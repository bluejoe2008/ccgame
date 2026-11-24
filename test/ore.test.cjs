'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sources=['commander.js','building-themes.js','game.js'].map(name=>new vm.Script(fs.readFileSync(path.join(__dirname,'..',name),'utf8'),{filename:name}));
function world(){
  const context=vm.createContext({matchEngine:{managed:true,seed:2296959562,capacity:2,teams:[],humanTeams:[],log(){},sound(){}}});
  for(const source of sources)source.runInContext(context);
  return context;
}
const read=(context,script)=>JSON.parse(vm.runInContext('JSON.stringify('+script+')',context));

test('ore repeatedly regenerates after its cooldown without a lifetime extraction limit',()=>{
  const result=read(world(),`(()=>{
    const cell=mapTiles.find(t=>oreCapacity(t.x,t.y)>0&&!onStructure(t.x,t.y));
    const key=tileKey(cell.x,cell.y),capacity=amountAt(cell.x,cell.y);
    let extracted=0;const cycles=[];
    for(let i=0;i<4;i++){
      extracted+=amountAt(cell.x,cell.y);takeOre(cell,0);
      game.time+=ORE_GROW_DELAY-.01;advanceOre(1);const waiting=amountAt(cell.x,cell.y);
      game.time+=.01;advanceOre(1);const resumed=amountAt(cell.x,cell.y);
      advanceOre(100000);cycles.push({waiting,resumed,full:amountAt(cell.x,cell.y),queued:recoveringOre.has(key)});
    }
    return {capacity,extracted,cycles};
  })()`);
  assert.equal(result.extracted,result.capacity*4);
  for(const cycle of result.cycles){assert.equal(cycle.waiting,0);assert.equal(cycle.resumed,2.2);assert.equal(cycle.full,result.capacity);assert.equal(cycle.queued,false);}
});

test('buildings pause ore regrowth and removing them resumes it',()=>{
  const result=read(world(),`(()=>{
    const cell=mapTiles.find(t=>oreCapacity(t.x,t.y)>0&&!onStructure(t.x,t.y));
    amountAt(cell.x,cell.y);takeOre(cell,0);game.time=ORE_GROW_DELAY;
    structures.push({...cell,type:'solar',team:'test',width:1,height:1,health:230});
    advanceOre(30);const covered=amountAt(cell.x,cell.y);structures.pop();advanceOre(5);
    return {covered,uncovered:amountAt(cell.x,cell.y)};
  })()`);
  assert.equal(result.covered,0);assert.equal(result.uncovered,11);
});

test('legacy exhausted deposits resume growth while existing cooldowns and capacity are preserved',()=>{
  const result=read(world(),`(()=>{
    const cells=mapTiles.filter(t=>oreCapacity(t.x,t.y)>0&&!onStructure(t.x,t.y)).slice(0,3);
    const [empty,partial,full]=cells,keys=cells.map(t=>tileKey(t.x,t.y));
    const capacities=cells.map(t=>amountAt(t.x,t.y));
    deposits.set(keys[0],0);oreReserves.set(keys[0],0);deposits.set(keys[1],capacities[1]/2);
    recoveringOre.set(keys[1],{...partial,capacity:capacities[1],ready:105});
    const bare=mapTiles.find(t=>oreCapacity(t.x,t.y)===0);deposits.set(tileKey(bare.x,bare.y),0);
    game.time=100;restoreOreGrowth();
    const queued=recoveringOre.size,ready=keys.slice(0,2).map(key=>recoveringOre.get(key).ready);
    game.time=113;advanceOre(1);
    return {queued,ready,reserves:oreReserves.size,capacities,amounts:cells.map(t=>amountAt(t.x,t.y)),fullQueued:recoveringOre.has(keys[2])};
  })()`);
  assert.equal(result.queued,2);assert.deepEqual(result.ready,[112,105]);assert.equal(result.reserves,0);
  assert.equal(result.amounts[0],2.2);assert.equal(result.amounts[1],result.capacities[1]/2+2.2);assert.equal(result.amounts[2],result.capacities[2]);assert.equal(result.fullQueued,false);
});
