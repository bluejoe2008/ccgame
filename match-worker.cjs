'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomInt, randomUUID } = require('node:crypto');
const vm = require('node:vm');
const v8 = require('node:v8');
const { parentPort, workerData } = require('node:worker_threads');
const { BattleHistory, labels, replaceFile } = require('./battle-history.cjs');
const { BUILDING_THEMES, RANDOM_BUILDING_THEME, validBuildingThemePreference, resolveBuildingTheme } = require('./building-themes.js');

const { checkpointFile, plannerOrigin, strategyKey } = workerData;
const version = 1;
const step = .04;
fs.mkdirSync(path.dirname(checkpointFile), { recursive:true, mode:0o700 });
const history = new BattleHistory(checkpointFile);
const sources = ['commander.js', 'building-themes.js', 'game.js'].map(name =>
  new vm.Script(fs.readFileSync(path.join(__dirname, name), 'utf8'), { filename: name }));

const interfaceScript = new vm.Script(`({
  game, FACTIONS, units, structures, deposits, oreReserves, recoveringOre, searchSites, battlefield, OIL_FIELD,
  shots, wrecks, movementDust, groundImpacts, stepSimulation, canSeeEntity, knowsBuilding, oreCapacity, amountAt, tileUnder, finalizeOilOperations,
  executePlayerOrder, addParticipant, withdrawParticipant, mapTiles,
  spawnSite(slots) {
    return slots.map(slot=>({slot,...battlefield.origins[slot]})).filter(point=>
      [...units,...structures.filter(b=>b.team!=='neutral')].every(entity=>distanceTo(point,entity.width?yardCenter(entity):entity)>12) &&
      walkable(point.x,point.y-1)).sort((a,b)=>{
        const score=p=>Math.min(999,...units.filter(u=>u.health>0).map(u=>distanceTo(p,u)));return score(b)-score(a);
      })[0]??null;
  },
  nextId() { return nextUnitId; },
  restore(saved) {
    for (const name of Object.keys(saved.factions)) {
      const faction=FACTIONS[name]=saved.factions[name];
      const {commander}=faction;
      delete faction.research;
      delete faction.manufacturing;
      delete faction.discoveries;
      delete faction.equipment;
      if (commander.plan?.task==='research') commander.plan=null;
      else if (commander.plan?.followup?.task==='research') commander.plan.followup=null;
      if (commander.proposal?.primary?.task==='research' || commander.proposal?.followup?.task==='research') {
        commander.proposal=null;
      }
      if (faction.orders?.task==='research') {
        faction.orders={mode:'develop',task:'mobilize',target:null,source:'local'};
        commander.nextReview=0;
      }
      if (faction.experience?.focus) faction.experience.focus=faction.experience.focus.filter(task=>task!=='research');
    }
    units.splice(0, units.length, ...saved.units);
    for (const unit of [...units,...units.flatMap(carrier=>carrier.passengers??[])]) {
      const speed=PRODUCTS[unit.type]?.speed;
      if (speed===undefined || unit.speed===speed) continue;
      unit.speed=speed;
      if (unit.velocity>speed) unit.velocity=speed;
    }
    structures.splice(0, structures.length, ...saved.structures);
    pathStructureCount=-1;
    for (const unit of units) {
      if (unit.type!=='helicopter' || unit.goal || unitElevation(unit)>2) continue;
      const airport=structures.find(building=>building.type==='airport' && building.team===unit.team &&
        unit.x>=building.x-.5 && unit.x<building.x+building.width-.5 &&
        unit.y>=building.y-.5 && unit.y<building.y+building.height-.5);
      const parking=airport && airfieldParking(airport,unit);
      if (parking) Object.assign(unit,parking);
    }
    searchSites.splice(0, searchSites.length, ...saved.searchSites);
    groundImpacts.push(...(saved.groundImpacts??[]));
    for (const [machine, stored] of [[deposits,saved.deposits],[oreReserves,saved.oreReserves],
      [recoveringOre,saved.recoveringOre]]) {
      machine.clear();
      for (const [key,value] of stored) machine.set(key,value);
    }
    nextUnitId = saved.nextUnitId;
    Object.assign(game, saved.game);
    restoreOreGrowth();
    if (saved.match.status === 'running') {
      for (const faction of Object.values(FACTIONS)) {
        delete faction.priorityFighter;
        if (faction.priorityAircraft) faction.priorityAircraft=faction.priorityAircraft.filter(type=>type!=='fighter');
      }
      for (const airport of structures.filter(building=>building.type==='airport')) {
        const active=airport.queue.filter(job=>job.type!=='fighter');
        const cancelled=airport.queue.length-active.length;
        if (!cancelled) continue;
        airport.queue=active;
        FACTIONS[airport.team].credits+=cancelled*PRODUCTS.fighter.cost;
        log(factionName(airport.team)+'已取消待造的战斗机并返还生产费用。',airport.team);
      }
    }
  },
})`);

let match;
let engine;
let logs;
let events;
let nextEvent;
let nextBuilding;
let checkpointAt = 0;
let lastTick = performance.now();
let pending = 0;
let journal;
let roundArchived = false;
let archiveRetryAt = 0;
let startPending = false;
const heardAt = new Map();
const sessions=new Map();
const idleTimeoutMs=workerData.idleTimeoutMs??600000;
const palette=['#4c91d1','#df6155','#6cbd71','#d9af4b','#ae7be5','#43bfc6','#e781b7','#dc8645','#a0b85c','#7a94e5','#c9c9c9','#a97855','#59cda5','#c47e92','#baca65','#c6a0dd'];
let nextSessionCheck=0;
let participantIndex=new Map(),activeRoster=new Map();
const availableThemes = Object.keys(BUILDING_THEMES);

function stylePreferences(saved) {
  return Object.fromEntries((match?.participants?.map(p=>p.id)??['player','enemy']).map(team=>{
    const preference=saved?.[team];
    return [team,validBuildingThemePreference(preference)?preference:RANDOM_BUILDING_THEME];
  }));
}

function addLog(message, team, time, plan, metrics) {
  const entry = { id:nextEvent++, message, team, time };
  if (plan) entry.plan=plan;
  if (metrics) entry.metrics=metrics;
  logs.push(entry);
  if (logs.length > 190) logs.shift();
  journal.pending.push(entry);
}

function initialise(description, saved = null) {
  match = description;
  participantIndex=new Map(match.participants.map(p=>[p.id,p]));
  activeRoster=new Map(match.participants.filter(p=>p.status==='active').map(p=>[p.id,p]));
  logs = saved?.logs ?? [];
  events = [];
  nextEvent = saved?.nextEvent ?? 1;
  nextBuilding = saved?.nextBuilding ?? 1;
  pending = 0;
  lastTick = performance.now();
  roundArchived = false;
  archiveRetryAt = 0;
  startPending = false;
  journal = { offsets:saved?.journal?.offsets ?? {player:0,enemy:0},
    complete:saved?.journal?.complete ?? !saved,
    pending:saved && !saved.journal ? logs.slice() : [] };
  heardAt.clear();
  const context = vm.createContext({
    AbortSignal,
    fetch: (url, options) => fetch(new URL(url, plannerOrigin), {...options,headers:{...options?.headers,'X-Strategy-Key':strategyKey}}),
    matchEngine: {
      seed: match.seed,
      get buildingStyles() { return match.buildingStyles; },
      managed:true,capacity:match.capacity??2,teams:match.participants,
      get humanTeams() { return activeParticipants().filter(p=>!p.bot).map(p=>p.id); },
      planner: Boolean(plannerOrigin),
      log:addLog,
      sound(cue, point, source) {
        const audience = Object.values(engine.FACTIONS).filter(faction =>
          faction.team === source.team || faction.explored.has(engine.tileUnder(point.x, point.y)))
          .map(faction => faction.team);
        if (!audience.length) return;
        const id = source.id ?? engine.tileUnder(source.x, source.y);
        const key = cue + ':' + id;
        const time = engine.game.time;
        if (time - (heardAt.get(key) ?? -Infinity) < .14) return;
        heardAt.set(key, time);
        events.push({ id: nextEvent++, cue, x: point.x, y: point.y, source: id, time, audience });
        while (events.length > 128 || time - events[0].time > 2) events.shift();
        if (heardAt.size > 512) {
          for (const [sourceKey, last] of heardAt) if (time - last > 5) heardAt.delete(sourceKey);
        }
      },
    },
  });
  for (const script of sources) script.runInContext(context);
  engine = interfaceScript.runInContext(context);
  if (saved) engine.restore(saved);
}

function freshMatch(status,round,capacity=8,participants=[]) {
  let seed=randomInt(0x100000000);while(seed===match?.seed)seed=randomInt(0x100000000);
  const buildingStylePreferences=Object.fromEntries(participants.map(p=>[p.id,p.theme??RANDOM_BUILDING_THEME]));
  const buildingStyles=Object.fromEntries(participants.map(p=>[p.id,p.theme&&p.theme!==RANDOM_BUILDING_THEME?resolveBuildingTheme(p.theme):availableThemes[randomInt(availableThemes.length)]]));
  return {id:randomUUID(),seed,status,round,mode:'multiplayer',auto:false,capacity,participants,initialBots:participants.filter(p=>p.bot).length,competitionStarted:participants.length>=2,
    buildingStyles,buildingStylePreferences,startedAt:status==='running'?Date.now():null,finishedAt:null,nextRoundAt:null};
}

function save() {
  const { game, FACTIONS, units, structures, searchSites, deposits, oreReserves, recoveringOre, groundImpacts } = engine;
  const offsets = history.append(match.id,journal.offsets,journal.pending,match.participants.map(p=>p.id));
  const state = {
    version, match, sessions:[...sessions], logs, nextEvent, nextBuilding, units, structures, searchSites, deposits, oreReserves, recoveringOre,
    factions: FACTIONS,
    groundImpacts,
    nextUnitId: engine.nextId(),
    game: { time: game.time, outcome: game.outcome, firstEngagement: game.firstEngagement },
    journal:{ offsets, complete:journal.complete },
  };
  replaceFile(checkpointFile,v8.serialize(state));
  journal.offsets=offsets;
  journal.pending=[];
  checkpointAt = performance.now();
}

function saveSafely() {
  try {
    save();
    return true;
  } catch (error) {
    console.error('Match checkpoint failed:', error.message);
    checkpointAt = performance.now();
    return false;
  }
}

function archiveRound() {
  if (roundArchived) return true;
  engine.finalizeOilOperations();
  if (!saveSafely()) return false;
  try {
    const survivors = Object.fromEntries(match.participants.map(p=>p.id).map(team=>[team,{
      units:engine.units.reduce((total,unit)=>total+(unit.team===team && unit.health>0 ?
        1+(unit.passengers?.length??0) : 0),0),
      buildings:engine.structures.filter(building=>building.team===team && building.health>0).length,
    }]));
    history.finish(matchInfo(),journal.complete,survivors);
    roundArchived=true;
  } catch (error) {
    console.error('Battle archive failed:',error.message);
  }
  return roundArchived;
}

function visitor(token) {
  if (!sessions.has(token)) sessions.set(token,{role:'observer',team:null,matchId:null,lastSeen:Date.now(),lastActivity:Date.now()});
  const session=sessions.get(token);session.lastSeen=Date.now();return session;
}
function activeParticipants() {return [...activeRoster.values()];}
function memberFor(session) {if(session.matchId!==match.id)return null;const p=activeRoster.get(session.team);return p?.owner===session.token?p:null;}
function permissions(session) {
  const humans=activeParticipants().filter(p=>!p.bot).length;
  return {canCreate:match.status!=='running',canJoin:match.status==='running' && session.role!=='player' && (activeParticipants().length<match.capacity || match.participants.some(p=>p.legacy && !p.owner && p.status==='active')),
    canEnd:match.status==='running' && ((session.role==='player' && memberFor(session) && humans===1) || (session.role==='observer' && humans===0))};
}
function publicParticipant(p,global=false,team=null) {
  const own=p.id===team;
  return {...pick(p,['id','name','color','bot','status','slot','joinedAt','leftAt','reason']),
    slot:global||own?p.slot:null,theme:match.buildingStyles[p.id],
    units:global||own?engine.units.filter(u=>u.team===p.id&&u.health>0).reduce((sum,u)=>sum+1+(u.passengers?.filter(p=>p.health>0).length??0),0):null,
    buildings:global||own?engine.structures.filter(b=>b.team===p.id && b.health>0).length:null,
    credits:global||own?engine.FACTIONS[p.id]?.credits??null:null,
    ...Object.fromEntries(['power','support','factoryCount','factoryBonus'].map(key=>[key,global||own?engine.FACTIONS[p.id]?.[key]??null:null]))};
}
function sessionInfo(session) {
  const active=memberFor(session);
  return {role:active?'player':'observer',team:active?.id??null,name:active?.name??session.name??'观察者',
    result:session.lastResult?.matchId===match.id?session.lastResult:null,
    idleRemaining:active?Math.max(0,idleTimeoutMs-(Date.now()-session.lastActivity)):null,...permissions(session)};
}
function profile(body) {
  const name=typeof body?.name==='string'?body.name.trim():'';
  const color=typeof body?.color==='string'?body.color.toLowerCase():'';
  if(!name || [...name].length>24 || /[\x00-\x1f\x7f]/.test(name))return {error:'invalid_name'};
  if(!/^#[0-9a-f]{6}$/.test(color))return {error:'invalid_color'};
  const theme=body.theme??RANDOM_BUILDING_THEME;
  if(!validBuildingThemePreference(theme))return {error:'invalid_theme'};
  return {name,color,theme};
}
function createGame(session,body) {
  if(match.status==='running')return {error:'game_running'};
  const person=profile(body);if(person.error)return person;
  const capacity=body.capacity,bots=body.bots;
  if(!Number.isInteger(capacity)||capacity<2||capacity>16||!Number.isInteger(bots)||bots<0||bots>=capacity)return {error:'invalid_capacity'};
  if(['finished','ended'].includes(match.status)&&!archiveRound())return {error:'archive_pending'};
  const people=[{id:'f1',...person,bot:false,status:'active',slot:0,joinedAt:Date.now(),owner:session.token}];
  const colors=palette.filter(c=>c!==person.color);
  for(let i=0;i<bots;i++)people.push({id:'f'+(i+2),name:'机器人 '+(i+1)+(person.name==='机器人 '+(i+1)?'（自动）':''),color:colors[i],bot:true,status:'active',slot:i+1,joinedAt:Date.now()});
  const round=match.round+Number(match.status!=='idle');
  for(const v of sessions.values()){v.role='observer';v.team=null;v.lastResult=null;}
  initialise(freshMatch('running',round,capacity,people));
  Object.assign(session,{role:'player',team:'f1',name:person.name,matchId:match.id,lastActivity:Date.now()});
  const experience=history.experience().enemy;
  for(const p of people.filter(p=>p.bot))engine.FACTIONS[p.id].experience=experience;
  addLog('第 '+round+' 局开始，最多 '+capacity+' 方，初始机器人 '+bots+' 方。',null,0);
  startPending=!saveSafely();return roomInfo(session);
}
function joinGame(session,body) {
  if(match.status!=='running')return {error:'inactive'};
  if(memberFor(session))return roomInfo(session);
  const person=profile(body);if(person.error)return person;
  const active=activeParticipants(),legacy=active.find(p=>p.legacy&&!p.owner&&!p.bot);
  if(active.some(p=>p.name===person.name && p!==legacy))return {error:'name_taken'};
  if(active.some(p=>p.color===person.color && p!==legacy))return {error:'color_taken'};
  if(!legacy&&active.length>=match.capacity)return {error:'full'};
  let participant;
  if(legacy) {
    participant=legacy;Object.assign(participant,person,{owner:session.token,legacy:false});
    match.buildingStylePreferences[participant.id]=person.theme;match.buildingStyles[participant.id]=person.theme===RANDOM_BUILDING_THEME?resolveBuildingTheme(match.buildingStyles[participant.id]):person.theme;
  } else {
    const slots=Array.from({length:match.capacity},(_,i)=>i).filter(slot=>!active.some(p=>p.slot===slot));
    const site=engine.spawnSite(slots);if(!site)return {error:'spawn_busy'};
    participant={id:'f'+(match.participants.length+1),...person,bot:false,status:'active',slot:site.slot,joinedAt:Date.now(),owner:session.token};
    match.participants.push(participant);participantIndex.set(participant.id,participant);activeRoster.set(participant.id,participant);
    match.buildingStylePreferences[participant.id]=person.theme;
    match.buildingStyles[participant.id]=person.theme===RANDOM_BUILDING_THEME?availableThemes[randomInt(availableThemes.length)]:person.theme;
    engine.addParticipant(participant,site);
  }
  Object.assign(session,{role:'player',team:participant.id,name:person.name,matchId:match.id,lastActivity:Date.now(),lastResult:null});
  match.competitionStarted ||= activeParticipants().length>=2;
  addLog(person.name+' 加入战场。',null,engine.game.time);saveSafely();return roomInfo(session);
}
function eliminate(participant,reason,explode=false) {
  if(participant.status!=='active')return;
  if(explode)engine.withdrawParticipant(participant.id);
  else delete engine.FACTIONS[participant.id];
  activeRoster.delete(participant.id);
  participant.status=reason==='defeated'?'eliminated':'left';participant.reason=reason;participant.leftAt=Date.now();
  const session=sessions.get(participant.owner);
  if(session){session.lastResult={matchId:match.id,team:participant.id,kind:reason};session.role='observer';session.team=null;}
  addLog(participant.name+(reason==='idle'?' 长时间未操作，已被移出战场。':reason==='left'?' 离开战场，所属单位已解体。':' 已被淘汰。'),null,engine.game.time);
}
function reconcile() {
  if(match.status!=='running')return;
  const aliveTeams=new Set([...engine.units,...engine.structures].filter(e=>e.health>0).map(e=>e.team));
  for(const p of activeParticipants())if(!aliveTeams.has(p.id))eliminate(p,'defeated');
  const alive=activeParticipants();
  if(match.competitionStarted && alive.length<=1) {
    engine.game.outcome=alive[0]?.id??'draw';match.status='finished';match.finishedAt=Date.now();
    addLog(alive[0]?alive[0].name+' 获胜，本局结束。':'所有阵营同时退出，本局平局。',null,engine.game.time);archiveRound();
  }
}
function checkSessions() {
  const now=Date.now();if(now<nextSessionCheck)return;nextSessionCheck=now+1000;
  if(match.status==='running')for(const p of activeParticipants().filter(p=>!p.bot)) {
    const session=sessions.get(p.owner);
    if(session?now-session.lastActivity>=idleTimeoutMs:now>=(p.graceUntil??Infinity))eliminate(p,'idle',true);
  }
  reconcile();
}
function roomInfo(session) {
  const global=match.status!=='running'||sessionInfo(session).role==='observer';
  const people=activeParticipants(),last=participantIndex.get(session.lastResult?.matchId===match.id?session.lastResult.team:null);
  if(last&&!people.includes(last))people.push(last);
  return {...matchInfo(false),self:sessionInfo(session),participants:people.map(p=>publicParticipant(p,global,session.team)),
    buildingStyles:Object.fromEntries(people.map(p=>[p.id,match.buildingStyles[p.id]])),buildingStylePreferences:Object.fromEntries(people.map(p=>[p.id,match.buildingStylePreferences[p.id]])),
    stats:{current:activeParticipants().length,humans:activeParticipants().filter(p=>!p.bot).length,bots:activeParticipants().filter(p=>p.bot).length,
      cumulative:match.participants.length,cumulativeHumans:match.participants.length-match.initialBots,cumulativeBots:match.initialBots,
      observers:[...sessions.values()].filter(s=>s.role==='observer' && Date.now()-s.lastSeen<30000).length}};
}

function entityId(entity) {
  if (!entity) return null;
  if (!entity.width) return 'u' + entity.id;
  entity.viewId ??= 'b' + nextBuilding++;
  return entity.viewId;
}

function pick(record, keys) {
  return Object.fromEntries(keys.map(key => [key, record[key] ?? null]));
}

const unitKeys = ['id','team','type','label','x','y','heading','speed','health','mode','engaged','travel',
  'stride','gaitCycles','lean','turretHeading','aim','altitude','cargo','autoMine','rank'];
const buildingKeys = ['team','type','x','y','width','height','remaining','health','axis','nextPayout'];
const planKeys = ['task','kind','homeReserve'];

function matchInfo(includeParticipants=true) {
  const {participants,...info}=match;
  return {...info,participants:includeParticipants?participants.map(p=>publicParticipant(p)):undefined,durationSeconds:match.startedAt?Math.max(0,((match.finishedAt??Date.now())-match.startedAt)/1000):0,
    time:engine.game.time,outcome:engine.game.outcome,firstEngagement:engine.game.firstEngagement};
}

function observation(session) {
  const team=match.status==='running'?(memberFor(session)?.id??'observer'):'observer',global=team==='observer';
  const view=engine.FACTIONS[team]??{team,commander:{},explored:new Map(),sight:new Set(),scentTargets:new Set(),orders:{},credits:0,power:{supply:0,demand:0,rate:1},support:{fireRate:1,damage:1}};
  const seenUnits = engine.units.filter(unit => unit.health > 0 && (global || engine.canSeeEntity(view, unit)));
  const seenBuildings = engine.structures.filter(building => building.health > 0 && (global || engine.canSeeEntity(view, building)));
  const {width:oilWidth,height:oilHeight}=engine.OIL_FIELD;
  const oilRuins=engine.battlefield.oils.filter(({x,y})=>(global || engine.knowsBuilding(view,{x,y,width:oilWidth,height:oilHeight})) &&
    !engine.structures.some(building=>building.type==='oil' && building.health>0 && building.x===x && building.y===y))
    .map(({x,y})=>({x,y}));
  const visible = new Set([...seenUnits, ...seenBuildings]);
  const visibleId = entity => visible.has(entity) ? entityId(entity) : null;
  const explored = [];
  const ore = [];
  for (const {x,y,stamp=0} of (global?engine.mapTiles:view.explored.values())) {
    if(!global)explored.push([x,y,stamp]);
    if (engine.oreCapacity(x,y)) ore.push([x,y,engine.amountAt(x,y)]);
  }
  const plan = view.commander.plan;
  const review = view.experience;
  const strategy = {
    ...pick(view, ['credits','power','support','factoryCount','factoryBonus','strategy','orders']),
    orders: pick(view.orders, ['mode','task','source']),
    experience:review ? pick(review,['sample','wins','losses','draws','last','focus']) : null,
    plan: plan ? { ...pick(plan, planKeys), followup: plan.followup ? pick(plan.followup, planKeys) : null } : null,
  };
  return {
    ...roomInfo(session),team,globalView:global,explored,ore,oilRuins,strategy,sight:[...view.sight],
    scents: [...view.scentTargets].map(visibleId).filter(Boolean),
    units: seenUnits.map(unit => ({
      ...pick(unit, unitKeys), viewId: entityId(unit),
      goal: unit.goal && (global || unit.team === team || !['bomber','reconPlane','helicopter'].includes(unit.type))
        ? pick(unit.goal, ['x','y','kind']) : null,
      route: global || unit.team === team ? unit.route : [],
      marchLeader: (global||unit.team===team) && unit.marchGroup?.leader===unit,
      marchSize: global||unit.team===team ? unit.marchGroup?.members.length??null : null,
      passengerCount: (global||unit.team === team) && unit.passengers ? unit.passengers.length : null,
      serviceActive: (global||unit.team === team) && Boolean(unit.serviceDepot),
      attackId: visibleId(unit.attackTarget), captureId: visibleId(unit.captureTarget), scentId: visibleId(unit.scentTarget),
    })),
    buildings: seenBuildings.map(building => ({
      ...pick(building, buildingKeys), viewId: entityId(building),
      queue: global || building.team === team ? building.queue : [],
      rally: global || building.team === team ? building.rally : null,
      repair: global || building.team === team ? building.repair : null,
      serviceStatus: (global||building.team === team) && building.type === 'repairDepot' && building.serviceTank?.health>0
        ? building.serviceTank.mode==='garage-repair'?'坦克维修中':'正在接收或放行坦克' : null,
    })),
    sounds: events.filter(event => (global || event.audience.includes(team)) && event.time + 1 > engine.game.time)
      .map(({ audience, ...event }) => event),
    shots: engine.shots.filter(shot => (global || shot.witnesses.includes(team))),
    wrecks: engine.wrecks.filter(wreck => (global || wreck.witnesses.includes(team))),
    dust: engine.movementDust.filter(dust => global || view.explored.has(engine.tileUnder(dust.x,dust.y))),
    impacts: engine.groundImpacts.filter(mark=>global || mark.witnesses.includes(team))
      .map(({x,y,radius,time})=>({x,y,radius,time})),
  };
}

function tick() {
  const clock = performance.now();
  const elapsed = Math.min(.20, (clock - lastTick) / 1000);
  lastTick = clock;
  if (startPending) {
    if (clock-checkpointAt>1000) startPending=!saveSafely();
    return;
  }
  checkSessions();
  if (match.status !== 'running') {
    if (['finished','ended'].includes(match.status) && !roundArchived && clock>=archiveRetryAt) {
      archiveRetryAt=clock+1000;
      archiveRound();
    }
    if(clock-checkpointAt>4500)saveSafely();
    return;
  }
  pending += elapsed;
  while (pending >= step && !engine.game.outcome) {
    engine.stepSimulation(step);
    pending -= step;
  }
  reconcile();
  if(clock-checkpointAt>4500)saveSafely();
}

function command(request) {
  if(request.action==='shutdown'){clearInterval(timer);saveSafely();return matchInfo();}
  const session=visitor(request.session??'internal-observer');session.token=request.session??'internal-observer';
  checkSessions();
  if(['create','join','leave','end','order','building-style','activity'].includes(request.action) && request.current!==match.id)return {error:'match_changed'};
  switch(request.action) {
    case 'status':return roomInfo(session);
    case 'snapshot':return observation(session);
    case 'activity':session.lastActivity=Date.now();return {ok:true};
    case 'create':return createGame(session,request.body);
    case 'join':return joinGame(session,request.body);
    case 'leave':{if(match.status!=='running'){session.role='observer';session.team=null;return roomInfo(session);}const p=memberFor(session);if(p)eliminate(p,'left',true);reconcile();saveSafely();return roomInfo(session);}
    case 'end':{
      if(!permissions(session).canEnd)return {error:'forbidden'};
      match.status='ended';match.finishedAt=Date.now();engine.game.outcome=null;
      addLog((session.name??'观察者')+' 手动结束本局，未分胜负。',null,engine.game.time);archiveRound();return roomInfo(session);
    }
    case 'order':{
      const p=memberFor(session);
      if(!p || match.status!=='running'||startPending)return {error:'forbidden'};
      session.lastActivity=Date.now();
      const resolve=id=>typeof id!=='string'?null:id.startsWith('u')?engine.units.find(u=>'u'+u.id===id):id.startsWith('b')?engine.structures.find(b=>b.viewId===id):null;
      const result=engine.executePlayerOrder(request.order,resolve,p.id);reconcile();return result;
    }
    case 'building-style':{
      const p=memberFor(session);if(!p || request.team!==p.id)return {error:'forbidden'};
      if(!validBuildingThemePreference(request.preference))return {error:'invalid_building_style'};
      session.lastActivity=Date.now();match.buildingStylePreferences[p.id]=request.preference;
      if(request.preference!==RANDOM_BUILDING_THEME)match.buildingStyles[p.id]=request.preference;
      saveSafely();return roomInfo(session);
    }
    case 'history':return history.list(request.team??'observer',request.before);
    case 'historyLog':{const round=history.get(request.round);if(!round)return null;const team=round.reviews[request.team]?request.team:Object.keys(round.reviews)[0];return history.logFile(round.id,team);}
    default:throw Error('Unknown match action');
  }
}

try {
  const saved = v8.deserialize(fs.readFileSync(checkpointFile));
  if (saved.version !== version) throw new Error('Unsupported checkpoint version');
  const description=saved.match;
  description.round??=history.latestRound()+1;description.auto=false;description.nextRoundAt=null;
  if(!description.participants) {
    description.capacity=2;description.mode='multiplayer';description.competitionStarted=true;
    description.participants=['player','enemy'].map((id,index)=>({id,name:index?'红方机器人':'原蓝方玩家',color:palette[index],bot:index===1,
      status:[...saved.units,...saved.structures].some(e=>e.team===id&&e.health>0)?'active':'eliminated',slot:index,legacy:index===0,owner:null,graceUntil:Date.now()+idleTimeoutMs,joinedAt:description.startedAt??Date.now()}));
  }
  description.initialBots??=description.participants.filter(p=>p.bot).length;
  description.buildingStyles=Object.fromEntries(description.participants.map(p=>[p.id,resolveBuildingTheme(description.buildingStyles?.[p.id])]));
  description.buildingStylePreferences=Object.fromEntries(description.participants.map(p=>[p.id,validBuildingThemePreference(description.buildingStylePreferences?.[p.id])?description.buildingStylePreferences[p.id]:'classic']));
  for(const [token,session]of saved.sessions??[])sessions.set(token,session);
  initialise(description,saved);

} catch (error) {
  if(error.code!=='ENOENT')throw error;
  initialise(freshMatch('idle',history.latestRound()+1));
}

const timer = setInterval(tick, 32);
parentPort.on('message', request => {
  try {
    const result = command(request);
    parentPort.postMessage({ id:request.id, result });
    if (request.action === 'shutdown') parentPort.close();
  } catch (error) {
    console.error(error);
    parentPort.postMessage({ id:request.id, error:'match_unavailable' });
  }
});
