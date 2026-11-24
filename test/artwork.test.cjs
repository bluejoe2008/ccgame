'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {BUILDING_THEMES,resolveBuildingTheme,buildingThemeAsset,validBuildingThemePreference}=require('../building-themes.js');
const root=path.join(__dirname,'..','assets');
function bitmap(name){const file=path.join(root,name+'.webp');assert.ok(fs.existsSync(file),name+' missing');const b=fs.readFileSync(file);assert.equal(b.toString('ascii',0,4),'RIFF',name);assert.equal(b.toString('ascii',8,12),'WEBP',name);}

test('available styles replace Red Army with European town and space expedition',()=>{
 assert.deepEqual(Object.keys(BUILDING_THEMES).sort(),['classic','europe','qinhan','qing','space','tang'].sort());assert.equal(validBuildingThemePreference('mountain'),false);assert.equal(resolveBuildingTheme('mountain'),'classic');assert.equal(validBuildingThemePreference('random'),true);
});

test('every building style provides complete images in both faction tints',()=>{
 for(const theme of Object.keys(BUILDING_THEMES))for(const type of ['yard','refinery','factory','repairDepot','barracks','airport','oil','sentry','turret','wall','bunker','laser','solar','diesel','recreation','training'])for(const tint of ['blue','red']){
  for(const axis of type==='wall'?['x','y']:['x'])bitmap(buildingThemeAsset(theme,type,tint,axis));
 }
 bitmap(buildingThemeAsset('classic','oil','neutral'));
});

test('historical and space armies have four complete headings, including mounted units',()=>{
 for(const theme of ['qinhan','tang','qing','europe','space'])for(const type of ['soldier','engineer','rocketeer','mortar','mountedCavalry','horse'])for(let facing=0;facing<4;facing++)for(const tint of ['blue','red'])bitmap(theme+'-'+type+'-'+facing+'-'+tint);
 for(const type of ['mcv','miner','tank','artillery','tank-hull','tank-turret'])for(let facing=0;facing<4;facing++)for(const tint of ['blue','red'])bitmap('space-'+type+'-'+facing+'-'+tint);
 const manifest=require('../assets/theme-manifest.json');assert.ok(manifest.assets.length>=350);for(const a of manifest.assets){assert.ok(a.width>0&&a.height>0);bitmap(a.name.slice(0,-5));}
});
