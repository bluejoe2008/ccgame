'use strict';

let observedMatch;
let lastLog = 0;
let lastSound = null;
let pendingControl = false;
let pendingBuildingStyle = false;
let observerConnected = true;
let observationRequest = 0;
let observationTimer;
const displayedUnits = new Map();
const displayedBuildings = new Map();
const unitMotionSamples = new Map();
const motionDelay = 220;
const linearPoseFields = ['x','y','travel','stride','gaitCycles','lean','altitude'];
const angularPoseFields = ['heading','turretHeading'];
const poseFields = [...linearPoseFields,...angularPoseFields];
const historyKey = 'ore-command-open-history';
let historyPage = [];
let historyBefore = null;
let historyRequest = 0;

function rememberHistory(round) {
  try {
    if (round === null) sessionStorage.removeItem(historyKey);
    else sessionStorage.setItem(historyKey,String(round));
  } catch {}
}

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

function battleClock(seconds) {
  const elapsed=Math.floor(seconds);
  return String(Math.floor(elapsed/60)).padStart(2,'0') + ':' + String(elapsed%60).padStart(2,'0');
}

function updateMatchControls() {
  const clock=battleClock(observedMatch?.time??0);
  const statuses = { idle:'等待开始', running:'进行中', ended:'已结束', finished:'已分胜负' };
  const number=observedMatch?.round?'第 '+observedMatch.round+' 局 · ':'';
  const running = observedMatch?.status === 'running';
  const rollover=observedMatch?.status==='finished' && observedMatch.auto;
  const results={player:'蓝方获胜',enemy:'红方获胜',draw:'平局'};
  const winner=results[observedMatch?.outcome];
  const seconds=rollover?Math.max(0,Math.ceil((observedMatch.nextRoundAt-Date.now())/1000)):0;
  const status=rollover ? (winner??'已分胜负')+' · '+(seconds?seconds+' 秒后开始下一局':'准备下一局') :
    (winner??statuses[observedMatch?.status]??'连接中')+' · '+clock;
  byId('match-clock').textContent=number+(observerConnected?status:'重连中 · '+clock);
  byId('start-session').disabled = running || !observerConnected || pendingControl;
  byId('end-session').disabled = (!running && !rollover) || !observerConnected || pendingControl;
  updateBuildingStyleControls();
}

function updateBuildingStyleControls() {
  for (const team of ['player','enemy']) {
    const select=byId('style-'+team);
    const preference=observedMatch?.buildingStylePreferences?.[team];
    select.disabled=!preference || !observerConnected || pendingBuildingStyle;
    if (preference && !pendingBuildingStyle && select.value!==preference) select.value=preference;
    const current=byId('style-current-'+team);
    const theme=observedMatch?.buildingStyles?.[team];
    const label=hasBuildingTheme(theme)?'本局 '+BUILDING_THEMES[theme].label:'';
    if (current.textContent!==label) current.textContent=label;
  }
}

async function chooseBuildingStyle(team,preference) {
  if (pendingBuildingStyle) return;
  pendingBuildingStyle=true;
  const status=byId('style-status');
  status.textContent='';
  updateBuildingStyleControls();
  try {
    const response=await fetch('/api/match/building-style',{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Match-Id':observedMatch.id},
      body:JSON.stringify({team,preference}),
      signal:AbortSignal.timeout(9000),
    });
    if (response.status===409) {
      await pollObservation();
      return;
    }
    if (!response.ok) throw new Error('Building style update failed');
    const state=await response.json();
    if (state.id===observedMatch.id) {
      observedMatch.buildingStyles=state.buildingStyles;
      observedMatch.buildingStylePreferences=state.buildingStylePreferences;
    }
    await pollObservation();
  } catch {
    status.textContent='风格设置未保存，请重试。';
  } finally {
    pendingBuildingStyle=false;
    updateBuildingStyleControls();
  }
}

function updateHistoryReview() {
  const select=byId('history-round');
  const item=historyPage.find(round=>String(round.round)===select.value);
  const logLink=byId('history-log');
  byId('history-summary').textContent=item?item.review.summary:'';
  byId('history-status').textContent=item?(item.completeLogs?'':'此局跨越升级，只保存了接入时尚留存的旧日志及之后的记录。'):
    '已有战史会在对局结束后显示。';
  const fill=(id,text)=>byId(id).replaceChildren(...text.map(value=>{
    const line=document.createElement('li');
    line.textContent=value;
    return line;
  }));
  fill('history-evidence',item?.review.evidence??[]);
  const lessons=item?.review.lessons.map(lesson=>lesson.reason)??[];
  byId('history-lessons-title').hidden=!lessons.length;
  fill('history-lessons',lessons);
  logLink.hidden=!item;
  if (item) {
    logLink.href='/api/history/'+item.round+'/log?perspective='+game.perspective;
    rememberHistory(item.round);
  }
}

async function loadBattleHistory({older=false,selected=0}={}) {
  const request=++historyRequest;
  const team=game.perspective;
  const before=older?historyBefore:selected?Number(selected)+1:null;
  byId('history-status').textContent='正在加载战史…';
  byId('history-older').disabled=true;
  try {
    const url='/api/history?perspective='+team+(before?'&before='+before:'');
    const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(9000)});
    if (!response.ok) throw new Error('History unavailable');
    const page=await response.json();
    if (request!==historyRequest || !byId('battle-history').open) return;
    historyPage=older?[...historyPage,...page.rounds]:page.rounds;
    historyBefore=page.before;
    const select=byId('history-round');
    const selectedRound=older?page.rounds[0]?.round:selected||historyPage[0]?.round;
    const resultLabels={win:'胜',loss:'负',draw:'平',stopped:'人工结束'};
    select.replaceChildren(...historyPage.map(round=>{
      const option=document.createElement('option');
      option.value=round.round;
      option.textContent='第 '+round.round+' 局 · '+resultLabels[round.review.result]+' · '+battleClock(round.duration);
      return option;
    }));
    select.disabled=!historyPage.length;
    if (historyPage.some(round=>round.round===Number(selectedRound))) select.value=selectedRound;
    byId('history-title').textContent=(team==='player'?'蓝方':'红方')+'战史与复盘';
    byId('history-older').hidden=!historyBefore;
    updateHistoryReview();
  } catch {
    if (request===historyRequest) byId('history-status').textContent='战史暂时无法加载。';
  } finally {
    if (request===historyRequest) byId('history-older').disabled=false;
  }
}

function openBattleHistory(selected=0) {
  const dialog=byId('battle-history');
  if (!dialog.open) dialog.showModal();
  rememberHistory(selected);
  loadBattleHistory({selected});
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
      gaitCycles:record.gaitCycles ?? (record.type==='dog' ? (record.travel ?? 0)/1.34 : 0),
      lean:record.lean ?? 0, altitude:record.altitude ?? 0, heading:record.heading,
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
  if (snapshot.explored.length !== faction.explored.size ||
      snapshot.explored.some(([x,y,stamp])=>faction.explored.get(tileKey(x,y))?.stamp!==stamp)) {
    faction.explored = new Map(snapshot.explored.map(([x,y,stamp]) => [tileKey(x,y),{ x,y,stamp }]));
  }
  if (snapshot.sight.length !== faction.sight.size || snapshot.sight.some(key=>!faction.sight.has(key))) {
    faction.sight = new Set(snapshot.sight);
  }
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
  groundImpacts.splice(0,groundImpacts.length,...(snapshot.impacts??[]));
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
  if (outcomeChanged && game.outcome && !document.hidden) sound.play(game.outcome===snapshot.team?'ready':'alert');
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
  units.length = structures.length = shots.length = wrecks.length = movementDust.length = groundImpacts.length = 0;
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
  for (const team of ['player','enemy']) {
    const select=byId('style-'+team);
    select.add(new Option('每局随机',RANDOM_BUILDING_THEME));
    for (const [value,theme] of Object.entries(BUILDING_THEMES)) select.add(new Option(theme.label,value));
    select.addEventListener('change',()=>chooseBuildingStyle(team,select.value));
  }
  applyObservation(snapshot);
  byId('start-session').addEventListener('click',()=>controlMatch('start'));
  byId('end-session').addEventListener('click',()=>controlMatch('end'));
  byId('open-history').addEventListener('click',()=>openBattleHistory());
  byId('history-round').addEventListener('change',updateHistoryReview);
  byId('history-older').addEventListener('click',()=>loadBattleHistory({older:true}));
  byId('battle-history').addEventListener('close',()=>{
    historyRequest++;
    rememberHistory(null);
  });
  let previousHistory=null;
  try { previousHistory=sessionStorage.getItem(historyKey); } catch {}
  if (previousHistory!==null) openBattleHistory(Number(previousHistory));
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
  script.src = 'game.js?v=building-themes';
  document.head.append(script);
}
bootObserver();
