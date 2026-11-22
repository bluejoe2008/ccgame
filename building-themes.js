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
