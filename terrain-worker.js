'use strict';

self.onmessage=({data})=>{
  if (Object.hasOwn(data,'seed')) {
    self.matchEngine={seed:data.seed,capacity:data.capacity,teams:[]};
    importScripts('commander.js?v=command-buttons','building-themes.js?v=multiplayer-themes','game.js?v=multiplayer-themes');
    groundTexture=data.texture;
    return;
  }
  const tile=paintTerrainChunk(data.x,data.y,new OffscreenCanvas(1,1));
  const art=tile.transferToImageBitmap();
  self.postMessage({key:data.key,art},[art]);
};
