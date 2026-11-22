'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const teams = ['player', 'enemy'];
const maxSeconds = 720;
const step = .04;
const fixtures = [2296959562, 3566125424, 19630628, 346829713];
const drills = ['scout','probe','relief','oil'];

// Run the same exercise for both factions with their positions mirrored.
function exercise(name,team) {
  const side=team==='player'?1:-1;
  const enemy=team==='player'?'enemy':'player';
  const faction=FACTIONS[team];
  game.time=160;
  structures.length=units.length=0;
  hillHeights.clear();
  for (let x=-20;x<=20;x++) for (let y=-12;y<=12;y++) ground.set(tileKey(x,y),'field');
  for (const view of Object.values(FACTIONS)) {
    view.explored.clear();
    view.sight.clear();
  }
  const place=(type,x,y,owner=team)=>{
    const spec=buildingSpec(type);
    const building={type,x:side*x,y,team:owner,width:spec.width,height:spec.height,
      health:spec.health,remaining:0,queue:[]};
    structures.push(building);
    return building;
  };
  const recruit=(type,x,y,owner=team)=>{
    const spec=PRODUCTS[type];
    const unit={id:nextUnitId++,type,team:owner,x:side*x,y,label:spec.label,
      health:spec.health??WEAPONS[type].health,speed:spec.speed,vision:spec.vision,
      heading:side===1?0:Math.PI,route:[],goal:null,mode:'idle'};
    units.push(unit);
    return unit;
  };
  const home=place('yard',-14,0);
  place('yard',16,1,enemy);
  const reserve=[recruit('tank',-11,-1),recruit('soldier',-12,3)];
  const front=[recruit('tank',3,0),recruit('tank',2,2),recruit('soldier',2,-1)];
  const scouts=name==='scout'?[recruit('dog',3,3)]:[];
  const army=[...reserve,...front,...scouts];
  const target=name==='probe' || name==='relief'?place('factory',7,0,enemy):null;
  const contact=name==='scout'?recruit('soldier',6,-1,enemy):null;
  const scoutPoint={x:side*6,y:5};
  const refresh=()=>{
    for (const current of [team,enemy]) refreshVision(FACTIONS[current],
      units.filter(unit=>unit.team===current && unit.health>0),
      structures.filter(building=>building.team===current && building.health>0));
  };
  const turn=raid=>{
    refresh();
    const intelligence=scoutBattlefield(faction);
    if (name==='scout') intelligence.frontier=[scoutPoint];
    const own=structures.filter(building=>building.team===team && building.health>0);
    const active=army.filter(unit=>unit.health>0);
    reviewCommander(faction,active,own,units.filter(unit=>unit.team===team),intelligence,raid);
    directAiArmy(faction,active,own,intelligence,raid);
  };
  const move=()=>{
    game.time+=.04;
    detourNodesLeft=DETOUR_NODES_PER_TICK;
    advanceMarchGroups();
    for (const unit of units.slice()) navigate(unit,.04);
    detourNodesLeft=Infinity;
  };
  if (name==='oil') {
    const field=place('oil',7,4,'neutral');
    const engineer=recruit('engineer',4,4);
    refresh();
    const ordered=orderCapture(engineer,field);
    while (field.team!==team && game.time<169) move();
    const transit=field.oilOperation?+(field.oilOperation.capturedAt-160).toFixed(1):null;
    const holding=field.oilOperation;
    for (let tick=0;holding && tick<800;tick++) {
      move();
      advanceOilFields();
    }
    const income=holding?.income??0;
    closeOilHolding(field,'round_end');
    return {passed:ordered && field.team===team && income>=PRODUCTS.engineer.cost,
      secondsToCapture:transit,heldSeconds:holding?Math.floor(game.time-holding.capturedAt):0,
      income,cost:PRODUCTS.engineer.cost};
  }

  faction.commander.campaign={intercepts:[106,126,148],nextTurn:0};
  turn(null);
  const plan=faction.commander.plan;
  const reserveHeld=reserve.filter(unit=>!unit.attackTarget).length;
  if (name==='scout') {
    const contactHeld=front.filter(unit=>unit.attackTarget===contact).length;
    let elapsed=null;
    while (plan?.scout && game.time<173) {
      move();
      if (distanceTo(plan.scout,scoutPoint)<=2.1) {
        elapsed=+(game.time-160).toFixed(1);
        break;
      }
    }
    return {passed:Boolean(plan?.maneuver && plan.task==='recon' && reserveHeld>=2 && contactHeld>=1 && elapsed!==null),
      reserveHeld,frontlineOnContact:contactHeld,secondsToReport:elapsed};
  }
  const committed=front.filter(unit=>unit.attackTarget===target).length;
  if (name==='relief') {
    const attacker=recruit('tank',-9,-1,enemy);
    refresh();
    recordRaid(attacker,home);
    turn(urgentRaid(faction,scoutBattlefield(faction).contacts));
    const responders=army.filter(unit=>unit.rescueTarget===home).length;
    return {passed:Boolean(plan?.maneuver && committed>=2 && reserveHeld>=2 &&
      faction.orders.task==='fortify' && faction.orders.mode==='guard' && responders>=2),
      committed,reserveHeld,responders,order:faction.orders.task};
  }
  for (let tick=0;tick<750 && target.health>0;tick++) {
    move();
    if (tick%14===0) turn(null);
    advanceCombat(.04);
  }
  turn(null);
  return {passed:Boolean(plan?.maneuver && plan.task==='harass' && committed>=2 && committed<=3 &&
    reserveHeld>=2 && target.health<=0),committed,reserveHeld,secondsToObjective:+(game.time-160).toFixed(1),
    objectiveLost:target.health<=0};
}

function play({ seed, trainedTeam, drill }) {
  const policies = Object.fromEntries(teams.map(team => [team, drill || team===trainedTeam?'trained':'baseline']));
  const counts = Object.fromEntries(teams.map(team => [team, {
    turns:0, probes:0, probeGoals:0, scoutTurns:0, raidInterruptions:0,
    oilIncome:0, oilMissions:0, oilNet:0, firstBaseLoss:null, firstObjective:null,
  }]));
  let random = seed ^ 0x7951462b;
  const durations = [];
  const context = vm.createContext({
    clock:()=>performance.now(),
    record:ms=>durations.push(ms),
    seededRandom() {
      random = (Math.imul(random,1664525) + 1013904223) >>> 0;
      return random / 0x100000000;
    },
    matchEngine:{
      seed, policies,
      log(message, team, time, plan, metrics) {
        const result=counts[team];
        if (!result) return;
        if (metrics?.kind==='turn') {
          result.turns++;
          result[metrics.task==='recon'?'scoutTurns':'probes']++;
        }
        if (metrics?.kind==='oil') {
          result.oilMissions++;
          result.oilNet+=metrics.income-metrics.cost;
        }
        if (metrics?.kind==='turn-result' && metrics.phase==='probe') {
          if (plan.result==='complete') result.probeGoals++;
          if (metrics?.reason==='home') result.raidInterruptions++;
        }
        if (plan?.result==='complete' && (plan.task==='strike' || plan.task==='capture')) result.firstObjective??=time;
        const income=/^油田收入 \+(\d+) 储备。$/.exec(message);
        if (income) result.oilIncome+=Number(income[1]);
        if (message===(team==='player'?'蓝方':'红方')+'建造场被摧毁。') result.firstBaseLoss??=time;
      },
      sound() {},
    },
  });
  vm.runInContext('Math.random=seededRandom;',context);
  for (const name of ['commander.js','building-themes.js','game.js']) {
    const source=fs.readFileSync(path.join(__dirname,name),'utf8');
    vm.runInContext(source,context,{filename:name});
  }
  if (drill) {
    const assessment=vm.runInContext('('+exercise.toString()+')('+JSON.stringify(drill)+','+
      JSON.stringify(trainedTeam)+')',context,{timeout:8000});
    return {drill,team:trainedTeam,...assessment};
  }
  const result=vm.runInContext(`
    for (let tick=0;tick<${maxSeconds/step} && !game.outcome;tick++) {
      const start=clock();
      stepSimulation(${step});
      if (tick%4===0) record(clock()-start);
    }
    finalizeOilOperations();
    ({ outcome:game.outcome??'timeout', duration:Math.round(game.time),
       remaining:Object.fromEntries(Object.entries(FACTIONS).map(([team,faction])=>[team,{
         units:units.filter(unit=>unit.team===team && unit.health>0).length,
         buildings:structures.filter(building=>building.team===team && building.health>0).length,
         power:Math.round(faction.power.rate*100),
       }])) })
  `,context);
  durations.sort((a,b)=>a-b);
  return {seed,trainedTeam,...result,teams:counts,
    p95Tick:+durations[Math.floor((durations.length-1)*.95)].toFixed(1)};
}

function run(fixture) {
  return new Promise((resolve,reject)=>{
    const worker = new Worker(__filename,{workerData:fixture});
    worker.once('message',resolve);
    worker.once('error',reject);
    worker.once('exit',code=>reject(new Error('Training worker exited before returning a result, code '+code)));
  });
}

async function runDrills(selected=drills) {
  if (!selected.length || new Set(selected).size!==selected.length || selected.some(name=>!drills.includes(name))) {
    throw new Error('Choose scout, probe, relief or oil.');
  }
  const results=[];
  for (const drill of selected) {
    const batch=await Promise.all(teams.map(trainedTeam=>run({seed:19630628,drill,trainedTeam})));
    results.push(...batch);
  }
  return results;
}

async function main() {
  const args=process.argv.slice(2);
  if (args[0]==='--drills') {
    const results=await runDrills(args.length>1?args.slice(1):undefined);
    for (const result of results) console.log(JSON.stringify(result));
    const passed=results.filter(row=>row.passed).length;
    console.log(JSON.stringify({drills:results.length,passed}));
    if (passed!==results.length) process.exitCode=1;
    return;
  }
  const seeds=args.length?args.map(Number):fixtures;
  if (seeds.some(seed=>!Number.isInteger(seed) || seed<0 || seed>0xffffffff)) throw new Error('Use unsigned 32-bit map seeds.');
  const queue=seeds.flatMap(seed=>[null,...teams].map(trainedTeam=>({seed,trainedTeam})));
  const results=[];
  await Promise.all(Array.from({length:Math.min(queue.length,6,Math.max(1,os.availableParallelism()-2))},async()=>{
    while (queue.length) {
      const result=await run(queue.shift());
      console.log(JSON.stringify(result));
      results.push(result);
    }
  }));
  const versus=results.filter(row=>row.trainedTeam);
  console.log(JSON.stringify({
    matches:results.length,
    trainedWins:versus.filter(row=>row.outcome===row.trainedTeam).length,
    baselineWins:versus.filter(row=>teams.includes(row.outcome) && row.outcome!==row.trainedTeam).length,
    timedOut:versus.filter(row=>row.outcome==='timeout').length,
    draws:versus.filter(row=>row.outcome==='draw').length,
  }));
}

if (require.main===module) {
  if (isMainThread) main().catch(error=>{console.error(error);process.exitCode=1;});
  else parentPort.postMessage(play(workerData));
}
module.exports={drills,runDrills};
