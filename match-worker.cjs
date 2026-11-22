'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomInt, randomUUID } = require('node:crypto');
const vm = require('node:vm');
const v8 = require('node:v8');
const { parentPort, workerData } = require('node:worker_threads');

const { checkpointFile, plannerOrigin } = workerData;
const version = 1;
const step = .04;
const sources = ['commander.js', 'game.js'].map(name =>
  new vm.Script(fs.readFileSync(path.join(__dirname, name), 'utf8'), { filename: name }));

const interfaceScript = new vm.Script(`({
  game, FACTIONS, units, structures, deposits, oreReserves, recoveringOre, searchSites,
  shots, wrecks, movementDust, stepSimulation, canSeeEntity, oreCapacity, amountAt, tileUnder,
  nextId() { return nextUnitId; },
  restore(saved) {
    for (const name of ['player','enemy']) FACTIONS[name] = saved.factions[name];
    units.splice(0, units.length, ...saved.units);
    structures.splice(0, structures.length, ...saved.structures);
    searchSites.splice(0, searchSites.length, ...saved.searchSites);
    for (const [machine, stored] of [[deposits,saved.deposits],[oreReserves,saved.oreReserves],
      [recoveringOre,saved.recoveringOre]]) {
      machine.clear();
      for (const [key,value] of stored) machine.set(key,value);
    }
    nextUnitId = saved.nextUnitId;
    Object.assign(game, saved.game);
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
const heardAt = new Map();

function initialise(description, saved = null) {
  match = description;
  logs = saved?.logs ?? [];
  events = [];
  nextEvent = saved?.nextEvent ?? 1;
  nextBuilding = saved?.nextBuilding ?? 1;
  pending = 0;
  lastTick = performance.now();
  heardAt.clear();
  const context = vm.createContext({
    AbortSignal,
    fetch: (url, options) => fetch(new URL(url, plannerOrigin), options),
    matchEngine: {
      seed: match.seed,
      planner: Boolean(plannerOrigin),
      log(message, team, time) {
        logs.push({ id: nextEvent++, message, team, time });
        if (logs.length > 190) logs.shift();
      },
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

function freshMatch(status) {
  return { id: randomUUID(), seed: randomInt(0x100000000), status };
}

function save() {
  const { game, FACTIONS, units, structures, searchSites, deposits, oreReserves, recoveringOre } = engine;
  const state = {
    version, match, logs, nextEvent, nextBuilding, units, structures, searchSites, deposits, oreReserves, recoveringOre,
    factions: FACTIONS,
    nextUnitId: engine.nextId(),
    game: { time: game.time, outcome: game.outcome, firstEngagement: game.firstEngagement },
  };
  const temporary = checkpointFile + '.tmp';
  fs.writeFileSync(temporary, v8.serialize(state), { mode: 0o600 });
  fs.renameSync(temporary, checkpointFile);
  checkpointAt = performance.now();
}

function saveSafely() {
  try {
    save();
  } catch (error) {
    console.error('Match checkpoint failed:', error.message);
    checkpointAt = performance.now();
  }
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
  'stride','lean','turretHeading','aim','altitude','cargo','autoMine'];
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
  const strategy = {
    ...pick(view, ['credits','power','support','factoryCount','factoryBonus','strategy','orders']),
    orders: pick(view.orders, ['mode','task','source']),
    research: view.research ? pick(view.research, ['program','remaining']) : null,
    manufacturing: view.manufacturing ? pick(view.manufacturing, ['id','remaining']) : null,
    discoveries: [...view.discoveries],
    equipment: [...view.equipment],
    plan: plan ? { ...pick(plan, planKeys), followup: plan.followup ? pick(plan.followup, planKeys) : null } : null,
  };
  return {
    ...matchInfo(), team, explored, ore, strategy, sight: [...view.sight],
    scents: [...view.scentTargets].map(visibleId).filter(Boolean),
    units: seenUnits.map(unit => ({
      ...pick(unit, unitKeys), viewId: entityId(unit), goal: unit.goal ? pick(unit.goal, ['x','y','kind']) : null,
      route: unit.team === team ? unit.route : [],
      attackId: visibleId(unit.attackTarget), captureId: visibleId(unit.captureTarget), scentId: visibleId(unit.scentTarget),
    })),
    buildings: seenBuildings.map(building => ({
      ...pick(building, buildingKeys), viewId: entityId(building),
      queue: building.team === team ? building.queue : [],
      rally: building.team === team ? building.rally : null,
      repair: building.team === team ? building.repair : null,
    })),
    logs: logs.filter(entry => !entry.team || entry.team === team).slice(-64),
    sounds: events.filter(event => event.audience.includes(team) && event.time + 1 > engine.game.time)
      .map(({ audience, ...event }) => event),
    shots: engine.shots.filter(shot => shot.witnesses.includes(team)),
    wrecks: engine.wrecks.filter(wreck => wreck.witnesses.includes(team)),
    dust: engine.movementDust.filter(dust => view.sight.has(engine.tileUnder(dust.x,dust.y))),
  };
}

function tick() {
  const clock = performance.now();
  const elapsed = Math.min(.20, (clock - lastTick) / 1000);
  lastTick = clock;
  if (match.status !== 'running') return;
  pending += elapsed;
  while (pending >= step && !engine.game.outcome) {
    engine.stepSimulation(step);
    pending -= step;
  }
  if (engine.game.outcome) {
    match.status = 'finished';
    saveSafely();
  } else if (clock - checkpointAt > 4500) {
    saveSafely();
  }
}

function command(request) {
  if (['start','end'].includes(request.action) && request.current && request.current !== match.id) return matchInfo();
  switch (request.action) {
    case 'status': return matchInfo();
    case 'snapshot': return observation(request.team);
    case 'start':
      if (match.status !== 'running') {
        initialise(freshMatch('running'));
        logs.push({ id: nextEvent++, message:'双方开始部署与侦察。', team:null, time:0 });
        saveSafely();
      }
      return matchInfo();
    case 'end':
      if (match.status === 'running') {
        match.status = 'ended';
        logs.push({ id: nextEvent++, message:'对局已结束。', team:null, time:engine.game.time });
        saveSafely();
      }
      return matchInfo();
    case 'shutdown':
      clearInterval(timer);
      saveSafely();
      return matchInfo();
    default: throw new Error('Unknown match action');
  }
}

fs.mkdirSync(path.dirname(checkpointFile), { recursive: true, mode: 0o700 });
try {
  const saved = v8.deserialize(fs.readFileSync(checkpointFile));
  if (saved.version !== version) throw new Error('Unsupported checkpoint version');
  initialise(saved.match, saved);
} catch (error) {
  if (error.code !== 'ENOENT') console.error('Cannot restore match:', error.message);
  initialise(freshMatch('idle'));
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
