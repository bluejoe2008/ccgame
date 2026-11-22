'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomInt, randomUUID } = require('node:crypto');
const vm = require('node:vm');
const v8 = require('node:v8');
const { parentPort, workerData } = require('node:worker_threads');
const { BattleHistory, labels, replaceFile } = require('./battle-history.cjs');
const { BUILDING_THEMES, RANDOM_BUILDING_THEME, validBuildingThemePreference, resolveBuildingTheme } = require('./building-themes.js');

const { checkpointFile, plannerOrigin } = workerData;
const version = 1;
const step = .04;
const roundDelay = 10000;
fs.mkdirSync(path.dirname(checkpointFile), { recursive:true, mode:0o700 });
const history = new BattleHistory(checkpointFile);
const sources = ['commander.js', 'building-themes.js', 'game.js'].map(name =>
  new vm.Script(fs.readFileSync(path.join(__dirname, name), 'utf8'), { filename: name }));

const interfaceScript = new vm.Script(`({
  game, FACTIONS, units, structures, deposits, oreReserves, recoveringOre, searchSites,
  shots, wrecks, movementDust, groundImpacts, stepSimulation, canSeeEntity, oreCapacity, amountAt, tileUnder,
  nextId() { return nextUnitId; },
  restore(saved) {
    for (const name of ['player','enemy']) FACTIONS[name] = saved.factions[name];
    units.splice(0, units.length, ...saved.units);
    structures.splice(0, structures.length, ...saved.structures);
    searchSites.splice(0, searchSites.length, ...saved.searchSites);
    groundImpacts.push(...(saved.groundImpacts??[]));
    for (const [machine, stored] of [[deposits,saved.deposits],[oreReserves,saved.oreReserves],
      [recoveringOre,saved.recoveringOre]]) {
      machine.clear();
      for (const [key,value] of stored) machine.set(key,value);
    }
    nextUnitId = saved.nextUnitId;
    Object.assign(game, saved.game);
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
const factions = ['player','enemy'];
const availableThemes = Object.keys(BUILDING_THEMES);

function stylePreferences(saved) {
  return Object.fromEntries(factions.map(team=>{
    const preference=saved?.[team];
    return [team,validBuildingThemePreference(preference)?preference:RANDOM_BUILDING_THEME];
  }));
}

function addLog(message, team, time, plan) {
  const entry = { id:nextEvent++, message, team, time };
  if (plan) entry.plan=plan;
  logs.push(entry);
  if (logs.length > 190) logs.shift();
  journal.pending.push(entry);
}

function initialise(description, saved = null) {
  match = description;
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
    fetch: (url, options) => fetch(new URL(url, plannerOrigin), options),
    matchEngine: {
      seed: match.seed,
      get buildingStyles() { return match.buildingStyles; },
      planner: Boolean(plannerOrigin),
      log:addLog,
      sound(cue, point, source) {
        const audience = Object.values(engine.FACTIONS).filter(faction =>
          faction.team === source.team || faction.sight.has(engine.tileUnder(point.x, point.y)))
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

function freshMatch(status, round, previousSeed = null, previousPreferences) {
  const chosen=randomInt(previousSeed===null?0x100000000:0xffffffff);
  const seed=previousSeed!==null && chosen>=previousSeed?chosen+1:chosen;
  const buildingStylePreferences=stylePreferences(previousPreferences);
  const buildingStyles=Object.fromEntries(factions.map(team=>{
    const preference=buildingStylePreferences[team];
    return [team,preference===RANDOM_BUILDING_THEME?availableThemes[randomInt(availableThemes.length)]:preference];
  }));
  return { id:randomUUID(), seed, status, round, auto:true, buildingStyles, buildingStylePreferences,
    startedAt:status==='running'?Date.now():null, finishedAt:null, nextRoundAt:null };
}

function save() {
  const { game, FACTIONS, units, structures, searchSites, deposits, oreReserves, recoveringOre, groundImpacts } = engine;
  const offsets = history.append(match.id,journal.offsets,journal.pending);
  const state = {
    version, match, logs, nextEvent, nextBuilding, units, structures, searchSites, deposits, oreReserves, recoveringOre,
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
  if (!saveSafely()) return false;
  try {
    const survivors = Object.fromEntries(['player','enemy'].map(team=>[team,{
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

function startRound() {
  if (['finished','ended'].includes(match.status) && !archiveRound()) return;
  const experience=history.experience();
  const round=match.round+Number(match.status!=='idle');
  initialise(freshMatch('running',round,match.seed,match.buildingStylePreferences));
  addLog('第 '+round+' 局开始。双方开始部署与侦察。',null,0);
  for (const [team,review] of Object.entries(experience)) {
    engine.FACTIONS[team].experience=review;
    if (!review.sample) continue;
    const name=team==='player'?'蓝方':'红方';
    addLog(name+'复习最近 '+review.sample+' 局（'+review.wins+' 胜 '+review.losses+' 负 '+review.draws+' 平）。本局重点：'+
      review.focus.map(task=>labels[task]).join('、')+'。',team,0);
  }
  startPending=!saveSafely();
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

function matchInfo() {
  return { ...match, time: engine.game.time, outcome: engine.game.outcome, firstEngagement: engine.game.firstEngagement };
}

function observation(team) {
  const view = engine.FACTIONS[team];
  const seenUnits = engine.units.filter(unit => unit.health > 0 && engine.canSeeEntity(view, unit));
  const seenBuildings = engine.structures.filter(building => building.health > 0 && engine.canSeeEntity(view, building));
  const visible = new Set([...seenUnits, ...seenBuildings]);
  const visibleId = entity => visible.has(entity) ? entityId(entity) : null;
  const explored = [];
  const ore = [];
  for (const { x, y, stamp } of view.explored.values()) {
    explored.push([x,y,stamp]);
    if (engine.oreCapacity(x,y)) ore.push([x,y,engine.amountAt(x,y)]);
  }
  const plan = view.commander.plan;
  const review = view.experience;
  const strategy = {
    ...pick(view, ['credits','power','support','factoryCount','factoryBonus','strategy','orders']),
    orders: pick(view.orders, ['mode','task','source']),
    research: view.research ? pick(view.research, ['program','remaining']) : null,
    experience:review ? pick(review,['sample','wins','losses','draws','last','focus']) : null,
    manufacturing: view.manufacturing ? pick(view.manufacturing, ['id','remaining']) : null,
    discoveries: [...view.discoveries],
    equipment: [...view.equipment],
    plan: plan ? { ...pick(plan, planKeys), followup: plan.followup ? pick(plan.followup, planKeys) : null } : null,
  };
  return {
    ...matchInfo(), team, explored, ore, strategy, sight: [...view.sight],
    scents: [...view.scentTargets].map(visibleId).filter(Boolean),
    units: seenUnits.map(unit => ({
      ...pick(unit, unitKeys), viewId: entityId(unit),
      goal: unit.goal && (unit.team === team || !['bomber','reconPlane','helicopter'].includes(unit.type))
        ? pick(unit.goal, ['x','y','kind']) : null,
      route: unit.team === team ? unit.route : [],
      marchLeader: unit.team===team && unit.marchGroup?.leader===unit,
      marchSize: unit.team===team ? unit.marchGroup?.members.length??null : null,
      passengerCount: unit.team === team && unit.passengers ? unit.passengers.length : null,
      serviceActive: unit.team === team && Boolean(unit.serviceDepot),
      attackId: visibleId(unit.attackTarget), captureId: visibleId(unit.captureTarget), scentId: visibleId(unit.scentTarget),
    })),
    buildings: seenBuildings.map(building => ({
      ...pick(building, buildingKeys), viewId: entityId(building),
      queue: building.team === team ? building.queue : [],
      rally: building.team === team ? building.rally : null,
      repair: building.team === team ? building.repair : null,
      serviceStatus: building.team === team && building.type === 'repairDepot' && building.serviceTank?.health>0
        ? building.serviceTank.mode==='garage-repair'?'坦克维修中':'正在接收或放行坦克' : null,
    })),
    logs: logs.filter(entry => !entry.team || entry.team === team).slice(-64),
    sounds: events.filter(event => event.audience.includes(team) && event.time + 1 > engine.game.time)
      .map(({ audience, ...event }) => event),
    shots: engine.shots.filter(shot => shot.witnesses.includes(team)),
    wrecks: engine.wrecks.filter(wreck => wreck.witnesses.includes(team)),
    dust: engine.movementDust.filter(dust => view.sight.has(engine.tileUnder(dust.x,dust.y))),
    impacts: engine.groundImpacts.filter(mark=>mark.witnesses.includes(team))
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
  if (match.status !== 'running') {
    if (match.status==='idle' && match.auto) startRound();
    if (['finished','ended'].includes(match.status) && !roundArchived && clock>=archiveRetryAt) {
      archiveRetryAt=clock+1000;
      archiveRound();
    }
    if (match.status==='finished' && match.auto && roundArchived && Date.now()>=match.nextRoundAt) startRound();
    return;
  }
  pending += elapsed;
  while (pending >= step && !engine.game.outcome) {
    engine.stepSimulation(step);
    pending -= step;
  }
  if (engine.game.outcome) {
    match.status = 'finished';
    match.finishedAt=Date.now();
    match.nextRoundAt=match.auto?match.finishedAt+roundDelay:null;
    const result={player:'蓝方获胜。',enemy:'红方获胜。',draw:'双方战成平局。'};
    addLog(result[engine.game.outcome],null,engine.game.time);
    archiveRound();
  } else if (clock - checkpointAt > 4500) {
    saveSafely();
  }
}

function command(request) {
  if (['start','end'].includes(request.action) && request.current && request.current !== match.id) return matchInfo();
  switch (request.action) {
    case 'status': return matchInfo();
    case 'snapshot': return observation(request.team);
    case 'building-style': {
      if (request.current!==match.id) return null;
      const {team,preference}=request;
      if (!factions.includes(team) || !validBuildingThemePreference(preference)) throw new Error('Invalid building style');
      if (match.buildingStylePreferences[team]===preference) return matchInfo();
      const previous=match;
      match={...match, buildingStylePreferences:{...match.buildingStylePreferences,[team]:preference}};
      if (preference!==RANDOM_BUILDING_THEME) match.buildingStyles={...match.buildingStyles,[team]:preference};
      if (!saveSafely()) {
        match=previous;
        throw new Error('Building style checkpoint failed');
      }
      return matchInfo();
    }
    case 'history': return history.list(request.team,request.before);
    case 'historyLog': {
      const round=history.get(request.round);
      return round?history.logFile(round.id,request.team):null;
    }
    case 'start':
      if (match.status !== 'running') startRound();
      return matchInfo();
    case 'end':
      match.auto=false;
      match.nextRoundAt=null;
      if (match.status === 'running') {
        match.status = 'ended';
        match.finishedAt=Date.now();
        addLog('对局由观战者结束。',null,engine.game.time);
        archiveRound();
      } else saveSafely();
      return matchInfo();
    case 'shutdown':
      clearInterval(timer);
      saveSafely();
      return matchInfo();
    default: throw new Error('Unknown match action');
  }
}

try {
  const saved = v8.deserialize(fs.readFileSync(checkpointFile));
  if (saved.version !== version) throw new Error('Unsupported checkpoint version');
  const match=saved.match;
  match.round??=history.latestRound()+1;
  match.auto??=match.status!=='ended';
  match.startedAt??=null;
  match.finishedAt??=null;
  match.nextRoundAt??=match.auto && match.status==='finished'?Date.now()+roundDelay:null;
  match.buildingStyles=Object.fromEntries(factions.map(team=>[team,resolveBuildingTheme(match.buildingStyles?.[team])]));
  match.buildingStylePreferences=stylePreferences(match.buildingStylePreferences);
  initialise(match, saved);
} catch (error) {
  if (error.code !== 'ENOENT') console.error('Cannot restore match:', error.message);
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
