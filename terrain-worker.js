'use strict';

self.onmessage=({data})=>{
  if (Object.hasOwn(data,'seed')) {
    self.matchEngine={seed:data.seed};
    importScripts('commander.js?v=shared-match','game.js?v=jiangnan');
    groundTexture=data.texture;
    return;
  }
  const tile=paintTerrainChunk(data.x,data.y,new OffscreenCanvas(1,1));
  const art=tile.transferToImageBitmap();
  self.postMessage({key:data.key,art},[art]);
};
