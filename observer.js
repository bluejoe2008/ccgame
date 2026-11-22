'use strict';

let observedMatch;
let lastLog = 0;
let lastSound = null;
let pendingControl = false;
let observerConnected = true;
let observationRequest = 0;
let observationTimer;
const displayedUnits = new Map();
const displayedBuildings = new Map();
const unitMotionSamples = new Map();
const motionDelay = 220;
const linearPoseFields = ['x','y','travel','stride','lean'];
const angularPoseFields = ['heading','turretHeading'];
const poseFields = [...linearPoseFields,...angularPoseFields];

function savedPerspective() {
  try {
    return sessionStorage.getItem('ore-command-perspective') === 'enemy' ? 'enemy' : 'player';
  } catch {
    return 'player';
  }
}

async function fetchObservation(team) {
  const response = await fetch('/api/match?perspective=' + team, { cache: 'no-store', signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error('Match unavailable');
  return response.json();
}

function updateMatchControls() {
  const elapsed = Math.floor(observedMatch?.time ?? 0);
  const clock = String(Math.floor(elapsed/60)).padStart(2,'0') + ':' + String(elapsed%60).padStart(2,'0');
  const statuses = { idle:'等待开始', running:'进行中', ended:'已结束', finished:'已分胜负' };
  byId('match-clock').textContent = observerConnected ? (statuses[observedMatch?.status] ?? '连接中') + ' · ' + clock : '重连中 · ' + clock;
  const running = observedMatch?.status === 'running';
  byId('start-session').disabled = running || !observerConnected || pendingControl;
  byId('end-session').disabled = !running || !observerConnected || pendingControl;
}

function updateObserverEntities(records, registry, destination, receivedAt) {
  const mobile = registry === displayedUnits;
  const active = new Set(records.map(record => record.viewId));
  for (const id of registry.keys()) {
    if (!active.has(id)) {
      registry.delete(id);
      if (mobile) unitMotionSamples.delete(id);
    }
  }
  const updated = records.map(record => {
    let entity = registry.get(record.viewId);
    if (!entity) {
      entity = {};
      registry.set(record.viewId, entity);
    }
    if (!mobile || reducedMotion.matches) {
      if (mobile) unitMotionSamples.delete(record.viewId);
      return Object.assign(entity,record);
    }
    const samples = unitMotionSamples.get(record.viewId) ?? [];
    const last = samples.at(-1);
    const pose = {
      x:record.x, y:record.y, travel:record.travel ?? 0, stride:record.stride ?? 0,
      lean:record.lean ?? 0, heading:record.heading,
      turretHeading:record.turretHeading ?? record.heading,
    };
    const continuous = last && entity.type === record.type && pose.travel >= last.pose.travel &&
      receivedAt-last.time < 700 && Math.hypot(last.pose.x-pose.x,last.pose.y-pose.y) < 5;
    const displayed = continuous ? Object.fromEntries(poseFields.map(key=>[key,entity[key]])) : pose;
    if (!continuous) samples.length=0;
    samples.push({ time:receivedAt, pose });
    if (samples.length>6) samples.shift();
    unitMotionSamples.set(record.viewId,samples);
    return Object.assign(entity,record,displayed);
  });
  destination.splice(0,destination.length,...updated);
}

function interpolateObservation(timestamp) {
  const time = timestamp-motionDelay;
  for (const [id, samples] of unitMotionSamples) {
    const unit = displayedUnits.get(id);
    if (!unit) continue;
    while (samples.length>1 && samples[1].time<=time) samples.shift();
    const [from,to] = samples;
    if (reducedMotion.matches || !to || time<=from.time) {
      Object.assign(unit,(reducedMotion.matches ? samples.at(-1) : from).pose);
      continue;
    }
    // Distance and position follow the same samples so feet don't outrun the rendered unit.
    const progress = (time-from.time)/(to.time-from.time);
    for (const key of linearPoseFields) unit[key] = mix(from.pose[key],to.pose[key],progress);
    for (const key of angularPoseFields) {
      unit[key] = from.pose[key]+angleDifference(to.pose[key],from.pose[key])*progress;
    }
  }
}

function applyObservation(snapshot) {
  if (observedMatch && snapshot.id !== observedMatch.id) {
    location.reload();
    return;
  }
  if (snapshot.team !== game.perspective) return;
  const outcomeChanged = game.outcome !== snapshot.outcome;
  observedMatch = snapshot;
  game.time = snapshot.time;
  game.outcome = snapshot.outcome;
  game.firstEngagement = snapshot.firstEngagement;
  const faction = viewFaction();
  faction.explored = new Map(snapshot.explored.map(([x,y,stamp]) => [tileKey(x,y),{ x,y,stamp }]));
  faction.sight = new Set(snapshot.sight);
  for (const [x,y,value] of snapshot.ore) deposits.set(tileKey(x,y),value);
  updateObserverEntities(snapshot.buildings,displayedBuildings,structures);
  updateObserverEntities(snapshot.units,displayedUnits,units,performance.now());
  const entity = id => displayedUnits.get(id) ?? displayedBuildings.get(id) ?? null;
  for (const unit of units) {
    unit.attackTarget = entity(unit.attackId);
    unit.captureTarget = entity(unit.captureId);
    unit.scentTarget = entity(unit.scentId);
  }
  faction.scentTargets = new Set(snapshot.scents.map(entity).filter(Boolean));
  const { plan, discoveries, equipment, ...strategy } = snapshot.strategy;
  Object.assign(faction,strategy);
  faction.commander.plan = plan;
  faction.discoveries = new Set(discoveries);
  faction.equipment = new Set(equipment);
  shots.splice(0,shots.length,...snapshot.shots);
  wrecks.splice(0,wrecks.length,...snapshot.wrecks);
  movementDust.splice(0,movementDust.length,...snapshot.dust);
  for (const entry of snapshot.logs) {
    if (entry.id <= lastLog) continue;
    log(entry.message,entry.team,entry.time);
    lastLog = entry.id;
  }
  const previousSound = lastSound;
  lastSound = Math.max(lastSound ?? 0,...snapshot.sounds.map(event=>event.id));
  if (previousSound !== null && snapshot.status === 'running' && !document.hidden) {
    for (const event of snapshot.sounds) {
      if (event.id > previousSound) playAt(event.cue,event,{ id:event.source,team:snapshot.team });
    }
  }
  if (outcomeChanged && game.outcome) showMatchResult(game.outcome);
  updateMatchControls();
}

async function pollObservation() {
  clearTimeout(observationTimer);
  const id = ++observationRequest;
  try {
    const snapshot = await fetchObservation(game.perspective);
    if (id !== observationRequest) return;
    observerConnected = true;
    applyObservation(snapshot);
  } catch {
    if (id !== observationRequest) return;
    observerConnected = false;
    updateMatchControls();
  }
  if (id === observationRequest) {
    const interval = document.hidden ? 800 : !observerConnected ? 1250 : observedMatch?.status === 'running' ? 180 : 600;
    observationTimer = setTimeout(pollObservation,interval);
  }
}

function setPerspectiveButtons(team) {
  byId('view-blue').setAttribute('aria-pressed',String(team==='player'));
  byId('view-red').setAttribute('aria-pressed',String(team==='enemy'));
}

function changeObserverPerspective(team,origin) {
  if (team === game.perspective) return;
  try { sessionStorage.setItem('ore-command-perspective',team); } catch {}
  game.perspective = team;
  setPerspectiveButtons(team);
  selectUnit(null);
  displayedUnits.clear();
  displayedBuildings.clear();
  unitMotionSamples.clear();
  units.length = structures.length = shots.length = wrecks.length = movementDust.length = 0;
  byId('log').replaceChildren();
  lastLog = 0;
  lastSound = null;
  centerCamera(origin);
  pollObservation();
}

async function controlMatch(action) {
  if (pendingControl) return;
  pendingControl = true;
  updateMatchControls();
  try {
    const response = await fetch('/api/match/' + action,{
      method:'POST', headers:{'X-Match-Id':observedMatch.id},signal:AbortSignal.timeout(9000),
    });
    if (!response.ok) throw new Error('Match control failed');
    const state = await response.json();
    if (state.id !== observedMatch?.id) location.reload();
    else await pollObservation();
  } catch {
    notice('战局操作暂未完成，请重试。');
  } finally {
    pendingControl = false;
    updateMatchControls();
  }
}

function attachObserver(snapshot) {
  game.perspective = snapshot.team;
  setPerspectiveButtons(snapshot.team);
  viewFaction().explored.clear();
  viewFaction().sight.clear();
  const yard = snapshot.buildings.find(building => building.team === snapshot.team && building.type === 'yard');
  const mobile = snapshot.units.find(unit => unit.team === snapshot.team);
  centerCamera(yard ? yardCenter(yard) : mobile ?? (snapshot.team === 'player' ? blueOrigin : redOrigin));
  applyObservation(snapshot);
  byId('start-session').addEventListener('click',()=>controlMatch('start'));
  byId('end-session').addEventListener('click',()=>controlMatch('end'));
  document.addEventListener('visibilitychange',()=>{ if (!document.hidden) pollObservation(); });
  syncHud();
  pollObservation();
}

async function bootObserver() {
  try {
    globalThis.matchBootstrap = await fetchObservation(savedPerspective());
  } catch {
    document.getElementById('match-clock').textContent = '正在连接服务器';
    setTimeout(bootObserver,1500);
    return;
  }
  const script = document.createElement('script');
  script.src = 'game.js?v=unit-ranks';
  document.head.append(script);
}
bootObserver();
