'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { gzip } = require('node:zlib');
const { promisify, parseArgs } = require('node:util');
const { Worker } = require('node:worker_threads');
const { pipeline } = require('node:stream/promises');
const { findCodex, chooseWithCodex, validObservation } = require('./game-planner.cjs');
const { validBuildingThemePreference } = require('./building-themes.js');
const { drills, runDrills } = require('./training.cjs');

const compress = promisify(gzip);
const root = __dirname;
const options = parseArgs({ options:{
  bind:{type:'string',default:'127.0.0.1'}, port:{type:'string',default:'8770'},
  state:{type:'string'}, codex:{type:'boolean'}, help:{type:'boolean'},
} }).values;
if (options.help) {
  console.log('Usage: node server.cjs [--bind ADDRESS] [--port PORT] [--state FILE] [--codex]');
  process.exit(0);
}
const port = Number(options.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(),'.local','state');
const checkpointFile = path.resolve(options.state || path.join(stateHome,'ore-command','match.bin'));
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.webp':'image/webp','.md':'text/plain; charset=utf-8'};
const publicFiles = new Set(['/index.html','/style.css','/audio.js','/commander.js','/building-themes.js',
  '/game.js','/observer.js','/terrain-worker.js']);
const pending = new Map();
let nextRequest = 0;
let worker;
let codex;
let plannerBusy = false;
let drillsRunning = false;
let nextStrategy = 0;
let stopping = false;

function launchWorker(host, actualPort) {
  worker = new Worker(path.join(root,'match-worker.cjs'),{workerData:{
    checkpointFile, plannerOrigin:codex ? 'http://' + host + ':' + actualPort : '',
  }});
  worker.on('message',({id,result,error})=>{
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(new Error(error));
    else entry.resolve(result);
  });
  worker.on('error',error=>console.error('Match worker:',error.message));
  worker.on('exit',()=>{
    worker = null;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Match worker stopped'));
    }
    pending.clear();
    if (!stopping) setTimeout(()=>launchWorker(host,actualPort),1200);
  });
}

function matchCall(action, fields={}) {
  if (!worker) return Promise.reject(new Error('Match worker unavailable'));
  const id = ++nextRequest;
  return new Promise((resolve,reject)=>{
    const timer = setTimeout(()=>{
      pending.delete(id);
      reject(new Error('Match worker timed out'));
    },8500);
    pending.set(id,{timer,resolve,reject});
    try {
      worker.postMessage({action,id,...fields});
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

async function sendJson(request,response,status,data) {
  let payload = Buffer.from(JSON.stringify(data));
  const headers = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
  if (payload.length>=4096 && (request.headers['accept-encoding'] ?? '').includes('gzip')) {
    payload = await compress(payload,{level:3});
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  response.writeHead(status,{...headers,'Content-Length':payload.length});
  response.end(payload);
}

function sameOrigin(request) {
  if (request.headers['sec-fetch-site']==='cross-site') return false;
  if (!request.headers.origin) return true;
  try { return new URL(request.headers.origin).host===request.headers.host; }
  catch { return false; }
}

async function readJson(request) {
  if ((request.headers['content-type'] ?? '').split(';')[0]!=='application/json') return null;
  const chunks=[];
  let size=0;
  for await (const chunk of request) {
    size+=chunk.length;
    if (size>4096) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return null; }
}

async function staticFile(request,response,pathname) {
  if (pathname==='/') pathname='/index.html';
  if (!publicFiles.has(pathname) && !/^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname)) return false;
  const filename=path.join(root,pathname);
  const type=types[path.extname(filename)];
  if (!type) return false;
  try {
    const contents=await fs.readFile(filename);
    const cache=pathname.startsWith('/assets/')?'public, max-age=3600':'no-cache';
    response.writeHead(200,{'Content-Type':type,'Content-Length':contents.length,'Cache-Control':cache});
    response.end(request.method==='HEAD'?null:contents);
    return true;
  } catch (error) {
    if (error.code==='ENOENT' || error.code==='EISDIR') return false;
    throw error;
  }
}

async function serve(request,response) {
  const url = new URL(request.url,'http://localhost');
  const send=(status,body)=>sendJson(request,response,status,body);
  if (request.method==='GET' && url.pathname==='/api/strategy/status') return send(200,{available:Boolean(codex),protocol:6});
  if (request.method==='GET' && url.pathname==='/api/match/status') {
    return send(200,await matchCall('status'));
  }
  if (request.method==='GET' && url.pathname==='/api/match') {
    const team=url.searchParams.get('perspective')??'player';
    if (team!=='player' && team!=='enemy') return send(400,{error:'invalid_perspective'});
    return send(200,await matchCall('snapshot',{team}));
  }
  const historyLog=/^\/api\/history\/(\d{1,12})\/log$/.exec(url.pathname);
  if (request.method==='GET' && (url.pathname==='/api/history' || historyLog)) {
    const team=url.searchParams.get('perspective')??'player';
    if (team!=='player' && team!=='enemy') return send(400,{error:'invalid_perspective'});
    if (!historyLog) {
      const before=url.searchParams.get('before');
      if (before!==null && !/^[1-9]\d{0,11}$/.test(before)) return send(400,{error:'invalid_round'});
      return send(200,await matchCall('history',{team,before:Number(before)}));
    }
    const round=Number(historyLog[1]);
    const file=await matchCall('historyLog',{team,round});
    if (!file) return send(404,{error:'round_not_found'});
    const {size}=await fs.stat(file);
    response.writeHead(200,{ 'Content-Type':'application/x-ndjson; charset=utf-8','Content-Length':size,
      'Content-Disposition':'attachment; filename="round-'+round+'-'+team+'.jsonl"','Cache-Control':'no-store' });
    return pipeline(createReadStream(file),response);
  }
  if (request.method==='POST') {
    if (!sameOrigin(request)) return send(403,{error:'origin'});
    if (url.pathname==='/api/match/start' || url.pathname==='/api/match/end') {
      if (Number(request.headers['content-length']??0)!==0 || request.headers['transfer-encoding']) {
        return send(400,{error:'unexpected_body'});
      }
      const action=url.pathname.split('/').pop();
      return send(200,await matchCall(action,{current:request.headers['x-match-id']}));
    }
    if (url.pathname==='/api/match/building-style') {
      const selection=await readJson(request);
      if (!['player','enemy'].includes(selection?.team) ||
          !validBuildingThemePreference(selection.preference)) return send(400,{error:'invalid_building_style'});
      const state=await matchCall('building-style',{team:selection.team,preference:selection.preference,
        current:request.headers['x-match-id']});
      return state?send(200,state):send(409,{error:'match_changed'});
    }
    if (url.pathname==='/api/training/drills') {
      const selection=await readJson(request);
      if (selection?.drill!=='all' && !drills.includes(selection?.drill)) return send(400,{error:'invalid_drill'});
      if (drillsRunning) return send(429,{error:'drills_running'});
      drillsRunning=true;
      try { return send(200,{results:await runDrills(selection.drill==='all'?drills:[selection.drill])}); }
      finally { drillsRunning=false; }
    }
    if (url.pathname==='/api/strategy') {
      const snapshot=await readJson(request);
      if (!validObservation(snapshot)) return send(400,{error:'invalid_snapshot'});
      if (!codex) return send(503,{error:'local_strategy'});
      if (plannerBusy || Date.now()<nextStrategy) return send(429,{error:'busy'});
      plannerBusy=true;
      nextStrategy=Date.now()+18000;
      try {
        const strategy=await chooseWithCodex(codex,snapshot);
        return strategy ? send(200,strategy) : send(502,{error:'local_strategy'});
      } finally { plannerBusy=false; }
    }
  }
  if (['GET','HEAD'].includes(request.method) && await staticFile(request,response,url.pathname)) return;
  return send(404,{error:'not_found'});
}

async function main() {
  codex=options.codex ? await findCodex() : null;
  const server=http.createServer((request,response)=>{
    serve(request,response).catch(error=>{
      console.error(error.message);
      if (!response.headersSent) void sendJson(request,response,503,{error:'service_unavailable'});
      else response.destroy();
    });
  });
  server.listen(port,options.bind,()=>{
    const host=options.bind==='0.0.0.0'?'127.0.0.1':options.bind;
    launchWorker(host,server.address().port);
    console.log('Command&Conquer listening on %s:%s',options.bind,server.address().port);
  });
  async function stop() {
    if (stopping) return;
    stopping=true;
    server.close();
    try { await matchCall('shutdown'); } catch {}
    if (worker) await worker.terminate();
    process.exit(0);
  }
  process.on('SIGTERM',stop);
  process.on('SIGINT',stop);
}
main().catch(error=>{ console.error(error.message); process.exitCode=1; });
