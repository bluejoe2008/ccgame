'use strict';

self.onmessage=({data})=>{
  if (Object.hasOwn(data,'seed')) {
    self.matchEngine={seed:data.seed};
    importScripts('commander.js?v=shared-match','building-themes.js?v=1','game.js?v=building-themes');
    groundTexture=data.texture;
    return;
  }
  const tile=paintTerrainChunk(data.x,data.y,new OffscreenCanvas(1,1));
  const art=tile.transferToImageBitmap();
  self.postMessage({key:data.key,art},[art]);
};
