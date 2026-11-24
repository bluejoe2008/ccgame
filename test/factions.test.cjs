'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sources=['commander.js','building-themes.js','game.js'].map(name=>new vm.Script(fs.readFileSync(path.join(__dirname,'..',name),'utf8'),{filename:name}));
function world(count,capacity=count){const teams=Array.from({length:count},(_,i)=>({id:'f'+(i+1),name:'阵营 '+(i+1),color:['#4c91d1','#df6155','#6cbd71'][i%3],bot:false,status:'active',slot:i}));const sounds=[];const c=vm.createContext({matchEngine:{managed:true,seed:2296959562,capacity,teams,humanTeams:teams.map(p=>p.id),log(){},sound(cue){sounds.push(cue);}}});for(const s of sources)s.runInContext(c);return{c,sounds};}
const read=(c,script)=>JSON.parse(vm.runInContext('JSON.stringify('+script+')',c));

test('all pairs of three independent factions may attack; commands enforce ownership',()=>{
 const{c}=world(3);
 const result=read(c,`(()=>{
  const output=[];structures.length=0;
  for(const attacker of ['f1','f2','f3'])for(const target of ['f1','f2','f3'])if(attacker!==target){
   const a={id:101,type:'tank',team:attacker,x:0,y:0,health:150,heading:0,speed:2.9,vision:5.3,route:[],mode:'idle',nextShot:0};
   const b={id:102,type:'tank',team:target,x:1,y:0,health:150,heading:0,speed:2.9,vision:5.3,route:[],mode:'idle',nextShot:1e9};
   units.splice(0,units.length,a,b);game.time=10;reveal(FACTIONS[attacker],0,0,5);
   const resolve=id=>id==='u101'?a:id==='u102'?b:null;
   const stolen=executePlayerOrder({kind:'move',units:['u102'],x:1,y:1},resolve,attacker);
   const order=executePlayerOrder({kind:'target',units:['u101'],target:'u102'},resolve,attacker);
   advanceCombat(.04);output.push({attacker,target,ordered:order.ordered,health:b.health,stolen:stolen.error,outcome:game.outcome});
  }
  return output;
 })()`);
 assert.equal(result.length,6);for(const r of result){assert.equal(r.ordered,1);assert.ok(r.health<150);assert.equal(r.stolen,'unavailable');assert.equal(r.outcome,null);}
});

test('withdrawal removes all assets and passengers with explosions, without granting kills',()=>{
 const{c,sounds}=world(3);const r=read(c,`(()=>{
  const actor=units.find(u=>u.team==='f1'&&u.type==='tank');const victim=units.find(u=>u.team==='f2');actor.attackTarget=victim;
  const building={type:'solar',team:'f2',x:0,y:0,width:2,height:2,health:230,remaining:0,queue:[]};structures.push(building);
  const transport={id:888,type:'helicopter',team:'f2',x:1,y:1,health:115,altitude:0,passengers:[{type:'dog',team:'f2',health:64}],route:[]};units.push(transport);
  const count=units.filter(u=>u.team==='f2').length+1;withdrawParticipant('f2');
  return {count,wrecks:wrecks.length,remaining:[...units,...structures].filter(e=>e.team==='f2').length,passengers:transport.passengers.length,rank:actor.rank??0,attack:actor.attackTarget??null,faction:Boolean(FACTIONS.f2)};
 })()`);
 assert.equal(r.remaining,0);assert.equal(r.passengers,0);assert.equal(r.rank,0);assert.equal(r.attack,null);assert.equal(r.faction,false);assert.equal(r.wrecks,r.count);assert.equal(sounds.filter(s=>s==='explosion').length,r.count);
});

test('late admission receives a fresh army and economy; maps grow with capacity',{timeout:30000},()=>{
 const{c}=world(2,8);const r=read(c,`(()=>{
  const config={id:'f3',name:'新人',color:'#b844dd',bot:false,status:'active',slot:4};TEAM_CONFIGS.push(config);addParticipant(config,battlefield.origins[4]);
  return {width:BOARD.right-BOARD.left,capacity:battlefield.origins.length,types:units.filter(u=>u.team==='f3').map(u=>u.type).sort(),credits:FACTIONS.f3.credits,ids:units.map(u=>u.id),blocked:units.filter(u=>unitPositionBlocked(u,u.x,u.y)).length};
 })()`);
 assert.equal(r.capacity,8);assert.equal(r.width,102*42*2);assert.deepEqual(r.types,['mcv','soldier','soldier','soldier','tank','tank']);assert.equal(r.credits,1250);assert.equal(new Set(r.ids).size,r.ids.length);assert.equal(r.blocked,0);
});

test('sixteen factions can initialize and simulate without legacy blue/red assumptions',{timeout:30000},()=>{
 const{c}=world(16);const r=read(c,`(()=>{for(let i=0;i<30;i++)stepSimulation(.04);return {teams:Object.keys(FACTIONS).length,units:units.length,colors:Object.keys(TEAM_PAINT).length,outcome:game.outcome};})()`);
 assert.equal(r.teams,16);assert.equal(r.units,96);assert.ok(r.colors>=16);assert.equal(r.outcome,null);
});
