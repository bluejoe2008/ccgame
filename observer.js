'use strict';

let observedMatch;
let lastSound = null;
let pendingControl = false;
let playerOrderRequests = Promise.resolve();
let observerConnected = true;
let observationRequest = 0;
let observationTimer;
let shownResultMatch = null;
const displayedUnits = new Map();
const displayedBuildings = new Map();
const unitMotionSamples = new Map();
const motionDelay = 220;
const linearPoseFields = ['x','y','travel','stride','gaitCycles','lean','altitude'];
const angularPoseFields = ['heading','turretHeading'];
const poseFields = [...linearPoseFields,...angularPoseFields];
async function fetchObservation() {
  const response = await fetch('/api/match', { cache: 'no-store', signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error('Match unavailable');
  return response.json();
}

function battleClock(seconds) {
  const elapsed=Math.max(0,Math.floor(seconds));
  return [Math.floor(elapsed/3600),Math.floor(elapsed/60)%60,elapsed%60].map(n=>String(n).padStart(2,'0')).join(':');
}
function playerCanCommand() {
  return observedMatch?.status==='running' && observedMatch.self?.role==='player' &&
    observedMatch.self.team===game.perspective && observerConnected;
}
function updateMatchControls() {
  const state=observedMatch,self=state?.self,stats=state?.stats;
  const statuses={idle:'等待创建',running:'进行中',ended:'手动结束',finished:'已分胜负'};
  const winner=state?.participants.find(p=>p.id===state.outcome);
  byId('match-clock').textContent='第 '+(state?.round??1)+' 局 · '+(observerConnected?(winner?winner.name+' 获胜':statuses[state?.status]??'连接中'):'重连中')+' · '+battleClock(state?.durationSeconds??0);
  byId('map-heading').textContent=self?.role==='player'&&state.status==='running'?self.name+' / 玩家':'全局观察者';
  byId('start-session').disabled=!self?.canCreate||!observerConnected||pendingControl;
  byId('join-session').disabled=!self?.canJoin||!observerConnected||pendingControl;
  byId('join-session').hidden=state?.status!=='running'||self?.role==='player';
  byId('end-session').disabled=!self?.canEnd||!observerConnected||pendingControl;
  byId('end-session').title=self?.canEnd?'手动结束，不判胜负':'仅唯一人类玩家，或无人类参战时的观察者可以结束';
  byId('leave-session').hidden=self?.role!=='player'||state?.status!=='running';
  byId('leave-session').disabled=pendingControl||!observerConnected;
  byId('map-shortcuts').textContent=self?.role==='player'?'左键下令 · 拖动框选 · 右键取消':'全局观察 · 滚轮移动视野';
  byId('room-stats').textContent=stats?(['finished','ended'].includes(state.status)?'结束时剩余 ':'当前 ')+stats.current+' / '+state.capacity+' 方（人类 '+stats.humans+' · 机器人 '+stats.bots+'） · 累计参战 '+stats.cumulative+'（人类 '+stats.cumulativeHumans+' · 机器人 '+stats.cumulativeBots+'） · 观察者 '+stats.observers:'';
  const remaining=self?.idleRemaining;
  byId('idle-warning').hidden=!(state?.status==='running'&&self?.role==='player'&&remaining!==null&&remaining<=60000);
  byId('idle-warning').textContent='已有一段时间未操作，'+Math.ceil((remaining??0)/1000)+' 秒后将被移出战场。操作游戏即可取消。';
  updateRoomRoster();
}
function updateRoomRoster() {
  const roster=byId('room-roster'),people=observedMatch?.participants??[];
  const key=JSON.stringify(people.map(p=>[p.id,p.name,p.color,p.status,p.bot,p.theme,p.units,p.buildings,p.credits]));
  if(roster.dataset.state===key)return;roster.dataset.state=key;
  roster.replaceChildren(...people.filter(p=>p.status==='active').map(p=>{
    const row=document.createElement('button');row.type='button';row.className='roster-row';
    const swatch=document.createElement('i');swatch.style.background=p.color;swatch.setAttribute('aria-hidden','true');
    const name=document.createElement('span');name.textContent=p.name+(p.id===observedMatch.self.team?'（我）':'')+' · '+(p.bot?'机器人':'人类');
    const counts=document.createElement('small');counts.textContent=(p.units===null?'未侦察':p.buildings+' 建筑 / '+p.units+' 单位')+' · '+(BUILDING_THEMES[p.theme]?.label??'');
    row.append(swatch,name,counts);row.title=p.name+' · '+(p.bot?'机器人':'人类')+' · '+(BUILDING_THEMES[p.theme]?.label??'')+'；点击定位已知位置';
    row.addEventListener('click',()=>{const entity=structures.find(b=>b.team===p.id)??units.find(u=>u.team===p.id);if(entity)centerCamera(entity.width?yardCenter(entity):entity);else notice('当前没有该方的已知位置。');});
    return row;
  }));
  byId('roster-count').textContent=String(people.filter(p=>p.status==='active').length);
}

function showMatchResult(snapshot) {
  const result=snapshot.self?.result;
  const terminal=snapshot.status==='finished'||snapshot.status==='ended';
  const key=snapshot.id+':'+(result?.kind??snapshot.status);
  if((!terminal&&!result)||shownResultMatch===key)return;
  const participant=snapshot.participants.find(p=>p.id===(snapshot.self?.team??result?.team));
  let title;
  if(result?.kind==='idle')title='已离线退出';
  else if(result?.kind==='left')return;
  else if(result?.kind==='defeated')title='你输了';
  else if(snapshot.status==='ended')title='本局已结束';
  else if(snapshot.outcome==='draw')title='平局';
  else title=participant?(snapshot.outcome===participant.id?'你赢了':'你输了'):(snapshot.participants.find(p=>p.id===snapshot.outcome)?.name??'胜者')+' 获胜';
  const dialog=byId('match-result');dialog.dataset.outcome=title==='你输了'||result?.kind==='idle'?'enemy':snapshot.outcome==='draw'?'draw':'player';
  byId('match-result-title').textContent=title;
  byId('match-result-detail').textContent='第 '+snapshot.round+' 局 · '+battleClock(snapshot.durationSeconds)+(result?.kind==='idle'?' · 10 分钟未操作，所属单位已清除。':'');
  if(!dialog.open)dialog.showModal();shownResultMatch=key;
}

const orderErrors={
  inactive:'当前没有可指挥的对局。',forbidden:'你没有执行此操作的权限。', invalid:'请点击地图内的有效位置。', unavailable:'所选单位或目标无法执行该指令。',
  placement:'这里无法建造。请选择范围内已探明的空地。', credits:'储备不足。', unexplored:'请先探索该区域。',
  route:'无法到达目标位置。', capture:'工程师无法接近占领目标。', transport:'请让人员靠近已落地且有空位的直升机。',
};

function sendPlayerOrder(order,message) {
  if (!playerCanCommand()) return Promise.resolve(false);
  const current=observedMatch.id;
  playerOrderRequests=playerOrderRequests.then(async()=>{
    if (!playerCanCommand() || observedMatch.id!==current) return false;
    try {
      const response=await fetch('/api/match/order',{
        method:'POST',headers:{'Content-Type':'application/json','X-Match-Id':current},
        body:JSON.stringify(order),signal:AbortSignal.timeout(9000),
      });
      const result=await response.json();
      if (!response.ok) {
        notice(orderErrors[result.error]??'指令未能完成，请重试。');
        return false;
      }
      notice(message);
      await pollObservation();
      return true;
    } catch {
      notice('连接中断，未能确认指令结果。');
      return false;
    }
  });
  return playerOrderRequests;
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
      gaitCycles:record.gaitCycles ?? (record.type==='dog' ? (record.travel ?? 0)/(1.34*DOG_SCALE) : 0),
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
  TEAM_CONFIGS.splice(0,TEAM_CONFIGS.length,...snapshot.participants);
  TEAM_CONFIG_INDEX.clear();for(const person of TEAM_CONFIGS)TEAM_CONFIG_INDEX.set(person.id,person);
  for(const team of Object.keys(FACTIONS))if(team!=='observer'&&!TEAM_CONFIG_INDEX.has(team))delete FACTIONS[team];
  for(const person of TEAM_CONFIGS){if(!FACTIONS[person.id])FACTIONS[person.id]=createFaction(person.id);if(TEAM_PAINT[person.id]?.radar!==person.color)installTeamPaint(person.id);for(const key of ['power','support','factoryCount','factoryBonus'])if(person[key]!==null&&person[key]!==undefined)FACTIONS[person.id][key]=person[key];}
  if(snapshot.team!==game.perspective) {
    game.perspective=snapshot.team;game.selection=[];game.selectedBuilding=null;game.placement=null;game.follow=null;
    displayedUnits.clear();displayedBuildings.clear();unitMotionSamples.clear();
    if(snapshot.team!=='observer') {
      const unit=snapshot.units.find(u=>u.team===snapshot.team);if(unit)centerCamera(unit);
    }
  }
  const outcomeChanged = game.outcome !== snapshot.outcome;
  observedMatch = snapshot;
  if (snapshot.status!=='running') game.placement=null;
  game.time = snapshot.time;
  game.outcome = snapshot.outcome;
  game.firstEngagement = snapshot.firstEngagement;
  const faction = viewFaction();
  if (snapshot.globalView) {
    if(faction.explored.size!==mapTiles.length)faction.explored=new Map(mapTiles.map(tile=>[tileKey(tile.x,tile.y),{...tile,stamp:-10}]));
  } else if (snapshot.explored.length !== faction.explored.size ||
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
  const { plan, ...strategy } = snapshot.strategy;
  Object.assign(faction,strategy);
  faction.commander.plan = plan;
  shots.splice(0,shots.length,...snapshot.shots);
  wrecks.splice(0,wrecks.length,...snapshot.wrecks);
  movementDust.splice(0,movementDust.length,...snapshot.dust);
  groundImpacts.splice(0,groundImpacts.length,...(snapshot.impacts??[]));
  oilRuins.splice(0,oilRuins.length,...(snapshot.oilRuins??[]));
  const previousSound = lastSound;
  lastSound = Math.max(lastSound ?? 0,...snapshot.sounds.map(event=>event.id));
  if (previousSound !== null && snapshot.status === 'running' && !document.hidden) {
    for (const event of snapshot.sounds) {
      if (event.id > previousSound) playAt(event.cue,event,{ id:event.source,team:snapshot.team });
    }
  }
  if (outcomeChanged && game.outcome && !document.hidden) sound.play(game.outcome===snapshot.team?'ready':'alert');
  updateMatchControls();
  showMatchResult(snapshot);
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
    const interval=document.hidden?1200:!observerConnected?1250:observedMatch?.status==='running'?(observedMatch.globalView?350:180):800;
    observationTimer = setTimeout(pollObservation,interval);
  }
}

const roomErrors={game_running:'已有正在运行的游戏，请申请加入。',invalid_name:'请输入 1～24 个字符的用户名。',invalid_color:'请选择有效颜色。',invalid_theme:'请选择有效风格。',invalid_capacity:'阵营上限为 2～16，机器人数必须少于总上限。',full:'当前游戏人数已满。',name_taken:'此用户名已被当前参战玩家使用。',color_taken:'此颜色已被当前参战方使用，请选择其他颜色。',spawn_busy:'空余出生区暂时被占用，请稍后重试。',inactive:'当前没有正在运行的游戏。',forbidden:'当前身份无权执行此操作。',match_changed:'游戏已经变更，请刷新状态后重试。',archive_pending:'战报正在保存，请稍后重试。'};
async function controlMatch(action,body=null) {
  if(pendingControl)return false;pendingControl=true;updateMatchControls();
  try {
    const response=await fetch('/api/match/'+action,{method:'POST',headers:{'X-Match-Id':observedMatch.id,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(35000)});
    const state=await response.json();
    if(!response.ok){const message=roomErrors[state.error]??'操作未完成，请重试。';byId('room-form-error').textContent=message;notice(message);return false;}
    if(state.id!==observedMatch.id){location.reload();return true;}
    await pollObservation();return true;
  }catch{byId('room-form-error').textContent='连接暂时中断，请重试。';return false;}
  finally{pendingControl=false;updateMatchControls();}
}
function openRoomForm(mode) {
  const form=byId('room-form');form.dataset.mode=mode;
  byId('room-form-title').textContent=mode==='create'?'创建新游戏':'加入当前游戏';
  byId('room-create-fields').hidden=mode!=='create';byId('room-create-fields').disabled=mode!=='create';byId('room-form-error').textContent='';
  byId('room-form-submit').textContent=mode==='create'?'创建并参战':'加入战场';
  if(!byId('room-name').value)byId('room-name').value=localStorage.getItem('cc-player-name')??'';
  const used=new Set((observedMatch.participants??[]).filter(p=>p.status==='active'&&!p.id.startsWith('player')).map(p=>p.color));
  const colors=['#4c91d1','#df6155','#6cbd71','#d9af4b','#ae7be5','#43bfc6','#e781b7','#dc8645','#a0b85c','#7a94e5','#c9c9c9','#a97855','#59cda5','#c47e92','#baca65','#c6a0dd'];
  byId('room-colors').replaceChildren(...colors.map(color=>{const button=document.createElement('button');button.type='button';button.style.background=color;button.title=color;button.setAttribute('aria-label','选择阵营颜色 '+color);button.disabled=mode==='join'&&used.has(color);button.addEventListener('click',()=>byId('room-color').value=color);return button;}));
  if(mode==='join'&&used.has(byId('room-color').value))byId('room-color').value=colors.find(c=>!used.has(c))??'#ffffff';
  byId('room-dialog').showModal();
}
function attachRoomControls() {
  const choices=[[RANDOM_BUILDING_THEME,{label:'每局随机'}],...Object.entries(BUILDING_THEMES)];
  byId('room-theme-choices').replaceChildren(...choices.map(([id,theme])=>{
    const button=document.createElement('button');button.type='button';button.className='theme-choice';button.dataset.theme=id;button.setAttribute('role','radio');button.setAttribute('aria-checked',String(id===byId('room-theme').value));
    if(id===RANDOM_BUILDING_THEME){const mark=document.createElement('b');mark.textContent='?';button.append(mark);}
    else{const image=document.createElement('img');image.src='assets/'+buildingThemeAsset(id,'yard','blue')+'.webp';image.alt='';button.append(image);}
    const name=document.createElement('span');name.textContent=theme.label;button.append(name);
    button.addEventListener('click',()=>{byId('room-theme').value=id;for(const sibling of button.parentElement.children)sibling.setAttribute('aria-checked',String(sibling===button));});return button;
  }));
  byId('start-session').addEventListener('click',()=>openRoomForm('create'));
  byId('join-session').addEventListener('click',()=>openRoomForm('join'));
  byId('leave-session').addEventListener('click',()=>controlMatch('leave'));
  byId('end-session').addEventListener('click',()=>controlMatch('end'));
  byId('room-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=byId('room-form-submit');if(button.disabled)return;button.disabled=true;
    const body={name:byId('room-name').value,color:byId('room-color').value,theme:byId('room-theme').value,capacity:Number(byId('room-capacity').value),bots:Number(byId('room-bots').value)};
    try{if(await controlMatch(byId('room-form').dataset.mode,body)){localStorage.setItem('cc-player-name',body.name);byId('room-dialog').close();}}
    finally{button.disabled=false;}
  });
  byId('room-form-close').addEventListener('click',()=>byId('room-dialog').close());
  byId('room-capacity').addEventListener('input',()=>{byId('room-bots').max=Number(byId('room-capacity').value)-1;if(Number(byId('room-bots').value)>Number(byId('room-bots').max))byId('room-bots').value=byId('room-bots').max;});
  let nextActivity=0;
  const activity=event=>{
    if(!event.isTrusted||observedMatch?.self?.role!=='player'||Date.now()<nextActivity)return;
    nextActivity=Date.now()+5000;void fetch('/api/session/activity',{method:'POST',headers:{'X-Match-Id':observedMatch.id}}).catch(()=>{});
  };
  for(const type of ['pointerdown','pointermove','keydown','wheel','touchstart'])document.addEventListener(type,activity,{passive:true});
}

function attachObserver(snapshot) {
  game.perspective = snapshot.team;
  if(!FACTIONS[snapshot.team])FACTIONS[snapshot.team]=createFaction(snapshot.team);
  viewFaction().explored.clear();
  viewFaction().sight.clear();
  const yard = snapshot.buildings.find(building => building.team === snapshot.team && building.type === 'yard');
  const mobile = snapshot.units.find(unit => unit.team === snapshot.team);
  centerCamera(yard?yardCenter(yard):mobile??{x:0,y:0});
  applyObservation(snapshot);
  attachRoomControls();
  document.addEventListener('visibilitychange',()=>{ if (!document.hidden) pollObservation(); });
  syncHud();
  pollObservation();
}

async function bootObserver() {
  try {
    globalThis.matchBootstrap = await fetchObservation();
  } catch {
    document.getElementById('match-clock').textContent = '正在连接服务器';
    setTimeout(bootObserver,1500);
    return;
  }
  const script = document.createElement('script');
  script.src = 'game.js?v=multiplayer-themes';
  document.head.append(script);
}
bootObserver();
