'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sources=['commander.js','building-themes.js','game.js'].map(name=>new vm.Script(fs.readFileSync(path.join(__dirname,'..',name),'utf8'),{filename:name}));
function world(){const c=vm.createContext({matchEngine:{managed:true,seed:2296959562,capacity:2,teams:[{id:'f1',name:'test',color:'#4c91d1',bot:false,status:'active',slot:0}],humanTeams:['f1'],log(){},sound(){}}});for(const s of sources)s.runInContext(c);return c;}
const read=(c,s)=>JSON.parse(vm.runInContext('JSON.stringify('+s+')',c));

test('indexed collision queries match full scans, including movement, embarkation and new passengers',()=>{
  const result=read(world(),`(()=>{
    structures.length=0;units.length=0;
    const types=['tank','soldier','dog','horse','helicopter'];
    for(let i=0;i<160;i++)units.push({id:i+1,type:types[i%types.length],team:i%2?'f1':'f2',x:(i%16)*.8-7,y:Math.floor(i/16)*.8-4,health:100,altitude:i%3*20});
    beginUnitIndex();let mismatches=0;
    for(let i=0;i<500;i++){
      const u=units[i%units.length],x=((i*17)%190)/10-9,y=((i*13)%130)/10-6;
      const indexed=blockingUnit(u,u.x,u.y,x,y),brute=blockingUnit(u,u.x,u.y,x,y,units);
      if(indexed!==brute || unitPositionBlocked(u,x,y,i%2) !== unitPositionBlocked(u,x,y,i%2,units))mismatches++;
      if(i%11===0){const v=units[(i+3)%units.length];v.x=x;v.y=y;updateUnitIndex(v);}
    }
    const removed=units.shift();removeUnitIndex(removed);
    const added={id:900,type:'soldier',team:'f1',x:0,y:0,health:58};units.push(added);updateUnitIndex(added);
    for(const u of units)if(blockingUnit(u,u.x,u.y,0,0)!==blockingUnit(u,u.x,u.y,0,0,units))mismatches++;
    const candidates=nearbyUnits(-1,-1,1,1);endUnitIndex();
    return{mismatches,removed:candidates.includes(removed),added:candidates.includes(added),inactive:unitBins===null};
  })()`);
  assert.equal(result.mismatches,0);assert.equal(result.removed,false);assert.equal(result.added,true);assert.equal(result.inactive,true);
});

test('path regions reject disconnected destinations and rebuild when a bridge opens',()=>{
  const result=read(world(),`(()=>{
    structures.length=0;pathStructureCount=-1;ground.clear();
    for(const t of mapTiles)ground.set(tileKey(t.x,t.y),t.x===0?'water':'dirt');pathTerrain.fill(255);
    const u={type:'tank',team:'f1',x:-10,y:0,health:150};units.splice(0,units.length,u);
    const blocked=findPath({x:10,y:0},u);
    ground.set(tileKey(0,0),'bridge');pathTerrain.fill(255);pathStructureCount=-1;
    const bridge=findPath({x:10,y:0},u);
    ground.set(tileKey(-10,0),'water');pathTerrain.fill(255);pathStructureCount=-1;
    const escape=findPath({x:10,y:0},u);
    return{blocked,bridge:bridge?.at(-1),escape:escape?.at(-1)};
  })()`);
  assert.equal(result.blocked,null);assert.deepEqual(result.bridge,{x:10,y:0});assert.deepEqual(result.escape,{x:10,y:0});
});

test('march followers share the leader route and elect one replacement after the leader is lost',()=>{
  const result=read(world(),`(()=>{
    structures.length=0;units.length=0;pathStructureCount=-1;ground.clear();
    for(const t of mapTiles)ground.set(tileKey(t.x,t.y),'dirt');pathTerrain.fill(255);
    FACTIONS.f1.explored=new Map(mapTiles.map(t=>[tileKey(t.x,t.y),{...t,stamp:0}]));
    for(let i=0;i<18;i++)units.push({id:100+i,type:'tank',team:'f1',label:'tank',x:-16+(i%6)*1.05,y:-9+Math.floor(i/6)*1.05,heading:.4,speed:2.9,vision:5.3,health:150,route:[],goal:null,mode:'idle'});
    let calls=0,followerCalls=0;const original=findPath;findPath=function(target,u,...rest){calls++;if(u.marchGroup&&u.marchGroup.leader!==u)followerCalls++;return original(target,u,...rest)};
    const ordered=orderPlayerMovement([...units],{x:19,y:11}),initialCalls=calls;
    const group=units.find(u=>u.marchGroup)?.marchGroup,oldLeader=group.leader;
    for(let i=0;i<80;i++)stepSimulation(.04);
    const progress=units.reduce((n,u)=>n+(u.travel??0),0);oldLeader.health=0;
    stepSimulation(.04);
    return{ordered,initialCalls,followerCalls,progress,members:group.members.length,replaced:group.leader!==oldLeader,leaderAlive:group.leader.health>0};
  })()`);
  assert.equal(result.ordered,18);assert.equal(result.initialCalls,1);assert.equal(result.followerCalls,0);assert.ok(result.progress>0);assert.equal(result.members,17);assert.equal(result.replaced,true);assert.equal(result.leaderAlive,true);
});

test('local detours avoid a blocking vehicle and never cut across a blocked segment',()=>{
  const result=read(world(),`(()=>{
    structures.length=0;units.length=0;pathStructureCount=-1;ground.clear();
    for(const t of mapTiles)ground.set(tileKey(t.x,t.y),t.y===0?'dirt':'rock');pathTerrain.fill(255);
    const u={id:1,type:'tank',team:'f1',x:-5,y:0,health:150},blocker={id:2,type:'tank',team:'f1',x:0,y:0,health:150};units.push(u,blocker);
    const blocked=findPath({x:5,y:0},u,true,12);
    for(let x=-5;x<=5;x++)ground.set(tileKey(x,1),'dirt');pathTerrain.fill(255);pathStructureCount=-1;
    const route=findPath({x:5,y:0},u,true,12);let unsafe=0,previous=u;
    for(const p of route??[]){if(!groundPathOpen(previous.x,previous.y,p.x,p.y)||unitPathBlocked(u,previous.x,previous.y,p.x,p.y))unsafe++;previous=p;}
    return{blocked,endpoint:route?.at(-1),unsafe};
  })()`);
  assert.equal(result.blocked,null);assert.deepEqual(result.endpoint,{x:5,y:0});assert.equal(result.unsafe,0);
});
