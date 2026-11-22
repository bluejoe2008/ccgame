'use strict';

const DEFAULT_BUILDING_THEME='mountain';
const RANDOM_BUILDING_THEME='random';
const BUILDING_WIDTHS={yard:205,refinery:232,factory:205,repairDepot:188,barracks:163,airport:270,
  oil:148,sentry:82,turret:157,bunker:155,wall:56,laser:132,solar:147,diesel:199,recreation:152,training:201};
const CLASSIC_LIGHTS={
  yard:[[.455,.522],[.642,.459],[.689,.451]], factory:[[.59,.548],[.77,.434]],
  repairDepot:[[.645,.46]], refinery:[[.46,.69]], barracks:[[.567,.028],[.176,.621],[.449,.733]],
  airport:[[.36,.58],[.45,.63],[.65,.77],[.81,.70]], solar:[[.790,.278],[.819,.292]],
  diesel:[[.20,.48]], oil:[[.733,.749]], sentry:[[.227,.510]], turret:[[.500,.121]],
  bunker:[[.179,.477],[.491,.595]], recreation:[[.256,.503],[.410,.574]], training:[[.859,.369]],
};

const BUILDING_THEMES={
  classic:{
    label:'原版写实', prefix:'', widths:{}, repairMark:[.53,.79],
    laser:{aspect:300/324,emitter:[.68,.25]}, lights:CLASSIC_LIGHTS,
    stacks:{diesel:[[.80,.05],[.87,.02]],refinery:[[.395,.04]]},
    rotors:{oil:[.567,.593]},
  },
  mountain:{
    label:'红军年代', prefix:'mountain-',
    widths:{sentry:77,turret:155,bunker:135,wall:59,laser:96,solar:113,recreation:136},
    laser:{aspect:360/185,emitter:[.45,.245]},
    lights:{
      yard:[[.46,.70],[.55,.75]], factory:[[.47,.52],[.60,.54]], repairDepot:[[.44,.44],[.64,.54]],
      refinery:[[.65,.61],[.88,.60]], barracks:[[.45,.32],[.65,.36]],
      airport:[[.06,.80],[.17,.64],[.35,.40],[.48,.92],[.70,.62],[.83,.38]],
      solar:[[.39,.82]], diesel:[[.54,.76],[.67,.72],[.74,.74]], oil:[[.63,.48]],
      sentry:[[.43,.38]], turret:[[.39,.43]], bunker:[[.58,.49]], recreation:[[.132,.48],[.66,.51]], training:[[.51,.85]],
    },
    stacks:{diesel:[[.096,.092],[.19,.102]],refinery:[[.075,.022],[.167,.091]]},
    rotors:{oil:[.22,.62],diesel:[.72,.74]},
  },
  qinhan:{
    label:'秦汉古风', prefix:'qinhan-',
    widths:{sentry:81,bunker:139,wall:60,laser:112,solar:139,recreation:140},
    laser:{aspect:356/282,emitter:[.46,.27]},
    lights:{
      yard:[[.43,.49],[.51,.52]], factory:[[.44,.56],[.59,.61]], repairDepot:[[.39,.55],[.52,.66]],
      refinery:[[.44,.57]], barracks:[[.32,.33],[.49,.37]],
      airport:[[.04,.73],[.18,.54],[.47,.84],[.59,.91],[.82,.65]], solar:[[.18,.75]],
      diesel:[[.23,.67],[.64,.64]], oil:[[.40,.42]], sentry:[[.48,.33]],
      turret:[[.51,.43]], bunker:[[.47,.66]], recreation:[[.44,.60],[.57,.63]], training:[[.35,.69]],
    },
    stacks:{diesel:[[.253,.054],[.355,.024]],refinery:[[.139,.114],[.225,.154]]},
    rotors:{oil:[.42,.42],diesel:[.633,.649]},
  },
  tang:{
    label:'唐代建筑', prefix:'tang-',
    widths:{sentry:78,bunker:143,wall:59,laser:96,solar:144,recreation:144},
    laser:{aspect:360/229,emitter:[.414,.31]},
    lights:{
      yard:[[.37,.65],[.45,.65]], factory:[[.38,.63],[.51,.64]], repairDepot:[[.43,.59],[.57,.65]],
      refinery:[[.07,.66],[.49,.50]], barracks:[[.40,.77],[.51,.77]],
      airport:[[.09,.82],[.20,.67],[.30,.52],[.68,.89],[.76,.72],[.85,.56]],
      solar:[[.51,.79]], diesel:[[.09,.79],[.27,.82]], oil:[[.53,.47]], sentry:[[.51,.36]],
      turret:[[.48,.31]], bunker:[[.42,.58]], recreation:[[.43,.56],[.62,.56]], training:[[.43,.66]],
    },
    stacks:{refinery:[[.132,.055],[.204,.024]],diesel:[[.193,.024],[.326,.04]]},
    rotors:{oil:[.63,.62],diesel:[.74,.70],solar:[.233,.305]},
  },
  qing:{
    label:'清代建筑', prefix:'qing-',
    widths:{sentry:71,bunker:143,wall:59,laser:82,solar:145,recreation:140},
    laser:{aspect:360/180,emitter:[.43,.30]},
    lights:{
      yard:[[.35,.61],[.51,.60]], factory:[[.40,.58],[.54,.61]], repairDepot:[[.43,.58],[.54,.70]],
      refinery:[[.16,.70],[.30,.68]], barracks:[[.34,.73],[.43,.74]],
      airport:[[.14,.81],[.25,.64],[.36,.56],[.69,.85],[.76,.73],[.83,.59]],
      solar:[[.48,.71]], diesel:[[.30,.76],[.44,.76]], oil:[[.73,.48]], sentry:[[.45,.355]],
      turret:[[.46,.35]], bunker:[[.40,.57]], recreation:[[.43,.59],[.61,.59]], training:[[.31,.71]],
    },
    stacks:{refinery:[[.145,.040],[.233,.021]],diesel:[[.383,.024],[.548,.06]]},
    rotors:{oil:[.675,.61],diesel:[.78,.67],solar:[.244,.264]},
  },
};

function hasBuildingTheme(theme) {
  return typeof theme==='string' && Object.hasOwn(BUILDING_THEMES,theme);
}

function validBuildingThemePreference(preference) {
  return preference===RANDOM_BUILDING_THEME || hasBuildingTheme(preference);
}

function resolveBuildingTheme(theme) {
  return hasBuildingTheme(theme)?theme:DEFAULT_BUILDING_THEME;
}

function buildingThemeAsset(id,type,tint,axis) {
  if (tint==='neutral') return 'mountain-oil-neutral';
  const theme=BUILDING_THEMES[id];
  const variant=type==='wall'?'wall-'+(axis==='y'?'y':'x'):theme.repairMark && type==='repairDepot'?'yard':type;
  return theme.prefix+variant+'-'+tint;
}

if (typeof module!=='undefined') {
  module.exports={BUILDING_THEMES, BUILDING_WIDTHS, DEFAULT_BUILDING_THEME, RANDOM_BUILDING_THEME,
    hasBuildingTheme, validBuildingThemePreference, resolveBuildingTheme, buildingThemeAsset};
}
