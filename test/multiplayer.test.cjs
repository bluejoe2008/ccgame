'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function server(state,idle=120000){
 const child=spawn(process.execPath,['server.cjs','--bind','127.0.0.1','--port','0','--state',state],{cwd:root,env:{...process.env,CC_IDLE_TIMEOUT_MS:String(idle)},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',data=>stderr+=data);
 let stopped=false;
 const [line]=await once(child.stdout,'data');const address=line.toString().match(/127\.0\.0\.1:\d+/)?.[0];assert.ok(address,line.toString());
 return {base:'http://'+address,child,get stderr(){return stderr;},async stop(){if(stopped)return;stopped=true;const done=child.exitCode===null?once(child,'exit'):Promise.resolve();if(child.exitCode===null)child.kill('SIGTERM');await done;assert.equal(stderr,'',stderr);}};
}
class Client{
 constructor(server){this.server=server;this.cookie='';this.match=null;}
 async call(route,body,method=body===undefined?'GET':'POST'){
  const response=await fetch(this.server.base+route,{method,headers:{Cookie:this.cookie,...(this.match?{'X-Match-Id':this.match}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  this.cookie=response.headers.get('set-cookie')?.split(';')[0]??this.cookie;
  const data=await response.json();if(data.id)this.match=data.id;return {status:response.status,data};
 }
 async status(){const r=await this.call('/api/match/status');assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
 async snapshot(query=''){const r=await this.call('/api/match'+query);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
 post(action,body){return this.call('/api/match/'+action,body,'POST');}
}
const fresh=()=>path.join(fs.mkdtempSync(path.join(os.tmpdir(),'ccgame-room-test-')),'match.bin');

test('sessions, admission, ownership, replacement, persistence and manual rounds',{timeout:120000},async()=>{
 const state=fresh();let service=await server(state);const owner=new Client(service),observer=new Client(service),others=[];
 try{
  await owner.status();assert.equal((await owner.post('create',{name:'A',color:'#123456',capacity:1,bots:0})).status,400);assert.equal((await owner.post('create',{name:'A',color:'#123456',capacity:8,bots:8})).status,400);assert.equal((await owner.post('create',{name:'A',color:'#123456',capacity:8,bots:0,theme:'mountain'})).data.error,'invalid_theme');const created=await owner.post('create',{name:'Alice',color:'#8833ca',capacity:8,bots:3,theme:'qinhan'});assert.equal(created.status,200);assert.equal(created.data.buildingStyles.f1,'qinhan');const initial=created.data;
  assert.equal(initial.self.role,'player');assert.equal(initial.stats.current,4);assert.equal(initial.stats.cumulative,4);assert.equal(initial.self.canEnd,true);
  const watch=await observer.status();assert.equal(watch.self.role,'observer');assert.equal(watch.self.canEnd,false);assert.equal(watch.self.canJoin,true);
  const all=await observer.snapshot();assert.equal(all.globalView,true);assert.ok(all.units.length+all.buildings.filter(b=>b.team!=='neutral').length>=24);assert.ok(all.participants.every(p=>p.units>=5));
  assert.equal(JSON.stringify(all).includes(owner.cookie.split('=')[1]),false,'Session secret must never be disclosed');
  const own=await owner.snapshot('?perspective=observer');assert.equal(own.globalView,false);assert.ok(own.units.every(u=>u.team===own.self.team));assert.ok(own.participants.filter(p=>p.id!==own.self.team).every(p=>p.credits===null));
  assert.equal((await observer.post('end')).status,403);assert.equal((await observer.post('create',{name:'Other',color:'#123456',capacity:4,bots:1})).status,409);
  assert.equal((await observer.post('join',{name:'Alice',color:'#ffffff'})).data.error,'name_taken');assert.equal((await observer.post('join',{name:'Different',color:'#8833ca'})).data.error,'color_taken');
  const colors=['#d9af4b','#ae7be5','#43bfc6','#e781b7','#dc8645'];
  const clients=await Promise.all(colors.map(async()=>{const c=new Client(service);await c.status();return c;}));
  const results=await Promise.all(clients.map((c,i)=>c.post('join',{name:'Player '+i,color:colors[i]})));
  assert.equal(results.filter(r=>r.status===200).length,4);assert.equal(results.filter(r=>r.data.error==='full').length,1);
  for(let i=0;i<results.length;i++)if(results[i].status===200)others.push(clients[i]);
  const full=await owner.status();assert.equal(full.stats.current,8);assert.equal(full.stats.cumulative,8);assert.equal(full.self.canEnd,false);assert.equal((await owner.post('end')).status,403);
  const b=others[0],bs=await b.snapshot(),as=await owner.snapshot();assert.notEqual(bs.self.team,as.self.team);
  const foreign=bs.units.find(u=>u.team===bs.self.team&&u.type==='mcv');
  assert.equal((await owner.post('order',{kind:'deploy',source:foreign.viewId})).data.error,'unavailable');
  assert.equal((await observer.post('order',{kind:'deploy',source:foreign.viewId})).status,403);
  const myMcv=as.units.find(u=>u.type==='mcv'&&u.team===as.self.team);
  assert.equal((await owner.post('order',{kind:'deploy',source:myMcv.viewId})).status,200);
  assert.ok((await owner.snapshot()).buildings.some(b=>b.team===as.self.team&&b.type==='yard'));
  const before=await b.status(),departed=before.self.team;
  assert.equal((await b.post('leave')).status,200);
  const clear=await observer.snapshot();assert.equal(clear.stats.current,7);assert.equal(clear.stats.cumulative,8);assert.ok(clear.units.every(u=>u.team!==departed));assert.ok(clear.buildings.every(b=>b.team!==departed));assert.ok(clear.wrecks.length>0);
  const replacement=await b.post('join',{name:before.self.name,color:before.participants.find(p=>p.id===departed).color});assert.equal(replacement.status,200);assert.notEqual(replacement.data.self.team,departed);assert.equal(replacement.data.stats.cumulative,9);assert.equal(replacement.data.stats.current,8);
  const stable=await owner.status();await service.stop();service=await server(state);for(const c of [owner,observer,...clients])c.server=service;
  const resumed=await owner.status();assert.equal(resumed.id,stable.id);assert.equal(resumed.seed,stable.seed);assert.equal(resumed.self.team,stable.self.team);assert.equal(resumed.stats.cumulative,9);
  assert.equal((await owner.snapshot()).self.role,'player');assert.equal((await b.status()).self.team,replacement.data.self.team);
  for(const c of others)await c.post('leave');
  const last=await owner.status();assert.equal(last.stats.humans,1);assert.equal(last.self.canEnd,true);
  assert.equal((await owner.post('end')).status,200);const ended=await observer.status();assert.equal(ended.status,'ended');assert.equal(ended.outcome,null);
  await wait(150);assert.equal((await observer.status()).id,ended.id);
  const next=await observer.post('create',{name:'New host',color:'#6cbd71',capacity:4,bots:0});assert.equal(next.status,200);assert.notEqual(next.data.id,ended.id);assert.notEqual(next.data.seed,ended.seed);assert.equal(next.data.stats.cumulative,1);assert.equal(next.data.status,'running');
  assert.equal((await owner.status()).self.role,'observer');assert.equal((await owner.post('end')).status,403);
  assert.equal((await observer.post('end')).status,200);
  const histories=await owner.call('/api/history?perspective=observer');assert.equal(histories.status,200);assert.ok(histories.data.rounds.length>=2);assert.ok(histories.data.rounds.every(r=>r.review));
 }finally{await service.stop();}
});

test('last surviving faction wins, including when a human leaves',{timeout:30000},async()=>{
 const service=await server(fresh());try{
  const a=new Client(service),b=new Client(service);await a.status();const one=await a.post('create',{name:'A',color:'#1234ab',capacity:4,bots:0});assert.equal(one.data.status,'running');
  await wait(150);assert.equal((await a.status()).status,'running','A lone creator waits for an opponent');
  await b.status();const joined=await b.post('join',{name:'B',color:'#ce6531'});assert.equal(joined.status,200);const winner=joined.data.self.team;
  await a.post('leave');const done=await b.status();assert.equal(done.status,'finished');assert.equal(done.outcome,winner);assert.equal(done.self.canJoin,false);assert.equal(done.self.canCreate,true);
  assert.equal((await a.post('join',{name:'Again',color:'#1234ab'})).status,409);
  await wait(200);assert.equal((await b.status()).id,done.id);assert.equal((await b.status()).status,'finished');
 }finally{await service.stop();}
});

test('passive polling does not prevent idle removal; an observer can end a bot-only game',{timeout:30000},async()=>{
 const service=await server(fresh(),1600);try{
  const a=new Client(service),watch=new Client(service);await a.status();await a.post('create',{name:'Idle',color:'#b744bf',capacity:4,bots:2});await watch.status();
  for(let i=0;i<14;i++){await a.snapshot();await wait(200);}
  const idle=await a.status();assert.equal(idle.self.role,'observer');assert.equal(idle.self.result.kind,'idle');assert.equal(idle.stats.humans,0);assert.equal(idle.stats.bots,2);
  const all=await watch.snapshot();assert.ok(all.units.every(u=>u.team!==idle.self.result.team));assert.equal(all.self.canEnd,true);assert.equal((await watch.post('end')).status,200);assert.equal((await watch.status()).outcome,null);
 }finally{await service.stop();}
});

test('real activity extends the idle deadline without counting another participant',{timeout:30000},async()=>{
 const service=await server(fresh(),1400);try{
  const a=new Client(service);await a.status();await a.post('create',{name:'Active',color:'#b744bf',capacity:2,bots:1});
  for(let i=0;i<5;i++){await wait(550);assert.equal((await a.call('/api/session/activity',undefined,'POST')).status,200);}
  const status=await a.status();assert.equal(status.self.role,'player');assert.equal(status.stats.cumulativeHumans,1);
 }finally{await service.stop();}
});

test('legacy two-side save is preserved and the original human side can be claimed',{timeout:30000},async()=>{
 const vm=require('node:vm'),v8=require('node:v8');
 const seed=2296959562,context=vm.createContext({matchEngine:{seed,log(){},sound(){}}});
 for(const name of ['commander.js','building-themes.js','game.js']){
  const code=fs.readFileSync(path.join(root,name),'utf8');vm.runInContext(code,context,{filename:name});
 }
 const saved=vm.runInContext(`(()=>{
  for(const f of Object.values(FACTIONS))f.nextOrder=1e9;
  for(const u of units){u.nextShot=1e9;u.goal=null;u.route=[];}
  return {version:1,match:{id:'legacy-test-match',seed:MAP_SEED,status:'running',mode:'human',round:1,auto:false,startedAt:Date.now()-42000,buildingStyles:{player:'mountain',enemy:'classic'},buildingStylePreferences:{player:'mountain',enemy:'classic'}},
   logs:[],nextEvent:1,nextBuilding:1,units,structures,searchSites,deposits,oreReserves,recoveringOre,factions:FACTIONS,groundImpacts:[],nextUnitId,
   game:{time:42,outcome:null,firstEngagement:false},journal:{offsets:{player:0,enemy:0},complete:false}};
 })()`,context);
 const state=fresh();fs.writeFileSync(state,v8.serialize(saved));let service=await server(state);const a=new Client(service),watch=new Client(service);
 try{
  const before=await a.status();assert.equal(before.id,'legacy-test-match');assert.equal(before.seed,seed);assert.equal(before.capacity,2);assert.equal(before.stats.current,2);assert.equal(before.self.role,'observer');assert.equal(before.self.canJoin,true);assert.equal(before.buildingStyles.player,'classic');
  assert.equal((await a.snapshot()).units.length,saved.units.length);
  const joined=await a.post('join',{name:'Original player',color:'#8833ca',theme:'qinhan'});assert.equal(joined.status,200);assert.equal(joined.data.self.team,'player');assert.equal(joined.data.stats.cumulative,2);assert.equal(joined.data.buildingStyles.player,'qinhan');
  await watch.status();const full=await watch.snapshot();assert.equal(full.units.length,saved.units.length);assert.ok(full.units.some(u=>u.id===2&&u.team==='player'));assert.ok(full.time>=42);
  await service.stop();service=await server(state);a.server=watch.server=service;const restored=await a.status();assert.equal(restored.id,before.id);assert.equal(restored.seed,before.seed);assert.equal(restored.self.team,'player');assert.equal(restored.buildingStyles.player,'qinhan');
 }finally{await service.stop();}
});

test('combat elimination ends the round only after the last opposing faction is gone',{timeout:30000},async()=>{
 const v8=require('node:v8');const state=fresh();let service=await server(state);const a=new Client(service),b=new Client(service);
 try{
  await a.status();await a.post('create',{name:'A',color:'#4c91d1',capacity:4,bots:0,theme:'classic'});await b.status();await b.post('join',{name:'B',color:'#df6155',theme:'classic'});
  const before=await a.status(),loser=before.participants.find(p=>p.name==='B').id;
  await service.stop();const saved=v8.deserialize(fs.readFileSync(state));
  const actor=saved.units.find(u=>u.team===before.self.team&&u.type==='tank'),target=saved.units.find(u=>u.team===loser&&u.type==='soldier');
  saved.units=saved.units.filter(u=>u.team!==loser||u===target);saved.structures=saved.structures.filter(b=>b.team!==loser);
  Object.assign(target,{x:actor.x+1,y:actor.y,health:1,nextShot:1e9,goal:null,route:[]});Object.assign(actor,{attackTarget:target,nextShot:0,goal:null,route:[]});
  for(const f of Object.values(saved.factions))f.nextOrder=1e9;
  fs.writeFileSync(state,v8.serialize(saved));service=await server(state);a.server=b.server=service;
  let status;for(let i=0;i<40;i++){status=await a.status();if(status.status==='finished')break;await wait(50);}
  assert.equal(status.status,'finished');assert.equal(status.outcome,before.self.team);assert.equal(status.stats.current,1);
  const loss=await b.status();assert.equal(loss.self.result.kind,'defeated');assert.equal(loss.self.role,'observer');assert.equal((await b.snapshot()).globalView,true);
 }finally{await service.stop();}
});
