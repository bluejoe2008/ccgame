'use strict';

const ENGINE_ONLY=Boolean(globalThis.matchEngine);
const byId = id => ENGINE_ONLY?null:document.getElementById(id);
const map = byId('map');
const groundMap = byId('map-ground');
const radar = byId('radar');
const view = byId('viewport');
const buildingMenu = byId('building-menu');
const unitMenu = byId('unit-menu');
const matchResult = byId('match-result');
const ctx = map?.getContext('2d');
const groundCtx = groundMap?.getContext('2d',{alpha:false});
const radarCtx = radar?.getContext('2d');
const TILE_W = 84;
const TILE_H = 42;
const U = TILE_W / 2;
const V = TILE_H / 2;
const CARGO_LIMIT = 100;
const SCENT_RANGE=8.4;
const MOUNTED_SPEED=5.0;
const JET_ALTITUDE=102;
const AIRCRAFT_TYPES=new Set(['fighter','bomber','reconPlane','helicopter']);
const HELICOPTER_CAPACITY=4;
const ORE_GROW_DELAY = 12;
const ORE_GROW_RATE = 2.2;
const UNDERGROUND_ORE_FRACTION=.65;
const ORE_GRADES={
  poor:{label:'贫矿',minimum:70,variation:155,rate:34,color:'#b0a99a'},
  rich:{label:'富矿',minimum:230,variation:155,rate:46,color:'#f6d174'},
};
const BUILD_RADIUS = 10;
const MCV_HEALTH = 280;
const REPAIR_INTERVAL = .5;
const REPAIR_AMOUNT = 12;
const OIL_INCOME = 280;
const OIL_CAPTURE_BONUS=260;
const OIL_INTERVAL = 15;
const FACTORY_SPEED_BONUS=.20;
const MAX_FACTORY_SPEED_BONUS=.60;
const OPENING_SCOUT_WINDOW=100;
const BASE_DEFENSE_RADIUS=12;
const CRITICAL_RAID_TARGETS=new Set(['yard','mcv','factory','refinery','barracks','airport','solar','diesel']);
const EMERGENCY_DEFENSE_TYPES=new Set(['turret','laser']);
const MAX_UNIT_RANK=3;
const RANK_DAMAGE_BONUS=.15;
const REFINERY_PAD = {x:-.85,y:-1.40,width:3.92,height:3.70};
const OIL_FIELD = {label:'油田',width:2,height:2,roof:82,body:66,health:350,color:'#d4aa72',powerUse:12};
const MAP_SEED=globalThis.matchEngine?.seed??globalThis.matchBootstrap?.seed??
  crypto.getRandomValues(new Uint32Array(1))[0];
const BOARD={left:-51*U,right:51*U,top:-47*V,bottom:47*V};
const SURFACES = {
  field:[131,143,83,0,.69,0], meadow:[146,155,86,0,1,0], scrub:[94,111,66,0,.8,.08],
  dirt:[160,133,91,0,.22,.72], road:[149,120,87,0,.07,.40],
  concrete:[132,133,120,0,0,.40], bank:[185,162,107,.10,.08,.38],
  water:[39,54,76,1,0,0], rock:[133,103,72,0,.1,1], hill:[145,133,77,0,.57,.42],
  bridge:[76,81,86,0,0,.35],
};
const COLORS = {
  field: '#6f8549', meadow: '#879657', scrub: '#4f6842', dirt: '#9a7a50', road: '#92704c',
  concrete: '#7b8980', bank: '#b59b66', water: '#3c5675', rock: '#876449', hill:'#ab8d58',
  bridge: '#7b8791',
};

const deposits = new Map();
const oreReserves = new Map();
const recoveringOre = new Map();
const ground = new Map();
const hillHeights=new Map();
const reducedMotion = ENGINE_ONLY?{matches:false}:matchMedia('(prefers-reduced-motion: reduce)');
const bounds={minX:-49,minY:-49,maxX:49,maxY:49};
const mapTiles=[];
for (let x=bounds.minX;x<=bounds.maxX;x++) {
  for (let y=bounds.minY;y<=bounds.maxY;y++) {
    if (onMap(x,y)) mapTiles.push({x,y});
  }
}
const battlefield=generateBattlefield();
const [blueOrigin,redOrigin]=battlefield.origins;
const mcv = {
  x:blueOrigin.x, y:blueOrigin.y-1, id:2, team:'player', type:'mcv', label:'基地车', speed:2.55, vision:5.8,
  heading:.16, mode:'idle', route:[], goal:null, health:MCV_HEALTH,
};
const enemyMcv={...mcv,x:redOrigin.x,y:redOrigin.y-1,id:4,team:'enemy',route:[]};
const units=[mcv,enemyMcv];
const structures=battlefield.oils.map(tile=>({type:'oil',...tile,team:'neutral',
  width:OIL_FIELD.width,height:OIL_FIELD.height,health:OIL_FIELD.health,remaining:0,queue:[]}));
const FACTIONS=Object.fromEntries(['player','enemy'].map(team=>[team,{
  team,credits:1250,nextOrder:0,searched:new Map(),discoveries:new Set(),equipment:new Set(),
  strategy:(team==='player')===(MAP_SEED%2===0)?'conservative':'aggressive',expanding:false,nextExpansionPlan:0,
  research:null,manufacturing:null,unitMix:0,vehicleMix:0,
  reports:new Map(),defensive:false,recoveringAt:null,retreatBenchmark:0,threatPoint:null,
  explored:new Map(),sight:new Set(),scentTargets:new Set(),
  power:{supply:0,demand:0,rate:1},support:{fireRate:1,damage:1},factoryCount:0,factoryBonus:0,
  raids:new Map(),lastRescueReport:-10,openingScout:null,
  orders:{mode:'develop',task:'mobilize',target:null,source:'local'},commander:createCommander(team),
}]));
const factionName=team=>team==='enemy'?'红方':'蓝方';
const shots=[];
const wrecks=[];
const movementDust=[];
const WEAPONS={
  tank:{health:150,defense:.18,range:4.45,damage:32,reload:1.22,height:28},
  miner:{health:170,defense:.12,range:3.2,damage:9,reload:.60,height:49},
  soldier:{health:58,defense:.06,range:3.4,damage:10,reload:.66,height:23},
  dog:{health:64,defense:0,range:1.50,damage:21,reload:.72,height:14,pursuit:6.35},
  rocketeer:{health:64,defense:.03,range:4.8,damage:34,reload:1.9,height:31,effect:'rocket',armorFactor:1.4,softFactor:.45},
  mortar:{health:55,defense:.02,range:5.8,minimum:1.5,damage:24,reload:2.5,height:27,effect:'mortar',splash:1.15},
  pulseTank:{health:255,defense:.28,range:6.4,damage:62,reload:1.75,height:38,effect:'pulse',armorFactor:1.35},
  siegeTank:{health:210,defense:.24,range:7.4,minimum:1.5,damage:54,reload:2.6,height:42,effect:'mortar',splash:2.05},
  artillery:{health:135,defense:.10,range:8.5,minimum:2.5,damage:44,reload:2.65,height:37,effect:'artillery',splash:1.75},
  cavalry:{health:68,defense:.07,range:3.5,damage:12,reload:.73,height:25},
  mountedCavalry:{health:127,defense:.12,range:3.7,damage:17,reload:.80,height:42},
  fighter:{health:125,defense:.10,range:5.6,damage:41,reload:1.45,height:12,effect:'rocket',armorFactor:1.12},
  bomber:{health:160,defense:.16,range:2.35,damage:110,reload:1,height:8,effect:'bomb'},
};
const YARD={label:'建造场',time:3,width:3,height:2,roof:124,body:66,health:490,color:'#d9ac73',powerUse:18};
const BUILDINGS = {
  refinery:{label:'精炼厂',cost:500,time:4.8,width:3,height:3,roof:115,body:74,health:420,icon:'▥',powerUse:42,color:'#a6d3d0'},
  factory:{label:'兵工厂',cost:750,time:5.5,width:3,height:2,roof:86,body:56,health:370,icon:'▤',powerUse:60,color:'#b99b7a'},
  barracks:{label:'兵营',cost:400,time:4.2,width:2,height:2,roof:65,body:44,health:290,icon:'⌂',powerUse:30,color:'#a3ab89'},
  airport:{label:'机场',cost:1050,time:8,width:4,height:3,roof:100,body:46,health:420,defense:.12,powerUse:85,color:'#849196'},
  sentry:{label:'机枪哨塔',cost:300,time:4,width:1,height:1,roof:55,body:31,health:240,defense:.10,icon:'⊙',powerUse:15,color:'#acc0a9',
    weapon:{range:4.6,damage:12,reload:.36,height:38,armorFactor:.4},priority:'soft'},
  turret:{label:'反坦克炮塔',cost:550,time:6,width:2,height:2,roof:64,body:38,health:330,defense:.24,icon:'⊕',powerUse:28,color:'#a6b7b7',
    weapon:{range:5.7,damage:42,reload:1.65,height:43,effect:'tank',softFactor:.36},priority:'armor'},
  wall:{label:'城墙',cost:100,time:2.8,width:1,height:1,roof:32,body:24,health:290,defense:.38,color:'#b0b1a4'},
  bunker:{label:'装甲碉堡',cost:425,time:5.5,width:2,height:2,roof:52,body:36,health:445,defense:.32,powerUse:25,color:'#afc4b7',
    weapon:{range:4.2,damage:18,reload:.48,height:26,armorFactor:.55},priority:'soft'},
  laser:{label:'激光塔',cost:650,time:7.2,width:2,height:2,roof:100,body:65,health:320,defense:.16,powerUse:65,color:'#9bd9d1',
    weapon:{range:6.7,damage:30,reload:1.22,height:82,effect:'laser',armorFactor:1.22,softFactor:.68},priority:'armor'},
  solar:{label:'太阳能电站',cost:300,time:4.3,width:2,height:2,roof:48,body:32,health:230,powerOutput:90,color:'#89acc0'},
  diesel:{label:'燃油发电厂',cost:600,time:6,width:3,height:2,roof:83,body:53,health:370,powerOutput:180,color:'#a9b6b1'},
  recreation:{label:'棋牌室',cost:240,time:4,width:2,height:2,roof:53,body:35,health:240,
    powerUse:12,fireRateBonus:.08,color:'#aba489'},
  training:{label:'训练操场',cost:360,time:5,width:3,height:2,roof:33,body:18,health:260,
    powerUse:16,damageBonus:.12,color:'#b7b080'},
};
const PRODUCTS = {
  miner:{label:'采矿车',cost:250,time:4.1,speed:3.25,vision:5.4,building:'factory',icon:'◆'},
  tank:{label:'坦克',cost:350,time:3.2,speed:2.9,vision:5.3,building:'factory',icon:'▰'},
  soldier:{label:'步兵',cost:120,time:1.7,speed:2.5,vision:5.5,building:'barracks',icon:'◆'},
  dog:{label:'军犬',cost:150,time:2.8,speed:5.25,vision:5.6,building:'barracks',icon:'◇'},
  engineer:{label:'工程师',cost:180,time:3.1,speed:2.55,vision:5.1,health:48,building:'barracks',icon:'▥'},
  rocketeer:{label:'火箭筒兵',cost:220,time:3.4,speed:2.35,vision:5.5,building:'barracks',icon:'➶'},
  mortar:{label:'迫击炮兵',cost:280,time:4.6,speed:2.05,vision:6.1,building:'barracks',icon:'↗'},
  pulseTank:{label:'脉冲炮车',cost:780,time:8,speed:2.6,vision:6.5,building:'factory',tech:'pulse'},
  siegeTank:{label:'震波攻城车',cost:760,time:8.5,speed:2.4,vision:7,building:'factory',tech:'shock'},
  artillery:{label:'自行火炮',cost:590,time:6.2,speed:2.35,vision:7.2,building:'factory'},
  mcv:{label:'基地车',cost:2200,time:15,speed:2.55,vision:5.8,health:MCV_HEALTH,building:'factory'},
  horse:{label:'战马',cost:160,time:3.3,speed:4.6,vision:4.8,health:85,building:'barracks'},
  cavalry:{label:'骑兵',cost:240,time:3.9,speed:2.55,vision:5.5,building:'barracks'},
  fighter:{label:'战斗机',cost:850,time:8.2,speed:8.1,vision:8.5,building:'airport'},
  bomber:{label:'轰炸机',cost:1100,time:10.6,speed:6.8,vision:7.8,building:'airport'},
  reconPlane:{label:'侦察机',cost:520,time:5.2,speed:10.2,vision:12,health:80,building:'airport'},
  helicopter:{label:'运输直升机',cost:740,time:7,speed:6.2,vision:6.8,health:115,building:'airport'},
};
const TECHNOLOGIES={
  pulse:{label:'脉冲增幅',unit:'pulseTank',description:'解锁脉冲炮车，对装甲目标增强伤害'},
  shock:{label:'震波弹药',unit:'siegeTank',description:'解锁震波攻城车，远程溅射伤害'},
  catalyst:{label:'矿物催化',device:'催化精炼设备',income:'ore',bonus:.55,cost:360,time:6},
  pressure:{label:'井压回收',device:'油井增压设备',income:'oil',bonus:.85,cost:360,time:6},
};
const RESEARCH_PROGRAMS={
  weapons:{label:'攻击科技',cost:560,time:12,results:['pulse','shock']},
  industry:{label:'经济科技',cost:460,time:10,results:['catalyst','pressure']},
};
const UNIT_ART = {
  miner:{bracket:48,hitWidth:57,hitHeight:53},
  mcv:{bracket:54,hitWidth:59,hitHeight:68},
  tank:{bracket:42,hitWidth:50,hitHeight:41},
  soldier:{bracket:14,hitWidth:12,hitHeight:39,small:true},
  dog:{bracket:24,hitWidth:26,hitHeight:28,small:true},
  engineer:{bracket:15,hitWidth:13,hitHeight:39,small:true},
  rocketeer:{bracket:15,hitWidth:17,hitHeight:42,small:true},
  mortar:{bracket:15,hitWidth:16,hitHeight:40,small:true},
  pulseTank:{bracket:49,hitWidth:57,hitHeight:63},
  siegeTank:{bracket:49,hitWidth:57,hitHeight:65},
  artillery:{bracket:50,hitWidth:60,hitHeight:63},
  horse:{bracket:32,hitWidth:33,hitHeight:46,small:true},
  cavalry:{bracket:15,hitWidth:17,hitHeight:42,small:true},
  mountedCavalry:{bracket:33,hitWidth:36,hitHeight:58,small:true},
  fighter:{bracket:51,hitWidth:59,hitHeight:50},
  bomber:{bracket:57,hitWidth:65,hitHeight:56},
  reconPlane:{bracket:46,hitWidth:52,hitHeight:44},
  helicopter:{bracket:49,hitWidth:52,hitHeight:39},
};
const COMBAT_INFANTRY = new Set(['soldier','rocketeer','mortar','cavalry','mountedCavalry']);
const VEHICLE_CONTACT_RADIUS = {mcv:.58,miner:.54,tank:.49,pulseTank:.53,siegeTank:.53,artillery:.52};
const HEAVY_MOTION = {acceleration:4.5, braking:8, turnRate:4.5};
const TRACKED_MOTION = {acceleration:6.5, braking:10, turnRate:7};
const DOG_MOTION={acceleration:22,braking:25,turnRate:19};
const FOOT_MOTION = {acceleration:14, braking:17, turnRate:15};
const UNIT_RADIUS = {mcv:.46,miner:.43,tank:.42,soldier:.20,dog:.23,engineer:.20,rocketeer:.20,mortar:.20,pulseTank:.45,siegeTank:.45,artillery:.46,horse:.33,cavalry:.20,mountedCavalry:.36,fighter:.40,
  bomber:.50,reconPlane:.34,helicopter:.44};
const AIR_TARGETING=new Set(['fighter','soldier','rocketeer','cavalry','mountedCavalry','sentry','bunker','laser']);
const TEAM_PAINT = {
  player:{
    body:['#739cae','#344855','#4f6c7b'],
    trim:['#afc9d5','#466376','#648c9d'],
    light:'#c4e3ed', dark:'#354c57', radar:'#a4d8ee',
  },
  enemy:{
    body:['#ae5c48','#543638','#824c42'],
    trim:['#d49378','#75483e','#a76856'],
    light:'#f3b49a', dark:'#563633', radar:'#ff987e',
  },
};

let nextUnitId=5;

const camera={x:blueOrigin.x+1.8,y:blueOrigin.y+2.6};
const viewport = {w: 0, h: 0, dpr: 1, get scale() { return this.w<610 ? .49 : .70; }};
const radarViewport = {w: 0, h: 0, dpr: 1};
const game = {
  selection:[], selectedBuilding:null, hoverTarget:null, time:0,
  perspective:'player', outcome:null,
  get selected() { return this.selection.length===1 ? this.selection[0] : null; },
  follow:null, notice:'', noticeUntil:0, radarLayout:null, firstEngagement:false,
};
const pressed = new Set();
const touches = new Map();
let mouseDrag = null;
let selectionDrag = null;
let lastFrame = 0;
let nextRadar = 0;
let nextHud = 0;
const codexAvailable=Boolean(globalThis.matchEngine?.planner);

function playAt(cue,point,source=point) {
  if (ENGINE_ONLY) {
    matchEngine.sound(cue,point,source);
    return;
  }
  if (!viewport.w || !viewport.h) return;
  if (source.team!==game.perspective && !currentlyVisible(point.x,point.y)) return;
  const dx=point.x-camera.x,dy=point.y-camera.y;
  const distance=Math.hypot(dx,dy);
  const level=1/(1+(distance/5.5)**1.65);
  const pan=Math.tanh(project(dx,dy).x*viewport.scale/(viewport.w*.4))*.94;
  const cutoff=mix(1800,18000,level**.72);
  sound.play(cue,{pan,level,cutoff,source:source.id??tileKey(Math.round(source.x),Math.round(source.y))});
}

function hash(x, y, seed = 0) {
  let k = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed + 5, 987987443) ^ MAP_SEED;
  k = Math.imul(k ^ (k >>> 13), 1274126177);
  return ((k ^ (k >>> 16)) >>> 0) / 4294967296;
}

function noise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const t = x - ix;
  const u = y - iy;
  const a = t * t * (3 - 2 * t);
  const b = u * u * (3 - 2 * u);
  const top = hash(ix, iy, seed) * (1 - a) + hash(ix + 1, iy, seed) * a;
  const bottom = hash(ix, iy + 1, seed) * (1 - a) + hash(ix + 1, iy + 1, seed) * a;
  return top * (1 - b) + bottom * b;
}

function project(x, y, h = 0) {
  return {x: (x - y) * U, y: (x + y) * V - h};
}

function inverse(x, y) {
  return {x: (x / U + y / V) / 2, y: (y / V - x / U) / 2};
}

function worldAt(sx, sy) {
  const offset = inverse((sx - viewport.w / 2) / viewport.scale, (sy - viewport.h / 2) / viewport.scale);
  return {x: offset.x + camera.x, y: offset.y + camera.y};
}

function tileKey(x, y) {
  return x + ',' + y;
}

function sameTile(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y);
}

function terrain(x, y) {
  const key=tileKey(x,y);
  if (!ground.has(key)) ground.set(key,generateTerrain(x,y));
  return ground.get(key);
}

function nearestMapSite(target,allowed) {
  let best=null,nearest=Infinity;
  for (const tile of mapTiles) {
    const distance=distanceTo(tile,target);
    if (distance>=nearest || !allowed(tile)) continue;
    best=tile;
    nearest=distance;
  }
  return best;
}

function insideMap(point,margin) {
  const p=project(point.x,point.y);
  return p.x>=BOARD.left+margin*U && p.x<=BOARD.right-margin*U &&
    p.y>=BOARD.top+margin*V && p.y<=BOARD.bottom-margin*V;
}

function channelDistance(x,y,coast) {
  const across=(x-coast.x)*coast.dx+(y-coast.y)*coast.dy;
  const along=(x-coast.x)*-coast.dy+(y-coast.y)*coast.dx;
  return Math.abs(across-Math.sin(along*.16+coast.bend)*1.75);
}

function generateBattlefield() {
  const angle=hash(8,13,70)*Math.PI*2;
  const spreadX=36+hash(5,2,70)*4,spreadY=31+hash(7,4,70)*4;
  const location=inverse(Math.cos(angle)*U*spreadX,Math.sin(angle)*V*spreadY);
  const origins=[{x:Math.round(location.x),y:Math.round(location.y)},
    {x:Math.round(-location.x+hash(14,2,70)*3-1.5),y:Math.round(-location.y+hash(3,14,70)*3-1.5)}];
  const midpoint={x:(origins[0].x+origins[1].x)/2,y:(origins[0].y+origins[1].y)/2};
  const separation=distanceTo(origins[0],origins[1]);
  const dx=(origins[1].x-origins[0].x)/separation,dy=(origins[1].y-origins[0].y)/separation;
  const coast={...midpoint,dx,dy,bend:hash(4,5,78)*Math.PI*2};
  const seams=[];
  for (const [index,base] of origins.entries()) {
    const side=hash(index,5,71)*Math.PI*2;
    const wanted={x:base.x+Math.cos(side)*9,y:base.y+Math.sin(side)*9};
    const point=nearestMapSite(wanted,tile=>insideMap(tile,4) && origins.every(home=>distanceTo(home,tile)>=7.9) &&
      distanceTo(base,tile)<=10.3 && (Math.abs(tile.x-base.x)>6 || Math.abs(tile.y-base.y)>7));
    seams.push({...point,radius:2.55,grade:'poor'});
  }
  const central=nearestMapSite({x:midpoint.x+hash(4,9,71)*12-6,y:midpoint.y+hash(9,4,71)*10-5},
    tile=>insideMap(tile,5) && origins.every(base=>distanceTo(base,tile)>8) &&
      channelDistance(tile.x,tile.y,coast)>=6.1 &&
      seams.every(mine=>distanceTo(mine,tile)>6));
  seams.push({...central,radius:2.8,grade:'rich'});

  const oils=[];
  const oilTargets=[...origins.map(base=>({x:mix(base.x,midpoint.x,.45),y:mix(base.y,midpoint.y,.45)})),
    ...Array.from({length:3},(_,i)=>({x:midpoint.x+(hash(i,7,73)-.5)*22,
      y:midpoint.y+(hash(7,i,73)-.5)*22}))];
  for (const wanted of oilTargets) {
    const oil=nearestMapSite(wanted,tile=>insideMap(tile,4) &&
      origins.every(base=>distanceTo(base,tile)>8) && seams.every(mine=>distanceTo(mine,tile)>4.5) &&
      channelDistance(tile.x,tile.y,coast)>5.4 &&
      oils.every(other=>distanceTo(other,tile)>6));
    if (oil) oils.push(oil);
  }

  const roads=new Set();
  const addRoad=(a,b,bend,width=1.05)=>{
    const length=distanceTo(a,b);
    const steps=Math.ceil(length*5);
    for (let i=0;i<=steps;i++) {
      const t=i/steps;
      const curve=Math.sin(Math.PI*t)*bend;
      const x=mix(a.x,b.x,t)+(b.y-a.y)/length*curve;
      const y=mix(a.y,b.y,t)-(b.x-a.x)/length*curve;
      for (let xx=Math.round(x)-2;xx<=Math.round(x)+2;xx++) {
        for (let yy=Math.round(y)-2;yy<=Math.round(y)+2;yy++) {
          if (Math.hypot(xx-x,yy-y)<=width) roads.add(tileKey(xx,yy));
        }
      }
    }
  };
  addRoad(origins[0],origins[1],(hash(6,11,74)-.5)*9,1.4);
  const crossingSide=hash(1,7,78)>.5?1:-1;
  const crossing={x:midpoint.x-dy*10*crossingSide,y:midpoint.y+dx*10*crossingSide};
  const west={x:crossing.x-dx*9,y:crossing.y-dy*9};
  const east={x:crossing.x+dx*9,y:crossing.y+dy*9};
  addRoad(origins[0],west,0);
  addRoad(west,east,0,1.35);
  addRoad(east,origins[1],0);
  for (const [index,mine] of seams.slice(0,2).entries()) addRoad(origins[index],mine,0);
  for (const oil of oils) {
    const road=nearestMapSite(oil,tile=>roads.has(tileKey(tile.x,tile.y)) && !sameTile(oil,tile));
    if (road) addRoad(oil,road,0);
  }
  const roadPoints=mapTiles.filter(tile=>roads.has(tileKey(tile.x,tile.y)));
  const bridges=new Set(roadPoints.filter(tile=>channelDistance(tile.x,tile.y,coast)<4.4)
    .map(tile=>tileKey(tile.x,tile.y)));
  const hills=[];
  for (let i=0;i<9;i++) {
    const radius=3.8+hash(i,8,75)*1.3;
    const target=inverse(mix(BOARD.left,BOARD.right,hash(i,9,75)),
      mix(BOARD.top,BOARD.bottom,hash(9,i,75)));
    const center=nearestMapSite(target,tile=>insideMap(tile,Math.ceil(radius*1.5)) &&
      origins.every(base=>distanceTo(base,tile)>11.5) &&
      channelDistance(tile.x,tile.y,coast)>3.8+radius*.65 &&
      seams.every(mine=>distanceTo(mine,tile)>radius+mine.radius+1) &&
      oils.every(oil=>distanceTo(oil,tile)>radius+2) &&
      hills.every(hill=>distanceTo(hill,tile)>radius+hill.radius+1) &&
      roadPoints.every(road=>distanceTo(road,tile)>radius+.5));
    if (center) hills.push({...center,radius,height:30+hash(i,3,75)*13});
  }
  for (const hill of hills) {
    for (let x=Math.floor(hill.x-hill.radius);x<=Math.ceil(hill.x+hill.radius);x++) {
      for (let y=Math.floor(hill.y-hill.radius);y<=Math.ceil(hill.y+hill.radius);y++) {
        const slope=1-((x-hill.x)**2+(y-hill.y)**2)/hill.radius**2;
        if (slope>0) hillHeights.set(tileKey(x,y),hill.height*slope*slope);
      }
    }
  }
  return {origins,seams,oils,roads,hills,coast,bridges};
}

function generateTerrain(x,y) {
  if (battlefield.oils.some(site=>x>=site.x && x<site.x+OIL_FIELD.width &&
      y>=site.y && y<site.y+OIL_FIELD.height)) return 'concrete';
  const local=battlefield.origins.find(base=>Math.abs(x-base.x)<=6 && y-base.y>=-6 && y-base.y<=8);
  if (local) {
    const dx=x-local.x,dy=y-local.y;
    if (dx>=-3 && dx<=2 && dy>=3 && dy<=7) return 'concrete';
    if (battlefield.roads.has(tileKey(x,y))) return 'road';
    return 'field';
  }
  if (seam(x,y)) return 'dirt';
  const coast=channelDistance(x,y,battlefield.coast);
  if (battlefield.bridges.has(tileKey(x,y))) return 'bridge';
  if (coast<3.5) return 'water';
  if (battlefield.roads.has(tileKey(x,y))) return 'road';
  if ((hillHeights.get(tileKey(x,y))??0)>3) return 'hill';
  if (coast<5.9) return 'bank';
  const basin=noise(x/6.9,y/7.7,8);
  const edge=hash(x,y,4)*.033;
  const ridge=noise((x+7)/5.5,(y-14)/6.1,2);
  if (basin<.23+edge) return 'water';
  if (basin<.33+edge) return 'bank';
  if (ridge>.73 && hash(x,y,12)>.38) return 'rock';
  if (ridge<.36) return 'meadow';
  if (ridge>.61 || basin<.42) return 'scrub';
  return hash(x,y,1)>.94?'dirt':'field';
}

function heightAt(x,y) {
  const ix=Math.floor(x),iy=Math.floor(y);
  const fx=x-ix,fy=y-iy;
  const a=hillHeights.get(tileKey(ix,iy))??0,b=hillHeights.get(tileKey(ix+1,iy))??0;
  const c=hillHeights.get(tileKey(ix,iy+1))??0,d=hillHeights.get(tileKey(ix+1,iy+1))??0;
  return mix(mix(a,b,fx),mix(c,d,fx),fy);
}

function projectGround(x,y,height=0) {
  return project(x,y,height+heightAt(x,y));
}

function terrainAtProjection(sx,sy) {
  const flat=inverse(sx,sy);
  const height=heightAt(flat.x,flat.y);
  if (!height) return flat;
  let point=inverse(sx,sy+height);
  for (let i=0;i<2;i++) point=inverse(sx,sy+heightAt(point.x,point.y));
  return point;
}

function seam(x,y) {
  const uneven=hash(x,y,11)*.58;
  return battlefield.seams.find(mine=>Math.hypot(x-mine.x,y-mine.y)<mine.radius-uneven);
}

function oreCapacity(x,y) {
  const mine=seam(x,y);
  if (!mine) return 0;
  const kind=terrain(x,y);
  if (kind==='water' || kind==='concrete') return 0;
  const grade=ORE_GRADES[mine.grade];
  return Math.round(grade.minimum+hash(x,y,10)*grade.variation);
}

function amountAt(x,y) {
  const key=tileKey(x,y);
  if (!deposits.has(key)) {
    const capacity=oreCapacity(x,y);
    deposits.set(key,capacity);
    if (capacity) oreReserves.set(key,Math.round(capacity*UNDERGROUND_ORE_FRACTION));
  }
  return deposits.get(key);
}

function takeOre(cell,left) {
  const {x,y}=cell;
  const key=tileKey(x,y);
  deposits.set(key,left);
  if (!(oreReserves.get(key)>0)) return;
  let ore=recoveringOre.get(key);
  if (!ore) {
    ore={x,y,capacity:oreCapacity(x,y)};
    recoveringOre.set(key,ore);
  }
  ore.ready=game.time+ORE_GROW_DELAY;
}

function advanceOre(dt) {
  for (const [key,ore] of recoveringOre) {
    if (game.time<ore.ready || onStructure(ore.x,ore.y)) continue;
    const amount=deposits.get(key);
    const reserve=oreReserves.get(key);
    const growth=Math.min(ore.capacity-amount,dt*ORE_GROW_RATE,reserve);
    deposits.set(key,amount+growth);
    oreReserves.set(key,reserve-growth);
    if (amount+growth>=ore.capacity || growth>=reserve) recoveringOre.delete(key);
  }
}

function forestAt(x,y,kind=terrain(x,y)) {
  return kind==='scrub' && hash(x,y,18)>.58;
}

function onStructure(x,y) {
  return structures.some(b=>x>=b.x && x<b.x+b.width && y>=b.y && y<b.y+b.height);
}

function walkable(x,y) {
  if (!onMap(x,y)) return false;
  const floor=terrain(x,y);
  return !onStructure(x,y) && floor!=='water' && floor!=='rock' && !forestAt(x,y,floor);
}

function onMap(x,y) {
  const p=project(x,y);
  return p.x>=BOARD.left && p.x<=BOARD.right && p.y>=BOARD.top && p.y<=BOARD.bottom;
}

function tileUnder(x,y) {
  return tileKey(Math.round(x),Math.round(y));
}

function viewFaction() {
  return FACTIONS[game.perspective];
}

function visible(x,y) {
  return viewFaction().explored.has(tileUnder(x,y));
}

function currentlyVisible(x,y) {
  return viewFaction().sight.has(tileUnder(x,y));
}

function canSeeEntity(faction,entity) {
  if (entity.embarked) return false;
  if (entity.team===faction.team) return true;
  if (!entity.width) return faction.sight.has(tileUnder(entity.x,entity.y));
  for (let x=entity.x;x<entity.x+entity.width;x++) {
    for (let y=entity.y;y<entity.y+entity.height;y++) {
      if (faction.sight.has(tileKey(x,y))) return true;
    }
  }
  return false;
}

function knowsBuilding(faction,building) {
  return footprint(building).some(tile=>faction.explored.has(tileKey(tile.x,tile.y)));
}

function structureVisible(building) {
  return canSeeEntity(viewFaction(),building);
}

function reveal(faction,x,y,radius,initial=false) {
  for (let tx=Math.ceil(x-radius);tx<=Math.floor(x+radius);tx++) {
    for (let ty=Math.ceil(y-radius);ty<=Math.floor(y+radius);ty++) {
      if (!onMap(tx,ty) || Math.hypot(x-tx,y-ty)>radius) continue;
      const key=tileKey(tx,ty);
      faction.sight.add(key);
      if (!faction.explored.has(key)) faction.explored.set(key,{x:tx,y:ty,stamp:initial?-10:game.time});
    }
  }
}

function isPersonnel(unit) {
  return COMBAT_INFANTRY.has(unit.type) || unit.type==='engineer';
}

function sensePersonnel(faction,dogs) {
  faction.scentTargets.clear();
  if (!dogs.length) return;
  const opposition=units.filter(unit=>unit.team!==faction.team && unit.health>0 && isPersonnel(unit));
  for (const dog of dogs) {
    let nearest=SCENT_RANGE,signal=null;
    for (const contact of opposition) {
      const distance=distanceTo(dog,contact);
      if (distance>SCENT_RANGE) continue;
      const newlySensed=!faction.sight.has(tileUnder(contact.x,contact.y));
      if (newlySensed) {
        faction.scentTargets.add(contact);
        reveal(faction,contact.x,contact.y,1.18);
      }
      if (distance<nearest) {
        nearest=distance;
        signal=contact;
      }
    }
    if (signal && signal!==dog.scentTarget && game.time>=(dog.nextScentAlert??0)) {
      dog.nextScentAlert=game.time+5;
      log('军犬发现敌方人员。',faction.team);
      playAt('bark',dog);
    }
    dog.scentTarget=signal;
  }
}

function refreshVision(faction,members,buildings) {
  faction.sight.clear();
  for (const unit of members) reveal(faction,unit.x,unit.y,unit.vision);
  for (const building of buildings) {
    const center=yardCenter(building);
    const weapon=BUILDINGS[building.type]?.weapon;
    const radius=building.remaining?2.6:Math.max(5,(weapon?.range??0)+1);
    reveal(faction,center.x,center.y,radius);
  }
  sensePersonnel(faction,members.filter(unit=>unit.type==='dog'));
}

function log(message,team=null,loggedTime=game.time) {
  if (ENGINE_ONLY) {
    matchEngine.log(message,team,loggedTime);
    return;
  }
  const entry = document.createElement('li');
  if (team) entry.dataset.team=team;
  entry.hidden=Boolean(team && team!==game.perspective);
  const time = document.createElement('time');
  const seconds = Math.floor(loggedTime);
  time.textContent = String(Math.floor(seconds / 60)).padStart(2,'0') + ':' + String(seconds % 60).padStart(2,'0');
  const text = document.createElement('span');
  text.textContent = message;
  entry.append(time,text);
  const history = byId('log');
  history.prepend(entry);
  while (history.children.length > 64) history.lastElementChild.remove();
}

function notice(message,team=null) {
  if (team && team!==game.perspective) return;
  game.notice = message;
  game.noticeUntil = game.time + 3.5;
}

function polygon(context, points, fill, stroke, width = 1) {
  context.beginPath();
  context.moveTo(points[0].x,points[0].y);
  for (const point of points.slice(1)) context.lineTo(point.x,point.y);
  context.closePath();
  if (fill) {
    context.fillStyle=fill;
    context.fill();
  }
  if (stroke) {
    context.strokeStyle=stroke;
    context.lineWidth=width;
    context.stroke();
  }
}

function shape(context, points, color, outline, width) {
  polygon(context, points.map(([x,y]) => ({x,y})), color, outline, width);
}

function stroke(context, x1,y1,x2,y2,color,width=1) {
  context.beginPath();
  context.moveTo(x1,y1);
  context.lineTo(x2,y2);
  context.lineWidth=width;
  context.strokeStyle=color;
  context.stroke();
}

const CHUNK = 192;
const TEXTURE_STEP = 1.5;
const PREVIEW_STEP = 12;
const TERRAIN_BORDER = 2;
const TERRAIN_NEIGHBORS=[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
const groundArt = new Map();
const groundPreviews = new Map();
const featheredTerrain = new WeakMap();
const terrainLayer = ENGINE_ONLY?null:document.createElement('canvas');
const revealMask = ENGINE_ONLY?null:document.createElement('canvas');
const blurredMask = ENGINE_ONLY?null:document.createElement('canvas');
const terrainPainter = terrainLayer?.getContext('2d');
const maskPainter = revealMask?.getContext('2d');
const blurPainter = blurredMask?.getContext('2d');
const FOG_PADDING=64;
const FOG_RESOLUTION=.5;
const MAX_VIEWPORT_PIXELS=1500000;
let fogView=null,terrainView=null,terrainRevision=0;
let backgroundView=null,backgroundTime=-1;
let textureReady=false,terrainWorker=null,terrainJob=null,terrainWorkerFailed=false;

const sprites=new Map();
const asset=(name,filename=name)=>{
  const image=new Image();
  image.src='assets/'+filename+'.webp';
  sprites.set(name,image);
  return image;
};
const factionTint=team=>team==='enemy'?'red':'blue';
const unitSpriteWidths={
  mcv:[112,105,103,62], miner:[106,103,101,58], tank:[101,98,96,56],
  soldier:[32,24,27,20], engineer:[25,24,22,23], dog:[45,40,38,19],
  rocketeer:[34,29,29,23], mortar:[29,26,25,22],
  pulseTank:[116,111,110,66], siegeTank:[113,109,109,63],
  artillery:[108,105,103,62],
  horse:[54,49,47,24], cavalry:[31,26,24,23], mountedCavalry:[59,54,52,30],
  fighter:[109,110,108,91],
};
const TANK_HULL_POSES=[
  {rect:[22,190,282,154],mount:[172,229],width:89,ground:17},
  {rect:[336,148,268,217],mount:[478,225],width:83,ground:24},
  {rect:[644,162,294,196],mount:[793,222],width:87,ground:20},
  {rect:[998,142,185,215],mount:[1090,221],width:59,ground:30},
];
// Atlas crops and their turntable pivots, clockwise from east.
const TANK_TURRET_POSES=[
  {rect:[18,545,306,121],mount:[98,638],width:91},
  {rect:[348,505,274,208],mount:[434,615],width:80},
  {rect:[708,489,152,263],mount:[785,610],width:46},
  {rect:[946,506,277,207],mount:[1135,615],width:80},
  {rect:[8,954,301,121],mount:[230,1048],width:91},
  {rect:[337,901,262,193],mount:[510,1065],width:78},
  {rect:[712,841,145,265],mount:[784,1077],width:45},
  {rect:[959,900,268,193],mount:[1051,1064],width:78},
];
const buildingSpriteWidths={yard:205,refinery:232,factory:205,barracks:163,airport:270,
  oil:148,sentry:82,turret:157,bunker:155,wall:56,laser:132,solar:147,diesel:199,recreation:152,training:201};
const retroBuildings=new Set(['yard','barracks','refinery','factory','solar','diesel','airport','laser']);
let poorOreArt=null;
let groundTexture=null;
if (!ENGINE_ONLY) {
for (const tint of ['blue','red']) {
  asset('tank-reference-'+tint);
}
for (const type of Object.keys(unitSpriteWidths)) {
  for (let facing=0;facing<4;facing++) {
    for (const tint of ['blue','red']) asset(type+'-'+facing+'-'+tint);
  }
}
for (const type of Object.keys(buildingSpriteWidths)) {
  const variants=type==='wall'?['wall-x','wall-y']:[type];
  for (const variant of variants) {
    for (const tint of ['blue','red']) {
      const key=variant+'-'+tint;
      asset(key,retroBuildings.has(type)?'retro-'+key:key);
    }
  }
}
for (const name of ['forest','stone','coast-palm','coast-fan','coast-cliff','coast-stone']) asset(name);
const oreImage=asset('ore');
oreImage.addEventListener('load',()=>{
  const image=document.createElement('canvas');
  image.width=oreImage.naturalWidth;
  image.height=oreImage.naturalHeight;
  const painter=image.getContext('2d');
  painter.filter='grayscale(.8) brightness(.82)';
  painter.drawImage(oreImage,0,0);
  poorOreArt=image;
});

const groundImage=asset('ground');
groundImage.addEventListener('load',()=>{
  const source=document.createElement('canvas');
  source.width=groundImage.width;
  source.height=groundImage.height;
  const painter=source.getContext('2d');
  painter.drawImage(groundImage,0,0);
  const {data}=painter.getImageData(0,0,source.width,source.height);
  const cell=source.width/2;
  groundTexture=Array.from({length:4},(_,material)=>{
    const samples=new Float32Array(cell*cell);
    let total=0;
    for (let y=0;y<cell;y++) {
      for (let x=0;x<cell;x++) {
        const i=((y+Math.floor(material/2)*cell)*source.width+x+material%2*cell)*4;
        const light=data[i]*.213+data[i+1]*.715+data[i+2]*.072;
        samples[y*cell+x]=light;
        total+=light;
      }
    }
    const mean=total/samples.length;
    for (let i=0;i<samples.length;i++) samples[i]-=mean;
    return samples;
  });
  textureReady=true;
  terrainRevision++;
});
groundImage.addEventListener('error',()=>{
  textureReady=true;
  terrainRevision++;
});
}

function groundDetail(sx,sy,grass,wet,concrete) {
  if (!groundTexture) return 0;
  // Alternate reflected tiles so world-coordinate sampling meets without seams.
  const fold=value=>{
    const i=(Math.floor(value)%512+512)%512;
    return i<256?i:511-i;
  };
  const index=fold(sy*.88)*256+fold(sx*.88);
  const dry=mix(mix(groundTexture[1][index],groundTexture[0][index],grass),
    groundTexture[3][index],concrete);
  return mix(dry,groundTexture[2][index],wet);
}

function sprite(context,name,x,bottom,width,mirror=false) {
  const image=name==='poor-ore'?poorOreArt:sprites.get(name);
  const nativeWidth=image?.naturalWidth??image?.width;
  if (!nativeWidth) return false;
  const height=width*(image.naturalHeight??image.height)/nativeWidth;
  if (mirror) {
    context.save();
    context.translate(x,bottom);
    context.scale(-1,1);
    context.drawImage(image,-width/2,-height,width,height);
    context.restore();
  } else context.drawImage(image,x-width/2,bottom-height,width,height);
  return true;
}

function mix(a,b,t) { return a+(b-a)*t; }
function smooth(t) { return t*t*(3-2*t); }

function paintTerrainChunk(cx,cy,tile,step=TEXTURE_STEP) {
  tile.width=tile.height=CHUNK/step+2*TERRAIN_BORDER;
  const draw=tile.getContext('2d');
  const pixels=draw.createImageData(tile.width,tile.height);
  const detailed=step===TEXTURE_STEP;
  const radius=CHUNK/2+TERRAIN_BORDER*step;
  const hasRelief=battlefield.hills.some(hill=>{
    const p=project(hill.x,hill.y);
    return Math.abs(p.x-(cx+.5)*CHUNK)<=radius+(hill.radius+1)*Math.SQRT2*U &&
      Math.abs(p.y-(cy+.5)*CHUNK)<=radius+(hill.radius+1)*Math.SQRT2*V+hill.height;
  });
  const cache=new Map();
  const surface=(x,y) => {
    const key=tileKey(x,y);
    if (!cache.has(key)) cache.set(key,SURFACES[terrain(x,y)]);
    return cache.get(key);
  };
  for (let py=0;py<tile.height;py++) {
    for (let px=0;px<tile.width;px++) {
      const sx=cx*CHUNK+(px-TERRAIN_BORDER+.5)*step;
      const sy=cy*CHUNK+(py-TERRAIN_BORDER+.5)*step;
      const w=hasRelief?terrainAtProjection(sx,sy):inverse(sx,sy);
      const warp=noise(w.x*.57,w.y*.57,22)-.5;
      const warpY=noise(w.x*.62+7,w.y*.52,23)-.5;
      const u=w.x+warp*.43;
      const v=w.y+warpY*.43;
      const x=Math.floor(u), y=Math.floor(v);
      const fx=smooth(u-x), fy=smooth(v-y);
      const a=surface(x,y), b=surface(x+1,y), c=surface(x,y+1), d=surface(x+1,y+1);
      const blend=(index)=>mix(mix(a[index],b[index],fx),mix(c[index],d[index],fx),fy);
      const bridge=surface(Math.round(w.x),Math.round(w.y))===SURFACES.bridge;
      const wet=bridge?0:blend(3);
      const grass=blend(4);
      const rock=blend(5);
      const macro=noise(sx*.008,sy*.015,25)-.5;
      const slope=noise(sx*.008+.16,sy*.015+.12,25)-.5-macro;
      const granule=detailed?noise(sx*.095,sy*.14,29)-.5:0;
      const speck=detailed?hash(Math.floor(sx/TEXTURE_STEP),Math.floor(sy/TEXTURE_STEP),3):.5;
      const patches=noise(sx*.033,sy*.045,32)-.5;
      const fleck=detailed?noise(sx*.18+sy*.035,sy*.31,34):.5;
      const waterLines=Math.sin(sy*.29+noise(sx*.018,sy*.033,24)*5.8);
      const shore=Math.max(0,1-Math.abs(wet-.51)*8)*(5+fleck*7);
      const sediment=Math.max(0,1-Math.abs(wet-.22)*4)*(1+patches*6);
      const grain=(speck-.5)*(12+rock*13);
      const blades=(fleck>.68?10:fleck<.25?-9:0)*grass;
      const dry=macro*26-slope*30+granule*(15+rock*12)+patches*(11+grass*15)+grain+blades+
        (speck>.984?10+rock*12:speck<.013?-11:0);
      const reflection=Math.max(0,waterLines-.33)*(2+fleck*8);
      const moist=macro*17+waterLines*(1.9+granule*3)+patches*11+(speck-.5)*6+reflection;
      const concrete=mix(mix(Number(a===SURFACES.concrete),Number(b===SURFACES.concrete),fx),
        mix(Number(c===SURFACES.concrete),Number(d===SURFACES.concrete),fx),fy);
      const elevation=hasRelief?heightAt(w.x,w.y):0;
      const relief=elevation?2.4*(heightAt(w.x+.4,w.y+.25)-heightAt(w.x-.4,w.y-.25))+elevation*.16:0;
      const detail=detailed?groundDetail(sx,sy,grass,wet,concrete)*.76:0;
      const shade=mix(dry,moist,wet)*((groundTexture || !detailed) ? .66 : 1)+shore-sediment+relief+detail;
      const index=(py*tile.width+px)*4;
      const asphalt=bridge?SURFACES.bridge:null;
      pixels.data[index]=(asphalt?.[0]??blend(0))+shade+grass*(macro*12-patches*3);
      pixels.data[index+1]=(asphalt?.[1]??blend(1))+shade+grass*patches*5;
      pixels.data[index+2]=(asphalt?.[2]??blend(2))+shade*.86-wet*macro*6+reflection*wet;
      pixels.data[index+3]=255;
    }
  }
  draw.putImageData(pixels,0,0);
  return tile;
}

function saveTerrainChunk(key,art) {
  groundArt.set(key,art);
  if (groundArt.size>260) {
    const oldest=groundArt.keys().next().value;
    groundArt.get(oldest).close?.();
    groundArt.delete(oldest);
  }
  terrainRevision++;
  terrainJob=null;
}

function requestTerrainChunk(job) {
  if (!job || terrainJob || !textureReady) return;
  terrainJob=job;
  if (!terrainWorkerFailed && !terrainWorker && typeof Worker==='function' && typeof OffscreenCanvas==='function') {
    try {
      const worker=new Worker('terrain-worker.js?v=terrain-seams');
      terrainWorker=worker;
      worker.onmessage=({data})=>{
        if (terrainWorker===worker) saveTerrainChunk(data.key,data.art);
        else data.art.close();
      };
      worker.onerror=event=>{
        event.preventDefault();
        if (terrainWorker!==worker) return;
        worker.terminate();
        terrainWorker=null;
        terrainWorkerFailed=true;
        terrainJob=null;
        terrainRevision++;
      };
      worker.postMessage({seed:MAP_SEED,texture:groundTexture});
    } catch {
      terrainWorker?.terminate();
      terrainWorker=null;
      terrainWorkerFailed=true;
    }
  }
  if (terrainWorker && !terrainWorkerFailed) {
    terrainWorker.postMessage(job);
  } else {
    const paint=()=>saveTerrainChunk(job.key,paintTerrainChunk(job.x,job.y,document.createElement('canvas')));
    if (typeof requestIdleCallback==='function') requestIdleCallback(paint,{timeout:120});
    else setTimeout(paint,0);
  }
}

function terrainPreview(x,y,key) {
  if (groundPreviews.has(key)) return groundPreviews.get(key);
  const tile=paintTerrainChunk(x,y,document.createElement('canvas'),PREVIEW_STEP);
  groundPreviews.set(key,tile);
  if (groundPreviews.size>160) groundPreviews.delete(groundPreviews.keys().next().value);
  return tile;
}

function featherTerrain(art,edges) {
  const previous=featheredTerrain.get(art);
  if (previous?.edges===edges) return previous.tile;
  const tile=previous?.tile??document.createElement('canvas');
  tile.width=tile.height=art.width;
  const context=tile.getContext('2d');
  context.drawImage(art,0,0);
  context.globalCompositeOperation='destination-in';
  const width=16;
  const edge=direction=>direction>0?tile.width-TERRAIN_BORDER:TERRAIN_BORDER;
  for (const [i,[dx,dy]] of TERRAIN_NEIGHBORS.entries()) {
    if (!(edges&(1<<i))) continue;
    const x=edge(dx),y=edge(dy);
    const gradient=dx && dy ?
      context.createRadialGradient(x,y,TERRAIN_BORDER*1.5,x,y,width):
      context.createLinearGradient(x,y,x-dx*width,y-dy*width);
    gradient.addColorStop(0,'#fff0');
    gradient.addColorStop(1,'#fff');
    context.fillStyle=gradient;
    context.fillRect(0,0,tile.width,tile.height);
  }
  featheredTerrain.set(art,{edges,tile});
  return tile;
}

function drawTerrainChunk(art,x,y,step) {
  // Overlap texels sampled at the same map coordinates across subpixel edges.
  const padding=TERRAIN_BORDER*step;
  const width=CHUNK+2*padding;
  terrainPainter.drawImage(art,x*CHUNK-padding,y*CHUNK-padding,width,width);
}

function fogNoise(x,y,period,seed) {
  const ix=Math.floor(x), iy=Math.floor(y);
  const a=smooth(x-ix), b=smooth(y-iy);
  const nx=(ix+1)%period, ny=(iy+1)%period;
  return mix(mix(hash(ix,iy,seed),hash(nx,iy,seed),a),
    mix(hash(ix,ny,seed),hash(nx,ny,seed),a),b);
}

function fogTexture(seed,veil) {
  const tile=document.createElement('canvas');
  const n=256;
  tile.width=tile.height=n;
  const draw=tile.getContext('2d');
  const pixels=draw.createImageData(n,n);
  for (let y=0;y<n;y++) {
    for (let x=0;x<n;x++) {
      const u=x/n, v=y/n;
      const billow=fogNoise(u*4,v*4,4,seed);
      const curls=fogNoise(u*9,v*9,9,seed+1);
      const fine=fogNoise(u*22,v*22,22,seed+2);
      const density=billow*.67+curls*.25+fine*.08;
      const i=(y*n+x)*4;
      pixels.data[i]=veil?158:17+density*43;
      pixels.data[i+1]=veil?174:26+density*48;
      pixels.data[i+2]=veil?155:21+density*39;
      pixels.data[i+3]=veil?Math.max(0,density-.29)*77:255;
    }
  }
  draw.putImageData(pixels,0,0);
  return groundCtx.createPattern(tile,'repeat');
}

const deepFog=ENGINE_ONLY?null:fogTexture(41,false);
const mist=ENGINE_ONLY?null:fogTexture(51,true);

function drawAtmosphere(center,w,h) {
  const layers=[
    {pattern:deepFog,x:1.8,y:1.2,drift:3,parallax:.65},
    {pattern:mist,x:2.8,y:1.4,drift:7,parallax:.42},
  ];
  for (const layer of layers) {
    const x=(w/2-center.x*viewport.scale*layer.parallax+game.time*layer.drift)%(256*layer.x);
    const y=(h/2-center.y*viewport.scale*layer.parallax-game.time*layer.drift*.24)%(256*layer.y);
    groundCtx.save();
    groundCtx.translate(x,y);
    groundCtx.scale(layer.x,layer.y);
    groundCtx.fillStyle=layer.pattern;
    groundCtx.fillRect(-x/layer.x,-y/layer.y,w/layer.x,h/layer.y);
    groundCtx.restore();
  }
}

function updateFogView(center) {
  const {w,h,scale}=viewport;
  const {explored}=viewFaction();
  const usablePadding=FOG_PADDING-24;
  if (fogView?.explored===explored && fogView.w===w && fogView.h===h &&
      Math.abs(fogView.x-center.x)*scale<usablePadding &&
      Math.abs(fogView.y-center.y)*scale<usablePadding) return fogView;
  const width=Math.ceil((w+FOG_PADDING*2)*FOG_RESOLUTION);
  const height=Math.ceil((h+FOG_PADDING*2)*FOG_RESOLUTION);
  if (revealMask.width!==width || revealMask.height!==height) {
    revealMask.width=blurredMask.width=width;
    revealMask.height=blurredMask.height=height;
  }
  const density=scale*FOG_RESOLUTION;
  maskPainter.setTransform(1,0,0,1,0,0);
  maskPainter.clearRect(0,0,width,height);
  maskPainter.setTransform(density,0,0,density,width/2-center.x*density,height/2-center.y*density);
  maskPainter.save();
  maskPainter.beginPath();
  maskPainter.rect(BOARD.left,BOARD.top,BOARD.right-BOARD.left,BOARD.bottom-BOARD.top);
  maskPainter.clip();
  const chunks=drawFogMask(visibleRange(FOG_PADDING+24));
  maskPainter.restore();
  blurPainter.clearRect(0,0,width,height);
  blurPainter.filter='blur('+11*FOG_RESOLUTION+'px)';
  blurPainter.drawImage(revealMask,0,0);
  fogView={...center,w,h,explored,chunks};
  return fogView;
}

function renderTerrain(center) {
  const {w,h,scale}=viewport;
  const fog=updateFogView(center);
  if (terrainView?.fog===fog && terrainView.x===center.x && terrainView.y===center.y &&
      terrainView.revision===terrainRevision) return terrainView;
  // A terrain texel already covers about one CSS pixel. Keep this layer at that resolution.
  const width=Math.ceil(w),height=Math.ceil(h);
  if (terrainLayer.width!==width || terrainLayer.height!==height) {
    terrainLayer.width=width;
    terrainLayer.height=height;
  }
  terrainPainter.setTransform(1,0,0,1,0,0);
  terrainPainter.clearRect(0,0,width,height);
  terrainPainter.setTransform(scale,0,0,scale,w/2-center.x*scale,h/2-center.y*scale);
  const x0=Math.floor((center.x-w/(2*scale))/CHUNK);
  const x1=Math.floor((center.x+w/(2*scale))/CHUNK);
  const y0=Math.floor((center.y-h/(2*scale))/CHUNK);
  const y1=Math.floor((center.y+h/(2*scale))/CHUNK);
  const available=[];
  const pending=new Set();
  let next=null,nearest=Infinity;
  for (let x=x0;x<=x1;x++) {
    for (let y=y0;y<=y1;y++) {
      const key=tileKey(x,y);
      if (!fog.chunks.has(key)) continue;
      const art=groundArt.get(key);
      if (art) {
        groundArt.delete(key);
        groundArt.set(key,art);
        available.push({x,y,key,art});
        continue;
      }
      drawTerrainChunk(terrainPreview(x,y,key),x,y,PREVIEW_STEP);
      pending.add(key);
      const distance=(center.x/CHUNK-x-.5)**2+(center.y/CHUNK-y-.5)**2;
      if (distance<nearest) {
        next={key,x,y};
        nearest=distance;
      }
    }
  }
  const details=available.map(tile=>{
    const {x,y,key,art}=tile;
    let edges=0;
    if (pending.size) {
      for (const [i,[dx,dy]] of TERRAIN_NEIGHBORS.entries()) {
        if (pending.has(tileKey(x+dx,y+dy))) edges|=1<<i;
      }
    }
    if (!edges) return tile;
    drawTerrainChunk(terrainPreview(x,y,key),x,y,PREVIEW_STEP);
    return {...tile,art:featherTerrain(art,edges)};
  });
  for (const {art,x,y} of details) drawTerrainChunk(art,x,y,TEXTURE_STEP);
  requestTerrainChunk(next);
  terrainPainter.setTransform(1,0,0,1,0,0);
  terrainPainter.save();
  terrainPainter.globalCompositeOperation='destination-in';
  const maskWidth=blurredMask.width/FOG_RESOLUTION,maskHeight=blurredMask.height/FOG_RESOLUTION;
  terrainPainter.drawImage(blurredMask,(w-maskWidth)/2+(fog.x-center.x)*scale,
    (h-maskHeight)/2+(fog.y-center.y)*scale,maskWidth,maskHeight);
  terrainPainter.restore();
  terrainView={...center,fog,revision:terrainRevision};
  return terrainView;
}

function drawGround(center) {
  const terrain=renderTerrain(center);
  if (terrain===backgroundView && backgroundTime===game.time) return;
  const {w,h}=viewport;
  if (groundMap.width!==terrainLayer.width || groundMap.height!==terrainLayer.height) {
    groundMap.width=terrainLayer.width;
    groundMap.height=terrainLayer.height;
  }
  drawAtmosphere(center,w,h);
  groundCtx.drawImage(terrainLayer,0,0);
  backgroundView=terrain;
  backgroundTime=game.time;
}

function drawFogMask(range) {
  const faction=viewFaction();
  const explored=new Path2D();
  const chunks=new Set();
  const margin=24/viewport.scale;
  for (let x=range.x1;x<=range.x2;x++) {
    for (let y=range.y1;y<=range.y2;y++) {
      const key=tileKey(x,y);
      if (!faction.explored.has(key)) continue;
      const point=project(x,y);
      const rx=U*(1.08+hash(x,y,26)*.27),ry=V*(1.14+hash(x,y,27)*.30);
      const px=point.x+(noise(x*.42,y*.42,54)-.5)*12;
      const py=point.y+(noise(x*.42,y*.42,55)-.5)*9;
      explored.moveTo(px+rx,py);
      explored.ellipse(px,py,rx,ry,0,0,Math.PI*2);
      for (let cx=Math.floor((px-rx-margin)/CHUNK);cx<=Math.floor((px+rx+margin)/CHUNK);cx++) {
        for (let cy=Math.floor((py-ry-margin)/CHUNK);cy<=Math.floor((py+ry+margin)/CHUNK);cy++) {
          if ((cx+1)*CHUNK>BOARD.left && cx*CHUNK<BOARD.right &&
              (cy+1)*CHUNK>BOARD.top && cy*CHUNK<BOARD.bottom) chunks.add(tileKey(cx,cy));
        }
      }
    }
  }
  maskPainter.fillStyle='#fff';
  maskPainter.fill(explored);
  return chunks;
}

const shadowImage=ENGINE_ONLY?null:document.createElement('canvas');
if (shadowImage) {
  shadowImage.width=shadowImage.height=96;
  const painter=shadowImage.getContext('2d');
  const soft=painter.createRadialGradient(48,48,7,48,48,48);
  soft.addColorStop(0,'#171a15');
  soft.addColorStop(.48,'#171a15d6');
  soft.addColorStop(1,'#171a1500');
  painter.fillStyle=soft;
  painter.fillRect(0,0,96,96);
}

function shadow(context,x,y,w,h,opacity=.32) {
  const alpha=context.globalAlpha;
  context.globalAlpha=alpha*opacity;
  context.drawImage(shadowImage,x-w,y-h,2*w,2*h);
  context.globalAlpha=alpha;
}

function castShadow(context,p,length,width,opacity) {
  context.save();
  context.translate(p.x+length*.41,p.y+length*.12);
  context.rotate(.29);
  shadow(context,0,0,length*.62,width,opacity);
  context.restore();
}

function pine(context,p,size,variant) {
  context.save();
  context.translate(p.x,p.y);
  context.scale(size,size);
  castShadow(context,{x:0,y:-1},32,8,.38);
  shadow(context,0,2,14,6,.54);
  context.fillStyle='#4b4334';
  context.fillRect(-1.7,-11,3.4,11);
  const coats=variant ? ['#293e33','#4c5e44','#758367'] : ['#273d33','#435646','#6b7c60'];
  for (let i=0;i<4;i++) {
    const level=-10-i*10;
    const span=16-i*2.85;
    shape(context,[[0,level-19],[span*.54,level-9],[span*.42,level-7],[span*.83,level-3],
      [span*.72,level-1],[span,level+3],[span*.41,level+5],[1,level+6],[-span,level+3],
      [-span*.69,level],[-span*.77,level-2],[-span*.35,level-8]],coats[0],'#26372e',.65);
    shape(context,[[0,level-19],[2,level+1],[-span*.47,level+5],[-span,level+3],
      [-span*.62,level-1],[-span*.76,level-2],[-span*.37,level-8]],coats[1]);
    for (let j=0;j<3;j++) {
      const branch=span*(.43+j*.19);
      stroke(context,-branch,level+2-j*2,-branch*.28,level-5-j*2,coats[2],.72);
    }
  }
  context.restore();
}

function stone(context,p,size,light=false) {
  context.save();
  context.translate(p.x,p.y);
  context.scale(size,size);
  castShadow(context,{x:0,y:1},25,7,.43);
  shadow(context,2,3,15,6,.44);
  const spread=(seed,amount)=>(hash(Math.round(p.x),Math.round(p.y),seed)-.5)*amount;
  const left=[-15+spread(5,6),-3+spread(6,5)];
  const shoulder=[-8+spread(7,9),-12+spread(8,6)];
  const crown=[5+spread(9,10),-17+spread(10,9)];
  const right=[14+spread(11,6),-9+spread(12,6)];
  const ridge=[spread(13,7),-5+spread(14,6)];
  const front=[5+spread(15,9),6+spread(16,4)];
  shape(context,[left,shoulder,crown,right,[18+spread(17,6),-1],front,[-8,7]],
    light?'#817f71':'#6e7063','#4b4c42',.72);
  shape(context,[left,shoulder,crown,right,ridge],light?'#aca697':'#929083');
  shape(context,[ridge,right,[18+spread(17,6),-1],front,[-2,3]],'#53584d');
  stroke(context,shoulder[0],shoulder[1]+1,crown[0]-1,crown[1]+1,'#d4cbb592',.88);
  stroke(context,left[0]+2,left[1]-2,ridge[0]-1,ridge[1]-1,'#52584b91',.72);
  stroke(context,ridge[0]-1,ridge[1]-1,crown[0]-2,crown[1]+4,'#52584b91',.76);
  context.restore();
}

function tufts(context,p,seed) {
  context.save();
  context.translate(p.x,p.y);
  for (let i=0;i<5;i++) {
    const xx=hash(seed,i,2)*12-6;
    const yy=hash(i,seed,6)*6-2;
    const len=3 + hash(i,seed,8)*5;
    stroke(context,xx,yy,xx+hash(seed,i,11)*4-2,yy-len,i%2 ? '#777c49' : '#4b5737',1.05);
  }
  context.restore();
}

function crystal(context,x,y,quantity) {
  const p=project(x,y);
  const variant=Math.round(hash(x,y,7)*276);
  context.save();
  context.translate(p.x,p.y);
  const growth=Math.min(1,.30+Math.sqrt(quantity/150)*.70);
  context.scale(growth,growth);
  shadow(context,1,0,23,10,.31);
  const count=quantity>105 ? 8 : quantity>44 ? 6 : quantity>12 ? 3 : 2;
  for (let i=0;i<count;i++) {
    const xx=(hash(variant,i,7)-.5)*42;
    const yy=(hash(i,variant,8)-.5)*13;
    const size=5+hash(variant,i,5)*7, tall=5+hash(i,variant,4)*11;
    const tilt=(hash(i,variant,19)-.5)*size;
    const left=[xx-size,yy+1], shoulder=[xx-size*.68,yy-tall*.53];
    const top=[xx+tilt-size*.21,yy-tall], crest=[xx+tilt+size*.27,yy-tall*.91];
    const edge=[xx+size*.72,yy-tall*.52], foot=[xx+size,yy], face=[xx+size*.14,yy+3];
    shape(context,[left,shoulder,top,crest,edge,foot,face,[xx-size*.43,yy+4]],'#9a7438','#665331',.76);
    shape(context,[left,shoulder,top,[xx+tilt,yy-tall*.67],face],i%3?'#c5a056':'#d4b371');
    shape(context,[top,crest,edge,[xx+tilt,yy-tall*.67]],'#e4c687');
    shape(context,[[xx+tilt,yy-tall*.67],edge,foot,face],'#92713d');
    stroke(context,shoulder[0]+1,shoulder[1],top[0],top[1]+.9,'#ccb477',.8);
    if (i%2===0) stroke(context,xx-2,yy-4,xx+1,yy-3,'#f1d69ca1',.85);
  }
  context.restore();
}

const materialColors=new Map();
function paintFace(context,points,color,edge,width=.8) {
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for (const {x,y} of points) {
    minX=Math.min(minX,x); maxX=Math.max(maxX,x);
    minY=Math.min(minY,y); maxY=Math.max(maxY,y);
  }
  if (maxX-minX<24 || maxY-minY<10) return polygon(context,points,color,edge,width);
  let tones=materialColors.get(color);
  if (!tones) {
    const number=parseInt(color.slice(1),16);
    const rgb=[number>>16&255,number>>8&255,number&255];
    const shade=(toward,amount)=>'rgb('+rgb.map((value,index)=>
      Math.round(mix(value,toward[index],amount))).join(',')+')';
    tones=[shade([246,230,196],.16),shade([26,37,40],.20)];
    materialColors.set(color,tones);
  }
  const light=context.createLinearGradient(minX,minY,maxX,maxY);
  light.addColorStop(0,tones[0]);
  light.addColorStop(.47,color);
  light.addColorStop(1,tones[1]);
  polygon(context,points,light,edge,width);
}

function cuboid(context, point, x,y,w,d,bottom,top,colors,edge='#26332b') {
  const lt=point(x,y,top), rt=point(x+w,y,top), rb=point(x+w,y+d,top), lb=point(x,y+d,top);
  const lowerR=point(x+w,y,bottom), lowerB=point(x+w,y+d,bottom), lowerL=point(x,y+d,bottom);
  paintFace(context,[rt,rb,lowerB,lowerR],colors[2],edge);
  paintFace(context,[lb,rb,lowerB,lowerL],colors[1],edge);
  paintFace(context,[lt,rt,rb,lb],colors[0],edge);
  return {lt,rt,rb,lb};
}

function worldLine(context,x1,y1,x2,y2,z,color,width=1) {
  const a=project(x1,y1,z), b=project(x2,y2,z);
  stroke(context,a.x,a.y,b.x,b.y,color,width);
}

function refinery(context,time,paint) {
  const p=project(-1,5.7);
  shadow(context,p.x+20,p.y+16,137,38,.40);
  cuboid(context,project,REFINERY_PAD.x-2,REFINERY_PAD.y+5,REFINERY_PAD.width,REFINERY_PAD.height,
    0,3.5,['#888b75','#535f53','#687263'],'#5f6654');
  cuboid(context,project,-2.62,4.75,3.47,2.04,4,15,['#535a4f','#465246','#3a4840']);
  cuboid(context,project,-2.47,4.88,3.15,1.76,13,63,['#ae5f47','#7a826f','#556b60']);
  cuboid(context,project,-2.55,4.80,3.30,1.90,61,68,paint.body,'#4c513f');
  for (let i=0;i<8;i++) {
    const x=-2.39+i*.37;
    worldLine(context,x,4.87,x,6.63,68,paint.dark,1.1);
    worldLine(context,x+.04,4.89,x+.04,6.63,68,paint.light,.65);
  }
  cuboid(context,project,-2.27,5.17,1.51,1.15,68,78,['#806150','#5d6050','#525446']);
  for (let i=0;i<3;i++) {
    worldLine(context,-2.18+i*.46,5.24,-2.18+i*.46,6.18,78,'#3d4a40',2.8);
    worldLine(context,-2.13+i*.46,5.24,-2.13+i*.46,6.18,78,'#aa9d78',1);
  }
  // Office frontage and a lit cargo gate on the dock side.
  const wall = (a,b,bottom,top,color,edge) => polygon(context,
    [project(a,6.65,top),project(b,6.65,top),project(b,6.65,bottom),project(a,6.65,bottom)],color,edge);
  wall(-2.36,-1.37,37,51,'#344f4a','#607d6a');
  for (let i=0;i<3;i++) wall(-2.33+i*.32,-2.08+i*.32,40,49,i%2 ? '#a2b5a4' : '#aec5ab');
  wall(-1.13,.44,6,35,'#293b35','#89927a');
  wall(-.99,.29,7,29,'#172a25','#434f43');
  for (let i=0;i<4;i++) {
    const p=project(-.96+i*.31,6.66,14+i%2*3);
    context.fillStyle=i===2?'#d6b269':'#7c8c6d';
    context.fillRect(p.x,p.y,6,4);
  }
  worldLine(context,-1.25,6.67,.51,6.67,35,'#edbc61',3);
  cuboid(context,project,-1.0,6.67,1.35,.33,2,7,['#93947e','#647260','#5f675a']);
  for (let i=0;i<6;i++) worldLine(context,-.94+i*.22,6.75,-.87+i*.22,6.99,7,i%2 ? '#d1a253' : '#414737',2);
  const tank=project(.57,5.68,0);
  context.save();
  context.translate(tank.x,tank.y);
  shadow(context,3,5,23,14,.45);
  shape(context,[[-16,-41],[17,-41],[17,-5],[11,1],[-12,3],[-16,-6]],'#65796b','#374a3c');
  context.fillStyle='#92a694'; context.fillRect(-12,-40,5,38);
  context.fillStyle='#4f6259'; context.fillRect(8,-40,8,39);
  for (const dy of [-29,-9]) {
    context.beginPath();
    context.ellipse(0,dy,16,6,0,0,Math.PI);
    context.strokeStyle='#c1b796';
    context.lineWidth=1;
    context.stroke();
  }
  context.beginPath(); context.ellipse(0,-41,17,8.5,0,0,Math.PI*2);
  context.fillStyle='#a5ad91'; context.fill();
  context.strokeStyle='#627365'; context.stroke();
  context.fillStyle='#5a685b'; context.fillRect(-3,-49,6,8);
  context.restore();

  cuboid(context,project,-2.43,4.86,.31,.32,77,108,['#877e69','#4f5e50','#435447']);
  cuboid(context,project,-2.48,4.82,.40,.41,106,112,['#818778','#555f54','#48594f']);
  const smoke=project(-2.28,5.01,111);
  for (let i=0;i<5;i++) {
    const phase=(time*.22+i*.21)%1;
    context.beginPath();
    context.ellipse(smoke.x-phase*14,smoke.y-phase*36,3+phase*8,2+phase*4,0,0,Math.PI*2);
    context.fillStyle='rgba(180,188,169,'+(1-phase)*.17+')';
    context.fill();
  }
  // Dock stripes are visible even when the hull obscures part of the pad.
  for (let i=0;i<5;i++) {
    const x=-1.7+i*.23;
    worldLine(context,x,3.50,x+.10,3.82,3.7,i%2 ? '#d6ae51' : '#484d3a',3);
  }
}

function vehiclePainter(context, origin, direction) {
  const angle=Math.round(direction/(Math.PI/8))*Math.PI/8;
  const cs=Math.cos(angle), sn=Math.sin(angle);
  const mapPoint=(x,y,z=0)=>{
    const spot=project(x*cs-y*sn,x*sn+y*cs,z);
    return {x:origin.x+spot.x,y:origin.y+spot.y};
  };
  const visible=(nx,ny)=>nx*(cs+sn)+ny*(cs-sn)>0;
  const panel=(vertices,color,edge='#272a22',width=.8,material=false)=>{
    const points=vertices.map(v=>mapPoint(...v));
    if (material) paintFace(context,points,color,edge,width);
    else polygon(context,points,color,edge,width);
  };
  const line=(a,b,color,width=1)=>{
    const aa=mapPoint(...a), bb=mapPoint(...b);
    stroke(context,aa.x,aa.y,bb.x,bb.y,color,width);
  };
  const extrude=(outline,low,high,colors,roof=outline)=>{
    for (let i=0;i<outline.length;i++) {
      const a=outline[i], b=outline[(i+1)%outline.length];
      const nx=b[1]-a[1], ny=a[0]-b[0];
      if (!visible(nx,ny)) continue;
      const light=nx*(cs-sn)-ny*(cs+sn);
      panel([[...roof[i],high],[...roof[(i+1)%roof.length],high],[...b,low],[...a,low]],
        light>.02?colors[2]:colors[1],'#22292b',.68,true);
    }
    panel(roof.map(v=>[...v,high]),colors[0],'#292f30',.68,true);
  };
  const bar=(x,y,w,d,low,high,colors)=>extrude([[x,y],[x+w,y],[x+w,y+d],[x,y+d]],low,high,colors);
  return {mapPoint,visible,panel,line,extrude,bar};
}

function track(painter, x,y,w,d,height) {
  const {extrude,visible,panel,line}=painter;
  const notch=.105;
  const outline=[[x+notch,y],[x+w-notch,y],[x+w,y+.09],[x+w,y+d-.09],
                 [x+w-notch,y+d],[x+notch,y+d],[x,y+d-.09],[x,y+.09]];
  extrude(outline,1,height,['#454746','#1e2224','#292d2e']);
  for (let xx=x+.12;xx<x+w-.09;xx+=.12) {
    line([xx,y+.04,height+.1],[xx-.035,y+d-.04,height+.1],'#73736a',.85);
  }
  for (const side of [-1,1]) {
    if (!visible(0,side)) continue;
    const plane=side<0?y-.008:y+d+.008;
    line([x+.07,plane,3],[x+w-.07,plane,3],'#505454',1);
    line([x+.04,plane,height-2],[x+w-.04,plane,height-2],'#747775',1);
    for (let i=0;i<6;i++) {
      const xx=x+w*(.12+i*.15),size=.079,z=6.1;
      panel([[xx-size,plane,z],[xx-size*.55,plane,z+3.5],[xx+size*.43,plane,z+3.6],
            [xx+size,plane,z+.1],[xx+size*.45,plane,z-3.1],[xx-size*.43,plane,z-3.2]],'#595c59','#1c2425');
      panel([[xx-.037,plane,z],[xx,plane,z+1.5],[xx+.038,plane,z],[xx,plane,z-1.4]],'#92938a',null);
    }
  }
  for (const side of [-1,1]) {
    if (!visible(side,0)) continue;
    const face=side<0?x-.005:x+w+.005;
    for (const h of [4,7,10]) line([face,y+.07,h],[face,y+d-.07,h],'#696554',1.25);
  }
}

const GUNMETAL = ['#959b96','#3b4244','#606a6c'];
const INDUSTRIAL_STEEL = ['#a6a9a0','#535a59','#747d7b'];

function drawTruck(context,origin,heading,paint,cargo=0,aim=heading) {
  const painter=vehiclePainter(context,origin,heading);
  const {bar,mapPoint,visible,panel,line,extrude}=painter;
  shadow(context,origin.x+8,origin.y+6,54,17,.46);
  const frontVisible=visible(1,0);
  const drawScoop=()=>{
    extrude([[.70,-.56],[.98,-.63],[1.05,-.50],[1.05,.50],[.98,.63],[.70,.56]],4,15,
      INDUSTRIAL_STEEL,[[.69,-.52],[.82,-.59],[.91,-.49],[.91,.49],[.82,.59],[.69,.52]]);
    if (!frontVisible) return;
    line([1.053,-.49,4],[1.053,.49,4],'#d0c8ae',1.6);
    for (let i=0;i<7;i++) {
      const y=-.43+i*.132;
      line([.933,y,13],[1.028,y+.042,6],i%2?'#232a28':'#cc9d51',1.7);
    }
  };
  if (!frontVisible) drawScoop();
  for (const y of [-.65,.37]) track(painter,-.88,y,1.62,.28,15);
  extrude([[-.89,-.58],[.68,-.58],[.82,-.39],[.82,.39],[.68,.58],[-.89,.58]],
    12,23,paint.body,[[-.84,-.47],[.56,-.47],[.74,-.31],[.74,.31],[.56,.47],[-.84,.47]]);

  // The armor flares outward around the recessed ore bin.
  extrude([[-.79,-.34],[.09,-.34],[.09,.34],[-.79,.34]],22,34,INDUSTRIAL_STEEL,
    [[-.93,-.46],[.13,-.46],[.13,.46],[-.93,.46]]);
  panel([[-.88,-.40,34],[.07,-.40,34],[.07,.40,34],[-.88,.40,34]],'#272a26','#9c9e87',1);
  panel([[-.72,-.30,34],[-.01,-.30,34],[-.01,.30,34],[-.72,.30,34]],'#464136',null);
  for (const side of [-1,1]) {
    const y=side*.464;
    line([-.91,y,34],[.12,y,34],paint.light,1.4);
    if (!visible(0,side)) continue;
    for (let i=0;i<4;i++) {
      const x=-.79+i*.245;
      panel([[x,y,34],[x+.10,y,34],[x+.055,side*.37,24],[x-.015,side*.37,24]],
        paint.trim[2],'#4b514a');
    }
  }
  if (cargo>1) {
    for (let i=0;i<Math.ceil(cargo/12);i++) {
      const xy=mapPoint(-.74+(i%4)*.197,-.24+Math.floor(i/4)*.217,35);
      shape(context,[[xy.x-5,xy.y+1],[xy.x-2,xy.y-5],[xy.x+2,xy.y-6],
        [xy.x+6,xy.y-1],[xy.x+2,xy.y+3]],i%2?'#c99149':'#e8bf69','#725132',.6);
      stroke(context,xy.x-3,xy.y,xy.x+1,xy.y-4,'#f9d991',.75);
    }
  }

  extrude([[.12,-.46],[.68,-.45],[.79,-.27],[.79,.27],[.68,.45],[.12,.46]],22,42,paint.body,
    [[.18,-.37],[.60,-.36],[.67,-.25],[.67,.25],[.60,.36],[.18,.37]]);
  for (const side of [-1,1]) {
    if (!visible(0,side)) continue;
    panel([[.27,side*.375,40],[.57,side*.372,40],[.66,side*.414,31],[.27,side*.413,31]],
      '#20343d','#9aaca9',1,true);
    line([.29,side*.378,39],[.54,side*.376,39],'#a8c4c7',1);
  }
  if (frontVisible) {
    panel([[.684,-.235,41],[.684,.235,41],[.752,.245,29],[.752,-.245,29]],'#243941','#869997',1,true);
    line([.692,0,40],[.754,0,29],'#a2a498',1.2);
  }

  if (frontVisible) drawScoop();
  for (const y of [-.48,.48]) bar(.73,y-.045,.09,.09,20,23,['#f4d59b','#87613d','#bd9557']);
  bar(.29,-.14,.28,.28,41,46,GUNMETAL);
  const turret=vehiclePainter(context,mapPoint(.43,0),aim);
  turret.bar(-.13,-.13,.30,.26,45,51,paint.trim);
  turret.bar(.11,-.045,.35,.09,47,50,GUNMETAL);
}

function drawTank(context,origin,heading,paint,enemyTank) {
  const p=vehiclePainter(context,origin,heading);
  const {bar,extrude,line,panel,visible}=p;
  shadow(context,origin.x+6,origin.y+6,43,15,.46);
  const halfWidth=enemyTank ? .57 : .50;
  for (const y of [-halfWidth,halfWidth-.26]) {
    track(p,-.75,y,1.54,.26,13);
    bar(-.67,y,1.31,.26,12,18,paint.body);
  }
  extrude([[-.75,-.35],[.56,-.43],[.83,-.31],[.83,.31],[.56,.43],[-.75,.35]],10,22,paint.body,
    [[-.63,-.32],[.35,-.36],[.56,-.24],[.56,.24],[.35,.36],[-.63,.32]]);
  const turret=enemyTank?
    [[-.49,-.31],[.03,-.33],[.43,-.22],[.43,.22],[.03,.33],[-.49,.31]]:
    [[-.46,-.20],[.04,-.31],[.43,-.19],[.43,.19],[.04,.31],[-.46,.20]];
  const roof=turret.map(([x,y])=>[x*.78,y*.75]);
  const turretTop=enemyTank?36:33;
  extrude(turret,21,turretTop,paint.trim,roof);
  bar(.30,-.105,.23,.21,24,32,paint.body);
  bar(.48,-.045,.61,.09,27,31,GUNMETAL);
  bar(.91,-.068,.15,.136,26,32,GUNMETAL);
  if (visible(1,0)) {
    panel([[1.091,-.032,28],[1.091,.032,28],[1.091,.032,30],[1.091,-.032,30]],'#262b2c',null);
    line([.70,-.25,17],[.70,.25,17],paint.light,1.6);
  }
  bar(-.26,-.13,.19,.17,turretTop,turretTop+2,GUNMETAL);
  bar(-.12,.07,.19,.13,turretTop,turretTop+2,paint.body);
  for (let i=0;i<4;i++) {
    line([-.61,-.22+i*.124,22.2],[-.51,-.22+i*.124,22.2],'#293537',1.65);
  }
  line([-.23,.19,turretTop],[-.29,.21,turretTop+10],'#232c2d',1.2);
  for (const side of [-1,1]) {
    if (!visible(0,side)) continue;
    const y=side*(halfWidth+.003);
    line([-.47,y,16],[.39,y,16],paint.light,2.2);
    for (const x of [-.42,-.13,.16,.45]) line([x,y,13],[x,y,18],'#354143',.8);
  }
}

function drawSoldier(context,origin,heading,paint,phase,engineer=false,idlePhase=null) {
  const look=project(Math.cos(heading),Math.sin(heading));
  const facing=look.x<0?-1:1;
  const back=look.y<0;
  const step=Math.sin(phase)*4;
  const cloth=engineer?'#a29c82':paint.body[2];
  const darkCloth=engineer?'#5c6359':paint.body[1];
  context.save();
  context.translate(origin.x,origin.y);
  shadow(context,3,2,12,5,.4);
  context.scale(facing,1);
  for (const [x,stride,color] of [[-4,-step,darkCloth],[3,step,cloth]]) {
    shape(context,[[x-3,-15],[x+3,-15],[x+3+stride*.6,-7],
      [x+2+stride,-2],[x-3+stride,-2],[x-2+stride*.4,-7]],color,'#333938',.8);
    shape(context,[[x-3+stride,-4],[x+2+stride,-4],[x+5+stride,0],[x-3+stride,1]],'#272f2e');
  }
  if (idlePhase!==null) context.translate(Math.sin(idlePhase*.61)*.52,Math.sin(idlePhase)*.84);
  shape(context,[[-8,-23],[-3,-27],[4,-26],[8,-21],[6,-13],[-5,-12]],cloth,'#303938',1);
  shape(context,[[-5,-24],[4,-24],[6,-20],[5,-14],[-5,-14]],
    engineer?paint.trim[0]:paint.body[1],paint.dark,.7);
  stroke(context,-6,-13,6,-13,'#333a36',2);
  if (back) {
    shape(context,[[-6,-24],[1,-24],[3,-21],[2,-15],[-6,-15]],'#65716a','#343c39',.8);
    stroke(context,-5,-18,1,-18,paint.light,1.7);
  } else {
    stroke(context,-4,-23,-2,-15,'#b5b4a0',1);
    stroke(context,3,-23,4,-15,'#b5b4a0',1);
  }
  shape(context,[[-8,-24],[-4,-22],[-4,-18],[-8,-17],[-10,-20]],paint.trim[0],paint.dark,.8);
  shape(context,[[4,-23],[8,-22],[11,-18],[8,-15],[4,-18]],cloth,paint.dark,.8);

  shape(context,[[-5,-29],[-2,-33],[5,-31],[7,-27],[4,-23],[-3,-25]],
    back?'#4e5146':'#ae8e75','#524f41',.8);
  shape(context,[[-7,-29],[-5,-34],[-1,-36],[4,-35],[7,-32],[8,-29],[2,-27],[-3,-28]],
    engineer?'#d8b76e':paint.trim[0],paint.dark,.85);
  stroke(context,-4,-33,2,-34,engineer?'#f8dfa0':paint.light,1.25);

  if (engineer) {
    shape(context,[[6,-14],[14,-13],[14,-5],[6,-6]],paint.body[2],'#2d3836',.9);
    stroke(context,8,-15,11,-15,'#9d9f8f',1.5);
    stroke(context,7,-12,12,-12,paint.light,1);
  } else {
    stroke(context,-4,-18,15,-22,'#20292b',3.4);
    stroke(context,2,-19,16,-22,'#899285',.9);
    stroke(context,6,-19,6,-16,'#303734',2);
    stroke(context,3,-18,7,-19,'#b39478',1.75);
  }
  context.restore();
}

function drawMcv(context,origin,heading,paint,enemyVehicle) {
  const painter=vehiclePainter(context,origin,heading);
  const {bar,extrude,visible,panel,line}=painter;
  shadow(context,origin.x+9,origin.y+9,61,22,.48);
  for (const y of [-.73,.41]) {
    if (enemyVehicle) {
      track(painter,-1.08,y,2.15,.32,18);
    } else {
      for (const x of [-.81,-.41,.68]) {
        extrude([[x-.16,y+.035],[x-.10,y],[x+.09,y],[x+.17,y+.035],[x+.17,y+.25],
          [x+.09,y+.285],[x-.10,y+.285],[x-.16,y+.25]],2,17,GUNMETAL,
          [[x-.115,y+.05],[x-.085,y+.016],[x+.065,y+.016],[x+.12,y+.05],[x+.12,y+.235],
            [x+.065,y+.27],[x-.085,y+.27],[x-.115,y+.235]]);
        const side=y<0?-1:1;
        if (!visible(0,side)) continue;
        const edge=y+(side<0?0:.288);
        panel([[x-.16,edge,6],[x-.16,edge,13],[x-.10,edge,17],[x+.09,edge,17],
          [x+.17,edge,13],[x+.17,edge,6],[x+.09,edge,2],[x-.10,edge,2]],'#282c2f','#171d20');
        panel([[x-.087,edge,8],[x-.045,edge,13],[x+.046,edge,13],[x+.09,edge,8],
          [x+.045,edge,5],[x-.045,edge,5]],'#8b8f86','#414947',.7);
      }
    }
  }
  extrude([[-1.05,-.55],[.88,-.55],[1.08,-.39],[1.08,.39],[.88,.55],[-1.05,.55]],12,23,GUNMETAL);
  extrude([[-1.02,-.54],[.28,-.54],[.38,-.40],[.38,.40],[.28,.54],[-1.02,.54]],22,49,paint.body,
    [[-.93,-.43],[.16,-.43],[.29,-.31],[.29,.31],[.16,.43],[-.93,.43]]);
  extrude([[.35,-.46],[.87,-.46],[1.01,-.35],[1.01,.35],[.87,.46],[.35,.46]],22,43,paint.trim,
    [[.39,-.40],[.76,-.40],[.88,-.29],[.88,.29],[.76,.40],[.39,.40]]);
  if (visible(1,0)) {
    panel([[.924,-.277,40],[.924,.277,40],[.982,.29,30],[.982,-.29,30]],'#203841','#91a6a8',1,true);
    line([.930,0,40],[.988,0,30],'#a5b6b1',1.4);
  }
  for (const side of [-1,1]) {
    if (!visible(0,side)) continue;
    panel([[.43,side*.414,41],[.73,side*.415,41],[.84,side*.448,32],[.43,side*.441,32]],
      '#253c43','#879c9e',.85,true);
    const outer=side*.542;
    line([-.95,outer,25],[.29,outer,25],paint.light,2);
    for (const x of [-.85,-.43,-.01]) {
      line([x,outer,25],[x,side*.445,46],paint.trim[0],2.45);
    }
  }
  for (const y of [-.42,.31]) {
    bar(-1.01,y,.25,.12,19,28,INDUSTRIAL_STEEL);
    bar(.86,y,.21,.12,17,23,INDUSTRIAL_STEEL);
    bar(1.06,y,.045,.105,21,24,['#fbe1ad','#877447','#c7a268']);
  }

  // Twin folded supports and an exposed hydraulic cylinder on the deployment deck.
  bar(-.82,-.30,.70,.60,49,54,GUNMETAL);
  for (const x of [-.84,-.73,-.62,-.51,-.40]) {
    line([x,-.14,54.2],[x,.14,54.2],'#464e4d',1.5);
  }
  for (const y of [-.31,.20]) {
    const hinge=[-.73,y+.055,55], joint=[-.47,y+.055,64], tip=[.22,y+.055,57];
    line(hinge,joint,'#303737',7.5);
    line(joint,tip,'#303737',7.5);
    line(hinge,joint,paint.trim[2],4.9);
    line(joint,tip,paint.trim[0],4.9);
    line([-.70,y+.11,52],[-.08,y+.11,57],'#bdba9e',2);
  }
  for (const y of [-.11,.11]) {
    line([-.97,y,50],[-.97,y,62],GUNMETAL[1],3.2);
    line([-.96,y,50],[-.96,y,62],GUNMETAL[0],1.2);
  }
}

function drawDog(context,origin,heading,paint,phase,idlePhase=null,enemyDog=false) {
  const look=project(Math.cos(heading),Math.sin(heading));
  const facing=look.x<0?-1:1;
  const step=Math.sin(phase)*3;
  const coat=enemyDog?'#aaa99b':'#ad885e';
  const light=enemyDog?'#dbd8c8':'#d1ac7e';
  const shade=enemyDog?'#5e6463':'#67513c';
  const outline='#343633';
  context.save();
  context.translate(origin.x,origin.y);
  context.scale(facing,1);
  shadow(context,1,2,22,6,.39);
  for (const [x,offset,color] of [[-11,-step,shade],[10,step,shade],[-15,step,coat],[6,-step,coat]]) {
    shape(context,[[x,-13],[x+4,-14],[x+3+offset*.4,-6],
      [x+4+offset,0],[x-1+offset,0],[x-.1+offset*.4,-6]],color,outline,.7);
  }
  const wag=idlePhase===null?0:Math.sin(idlePhase*2.8)*3.1;
  shape(context,[[-14,-16],[-22,-18+wag],[-26,-12+wag],[-21,-12+wag],[-16,-11]],shade,outline,.8);
  if (idlePhase!==null) context.translate(0,Math.sin(idlePhase)*.66);
  shape(context,[[-17,-13],[-13,-20],[0,-22],[7,-21],[12,-16],[9,-9],
    [3,-8],[-3,-11],[-12,-9]],coat,outline,.9);
  shape(context,[[-15,-16],[-12,-20],[1,-22],[6,-21],[8,-15],[1,-17],[-5,-15]],shade);
  shape(context,[[-9,-20],[-2,-21],[-1,-13],[-7,-12]],paint.body[2],paint.dark,.7);
  stroke(context,-8,-18,-3,-19,paint.light,1.55);
  shape(context,[[6,-17],[9,-23],[12,-24],[11,-30],[15,-29],[17,-25],[20,-24],
    [21,-20],[26,-17],[23,-14],[16,-15],[12,-11],[8,-13]],coat,outline,.9);
  shape(context,[[20,-20],[26,-17],[23,-14],[19,-16],[17,-18]],shade,outline,.65);
  shape(context,[[12,-27],[14,-28],[16,-24],[13,-24]],shade);
  stroke(context,11,-19,14,-16,light,1.5);
  stroke(context,9,-21,13,-13,paint.trim[0],2.6);
  context.fillStyle='#252b28';
  context.fillRect(17.5,-22.2,2,1.5);
  context.restore();
}

function drawHq(context,building,paint) {
  const x=building.x-.43,y=building.y-.43,p=project(x+1.55,y+1.14);
  shadow(context,p.x+16,p.y+11,105,36,.39);
  cuboid(context,project,x,y,2.86,1.86,0,6,['#858a76','#4e5f53','#657361']);
  cuboid(context,project,x+.12,y+.10,2.58,1.60,6,61,['#965d44','#65776c','#4f635d']);
  cuboid(context,project,x+.08,y+.05,2.65,1.69,58,66,paint.body);
  cuboid(context,project,x+.19,y+.16,1.06,.75,65,83,['#818571','#526354','#697963']);
  const z=project(x+.42,y+.37,84);
  stroke(context,z.x,z.y,z.x,z.y-19,'#c8bfa2',1.4);
  stroke(context,z.x-8,z.y-15,z.x+8,z.y-15,'#b8b395',1);
  for(let i=0;i<4;i++) {
    const left=x+.23+i*.32;
    polygon(context,[project(left,y+1.72,38),project(left+.23,y+1.72,38),
      project(left+.23,y+1.72,53),project(left,y+1.72,53)],'#8fab98','#4e6a5e',.8);
  }
  cuboid(context,project,x+1.82,y+.42,.26,.25,65,120,['#ac9659','#8e7547','#716441']);
  cuboid(context,project,x+1.32,y+.40,1.19,.29,115,124,['#c09c56','#877245','#977b46']);
  const end=project(x+2.41,y+.56,115);
  stroke(context,end.x,end.y,end.x,end.y+18,'#cbb389',1.4);
  stroke(context,end.x,end.y+18,end.x-4,end.y+19,'#d9bb7f',1.4);
  worldLine(context,x+.14,y+1.72,x+2.66,y+1.72,56,paint.light,2.5);
}

function drawIdleExhaust(context,unit,origin,phase) {
  const distance=unit.type==='mcv'?.91:.73;
  const rear=project(-Math.cos(unit.heading)*distance,-Math.sin(unit.heading)*distance,13);
  context.save();
  const alpha=context.globalAlpha;
  for (let i=0;i<2;i++) {
    const age=(phase*.19+i*.5)%1;
    context.globalAlpha=alpha*(1-age)*.29;
    context.fillStyle='#a7ac93';
    context.beginPath();
    context.ellipse(origin.x+rear.x-age*9,origin.y+rear.y-age*11,2+age*3,1.5+age*2.4,0,0,Math.PI*2);
    context.fill();
  }
  context.restore();
}

// Each painted limb has a joint, a foot, a contact phase, and a cutout in sprite pixels.
// The red and blue sprites use the same silhouettes.
const GAIT_LIMBS={
  soldier:[
    [
      [[49,107],[16,179],.5,[[31,105],[58,110],[66,128],[54,153],[42,190],[0,190],[0,156]]],
      [[65,106],[91,179],0,[[58,102],[83,103],[111,127],[121,174],[123,190],[46,190],[61,148],[66,128]]],
    ],
    [
      [[29,108],[22,150],.5,[[8,107],[34,107],[42,128],[36,158],[0,164],[0,119]]],
      [[47,112],[49,183],0,[[35,104],[76,111],[76,156],[67,190],[28,190],[35,151]]],
    ],
    [
      [[54,104],[75,144],.5,[[52,102],[76,101],[97,126],[97,154],[67,159],[57,138]]],
      [[42,106],[20,177],0,[[20,105],[54,100],[66,117],[57,139],[42,190],[0,190],[0,151]]],
    ],
    [
      [[56,107],[56,151],.5,[[48,104],[70,104],[75,150],[49,163],[46,130]]],
      [[35,109],[39,181],0,[[21,110],[47,104],[51,138],[60,188],[23,190],[19,147]]],
    ],
  ],
  dog:[
    [
      [[77,71],[94,120],0,[[65,69],[96,66],[112,108],[106,127],[73,128],[65,103]]],
      [[145,67],[175,124],.5,[[142,65],[164,65],[188,112],[193,131],[150,131],[143,96]]],
      [[57,70],[47,123],.13,[[39,75],[65,66],[74,93],[62,127],[27,131],[31,102]]],
      [[131,68],[123,124],.63,[[113,67],[144,68],[148,95],[142,131],[106,131],[109,100]]],
    ],
    [
      [[50,39],[49,93],0,[[38,39],[61,38],[64,68],[60,102],[37,102],[36,60]]],
      [[107,63],[101,122],.5,[[93,65],[118,59],[119,111],[115,137],[87,135],[86,98]]],
      [[64,49],[78,110],.13,[[57,46],[82,44],[89,85],[89,119],[66,123],[56,79]]],
      [[127,77],[146,158],.63,[[119,75],[149,75],[159,125],[168,167],[129,167],[112,112]]],
    ],
    [
      [[70,116],[69,152],0,[[63,111],[87,112],[88,157],[61,166],[59,136]]],
      [[127,72],[126,126],.5,[[120,72],[146,76],[148,131],[119,142],[116,95]]],
      [[56,121],[42,180],.13,[[37,125],[66,115],[74,136],[57,187],[49,190],[25,190],[23,153]]],
      [[110,89],[100,146],.63,[[94,88],[119,85],[124,125],[115,154],[86,156],[85,121]]],
    ],
    [
      [[54,121],[52,159],.5,[[49,120],[64,114],[69,145],[62,174],[43,174],[42,157]]],
      [[18,119],[16,181],0,[[7,114],[23,125],[28,151],[33,187],[5,190],[2,149]]],
    ],
  ],
};
const DOG_IDLE_PARTS=[
  [
    [[151,55],[[146,43],[151,2],[210,0],[210,65],[173,72],[148,64]]],
    [[43,72],[[0,69],[43,63],[52,69],[36,84],[13,101],[0,103]]],
  ],
  [
    [[136,60],[[117,42],[131,15],[193,15],[193,112],[154,104],[146,84],[125,72]]],
    [[43,35],[[0,14],[44,15],[55,31],[43,49],[12,58],[0,53]]],
  ],
  [
    [[112,66],[[100,38],[103,0],[166,0],[166,70],[141,72],[112,78]]],
    [[40,125],[[30,115],[44,131],[28,155],[19,170],[0,172],[0,149]]],
  ],
  [
    [[35,86],[[14,76],[53,76],[60,109],[48,128],[47,153],[23,153],[21,128],[13,106]]],
  ],
];
const gaitArt=new WeakMap();

function gaitLayers(image,type,facing,equine) {
  if (gaitArt.has(image)) return gaitArt.get(image);
  const w=image.naturalWidth,h=image.naturalHeight;
  const canvas=document.createElement('canvas');
  canvas.width=w;
  canvas.height=h;
  const body=canvas.getContext('2d');
  body.drawImage(image,0,0);
  body.globalCompositeOperation='destination-out';
  const count=equine && facing!==3?4:2;
  const top=Math.round(h*(type==='engineer'?.70:equine?.67:.60));
  const definitions=GAIT_LIMBS[type]?.[facing] ?? Array.from({length:count},(_,index)=>{
    const left=Math.round(w*index/count),right=Math.round(w*(index+1)/count);
    const x=(left+right)/2;
    return [[x,top],[x,h-2],index%2*.5,[[left,top],[right,top],[right,h],[left,h]]];
  });
  const cutout=polygon=>{
    const path=new Path2D();
    polygon.forEach(([x,y],index)=>index?path.lineTo(x,y):path.moveTo(x,y));
    path.closePath();
    body.fill(path);
    const left=Math.min(...polygon.map(point=>point[0]));
    const top=Math.min(...polygon.map(point=>point[1]));
    const layer=document.createElement('canvas');
    layer.width=Math.max(...polygon.map(point=>point[0]))-left;
    layer.height=Math.max(...polygon.map(point=>point[1]))-top;
    const part=layer.getContext('2d');
    part.translate(-left,-top);
    part.clip(path);
    part.drawImage(image,0,0);
    return {layer,left,top};
  };
  const limbs=definitions.map(([hip,foot,contact,polygon])=>{
    const dx=foot[0]-hip[0],dy=foot[1]-hip[1];
    const squaredLength=dx*dx+dy*dy;
    return {...cutout(polygon),hip,foot,contact,axisX:dx/squaredLength,axisY:dy/squaredLength};
  });
  const idleParts=type==='dog'?DOG_IDLE_PARTS[facing].map(([pivot,polygon])=>({...cutout(polygon),pivot})):[];
  const art={body:canvas,limbs,idleParts};
  gaitArt.set(image,art);
  return art;
}

function dogRunMix(stride) {
  return smooth(Math.max(0,Math.min(1,(stride-.40)/.44)));
}

function drawGait(context,image,width,height,unit,facing,forward,mirror,equine,idlePhase=null) {
  const dog=unit.type==='dog';
  const quadruped=dog || equine;
  const stride=unit.stride??0;
  const running=dog?dogRunMix(stride):1;
  const strideLength=equine?1.46:dog?mix(.64,1.34,running):.82;
  const stance=equine?.34:dog?mix(.52,.30,running):.43;
  const phase=dog?(unit.gaitCycles??(unit.travel??0)/1.34):(unit.travel??0)/strideLength;
  const strength=dog?smooth(Math.min(1,stride*2.0)):smooth(Math.min(1,stride*3.5));
  const resting=idlePhase===null?0:1-smooth(Math.min(1,stride*4));
  const breath=idlePhase===null?0:Math.sin(idlePhase*.62)*.56*resting;
  const scale=width/image.naturalWidth;
  const strideX=forward.x*(mirror?-1:1)*strideLength*stance;
  const strideY=forward.y*strideLength*stance;
  const bounce=(quadruped?Math.cos(phase*Math.PI*2):Math.cos(phase*Math.PI*4))*
    (dog?mix(.53,1.25,running):equine?1.65:.8)*strength+breath;
  const art=gaitLayers(image,unit.type,facing,equine);

  context.save();
  context.translate(-width/2,-height+bounce);
  context.scale(scale,scale);
  for (const [index,{layer,left,top,hip,foot,contact:runContact,axisX,axisY}] of art.limbs.entries()) {
    const trotContact=art.limbs.length===4?(index===0 || index===3?.5:0):runContact;
    const contact=dog?mix(trotContact,runContact,running):runContact;
    const cycle=(phase+1-contact)%1;
    const swing=Math.max(0,(cycle-stance)/(1-stance));
    // During contact the foot moves backwards exactly as far as the unit advances.
    const reach=cycle<stance?.5-cycle/stance:-.5+smooth(swing);
    const lift=Math.sin(swing*Math.PI)*(dog?mix(2.5,4.7,running):equine?4.4:4);
    const pawShift=idlePhase===null || index!==1?0:
      resting*Math.max(0,Math.sin(idlePhase*.31))**20*(equine?2.1:1.6);
    const dx=strength*(strideX*reach/scale+(hip[0]-foot[0])*.48);
    const dy=(strength*(strideY*reach-lift)-bounce-pawShift)/scale;
    context.save();
    context.translate(hip[0],hip[1]);
    context.transform(1+dx*axisX,dy*axisX,dx*axisY,1+dy*axisY,0,0);
    context.drawImage(layer,left-hip[0],top-hip[1]);
    context.restore();
  }
  context.drawImage(art.body,0,0);
  for (const [index,{layer,left,top,pivot:[x,y]}] of art.idleParts.entries()) {
    const idle=idlePhase??0;
    const glance=Math.max(0,Math.sin(idle*.37-.8))**6;
    const turn=index===0?(Math.sin(phase*Math.PI*2-.6)*.045*strength+glance*.095*resting):
      (Math.sin(idle*1.55)*.15*resting+Math.cos(phase*Math.PI*2)*.05*strength);
    context.save();
    context.translate(x,y);
    context.rotate(turn);
    context.drawImage(layer,left-x,top-y);
    context.restore();
  }
  context.restore();
}

function drawIdlePose(context,image,width,height,phase,type) {
  const engineer=type==='engineer';
  const shoulder=engineer?.44:.53;
  const arm=engineer?[0,.35,shoulder,.68]:[shoulder,.24,1,type==='rocketeer'?.50:.56];
  const leg=type==='rocketeer'?.74:.78;
  const stepCycle=phase*.35;
  const alternate=Math.floor(stepCycle/Math.PI)%2;
  const foot=[alternate*.5,leg,alternate*.5+.5,1];
  const armMovement=Math.max(0,Math.sin(phase*.42+.7))**5;
  const footMovement=Math.abs(Math.sin(stepCycle))**7;

  const rectangle=(path,part)=>{
    const [left,top,right,bottom]=part;
    path.rect((left-.5)*width,(top-1)*height,(right-left)*width,(bottom-top)*height);
  };
  const torso=new Path2D();
  rectangle(torso,[0,0,1,1]);
  rectangle(torso,arm);
  rectangle(torso,foot);
  context.save();
  context.clip(torso,'evenodd');
  context.drawImage(image,-width/2,-height,width,height);
  context.restore();

  const drawLimb=(part,pivot,angle)=>{
    const clip=new Path2D();
    rectangle(clip,part);
    const x=(pivot[0]-.5)*width,y=(pivot[1]-1)*height;
    context.save();
    context.translate(x,y);
    context.rotate(angle);
    context.translate(-x,-y);
    context.clip(clip);
    context.drawImage(image,-width/2,-height,width,height);
    context.restore();
  };
  drawLimb(arm,[shoulder,engineer?.38:.31],armMovement*(engineer?.13:-.10));
  drawLimb(foot,[(alternate+.5)*.5,leg],footMovement*(alternate?.18:-.18));
}

function drawTankAssembly(context,unit,origin,facing,mirror,strength) {
  const atlas=sprites.get('tank-reference-'+factionTint(unit.team));
  if (!atlas?.naturalWidth) return false;
  const heading=unit.turretHeading??unit.heading;
  const direction=project(Math.cos(heading),Math.sin(heading));
  const screenAngle=Math.atan2(direction.y,direction.x);
  const octant=Math.PI/4;
  const step=Math.round(screenAngle/octant);
  const index=(step+8)%8;
  const {rect:[hx,hy,hw,hh],mount:[ringX,ringY],width,ground}=TANK_HULL_POSES[facing];
  const scale=width/hw,height=hh*scale;
  const {rect:[tx,ty,tw,th],mount:[pivotX,pivotY],width:turretWidth}=TANK_TURRET_POSES[index];
  const turretScale=turretWidth/tw;
  const suspension=strength>.025?(unit.lean??0):0;
  const bounce=strength>.025?Math.sin((unit.travel??0)*14)*.43*strength:0;

  context.save();
  context.translate(origin.x,origin.y+ground+bounce);
  if (suspension) context.rotate(suspension);
  context.save();
  if (mirror) context.scale(-1,1);
  context.drawImage(atlas,hx,hy,hw,hh,-width/2,-height,width,height);
  context.restore();
  context.translate((ringX-hx-hw/2)*scale*(mirror?-1:1),(ringY-hy-hh)*scale);
  // Interpolate between the painted directions around the mounting ring.
  context.rotate((screenAngle-step*octant)*.38);
  context.drawImage(atlas,tx,ty,tw,th,(tx-pivotX)*turretScale,(ty-pivotY)*turretScale,turretWidth,th*turretScale);
  context.restore();
  return true;
}

function drawTransportHelicopter(context,unit,origin,paint) {
  const {bar,extrude,panel,line}=vehiclePainter(context,origin,unit.heading);
  for (const side of [-1,1]) {
    line([-.59,side*.37,1],[.65,side*.37,1],'#242e30',3);
    for (const x of [-.39,.37]) line([x,side*.37,2],[x,side*.27,12],'#565f5e',2.2);
  }
  bar(-1.42,-.07,.93,.14,17,23,GUNMETAL);
  bar(-1.36,-.052,.14,.104,21,39,paint.trim);
  extrude([[-.63,-.38],[.37,-.38],[.68,-.23],[.78,0],[.68,.23],[.37,.38],[-.63,.38]],
    8,31,paint.body,[[-.55,-.34],[.35,-.31],[.55,-.19],[.65,0],[.55,.19],[.35,.31],[-.55,.34]]);
  for (const side of [-1,1]) {
    panel([[.15,side*.331,26],[.47,side*.255,27],[.62,side*.19,19],[.15,side*.352,18]],'#20343c','#829b9e',.8,true);
    line([-.54,side*.379,17],[-.04,side*.379,17],paint.light,1.6);
  }
  panel([[.52,-.18,28],[.52,.18,28],[.76,.12,17],[.76,-.12,17]],'#324c58','#899b9d',.8,true);
  bar(-.19,-.17,.34,.34,29,36,paint.trim);
  bar(-.04,-.04,.08,.08,34,46,GUNMETAL);
  const angle=reducedMotion.matches?.24:lastFrame*.017;
  for (let i=0;i<2;i++) {
    const heading=angle+i*Math.PI/2;
    const x=Math.cos(heading)*1.16,y=Math.sin(heading)*1.16;
    line([-x,-y,45],[x,y,45],'#313a3bd0',2.2);
  }
}

function renderUnit(context,unit,origin) {
  const paint=TEAM_PAINT[unit.team];
  if (unit.type==='helicopter') return drawTransportHelicopter(context,unit,origin,paint);
  const hostile=unit.team==='enemy';
  const wheeled=Boolean(VEHICLE_CONTACT_RADIUS[unit.type]);
  const dog=unit.type==='dog';
  const equine=unit.type==='horse' || unit.type==='mountedCavalry';
  const quadruped=dog || equine;
  const travel=unit.travel??0;
  const phase=travel*Math.PI*2/(equine?1.31:dog?1.01:.69);
  const strength=reducedMotion.matches?0:(unit.stride??0);
  const idlePhase=reducedMotion.matches?null:lastFrame*.00375+(unit.id??0)*1.37;
  if (idlePhase!==null && wheeled && strength<.16) drawIdleExhaust(context,unit,origin,idlePhase);
  const forward=project(Math.cos(unit.heading),Math.sin(unit.heading));
  const angle=Math.atan2(forward.y,Math.abs(forward.x));
  const facing=angle<-.22?2:angle<.22?0:angle>1.02?3:1;
  const spriteType=isAirborne(unit)?'fighter':unit.type;
  const width=unitSpriteWidths[spriteType][facing]*(unit.type==='bomber'?1.15:unit.type==='reconPlane'?.80:1);
  const offset=wheeled?[12,25,20,31][facing]:quadruped?[3,8,6,8][facing]:2;
  const mirror=forward.x<0 && facing!==3;
  if (unit.type==='tank' && drawTankAssembly(context,unit,origin,facing,mirror,strength)) return;
  const image=sprites.get(spriteType+'-'+facing+'-'+factionTint(unit.team));
  if (image?.naturalWidth) {
    const height=width*image.naturalHeight/image.naturalWidth;
    const bodyBob=wheeled?Math.sin(travel*14)*.48*strength:0;
    context.save();
    context.translate(origin.x,origin.y+offset+bodyBob);
    if (wheeled && !reducedMotion.matches && strength>.025) {
      context.rotate((unit.lean??0)*(facing===3 ? .5 : 1));
    }
    if (mirror) context.scale(-1,1);
    if (isAirborne(unit)) {
      context.drawImage(image,-width/2,-height*.75,width,height);
    } else if (!wheeled && idlePhase!==null && (quadruped || strength>.025)) {
      drawGait(context,image,width,height,unit,facing,forward,mirror,equine,quadruped?idlePhase:null);
    } else if (!wheeled && !equine && idlePhase!==null) {
      drawIdlePose(context,image,width,height,idlePhase,unit.type);
    } else context.drawImage(image,-width/2,-height,width,height);
    context.restore();
    return;
  }
  if (unit.type==='miner') drawTruck(context,origin,unit.heading,paint,unit.cargo,unit.aim);
  else if (unit.type==='mcv') drawMcv(context,origin,unit.heading,paint,hostile);
  else if (wheeled) drawTank(context,origin,unit.heading,paint,hostile);
  else if (COMBAT_INFANTRY.has(unit.type) || unit.type==='engineer') {
    drawSoldier(context,origin,unit.heading,paint,strength>.025?phase:0,unit.type==='engineer',
      strength>.025?null:idlePhase);
  } else if (dog) drawDog(context,origin,unit.heading,paint,strength>.025?phase:0,
    strength>.025?null:idlePhase,hostile);
}

function drawMovementDust() {
  if (reducedMotion.matches) return;
  for (const dust of movementDust) {
    const age=game.time-dust.time;
    if (age>=.66 || !currentlyVisible(dust.x,dust.y)) continue;
    const progress=age/.66;
    const point=projectGround(dust.x+dust.dx*age,dust.y+dust.dy*age,1+progress*5);
    const radius=dust.radius+progress*6;
    ctx.fillStyle='rgba(166,148,112,'+((1-progress)**2*dust.opacity)+')';
    ctx.beginPath();
    ctx.ellipse(point.x,point.y,radius,radius*.52,0,0,Math.PI*2);
    ctx.fill();
  }
}

function drawOilField(context,field) {
  const x=field.x-.40, y=field.y-.40;
  const p=project(x+.94,y+.91);
  const paint=TEAM_PAINT[field.team];
  const stripe=paint?.light??OIL_FIELD.color;
  shadow(context,p.x+10,p.y+9,55,23,.41);
  cuboid(context,project,x,y,1.80,1.80,0,4,['#8b8370','#4c5245','#615d4f'],'#525446');
  cuboid(context,project,x+.12,y+1.19,.59,.45,4,23,['#8f8d70','#54594a','#767054']);
  cuboid(context,project,x+.13,y+1.16,.60,.52,22,27,paint?.body??['#ac8f60','#685747','#826a50']);
  worldLine(context,x+.12,y+1.65,x+.67,y+1.65,15,stripe,2.7);

  const pivot=project(x+.85,y+.74,60);
  for (const [ax,ay] of [[.41,.45],[1.24,.46],[1.20,1.09],[.44,1.10]]) {
    const foot=project(x+ax,y+ay,4);
    stroke(context,foot.x,foot.y,pivot.x,pivot.y,'#3f4339',4);
    stroke(context,foot.x,foot.y,pivot.x,pivot.y,'#928d70',1.5);
  }
  worldLine(context,x+.54,y+.64,x+1.10,y+.88,27,'#897d61',2);
  const swing=paint?Math.sin(game.time*1.8+field.x*.23)*12:0;
  const tail=project(x+.22,y+.74,58+swing);
  const head=project(x+1.57,y+.74,66-swing);
  stroke(context,tail.x,tail.y,pivot.x,pivot.y,'#444335',8);
  stroke(context,pivot.x,pivot.y,head.x,head.y,'#524c3b',8);
  stroke(context,tail.x,tail.y-1,head.x,head.y-1,stripe,3);
  shape(context,[[head.x-2,head.y-8],[head.x+5,head.y-7],[head.x+11,head.y],
    [head.x+9,head.y+9],[head.x+4,head.y+12],[head.x+1,head.y+4]],stripe,'#544b39',1.2);
  const well=project(x+1.62,y+.70,8);
  stroke(context,head.x+8,head.y+8,well.x,well.y,'#473e30',1.4);
  cuboid(context,project,x+1.48,y+.57,.30,.28,4,10,['#726f59','#48473a','#615748']);
}

const constructionFrames=new WeakMap();

function constructionFrame(image) {
  if (constructionFrames.has(image)) return constructionFrames.get(image);
  const frame=document.createElement('canvas');
  frame.width=Math.min(152,image.naturalWidth);
  frame.height=Math.round(frame.width*image.naturalHeight/image.naturalWidth);
  const painter=frame.getContext('2d',{willReadFrequently:true});
  painter.drawImage(image,0,0,frame.width,frame.height);
  const {width,height}=frame;
  const {data}=painter.getImageData(0,0,width,height);
  const lines=painter.createImageData(width,height);
  const brightness=new Float32Array(width*height);
  for (let i=0;i<brightness.length;i++) {
    const p=i*4;
    brightness[i]=(data[p]*.22+data[p+1]*.70+data[p+2]*.08)*(data[p+3]/255);
  }
  for (let y=0;y<height;y++) {
    for (let x=0;x<width;x++) {
      const i=y*width+x,p=i*4;
      if (data[p+3]<20) continue;
      const left=y*width+Math.max(0,x-2),right=y*width+Math.min(width-1,x+2);
      const above=Math.max(0,y-2)*width+x,below=Math.min(height-1,y+2)*width+x;
      const silhouette=Math.min(data[left*4+3],data[right*4+3],data[above*4+3],data[below*4+3])<112;
      const contrast=Math.abs(brightness[right]-brightness[left])+Math.abs(brightness[above]-brightness[below]);
      const clarity=silhouette?170:Math.max(0,Math.min(150,(contrast-35)*1.75));
      lines.data[p]=189;
      lines.data[p+1]=214;
      lines.data[p+2]=217;
      lines.data[p+3]=Math.round((12+clarity)*data[p+3]/255);
    }
  }
  painter.putImageData(lines,0,0);
  constructionFrames.set(image,frame);
  return frame;
}

function structureArt(building) {
  const variant=building.type==='wall'?'wall-'+(building.axis??'x'):building.type;
  const image=sprites.get(variant+'-'+factionTint(building.team));
  const position=yardCenter(building);
  const center=project(position.x,position.y);
  const width=buildingSpriteWidths[building.type];
  const height=image?.naturalWidth?width*image.naturalHeight/image.naturalWidth:buildingSpec(building.type).roof;
  const bottom=center.y+V*(building.width+building.height)*(building.type==='wall'?.37:.48);
  const progress=building.remaining>0?1-building.remaining/buildingSpec(building.type).time:1;
  return {image,left:center.x-width/2,width,height,bottom,top:bottom-height,progress};
}

// Operating effects sit on features shared by the two painted faction variants.
const buildingLights={
  yard:[[.455,.522],[.642,.459],[.689,.451]],
  factory:[[.59,.548],[.77,.434]],
  refinery:[[.453,.461]],
  barracks:[[.567,.028],[.176,.621],[.449,.733]],
  airport:[[.246,.149],[.352,.915],[.489,.856],[.636,.790],[.787,.717],[.890,.651]],
  solar:[[.790,.278],[.819,.292]],
  diesel:[[.152,.348],[.286,.427],[.432,.502]],
  oil:[[.733,.749]],
  sentry:[[.227,.510]],
  turret:[[.500,.121]],
  bunker:[[.179,.477],[.491,.595]],
  laser:[[.292,.238]],
  recreation:[[.256,.503],[.410,.574]],
  training:[[.859,.369]],
};
const buildingEffectSprites=new Map();

function drawBuildingGlow(context,color,x,y,rx,ry,intensity) {
  if (!buildingEffectSprites.has(color)) {
    const image=document.createElement('canvas');
    image.width=image.height=32;
    const brush=image.getContext('2d');
    const glow=brush.createRadialGradient(16,16,0,16,16,16);
    glow.addColorStop(0,color);
    glow.addColorStop(.32,color+'9e');
    glow.addColorStop(1,color+'00');
    brush.fillStyle=glow;
    brush.fillRect(0,0,32,32);
    buildingEffectSprites.set(color,image);
  }
  const opacity=context.globalAlpha;
  context.globalAlpha=opacity*intensity;
  context.drawImage(buildingEffectSprites.get(color),x-rx,y-ry,2*rx,2*ry);
  context.globalAlpha=opacity;
}

function drawBuildingActivity(context,building,art) {
  const {type,team}=building;
  const lights=buildingLights[type];
  if (!lights || team==='neutral' || building.health<=0 || building.remaining>0 ||
      reducedMotion.matches || observedMatch?.status!=='running') return;
  const rate=team===game.perspective?viewFaction().power.rate:1;
  const active=team===game.perspective && building.queue?.[0]?.remaining>0;
  const time=lastFrame*.001+hash(building.x,building.y,97)*5;
  const phase=time*(active?4:1.7)*(.55+.45*rate);
  const signal=type==='laser' || type==='solar' || type==='barracks';
  const color=signal?(team==='enemy'?'#ff794b':'#8ad8ff'):'#ffca7e';
  for (const [i,[x,y]] of lights.entries()) {
    const wave=.5+.5*Math.cos(phase-i*(type==='airport'?1.45:1.9));
    const strength=(active?.30+.55*wave:.20+.34*wave)*(.42+.58*rate);
    const radius=type==='laser'?6:type==='airport'?4:4.8;
    drawBuildingGlow(context,color,art.left+x*art.width,art.top+y*art.height,radius,radius*.8,strength);
  }

  if (type==='oil' || type==='diesel') {
    const oil=type==='oil';
    const x=art.left+art.width*(oil?.567:.269);
    const y=art.top+art.height*(oil?.593:.536);
    const radius=oil?5:4;
    context.beginPath();
    for (let i=0;i<3;i++) {
      const angle=time*(oil?4:7)+i*Math.PI*2/3;
      context.moveTo(x,y);
      context.lineTo(x+Math.cos(angle)*radius*(oil?1:.56),y+Math.sin(angle)*radius*(oil?.76:1.55));
    }
    context.strokeStyle=oil?'#d2a46794':'#bec2ac6e';
    context.lineWidth=1.15;
    context.stroke();
  }

  if ((type==='diesel' || type==='refinery') && building.health>buildingSpec(type).health*.70) {
    const diesel=type==='diesel';
    const stack=diesel?[.227,.035]:[.347,.029];
    const x=art.left+art.width*stack[0],y=art.top+art.height*stack[1];
    for (let i=0;i<3;i++) {
      const age=(time*(diesel?.72:.54)+i/3)%1;
      const opacity=Math.sin(age*Math.PI)*.23*(diesel?1:rate);
      drawBuildingGlow(context,'#d1cbb6',x+age*9,y-age*23,3+age*7,2.8+age*5,opacity);
    }
  }
}

function drawStructure(context,structure,art) {
  const {image,left,top,bottom,width:drawWidth,height:drawHeight,progress}=art;
  if (image?.naturalWidth) {
    if (progress>=1) {
      context.drawImage(image,left,top,drawWidth,drawHeight);
      drawBuildingActivity(context,structure,art);
      return;
    }
    const fill=Math.max(0,(progress-.18)/.82);
    const visibleHeight=drawHeight*(.10+.90*smooth(fill));
    const shellOpacity=1-smooth(fill)*.91;
    const opacity=context.globalAlpha;
    context.save();
    context.globalAlpha=opacity*shellOpacity;
    context.drawImage(constructionFrame(image),left,top,drawWidth,drawHeight);
    if (fill>0) {
      const scale=image.naturalHeight/drawHeight;
      const srcHeight=visibleHeight*scale;
      context.globalAlpha=opacity*mix(.20,1,fill);
      context.filter='saturate('+mix(.28,1,fill)+') brightness('+mix(1.24,1,fill)+')';
      context.drawImage(image,0,image.naturalHeight-srcHeight,image.naturalWidth,srcHeight,
        left,bottom-visibleHeight,drawWidth,visibleHeight);
    }
    context.restore();
    return;
  }
  if (structure.remaining>0 || ['wall','bunker','laser','solar','diesel','recreation','training'].includes(structure.type)) return;
  const position=yardCenter(structure);
  const center=project(position.x,position.y);
  if (structure.type==='oil') return drawOilField(context,structure);
  const paint=TEAM_PAINT[structure.team];
  if (structure.type==='refinery') {
    const shift=project(structure.x+2,structure.y-5);
    context.save();
    context.translate(shift.x,shift.y);
    refinery(context,game.time,paint);
    context.restore();
    return;
  }
  if (structure.type==='yard') return drawHq(context,structure,paint);
  const {x,y,width,height,type}=structure;
  const xx=x-.43, yy=y-.43, w=width-.14, d=height-.14;
  const factory=type==='factory';
  const roof=factory?56:44;
  const floor=yy+d-.05;
  shadow(context,center.x+14,center.y+12,width*35,height*15,.38);
  cuboid(context,project,x-.47,y-.47,width-.045,height-.045,0,5,
    ['#828473','#4c5a4e','#606853'],'#555b4b');
  cuboid(context,project,xx,yy,w,d,5,roof-4,
    factory?['#79775e','#70786b','#52695b']:['#8f765c','#7f715e','#526758']);
  cuboid(context,project,xx-.04,yy-.04,w+.08,d+.08,roof-5,roof,paint.body);
  const stripe=(a,b,u,v,color)=>polygon(context,
    [project(a,floor,v),project(b,floor,v),project(b,floor,u),project(a,floor,u)],color,'#55563e',.6);
  stripe(xx+.04,xx+w-.04,roof-17,roof-12,paint.light);
  const door=xx+(factory ? .53 : .55);
  const doorWidth=factory ? 1.60 : .64;
  stripe(door-.08,door+doorWidth+.08,5,roof-17,'#746956');
  stripe(door,door+doorWidth,5,roof-19,'#29352a');
  for (let i=1;i<5;i++) {
    const beam=project(door+doorWidth/5*i,floor,roof-24);
    context.fillStyle=i%3===0?'#e1bc79':'#829b80';
    context.fillRect(beam.x-2,beam.y,4,2);
  }
  for (let i=0;i<Math.ceil(w/.26);i++) {
    const offset=i*.26;
    worldLine(context,xx+offset,yy+.055,xx+offset,yy+d-.045,roof+.05,paint.dark,1.08);
  }
  for (let i=0;i<4;i++) {
    if (factory) {
      worldLine(context,xx+.20,yy+d+.08+i*.09,xx+.38,yy+d+.08+i*.09,0,
        i%2?'#b7914d':'#424737',1.7);
    } else {
      stripe(xx+.14+i*.36,xx+.28+i*.36,roof-29,roof-24,'#a0b39d');
    }
  }
  if (factory) {
    cuboid(context,project,xx+.15,yy+.22,w*.65,.33,roof,roof+13,['#88725b','#524d43','#68534a']);
    cuboid(context,project,xx+w-.33,yy+.16,.21,.27,roof,roof+27,['#877e5f','#516050','#455448']);
    cuboid(context,project,xx+w-.38,yy+.11,.31,.37,roof+25,roof+30,['#928669','#59564a','#665d46']);
  } else {
    cuboid(context,project,xx+.22,yy+.18,1.0,.39,roof,roof+7,['#7f8363','#5b6453','#585d48']);
    const rail=project(xx+w-.34,yy+.36,roof);
    stroke(context,rail.x,rail.y,rail.x,rail.y-21,'#363e32',1.8);
    stroke(context,rail.x-8,rail.y-19,rail.x+6,rail.y-16,'#aaa986',1.1);
  }
}

function buildingSpec(type) {
  return type==='oil'?OIL_FIELD:type==='yard'?YARD:BUILDINGS[type];
}

function damageStage(building) {
  const integrity=building.health/buildingSpec(building.type).health;
  if (integrity>=1) return 0;
  if (integrity>.70) return 1;
  return integrity>.35?2:3;
}

function drawBuildingDamage(context,building) {
  const stage=damageStage(building);
  if (!stage) return;
  const {x,y,width,height,remaining}=building;
  const roof=remaining>0?18:buildingSpec(building.type).body-8;
  const wall=project(x+width*.36,y+height-.66,roof*.63);
  context.save();
  shape(context,[[wall.x-15,wall.y-4],[wall.x-4,wall.y-12],[wall.x+12,wall.y-5],
    [wall.x+14,wall.y+5],[wall.x-7,wall.y+9]],'#2928208a',null);
  stroke(context,wall.x-11,wall.y+7,wall.x-3,wall.y-6,'#28251f',2);
  stroke(context,wall.x-3,wall.y-6,wall.x+7,wall.y-1,'#28251f',2);
  if (stage>=2) {
    const source=project(x+width*.51,y+height*.49,roof);
    const particles=stage===3?8:5;
    for (let i=0;i<particles;i++) {
      const age=(game.time*.72+i/particles+hash(x,y,63))%1;
      const drift=(hash(i,x+y,64)*.6+.6)*age;
      context.globalAlpha=(1-age)*(stage===3?.58:.41);
      context.fillStyle=i%2?'#5a574a':'#34352f';
      context.beginPath();
      context.ellipse(source.x-drift*20,source.y-age*(stage===3?57:43),
        4+age*12,3+age*8,0,0,Math.PI*2);
      context.fill();
    }
    context.globalAlpha=1;
    if (stage===3) {
      for (let i=0;i<3;i++) {
        const flame=project(x+.13+i*width*.28,y+height*.50,roof-3);
        const sway=Math.sin(game.time*7+i*1.8);
        const rise=10+sway*3+i*2;
        shape(context,[[flame.x-6,flame.y],[flame.x-3,flame.y-5],
          [flame.x+sway*3,flame.y-rise],[flame.x+5,flame.y-4],[flame.x+6,flame.y]],'#dc7e43',null);
        shape(context,[[flame.x-2,flame.y],[flame.x+sway,flame.y-rise*.66],
          [flame.x+3,flame.y]],'#f4c670',null);
      }
    }
  }
  context.restore();
}

function buildingLabelPoint(building) {
  if (building.remaining>0) {
    const art=structureArt(building);
    return {x:art.left+art.width/2,y:art.top-10};
  }
  if (building.type==='refinery' && building.remaining===0) {
    return project(building.x+.55,building.y+.21,125);
  }
  const height=buildingSpec(building.type).roof+10;
  return project(building.x+(building.width-1)*.5,building.y+.15,height);
}

function buildingCaption(building) {
  const owner=building.team==='neutral'?'中立':factionName(building.team);
  return owner+buildingSpec(building.type).label;
}

function structureOutline(building) {
  const {x,y,width,height}=building;
  return [[x-.48,y-.48],[x+width-.52,y-.48],
    [x+width-.52,y+height-.52],[x-.48,y+height-.52]];
}

function diamondAt(context,p,rx,ry,fillColor,lineColor,width) {
  shape(context,[[p.x,p.y-ry],[p.x+rx,p.y],[p.x,p.y+ry],[p.x-rx,p.y]],fillColor,lineColor,width);
}

function outlines(context,p,type) {
  context.save();
  context.strokeStyle='#c3eca1';
  context.lineWidth=2.2;
  context.shadowBlur=6;
  context.shadowColor='#abe36b7d';
  const {bracket:w,small}=UNIT_ART[type];
  const h=small?8:20, len=small?6:12;
  for (const [x,y] of [[-1,-1],[1,-1],[1,1],[-1,1]]) {
    context.beginPath();
    context.moveTo(p.x+x*(w-len),p.y+y*h);
    context.lineTo(p.x+x*w,p.y+y*h);
    context.lineTo(p.x+x*w,p.y+y*(h-len*.55));
    context.stroke();
  }
  context.shadowBlur=0;
  context.fillStyle='#27392c';
  context.fillRect(p.x-w*.63,p.y+h+3,w*1.26,4);
  context.fillStyle='#afd37f';
  context.fillRect(p.x-w*.63+1,p.y+h+4,w*1.26-2,2);
  context.restore();
}

function tagLabel(context, p, text, tint) {
  context.font='650 11px "Noto Sans CJK SC", sans-serif';
  context.textAlign='center';
  context.textBaseline='middle';
  const span=context.measureText(text).width+14;
  context.fillStyle='#1a281de8';
  context.fillRect(Math.round(p.x-span/2),Math.round(p.y-9),span,18);
  context.strokeStyle=tint;
  context.lineWidth=.8;
  context.strokeRect(Math.round(p.x-span/2)+.5,Math.round(p.y-8.5),span-1,17);
  context.fillStyle=tint;
  context.fillText(text,p.x,p.y);
}

function drawRoute(unit) {
  if (!unit.goal || !unit.route.length) return;
  const target=project(unit.goal.x,unit.goal.y);
  const color=unit.goal.kind==='attack'?'#ef9c76':
    (unit.goal.kind==='mine' || unit.goal.kind==='capture')?'#efd47a':'#c6e6a7';
  ctx.save();
  ctx.beginPath();
  const p=projectGround(unit.x,unit.y);
  ctx.moveTo(p.x,p.y);
  for (const node of unit.route) {
    const next=projectGround(node.x,node.y);
    ctx.lineTo(next.x,next.y);
  }
  ctx.strokeStyle=color+'b0';
  ctx.lineWidth=1.55;
  ctx.setLineDash([4,7]);
  ctx.stroke();
  ctx.setLineDash([]);
  diamondAt(ctx,target,22,11,color+'25',color,1.2);
  ctx.restore();
}

function drawRallyPoint(building) {
  if (!building?.rally) return;
  const {rally}=building;
  const color=rallyTileAvailable(rally)?'#9ddbbd':'#dc8d75';
  const start=project(building.x+(building.width-1)/2,building.y+(building.height-1)/2);
  const end=project(rally.x,rally.y);
  ctx.save();
  ctx.setLineDash([5,6]);
  stroke(ctx,start.x,start.y,end.x,end.y,color+'a0',1.6);
  ctx.setLineDash([]);
  diamondAt(ctx,end,24,12,color+'24',color,1.5);
  stroke(ctx,end.x,end.y,end.x,end.y-26,color,2);
  shape(ctx,[[end.x,end.y-26],[end.x+18,end.y-20],[end.x,end.y-14]],color,'#30453c',1);
  ctx.restore();
}

function visibleRange(padding=0) {
  const right=viewport.w+padding,bottom=viewport.h+padding;
  const corners=[worldAt(-padding,-padding),worldAt(right,-padding),worldAt(right,bottom),worldAt(-padding,bottom)];
  return {
    x1: Math.max(bounds.minX,Math.floor(Math.min(...corners.map(p=>p.x)))-3),
    x2: Math.min(bounds.maxX,Math.ceil(Math.max(...corners.map(p=>p.x)))+3),
    y1: Math.max(bounds.minY,Math.floor(Math.min(...corners.map(p=>p.y)))-3),
    y2: Math.min(bounds.maxY,Math.ceil(Math.max(...corners.map(p=>p.y)))+3),
  };
}

function structureDepthAt(building,screenX) {
  // A ray through this screen column follows x - y = constant on the ground.
  // Its nearer intersection is the first of the two front edges it reaches.
  const diagonal=screenX/U;
  const frontX=building.x+building.width-.5;
  const frontY=building.y+building.height-.5;
  return Math.min(2*frontX-diagonal,2*frontY+diagonal);
}

function structureLayers(building,art,unitLayers,transform) {
  const left=art.left-12,right=art.left+art.width+12;
  const pivot=(building.x+building.width-building.y-building.height)*U;
  const cuts=[left,right];
  for (const unit of unitLayers) {
    if (unit.right<=left || unit.left>=right || unit.top>art.bottom+8 || unit.bottom<art.top) continue;
    // On either face, solve depth(column) = depth(unit) for the ordering change.
    const leftCut=(unit.depth-2*(building.y+building.height-.5))*U;
    const rightCut=(2*(building.x+building.width-.5)-unit.depth)*U;
    for (const cut of [leftCut,rightCut]) {
      if (leftCut>pivot || rightCut<pivot || cut<=left || cut>=right) continue;
      // Align adjacent clips to device pixels so they meet without a seam.
      const screen=Math.round(cut*transform.a+transform.e);
      cuts.push((screen-transform.e)/transform.a);
    }
  }
  cuts.sort((a,b)=>a-b);
  const draw=()=>{
    drawStructure(ctx,building,art);
    if (!building.remaining) drawBuildingDamage(ctx,building);
  };
  const layers=[];
  for (let i=1;i<cuts.length;i++) {
    const start=cuts[i-1],end=cuts[i];
    if (end-start<.0001) continue;
    layers.push({
      depth:structureDepthAt(building,(start+end)/2),
      draw:cuts.length===2?draw:()=>{
        ctx.save();
        ctx.beginPath();
        ctx.rect(start,art.top-110,end-start,art.bottom-art.top+120);
        ctx.clip();
        draw();
        ctx.restore();
      },
    });
  }
  return layers;
}

function drawWorld() {
  const {w,h,dpr}=viewport;
  if (!w||!h) return;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  const center=project(camera.x,camera.y);
  drawGround(center);
  const range=visibleRange();
  ctx.translate(w/2,h/2);
  ctx.scale(viewport.scale,viewport.scale);
  ctx.translate(-center.x,-center.y);
  const selectedBuilding=game.selectedBuilding;
  if (selectedBuilding && !selectedBuilding.remaining) {
    const weapon=BUILDINGS[selectedBuilding.type]?.weapon;
    if (selectedBuilding.type==='yard') drawRange(yardCenter(selectedBuilding),BUILD_RADIUS);
    else if (weapon) drawRange(yardCenter(selectedBuilding),weapon.range,weapon);
  }
  const selectedUnit=game.selected;
  const weapon=WEAPONS[selectedUnit?.type];
  if (weapon) drawRange(selectedUnit,weapon.range,weapon);
  drawMovementDust();
  const perspective=viewFaction();
  const objects=[];
  for (let x=range.x1;x<=range.x2;x++) {
    for (let y=range.y1;y<=range.y2;y++) {
      if (!onMap(x,y)) continue;
      const key=tileKey(x,y);
      const discovery=perspective.explored.get(key);
      if (!discovery) continue;
      const age=game.time-discovery.stamp;
      if (age<.10) continue;
      const fade=smooth(Math.min(1,(age-.10)/.54));
      const kind=terrain(x,y), mineral=amountAt(x,y), seed=hash(x,y,18), p=projectGround(x,y);
      if (mineral) objects.push({depth:x+y+.02,fade,draw:()=>{
        const rich=seam(x,y)?.grade==='rich';
        const width=28+Math.min(1,mineral/110)*29+seed*10+(rich?6:0);
        if (!sprite(ctx,rich?'ore':'poor-ore',p.x+seed*12-6,p.y+4,width,seed>.5)) crystal(ctx,x,y,mineral);
      }});
      else if (kind==='rock' || (kind==='hill' && seed>.91)) {
        objects.push({depth:x+y+.04,fade,draw:()=> {
          if (sprite(ctx,kind==='hill'?'coast-cliff':'coast-stone',p.x,p.y+8,57+seed*19,seed>.5)) return;
          if (sprite(ctx,'stone',p.x,p.y+8,60+seed*19,seed>.5)) return;
          stone(ctx,{x:p.x-14,y:p.y+1},1.07,seed>.54);
          stone(ctx,{x:p.x+8,y:p.y-4},1.19,seed>.64);
          stone(ctx,{x:p.x+18,y:p.y+4},.47,true);
        }});
      } else if (forestAt(x,y,kind)) {
        objects.push({depth:x+y+.13,fade,draw:()=> {
          if (sprite(ctx,seed>.55?'coast-palm':'coast-fan',p.x+seed*10-5,p.y+7,43+seed*29,seed>.5)) return;
          if (sprite(ctx,'forest',p.x+seed*10-5,p.y+7,48+seed*33,seed>.5)) return;
          pine(ctx,{x:p.x-8,y:p.y+1},.67+seed*.23,seed>.8);
          if (seed>.78) pine(ctx,{x:p.x+12,y:p.y+5},.59,seed>.91);
        }});
      } else if (kind==='bank' && seed>.91 && !onStructure(x,y)) {
        objects.push({depth:x+y+.08,fade,draw:()=>sprite(ctx,'coast-fan',p.x,p.y+5,37+seed*12,seed>.95)});
      } else if (!groundTexture && ['field','meadow','bank','scrub'].includes(kind) && seed>.46) {
        if (seed>.93 && kind!=='meadow') objects.push({depth:x+y,fade,draw:()=>stone(ctx,p,.40,true)});
        else {
          ctx.globalAlpha=fade;
          tufts(ctx,{x:p.x+seed*22-11,y:p.y+2},Math.round(seed*1000));
          ctx.globalAlpha=1;
        }
      }
    }
  }
  const visibleStructures=structures.filter(building=>building.x<=range.x2 &&
    building.y<=range.y2 && building.x+building.width>=range.x1 && building.y+building.height>=range.y1 &&
    structureVisible(building));
  const visibleUnits=units.filter(unit=>unit.x>=range.x1 && unit.x<=range.x2 &&
    unit.y>=range.y1 && unit.y<=range.y2 && canSeeEntity(perspective,unit));
  const unitLayers=visibleUnits.map(unit=>{
    const air=isAirborne(unit) && unitElevation(unit)>42;
    const ground=projectGround(unit.x,unit.y);
    const position=project(unit.x,unit.y,unitElevation(unit));
    const art=UNIT_ART[unit.type];
    const vehicle=Boolean(VEHICLE_CONTACT_RADIUS[unit.type]);
    const extent=Math.max(art.hitWidth,art.bracket)+7;
    castShadow(ctx,ground,air?41:vehicle?44:23,air?9:vehicle?11:4,air?.26:.43);
    return {air,depth:unit.x+unit.y+.12,left:position.x-extent,right:position.x+extent,
      top:position.y-art.hitHeight-22,bottom:position.y+(vehicle?34:10),draw:()=>{
        if (game.selection.includes(unit)) outlines(ctx,position,unit.type);
        renderUnit(ctx,unit,position);
        drawUnitStatus(unit);
      }};
  });
  const transform=ctx.getTransform();
  for (const building of visibleStructures) {
    const center=yardCenter(building);
    castShadow(ctx,project(center.x,center.y),building.width*34,building.height*10,.34);
    objects.push(...structureLayers(building,structureArt(building),unitLayers.filter(layer=>!layer.air),transform));
  }
  objects.push(...unitLayers);
  for (const unit of game.selection) if (unit.team===game.perspective) drawRoute(unit);
  drawRallyPoint(game.selectedBuilding);
  objects.sort((a,b)=>Number(Boolean(a.air))-Number(Boolean(b.air)) || a.depth-b.depth);
  for (const item of objects) {
    ctx.globalAlpha=item.fade??1;
    item.draw();
  }
  ctx.globalAlpha=1;
  if (game.selectedBuilding) {
    const border=structureOutline(game.selectedBuilding).map(([x,y])=>project(x,y));
    polygon(ctx,border,null,'#222e20',3.5);
    polygon(ctx,border,null,'#c3eca1',1.8);
  }
  for (const miner of visibleUnits) {
    if (miner.mode!=='mining') continue;
    const point=project(miner.x,miner.y);
    const phase=Math.floor(game.time*27);
    for (let i=0;i<7;i++) {
      const v=hash(i,phase,7), spread=hash(phase,i,2);
      ctx.fillStyle=i%2?'#fbd08a':'#f4a440';
      ctx.fillRect(point.x+4+v*22,point.y-7-spread*21,1+(i%2),1+(i%2));
    }
  }
  drawCombat();
  const targets=new Set(game.selection.map(unit=>unit.attackTarget));
  const captures=new Set(game.selection.filter(unit=>unit.team===game.perspective).map(unit=>unit.captureTarget));
  if (game.hoverTarget) targets.add(game.hoverTarget);
  for (const building of visibleStructures) {
    const spec=buildingSpec(building.type);
    const pending=building.remaining>0;
    const progress=pending?Math.floor((1-building.remaining/spec.time)*100):100;
    const p=buildingLabelPoint(building);
    const capturing=captures.has(building) || (building===game.hoverTarget &&
      game.selection.some(unit=>unit.team===game.perspective && canCapture(unit,building)));
    if (capturing || targets.has(building)) {
      polygon(ctx,structureOutline(building).map(([x,y])=>project(x,y)),null,
        capturing?'#edd184':'#f89d75',2.1);
    }
    if (building.health<spec.health || targets.has(building)) {
      drawHealth({x:p.x,y:p.y+12},building,spec.health,42);
    }
    const hostile=building.team==='enemy';
    const name=buildingCaption(building);
    const label=pending?name+' '+progress+'%':name;
    tagLabel(ctx,p,label,hostile?'#ef987a':pending?'#e7c17d':
      building.team==='neutral'?'#e7c17d':
        (building===game.selectedBuilding || building.type==='oil')?'#c3eca1':'#bdbfa2');
  }
  for (const hill of battlefield.hills) {
    if (visible(hill.x,hill.y)) tagLabel(ctx,projectGround(hill.x,hill.y,15),'山丘','#c7bd98');
  }
  for (const mine of battlefield.seams) {
    if (visible(mine.x,mine.y)) {
      const grade=ORE_GRADES[mine.grade];
      tagLabel(ctx,project(mine.x,mine.y,47),grade.label,grade.color);
    }
  }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  if (selectionDrag?.active) {
    const {left,top,right,bottom}=selectionBounds(selectionDrag);
    ctx.fillStyle='#acd58c28';
    ctx.strokeStyle='#c3eca1';
    ctx.lineWidth=1;
    ctx.fillRect(left,top,right-left,bottom-top);
    ctx.strokeRect(left+.5,top+.5,right-left,bottom-top);
  }
}

function terrainRadar() {
  const {w,h,dpr}=radarViewport;
  if (!w || !h) return;
  radarCtx.setTransform(dpr,0,0,dpr,0,0);
  radarCtx.fillStyle='#121b13';
  radarCtx.fillRect(0,0,w,h);
  radarCtx.lineWidth=.5;
  for (let i=1;i<9;i++) {
    stroke(radarCtx,i*w/9,0,i*w/9,h,'#798d6240',.5);
    stroke(radarCtx,0,i*h/9,w,i*h/9,'#798d6230',.5);
  }
  const width=BOARD.right-BOARD.left,height=BOARD.bottom-BOARD.top;
  const scale=Math.min((w-12)/width,(h-12)/height);
  const left=(w-width*scale)/2,top=(h-height*scale)/2;
  const mapPoint=(x,y)=>{
    const p=project(x,y);
    return {x:left+(p.x-BOARD.left)*scale,y:top+(p.y-BOARD.top)*scale};
  };
  game.radarLayout={left,top,scale};
  radarCtx.save();
  radarCtx.beginPath();
  radarCtx.rect(left,top,width*scale,height*scale);
  radarCtx.clip();
  const perspective=viewFaction();
  const cells=perspective.explored.values();
  const terrainPaths=new Map();
  const rx=U*scale+.1,ry=V*scale+.1;
  for (const tile of cells) {
    const p=mapPoint(tile.x,tile.y);
    const kind=terrain(tile.x,tile.y);
    const color=COLORS[kind];
    if (!terrainPaths.has(color)) terrainPaths.set(color,new Path2D());
    const path=terrainPaths.get(color);
    path.moveTo(p.x,p.y-ry);
    path.lineTo(p.x+rx,p.y);
    path.lineTo(p.x,p.y+ry);
    path.lineTo(p.x-rx,p.y);
    path.closePath();
  }
  for (const [color,path] of terrainPaths) {
    radarCtx.fillStyle=color;
    radarCtx.fill(path);
  }
  for (const item of perspective.explored.values()) {
    const ore=amountAt(item.x,item.y);
    if (!ore) continue;
    radarCtx.fillStyle=ORE_GRADES[seam(item.x,item.y)?.grade??'poor'].color;
    const p=mapPoint(item.x,item.y);
    const size=Math.min(1.6,.65+ore*.002);
    radarCtx.fillRect(p.x-size,p.y-size,size*2,size*2);
  }
  for (const building of structures) {
    if (!structureVisible(building)) continue;
    const color=building===game.selectedBuilding?'#dcfba5':building.team==='neutral'?
      buildingSpec(building.type).color:TEAM_PAINT[building.team].radar;
    polygon(radarCtx,structureOutline(building).map(([x,y])=>mapPoint(x,y)),color,null);
  }
  for (const unit of units) {
    if (!canSeeEntity(perspective,unit)) continue;
    const point=mapPoint(unit.x,unit.y), radius=game.selection.includes(unit)?2.6:1.65;
    radarCtx.fillStyle='#161d14';
    radarCtx.fillRect(point.x-radius-1,point.y-radius-1,radius*2+2,radius*2+2);
    radarCtx.fillStyle=TEAM_PAINT[unit.team].radar;
    radarCtx.fillRect(point.x-radius,point.y-radius,radius*2,radius*2);
  }
  const corners=[worldAt(0,0),worldAt(viewport.w,0),worldAt(viewport.w,viewport.h),worldAt(0,viewport.h)];
  polygon(radarCtx,corners.map(p=>mapPoint(p.x,p.y)),null,'#d0df9ecc',.9);
  radarCtx.restore();
  radarCtx.fillStyle='#b2c49a'; radarCtx.font='8px monospace'; radarCtx.fillText('N',w-12,12);
}

class MinHeap {
  constructor() { this.data=[]; }
  push(item) {
    const data=this.data;
    let index=data.length;
    data.push(item);
    while (index>0) {
      const parent=(index-1)>>1;
      if (data[parent].score<=item.score) break;
      data[index]=data[parent];
      index=parent;
    }
    data[index]=item;
  }
  pop() {
    const data=this.data;
    const first=data[0];
    const last=data.pop();
    if (!data.length) return first;
    let index=0;
    while (index*2+1<data.length) {
      let leaf=index*2+1;
      if (leaf+1<data.length && data[leaf+1].score<data[leaf].score) leaf++;
      if (data[leaf].score>=last.score) break;
      data[index]=data[leaf];
      index=leaf;
    }
    data[index]=last;
    return first;
  }
}

const NEIGHBORS=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
const DETOUR_NODES_PER_TICK=320;
let detourNodesLeft=Infinity;

function findPath(destination,unit,avoidUnits=false,radius=8) {
  if (isAirborne(unit)) {
    if (!onMap(destination.x,destination.y) ||
        (avoidUnits && unitPathBlocked(unit,unit.x,unit.y,destination.x,destination.y))) return null;
    return distanceTo(unit,destination)<.04?[]:[{x:destination.x,y:destination.y}];
  }
  const here={x:Math.round(unit.x),y:Math.round(unit.y)};
  const inside=(x,y)=>Math.abs(x-here.x)<=radius && Math.abs(y-here.y)<=radius;
  if (avoidUnits && (!detourNodesLeft || !inside(destination.x,destination.y))) return null;
  const obstacles=avoidUnits?units.filter(other=>other!==unit && other.health>0 &&
    !isAirborne(other) && !canRunOver(unit,other) &&
    Math.abs(other.x-here.x)<radius+1 && Math.abs(other.y-here.y)<radius+1):null;
  const walkableCache=avoidUnits?new Map():null;
  const open=(x,y)=>{
    if (!walkableCache) return walkable(x,y);
    if (!inside(x,y)) return false;
    const key=tileKey(x,y);
    if (!walkableCache.has(key)) walkableCache.set(key,walkable(x,y));
    return walkableCache.get(key);
  };
  const occupied=(x,y)=>unitPositionBlocked(unit,x,y,true,obstacles);
  const blocked=(x,y,nx,ny)=>blockingUnit(unit,x,y,nx,ny,obstacles);
  if (!open(destination.x,destination.y) || (avoidUnits && occupied(destination.x,destination.y))) return null;
  const queue=new MinHeap();
  const frontier=new Map();
  let starts=[here];
  if (avoidUnits && (!open(here.x,here.y) || occupied(here.x,here.y) || blocked(unit.x,unit.y,here.x,here.y))) {
    starts=NEIGHBORS.filter(([dx,dy])=>!dx || !dy ||
      (open(here.x+dx,here.y) && open(here.x,here.y+dy)))
      .map(([dx,dy])=>({x:here.x+dx,y:here.y+dy}))
      .filter(tile=>open(tile.x,tile.y) && !blocked(unit.x,unit.y,tile.x,tile.y));
  }
  for (const start of starts) {
    const key=tileKey(start.x,start.y);
    const g=avoidUnits?distanceTo(unit,start):0;
    frontier.set(key,{...start,g,previous:null});
    queue.push({key,score:g+distanceTo(start,destination),g});
  }
  const nodeLimit=avoidUnits?(radius<=8?100:170):16000;
  for (let visited=0;queue.data.length && visited<nodeLimit && (!avoidUnits || detourNodesLeft>0);visited++) {
    if (avoidUnits) detourNodesLeft--;
    const current=queue.pop();
    const position=frontier.get(current.key);
    if (position.g!==current.g) continue;
    if (sameTile(position,destination)) {
      const route=[];
      let node=position;
      while (node.previous) {
        route.push({x:node.x,y:node.y});
        node=frontier.get(node.previous);
      }
      if (distanceTo(unit,node)>.04) route.push({x:node.x,y:node.y});
      return route.reverse();
    }
    for (const [dx,dy] of NEIGHBORS) {
      const x=position.x+dx,y=position.y+dy;
      if (!open(x,y) || (dx && dy &&
         (!open(position.x+dx,position.y) || !open(position.x,position.y+dy)))) continue;
      if (avoidUnits && blocked(position.x,position.y,x,y)) continue;
      const nextKey=tileKey(x,y);
      const effort=position.g+(dx&&dy ? Math.SQRT2 : 1)*(terrain(x,y)==='hill'?1.28:1);
      if (frontier.has(nextKey) && frontier.get(nextKey).g<=effort) continue;
      frontier.set(nextKey,{x,y,g:effort,previous:current.key});
      queue.push({key:nextKey,g:effort,score:effort+Math.hypot(destination.x-x,destination.y-y)});
    }
  }
  return null;
}

function findOreRoute(miner,minimum) {
  const faction=FACTIONS[miner.team];
  const depots=structures.filter(building=>refineryReady(building,miner.team)).map(dockFor);
  const threats=[...faction.reports.values()].filter(report=>game.time-report.time<16);
  const claimed=new Set();
  for (const unit of units) {
    if (unit===miner || unit.team!==miner.team || unit.type!=='miner') continue;
    const target=unit.mode==='mining'?unit.mine:unit.goal?.kind==='mine'?unit.goal:unit.returnTo;
    if (target) claimed.add(tileKey(target.x,target.y));
  }
  const candidates=[];
  const space=Math.max(1,CARGO_LIMIT-(miner.cargo??0));
  const consider=(x,y)=>{
    const amount=amountAt(x,y);
    if (amount<minimum || !walkable(x,y)) return;
    const tile={x,y};
    const dockDistance=depots.length?Math.min(...depots.map(dock=>distanceTo(tile,dock))):0;
    const danger=threats.reduce((risk,report)=>risk+Math.max(0,7-distanceTo(tile,report))*.42,0);
    const rate=ORE_GRADES[seam(x,y)?.grade??'poor'].rate;
    const loadingCost=Math.min(amount,space)/rate*miner.speed+Math.max(0,1-amount/space)*10;
    const cost=distanceTo(tile,miner)+dockDistance*.32+danger+loadingCost+(claimed.has(tileKey(x,y))?5:0);
    candidates.push({x,y,cost});
  };
  for (const {x,y} of faction.explored.values()) consider(x,y);
  candidates.sort((a,b)=>a.cost-b.cost);
  for (const target of candidates) {
    const course=findPath(target,miner);
    if (course) return {target,course};
  }
  return null;
}

function setCourse(target,kind,unit,course=findPath(target,unit)) {
  if (!FACTIONS[unit.team].explored.has(tileUnder(target.x,target.y))) return false;
  if (!course) {
    if (unit.team==='player') {
      notice('该位置无法通行',unit.team);
      log('未找到通往目标的路线。',unit.team);
    }
    return false;
  }
  if (kind!=='attack') unit.attackTarget=null;
  if (kind!=='capture') unit.captureTarget=null;
  unit.route=smoothCourse(unit,course);
  unit.goal={x:target.x,y:target.y,kind};
  unit.mode=kind==='dock'?'returning':'moving';
  if (!unit.route.length) arrive(unit);
  return true;
}

function selectUnit(unit) {
  select(unit?[unit]:[]);
}

function select(selection,building=null) {
  const changed=building!==game.selectedBuilding || selection.length!==game.selection.length ||
    selection.some(unit=>!game.selection.includes(unit));
  if (changed && (building || selection.length)) sound.play('select');
  game.selection=selection;
  game.selectedBuilding=building;
  game.hoverTarget=null;
  game.notice='';
  game.follow=game.selected;
  syncHud();
}

function forestDestination(target,unit) {
  const alternatives=[];
  for (let dx=-2;dx<=2;dx++) {
    for (let dy=-2;dy<=2;dy++) {
      const x=target.x+dx,y=target.y+dy;
      if (!walkable(x,y)) continue;
      alternatives.push({x,y,rank:Math.hypot(dx,dy)+Math.hypot(x-unit.x,y-unit.y)*.12});
    }
  }
  alternatives.sort((a,b)=>a.rank-b.rank);
  for (const candidate of alternatives) {
    const course=findPath(candidate,unit);
    if (course) return {target:candidate,course};
  }
  return null;
}

function refineryReady(building,team) {
  return building.type==='refinery' && building.team===team && building.remaining===0;
}

function dockFor(building) {
  return {x:building.x+1,y:building.y-1};
}

function reservedDock(cell) {
  return structures.some(b=>b.type==='refinery' && cell.y===b.y-1 && Math.abs(cell.x-(b.x+1))<=1);
}

function returnToBase(miner,resume=null,reason='矿车正在返回精炼厂。') {
  if (miner?.type!=='miner') return;
  const own=miner.team==='player';
  const depots=structures.filter(building=>refineryReady(building,miner.team)).flatMap(building=>{
    const main=dockFor(building);
    return [0,-1,1].map(offset=>{
      const dock={x:main.x+offset,y:main.y};
      const busy=unitPositionBlocked(miner,dock.x,dock.y,true) ||
        units.some(unit=>unit!==miner && unit.goal?.kind==='dock' && sameTile(unit.goal,dock));
      return {building,dock,rank:distanceTo(dock,miner)+Math.abs(offset)*.7+(busy?1000:0)};
    });
  }).sort((a,b)=>a.rank-b.rank);
  for (const {building,dock} of depots) {
    const course=findPath(dock,miner);
    if (!course) continue;
    miner.refinery=building;
    miner.returnTo=resume;
    setCourse(dock,'dock',miner,course);
    if (own) log(reason,miner.team);
    return true;
  }
  miner.refinery=null;
  miner.returnTo=null;
  miner.goal=null;
  miner.route=[];
  miner.mode='idle';
  return false;
}

function dispatchMiner(miner) {
  miner.nextMineSearch=game.time+1.6;
  if (miner.cargo>=CARGO_LIMIT-.001) {
    returnToBase(miner);
    return;
  }
  const order=findOreRoute(miner,12) || findOreRoute(miner,1);
  if (order) {
    setCourse(order.target,'mine',miner,order.course);
  } else if (miner.cargo>0) {
    returnToBase(miner);
  }
}

function arrive(unit) {
  const goal=unit.goal;
  if (!goal) return;
  if (goal.kind==='capture') {
    unit.mode='idle';
    const field=unit.captureTarget;
    unit.captureTarget=null;
    if (field && canCapture(unit,field)) {
      const index=units.indexOf(unit);
      if (index>=0) units.splice(index,1);
      unit.health=0;
      if (game.selection.includes(unit)) select(game.selection.filter(member=>member!==unit));
      captureBuilding(field,unit.team);
    }
  } else if (goal.kind==='mine' && amountAt(goal.x,goal.y)>0) {
    unit.mode='mining';
    unit.mine={x:goal.x,y:goal.y};
    if (unit.team==='player') log('矿车开始开采。',unit.team);
  } else if (goal.kind==='dock' && unit.cargo>0 && structures.includes(unit.refinery)) {
    unit.mode='unloading';
    unit.unloadTimer=.70;
  } else {
    unit.mode='idle';
    if (goal.kind==='move' && unit.team==='player') log(unit.label+'已抵达目的地。',unit.team);
  }
  unit.goal=null;
}

function harvest(miner,dt) {
  const cell=miner.mine;
  const remaining=amountAt(cell.x,cell.y);
  const rate=ORE_GRADES[seam(cell.x,cell.y)?.grade??'poor'].rate;
  const load=Math.min(remaining,dt*rate,CARGO_LIMIT-miner.cargo);
  miner.cargo+=load;
  const left=remaining-load;
  if (load>0) {
    takeOre(cell,left);
    if (miner.team==='player' || visible(miner.x,miner.y)) playAt('mining',miner);
  }
  if (miner.cargo>=CARGO_LIMIT-.001 || left<=.001) {
    const depleted=left<=.001;
    returnToBase(miner,depleted?null:cell,depleted?'矿脉已采尽，矿车返厂。':'矿仓已满，矿车返厂。');
  }
}

function advanceMiner(miner,dt) {
  if (miner.health<=0) return;
  if ((miner.mode==='returning' || miner.mode==='unloading') && !structures.includes(miner.refinery)) {
    returnToBase(miner,miner.returnTo);
    return;
  }
  if (miner.mode==='mining') {
    recordTravel(miner,0,dt);
    harvest(miner,dt);
    return;
  }
  if (miner.mode==='unloading') {
    recordTravel(miner,0,dt);
    miner.unloadTimer-=dt*FACTIONS[miner.team].power.rate;
    if (miner.unloadTimer>0) return;
    const hauled=Math.round(Math.round(miner.cargo)*5*incomeMultiplier(miner.team,'ore'));
    treasury(miner.team).credits+=hauled;
    miner.cargo=0;
    miner.mode='idle';
    if (visible(miner.x,miner.y)) playAt('cash',miner);
    if (miner.team==='player') {
      log('精炼入库 +' + hauled + ' 储备。',miner.team);
    }
    const next=miner.returnTo;
    miner.returnTo=null;
    const course=next && amountAt(next.x,next.y)>0 && findPath(next,miner);
    if (course) {
      setCourse(next,'mine',miner,course);
      if (miner.team==='player') log('矿车已再次前往矿脉。',miner.team);
    } else if (miner.autoMine) {
      dispatchMiner(miner);
    }
    return;
  }
  navigate(miner,dt);
  if (miner.mode==='idle' && miner.autoMine && !miner.attackTarget &&
      game.time>=miner.nextMineSearch) dispatchMiner(miner);
}

function canRunOver(vehicle,target) {
  return vehicle.team!==target.team && Boolean(VEHICLE_CONTACT_RADIUS[vehicle.type]) &&
    (isPersonnel(target) || target.type==='dog');
}

function segmentDistanceSquared(x,y,dx,dy) {
  const travelSquared=dx*dx+dy*dy;
  const along=travelSquared?Math.max(0,Math.min(1,(x*dx+y*dy)/travelSquared)):0;
  return (x-dx*along)**2+(y-dy*along)**2;
}

function unitPositionBlocked(unit,x,y,allowRunOver=false,candidates=units) {
  return candidates.some(other=>other!==unit && !(other.health<=0) && collisionLayerMatches(unit,other) &&
    !(allowRunOver && canRunOver(unit,other)) &&
    Math.hypot(x-other.x,y-other.y)<UNIT_RADIUS[unit.type]+UNIT_RADIUS[other.type]);
}

function unitPathBlocked(unit,fromX,fromY,toX,toY) {
  return Boolean(blockingUnit(unit,fromX,fromY,toX,toY));
}

function blockingUnit(unit,fromX,fromY,toX,toY,candidates=units) {
  const dx=toX-fromX, dy=toY-fromY;
  if (!dx && !dy) return null;
  for (const other of candidates) {
    if (other===unit || other.health<=0 || !collisionLayerMatches(unit,other) || canRunOver(unit,other)) continue;
    const x=other.x-fromX, y=other.y-fromY;
    const radius=UNIT_RADIUS[unit.type]+UNIT_RADIUS[other.type];
    // Let units separate if an existing overlap would otherwise trap them.
    if (x*x+y*y<radius*radius && x*dx+y*dy<=0) continue;
    if (segmentDistanceSquared(x,y,dx,dy)<radius*radius) return other;
  }
  return null;
}

function clearMinerLane(miner,blocker,node) {
  if (miner.type!=='miner' || blocker.team!==miner.team || !VEHICLE_CONTACT_RADIUS[blocker.type] ||
      !isArmyType(blocker.type) || blocker.engaged || blocker.attackTarget || blocker.rescueTarget ||
      (blocker.goal && !['stage','retreat'].includes(blocker.goal.kind))) return false;
  const heading=Math.atan2(node.y-miner.y,node.x-miner.x);
  const dx=Math.cos(heading),dy=Math.sin(heading);
  const clearance=UNIT_RADIUS.miner+UNIT_RADIUS[blocker.type]+.3;
  const faction=FACTIONS[miner.team];
  const tiles=[];
  for (let x=Math.round(blocker.x)-2;x<=Math.round(blocker.x)+2;x++) {
    for (let y=Math.round(blocker.y)-2;y<=Math.round(blocker.y)+2;y++) {
      const tile={x,y};
      if (Math.abs((x-miner.x)*dy-(y-miner.y)*dx)<clearance || !walkable(x,y) ||
          !faction.explored.has(tileKey(x,y)) || reservedDock(tile) || amountAt(x,y)>0 ||
          unitPositionBlocked(blocker,x,y) || units.some(other=>other.goal && sameTile(other.goal,tile))) continue;
      tiles.push(tile);
    }
  }
  tiles.sort((a,b)=>distanceTo(a,blocker)-distanceTo(b,blocker));
  for (const tile of tiles) {
    const course=findPath(tile,blocker,true);
    if (!course?.length || !setCourse(tile,'yield',blocker,course)) continue;
    log(factionName(miner.team)+blocker.label+'为采矿车让道。',miner.team);
    return true;
  }
  return false;
}

function runOverInfantry(vehicle,fromX,fromY,radius) {
  const dx=vehicle.x-fromX, dy=vehicle.y-fromY;
  if (!dx && !dy) return;
  for (const unit of units) {
    if (unit.health<=0 || !canRunOver(vehicle,unit)) continue;
    const contact=Math.max(radius,UNIT_RADIUS[vehicle.type]+UNIT_RADIUS[unit.type]);
    if (segmentDistanceSquared(unit.x-fromX,unit.y-fromY,dx,dy)>contact*contact) continue;
    unit.health=0;
    unit.runOver=true;
    promoteAfterKill(vehicle);
    recordRaid(vehicle,unit);
  }
}

function isAirborne(unit) {
  return AIRCRAFT_TYPES.has(unit.type);
}

function collisionLayerMatches(unit,other) {
  const air=isAirborne(unit);
  return air===isAirborne(other) && (!air || Math.abs((unit.altitude??0)-(other.altitude??0))<24);
}

function unitElevation(unit) {
  return isAirborne(unit)?(unit.altitude??JET_ALTITUDE):heightAt(unit.x,unit.y);
}

function airfieldReady(airport,team) {
  return airport?.type==='airport' && airport.team===team && airport.health>0 &&
    airport.remaining===0 && structures.includes(airport);
}

function airfieldParking(airport,unit) {
  const center=yardCenter(airport);
  const grounded={type:unit.type,altitude:0};
  for (const [dx,dy] of [[-1.05,.77],[1.05,.77],[-1.05,-.77],[1.05,-.77]]) {
    const point={x:center.x+dx,y:center.y+dy};
    if (!onMap(point.x,point.y)) continue;
    const taken=units.some(other=>other!==unit && other.health>0 && (
      other.goal?.kind==='land' && sameTile(other.goal,point) ||
      collisionLayerMatches(grounded,other) && distanceTo(other,point)<UNIT_RADIUS[unit.type]+UNIT_RADIUS[other.type]));
    if (!taken) return point;
  }
  return null;
}

function setFlightCourse(unit,{x,y},kind) {
  unit.route=distanceTo(unit,{x,y})<.02?[]:[{x,y}];
  unit.goal={x,y,kind};
  unit.orbit=null;
}

function returnBomber(unit) {
  unit.attackTarget=null;
  unit.engaged=false;
  unit.route=[];
  unit.goal=null;
  unit.mode='returning';
  unit.nextLandingCheck=0;
}

function findBomberLanding(unit) {
  if (game.time<(unit.nextLandingCheck??0)) return;
  unit.nextLandingCheck=game.time+.6;
  const bases=structures.filter(base=>airfieldReady(base,unit.team))
    .sort((a,b)=>Number(b===unit.airbase)-Number(a===unit.airbase) ||
      distanceTo(unit,yardCenter(a))-distanceTo(unit,yardCenter(b)));
  for (const base of bases) {
    const parking=airfieldParking(base,unit);
    if (!parking) continue;
    unit.airbase=base;
    setFlightCourse(unit,parking,'land');
    break;
  }
}

function canTransport(carrier,unit) {
  return carrier.team===unit.team && unit.health>0 &&
    (unit.type==='dog' || isPersonnel(unit) && unit.type!=='mountedCavalry');
}

function boardTransport(carrier,unit) {
  const index=units.indexOf(unit);
  if (index<0 || carrier.type!=='helicopter' || carrier.health<=0 ||
      !canTransport(carrier,unit) || distanceTo(carrier,unit)>2.4 ||
      (carrier.altitude??0)>2 || carrier.passengers.length>=HELICOPTER_CAPACITY) return false;
  clearAttackOrder(unit);
  unit.captureTarget=null;
  unit.rescueTarget=null;
  unit.mountTarget=null;
  unit.velocity=0;
  unit.embarked=true;
  units.splice(index,1);
  carrier.passengers.push(unit);
  if (game.selection.includes(unit)) select(game.selection.filter(member=>member!==unit));
  return true;
}

function unloadTransport(carrier) {
  if (game.time<(carrier.nextUnload??0)) return;
  carrier.nextUnload=game.time+.24;
  const x=Math.round(carrier.x),y=Math.round(carrier.y);
  const explored=FACTIONS[carrier.team].explored;
  const spaces=[];
  for (let dx=-2;dx<=2;dx++) {
    for (let dy=-2;dy<=2;dy++) {
      const position={x:x+dx,y:y+dy};
      if (explored.has(tileKey(position.x,position.y)) && walkable(position.x,position.y)) spaces.push(position);
    }
  }
  spaces.sort((a,b)=>distanceTo(carrier,a)-distanceTo(carrier,b));
  let count=0;
  while (carrier.passengers.length) {
    const passenger=carrier.passengers[0];
    const site=spaces.findIndex(point=>!unitPositionBlocked(passenger,point.x,point.y));
    if (site<0) break;
    const [position]=spaces.splice(site,1);
    Object.assign(passenger,position);
    delete passenger.embarked;
    units.push(carrier.passengers.shift());
    count++;
  }
  if (count) log(factionName(carrier.team)+'运输直升机已卸载 '+count+' 个单位。',carrier.team);
}

function navigateAircraft(unit,dt) {
  if (unit.type==='bomber') {
    const hasBase=airfieldReady(unit.airbase,unit.team);
    if (unit.mode==='parked') {
      if (hasBase) return;
      returnBomber(unit);
    }
    if (unit.mode==='returning') {
      if (unit.goal?.kind==='land' && !hasBase) returnBomber(unit);
      if (!unit.goal) findBomberLanding(unit);
    }
  }
  const helicopter=unit.type==='helicopter';
  const landing=unit.goal?.kind==='land' || helicopter &&
    (!unit.goal || unit.goal.kind==='pickup' || unit.goal.kind==='drop');
  const ceiling=helicopter?62:JET_ALTITUDE;
  const target=unit.route[0];
  const altitude=unit.altitude??ceiling;
  const desired=landing?Math.min(ceiling,target?distanceTo(unit,target)*20:0):ceiling;
  unit.altitude=Math.max(altitude-dt*110,Math.min(desired,altitude+dt*115));
  if (!target) {
    if (landing) {
      if (unit.altitude>0) return;
      if (unit.type==='bomber') {
        unit.mode='parked';
        unit.readyForSortie=game.time+3;
        log(factionName(unit.team)+'轰炸机已返回机场。',unit.team);
      } else if (unit.goal?.kind==='drop' || unit.passengers.length) {
        unloadTransport(unit);
        if (unit.passengers.length) return;
        unit.mode='idle';
      } else unit.mode='idle';
      unit.goal=null;
      return;
    }
    if (unit.goal?.kind==='bomb') return;
    if (unit.goal) arrive(unit);
    const angle=unit.heading-Math.PI/2;
    const radius=1.45;
    unit.orbit??={x:unit.x-Math.cos(angle)*radius,y:unit.y-Math.sin(angle)*radius,angle};
    const orbit=unit.orbit;
    orbit.angle+=dt*1.95;
    const x=orbit.x+Math.cos(orbit.angle)*radius,y=orbit.y+Math.sin(orbit.angle)*radius;
    if (!onMap(x,y) || unitPositionBlocked(unit,x,y)) return;
    turnTowards(unit,orbit.angle+Math.PI/2,3.8,dt);
    unit.x=x;
    unit.y=y;
    return;
  }
  unit.orbit=null;
  const distance=distanceTo(unit,target);
  const heading=Math.atan2(target.y-unit.y,target.x-unit.x);
  const {gap}=turnTowards(unit,heading,4.8,dt);
  const step=Math.min(distance,dt*unit.speed*(.57+.43*Math.max(0,Math.cos(gap))));
  let x=unit.x+Math.cos(heading)*step,y=unit.y+Math.sin(heading)*step;
  if (unitPathBlocked(unit,unit.x,unit.y,x,y)) {
    x=unit.x-Math.sin(heading)*step;
    y=unit.y+Math.cos(heading)*step;
    if (!onMap(x,y) || unitPathBlocked(unit,unit.x,unit.y,x,y)) return;
  } else if (step>=distance) {
    unit.route.shift();
  }
  unit.x=x;
  unit.y=y;
  if (!unit.route.length && unit.goal && !landing && unit.goal.kind!=='bomb') arrive(unit);
}

function motionFor(unit) {
  if (['dog','horse','mountedCavalry'].includes(unit.type)) return DOG_MOTION;
  if (unit.type==='mcv' || unit.type==='miner') return HEAVY_MOTION;
  return VEHICLE_CONTACT_RADIUS[unit.type]?TRACKED_MOTION:FOOT_MOTION;
}

function angleDifference(target,current) {
  return Math.atan2(Math.sin(target-current),Math.cos(target-current));
}

function advanceTurret(unit,dt) {
  if (unit.type!=='tank') return;
  let target=unit.turretAim??unit.heading;
  if (unit.turretAim===undefined && !unit.route.length && !reducedMotion.matches) {
    const time=(game.time+(unit.id??0)*.67)%8.8;
    const scan=time<1.2?mix(0,-1.45,smooth(time/1.2)):
      time<2.6?-1.45:time<4.8?mix(-1.45,1.70,smooth((time-2.6)/2.2)):
        time<6.2?1.70:time<7.6?mix(1.70,0,smooth((time-6.2)/1.4)):0;
    target+=scan;
  }
  const current=unit.turretHeading??unit.heading;
  const angle=angleDifference(target,current);
  unit.turretHeading=current+Math.sign(angle)*Math.min(Math.abs(angle),2.85*dt);
}

function turnTowards(unit,heading,turnRate,dt) {
  const gap=angleDifference(heading,unit.heading);
  const turn=Math.min(turnRate*dt,Math.abs(gap))*Math.sign(gap);
  unit.heading+=turn;
  return {gap:gap-turn,turn};
}

function groundPathOpen(fromX,fromY,toX,toY) {
  const dx=toX-fromX,dy=toY-fromY;
  const samples=Math.max(1,Math.ceil(Math.hypot(dx,dy)/.18));
  let prevX=Math.round(fromX),prevY=Math.round(fromY);
  for (let i=1;i<=samples;i++) {
    const x=Math.round(fromX+dx*i/samples),y=Math.round(fromY+dy*i/samples);
    if (!walkable(x,y) || (x!==prevX && y!==prevY && (!walkable(x,prevY) || !walkable(prevX,y)))) {
      return false;
    }
    prevX=x;
    prevY=y;
  }
  return true;
}

function smoothCourse(unit,route,avoidUnits=false) {
  if (route.length<2) return route;
  const path=[];
  const rounding=VEHICLE_CONTACT_RADIUS[unit.type] ? .45 : .32;
  let previous=unit;
  for (let i=0;i<route.length-1;i++) {
    const corner=route[i],next=route[i+1];
    const first=distanceTo(previous,corner),second=distanceTo(corner,next);
    const trim=Math.min(first,second)*rounding;
    if (trim<.12) {
      path.push(corner);
      previous=corner;
      continue;
    }
    const ux=(corner.x-previous.x)/first,uy=(corner.y-previous.y)/first;
    const vx=(next.x-corner.x)/second,vy=(next.y-corner.y)/second;
    const cosine=ux*vx+uy*vy;
    if (cosine>.985 || cosine<-.75) {
      path.push(corner);
      previous=corner;
      continue;
    }
    const a={x:corner.x-ux*trim,y:corner.y-uy*trim};
    const b={x:corner.x+vx*trim,y:corner.y+vy*trim};
    const arc=[a];
    for (const t of [.25,.5,.75,1]) {
      arc.push({
        x:mix(mix(a.x,corner.x,t),mix(corner.x,b.x,t),t),
        y:mix(mix(a.y,corner.y,t),mix(corner.y,b.y,t),t),
      });
    }
    const open=arc.every((point,index)=>{
      if (index===0) return true;
      const start=arc[index-1];
      return groundPathOpen(start.x,start.y,point.x,point.y) &&
        (!avoidUnits || !unitPathBlocked(unit,start.x,start.y,point.x,point.y));
    });
    if (open) path.push(...arc);
    else path.push(corner);
    previous=corner;
  }
  path.push(route[route.length-1]);
  return path;
}

function localDetour(unit) {
  const radius=(unit.detourFailures??0)>=2?12:7;
  const anchors=new Map();
  let previous=unit, distance=0;
  for (const [index,point] of unit.route.entries()) {
    distance+=distanceTo(previous,point);
    if (distance>radius) break;
    previous=point;
    if (distance<1.5) continue;
    const tile={x:Math.round(point.x),y:Math.round(point.y)};
    const key=tileKey(tile.x,tile.y);
    if (!walkable(tile.x,tile.y) || unitPositionBlocked(unit,tile.x,tile.y,true) ||
        !groundPathOpen(tile.x,tile.y,point.x,point.y) ||
        unitPathBlocked(unit,tile.x,tile.y,point.x,point.y)) continue;
    anchors.set(key,{tile,index});
  }
  // Rejoin the existing route beyond the blockage and retain the original destination.
  const exits=[...anchors.values()].reverse();
  const candidates=exits.length>1?[exits[0],exits[Math.floor(exits.length/2)]]:exits;
  for (const {tile,index} of candidates) {
    if (!detourNodesLeft) break;
    const path=findPath(tile,unit,true,radius);
    if (!path?.length) continue;
    const resume=index+Number(sameTile(tile,unit.route[index]));
    return [...smoothCourse(unit,path,true),...unit.route.slice(resume)];
  }
  return null;
}

function recordTravel(unit,distance,dt,turn=0) {
  const previousTravel=unit.travel??0;
  unit.travel=previousTravel+distance;
  const movement=distance>0 ? Math.min(1,distance/(dt*unit.speed)) : 0;
  const blend=1-Math.exp(-dt*14);
  unit.stride=mix(unit.stride??0,movement,blend);
  if (unit.type==='dog' && distance>0) {
    const length=mix(.64,1.34,dogRunMix(unit.stride));
    unit.gaitCycles=(unit.gaitCycles??previousTravel/1.34)+distance/length;
  }
  const lean=dt ? Math.max(-.046,Math.min(.046,turn/dt*.013))*movement : 0;
  unit.lean=mix(unit.lean??0,lean,blend);
  if (reducedMotion.matches || distance<=0 || !VEHICLE_CONTACT_RADIUS[unit.type] ||
      unit.travel<(unit.nextDust??.26)) return;
  unit.nextDust=unit.travel+.36;
  const surface=terrain(Math.round(unit.x),Math.round(unit.y));
  if (surface==='concrete' || surface==='bank') return;
  const vx=Math.cos(unit.heading),vy=Math.sin(unit.heading);
  const drift=hash(Math.round(unit.travel*20),unit.id??0,40)-.5;
  const rear=unit.type==='mcv' ? .78 : .58;
  const opacity=(surface==='dirt' || surface==='road' ? .34 : .21)*movement;
  movementDust.push({x:unit.x-vx*rear+vy*drift*.42,y:unit.y-vy*rear-vx*drift*.42,
    dx:-vx*.48+vy*drift,dy:-vy*.48-vx*drift,time:game.time,
    radius:3+Math.abs(drift)*4,opacity});
  while (movementDust.length>175 || game.time-movementDust[0].time>.66) movementDust.shift();
}

function navigate(unit,dt) {
  if (unit.health<=0 || dt<=0) return;
  if (isAirborne(unit)) {
    navigateAircraft(unit,dt);
    return;
  }
  if (unit.captureTarget && !canCapture(unit,unit.captureTarget)) {
    stopCapture(unit);
  }
  const radius=VEHICLE_CONTACT_RADIUS[unit.type];
  const motion=motionFor(unit);
  let target=unit.route[0];
  while (target && distanceTo(unit,target)<.00001) {
    unit.route.shift();
    target=unit.route[0];
  }
  if (!target) {
    unit.velocity=0;
    recordTravel(unit,0,dt);
    if (unit.goal) arrive(unit);
    return;
  }

  const heading=Math.atan2(target.y-unit.y,target.x-unit.x);
  const {gap,turn}=turnTowards(unit,heading,motion.turnRate,dt);
  const angle=Math.abs(gap);
  const dog=unit.type==='dog';
  const steering=radius || dog ? Math.max(0,Math.cos(angle))**(dog?2:3) : 1;
  // Only the last few path points can affect the stopping distance at normal speeds.
  let stoppingDistance=Infinity;
  if (unit.route.length<=7) {
    stoppingDistance=distanceTo(unit,target);
    for (let i=1;i<unit.route.length;i++) stoppingDistance+=distanceTo(unit.route[i-1],unit.route[i]);
  }
  const brakeSpeed=Math.sqrt(2*motion.braking*stoppingDistance);
  const currentElevation=heightAt(unit.x,unit.y);
  const rise=currentElevation?Math.max(0,heightAt(target.x,target.y)-currentElevation):0;
  const grade=currentElevation?Math.max(.62,.96-rise*.027):1;
  const targetSpeed=Math.min(unit.speed*steering*grade,brakeSpeed);
  const oldSpeed=unit.velocity??0;
  unit.velocity=Math.max(oldSpeed-motion.braking*dt,Math.min(targetSpeed,oldSpeed+motion.acceleration*dt));
  // Pivot in place through very tight turns to avoid a sideways slide.
  const pivot=(radius || dog) && angle>1.11;
  if (dog && pivot) unit.velocity=0;
  let remaining=pivot?0:dt*unit.velocity;
  let traveled=0;
  while (unit.route.length && remaining>0) {
    const node=unit.route[0];
    const fromX=unit.x,fromY=unit.y;
    const dx=node.x-fromX,dy=node.y-fromY;
    const distance=Math.hypot(dx,dy);
    const step=distance>remaining?remaining/distance:1;
    const nextX=fromX+dx*step,nextY=fromY+dy*step;
    if (!groundPathOpen(fromX,fromY,nextX,nextY)) {
      const goal=unit.goal;
      const path=goal && findPath(goal,unit);
      unit.route=path?smoothCourse(unit,path):[];
      unit.velocity=0;
      if (!path) {
        unit.goal=null;
        unit.mode='idle';
        if (unit.team==='player') log(unit.label+'的路线被阻挡。',unit.team);
      }
      break;
    }
    const blocker=blockingUnit(unit,fromX,fromY,nextX,nextY);
    if (blocker) {
      unit.velocity=0;
      if (unit.goal && detourNodesLeft && game.time>=(unit.nextDetour??0)) {
        const stagger=((unit.id??0)%7)*.045;
        unit.nextDetour=game.time+.48+stagger;
        if (!clearMinerLane(unit,blocker,node) && !(unit.type==='miner' && blocker.team===unit.team && blocker.goal?.kind==='yield')) {
          const detour=localDetour(unit);
          if (detour) {
            unit.route=detour;
            unit.detourFailures=0;
          } else if (detourNodesLeft) {
            unit.detourFailures=Math.min(5,(unit.detourFailures??0)+1);
            unit.nextDetour+=unit.detourFailures*.24;
          }
        }
      }
      break;
    }
    unit.x=nextX;
    unit.y=nextY;
    const displacement=Math.min(distance,remaining);
    traveled+=displacement;
    remaining-=displacement;
    if (step===1) unit.route.shift();
    if (radius) runOverInfantry(unit,fromX,fromY,radius);
  }
  if (traveled>0) unit.detourFailures=0;
  recordTravel(unit,traveled,dt,turn);
  if (!unit.route.length) {
    unit.velocity=0;
    if (unit.goal) arrive(unit);
  }
}

function footprint(building) {
  const tiles=[];
  for (let y=building.y;y<building.y+building.height;y++) {
    for (let x=building.x;x<building.x+building.width;x++) tiles.push({x,y});
  }
  return tiles;
}

function occupied(x,y,except=null) {
  return units.some(unit=>unit!==except && !isAirborne(unit) && Math.round(unit.x)===x && Math.round(unit.y)===y);
}

function perimeterTiles(building) {
  const {x,y,width,height}=building;
  const cells=[];
  for (let i=0;i<width;i++) {
    cells.push({x:x+i,y:y+height},{x:x+i,y:y-1});
  }
  for (let i=0;i<height;i++) {
    cells.push({x:x+width,y:y+i},{x:x-1,y:y+i});
  }
  return cells;
}

function spawnPoint(building,requireEmpty=true,unit=null) {
  const {x,y,width,height}=building;
  const cells=perimeterTiles(building);
  const exit={x:x+(width-1)*.52,y:y+height};
  cells.sort((a,b)=>Math.hypot(a.x-exit.x,a.y-exit.y)-Math.hypot(b.x-exit.x,b.y-exit.y));
  return cells.find(cell=>walkable(cell.x,cell.y) && !reservedDock(cell) &&
    (building.type!=='refinery' || !sameTile(cell,dockFor(building))) &&
    (!requireEmpty || (unit?!unitPositionBlocked(unit,cell.x,cell.y):!occupied(cell.x,cell.y)))) || null;
}

function placementBounds(building) {
  const {x,y,width,height}=building;
  const box={left:x-.5,top:y-.5,right:x+width-.5,bottom:y+height-.5};
  if (building.type!=='refinery') return box;
  return {
    left:Math.min(box.left,x+REFINERY_PAD.x),
    top:Math.min(box.top,dockFor(building).y-.5),
    right:Math.max(box.right,x+REFINERY_PAD.x+REFINERY_PAD.width),
    bottom:Math.max(box.bottom,y+REFINERY_PAD.y+REFINERY_PAD.height),
  };
}

function rectanglesOverlap(a,b) {
  return a.left<b.right && a.right>b.left && a.top<b.bottom && a.bottom>b.top;
}

function readyYard(building,team) {
  return building.type==='yard' && building.team===team && building.remaining===0 && building.health>0;
}

function yardCenter(yard) {
  return {x:yard.x+(yard.width-1)/2,y:yard.y+(yard.height-1)/2};
}

function withinYard(box,yard) {
  const {x,y}=yardCenter(yard);
  const dx=Math.max(Math.abs(box.left-x),Math.abs(box.right-x));
  const dy=Math.max(Math.abs(box.top-y),Math.abs(box.bottom-y));
  return dx*dx+dy*dy<=BUILD_RADIUS**2;
}

function withinBuildRange(box,team) {
  return structures.some(yard=>readyYard(yard,team) && withinYard(box,yard));
}

function wallPreservesAccess(wall) {
  const facilities=structures.filter(building=>building.team===wall.team &&
    ['refinery','factory','barracks'].includes(building.type) && distanceTo(yardCenter(building),wall)<12);
  if (!facilities.length) return true;
  const exits=facilities.map(building=>{
    const options=perimeterTiles(building).filter(tile=>walkable(tile.x,tile.y));
    return building.type==='refinery'?[dockFor(building),...options].filter(tile=>walkable(tile.x,tile.y)):options;
  }).filter(options=>options.length);
  if (!exits.length) return true;
  const road=nearestMapSite(wall,tile=>distanceTo(tile,wall)>=5 && walkable(tile.x,tile.y) &&
    battlefield.roads.has(tileKey(tile.x,tile.y)));
  if (!road) return exits.every(options=>options.some(tile=>!sameTile(tile,wall)));

  const connected=(obstacle)=>{
    const reached=new Set([tileKey(road.x,road.y)]);
    const queue=[road];
    for (let i=0;i<queue.length;i++) {
      const tile=queue[i];
      for (const [dx,dy] of NEIGHBORS.slice(0,4)) {
        const x=tile.x+dx,y=tile.y+dy,key=tileKey(x,y);
        if (reached.has(key) || (obstacle && x===obstacle.x && y===obstacle.y) || !walkable(x,y)) continue;
        reached.add(key);
        queue.push({x,y});
      }
    }
    return reached;
  };
  const after=connected(wall);
  const reaches=(options,map)=>options.some(tile=>map.has(tileKey(tile.x,tile.y)));
  if (exits.every(options=>reaches(options,after))) return true;
  const before=connected(null);
  return exits.every(options=>!reaches(options,before) || reaches(options,after));
}

function canPlace(building,except=null) {
  const box=placementBounds(building);
  if (building.type!=='yard' && !withinBuildRange(box,building.team)) return false;
  if (structures.some(other=>rectanglesOverlap(box,placementBounds(other)))) return false;
  if (units.some(unit=>{
    if (unit===except || unit.health<=0 || isAirborne(unit)) return false;
    const x=Math.max(box.left,Math.min(box.right,unit.x));
    const y=Math.max(box.top,Math.min(box.bottom,unit.y));
    return Math.hypot(x-unit.x,y-unit.y)<UNIT_RADIUS[unit.type];
  })) return false;
  for (let x=Math.floor(box.left+.5);x<Math.ceil(box.right+.5);x++) {
    for (let y=Math.floor(box.top+.5);y<Math.ceil(box.bottom+.5);y++) {
      if (!FACTIONS[building.team].explored.has(tileKey(x,y)) || !walkable(x,y) ||
          terrain(x,y)==='bridge' || amountAt(x,y)>0) return false;
    }
  }
  if (building.type==='wall') {
    return !reservedDock(building) && !battlefield.roads.has(tileKey(building.x,building.y)) &&
      wallPreservesAccess(building);
  }
  return Boolean(BUILDINGS[building.type]?.weapon || BUILDINGS[building.type]?.powerOutput || BUILDINGS[building.type]?.fireRateBonus ||
    BUILDINGS[building.type]?.damageBonus || spawnPoint(building,false));
}

function treasury(team) {
  return FACTIONS[team];
}

function stopCapture(engineer) {
  engineer.captureTarget=null;
  engineer.goal=null;
  engineer.route=[];
  engineer.mode='idle';
}

function captureAvailable(faction,building) {
  if (!building || building.health<=0 || building.team===faction.team || !structures.includes(building)) return false;
  if (building.team==='neutral') return building.type==='oil' && canSeeEntity(faction,building);
  return canSeeEntity(faction,building);
}

function canCapture(engineer,building) {
  return engineer.type==='engineer' && captureAvailable(FACTIONS[engineer.team],building);
}

function orderCapture(engineer,building) {
  if (!canCapture(engineer,building)) return false;
  const explored=FACTIONS[engineer.team].explored;
  const cells=perimeterTiles(building);
  cells.sort((a,b)=>distanceTo(a,engineer)-distanceTo(b,engineer));
  for (const cell of cells) {
    if (!explored.has(tileKey(cell.x,cell.y)) || !walkable(cell.x,cell.y) ||
        unitPositionBlocked(engineer,cell.x,cell.y)) continue;
    const path=findPath(cell,engineer);
    if (!path) continue;
    engineer.captureTarget=building;
    return setCourse(cell,'capture',engineer,path);
  }
  return false;
}

function captureBuilding(building,team) {
  const previous=building.team;
  building.team=team;
  building.repair=null;
  building.queue.length=0;
  building.nextShot=0;
  const firstOil=building.type==='oil' && previous==='neutral' && !building.firstCapturePaid;
  if (building.type==='oil') building.nextPayout=game.time+OIL_INTERVAL;
  if (firstOil) {
    building.firstCapturePaid=true;
    FACTIONS[team].credits+=OIL_CAPTURE_BONUS;
  }
  const center=yardCenter(building);
  reveal(FACTIONS[team],center.x,center.y,building.remaining?2.6:5);
  if (FACTIONS[team].commander.plan?.target===building) FACTIONS[team].commander.nextReview=0;
  refreshPowerGrids();
  const owner=previous==='neutral'?'中立':factionName(previous);
  const text=factionName(team)+'工程师接管了'+owner+buildingSpec(building.type).label+'。';
  log(text+(firstOil?'首占奖励 +'+OIL_CAPTURE_BONUS+'。':''),team);
  notice(firstOil?'占领油田 · 首占 +'+OIL_CAPTURE_BONUS:text,team);
  if (previous!=='neutral') {
    log(text,previous);
    notice(text,previous);
  }
  playAt('ready',center,building);
}

function advanceOilFields() {
  const incomes={player:0,enemy:0};
  for (const field of structures) {
    if (field.type!=='oil' || field.team==='neutral' || field.nextPayout>game.time) continue;
    field.nextPayout+=OIL_INTERVAL;
    const account=treasury(field.team);
    const income=Math.round(OIL_INCOME*incomeMultiplier(field.team,'oil')*account.power.rate);
    account.credits+=income;
    incomes[field.team]+=income;
    if (structureVisible(field)) playAt('cash',yardCenter(field),field);
  }
  for (const [team,income] of Object.entries(incomes)) {
    if (income) log('油田收入 +'+income+' 储备。',team);
  }
}

function beginConstruction(type,tile,team,except=null) {
  const spec=buildingSpec(type);
  const building={type,...tile,team,width:spec.width,height:spec.height,health:spec.health,
    remaining:spec.time,queue:[],pendingGift:type==='refinery'};
  const account=treasury(team), cost=spec.cost??0;
  if (account.credits<cost || !canPlace(building,except)) return false;
  account.credits-=cost;
  structures.push(building);
  return building;
}

function deployYard(vehicle) {
  const index=units.indexOf(vehicle);
  if (index<0 || vehicle.health<=0) return false;
  const tile={x:Math.round(vehicle.x)-1,y:Math.round(vehicle.y)};
  const yard=beginConstruction('yard',tile,vehicle.team,vehicle);
  if (!yard) return false;
  yard.health=Math.max(1,Math.round(yard.health*vehicle.health/MCV_HEALTH));
  units.splice(index,1);
  orderAttack(units.filter(unit=>unit.attackTarget===vehicle),yard);
  playAt('build',yardCenter(yard),yard);
  return true;
}

function enqueue(building,type) {
  const spec=PRODUCTS[type];
  if (!spec || building?.type!==spec.building || building.remaining>0 || !structures.includes(building)) return false;
  const account=treasury(building.team);
  if (account.credits<spec.cost || (spec.tech && !account.discoveries.has(spec.tech))) return false;
  account.credits-=spec.cost;
  building.queue.push({type,remaining:spec.time});
  return true;
}

function supportsRally(building) {
  return building?.team==='player' && (building.type==='factory' || building.type==='barracks');
}

function rallyTileAvailable(tile) {
  return walkable(tile.x,tile.y) && !reservedDock(tile);
}

function setRallyPoint(building,tile) {
  if (!visible(tile.x,tile.y) || !rallyTileAvailable(tile)) {
    notice('请选择可通行的空地作为集结点');
    return;
  }
  const exit=spawnPoint(building,false);
  if (!exit || !findPath(tile,exit)) {
    notice('建筑出口无法通往该集结点');
    return;
  }
  building.rally={x:tile.x,y:tile.y};
  sound.play('move');
  notice(buildingSpec(building.type).label+'集结点已设置');
  syncBuildMenu();
}

function sendToRally(unit,building) {
  const rally=building.rally;
  if (!rally) return false;
  const claimed=new Set(units.filter(other=>other!==unit && other.goal?.kind==='rally')
    .map(other=>tileKey(other.goal.x,other.goal.y)));
  const cells=[];
  for (let x=rally.x-3;x<=rally.x+3;x++) {
    for (let y=rally.y-3;y<=rally.y+3;y++) {
      const tile={x,y};
      if (!rallyTileAvailable(tile) || claimed.has(tileKey(x,y)) || unitPositionBlocked(unit,x,y)) continue;
      cells.push(tile);
    }
  }
  cells.sort((a,b)=>distanceTo(a,rally)-distanceTo(b,rally));
  for (const tile of cells) {
    const path=findPath(tile,unit);
    if (path) return setCourse(tile,'rally',unit,path);
  }
  return false;
}

function spawnUnit(building,type) {
  const air=AIRCRAFT_TYPES.has(type);
  const parked=type==='bomber' || type==='helicopter';
  const aircraft={type,team:building.team};
  const launch=air?yardCenter(building):null;
  const spawn=parked?airfieldParking(building,aircraft):
    air?(unitPositionBlocked(aircraft,launch.x,launch.y)?null:launch):
    spawnPoint(building,true,{type,team:building.team});
  if (!spawn) return false;
  const spec=PRODUCTS[type];
  const speed=spec.speed;
  const unit={...spawn,team:building.team,type,id:nextUnitId++,label:spec.label,speed,
    vision:spec.vision,heading:Math.PI/2,mode:'idle',route:[],goal:null};
  if (air) unit.altitude=parked?0:12;
  if (type==='bomber') {
    unit.airbase=building;
    unit.mode='parked';
  }
  if (type==='helicopter') unit.passengers=[];
  if (type==='mcv') unit.expansion=true;
  if (type==='miner') {
    unit.cargo=0;
    unit.autoMine=true;
    unit.nextMineSearch=game.time;
  }
  if (WEAPONS[type]) {
    unit.health=WEAPONS[type].health;
    unit.nextShot=0;
  }
  if (spec.health) unit.health=spec.health;
  units.push(unit);
  const rallying=sendToRally(unit,building);
  if (!rallying && type==='miner') dispatchMiner(unit);
  return true;
}

function refreshPowerGrids() {
  for (const faction of Object.values(FACTIONS)) {
    let supply=0,demand=0,fireRate=0,damage=0;
    let factories=0;
    for (const building of structures) {
      if (building.team!==faction.team || building.remaining>0 || building.health<=0) continue;
      const spec=buildingSpec(building.type);
      if (building.type==='factory') factories++;
      supply+=spec.powerOutput??0;
      demand+=spec.powerUse??0;
      fireRate=Math.max(fireRate,spec.fireRateBonus??0);
      damage=Math.max(damage,spec.damageBonus??0);
    }
    const rate=demand>0?Math.max(.27,Math.min(1,supply/demand)):1;
    faction.power={supply,demand,rate};
    faction.support={fireRate:1+fireRate*rate,damage:1+damage*rate};
    faction.factoryCount=factories;
    faction.factoryBonus=rate*Math.min(MAX_FACTORY_SPEED_BONUS,Math.max(0,factories-1)*FACTORY_SPEED_BONUS);
  }
}

function productionRate(building) {
  const faction=FACTIONS[building.team];
  return faction.power.rate*(building.type==='factory'?1+faction.factoryBonus:1);
}

function maintainPower(faction,yard,reserve=0) {
  const sites=structures.filter(building=>building.team===faction.team && building.health>0);
  const plants=sites.filter(building=>buildingSpec(building.type).powerOutput);
  if (plants.some(plant=>plant.remaining)) return;
  const planned=sites.reduce((sum,building)=>sum+(buildingSpec(building.type).powerUse??0),0);
  if (planned<=faction.power.supply) return;
  const deficit=planned-faction.power.supply;
  const available=faction.credits-(plants.length?reserve:0);
  const type=plants.length && deficit>55 && available>=BUILDINGS.diesel.cost?'diesel':'solar';
  if (available<BUILDINGS[type].cost) return;
  placeAiBuilding({type,x:-4,y:-3},yard,faction.team);
}

function buildSupportFacilities(faction,yard,buildings) {
  const plans=[{type:'recreation',x:-5,y:0},{type:'training',x:-1,y:-5}];
  const next=plans.find(plan=>!buildings.some(building=>building.type===plan.type));
  if (!next || faction.credits<BUILDINGS[next.type].cost+275) return;
  placeAiBuilding(next,yard,faction.team);
}

function advanceProduction(dt) {
  for (const building of structures) {
    if (building.remaining>0) {
      const buildRate=building.rushUntil>game.time?2:1;
      building.remaining=Math.max(0,building.remaining-dt*buildRate);
      if (building.remaining===0) {
        const label=buildingSpec(building.type).label;
        playAt('ready',yardCenter(building),building);
        log(factionName(building.team)+label+'已建成。',building.team);
      }
    }
  }
  refreshPowerGrids();
  for (const building of structures) {
    if (building.remaining>0) continue;
    const own=building.team==='player';
    if (building.pendingGift && spawnUnit(building,'miner')) {
      building.pendingGift=false;
      if (own) {
        log('精炼厂配发了一辆采矿车。',building.team);
        notice('采矿车已就绪，会自动寻找矿脉',building.team);
      }
    }
    const job=building.queue[0];
    if (!job) continue;
    job.remaining=Math.max(0,job.remaining-dt*productionRate(building));
    if (job.remaining>0 || !spawnUnit(building,job.type)) continue;
    building.queue.shift();
    const orders=FACTIONS[building.team].priorityAircraft;
    if (orders?.[0]===job.type) orders.shift();
    playAt('ready',yardCenter(building),building);
    log(factionName(building.team)+PRODUCTS[job.type].label+'已完成生产。',building.team);
  }
}

const baseBuildPlan=[
  {type:'refinery',x:-2,y:5},
  {type:'barracks',x:3,y:5},
  {type:'factory',x:2,y:-3},
];
const defenseBuildPlan=[
  {type:'sentry',x:4,y:2}, {type:'turret',x:6,y:-1}, {type:'laser',x:3,y:-5},
];
const searchSites=mapTiles.filter(tile=>tile.x%4===0 && tile.y%4===0);

function isArmyType(type) {
  return type!=='miner' && Boolean(WEAPONS[type]);
}

function advanceAiCapture(faction,barracks,members,mayTrain) {
  const targets=structures.filter(building=>captureAvailable(faction,building));
  const captureValue={yard:9,factory:7,refinery:6,barracks:5,bunker:4,turret:4,laser:5,sentry:3,oil:8,wall:-6};
  if (!targets.length) return;
  const priority=faction.orders.task==='capture' && targets.includes(faction.orders.target)?faction.orders.target:null;
  const engineer=members.find(unit=>unit.type==='engineer');
  if (engineer) {
    if (engineer.goal && (!priority || engineer.captureTarget===priority)) return;
    const rank=building=>distanceTo(yardCenter(building),engineer)-(captureValue[building.type]??0) +
      (BUILDINGS[building.type]?.weapon?5:0);
    targets.sort((a,b)=>rank(a)-rank(b));
    if (priority && orderCapture(engineer,priority)) return;
    targets.some(building=>orderCapture(engineer,building));
    return;
  }
  const earlyOil=targets.some(building=>building.type==='oil' && building.team==='neutral') &&
    !structures.some(building=>building.type==='oil' && building.team===faction.team);
  if (mayTrain && barracks && !barracks.queue.length && (priority || earlyOil || faction.unitMix%7===6) &&
      members.some(unit=>isArmyType(unit.type)) && enqueue(barracks,'engineer')) faction.unitMix++;
}

function sendScout(unit,point,kind='move') {
  const path=findPath(point,unit);
  if (path?.length) return setCourse(point,kind,unit,path);
  if (path) return false;
  const nearby=forestDestination(point,unit);
  return Boolean(nearby?.course.length && setCourse(nearby.target,kind,unit,nearby.course));
}

function searchBattlefield(faction,unit,frontier,kind='move') {
  const candidates=frontier.filter(site=>!units.some(other=>other.team===unit.team &&
    ['move','scout'].includes(other.goal?.kind) && sameTile(other.goal,site)));
  candidates.sort((a,b)=>{
    const visited=(faction.searched.get(a)??0)-(faction.searched.get(b)??0);
    return visited || distanceTo(a,unit)-distanceTo(b,unit);
  });
  for (const site of candidates) {
    if (!sendScout(unit,site,kind)) continue;
    faction.searched.set(site,game.time);
    return true;
  }
  return false;
}

function stageArmy(army,buildings,retreat=false) {
  const base=buildings.find(building=>building.type==='yard')??buildings.find(building=>building.type==='factory' ||
    building.type==='barracks' || building.type==='refinery');
  if (!base) return;
  const center=yardCenter(base);
  const staged=army.filter(unit=>!unit.goal && (!unit.staging || (retreat && distanceTo(unit,center)>9)));
  if (!staged.length) return;
  const taken=new Set(army.map(unit=>unit.goal??{x:Math.round(unit.x),y:Math.round(unit.y)})
    .map(point=>tileKey(point.x,point.y)));
  const stagingTiles=[];
  const explored=FACTIONS[base.team].explored;
  for (let x=base.x-9;x<=base.x+10;x++) {
    for (let y=base.y-9;y<=base.y+10;y++) {
      const distance=distanceTo({x,y},center);
      if (distance<5 || distance>9 || !walkable(x,y) || reservedDock({x,y}) || amountAt(x,y)>0 ||
          taken.has(tileKey(x,y)) || !explored.has(tileKey(x,y))) continue;
      stagingTiles.push({x,y});
    }
  }
  for (const unit of staged) {
    stagingTiles.sort((a,b)=>distanceTo(a,unit)-distanceTo(b,unit));
    const index=stagingTiles.findIndex(tile=>{
      if (unitPositionBlocked(unit,tile.x,tile.y)) return false;
      const path=findPath(tile,unit);
      return path?.length && setCourse(tile,retreat?'retreat':'stage',unit,path);
    });
    if (index>=0) {
      unit.staging=true;
      stagingTiles.splice(index,1);
    }
  }
}

function scoutBattlefield(faction) {
  const contacts=[...units,...structures].filter(target=>target.team!==faction.team &&
    target.team!=='neutral' && target.health>0 && canSeeEntity(faction,target));
  const frontier=searchSites.filter(tile=>{
    if (!faction.explored.has(tileKey(tile.x,tile.y)) || !walkable(tile.x,tile.y)) return false;
    return NEIGHBORS.some(([dx,dy])=>onMap(tile.x+dx*4,tile.y+dy*4) &&
      !faction.explored.has(tileKey(tile.x+dx*4,tile.y+dy*4)));
  });
  return {frontier,contacts};
}

function combatPower(unit,own=false) {
  const weapon=WEAPONS[unit.type];
  const ranged=weaponDamage(unit,weapon)/weapon.reload*Math.sqrt(weapon.range);
  const role=unit.type==='dog'?.64:weapon.splash?1.24:1;
  const support=own?FACTIONS[unit.team].support.damage*FACTIONS[unit.team].support.fireRate:1;
  const effectiveHealth=weapon.health/(1-weapon.defense);
  return (ranged*role*support+effectiveHealth*.13)*Math.sqrt(unit.health/weapon.health);
}

function assessStrength(faction,army,contacts,base) {
  if (!base) return;
  const center=yardCenter(base);
  const rivals=contacts.filter(unit=>!unit.width && isArmyType(unit.type));
  for (const rival of rivals) {
    faction.reports.set(rival,{power:combatPower(rival),time:game.time,x:rival.x,y:rival.y});
  }
  let opponent=0;
  for (const [unit,report] of faction.reports) {
    const age=game.time-report.time;
    if (age>42) {
      faction.reports.delete(unit);
      continue;
    }
    opponent+=report.power*(1-age/63);
  }
  const closest=rivals.reduce((best,unit)=>!best || distanceTo(unit,center)<distanceTo(best,center)?unit:best,null);
  if (closest) faction.threatPoint={x:closest.x,y:closest.y};
  const own=army.reduce((sum,unit)=>sum+combatPower(unit,true),0);
  if (!faction.defensive && opponent>=70 && own<opponent*.60) {
    faction.defensive=true;
    faction.retreatBenchmark=opponent;
    faction.recoveringAt=null;
    log(factionName(faction.team)+'判断兵力处于劣势，转入防守并增建工事。',faction.team);
    return;
  }
  if (!faction.defensive) return;
  const threshold=Math.max(opponent*.86,Math.min(faction.retreatBenchmark,opponent*1.4)*.72);
  if (own<threshold || army.length<2) {
    faction.recoveringAt=null;
    return;
  }
  faction.recoveringAt??=game.time;
  if (game.time-faction.recoveringAt>=6) {
    faction.defensive=false;
    faction.recoveringAt=null;
    faction.retreatBenchmark=0;
    log(factionName(faction.team)+'兵力已恢复，开始反攻。',faction.team);
  }
}

function urgentRaid(faction,contacts) {
  let raid=null,best=-Infinity;
  for (const [target,report] of faction.raids) {
    const localThreat=report.critical && contacts.some(contact=>contact.health>0 &&
      (WEAPONS[contact.type] || BUILDINGS[contact.type]?.weapon) &&
      distanceTo(report.point,targetPoint(report.point,contact))<=BASE_DEFENSE_RADIUS);
    const expires=report.time+(report.critical?18:8);
    if ((expires<game.time && !localThreat) || target.team!==faction.team) {
      faction.raids.delete(target);
      continue;
    }
    const weight=target.type==='yard' || target.type==='mcv'?18:report.critical?12:target.width?5:1;
    const score=weight+(localThreat?8:0)-Math.min(8,game.time-report.time);
    if (score>best) {
      raid=report;
      best=score;
    }
  }
  return raid;
}

function recordRaid(attacker,target) {
  const faction=FACTIONS[target.team];
  if (!faction) return;
  const point=target.width?yardCenter(target):{x:target.x,y:target.y};
  const critical=CRITICAL_RAID_TARGETS.has(target.type) || structures.some(building=>
    building.team===faction.team && building.health>0 && CRITICAL_RAID_TARGETS.has(building.type) &&
    distanceTo(yardCenter(building),point)<=6);
  let report=faction.raids.get(target);
  if (!report) {
    report={target,critical:false,time:-Infinity,responseAt:game.time};
    faction.raids.set(target,report);
  }
  if (critical && (!report.critical || report.time+8<game.time)) {
    report.responseAt=game.time;
    faction.nextOrder=Math.min(faction.nextOrder,game.time+.06);
  }
  report.critical=critical;
  Object.assign(report,{attacker,point,time:game.time});
}

function sendRelief(faction,army,contacts,raid) {
  const responders=new Set();
  if (!raid) return responders;
  const range=raid.critical?Infinity:16;
  const relief=army.filter(unit=>distanceTo(unit,raid.point)<=range);
  relief.sort((a,b)=>distanceTo(a,raid.point)/a.speed-distanceTo(b,raid.point)/b.speed);
  const attackers=contacts.filter(contact=>contact.health>0 &&
    (contact===raid.attacker || WEAPONS[contact.type] || BUILDINGS[contact.type]?.weapon) &&
    distanceTo(raid.point,targetPoint(raid.point,contact))<=BASE_DEFENSE_RADIUS);
  attackers.sort((a,b)=>distanceTo(raid.point,targetPoint(raid.point,a))-
    distanceTo(raid.point,targetPoint(raid.point,b))+(b===raid.attacker?3:0)-(a===raid.attacker?3:0));
  const cap=raid.critical?relief.length:Math.max(4,Math.ceil(army.length*.62));
  const defenders=relief.slice(0,cap);
  const front=attackers[0];
  // Troops already in range keep firing while arriving squads form up.
  const forming=raid.critical && front && defenders.length>=3 && game.time<raid.responseAt+2.8 &&
    defenders.filter(unit=>distanceTo(unit,targetPoint(unit,front))<=WEAPONS[unit.type].range+2).length<3;
  const cx=Math.round(raid.point.x),cy=Math.round(raid.point.y);
  const used=new Set(army.filter(unit=>unit.goal?.kind==='reinforce' || unit.goal?.kind==='attack')
    .map(unit=>tileUnder(unit.goal.x,unit.goal.y)));
  const rally=[];
  for (let x=cx-7;x<=cx+7;x++) {
    for (let y=cy-7;y<=cy+7;y++) {
      const tile={x,y};
      const distance=distanceTo(tile,raid.point);
      if (distance>=2.4 && distance<=7 && faction.explored.has(tileKey(x,y)) &&
          onMap(x,y) && !reservedDock(tile)) rally.push(tile);
    }
  }
  let issued=false;
  for (const unit of defenders) {
    const distance=distanceTo(unit,raid.point);
    const knownAttacker=attackers.find(target=>canAttackTarget(unit,target) &&
      (unit.type!=='dog' || isPersonnel(target) || target.type==='dog') &&
      (!(unit.attackRetryTime>game.time) || target!==unit.blockedAttackTarget) &&
      ((!forming && distance<=BASE_DEFENSE_RADIUS) || inWeaponRange(unit,target,WEAPONS[unit.type])));
    if (knownAttacker && (unit.attackTarget===knownAttacker || orderAttack([unit],knownAttacker))) {
      responders.add(unit);
      issued ||= unit.rescueTarget!==raid.target;
      unit.rescueTarget=raid.target;
      continue;
    }
    if (unit.goal?.kind==='reinforce' && unit.rescueTarget===raid.target &&
        distanceTo(unit.goal,raid.point)<=8) {
      responders.add(unit);
      continue;
    }
    if (distance<=7) {
      if (unit.goal || unit.attackTarget) clearAttackOrder(unit);
      unit.rescueTarget=raid.target;
      responders.add(unit);
      continue;
    }
    const tiles=rally.filter(({x,y})=>!used.has(tileKey(x,y)) &&
      (isAirborne(unit) || walkable(x,y)) && !unitPositionBlocked(unit,x,y));
    const rank=tile=>distanceTo(unit,tile)+distanceTo(raid.point,tile)*1.4;
    tiles.sort((a,b)=>rank(a)-rank(b));
    for (const tile of tiles) {
      const path=findPath(tile,unit);
      if (!path?.length || !setCourse(tile,'reinforce',unit,path)) continue;
      used.add(tileKey(tile.x,tile.y));
      unit.rescueTarget=raid.target;
      responders.add(unit);
      issued=true;
      break;
    }
  }
  if (issued && game.time-faction.lastRescueReport>=7) {
    faction.lastRescueReport=game.time;
    log(factionName(faction.team)+'调集 '+responders.size+' 个作战单位增援受击位置。',faction.team);
  }
  return responders;
}

function isFastScout(unit) {
  return unit.type==='dog' || unit.type==='cavalry' || unit.type==='mountedCavalry';
}

function openingReconAllowed(faction,intelligence,raid) {
  return game.time<OPENING_SCOUT_WINDOW && intelligence.frontier.length>0 &&
    !raid?.critical && !faction.defensive && faction.orders.task!=='intercept';
}

function dispatchOpeningScout(faction,army,intelligence,raid) {
  const previous=faction.openingScout;
  if (!openingReconAllowed(faction,intelligence,raid)) {
    if ((raid?.critical || faction.defensive || faction.orders.task==='intercept') &&
        previous?.goal?.kind==='scout' && army.includes(previous)) {
      clearAttackOrder(previous);
      previous.staging=false;
    }
    return null;
  }
  if (army.includes(previous) && previous.goal?.kind==='scout') return previous;
  const plan=faction.commander.plan;
  const scouts=army.filter(unit=>isFastScout(unit) && !unit.engaged && !unit.attackTarget &&
    !['mount','reinforce'].includes(unit.goal?.kind));
  scouts.sort((a,b)=>b.speed-a.speed || b.vision-a.vision);
  for (const scout of scouts) {
    if (plan?.task==='recon' && sendScout(scout,plan.target,'scout')) {
      faction.searched.set(plan.target,game.time);
      plan.scout=scout;
    } else if (!searchBattlefield(faction,scout,intelligence.frontier,'scout')) continue;
    if (previous!==scout) {
      log(factionName(faction.team)+'派'+scout.label+'侦察前沿。',faction.team);
    }
    faction.openingScout=scout;
    return scout;
  }
  return null;
}

function dispatchScouts(faction,army,point,kind='move') {
  const scouts=army.filter(unit=>!unit.attackTarget &&
    (!unit.goal || unit.goal.kind==='stage' || unit.goal.kind==='retreat')).sort((a,b)=>{
    const order=unit=>(isFastScout(unit) || isAirborne(unit)?6:0)+unit.vision+unit.speed*.35;
    return order(b)-order(a) || distanceTo(a,point)-distanceTo(b,point);
  });
  const scout=scouts.find(unit=>sendScout(unit,point,kind));
  if (scout) faction.searched.set(point,game.time);
  return scout;
}

function marchUnit(unit,plan,claimed) {
  if (distanceTo(unit,plan.point)<2.6) return;
  if (unit.goal?.kind==='advance' && unit.advancePlan===plan) return;
  if (unit.advancePlan===plan && game.time<(unit.nextAdvanceAttempt??0)) return;
  unit.advancePlan=plan;
  unit.nextAdvanceAttempt=game.time+2;
  const {x,y}=plan.point;
  const explored=FACTIONS[unit.team].explored;
  const sites=[];
  for (let dx=-2;dx<=2;dx++) {
    for (let dy=-2;dy<=2;dy++) {
      const tile={x:x+dx,y:y+dy};
      const key=tileKey(tile.x,tile.y);
      if (explored.has(key) && !claimed.has(key) && !reservedDock(tile) &&
          (isAirborne(unit) || walkable(tile.x,tile.y)) && !unitPositionBlocked(unit,tile.x,tile.y)) sites.push(tile);
    }
  }
  sites.sort((a,b)=>distanceTo(a,plan.point)-distanceTo(b,plan.point) ||
    distanceTo(a,unit)-distanceTo(b,unit));
  for (const site of sites) {
    if (!sendScout(unit,site,'advance')) continue;
    claimed.add(tileKey(site.x,site.y));
    break;
  }
}

function directAiArmy(faction,army,buildings,intelligence,raid) {
  const {frontier,contacts}=intelligence;
  const responders=sendRelief(faction,army,contacts,raid);
  const available=army.filter(unit=>!responders.has(unit) && (raid?.critical || unit.goal?.kind!=='yield'));
  for (const unit of available) {
    if (!unit.rescueTarget) continue;
    if (unit.goal?.kind==='reinforce') clearAttackOrder(unit);
    unit.rescueTarget=null;
  }
  const scout=dispatchOpeningScout(faction,available,intelligence,raid);
  const remaining=available.filter(unit=>unit!==scout);
  if (faction.orders.mode!=='assault') {
    for (const unit of remaining) {
      if (unit.attackTarget || ['attack','reinforce','advance'].includes(unit.goal?.kind)) {
        clearAttackOrder(unit);
        unit.staging=false;
      }
    }
    const plan=faction.commander.plan;
    if (!scout && faction.orders.mode==='develop' && plan?.task==='recon' && !available.includes(plan.scout) &&
        !(plan.scout?.type==='reconPlane' && units.includes(plan.scout))) {
      plan.scout=dispatchScouts(faction,remaining,plan.target,'scout');
    }
    if (plan?.task==='capture' && remaining.length>=3 && !remaining.includes(plan.scout) &&
        captureAvailable(faction,plan.target)) {
      const post=perimeterTiles(plan.target).find(tile=>faction.explored.has(tileKey(tile.x,tile.y)) && walkable(tile.x,tile.y));
      if (post) plan.scout=dispatchScouts(faction,remaining,post);
    }
    stageArmy(remaining,buildings,true);
    return;
  }
  const plan=faction.commander.plan;
  const objective=faction.orders.task;
  const home=buildings.find(building=>building.type==='yard')??buildings.find(building=>CRITICAL_RAID_TARGETS.has(building.type));
  const preferred=contacts.includes(faction.orders.target)?faction.orders.target:null;
  let attackers=remaining;
  const offensive=objective==='strike' || objective==='harass' || objective==='advance';
  if (home && scout && offensive && remaining.length<2) {
    attackers=[];
  } else if (home && offensive && remaining.length>=2) {
    const center=yardCenter(home);
    const exposed=contacts.some(contact=>!contact.width && WEAPONS[contact.type] && distanceTo(center,contact)<=14);
    const towers=buildings.filter(building=>!building.remaining && BUILDINGS[building.type]?.weapon &&
      distanceTo(yardCenter(building),center)<=10).length;
    const share=exposed?2/3:towers>=2?.22:.34;
    const reserves=Math.min(remaining.length-1,Math.max(1,Math.round(remaining.length*share)));
    const guardRank=unit=>distanceTo(unit,center)+(WEAPONS[unit.type].minimum?7:0)-
      (plan?.guards?.includes(unit)?3:0);
    const guards=remaining.slice().sort((a,b)=>guardRank(a)-guardRank(b));
    if (plan) plan.guards=guards.slice(0,reserves);
    attackers=guards.slice(reserves);
    if (objective==='harass') {
      const point=preferred?(preferred.width?yardCenter(preferred):preferred):(plan?.point??center);
      const raidRank=unit=>distanceTo(unit,point)/unit.speed+(unit.type==='dog'?4:0)-
        (plan?.raiders?.includes(unit)?4:0);
      attackers=attackers.filter(unit=>unit.health>=WEAPONS[unit.type].health*.4)
        .sort((a,b)=>raidRank(a)-raidRank(b)).slice(0,3);
      if (plan) plan.raiders=attackers;
    }
  }
  const guard=remaining.filter(unit=>!attackers.includes(unit));
  if (plan) plan.homeReserve=guard.length;
  const advancing=objective==='advance' && plan;
  if (advancing) plan.marchers=attackers;
  const claimed=new Set(attackers.filter(unit=>unit.advancePlan===plan && unit.goal?.kind==='advance')
    .map(unit=>tileKey(unit.goal.x,unit.goal.y)));
  for (const unit of guard) {
    if (unit.attackTarget || (unit.goal && !['stage','retreat','mount'].includes(unit.goal.kind))) {
      clearAttackOrder(unit);
      unit.staging=false;
    }
  }
  stageArmy(guard,buildings,true);
  for (const unit of attackers) {
    if (unit.goal?.kind==='mount') continue;
    const current=unit.attackTarget;
    const weapon=WEAPONS[unit.type];
    const retrying=unit.attackRetryTime>game.time;
    let target=null,best=Infinity;
    for (const contact of contacts) {
      if (!canAttackTarget(unit,contact) || (retrying && contact===unit.blockedAttackTarget)) continue;
      const distance=distanceTo(unit,targetPoint(unit,contact));
      const priority=contact.type==='oil'?12:contact.width?4:0;
      const armorPreference=weapon.armorFactor>1 && armoredTarget(contact)?-2:0;
      const dogPreference=unit.type==='dog' && COMBAT_INFANTRY.has(contact.type)?-3:0;
      const focus=contact===preferred?(objective==='intercept'?-18:-Math.max(28,distance+10)):0;
      const score=distance+priority+focus+armorPreference+dogPreference-(contact===current?2:0);
      if (score>=best) continue;
      target=contact;
      best=score;
    }
    if (target) {
      if (current!==target) orderAttack([unit],target);
      const position=targetPoint(unit,target);
      unit.lastKnownTarget={x:Math.round(position.x),y:Math.round(position.y)};
      continue;
    }
    if (current) {
      clearAttackOrder(unit);
      if (!advancing && unit.lastKnownTarget && sendScout(unit,unit.lastKnownTarget)) continue;
    }
    if (advancing) marchUnit(unit,plan,claimed);
    else if (!unit.goal) searchBattlefield(faction,unit,frontier);
  }
}

function placeAiBuilding(plan,yard,team) {
  const accounts=treasury(team);
  if (accounts.credits<BUILDINGS[plan.type].cost) return false;
  const origin={x:yard.x+1,y:yard.y+1};
  const preferred={x:origin.x+plan.x,y:origin.y+plan.y};
  const candidates=plan.type==='wall'?[{...preferred,axis:plan.axis}]:[];
  if (plan.type!=='wall') {
    for (let dx=-BUILD_RADIUS;dx<=BUILD_RADIUS;dx++) {
      for (let dy=-BUILD_RADIUS;dy<=BUILD_RADIUS;dy++) {
        const tile={x:origin.x+dx,y:origin.y+dy};
        if (onMap(tile.x,tile.y)) candidates.push(tile);
      }
    }
    candidates.sort((a,b)=>distanceTo(a,preferred)-distanceTo(b,preferred));
  }
  const spec=BUILDINGS[plan.type];
  for (const tile of candidates) {
    if (!withinYard(placementBounds({type:plan.type,...tile,width:spec.width,height:spec.height}),yard)) continue;
    const building=beginConstruction(plan.type,tile,team);
    if (!building) continue;
    if (plan.rush) building.rushUntil=game.time+1;
    log(factionName(team)+spec.label+(plan.rush?'开始抢建。':'开始施工。'),team);
    playAt('build',yardCenter(building),building);
    return building;
  }
  return false;
}

function rushDefenses(faction,yards,buildings,contacts,raid) {
  const distance=yard=>distanceTo(yardCenter(yard),raid.point);
  const yard=yards.filter(yard=>readyYard(yard,faction.team) && distance(yard)<=BASE_DEFENSE_RADIUS)
    .sort((a,b)=>distance(a)-distance(b))[0];
  if (!yard) return;

  const defenses=baseFacilities(yard,yards,buildings).filter(building=>EMERGENCY_DEFENSE_TYPES.has(building.type));
  const buildingNow=defenses.filter(building=>building.remaining>0);
  for (const building of buildingNow) building.rushUntil=game.time+1;
  if (buildingNow.length) return true;
  if (defenses.length>=3 || faction.credits<BUILDINGS.turret.cost) return false;

  const attackers=contacts.filter(contact=>(WEAPONS[contact.type] || BUILDINGS[contact.type]?.weapon) &&
    distanceTo(raid.point,targetPoint(raid.point,contact))<=BASE_DEFENSE_RADIUS);
  const front=attackers.includes(raid.attacker)?raid.attacker:nearestOpponent({...raid.point,team:faction.team},
    attackers,BASE_DEFENSE_RADIUS);
  const incoming=front?targetPoint(raid.point,front):raid.point;
  const center=yardCenter(yard);
  const length=distanceTo(incoming,center);
  const x=length>.1?Math.round((incoming.x-center.x)*6/length):5;
  const y=length>.1?Math.round((incoming.y-center.y)*6/length):1;
  const plannedLoad=buildings.reduce((sum,building)=>sum+(buildingSpec(building.type).powerUse??0),0);
  const laserReady=faction.credits>=BUILDINGS.laser.cost &&
    faction.power.supply>=plannedLoad+BUILDINGS.laser.powerUse;
  const airRaid=attackers.length>0 && attackers.every(isAirborne);
  const preferLaser=airRaid || (laserReady && defenses.length>0 && !defenses.some(building=>building.type==='laser'));
  const types=preferLaser?(airRaid?['laser']:['laser','turret']):['turret'];
  for (const type of types) {
    if (placeAiBuilding({type,x,y,rush:true},yard,faction.team)) return true;
  }
  return false;
}

function protectFacilities(faction,yard,buildings,threat) {
  const important=buildings.filter(building=>['yard','refinery','factory','barracks','solar','diesel'].includes(building.type) &&
    distanceTo(yardCenter(building),yardCenter(yard))<=9);
  const envelopes=important.map(placementBounds);
  const left=Math.floor(Math.min(...envelopes.map(box=>box.left)))-1;
  const right=Math.ceil(Math.max(...envelopes.map(box=>box.right)))+1;
  const top=Math.floor(Math.min(...envelopes.map(box=>box.top)))-1;
  const bottom=Math.ceil(Math.max(...envelopes.map(box=>box.bottom)))+1;
  const openingX=Math.round((left+right)/2),openingY=Math.round((top+bottom)/2);
  const perimeter=[];
  for (let x=left;x<=right;x++) {
    if (x===openingX) continue;
    perimeter.push({x,y:top,axis:'x'},{x,y:bottom,axis:'x'});
  }
  for (let y=top+1;y<bottom;y++) {
    if (y===openingY) continue;
    perimeter.push({x:left,y,axis:'y'},{x:right,y,axis:'y'});
  }
  const walls=buildings.filter(building=>building.type==='wall');
  const rank=tile=>distanceTo(tile,threat)-walls.filter(wall=>distanceTo(tile,wall)===1).length*6;
  perimeter.sort((a,b)=>rank(a)-rank(b));
  const origin={x:yard.x+1,y:yard.y+1};
  return perimeter.some(tile=>placeAiBuilding({type:'wall',x:tile.x-origin.x,y:tile.y-origin.y,axis:tile.axis},
    yard,faction.team));
}

function buildDefenses(faction,yard,buildings,contacts) {
  const center=yardCenter(yard);
  const nearby=contacts.filter(unit=>!unit.width && isArmyType(unit.type) && distanceTo(unit,center)<10);
  const armorNearby=nearby.some(armoredTarget);
  const weapons=buildings.filter(b=>BUILDINGS[b.type]?.weapon);
  const walls=buildings.filter(b=>b.type==='wall');
  const underConstruction=building=>building.remaining>0;
  const threat=faction.threatPoint??{x:0,y:0};
  const dx=threat.x-center.x,dy=threat.y-center.y;
  const alongX=Math.abs(dx)>=Math.abs(dy);
  const direction=Math.sign(alongX?dx:dy)||1;
  const line=alongX?{x:5*direction,y:0,axis:'y'}:{x:0,y:5*direction,axis:'x'};

  const guarding=faction.defensive || faction.orders.mode==='guard';
  if (guarding && !weapons.some(underConstruction)) {
    const goal=faction.retreatBenchmark>240?4:3;
    if (weapons.length<goal && (weapons.length===0 || nearby.length || walls.length>=2)) {
      const canAddLaser=weapons.length>=2 && !weapons.some(building=>building.type==='laser') &&
        faction.credits>=BUILDINGS.laser.cost+170;
      const type=canAddLaser?'laser':armorNearby?'turret':'bunker';
      const side=weapons.length%2 ? -1 : 1;
      const plan={type,x:line.x+(alongX?0:side*2),y:line.y+(alongX?side*2:0)};
      if (placeAiBuilding(plan,yard,faction.team)) return;
      if (weapons.length===0 && placeAiBuilding({...plan,type:'sentry'},yard,faction.team)) return;
    }
  }

  const conservative=faction.strategy==='conservative';
  const wallLimit=conservative?12:guarding?4:2;
  const wallReserve=conservative?220:guarding?180:460;
  if (walls.length<wallLimit && !walls.some(underConstruction) && faction.credits>=BUILDINGS.wall.cost+wallReserve &&
      (guarding || conservative || nearby.length)) {
    if (conservative && protectFacilities(faction,yard,buildings,threat)) return;
    // Leave the center lane open and place two short wings across the approach.
    for (const forward of [0,1,-1,2]) {
      for (const side of [-1,-2,1,2,-3,3,-4,4]) {
        const plan={type:'wall',axis:line.axis,x:line.x+(alongX?forward*direction:side),
          y:line.y+(alongX?side:forward*direction)};
        if (placeAiBuilding(plan,yard,faction.team)) return;
      }
    }
  }
  if (guarding) return;

  const missing=defenseBuildPlan.filter(plan=>!buildings.some(b=>b.type===plan.type));
  const defense=missing.find(plan=>armorNearby && plan.type==='turret')??missing[0];
  if (defense && faction.credits>=BUILDINGS[defense.type].cost+(nearby.length?250:defense.type==='laser'?350:600)) {
    placeAiBuilding(defense,yard,faction.team);
  }
}

function incomeMultiplier(team,source) {
  const faction=treasury(team);
  let bonus=0;
  for (const id of faction.equipment) {
    if (TECHNOLOGIES[id].income===source) bonus+=TECHNOLOGIES[id].bonus;
  }
  return 1+bonus;
}

function planResearch(faction,yard,allowNewProject=true) {
  const {team}=faction;
  const manufactured=[...faction.discoveries].find(id=>TECHNOLOGIES[id].device && !faction.equipment.has(id));
  if (manufactured && !faction.manufacturing) {
    const design=TECHNOLOGIES[manufactured];
    if (faction.credits<design.cost) return true;
    faction.credits-=design.cost;
    faction.manufacturing={id:manufactured,remaining:design.time,facility:yard};
    log(factionName(team)+'开始制造'+design.device+'，支出 '+design.cost+'。',team);
  }
  if (!allowNewProject || faction.research || faction.discoveries.size===Object.keys(RESEARCH_PROGRAMS).length) return false;
  const available=Object.entries(RESEARCH_PROGRAMS).filter(([,program])=>
    !program.results.some(id=>faction.discoveries.has(id)));
  const program=available.length===1?available[0][1]:
    available[Math.floor(Math.random()*available.length)][1];
  if (faction.credits<program.cost) return true;
  faction.credits-=program.cost;
  faction.research={program,remaining:program.time,facility:yard};
  log(factionName(team)+'启动未知'+program.label+'研发，支出 '+program.cost+'。',team);
  return false;
}

function advanceResearch(dt) {
  for (const faction of Object.values(FACTIONS)) {
    for (const key of ['research','manufacturing']) {
      const project=faction[key];
      if (!project) continue;
      if (!structures.includes(project.facility) || project.facility.team!==faction.team) {
        faction[key]=null;
        log(factionName(faction.team)+'失去建造场，'+(key==='research'?'研发':'设备制造')+'中断。',faction.team);
        continue;
      }
      project.remaining=Math.max(0,project.remaining-dt*faction.power.rate);
      if (project.remaining>0) continue;
      faction[key]=null;
      if (key==='research') {
        const {results}=project.program;
        const id=results[Math.floor(Math.random()*results.length)];
        faction.discoveries.add(id);
        const design=TECHNOLOGIES[id];
        log(factionName(faction.team)+'发现「'+design.label+'」，可制造'+(design.device??PRODUCTS[design.unit].label)+'。',faction.team);
      } else {
        faction.equipment.add(project.id);
        const design=TECHNOLOGIES[project.id];
        log(factionName(faction.team)+design.device+'已投用，收入提高 '+Math.round(design.bonus*100)+'%。',faction.team);
      }
      playAt('ready',yardCenter(project.facility),project.facility);
    }
  }
}

function expansionSite(faction,vehicle,yards) {
  const mines=battlefield.seams.filter(mine=>faction.explored.has(tileKey(mine.x,mine.y)) &&
    amountAt(mine.x,mine.y)>0);
  const position=unit=>yardCenter(unit);
  const candidates=[...faction.explored.values()].filter(tile=>walkable(tile.x,tile.y) && insideMap(tile,6) &&
    yards.every(base=>distanceTo(position(base),tile)>=11.5) &&
    [...faction.reports.values()].every(contact=>distanceTo(contact,tile)>5));
  const rank=tile=>{
    const resource=Math.min(18,...mines.map(mine=>distanceTo(tile,mine)));
    return Math.abs(resource-6)*1.6+distanceTo(tile,vehicle)*.36;
  };
  candidates.sort((a,b)=>rank(a)-rank(b));
  for (const tile of candidates) {
    const site={type:'yard',team:faction.team,x:tile.x-1,y:tile.y,width:YARD.width,height:YARD.height};
    if (!canPlace(site,vehicle)) continue;
    const clear=mapTiles.filter(cell=>Math.abs(cell.x-tile.x)<=4 && Math.abs(cell.y-tile.y)<=4 &&
      walkable(cell.x,cell.y) && faction.explored.has(tileKey(cell.x,cell.y))).length;
    if (clear<36) continue;
    if (findPath(tile,vehicle)) return tile;
  }
  return null;
}

function deployBaseVehicles(faction,members,yards) {
  for (const vehicle of members.filter(unit=>unit.type==='mcv' && !unit.goal)) {
    if (yards.length && vehicle.expansion && (!vehicle.expansionSite ||
        distanceTo(vehicle,vehicle.expansionSite)>.4)) {
      if (game.time<(vehicle.nextSiteSearch??0)) continue;
      vehicle.nextSiteSearch=game.time+5;
      const destination=expansionSite(faction,vehicle,yards);
      if (destination && setCourse(destination,'expand',vehicle)) {
        vehicle.expansionSite=destination;
        log(factionName(faction.team)+'基地车前往新基地位置。',faction.team);
      }
      continue;
    }
    if (deployYard(vehicle)) {
      log(factionName(faction.team)+(yards.length?'开始部署新建造场。':'基地车开始部署。'),faction.team);
      faction.expanding=false;
    } else {
      vehicle.expansionSite=null;
      const fallback=yards.length?expansionSite(faction,vehicle,yards):
        forestDestination({x:Math.round(vehicle.x)+3,y:Math.round(vehicle.y)+2},vehicle)?.target;
      if (fallback && setCourse(fallback,'expand',vehicle)) vehicle.expansionSite=fallback;
    }
  }
}

function baseFacilities(yard,yards,buildings) {
  const center=yardCenter(yard);
  return buildings.filter(building=>distanceTo(yardCenter(building),center)<=BUILD_RADIUS &&
    yards.every(other=>other===yard ||
      distanceTo(yardCenter(building),yardCenter(other))>=distanceTo(yardCenter(building),center)));
}

function developOutposts(faction,yards,buildings) {
  for (const yard of yards.slice(1)) {
    if (!readyYard(yard,faction.team)) continue;
    const local=baseFacilities(yard,yards,buildings);
    const plan=baseBuildPlan.find(entry=>!local.some(building=>building.type===entry.type));
    if (plan) placeAiBuilding(plan,yard,faction.team);
  }
}

function planExpansion(faction,yards,members,factory,army) {
  if (!factory || factory.remaining ||
      members.some(unit=>unit.type==='mcv') || structures.some(building=>building.team===faction.team &&
        building.type==='factory' && building.queue.some(job=>job.type==='mcv'))) return false;
  if (!yards.length) {
    enqueue(factory,'mcv');
    return factory.queue.length===0;
  }
  if (faction.defensive || faction.orders.mode==='guard') return false;
  const healthyBase=army.length>=4;
  if (!healthyBase && !faction.expanding) return false;
  if (!faction.expanding && game.time>=faction.nextExpansionPlan && faction.credits>=1250) {
    faction.nextExpansionPlan=game.time+12;
    const exit=spawnPoint(factory,false);
    if (exit) faction.expanding=Boolean(expansionSite(faction,{...exit,type:'mcv',team:faction.team},yards));
  }
  if (!faction.expanding) return false;
  if (faction.credits>=PRODUCTS.mcv.cost+480 && enqueue(factory,'mcv')) {
    faction.expanding=false;
    log(factionName(faction.team)+'开始生产新的基地车，耗资 '+PRODUCTS.mcv.cost+'。',faction.team);
    return false;
  }
  return true;
}

function mountHorse(rider,horse) {
  const index=units.indexOf(horse);
  if (index<0 || horse.health<=0 || rider.team!==horse.team || rider.type!=='cavalry' ||
      distanceTo(rider,horse)>1.46 || !groundPathOpen(rider.x,rider.y,horse.x,horse.y)) return false;
  units.splice(index,1);
  horse.health=0;
  clearAttackOrder(rider);
  rider.mountTarget=null;
  rider.type='mountedCavalry';
  rider.label='骑兵（已上马）';
  rider.speed=MOUNTED_SPEED;
  rider.health=Math.round(WEAPONS.mountedCavalry.health*rider.health/WEAPONS.cavalry.health);
  rider.vision=6.3;
  if (game.selection.includes(horse)) select(game.selection.filter(unit=>unit!==horse));
  log(factionName(rider.team)+'骑兵已上马。',rider.team);
  return true;
}

function advanceMounts(faction,members) {
  const horses=members.filter(unit=>unit.type==='horse' && unit.health>0);
  const enlisted=members.filter(unit=>unit.type==='cavalry');
  const reserved=new Set(enlisted.map(rider=>rider.mountTarget).filter(Boolean));
  for (const rider of enlisted) {
    let horse=rider.mountTarget;
    if (!horse || horse.health<=0 || !horses.includes(horse)) {
      horse=horses.filter(candidate=>!reserved.has(candidate) && candidate.health>0)
        .sort((a,b)=>distanceTo(rider,a)-distanceTo(rider,b))[0];
    }
    if (!horse) {
      rider.mountTarget=null;
      if (rider.goal?.kind==='mount') clearAttackOrder(rider);
      continue;
    }
    if (mountHorse(rider,horse)) continue;
    if (rider.goal?.kind==='mount' && rider.mountTarget===horse) continue;
    if (game.time<(rider.nextMountSearch??0)) continue;
    rider.nextMountSearch=game.time+2.4;
    const x=Math.round(horse.x),y=Math.round(horse.y);
    const neighbors=NEIGHBORS.map(([dx,dy])=>({x:x+dx,y:y+dy}));
    neighbors.sort((a,b)=>distanceTo(rider,a)-distanceTo(rider,b));
    const reachable=neighbors.find(tile=>distanceTo(tile,horse)<=1.46 && faction.explored.has(tileKey(tile.x,tile.y)) &&
      walkable(tile.x,tile.y) && !unitPositionBlocked(rider,tile.x,tile.y) && findPath(tile,rider));
    if (reachable && setCourse(reachable,'mount',rider)) {
      rider.mountTarget=horse;
      reserved.add(horse);
    }
  }
}

function transportDropPoint(carrier,objective,faction) {
  const distance=distanceTo(carrier,objective);
  if (distance<7) return null;
  const x=Math.round(mix(objective.x,carrier.x,4/distance));
  const y=Math.round(mix(objective.y,carrier.y,4/distance));
  const candidates=[];
  for (let dx=-2;dx<=2;dx++) {
    for (let dy=-2;dy<=2;dy++) {
      const point={x:x+dx,y:y+dy};
      if (distanceTo(point,objective)<3 || !faction.explored.has(tileKey(point.x,point.y)) ||
          !walkable(point.x,point.y) || unitPositionBlocked(carrier,point.x,point.y)) continue;
      candidates.push(point);
    }
  }
  return candidates.sort((a,b)=>Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y))[0]??null;
}

function directSpecialAircraft(faction,members,intelligence,raid) {
  const {contacts,frontier}=intelligence;
  const {mode,task,target}=faction.orders;
  const assigned=mode==='assault' && contacts.includes(target)?target:null;
  const raider=raid?.critical && contacts.includes(raid.attacker)?raid.attacker:null;
  const groundTarget=[assigned,raider].find(contact=>contact && !isAirborne(contact));
  const strikeOrder=groundTarget===assigned?(faction.commander.plan??assigned):raid;
  const objective=groundTarget?(groundTarget.width?yardCenter(groundTarget):groundTarget):
    raid?.critical?raid.point:task==='advance'?faction.commander.plan?.point:null;
  for (const aircraft of members) {
    if (aircraft.type==='reconPlane') {
      if (aircraft.goal) continue;
      const plan=faction.commander.plan;
      if (plan?.task==='recon' && sendScout(aircraft,plan.target,'scout')) {
        faction.searched.set(plan.target,game.time);
        plan.scout=aircraft;
      } else searchBattlefield(faction,aircraft,frontier,'scout');
    } else if (aircraft.type==='bomber') {
      if (groundTarget && aircraft.mode==='parked' && aircraft.lastStrikeOrder!==strikeOrder &&
          orderAttack([aircraft],groundTarget)) aircraft.lastStrikeOrder=strikeOrder;
    } else if (aircraft.type==='helicopter' && objective && !aircraft.goal && !aircraft.passengers.length) {
      const drop=transportDropPoint(aircraft,objective,faction);
      if (!drop) continue;
      const candidates=members.filter(unit=>canTransport(aircraft,unit) && !unit.engaged && !unit.captureTarget &&
        distanceTo(unit,objective)>7).sort((a,b)=>distanceTo(a,aircraft)-distanceTo(b,aircraft));
      if (!candidates.length) continue;
      for (const unit of candidates) {
        if (distanceTo(aircraft,unit)>2.4 || aircraft.passengers.length>=HELICOPTER_CAPACITY) break;
        boardTransport(aircraft,unit);
      }
      if (aircraft.passengers.length) {
        setFlightCourse(aircraft,drop,'drop');
        aircraft.mode='transporting';
        log(factionName(aircraft.team)+'运输直升机搭载 '+aircraft.passengers.length+' 个单位起飞。',aircraft.team);
      } else if ((aircraft.altitude??0)<=2) {
        const passenger=candidates[0];
        setFlightCourse(aircraft,{x:passenger.x,y:passenger.y},'pickup');
        aircraft.mode='pickup';
      }
    }
  }
}

function reserveForPriorityAircraft(faction,yards,airport,members,hasIncome) {
  const orders=faction.priorityAircraft;
  while (orders?.length && members.some(unit=>unit.type===orders[0])) orders.shift();
  if (orders && !orders.length) delete faction.priorityAircraft;
  if (faction.priorityFighter && members.some(unit=>unit.type==='fighter')) delete faction.priorityFighter;
  const type=orders?.[0]??(faction.priorityFighter?'fighter':null);
  if (!type) return false;
  if (airport) {
    if (airport.queue.length) return Boolean(orders?.length);
    if (airport.remaining===0 && enqueue(airport,type)) {
      log(factionName(faction.team)+'机场开始生产优先调度的'+PRODUCTS[type].label+'。',faction.team);
      return Boolean(orders?.length);
    }
    return hasIncome;
  }
  const ready=yards.filter(yard=>readyYard(yard,faction.team));
  if (!ready.length) return false;
  if (faction.credits>=BUILDINGS.airport.cost && game.time>=(faction.nextAirportSiteCheck??0)) {
    faction.nextAirportSiteCheck=game.time+2;
    ready.some(yard=>placeAiBuilding({type:'airport',x:5,y:-4},yard,faction.team));
  }
  return hasIncome;
}

function advanceFaction(faction) {
  const {team}=faction;
  if (game.time<faction.nextOrder) return;
  faction.nextOrder=game.time+.55;
  const buildings=structures.filter(building=>building.team===team && building.health>0);
  const members=units.filter(unit=>unit.team===team && unit.health>0);
  const yards=buildings.filter(building=>building.type==='yard');
  const yard=yards[0];
  deployBaseVehicles(faction,members,yards);
  const local=yard?baseFacilities(yard,yards,buildings):buildings;
  const refinery=buildings.find(building=>refineryReady(building,team));
  const factories=buildings.filter(building=>building.type==='factory');
  const idleFactories=factories.filter(building=>!building.remaining && !building.queue.length);
  const factory=idleFactories[0]??factories.find(building=>!building.remaining);
  const barracks=buildings.find(building=>building.type==='barracks');
  const airport=buildings.find(building=>building.type==='airport');
  const army=members.filter(unit=>isArmyType(unit.type));
  refreshVision(faction,members,buildings);
  const intelligence=scoutBattlefield(faction);
  assessStrength(faction,army,intelligence.contacts,yard??factory??barracks??refinery);
  const raid=urgentRaid(faction,intelligence.contacts);
  const hasIncome=Boolean(refinery && (refinery.pendingGift || members.some(unit=>unit.type==='miner'))) ||
    buildings.some(building=>building.type==='oil');
  const reservingAircraft=reserveForPriorityAircraft(faction,yards,airport,members,hasIncome);
  const rushingDefenses=!reservingAircraft && raid?.critical && rushDefenses(faction,yards,buildings,intelligence.contacts,raid);
  if (!raid?.critical) advanceMounts(faction,members);
  reviewCommander(faction,army,buildings,members,intelligence,raid);
  directSpecialAircraft(faction,members,intelligence,raid);
  directAiArmy(faction,army.filter(unit=>unit.type!=='bomber' && !unit.embarked),buildings,intelligence,raid);
  if (reservingAircraft) {
    advanceAiCapture(faction,barracks,members,false);
    return;
  }
  if (barracks && !barracks.queue.length && openingReconAllowed(faction,intelligence,raid) &&
      !army.some(isFastScout)) enqueue(barracks,'dog');
  const fleet=miningFleet(faction,buildings,members);
  const supplied=fleet.active+fleet.ordered;
  const earlyInvestment=game.time<150 && supplied<2;
  const safeToInvest=!raid?.critical && !faction.defensive &&
    faction.orders.mode!=='assault' && (earlyInvestment || faction.orders.task==='mine');
  const fleetTarget=safeToInvest?(earlyInvestment?2:fleet.desired):1;
  let savingForEarlyMiner=safeToInvest && earlyInvestment && supplied===1 && Boolean(refinery);
  if (refinery && factory && !factory.queue.length && supplied<fleetTarget &&
      (supplied<2 || faction.credits>=PRODUCTS.miner.cost+PRODUCTS.soldier.cost)) {
    if (enqueue(factory,'miner')) {
      savingForEarlyMiner=false;
      if (supplied>0) log(factionName(team)+'为扩大采矿收入增产矿车。',team);
    }
  }
  const nextBase=baseBuildPlan.find(plan=>!local.some(b=>b.type===plan.type));
  if (yard?.remaining===0 && nextBase && (nextBase.type==='refinery' || refinery)) {
    placeAiBuilding(nextBase,yard,team);
  }
  const plan=faction.commander.plan;
  const aircraft=members.filter(isAirborne);
  const airProduct=!aircraft.some(unit=>unit.type==='reconPlane') && intelligence.frontier.length && !intelligence.contacts.length?
    'reconPlane':!aircraft.some(unit=>unit.type==='bomber') && intelligence.contacts.some(contact=>contact.width)?
    'bomber':!aircraft.some(unit=>unit.type==='fighter')?'fighter':
    !aircraft.some(unit=>unit.type==='helicopter')?'helicopter':'fighter';
  const developingAir=plan?.task==='airpower' && !raid?.critical && !faction.defensive;
  if (developingAir && !airport && yard?.remaining===0 && !nextBase &&
      faction.credits>=BUILDINGS.airport.cost+PRODUCTS.soldier.cost) {
    if (placeAiBuilding({type:'airport',x:5,y:-4},yard,team)) {
      log(factionName(team)+'开始建设机场。',team);
    }
  }
  if (!raid?.critical && !faction.defensive && airport?.remaining===0 && !airport.queue.length &&
      aircraft.length<(army.length>=6?3:1) && (developingAir || faction.credits>=PRODUCTS[airProduct].cost+450)) {
    enqueue(airport,airProduct);
  }
  const savingForAir=developingAir && !aircraft.length && !airport?.queue.length;
  if (!raid?.critical && !faction.defensive && plan?.task==='industry' && factories.length<plan.goal &&
      faction.credits>=BUILDINGS.factory.cost+PRODUCTS.tank.cost) {
    if (yards.some(base=>readyYard(base,team) && placeAiBuilding({type:'factory',x:-5,y:-3},base,team))) {
      log(factionName(team)+'开工建设另一座兵工厂。',team);
    }
  }

  let savingForResearch=false;
  if (yard?.remaining===0) maintainPower(faction,yard,savingForEarlyMiner?PRODUCTS.miner.cost:0);
  if (!raid?.critical && !nextBase) developOutposts(faction,yards,buildings);
  const wantsExpansion=faction.orders.task==='mine' || (faction.credits>=2800 && faction.orders.mode==='develop');
  const savingForExpansion=!raid?.critical && (!yard || !nextBase && wantsExpansion) &&
    planExpansion(faction,yards,members,factory,army);
  const canBuildDefenses=yard?.remaining===0 && !nextBase && !savingForExpansion;
  if (!raid?.critical && !savingForEarlyMiner && !savingForAir && canBuildDefenses) {
    if (faction.orders.task==='fortify' || faction.defensive) buildDefenses(faction,yard,buildings,intelligence.contacts);
    if (!faction.defensive && army.length>=2 && game.time>=52 && faction.credits>=1000) {
      buildSupportFacilities(faction,yard,buildings);
    }
    if (!faction.defensive && (faction.orders.task==='research' || faction.credits>=950)) {
      savingForResearch=planResearch(faction,yard,faction.orders.task==='research');
    }
  }

  // Fund the first army before adding optional specialist equipment.
  const buildingArmy=buildings.some(b=>b.queue.some(job=>isArmyType(job.type)));
  const advanced=Object.values(TECHNOLOGIES).map(design=>design.unit)
    .find(type=>type && faction.discoveries.has(PRODUCTS[type].tech) && !members.some(unit=>unit.type===type) &&
      !factories.some(site=>site.queue.some(job=>job.type===type)));
  const savingForPrototype=!raid?.critical && !faction.defensive && advanced && factory && !factory.queue.length &&
    faction.credits<PRODUCTS[advanced].cost;
  const mayTrain=raid?.critical || (!nextBase && !savingForEarlyMiner && !savingForAir &&
    !savingForResearch && !savingForPrototype && !savingForExpansion) ||
    (!army.length && !buildingArmy);
  advanceAiCapture(faction,barracks,members,mayTrain && !raid?.critical);
  if (mayTrain) {
    const scouts=intelligence.contacts;
    const hostileArmor=scouts.filter(unit=>!unit.width && WEAPONS[unit.type] && armoredTarget(unit)).length;
    const hostileInfantry=scouts.filter(unit=>isPersonnel(unit)).length;
    const hostileAircraft=scouts.some(isAirborne);
    if (!raid?.critical && barracks && !barracks.queue.length && members.some(unit=>unit.type==='cavalry') &&
        !members.some(unit=>unit.type==='horse' && unit.health>0)) enqueue(barracks,'horse');
    let prototype=advanced;
    for (const site of idleFactories) {
      if (site.queue.length) continue;
      const siege=faction.orders.task==='strike' && BUILDINGS[faction.orders.target?.type]?.weapon;
      const vehicle=!raid?.critical && (siege || faction.vehicleMix%3===2)?'artillery':'tank';
      if (prototype && enqueue(site,prototype)) {
        prototype=null;
        faction.vehicleMix++;
      } else if (enqueue(site,vehicle) || enqueue(site,'tank')) {
        faction.vehicleMix++;
      }
    }
    if (barracks && !barracks.queue.length) {
      const rotation=['soldier','rocketeer','mortar','dog','cavalry'];
      const infantry=raid?.critical || hostileAircraft || hostileArmor>hostileInfantry?'rocketeer':
        hostileInfantry>=3 && faction.unitMix%3===0?'dog':rotation[faction.unitMix%rotation.length];
      if (enqueue(barracks,infantry) || enqueue(barracks,'soldier')) {
        faction.unitMix++;
      }
    }
  }

  if (raid?.critical && canBuildDefenses && !rushingDefenses) buildDefenses(faction,yard,buildings,intelligence.contacts);
}

function distanceTo(a,b) {
  return Math.hypot(a.x-b.x,a.y-b.y);
}

function nearestOpponent(unit,opponents,range) {
  let best=null, nearest=range;
  for (const other of opponents) {
    if (other.team===unit.team) continue;
    const distance=distanceTo(unit,targetPoint(unit,other));
    if (distance<=nearest) {
      best=other;
      nearest=distance;
    }
  }
  return best;
}

function targetPoint(from,target) {
  if (!target.width) return target;
  return {
    x:Math.max(target.x-.4,Math.min(target.x+target.width-.6,from.x)),
    y:Math.max(target.y-.4,Math.min(target.y+target.height-.6,from.y)),
  };
}

function orderAttack(members,target,automatic=false) {
  if (!(target.health>0)) return 0;
  let ordered=0;
  for (const unit of members) {
    if (!WEAPONS[unit.type] || unit.team===target.team || !canAttackTarget(unit,target) ||
        !canSeeEntity(FACTIONS[unit.team],target)) continue;
    if (unit.type==='bomber') {
      if (automatic || unit.mode!=='parked' || game.time<(unit.readyForSortie??0) || target.team==='neutral') continue;
      unit.attackTarget=target;
      unit.mode='bombing';
      setFlightCourse(unit,targetPoint(unit,target),'bomb');
      log(factionName(unit.team)+'轰炸机出动，目标为'+(target.width?buildingSpec(target.type).label:target.label)+'。',unit.team);
      ordered++;
      continue;
    }
    unit.attackTarget=target;
    unit.automaticAttack=automatic;
    unit.nextApproach=0;
    if (unit.type==='miner') unit.returnTo=null;
    if (unit.type==='dog' && (unit.team==='player' || visible(unit.x,unit.y))) playAt('bark',unit);
    unit.route=[];
    unit.goal=null;
    unit.mode='idle';
    ordered++;
  }
  return ordered;
}

function clearAttackOrder(unit) {
  unit.attackTarget=null;
  unit.route=[];
  unit.goal=null;
  unit.mode='idle';
}

function advanceAttackOrders(fighters) {
  const approaches=new Map(Object.keys(FACTIONS).map(team=>[team,new Map()]));
  for (const unit of fighters) if (unit.goal?.kind==='attack' || unit.goal?.kind==='reinforce') {
    const slots=approaches.get(unit.team);
    const key=tileKey(unit.goal.x,unit.goal.y);
    if (!slots.has(key)) slots.set(key,unit);
  }
  for (const unit of fighters) {
    const target=unit.attackTarget;
    if (!target) continue;
    const leavesPursuit=unit.automaticAttack && distanceTo(unit,target)>WEAPONS.dog.pursuit+1;
    if (target.health<=0 || target.team===unit.team || leavesPursuit || !canAttackTarget(unit,target) ||
        !canSeeEntity(FACTIONS[unit.team],target)) {
      clearAttackOrder(unit);
      continue;
    }

    const weapon=WEAPONS[unit.type];
    const {range}=weapon;
    if (inWeaponRange(unit,target,weapon)) {
      unit.route=[];
      unit.goal=null;
      unit.mode='idle';
      continue;
    }
    if (unit.goal && approaches.get(unit.team).get(tileKey(unit.goal.x,unit.goal.y))===unit &&
        inWeaponRange(unit.goal,target,weapon) &&
        !unitPositionBlocked(unit,unit.goal.x,unit.goal.y,true)) continue;
    if (game.time<unit.nextApproach) continue;
    unit.nextApproach=game.time+.85;

    const point=targetPoint(unit,target);
    const approachRange=range-(unit.type==='dog'?.08:.28);
    const candidates=[];
    for (let x=Math.ceil(point.x-range);x<=Math.floor(point.x+range);x++) {
      for (let y=Math.ceil(point.y-range);y<=Math.floor(point.y+range);y++) {
        const tile={x,y};
        const used=approaches.get(unit.team).get(tileKey(x,y));
        if ((used && used!==unit) || !FACTIONS[unit.team].explored.has(tileKey(x,y)) ||
            !(isAirborne(unit)?onMap(x,y):walkable(x,y)) || !inWeaponRange(tile,target,weapon) ||
            distanceTo(tile,targetPoint(tile,target))>approachRange) continue;
        candidates.push(tile);
      }
    }
    candidates.sort((a,b)=>distanceTo(a,unit)-distanceTo(b,unit));
    const approached=candidates.some(tile=>{
      if (unitPositionBlocked(unit,tile.x,tile.y,true)) return false;
      const path=findPath(tile,unit);
      if (!path?.length || !setCourse(tile,'attack',unit,path)) return false;
      approaches.get(unit.team).set(tileKey(tile.x,tile.y),unit);
      return true;
    });
    if (!approached) {
      unit.blockedAttackTarget=target;
      unit.attackRetryTime=game.time+8;
      clearAttackOrder(unit);
    }
  }
}

function inWeaponRange(from,target,weapon) {
  const distance=distanceTo(from,targetPoint(from,target));
  return distance<=weapon.range && distance>=(weapon.minimum??0);
}

function armoredTarget(target) {
  return Boolean(target.width || VEHICLE_CONTACT_RADIUS[target.type]);
}

function canAttackTarget(attacker,target) {
  if (attacker.type==='reconPlane' || attacker.type==='helicopter') return false;
  return !isAirborne(target) || AIR_TARGETING.has(attacker.type);
}

function defenseOf(target) {
  if (!target.width) return WEAPONS[target.type]?.defense??0;
  const spec=buildingSpec(target.type);
  const defense=spec.defense??0;
  return defense && target.remaining?defense*Math.max(0,1-target.remaining/spec.time):defense;
}

function damageAfterDefense(target,damage) {
  return Math.max(1,Math.round(damage*(1-defenseOf(target))));
}

function weaponDamage(unit,weapon) {
  return weapon.damage*(1+(unit.rank??0)*RANK_DAMAGE_BONUS);
}

function promoteAfterKill(unit) {
  const rank=unit.rank??0;
  if (unit.health<=0 || unit.width || !WEAPONS[unit.type] || rank>=MAX_UNIT_RANK) return;
  unit.rank=rank+1;
  log(factionName(unit.team)+unit.label+'晋升至 '+unit.rank+' 级，攻击力 +'+
    Math.round(unit.rank*RANK_DAMAGE_BONUS*100)+'%。',unit.team);
}

function fireWeapon(attacker,from,weapon,target,hits) {
  if (game.time<(attacker.nextShot??0)) return;
  const faction=FACTIONS[attacker.team];
  const efficiency=attacker.width?faction.power.rate:faction.support.fireRate;
  const damage=weaponDamage(attacker,weapon)*(attacker.width?1:faction.support.damage);
  attacker.nextShot=game.time+weapon.reload/efficiency;
  const point=targetPoint(from,target);
  const effect=weapon.effect??(attacker.type==='tank' || attacker.type==='dog'?attacker.type:'bullet');
  const barrel=attacker.type==='tank'?.80:0;
  const heading=attacker.turretHeading??attacker.heading??0;
  const originX=from.x+Math.cos(heading)*barrel,originY=from.y+Math.sin(heading)*barrel;
  let origin=isAirborne(attacker)?project(originX,originY,unitElevation(attacker)+weapon.height):
    projectGround(originX,originY,weapon.height);
  if (effect==='laser') {
    const art=structureArt(attacker);
    origin={x:art.left+art.width*.68,y:art.top+art.height*.245};
  }
  const height=target.width ? Math.min(32,buildingSpec(target.type).body*.62) :
    (WEAPONS[target.type]?.height??UNIT_ART[target.type].hitHeight*.72)*.70;
  const witnesses=Object.values(FACTIONS).filter(faction=>canSeeEntity(faction,attacker) &&
    canSeeEntity(faction,target)).map(faction=>faction.team);
  if (witnesses.length) {
    const impact=isAirborne(target)?project(point.x,point.y,unitElevation(target)+height):
      projectGround(point.x,point.y,height);
    shots.push({from:origin,to:impact,time:game.time,type:effect,team:attacker.team,witnesses});
    if (ENGINE_ONLY || witnesses.includes(game.perspective)) {
      const cue={dog:'bark',bullet:'rifle',mortar:'mortar',artillery:'mortar',rocket:'rocket',
        bomb:'explosion',laser:'laser'}[effect]??'cannon';
      playAt(cue,from,attacker);
    }
  }
  const multiplier=armoredTarget(target)?(weapon.armorFactor??(effect==='dog'?1/3:1)):(weapon.softFactor??1);
  hits.push({target,attacker,damage:damageAfterDefense(target,damage*multiplier)});
  if (weapon.splash) {
    for (const other of [...units,...structures]) {
      if (other===target || other.team===attacker.team || other.team==='neutral' || other.health<=0 ||
          isAirborne(other)!==isAirborne(target)) continue;
      const distance=distanceTo(point,targetPoint(point,other));
      if (distance>weapon.splash) continue;
      const splash=damage*(.68-.33*distance/weapon.splash);
      hits.push({target:other,attacker,damage:damageAfterDefense(other,splash)});
    }
  }
  return true;
}

function advanceBombSortie(unit,hits) {
  const target=unit.attackTarget;
  if (unit.mode!=='bombing') return;
  if (!target || target.health<=0 || target.team===unit.team || target.team==='neutral' ||
      !canAttackTarget(unit,target) || !canSeeEntity(FACTIONS[unit.team],target)) {
    returnBomber(unit);
    return;
  }
  const weapon=WEAPONS.bomber;
  if (inWeaponRange(unit,target,weapon) && unitElevation(unit)>=JET_ALTITUDE*.70) {
    if (fireWeapon(unit,unit,weapon,target,hits)) {
      returnBomber(unit);
      log(factionName(unit.team)+'轰炸机已投弹，正在返航。',unit.team);
    }
    return;
  }
  const point=targetPoint(unit,target);
  if (!unit.goal || distanceTo(unit.goal,point)>.65) setFlightCourse(unit,point,'bomb');
}

function advanceCombat(dt=.04) {
  if (game.outcome) return;
  const mobile=units.filter(unit=>unit.health>0);
  const fighters=mobile.filter(unit=>WEAPONS[unit.type]);
  const regularFighters=fighters.filter(unit=>unit.type!=='bomber');
  const combatTargets=mobile.filter(unit=>WEAPONS[unit.type] || isAirborne(unit));
  const infantry=mobile.filter(isPersonnel);
  const engineers=mobile.filter(unit=>unit.type==='engineer');
  for (const dog of fighters) {
    if (dog.type!=='dog' || dog.attackTarget || dog.rescueTarget || dog.goal?.kind==='scout' ||
        FACTIONS[dog.team].defensive) continue;
    const known=infantry.filter(unit=>canSeeEntity(FACTIONS[dog.team],unit));
    const prey=nearestOpponent(dog,known,WEAPONS.dog.pursuit);
    if (prey) orderAttack([dog],prey,true);
  }
  advanceAttackOrders(regularFighters);
  const hits=[];
  for (const unit of fighters) if (unit.type==='bomber') advanceBombSortie(unit,hits);
  for (const unit of regularFighters) {
    const weapon=WEAPONS[unit.type];
    const faction=FACTIONS[unit.team];
    const candidates=unit.type==='dog'?infantry:combatTargets;
    const eligible=candidates.filter(target=>target.team!==unit.team && canAttackTarget(unit,target) && canSeeEntity(faction,target) &&
      (!weapon.minimum || inWeaponRange(unit,target,weapon)));
    const ordered=unit.attackTarget;
    const target=ordered && inWeaponRange(unit,ordered,weapon) ? ordered :
      nearestOpponent(unit,eligible,weapon.range) || (unit.type!=='dog' &&
        nearestOpponent(unit,engineers.filter(target=>canSeeEntity(faction,target) &&
          inWeaponRange(unit,target,weapon)),weapon.range));
    unit.engaged=Boolean(target);
    if (!target) {
      if (unit.type==='miner') unit.aim=undefined;
      if (unit.type==='tank') unit.turretAim=undefined;
      continue;
    }
    const point=targetPoint(unit,target);
    const heading=Math.atan2(point.y-unit.y,point.x-unit.x);
    if (unit.type==='tank') {
      unit.turretAim=heading;
      if (Math.abs(angleDifference(heading,unit.turretHeading??unit.heading))>.24) continue;
    } else if (unit.mode==='idle') {
      turnTowards(unit,heading,motionFor(unit).turnRate,dt);
    }
    if (unit.type==='miner') unit.aim=heading;
    fireWeapon(unit,unit,weapon,target,hits);
  }
  for (const defense of structures) {
    const spec=BUILDINGS[defense.type];
    if (!spec?.weapon || defense.remaining>0 || defense.health<=0) continue;
    const center={...yardCenter(defense),team:defense.team};
    const known=mobile.filter(unit=>unit.team!==defense.team && canAttackTarget(defense,unit) &&
      canSeeEntity(FACTIONS[defense.team],unit));
    const preferred=known.filter(unit=>armoredTarget(unit)===(spec.priority==='armor'));
    const target=nearestOpponent(center,preferred,spec.weapon.range) ||
      nearestOpponent(center,known,spec.weapon.range);
    if (target) fireWeapon(defense,center,spec.weapon,target,hits);
  }

  if (hits.length && !game.firstEngagement) {
    game.firstEngagement=true;
    log('战斗已开始。');
    notice('战斗已开始');
  }
  const creditedKills=[];
  for (const {target,damage,attacker} of hits) {
    if (target.health<=0) continue;
    target.health-=damage;
    if (target.width) target.lastDamageTime=game.time;
    if (damage>0) recordRaid(attacker,target);
    if (target.health<=0 && target.team!=='neutral' && target.team!==attacker.team) creditedKills.push(attacker);
  }
  for (const unit of creditedKills) promoteAfterKill(unit);
  let buildingsDestroyed=false;
  const priorPower=new Map();
  for (const list of [units,structures]) {
    for (let i=list.length-1;i>=0;i--) {
      const target=list[i];
      if (!(target.health<=0)) continue;
      list.splice(i,1);
      if (list===structures) {
        buildingsDestroyed=true;
        const affected=FACTIONS[target.team];
        if (affected && BUILDINGS[target.type]?.powerOutput && !target.remaining) {
          priorPower.set(affected,affected.power.rate);
        }
      }
      const x=target.x+(target.width?((target.width-1)/2):0);
      const y=target.y+(target.height?((target.height-1)/2):0);
      const name=target.width?buildingSpec(target.type).label:target.label;
      const witnesses=Object.values(FACTIONS).filter(faction=>canSeeEntity(faction,target)).map(faction=>faction.team);
      if (witnesses.length) {
        const big=target.width || Boolean(VEHICLE_CONTACT_RADIUS[target.type]);
        wrecks.push({x,y,time:game.time,big,building:target.width?target:null,witnesses});
        if (big) playAt('explosion',{x,y},target);
        for (const team of witnesses) {
          const faction=FACTIONS[team];
          faction.commander.confirmedLosses.add(target);
          if (faction.commander.plan?.target===target) faction.commander.nextReview=0;
          const report=faction.reports.get(target);
          if (report) {
            faction.retreatBenchmark=Math.max(0,faction.retreatBenchmark-report.power);
            faction.reports.delete(target);
          }
          log((target.team==='neutral'?'中立':factionName(target.team))+name+
            (target.runOver?'被车辆碾压。':'被摧毁。'),team);
        }
      }
      if (target===game.selectedBuilding) select([]);
    }
  }
  if (buildingsDestroyed) refreshPowerGrids();
  for (const [faction,previous] of priorPower) {
    if (faction.power.rate<previous) {
      log(factionName(faction.team)+'电厂被毁，供电降至 '+Math.round(faction.power.rate*100)+'%。',faction.team);
    }
  }
  if (game.selection.some(unit=>unit.health<=0)) select(game.selection.filter(unit=>!(unit.health<=0)));
  while (shots.length && game.time-shots[0].time>.42) shots.shift();
  while (wrecks.length && game.time-wrecks[0].time>3.0) wrecks.shift();
  checkMatchResult();
}

function checkMatchResult() {
  const defeated=Object.keys(FACTIONS).filter(team=>
    !units.some(unit=>unit.team===team && unit.health>0) &&
    !structures.some(building=>building.team===team && building.health>0));
  if (!defeated.length) return;
  const outcome=defeated.length===2?'draw':defeated[0]==='enemy'?'player':'enemy';
  game.outcome=outcome;
  game.follow=null;
  pressed.clear();
  if (!ENGINE_ONLY) showMatchResult(outcome);
}

function showMatchResult(outcome) {
  const [title,description]={
    player:['蓝方获胜','红方已失去所有建筑和活动单位。'],
    enemy:['红方获胜','蓝方已失去所有建筑和活动单位。'],
    draw:['平局','双方均已失去所有建筑和活动单位。'],
  }[outcome];
  byId('match-title').textContent=title;
  byId('match-summary').textContent=description;
  matchResult.dataset.outcome=outcome;
  if (byId('help').open) byId('help').close();
  if (!matchResult.open) matchResult.show();
  sound.play(outcome==='player'?'ready':'alert');
}

function hostileMarker(context,p,size) {
  shape(context,[[p.x-size,p.y-3],[p.x+size,p.y-3],[p.x,p.y+3]],
    '#e58b71','#422e27',1);
}

function drawHealth(point,entity,max,width) {
  const ratio=Math.max(0,entity.health/max);
  ctx.fillStyle='#1c251df1';
  ctx.fillRect(point.x-width/2,point.y,width,5);
  ctx.fillStyle=entity.team==='enemy'?'#e48064':ratio>.36?'#b3cf86':'#e4b16b';
  ctx.fillRect(point.x-width/2+1,point.y+1,(width-2)*ratio,3);
}

function drawUnitStatus(unit) {
  const point=project(unit.x,unit.y,UNIT_ART[unit.type].hitHeight+7+unitElevation(unit));
  const hp=unit.type==='mcv'?MCV_HEALTH:WEAPONS[unit.type]?.health??PRODUCTS[unit.type]?.health;
  if (game.hoverTarget===unit || game.selection.some(member=>member.attackTarget===unit)) {
    const ground=project(unit.x,unit.y,unitElevation(unit));
    diamondAt(ctx,ground,UNIT_ART[unit.type].bracket,UNIT_ART[unit.type].small?8:16,
      '#ed98731a','#ef987a',1.5);
  }
  if (unit.team==='enemy') hostileMarker(ctx,point,5);
  if (viewFaction().scentTargets.has(unit)) {
    ctx.fillStyle='#ffdc88';
    ctx.beginPath();ctx.arc(point.x+10,point.y,2.3,0,Math.PI*2);ctx.fill();
  }
  if (hp && (unit.team==='enemy' || unit.health<hp || game.selection.includes(unit))) {
    drawHealth({x:point.x,y:point.y-7},unit,hp,UNIT_ART[unit.type].small?19:27);
  }
  const rank=unit.rank??0;
  for (let i=0;i<rank;i++) {
    const x=point.x+(i-(rank-1)/2)*7,y=point.y-13;
    shape(ctx,[[x-3,y],[x,y-4],[x+3,y],[x+3,y+2],[x,y-2],[x-3,y+2]],'#ffda82','#423620',.8);
  }
}

function drawCombat() {
  for (const {from,to,time,type,team,witnesses} of shots) {
    if (!witnesses.includes(game.perspective)) continue;
    const age=game.time-time;
    if (type==='laser') {
      if (age<.19) {
        const tint=team==='player'?'#69e8ff':'#ff8c77';
        const fade=1-age/.19;
        ctx.globalAlpha=fade*.40;
        stroke(ctx,from.x,from.y,to.x,to.y,tint,10);
        ctx.globalAlpha=fade*.87;
        stroke(ctx,from.x,from.y,to.x,to.y,tint,4);
        ctx.globalAlpha=fade;
        stroke(ctx,from.x,from.y,to.x,to.y,'#f7fcff',1.35);
        ctx.fillStyle=tint;
        ctx.beginPath();
        ctx.arc(to.x,to.y,2+age*15,0,Math.PI*2);
        ctx.fill();
      }
      continue;
    }
    const artillery=type==='artillery';
    const curved=type==='mortar' || artillery;
    const bomb=type==='bomb';
    const explosive=type==='tank' || type==='rocket' || curved || type==='pulse' || bomb;
    const flight=artillery?.29:bomb?.22:type==='mortar'?.19:type==='rocket'?.15:.08;
    const lifetime=(artillery || bomb) ? .42 : .28;
    if (age>=lifetime) continue;
    if (type!=='dog' && age<flight+.035) {
      const rate=Math.min(1,age/flight);
      const trail=Math.max(0,rate-.30);
      const arc=t=>curved?Math.sin(t*Math.PI)*(artillery?83:44):0;
      const lead={x:mix(from.x,to.x,rate),y:mix(from.y,to.y,rate)-arc(rate)};
      ctx.globalAlpha=1-age*4;
      stroke(ctx,mix(from.x,to.x,trail),mix(from.y,to.y,trail)-arc(trail),lead.x,lead.y,
        type==='pulse'?'#a7f5ff':team==='enemy'?'#f4a481':'#ffe0a0',explosive?2.5:1.15);
    }
    if (age>flight) {
      ctx.globalAlpha=Math.max(0,1-(age-flight)/(lifetime-flight));
      ctx.fillStyle=type==='pulse'?'#c4f9fc':explosive?'#ffbf70':'#ffdcb0';
      ctx.beginPath();
      ctx.arc(to.x,to.y,(artillery || bomb?17:curved?12:explosive?5:2)+(age-flight)*17,0,Math.PI*2);
      ctx.fill();
    }
  }
  for (const wreck of wrecks) {
    if (!wreck.witnesses.includes(game.perspective)) continue;
    const point=project(wreck.x,wreck.y);
    const age=game.time-wreck.time;
    ctx.globalAlpha=Math.max(0,1-age/3);
    shadow(ctx,point.x,point.y,wreck.big?26:12,7,.84);
    if (wreck.building) {
      const {x,y,width,height}=wreck.building;
      for (let i=0;i<9;i++) {
        const px=x-.28+hash(x+i,y,27)*(width-.45);
        const py=y-.28+hash(x,y+i,28)*(height-.45);
        const size=.19+hash(i,x+y,8)*.20;
        const rubble=3+hash(x+y,i,9)*7;
        cuboid(ctx,project,px,py,size,size*.8,0,rubble,['#7f7865','#48463d','#625849'],'#49473d');
      }
    }
    for (let i=0;i<5;i++) {
      const p=hash(i,3,61)-.5;
      const rise=age*(15+i*6);
      ctx.fillStyle=age<.28&&i%2?'#f3a669':'#5a6257';
      ctx.beginPath();
      ctx.arc(point.x+p*(10+rise),point.y-rise-6,(wreck.big?6:3)+rise*.1,0,Math.PI*2);
      ctx.fill();
    }
  }
  ctx.globalAlpha=1;
}

function repairPrice(building,amount) {
  const spec=buildingSpec(building.type);
  return Math.ceil(amount*(spec.cost??500)*.45/spec.health);
}

function advanceRepairs(dt) {
  const damaged=structures.filter(building=>building.team!=='neutral' && building.health>0 &&
    building.health<buildingSpec(building.type).health);
  damaged.sort((a,b)=>(b.lastDamageTime??-1)-(a.lastDamageTime??-1));
  for (const building of damaged) {
    const repair=building.repair??{remaining:REPAIR_INTERVAL,waiting:false};
    building.repair=repair;
    const spec=buildingSpec(building.type);
    const amount=Math.min(REPAIR_AMOUNT,spec.health-building.health);
    const cost=repairPrice(building,amount);
    const account=treasury(building.team);
    repair.waiting=account.credits<cost;
    if (repair.waiting) continue;
    repair.remaining-=dt;
    if (repair.remaining>0) continue;
    account.credits-=cost;
    building.health+=amount;
    if (building.health>=spec.health) {
      building.repair=null;
      playAt('ready',yardCenter(building),building);
      log(spec.label+'已修复。',building.team);
    } else {
      repair.remaining+=REPAIR_INTERVAL;
    }
  }
}

function positionBuildingMenu(building) {
  const {w,h}=viewport;
  const {x,y,width,height}=building;
  const center=project(camera.x,camera.y);
  const point=project(x+(width-1)/2,y+(height-1)/2,building.remaining>0?12:24);
  const sx=w/2+(point.x-center.x)*viewport.scale;
  const sy=h/2+(point.y-center.y)*viewport.scale;
  const popupWidth=buildingMenu.offsetWidth, popupHeight=buildingMenu.offsetHeight;
  const gap=U*(width+height)*.45*viewport.scale+8;
  const left=Math.max(8,Math.min(w-popupWidth-8,sx+gap+popupWidth<w-8?sx+gap:sx-gap-popupWidth));
  const radarFloor=left+popupWidth>w-radar.offsetWidth-24?radar.offsetHeight+20:8;
  const top=Math.max(8,Math.min(h-popupHeight-44,Math.max(radarFloor,sy-popupHeight*.42)));
  buildingMenu.style.left=Math.round(left)+'px';
  buildingMenu.style.top=Math.round(top)+'px';
}

function drawRange(center,radius,weapon=null) {
  const {x,y}=project(center.x,center.y);
  ctx.save();
  ctx.beginPath();
  ctx.rect(BOARD.left,BOARD.top,BOARD.right-BOARD.left,BOARD.bottom-BOARD.top);
  ctx.clip();
  ctx.beginPath();
  ctx.ellipse(x,y,radius*U*Math.SQRT2,radius*V*Math.SQRT2,0,0,Math.PI*2);
  if (weapon?.minimum) {
    const inner=weapon.minimum*U*Math.SQRT2;
    ctx.moveTo(x+inner,y);
    ctx.ellipse(x,y,inner,weapon.minimum*V*Math.SQRT2,0,0,Math.PI*2);
  }
  ctx.fillStyle=weapon?'#eabb611c':'#c5ed7218';
  ctx.strokeStyle=weapon?'#ffcb79d9':'#d5ec9bd0';
  ctx.lineWidth=1.8;
  ctx.setLineDash([8,6]);
  ctx.fill('evenodd');
  ctx.stroke();
  ctx.restore();
}

function weaponRangeLabel(weapon) {
  if (!weapon) return '—';
  return (weapon.minimum?weapon.minimum+'–':'')+weapon.range+' 格';
}

function syncBuildMenu() {
  const building=game.selectedBuilding;
  buildingMenu.hidden=!building;
  if (!building) return;
  const spec=buildingSpec(building.type);
  const job=building.team===game.perspective?building.queue[0]:null;
  const weapon=spec.weapon;
  let progress=null;
  let status='待命';
  if (building.remaining>0) {
    status='施工中 · '+building.remaining.toFixed(1)+' 秒';
    progress=(1-building.remaining/spec.time)*100;
  } else if (job) {
    const product=PRODUCTS[job.type];
    status=product.label+' · '+(job.remaining>0?(job.remaining/productionRate(building)).toFixed(1)+' 秒':'等待出口空出');
    progress=(1-job.remaining/product.time)*100;
  } else if (building.type==='oil') {
    status=building.team==='neutral'?'首占 +'+OIL_CAPTURE_BONUS+' · 满供电每 '+OIL_INTERVAL+' 秒 +'+OIL_INCOME:
      '下次收入 +'+Math.round(OIL_INCOME*incomeMultiplier(building.team,'oil')*FACTIONS[building.team].power.rate)+' · '+
      Math.max(0,Math.ceil(building.nextPayout-game.time))+' 秒';
  } else if (spec.powerOutput) {
    status='发电量 '+spec.powerOutput;
  } else if (spec.fireRateBonus || spec.damageBonus) {
    const bonus=spec.fireRateBonus??spec.damageBonus;
    const rate=building.team===game.perspective?FACTIONS[building.team].power.rate:1;
    status='活动单位'+(spec.fireRateBonus?'射速':'伤害')+' +'+Math.round(bonus*rate*100)+'%';
  } else if (building.type==='wall') {
    status='阻挡地面单位通行';
  } else if (weapon) {
    status='反击射程 '+weaponRangeLabel(weapon)+' · 优先攻击'+(spec.priority==='armor'?'装甲单位':'步兵与军犬');
  } else if (building.type==='refinery') {
    status='矿车返厂卸矿';
  } else if (building.type==='airport') {
    status='生产战斗机、轰炸机、侦察机和运输直升机';
  } else if (building.type==='yard') {
    status='建造半径 '+BUILD_RADIUS+' 格';
  }
  byId('building-name').textContent=buildingCaption(building);
  if (spec.powerUse && building.team===game.perspective && !building.remaining) {
    status+=' · 耗电 '+spec.powerUse;
  }
  if (spec.defense) status+=' · 防御减伤 '+Math.round(defenseOf(building)*100)+'%';
  if (building.type==='factory' && building.team===game.perspective && !building.remaining) {
    const bonus=Math.round(FACTIONS[building.team].factoryBonus*100);
    if (bonus) status+=' · 协同生产 +'+bonus+'%';
  }
  byId('production-status').textContent=status;
  const bar=byId('production-bar');
  bar.hidden=progress===null;
  if (progress!==null) bar.value=progress;
  const health=byId('repair-bar');
  health.max=spec.health;
  health.value=building.health;
  let repairStatus='';
  if (building.repair && building.team===game.perspective) {
    repairStatus=building.repair.waiting?' · 等待维修资金':' · 自动维修中';
  }
  byId('repair-status').textContent='耐久 '+Math.ceil(building.health)+' / '+spec.health+repairStatus;
  positionBuildingMenu(building);
}

function syncResearchHud() {
  for (const faction of Object.values(FACTIONS)) {
    const key=factionTint(faction.team);
    byId(key+'-research').parentElement.hidden=faction.team!==game.perspective;
    if (faction.team!==game.perspective) continue;
    const lines=[faction.strategy==='conservative'?'保守型':'进取型'];
    const plan=faction.commander.plan;
    lines.push((plan?commandLabel(plan):faction.orders.mode==='guard'?'紧急回援':'部署基地')+
      (faction.orders.source==='Codex'?'（Codex）':'（本地智能体）'));
    if (plan?.followup) lines.push('后续：'+commandLabel(plan.followup));
    if (plan?.homeReserve) lines.push('基地留守 '+plan.homeReserve+' 个作战单位');
    if (faction.factoryCount) {
      lines.push('兵工厂 '+faction.factoryCount+' 座'+(faction.factoryBonus?
        ' · 协同生产 +'+Math.round(faction.factoryBonus*100)+'%':''));
    }
    const buffs=[];
    if (faction.support.fireRate>1) buffs.push('射速 +'+Math.round((faction.support.fireRate-1)*100)+'%');
    if (faction.support.damage>1) buffs.push('伤害 +'+Math.round((faction.support.damage-1)*100)+'%');
    if (buffs.length) lines.push(buffs.join(' · '));
    if (faction.research) lines.push('未知'+faction.research.program.label+' · '+Math.ceil(faction.research.remaining)+' 秒');
    if (faction.manufacturing) lines.push(TECHNOLOGIES[faction.manufacturing.id].device+'制造中 · '+
      Math.ceil(faction.manufacturing.remaining)+' 秒');
    byId(key+'-research').textContent=lines.join(' / ') || '暂无进行中的项目';
    const list=byId(key+'-tech');
    const entries=[...faction.discoveries].map(id=>{
      const design=TECHNOLOGIES[id];
      return design.label+' · '+(design.description??(design.device+(faction.equipment.has(id)?
        '已投用，收入 +'+Math.round(design.bonus*100)+'%':'已解锁')));
    });
    const combined=entries.join('\n');
    if (list.dataset.entries===combined) continue;
    list.dataset.entries=combined;
    list.replaceChildren(...entries.map(content=>{
      const item=document.createElement('li');
      item.textContent=content;
      return item;
    }));
  }
}

function syncHud() {
  const labels={idle:'待命',moving:'行驶中',mining:'开采中',returning:'返航中',unloading:'卸矿中'};
  const unit=game.selected;
  const cargo=Math.min(CARGO_LIMIT,Math.floor((unit?.cargo??0)+.001));
  byId('credits').closest('.metric').hidden=game.perspective!=='player';
  byId('red-credits').closest('.metric').hidden=game.perspective!=='enemy';
  const budget=byId(game.perspective==='player'?'credits':'red-credits');
  budget.textContent=viewFaction().credits.toLocaleString('zh-CN');
  const power=viewFaction().power;
  byId('power').textContent=power.supply+' / '+power.demand;
  byId('power-label').textContent=power.rate<1?'供电不足 · '+Math.round(power.rate*100)+'%':'供电 / 负载';
  byId('power').parentElement.classList.toggle('power-low',power.rate<1);
  for (const team of ['player','enemy']) {
    const color=factionTint(team);
    const own=team===game.perspective;
    const visibleAndAlive=entity=>entity.team===team && entity.health>0 &&
      (own || canSeeEntity(viewFaction(),entity));
    byId(color+'-buildings-label').textContent=factionName(team)+(own?'建筑':'可见建筑');
    byId(color+'-units-label').textContent=own?'活动单位':'可见单位';
    byId(color+'-buildings').textContent=structures.filter(visibleAndAlive).length;
    byId(color+'-units').textContent=units.filter(visibleAndAlive).length;
  }
  const building=game.selectedBuilding;
  const count=game.selection.length;
  const rank=unit?.rank?' · '+unit.rank+' 级':'';
  byId('active-unit').textContent=unit ? factionName(unit.team)+unit.label+rank : count ? '已选 '+count+' 个单位' :
    building ? buildingSpec(building.type).label : '未选择单位';
  unitMenu.hidden=!count;
  syncUnitStats(unit);
  byId('cargo-count').textContent=cargo+' / '+CARGO_LIMIT;
  byId('cargo-bar').value=cargo;
  byId('cargo-panel').hidden=unit?.type!=='miner';
  let mode='';
  if (unit) {
    if (unit.type==='bomber' && unit.mode==='returning') {
      mode='返航中';
    } else if (unit.type==='bomber' && unit.mode==='parked') {
      mode='机场待命';
    } else if (unit.type==='bomber' && unit.mode==='bombing') {
      mode='飞往指定轰炸目标';
    } else if (unit.type==='helicopter') {
      const task=unit.mode==='pickup'?'飞往接载点':unit.mode==='transporting'?'运送中':'待命';
      mode=unit.passengerCount==null?task:task+' · 载员 '+unit.passengerCount+'/'+HELICOPTER_CAPACITY;
    } else if (unit.type==='reconPlane') {
      mode='航空侦察';
    } else if (unit.type==='miner' && unit.mode==='idle' && unit.autoMine && !unit.attackTarget && !unit.engaged) {
      mode=unit.cargo>=CARGO_LIMIT-.001?'等待卸矿':'寻找矿脉';
    } else {
      mode=unit.engaged?'交战中':unit.goal?.kind==='scout'?'侦察中':unit.goal?.kind==='retreat'?'回撤中':unit.goal?.kind==='expand'?'前往部署':unit.goal?.kind==='mount'?'前往上马':unit.goal?.kind==='reinforce'?'驰援中':unit.attackTarget?'进攻中':unit.captureTarget?'前往占领':
        unit.type==='dog' && unit.team===game.perspective && unit.scentTarget?'发现敌方人员':
        isAirborne(unit)?(unitElevation(unit)<JET_ALTITUDE?'起飞中':'巡航中'):
        UNIT_ART[unit.type].small && unit.mode==='moving'?'行进中':labels[unit.mode];
    }
  } else if (count) {
    const working=game.selection.filter(member=>member.mode!=='idle' || member.engaged || member.attackTarget);
    mode=working.length?working.length+' 个执行指令':'待命';
  }
  byId('unit-mode').textContent=mode;
  const coord=x=>(x<0?'-':'')+String(Math.abs(Math.round(x))).padStart(2,'0');
  byId('coords').textContent='X '+coord(camera.x)+' / Y '+coord(camera.y);
  const focus=byId('focus');
  const focusLabel=unit?'跟踪':'定位所选';
  byId('focus-label').textContent=focusLabel;
  focus.setAttribute('aria-label',focusLabel);
  if (unit) focus.setAttribute('aria-pressed',String(Boolean(game.follow)));
  else focus.removeAttribute('aria-pressed');
  focus.title=(game.follow?'停止跟踪':focusLabel)+'（F）';
  const hint=factionName(game.perspective)+'视角 · 拖动地图或点击小地图';
  byId('instruction').textContent=(game.noticeUntil>game.time && game.notice) ||
    (game.follow?'跟踪中 · '+factionName(game.follow.team)+game.follow.label:hint);
  syncResearchHud();
  syncBuildMenu();
}

function syncUnitStats(unit) {
  byId('unit-stats').hidden=!unit;
  if (!unit) return;
  const weapon=WEAPONS[unit.type];
  const mounted=unit.type==='mountedCavalry';
  const product=mounted?PRODUCTS.cavalry:PRODUCTS[unit.type];
  const horse=mounted?PRODUCTS.horse:null;
  const maxHealth=weapon?.health??product.health;
  const cost=product.cost+(horse?.cost??0);
  const time=product.time+(horse?.time??0);
  byId('unit-health').textContent=Math.ceil(unit.health)+' / '+maxHealth;
  const bonus=unit.rank?' (+'+Math.round(unit.rank*RANK_DAMAGE_BONUS*100)+'%)':'';
  byId('unit-attack').textContent=weapon?Number(weaponDamage(unit,weapon).toFixed(1))+bonus:'—';
  byId('unit-defense').textContent=Math.round(defenseOf(unit)*100)+'%';
  byId('unit-speed').textContent=unit.speed+' 格/秒';
  byId('unit-cost').textContent=cost.toLocaleString('zh-CN');
  byId('unit-time').textContent=Number(time.toFixed(1))+' 秒';
  byId('unit-range').textContent=weaponRangeLabel(weapon);
}

function pan(dx,dy) {
  const delta=inverse(dx/viewport.scale,dy/viewport.scale);
  camera.x+=delta.x;
  camera.y+=delta.y;
  clampCamera();
  game.follow=null;
}

function clampCamera() {
  const view=project(camera.x,camera.y);
  const marginX=Math.min((BOARD.right-BOARD.left)/2,viewport.w/(2*viewport.scale));
  const marginY=Math.min((BOARD.bottom-BOARD.top)/2,viewport.h/(2*viewport.scale));
  const point=inverse(Math.max(BOARD.left+marginX,Math.min(BOARD.right-marginX,view.x)),
    Math.max(BOARD.top+marginY,Math.min(BOARD.bottom-marginY,view.y)));
  camera.x=point.x;
  camera.y=point.y;
}

function focusUnit() {
  const building=game.selectedBuilding;
  if (building) {
    centerCamera(yardCenter(building));
    return;
  }
  const {selection,selected}=game;
  if (selection.length>1) {
    centerCamera({
      x:selection.reduce((sum,unit)=>sum+unit.x,0)/selection.length,
      y:selection.reduce((sum,unit)=>sum+unit.y,0)/selection.length,
    });
    return;
  }
  if (selected) {
    game.follow=game.follow?null:selected;
    syncHud();
    return;
  }
  const unit=units.find(member=>member.team===game.perspective && member.health>0);
  if (unit) {
    selectUnit(unit);
  } else {
    const yard=structures.find(building=>building.team===game.perspective);
    if (yard) {
      select([],yard);
      focusUnit();
    }
  }
}

function screenPoint(event, element=map) {
  const bounds=element.getBoundingClientRect();
  return {x:event.clientX-bounds.left,y:event.clientY-bounds.top};
}

function unitAt(sx,sy,team='player') {
  const p=worldAt(sx,sy);
  let nearest=Infinity, selected=null;
  for (const unit of units) {
    if (team && unit.team!==team) continue;
    if (unit.health<=0 || !canSeeEntity(viewFaction(),unit)) continue;
    const d=project(p.x-unit.x,p.y-unit.y);
    d.y+=unitElevation(unit);
    const {hitWidth,hitHeight,small}=UNIT_ART[unit.type];
    if (Math.abs(d.x)>hitWidth || d.y<-hitHeight || d.y>(small?8:17)) continue;
    const distance=Math.hypot(d.x,d.y+hitHeight*.44);
    if (distance<nearest) {
      nearest=distance;
      selected=unit;
    }
  }
  return selected;
}

const spriteAlpha=new WeakMap();

function structureCovers(art,point) {
  const x=(point.x-art.left)/art.width;
  const y=(point.y-art.bottom+art.height)/art.height;
  if (x<0 || x>=1 || y<0 || y>=1 || point.y<art.top) return false;
  const {image}=art;
  if (!image?.naturalWidth) return true;
  const w=image.naturalWidth,h=image.naturalHeight;
  if (!spriteAlpha.has(image)) {
    const canvas=document.createElement('canvas');
    canvas.width=w;
    canvas.height=h;
    const sample=canvas.getContext('2d',{willReadFrequently:true});
    sample.drawImage(image,0,0);
    spriteAlpha.set(image,sample.getImageData(0,0,w,h).data);
  }
  return spriteAlpha.get(image)[(Math.floor(y*h)*w+Math.floor(x*w))*4+3]>=112;
}

function mapEntityAt({x,y}) {
  const world=worldAt(x,y);
  const screen=project(world.x,world.y);
  const unit=unitAt(x,y,null);
  let solid=null,label=null,nearest=-Infinity,labelDistance=Infinity;
  for (const building of structures) {
    if (!structureVisible(building)) continue;
    const depth=structureDepthAt(building,screen.x);
    if (depth>nearest && structureCovers(structureArt(building),screen)) {
      solid=building;
      nearest=depth;
    }
    const point=buildingLabelPoint(building);
    const distance=distanceTo(screen,point);
    if (distance<labelDistance && Math.abs(screen.y-point.y)<=9 &&
        Math.abs(screen.x-point.x)<=buildingCaption(building).length*5.5+18) {
      label=building;
      labelDistance=distance;
    }
  }
  if (unit && ((isAirborne(unit) && unitElevation(unit)>42) || unit.x+unit.y+.12>nearest)) return unit;
  return label??solid;
}

function mapClick(point) {
  const target=mapEntityAt(point);
  if (target?.width) select([],target);
  else selectUnit(target);
}

function selectionBounds({start,end}) {
  return {
    left:Math.min(start.x,end.x), right:Math.max(start.x,end.x),
    top:Math.min(start.y,end.y), bottom:Math.max(start.y,end.y),
  };
}

function selectBox(drag) {
  const {left,top,right,bottom}=selectionBounds(drag);
  const center=project(camera.x,camera.y);
  select(units.filter(unit=>{
    if (!canSeeEntity(viewFaction(),unit)) return false;
    const point=project(unit.x,unit.y,UNIT_ART[unit.type].hitHeight*.44+unitElevation(unit));
    const x=viewport.w/2+(point.x-center.x)*viewport.scale;
    const y=viewport.h/2+(point.y-center.y)*viewport.scale;
    return x>=left && x<=right && y>=top && y<=bottom;
  }));
}

if (!ENGINE_ONLY) {
map.addEventListener('pointerdown',event=>{
  const p=screenPoint(event);
  if (event.pointerType==='touch') {
    if (touches.size) for (const touch of touches.values()) touch.moved=true;
    touches.set(event.pointerId,{...p,startX:p.x,startY:p.y,moved:touches.size>0});
    map.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button===0 && event.shiftKey) {
    selectionDrag={pointerId:event.pointerId,start:p,end:p,active:false};
  } else if (event.button===0 || event.button===1) {
    event.preventDefault();
    mouseDrag={pointerId:event.pointerId,start:p,previous:p,active:event.button===1};
    if (mouseDrag.active) map.style.cursor='grabbing';
  } else return;
  map.setPointerCapture(event.pointerId);
});

map.addEventListener('pointermove',event=>{
  const p=screenPoint(event);
  const touch=touches.get(event.pointerId);
  if (touch) {
    if (touches.size===1 && (touch.moved || Math.hypot(p.x-touch.startX,p.y-touch.startY)>8)) {
      pan(touch.x-p.x,touch.y-p.y);
      touch.moved=true;
    }
    touch.x=p.x;
    touch.y=p.y;
    return;
  }
  if (mouseDrag?.pointerId===event.pointerId) {
    const {start,previous}=mouseDrag;
    mouseDrag.active||=Math.hypot(p.x-start.x,p.y-start.y)>=5;
    if (mouseDrag.active) {
      map.style.cursor='grabbing';
      game.hoverTarget=null;
      pan(previous.x-p.x,previous.y-p.y);
      mouseDrag.previous=p;
    }
    return;
  }
  if (selectionDrag?.pointerId===event.pointerId) {
    selectionDrag.end={x:Math.max(0,Math.min(viewport.w,p.x)),y:Math.max(0,Math.min(viewport.h,p.y))};
    const {start,end}=selectionDrag;
    selectionDrag.active||=Math.hypot(start.x-end.x,start.y-end.y)>=6;
    if (selectionDrag.active) {
      game.follow=null;
      game.hoverTarget=null;
      map.style.cursor='crosshair';
      return;
    }
  }
  const entity=mapEntityAt(p);
  game.hoverTarget=entity;
  map.style.cursor=entity?'pointer':'grab';
});

map.addEventListener('pointerup',event=>{
  const p=screenPoint(event);
  const touch=touches.get(event.pointerId);
  if (touch) {
    touches.delete(event.pointerId);
    if (!touch.moved) mapClick(p);
    return;
  }
  if (mouseDrag?.pointerId===event.pointerId) {
    const moved=mouseDrag.active;
    mouseDrag=null;
    map.style.cursor='grab';
    if (moved || event.button!==0) return;
  }
  if (event.button!==0) return;
  const drag=selectionDrag;
  selectionDrag=null;
  if (drag?.active) selectBox(drag);
  else if (p.x>=0 && p.x<=viewport.w && p.y>=0 && p.y<=viewport.h) mapClick(p);
});
map.addEventListener('pointercancel',event=>{
  touches.delete(event.pointerId);
  mouseDrag=null;
  selectionDrag=null;
});
map.addEventListener('lostpointercapture',event=>{
  if (selectionDrag?.pointerId===event.pointerId) selectionDrag=null;
  if (mouseDrag?.pointerId===event.pointerId) {
    mouseDrag=null;
    map.style.cursor='grab';
  }
});
map.addEventListener('pointerleave',()=>{ game.hoverTarget=null; });
view.addEventListener('contextmenu',event=>{
  event.preventDefault();
  selectionDrag=null;
  if (game.selection.length || game.selectedBuilding) sound.play('cancel');
  selectUnit(null);
});
}
function centerCamera(point) {
  camera.x=point.x;
  camera.y=point.y;
  clampCamera();
  game.follow=null;
}

function navigateRadar(event) {
  if (!game.radarLayout) return;
  const p=screenPoint(event,radar);
  const {left,top,scale}=game.radarLayout;
  centerCamera(inverse(BOARD.left+(p.x-left)/scale,BOARD.top+(p.y-top)/scale));
}

if (!ENGINE_ONLY) {
radar.addEventListener('pointerdown',event=>{
  if (event.button!==0 || !game.radarLayout) return;
  radar.setPointerCapture(event.pointerId);
  navigateRadar(event);
});
radar.addEventListener('pointermove',event=>{
  if (radar.hasPointerCapture(event.pointerId)) navigateRadar(event);
});
for (const [id,team,origin] of [['view-blue','player',mcv],['view-red','enemy',enemyMcv]]) {
  byId(id).addEventListener('click',()=>{
    changeObserverPerspective(team,origin);
  });
}
byId('close-building').addEventListener('click',()=>selectUnit(null));
byId('focus').addEventListener('click',focusUnit);
byId('help-button').addEventListener('click',()=>byId('help').showModal());
byId('restart-match').addEventListener('click',()=>controlMatch('start'));
byId('continue-match').addEventListener('click',()=>matchResult.close());
byId('fullscreen').addEventListener('click',async()=>{
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else notice('当前浏览器不支持全屏');
  } catch {
    notice('当前浏览器不支持全屏');
  }
});
document.addEventListener('fullscreenchange',()=>{
  byId('fullscreen').setAttribute('aria-label',document.fullscreenElement?'退出全屏':'全屏');
  byId('fullscreen').querySelector('.header-label').textContent=document.fullscreenElement?'退出全屏':'全屏';
});
document.addEventListener('keydown',event=>{
  if (byId('help').open || event.altKey || event.ctrlKey || event.metaKey) return;
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
    event.preventDefault();
    pressed.add(event.key);
    return;
  }
  if (event.repeat) return;
  const shortcuts={f:focusUnit,escape:()=>selectUnit(null)};
  const action=shortcuts[event.key.toLowerCase()];
  if (action) {
    event.preventDefault();
    action();
  }
});
document.addEventListener('keyup',event=>pressed.delete(event.key));
window.addEventListener('blur',()=>{
  pressed.clear();
});
}

function sizeCanvas(canvas, box, pixelBudget=Infinity) {
  const rect=canvas.getBoundingClientRect();
  box.w=rect.width;
  box.h=rect.height;
  const limit=Math.sqrt(pixelBudget/Math.max(1,rect.width*rect.height));
  box.dpr=Math.min(2,window.devicePixelRatio||1,Math.max(1,limit));
  canvas.width=Math.max(1,Math.round(rect.width*box.dpr));
  canvas.height=Math.max(1,Math.round(rect.height*box.dpr));
}
if (!ENGINE_ONLY) {
const responsive=new ResizeObserver(()=>{
  sizeCanvas(map,viewport,MAX_VIEWPORT_PIXELS);
  sizeCanvas(radar,radarViewport);
  clampCamera();
  drawWorld();
  terrainRadar();
});
responsive.observe(view);
responsive.observe(radar.parentElement);
}

function stepSimulation(dt) {
  if (!game.outcome) {
    game.time+=dt;
    detourNodesLeft=DETOUR_NODES_PER_TICK;
    try {
      for (const unit of [...units]) {
        if (unit.type==='miner') advanceMiner(unit,dt);
        else navigate(unit,dt);
      }
    } finally {
      detourNodesLeft=Infinity;
    }
    advanceOre(dt);
    advanceProduction(dt);
    advanceRepairs(dt);
    for (const faction of Object.values(FACTIONS)) advanceFaction(faction);
    advanceResearch(dt);
    advanceCombat(dt);
    for (const unit of units) advanceTurret(unit,dt);
    if (!game.outcome) advanceOilFields();
  }
}

function frame(timestamp) {
  const dt=Math.min(.046,Math.max(0,(timestamp-(lastFrame||timestamp))*.001));
  lastFrame=timestamp;
  interpolateObservation(timestamp);
  const speed=370*dt;
  const dx=(Number(pressed.has('ArrowRight'))-Number(pressed.has('ArrowLeft')))*speed;
  const dy=(Number(pressed.has('ArrowDown'))-Number(pressed.has('ArrowUp')))*speed;
  if (dx || dy) pan(dx,dy);
  const selectable=unit=>unit.health>0 && units.includes(unit) && canSeeEntity(viewFaction(),unit);
  if (game.selection.some(unit=>!selectable(unit)) ||
      (game.selectedBuilding && !structureVisible(game.selectedBuilding))) {
    const building=game.selectedBuilding;
    select(game.selection.filter(selectable),
      building && structureVisible(building)?building:null);
  }
  if (game.follow) {
    const ease=reducedMotion.matches?1:1-Math.exp(-dt*5.5);
    camera.x+=(game.follow.x-camera.x)*ease;
    camera.y+=(game.follow.y-camera.y)*ease;
    clampCamera();
  }
  drawWorld();
  if (timestamp>=nextRadar) {
    terrainRadar();
    nextRadar=timestamp+105;
  }
  if (timestamp>=nextHud) {
    syncHud();
    nextHud=timestamp+90;
  }
  requestAnimationFrame(frame);
}

reveal(FACTIONS.player,blueOrigin.x,blueOrigin.y,11,true);
reveal(FACTIONS.enemy,redOrigin.x,redOrigin.y,11,true);
refreshVision(FACTIONS.player,[mcv],[]);
refreshVision(FACTIONS.enemy,[enemyMcv],[]);
if (!ENGINE_ONLY) {
  sizeCanvas(map,viewport,MAX_VIEWPORT_PIXELS);
  sizeCanvas(radar,radarViewport);
  attachObserver(globalThis.matchBootstrap);
  requestAnimationFrame(frame);
}
