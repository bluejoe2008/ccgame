'use strict';

const COMMAND_TASKS={
  mine:{label:'扩充矿车编队',mode:'develop',duration:36},
  power:{label:'恢复供电',mode:'develop',duration:28},
  industry:{label:'扩建兵工厂',mode:'develop',duration:34},
  airpower:{label:'建设机场并部署飞机',mode:'develop',duration:60},
  mobilize:{label:'训练增援',mode:'develop',duration:30},
  recon:{label:'侦察前沿',mode:'develop',duration:26},
  advance:{label:'向敌区推进',mode:'assault',duration:42},
  capture:{label:'夺取油田',mode:'develop',duration:42},
  harass:{label:'小队袭扰敌方经济',mode:'assault',duration:29},
  intercept:{label:'集中拦截',mode:'assault',duration:31},
  strike:{label:'进攻敌方建筑',mode:'assault',duration:46},
  fortify:{label:'加强基地防御',mode:'guard',duration:32},
  research:{label:'推进科技研发',mode:'develop',duration:38},
};
const COMMAND_RESULTS={complete:'已完成',stalled:'受阻',lost:'目标失去联系',interrupted:'因战况中断'};
const CAMPAIGN_TASKS=new Set(['advance','strike','harass','intercept']);
let commanderRequestInFlight=false;

function commandLabel(plan) {
  return plan.task==='strike' && plan.kind==='power_plant'?'打击敌方电厂':COMMAND_TASKS[plan.task].label;
}

function createCommander(team) {
  return {
    plan:null,proposal:null,last:null,scoutLead:null,enemySites:new Map(),cooldowns:new Map(),confirmedLosses:new Set(),
    nextReview:0,nextRequest:team==='player'?14:29,
  };
}

function miningFleet(faction,buildings,members) {
  const refineries=buildings.filter(building=>refineryReady(building,faction.team));
  const active=members.filter(unit=>unit.type==='miner').length;
  const ordered=buildings.reduce((count,building)=>count+Number(Boolean(building.pendingGift))+
    building.queue.filter(job=>job.type==='miner').length,0);
  let ore=0;
  for (const [key,amount] of deposits) {
    if (amount<30 || !faction.sight.has(key)) continue;
    const tile=faction.explored.get(key);
    if (tile && refineries.some(building=>distanceTo(tile,dockFor(building))<=13)) ore++;
  }
  const desired=refineries.length?ore>=6?3:2:0;
  return {active,ordered,desired,ore};
}

function campaignWaypoint(faction,home,army,frontier,threatNear) {
  const commander=faction.commander;
  const column=army.reduce((point,unit)=>({x:point.x+unit.x/army.length,y:point.y+unit.y/army.length}),{x:0,y:0});
  const bearing=Math.atan2(-home.y,-home.x);
  const dx=Math.cos(bearing),dy=Math.sin(bearing);
  const remembered=[...commander.enemySites.values()];
  const possible=remembered.length || !frontier.length?searchSites:frontier;
  let best=null,lowest=Infinity;
  for (const site of possible) {
    if (!faction.explored.has(tileKey(site.x,site.y)) || !walkable(site.x,site.y) ||
        (commander.cooldowns.get(site)??0)>game.time || distanceTo(site,column)<4) continue;
    const travel=distanceTo(site,column);
    const last=faction.searched.get(site);
    const revisit=last===undefined?0:Math.max(0,34-(game.time-last)*.55);
    const progress=(site.x-home.x)*dx+(site.y-home.y)*dy;
    const flank=Math.abs((site.x-home.x)*dy-(site.y-home.y)*dx);
    const toEnemy=remembered.length?Math.min(...remembered.map(point=>distanceTo(site,point))):null;
    const priority=toEnemy===null?flank*.4-progress*1.05:toEnemy*1.75;
    const value=travel*.32+revisit+threatNear(site)*.07+priority;
    if (value>=lowest) continue;
    lowest=value;
    best=site;
  }
  return best;
}

function observeBattle(faction,army,buildings,members,intelligence,raid) {
  const base=buildings.find(b=>b.type==='yard')??buildings.find(b=>b.type==='factory' || b.type==='barracks')??members[0];
  const home=base?.width?yardCenter(base):base;
  const distance=point=>home?distanceTo(home,point):0;
  const {contacts,frontier}=intelligence;
  const rivals=contacts.filter(unit=>!unit.width && WEAPONS[unit.type]);
  const hostileBuildings=contacts.filter(contact=>contact.width);
  for (const target of hostileBuildings) {
    faction.commander.enemySites.set(target,yardCenter(target));
  }
  for (const [target,point] of faction.commander.enemySites) {
    if (faction.commander.confirmedLosses.has(target) || buildings.includes(target) ||
        (faction.sight.has(tileUnder(point.x,point.y)) && !hostileBuildings.includes(target))) {
      faction.commander.enemySites.delete(target);
    }
  }
  const hostileProduction=hostileBuildings.filter(b=>['factory','barracks','airport'].includes(b.type)).length;
  const powerPlants=hostileBuildings.filter(b=>!b.remaining && BUILDINGS[b.type]?.powerOutput);
  const visibleSupply=powerPlants.reduce((sum,building)=>sum+BUILDINGS[building.type].powerOutput,0);
  const ownPower=army.reduce((total,unit)=>total+combatPower(unit,true),0);
  const mobileThreatNear=point=>rivals.reduce((sum,unit)=>sum+
    (distanceTo(unit,point)<=9?combatPower(unit):0),0);
  const hostileDefenses=hostileBuildings.filter(b=>!b.remaining && BUILDINGS[b.type]?.weapon);
  const threatNear=point=>mobileThreatNear(point)+hostileDefenses.reduce((sum,building)=>{
    const weapon=BUILDINGS[building.type].weapon;
    return sum+(distanceTo(yardCenter(building),point)<=weapon.range+2?weapon.damage/weapon.reload:0);
  },0);
  let homeThreat=home?mobileThreatNear(home):0;
  if (home) {
    for (const [unit,report] of faction.reports) {
      if (!contacts.includes(unit) && game.time-report.time<19 && distanceTo(report,home)<=12) {
        homeThreat+=report.power*.35;
      }
    }
  }
  const homeGuard=home?army.filter(unit=>distanceTo(unit,home)<=10).length:0;
  const fleet=miningFleet(faction,buildings,members);
  const count=type=>buildings.filter(building=>building.type===type && !building.remaining).length;
  const power=faction.power.supply>=faction.power.demand?100:Math.round(faction.power.rate*100);
  const defenses=buildings.filter(b=>BUILDINGS[b.type]?.weapon).length;
  const options=[];
  const add=(task,score,target=null,kind='none',point=null,goal=0)=>{
    if (!target || !point) point=home??{x:0,y:0};
    const key=target??task;
    if (score>0 && (faction.commander.cooldowns.get(key)??0)>game.time) return;
    const risk=threatNear(point);
    options.push({task,score,target,key,point,goal,kind,distance:Math.round(distance(point)),
      risk:risk>Math.max(55,ownPower*.75)?'high':risk>0?'medium':'low'});
  };
  const factories=count('factory'),barracks=count('barracks'),yards=count('yard');
  const underPressure=Boolean(raid?.critical || faction.defensive);
  const openingEconomy=game.time<115 && fleet.desired>0 && fleet.active+fleet.ordered<2;
  const campaignReady=!underPressure && !openingEconomy &&
    (army.length>=4 || (!factories && !barracks && army.length>0 && game.time>=75));
  if (factories && fleet.active+fleet.ordered<fleet.desired) {
    const early=fleet.active+fleet.ordered<2 && game.time<150;
    add('mine',early?120:68,null,'mine',null,early?2:fleet.desired);
  }
  if (yards && power<90) add('power',power<55?108:64,null,'power');
  if (!underPressure && yards && factories>=1 && factories<4 &&
      buildings.filter(building=>building.type==='factory').length===factories &&
      fleet.active>=2 && army.length>=3 && power>=80 && faction.credits>=BUILDINGS.factory.cost+PRODUCTS.tank.cost) {
    add('industry',factories===1?88:72,null,'industry',null,factories+1);
  }
  const hasAirport=buildings.some(building=>building.type==='airport');
  const aircraft=members.filter(isAirborne).length;
  if (!underPressure && yards && factories && barracks && fleet.active>=2 &&
      army.length>=3 && !aircraft && power>=72 &&
      faction.credits>=(hasAirport?PRODUCTS.reconPlane.cost*.6:BUILDINGS.airport.cost*.75)) {
    add('airpower',hasAirport?85:faction.strategy==='aggressive'?79:69,null,'airpower');
  }
  if (factories || barracks) add('mobilize',underPressure?96:army.length<3?86:40,null,'reserve',null,army.length+2);
  if (yards && defenses<4 && (underPressure || faction.credits>=425)) {
    add('fortify',underPressure?105:faction.strategy==='conservative' && defenses<2?64:45,
      null,'defense',null,defenses+1);
  }
  if (yards && power>=82 && army.length>=3 && faction.credits>=750 &&
      faction.discoveries.size<Object.keys(RESEARCH_PROGRAMS).length) {
    add('research',faction.credits>=1400 && army.length>=6?78:58,null,'research',null,faction.discoveries.size+1);
  }

  const scouts=members.filter(unit=>!unit.attackTarget &&
    (unit.type==='reconPlane' || unit.type!=='bomber' && isArmyType(unit.type)));
  if (scouts.length) {
    const lead=faction.commander.scoutLead;
    const findLead=lead && lead.until>game.time;
    const frontierRank=site=>{
      const unknown=NEIGHBORS.filter(([dx,dy])=>onMap(site.x+dx*4,site.y+dy*4) &&
        !faction.explored.has(tileKey(site.x+dx*4,site.y+dy*4))).length;
      return Math.min(55,distance(site))*.33+(faction.searched.get(site)??0)*.035+
        threatNear(site)*.11-unknown*1.4+(findLead?Math.min(25,distanceTo(site,lead.point))*1.1:0);
    };
    const weighted=frontier.filter(tile=>(faction.commander.cooldowns.get(tile)??0)<=game.time)
      .map(site=>({site,rank:frontierRank(site)}))
      .sort((a,b)=>a.rank-b.rank);
    for (const {site} of weighted.slice(0,2)) {
      add('recon',findLead && distanceTo(site,lead.point)<16?88:contacts.length?39:62,site,'frontier',site);
    }
  }
  if (barracks && army.length && !underPressure) {
    const fields=structures.filter(building=>building.type==='oil' && captureAvailable(faction,building));
    fields.sort((a,b)=>{
      const score=building=>distance(yardCenter(building))+threatNear(yardCenter(building))*.25+(building.team==='neutral'?0:5);
      return score(a)-score(b);
    });
    for (const field of fields.slice(0,2)) {
      add('capture',fleet.active>=2?84:65,field,field.team==='neutral'?'neutral_oil':'hostile_oil',yardCenter(field));
    }
  }
  if (army.length && !faction.defensive) {
    const threat=rivals.slice().sort((a,b)=>distance(a)-distance(b))[0];
    if (threat) {
      const danger=threatNear(threat);
      const nearby=distance(threat)<=BASE_DEFENSE_RADIUS+2;
      if (nearby || ownPower>=danger*.82) {
        add('intercept',nearby?140:campaignReady?104:75,threat,isAirborne(threat)?'aircraft':
          armoredTarget(threat)?'armor':'infantry',{x:threat.x,y:threat.y});
      }
    }
    if (!underPressure && army.length>=2 && army.length<=8 && homeThreat<=ownPower*.32) {
      const squadPower=ownPower/army.length*Math.min(3,army.length-1);
      const exposed=contacts.filter(target=>target.type==='miner' || target.type==='refinery' ||
        target.type==='oil' || target.type==='solar' || target.type==='diesel').map(target=>{
        const point=target.width?yardCenter(target):{x:target.x,y:target.y};
        const danger=threatNear(point)-(target.type==='miner'?combatPower(target)*.75:0);
        const kind=target.type==='miner'?'miner':BUILDINGS[target.type]?.powerOutput?'power_plant':'economy';
        return {target,point,kind,danger,rank:distance(point)*.38+danger*.45-
          (kind==='power_plant' && hostileProduction?6:0)};
      }).filter(candidate=>candidate.danger<squadPower*.72 &&
        (faction.commander.cooldowns.get(candidate.target)??0)<=game.time);
      exposed.sort((a,b)=>a.rank-b.rank);
      const raidSite=exposed[0];
      if (raidSite) {
        const rating=faction.strategy==='aggressive'?106:fleet.active>=2?90:57;
        add('harass',rating,raidSite.target,raidSite.kind,raidSite.point);
      }
    }
    const strikes=hostileBuildings.map(target=>{
      const point=yardCenter(target);
      const spec=BUILDINGS[target.type];
      const output=spec?.powerOutput??0;
      const impact=output && !target.remaining?(hostileProduction?22:10)+8*output/visibleSupply:0;
      const danger=threatNear(point);
      const rank=distance(point)+danger*.15-impact-
        (['yard','factory','barracks','refinery'].includes(target.type)?8:0)+
        (target.type==='oil' || target.type==='wall'?10:0);
      return {target,point,rank,danger,impact,kind:output?'power_plant':spec?.weapon?'defense':'infrastructure'};
    }).filter(strike=>ownPower>=strike.danger*1.2 && (strike.kind!=='defense' || ownPower>=100) &&
      (faction.commander.cooldowns.get(strike.target)??0)<=game.time);
    strikes.sort((a,b)=>a.rank-b.rank);
    for (const {target,point,impact,kind} of strikes.slice(0,2)) {
      add('strike',(faction.strategy==='aggressive'?92:82)+impact+(campaignReady?29:0),target,kind,point);
    }
  }
  if (campaignReady && home && !options.some(option=>CAMPAIGN_TASKS.has(option.task))) {
    const waypoint=campaignWaypoint(faction,home,army,frontier,threatNear);
    if (waypoint) add('advance',108,waypoint,'frontier',waypoint);
  }
  if (!options.length) add('mobilize',0,null,'reserve',null,army.length+2);
  return {options,contacts,fleet,power,defenses,army,members,aircraft,buildings,campaignReady,
    snapshot:{
      personality:faction.strategy,
      situation:raid?.critical?'raided':faction.defensive?'outmatched':contacts.length?'contested':'clear',
      own:{credits:faction.credits,power,army:army.length,strength:Math.round(ownPower),
        miners:fleet.active,miners_ordered:fleet.ordered,ore:fleet.ore,
        oil:count('oil'),factories,barracks,airports:count('airport'),aircraft,
        defenses,home_guard:homeGuard,home_threat:Math.round(homeThreat)},
      enemy:{armor:rivals.filter(armoredTarget).length,infantry:rivals.filter(isPersonnel).length,
        aircraft:contacts.filter(isAirborne).length,
        buildings:hostileBuildings.length,production:hostileProduction,power_plants:powerPlants.length,
        strength:Math.round(rivals.reduce((total,unit)=>total+combatPower(unit),0)),
        remembered:[...faction.reports.keys()].filter(unit=>!contacts.includes(unit)).length},
      recent:faction.commander.last,
      options:options.map(({task,kind,distance,risk})=>({task,kind,distance,risk})),
    },
  };
}

function requestCommanderPlan(faction,battle) {
  const commander=faction.commander;
  if (!codexAvailable || commanderRequestInFlight || commander.proposal || game.time<commander.nextRequest ||
      battle.options.length<2 || game.outcome) return;

  commanderRequestInFlight=true;
  commander.nextRequest=game.time+43;
  fetch('/api/strategy',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(battle.snapshot),
    signal:AbortSignal.timeout(35000),
  }).then(response=>{
    if (response.status===429) commander.nextRequest=game.time+10;
    if (!response.ok) return null;
    return response.json();
  }).then(reply=>{
    if (!reply || game.outcome || !Number.isInteger(reply.primary) ||
        !Number.isInteger(reply.followup) || reply.followup < -1 || reply.followup===reply.primary) return;
    const primary=battle.options[reply.primary],followup=battle.options[reply.followup];
    if (!primary || (reply.followup!==-1 && !followup)) return;
    commander.proposal={primary,followup,until:game.time+8};
    commander.nextReview=0;
  }).catch(()=>{}).finally(()=>{commanderRequestInFlight=false;});
}

function evaluateCommand(faction,plan,battle) {
  const {task,target,goal}=plan;
  const confirmed=faction.commander.confirmedLosses;
  if (task==='mine' && battle.fleet.active>=goal ||
      task==='power' && battle.power>=90 ||
      task==='industry' && battle.buildings.filter(b=>b.type==='factory' && !b.remaining).length>=goal ||
      task==='airpower' && battle.aircraft>0 ||
      task==='mobilize' && battle.army.length>=goal ||
      task==='fortify' && battle.defenses>=goal ||
      task==='research' && faction.discoveries.size>=goal ||
      task==='capture' && battle.buildings.includes(target) ||
      task==='recon' && battle.members.includes(plan.scout) && distanceTo(plan.scout,plan.point)<=2.1 ||
      task==='advance' && plan.marchers?.length && plan.marchers.filter(unit=>
        battle.army.includes(unit) && distanceTo(unit,plan.point)<3.5).length>=Math.min(2,plan.marchers.length) ||
      ['strike','intercept','harass'].includes(task) && (confirmed.has(target) || battle.buildings.includes(target))) {
    return 'complete';
  }
  if (faction.defensive && (task==='capture' || CAMPAIGN_TASKS.has(task))) return 'interrupted';
  const activeFront=battle.campaignReady && battle.options.some(option=>CAMPAIGN_TASKS.has(option.task));
  if (task==='advance' && activeFront && battle.options.some(option=>option.task!=='advance' &&
      CAMPAIGN_TASKS.has(option.task))) return 'interrupted';
  if (activeFront && !CAMPAIGN_TASKS.has(task) && game.time>=plan.started+8 &&
      !(task==='power' && battle.power<55)) return 'interrupted';
  if (task==='harass' && (battle.army.length<2 || battle.snapshot.own.home_threat>battle.snapshot.own.strength*.4)) {
    return 'interrupted';
  }
  if (!faction.defensive && !['fortify','intercept'].includes(task) &&
      battle.options.some(option=>option.task==='intercept' && option.score>=140)) return 'interrupted';
  if (task!=='mine' && !['fortify','intercept','strike','harass'].includes(task) &&
      battle.options.some(option=>option.task==='mine' && option.score>=120)) return 'interrupted';
  if (task==='strike' && plan.kind!=='power_plant' && battle.options.some(option=>
    option.kind==='power_plant' && option.score>=105 && option.risk!=='high')) return 'interrupted';
  if (['capture','strike','intercept','harass'].includes(task)) {
    if (task==='capture' && confirmed.has(target)) return 'stalled';
    const visible=task==='capture'?captureAvailable(faction,target):battle.contacts.includes(target);
    if (visible) {
      plan.lastSeen=game.time;
      if (!target.width) plan.point={x:target.x,y:target.y};
    } else if (game.time-plan.lastSeen>=5) return 'lost';
  }
  if (game.time>=plan.until) return 'stalled';
  return null;
}

function reviewCommander(faction,army,buildings,members,intelligence,raid) {
  const commander=faction.commander;
  if (raid?.critical) {
    if (commander.plan) commander.last={task:commander.plan.task,result:'interrupted'};
    commander.plan=null;
    commander.proposal=null;
    commander.nextReview=0;
    faction.orders={mode:'guard',task:'fortify',target:null,source:'local'};
    return;
  }
  if (game.time<commander.nextReview) return;
  commander.nextReview=game.time+1.4;
  for (const [key,until] of commander.cooldowns) if (until<=game.time) commander.cooldowns.delete(key);
  const battle=observeBattle(faction,army,buildings,members,intelligence,raid);
  const available=choice=>choice && battle.options.find(option=>option.task===choice.task && option.key===choice.key);
  let next=null,source='local',followup=null;
  if (commander.plan) {
    const result=evaluateCommand(faction,commander.plan,battle);
    if (result) {
      const previous=commander.plan;
      commander.last={task:previous.task,result};
      battle.snapshot.recent=commander.last;
      const wait=previous.target?20:previous.task==='mobilize'?4:8;
      commander.cooldowns.set(previous.key,game.time+(result==='complete'?wait:20));
      if (result==='lost' || result==='stalled' && previous.task==='capture') {
        commander.scoutLead={point:previous.point,until:game.time+23};
      }
      log(factionName(faction.team)+'指挥计划：'+commandLabel(previous)+COMMAND_RESULTS[result]+'。',faction.team);
      next=result==='complete'?available(previous.followup):null;
      if (next) source=previous.source;
      commander.plan=null;
    }
  }

  const proposal=commander.proposal;
  if (proposal) {
    commander.proposal=null;
    const choice=proposal.until>=game.time?available(proposal.primary):null;
    const mineFirst=battle.options.some(option=>option.task==='mine' && option.score>=120);
    const lastDefense=battle.options.some(option=>option.task==='intercept' && option.score>=140);
    const campaignNeeded=battle.campaignReady && battle.options.some(option=>CAMPAIGN_TASKS.has(option.task));
    const usefulForCampaign=choice && (CAMPAIGN_TASKS.has(choice.task) ||
      (choice.task==='power' && battle.power<55));
    if (choice && !commander.cooldowns.has(choice.key) && (!mineFirst || choice.task==='mine') &&
        (!lastDefense || ['intercept','fortify','mobilize'].includes(choice.task)) &&
        (!campaignNeeded || usefulForCampaign || lastDefense)) {
      next=choice;
      followup=proposal.followup;
      source='Codex';
    }
  }
  if (!commander.plan && !next) {
    const candidates=battle.options.filter(option=>!commander.cooldowns.has(option.key));
    next=candidates.sort((a,b)=>b.score-a.score)[0]??battle.options[0];
  }
  if (next) {
    const active=commander.plan;
    if (active?.key===next.key && active.task===next.task) {
      active.source=source;
      active.followup=followup;
    } else {
      commander.plan={...next,source,followup,started:game.time,lastSeen:game.time,
        until:game.time+COMMAND_TASKS[next.task].duration};
      if (next.task==='advance') faction.searched.set(next.target,game.time);
      log(factionName(faction.team)+(source==='Codex'?'采用 Codex 计划：':'指挥智能体：')+commandLabel(next)+'。',faction.team);
    }
  }
  const current=commander.plan;
  faction.orders={mode:faction.defensive?'guard':COMMAND_TASKS[current.task].mode,
    task:current.task,target:current.target,source:current.source};
  requestCommanderPlan(faction,battle);
}
