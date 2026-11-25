const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');const{performance}=require('node:perf_hooks');
const {execFileSync}=require('node:child_process');
const after=path.resolve(__dirname,'..'),baseline=process.argv[2]??'caaf64f',runs=3;
const before=after;
const measured=[];
for(let run=0;run<runs;run++)for(const mode of ['before','core','after']){
const original=execFileSync('git',['show',baseline+':game.js'],{cwd:after,encoding:'utf8'});let code=mode==='before'?original:fs.readFileSync(path.join(after,'game.js'),'utf8');
if(mode==='core'){const start=original.indexOf('const MARCH_LIMIT='),end=original.indexOf('function navigate(unit,dt)',start);const ns=code.indexOf('const MARCH_LIMIT='),ne=code.indexOf('function navigate(unit,dt)',ns);code=code.slice(0,ns)+original.slice(start,end)+code.slice(ne);}
const results=[];
for(const count of [18,54,108]){
 const c=vm.createContext({performance,matchEngine:{managed:true,seed:2296959562,capacity:2,teams:[{id:'f1',name:'test',color:'#4c91d1',bot:false,status:'active',slot:0}],humanTeams:['f1'],log(){},sound(){}}});
 for(const file of ['commander.js','building-themes.js'])new vm.Script(fs.readFileSync(path.join(after,file),'utf8'),{filename:file}).runInContext(c);new vm.Script(code,{filename:'game.js'}).runInContext(c);
 vm.runInContext(`structures.length=0;units.length=0;pathStructureCount=-1;ground.clear();for(const t of mapTiles)ground.set(tileKey(t.x,t.y),'dirt');pathTerrain.fill(255);FACTIONS.f1.explored=new Map(mapTiles.map(t=>[tileKey(t.x,t.y),{...t,stamp:0}]));
 for(let i=0;i<${count};i++){const x=-22+(i%9)*1.15,y=-12+Math.floor(i/9)*1.15;units.push({id:1000+i,type:'tank',label:'test',team:'f1',x,y,heading:.4,turretHeading:.4,speed:2.9,vision:5.3,health:150,route:[],goal:null,mode:'idle'});}
 for(const t of mapTiles)if(onMap(t.x,t.y))groundPathCost(t.x,t.y,pathCell(t.x,t.y));if(typeof pathRegionGrid==='function')pathRegionGrid(pathBuildingGrid());
 globalThis.pathCalls=0;const originalFindPath=findPath;findPath=function(...args){pathCalls++;return originalFindPath(...args)};`,c);
 const start=performance.now();const order=vm.runInContext(`(()=>{const ordered=orderPlayerMovement([...units],{x:19,y:11});return{ordered,leaders:units.filter(u=>u.marchGroup?.leader===u).length,followers:units.filter(u=>u.marchGroup&&u.marchGroup.leader!==u).length,calls:pathCalls};})()`,c);const orderMs=performance.now()-start;
 const simStart=performance.now();vm.runInContext('for(let i=0;i<300;i++)stepSimulation(.04)',c);const simMs=performance.now()-simStart;
 const state=vm.runInContext(`(()=>({calls:pathCalls,alive:units.filter(u=>u.health>0).length,progress:units.reduce((n,u)=>n+(u.travel??0),0)/units.length,followers:units.filter(u=>u.marchGroup&&u.marchGroup.leader!==u).length,overlaps:units.reduce((n,u,i)=>n+units.slice(i+1).filter(v=>distanceTo(u,v)<UNIT_RADIUS.tank*2-.001).length,0)}))()`,c);
 results.push({mode,count,orderMs:+orderMs.toFixed(2),simulationMs:+simMs.toFixed(2),order,...state});
}
measured.push(...results.map(result=>({run,...result})));
}
const median=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)];
const summary=[];
for(const count of [18,54,108])for(const mode of ['before','core','after']){const samples=measured.filter(row=>row.count===count&&row.mode===mode);summary.push({...samples[0],run:undefined,orderMs:+median(samples.map(s=>s.orderMs)).toFixed(2),simulationMs:+median(samples.map(s=>s.simulationMs)).toFixed(2)});}
console.log(JSON.stringify({baseline,runs,simulatedSeconds:12,summary,samples:measured},null,2));
