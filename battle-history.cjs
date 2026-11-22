'use strict';

const fs = require('node:fs');
const path = require('node:path');

const teams = ['player', 'enemy'];
const labels = {
  mine:'扩充采矿',power:'维持供电',industry:'扩建兵工厂',airpower:'部署空军',mobilize:'训练增援',
  recon:'侦察前沿',advance:'向前沿推进',capture:'争夺油田',harass:'小队袭扰',
  intercept:'集中拦截',strike:'打击关键建筑',fortify:'加强基地防御',research:'研发科技',
};

function replaceFile(file, contents) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, contents, { mode:0o600 });
  fs.renameSync(temporary, file);
}

function review(match, team, logs, remaining) {
  const result = match.status === 'ended' ? 'stopped' : match.outcome === 'draw' ? 'draw' :
    match.outcome === team ? 'win' : 'loss';
  const name = team === 'player' ? '蓝方' : '红方';
  let oil = 0, yardLosses = 0, firstPowerDrop = null, events = 0;
  const plans = new Map();
  const oilOperations = {};
  let turns=0, probingSuccesses=0;
  for (const line of logs.split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line);
    events++;
    if (entry.team !== team) continue;
    const oilPayment = /^油田收入 \+(\d+) 储备。$/.exec(entry.message);
    if (oilPayment) oil += Number(oilPayment[1]);
    if (entry.message === name+'建造场被摧毁。') yardLosses++;
    const powerDrop = /^电厂被毁，供电降至 (\d+)%/.exec(entry.message.slice(name.length));
    if (entry.message.startsWith(name) && powerDrop && firstPowerDrop === null) {
      firstPowerDrop = { time:entry.time, percent:Number(powerDrop[1]) };
    }
    const metrics=entry.metrics;
    if (metrics?.kind==='turn') turns++;
    if (metrics?.kind==='turn-result' && metrics.phase==='probe' && entry.plan?.result==='complete') probingSuccesses++;
    if (metrics?.kind==='oil' && ['neutral_oil','hostile_oil'].includes(metrics.targetKind)) {
      const tally=oilOperations[metrics.targetKind]??={attempts:0,paidBack:0,net:0,held:0};
      if (metrics.result!=='round_end' || metrics.held>=30 || metrics.income>=metrics.cost) {
        tally.attempts++;
        tally.paidBack+=Number(metrics.income>=metrics.cost);
        tally.net+=metrics.income-metrics.cost;
        tally.held+=metrics.held;
      }
    }
    const plan = entry.plan;
    if (!Object.hasOwn(labels, plan?.task)) continue;
    const counts = plans.get(plan.task) ?? { done:0, failed:0 };
    if (plan.result === 'complete') counts.done++;
    else counts.failed++;
    plans.set(plan.task, counts);
  }

  const ranked = [...plans].sort((a,b)=>(b[1].done-b[1].failed)-(a[1].done-a[1].failed));
  const best = ranked.find(([,counts])=>counts.done>counts.failed);
  const worst = ranked.slice().reverse().find(([,counts])=>counts.failed>counts.done);
  const evidence = ['结束时保有 '+remaining.units+' 个活动单位、'+remaining.buildings+' 座建筑。'];
  if (oil) evidence.push('日志记录油田累计入账 '+oil.toLocaleString('zh-CN')+' 储备。');
  if (firstPowerDrop) {
    evidence.push('第 '+Math.floor(firstPowerDrop.time)+' 秒电厂被摧毁，供电降至 '+firstPowerDrop.percent+'%。');
  }
  if (yardLosses) evidence.push('日志记录 '+yardLosses+' 次建造场损失。');
  if (best) evidence.push('「'+labels[best[0]]+'」完成 '+best[1].done+' 次，受阻或中断 '+best[1].failed+' 次。');
  if (worst) evidence.push('「'+labels[worst[0]]+'」受阻或中断 '+worst[1].failed+' 次，完成 '+worst[1].done+' 次。');
  if (turns) evidence.push('反复拦截后调整任务 '+turns+' 次，小队试探完成目标 '+probingSuccesses+' 次。');
  for (const [category,stats] of Object.entries(oilOperations)) {
    if (!stats.attempts) continue;
    const name=category==='neutral_oil'?'中立油田':'敌方油田';
    evidence.push(name+'行动 '+stats.attempts+' 次，其中 '+stats.paidBack+' 次收入覆盖工程师及已记录的护卫损失，'
      +'累计净入账 '+stats.net.toLocaleString('zh-CN')+' 储备。');
  }

  const lessons = [];
  const add = (task, weight, reason) => {
    if (lessons.length<3 && !lessons.some(item=>item.task===task)) lessons.push({ task, weight, reason });
  };
  if (result !== 'stopped') {
    if (result === 'loss' && yardLosses) add('fortify',20,'本局失去建造场，下局较早补设防御并留守。');
    if (firstPowerDrop) add('power',19,'电厂损失导致供电下降，下局优先维持供电并分散电站。');
    if (result !== 'loss' && best) add(best[0],14,'延续本局完成较多的「'+labels[best[0]]+'」计划。');
    if (oil) add('capture',12,'油田带来持续收入，继续争取已侦察且可到达的油田。');
    if (worst) add('recon',12,'「'+labels[worst[0]]+'」多次受阻，下局先更新侦察再投入主力。');
    if (!lessons.length) add(result==='win'?'mine':'recon',10,
      result==='win'?'本局获胜，下局继续先建立能够持续补充部队的经济。':
        '本局缺少稳定的成功记录，下局先收集情报并评估可行目标。');
  }
  const summaries = {
    win:'获胜，保留有效做法并检查仍有损失的环节。',
    loss:'战败，优先修正日志中可确认的薄弱环节。',
    draw:'平局，优先修正可确认的弱点。',
    stopped:'人工结束，对局未分胜负。',
  };
  return { result, summary:name+summaries[result], evidence, lessons, events, oilOperations };
}

function safeId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(id)) throw new Error('Invalid match ID');
  return id;
}

class BattleHistory {
  constructor(checkpointFile) {
    this.root = checkpointFile + '.history';
    fs.mkdirSync(this.root, { recursive:true, mode:0o700 });
  }

  logFile(id, team) {
    if (!teams.includes(team)) throw new Error('Invalid perspective');
    return path.join(this.root, safeId(id), team+'.jsonl');
  }

  append(id, offsets, entries) {
    fs.mkdirSync(path.join(this.root, safeId(id)), { recursive:true, mode:0o700 });
    const next = {};
    for (const team of teams) {
      const file = this.logFile(id,team);
      const handle = fs.openSync(file,'a+',0o600);
      try {
        const size = fs.fstatSync(handle).size;
        if (size < offsets[team]) throw new Error('Battle log is shorter than its checkpoint');
        // Discard writes made before a process exited without committing its checkpoint.
        if (size > offsets[team]) fs.ftruncateSync(handle, offsets[team]);
        const lines = entries.filter(entry=>!entry.team || entry.team===team)
          .map(entry=>JSON.stringify(entry)+'\n').join('');
        if (lines) fs.writeFileSync(handle, lines);
        next[team] = offsets[team] + Buffer.byteLength(lines);
      } finally { fs.closeSync(handle); }
    }
    return next;
  }

  records() {
    return fs.readdirSync(this.root).filter(name=>/^round-\d{12}\.json$/.test(name)).sort().reverse();
  }

  manifestFile(round) {
    return path.join(this.root,'round-'+String(round).padStart(12,'0')+'.json');
  }

  get(round) {
    try { return JSON.parse(fs.readFileSync(this.manifestFile(round),'utf8')); }
    catch (error) { if (error.code!=='ENOENT') throw error; return null; }
  }

  finish(match, completeLogs, survivors) {
    const existing = this.get(match.round);
    if (existing) {
      if (existing.id!==match.id) throw new Error('Round already belongs to another match');
      return existing;
    }
    const reviews = Object.fromEntries(teams.map(team=>[team,review(match,team,
      fs.readFileSync(this.logFile(match.id,team),'utf8'),survivors[team])]));
    const result = { id:match.id, round:match.round, startedAt:match.startedAt, finishedAt:match.finishedAt,
      status:match.status, outcome:match.outcome, duration:match.time, completeLogs, reviews };
    replaceFile(this.manifestFile(match.round),JSON.stringify(result));
    return result;
  }

  latestRound() {
    const first = this.records()[0];
    return first ? Number(first.slice(6,-5)) : 0;
  }

  list(team, before) {
    const rounds = this.records().map(file=>Number(file.slice(6,-5))).filter(round=>!before || round<before);
    const page = rounds.slice(0,24).map(round=>{
      const { reviews, ...info } = this.get(round);
      return { ...info, review:reviews[team] };
    });
    return { rounds:page, before:rounds.length>page.length ? page.at(-1).round : null };
  }

  experience() {
    const recent = [];
    for (const file of this.records()) {
      const result = this.get(Number(file.slice(6,-5)));
      if (result.status==='finished') recent.push(result);
      if (recent.length===8) break;
    }
    return Object.fromEntries(teams.map(team=>{
      const reviews = recent.map(round=>round.reviews[team]);
      const weights = {};
      const oilObservations = {};
      for (const [i, result] of reviews.entries()) {
        for (const {task,weight} of result.lessons) {
          weights[task] = Math.min(27, (weights[task]??0) + Math.round(weight*.65**i));
        }
        for (const [category,stats] of Object.entries(result.oilOperations??{})) {
          const weight=.65**i;
          const totals=oilObservations[category]??={attempts:0,paidBack:0};
          totals.attempts+=stats.attempts*weight;
          totals.paidBack+=stats.paidBack*weight;
        }
      }
      const focus = Object.keys(weights).sort((a,b)=>weights[b]-weights[a]).slice(0,3);
      const oilWeights=Object.fromEntries(Object.entries(oilObservations)
        .map(([category,{attempts,paidBack}])=>[category,Math.round(12*(2*paidBack-attempts)/(attempts+2))]));
      return [team,{ sample:reviews.length, wins:reviews.filter(r=>r.result==='win').length,
        losses:reviews.filter(r=>r.result==='loss').length, draws:reviews.filter(r=>r.result==='draw').length,
        last:reviews[0]?.result??null, focus, weights, oilWeights }];
    }));
  }
}

module.exports = { BattleHistory, labels, replaceFile };
