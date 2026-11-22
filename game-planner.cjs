'use strict';

const TASK_KINDS = {
  "mine": [
    "mine"
  ],
  "power": [
    "power"
  ],
  "industry": [
    "industry"
  ],
  "airpower": [
    "airpower"
  ],
  "mobilize": [
    "reserve"
  ],
  "recon": [
    "frontier"
  ],
  "advance": [
    "frontier"
  ],
  "capture": [
    "hostile_oil",
    "neutral_oil"
  ],
  "harass": [
    "economy",
    "miner",
    "power_plant"
  ],
  "intercept": [
    "aircraft",
    "armor",
    "infantry"
  ],
  "strike": [
    "defense",
    "infrastructure",
    "power_plant"
  ],
  "fortify": [
    "defense"
  ],
  "research": [
    "research"
  ]
};
const OWN_FIELDS = ["aircraft", "airports", "army", "barracks", "credits", "defenses", "factories", "home_guard", "home_threat", "miners", "miners_ordered", "oil", "ore", "power", "strength"];
const ENEMY_FIELDS = ["aircraft", "armor", "buildings", "infantry", "power_plants", "production", "remembered", "strength"];
const PROMPT = "Plan for one commander in a fictional browser RTS.\nChoose the zero-based index of a primary option and, if useful, a different\nfollowup option to try only after the primary succeeds. Use -1 for no followup.\nEach option is an executable goal. Distance is measured from home in tiles.\nRisk reflects hostile combat units spotted near that option. Enemy observations\ncover only what this side has seen. The remembered count may be stale.\nProtect the base when attacked, secure a sustainable income and reliable power,\nand prefer safe scouting and regrouping when hostile strength is uncertain.\nThe objective is to defeat the opposing faction. When combat forces are ready,\nadvance into the explored frontier if enemies remain undiscovered. Engage\nfeasible targets as soon as your own scouts find them.\nIn the early economy, aim for at least two miners when the base is safe.\nMining and reliable power fund later military expansion. A harass option sends\na small fast squad to disrupt exposed income while retaining home guards.\nIt can delay an opponent before a full strike is viable. Consider home_guard\nand the observed home_threat to avoid leaving the base open to a counter-raid.\nExtra factories boost and parallelize vehicle production when power is stable.\nAirpower buys an airport and a versatile fighter. It needs reliable funding and power.\nWhen attacking, prefer an exposed power plant if cutting power can disrupt\nenemy production. Factories and barracks slow down on insufficient power.\nUse the previous outcome to avoid repeating an approach that stalled.\nDo not use tools, files, shell commands or outside knowledge. Return only\nthe JSON object with the two option indices.\nObservations: ";

const { access, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { constants } = require('node:fs');
const { execFile } = require('node:child_process');
const { tmpdir } = require('node:os');
const path = require('node:path');

function hasFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every(field => Object.hasOwn(value, field));
}

function validCount(value, limit = 10000000) {
  return Number.isInteger(value) && value >= 0 && value <= limit;
}

function validObservation(body) {
  return hasFields(body,['personality','situation','own','enemy','recent','options']) &&
    ['conservative','aggressive'].includes(body.personality) &&
    ['raided','outmatched','contested','clear'].includes(body.situation) &&
    hasFields(body.own,OWN_FIELDS) && OWN_FIELDS.every(field => validCount(body.own[field])) &&
    validCount(body.own.power,100) && hasFields(body.enemy,ENEMY_FIELDS) &&
    ENEMY_FIELDS.every(field => validCount(body.enemy[field])) &&
    (body.recent === null || (hasFields(body.recent,['task','result']) &&
      Object.hasOwn(TASK_KINDS,body.recent.task) &&
      ['complete','stalled','lost','interrupted'].includes(body.recent.result))) &&
    Array.isArray(body.options) && body.options.length > 0 && body.options.length <= 16 &&
    body.options.every(option => hasFields(option,['task','kind','distance','risk']) &&
      typeof option.task === 'string' && Object.hasOwn(TASK_KINDS,option.task) &&
      TASK_KINDS[option.task].includes(option.kind) && validCount(option.distance,200) &&
      ['low','medium','high'].includes(option.risk));
}

async function findCodex() {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const binary = path.join(directory,'codex');
    try {
      await access(binary,constants.X_OK);
      return binary;
    } catch {}
  }
  return null;
}

async function chooseWithCodex(binary,snapshot) {
  const directory = await mkdtemp(path.join(tmpdir(),'ccgame-plan-'));
  try {
    const ids = snapshot.options.map((_,index)=>index);
    const schema = path.join(directory,'schema.json');
    const result = path.join(directory,'reply.json');
    await writeFile(schema,JSON.stringify({
      type:'object', required:['primary','followup'], additionalProperties:false,
      properties:{ primary:{type:'integer',enum:ids}, followup:{type:'integer',enum:[-1,...ids]} },
    }));
    const completed = await new Promise(resolve => {
      const process = execFile(binary,[
        'exec','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only',
        '-c','approval_policy="never"','-c','web_search="disabled"','-c','features.hooks=false',
        '--output-schema',schema,'--output-last-message',result,'--cd',directory,'-',
      ],{ timeout:32000, maxBuffer:1024*1024 }, error=>resolve(!error));
      process.stdin.on('error',()=>{});
      process.stdin.end(PROMPT + JSON.stringify(snapshot));
    });
    if (!completed) return null;
    const reply = JSON.parse(await readFile(result,'utf8'));
    return hasFields(reply,['primary','followup']) && ids.includes(reply.primary) &&
      (ids.includes(reply.followup) || reply.followup===-1) && reply.primary!==reply.followup ? reply : null;
  } catch {
    return null;
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
}

module.exports = { findCodex, chooseWithCodex, validObservation };
