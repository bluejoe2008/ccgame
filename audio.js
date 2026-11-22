'use strict';

const sound = (() => {
  const Audio = window.AudioContext || window.webkitAudioContext;
  const button = document.getElementById('sound-toggle');
  const icon = button.querySelector('.sound-icon');
  const preference = 'ore-command-muted';
  let muted = false;
  let context, master, texture;
  let resuming = false;
  let unavailable = !Audio;
  const lastPlayed = new Map();
  const activeSpatial = new Set();
  const MAX_SPATIAL_VOICES = 32;

  try {
    muted = localStorage.getItem(preference) === '1';
  } catch {
    // Sound remains available when this browser blocks storage.
  }

  function syncButton() {
    button.disabled = unavailable;
    button.setAttribute('aria-pressed', String(muted));
    button.title = unavailable ? '当前浏览器不支持音效' : muted ? '打开音效' : '静音';
    icon.textContent = muted || unavailable ? '♪̸' : '♪';
  }

  function unlock() {
    if (muted || unavailable) return;
    if (!context) {
      try {
        context = new Audio();
        master = context.createGain();
        master.gain.value = .32;
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -17;
        limiter.ratio.value = 5;
        master.connect(limiter);
        limiter.connect(context.destination);
      } catch {
        unavailable = true;
        syncButton();
        return;
      }
    }
    if (context.state !== 'running' && !resuming) {
      resuming = true;
      context.resume().catch(() => {}).finally(() => { resuming = false; });
    }
  }

  function envelope(output,start,duration,volume) {
    const gain = context.createGain();
    gain.gain.setValueAtTime(.0001,start);
    gain.gain.exponentialRampToValueAtTime(volume,start+Math.min(.009,duration*.2));
    gain.gain.exponentialRampToValueAtTime(.0001,start+duration);
    gain.connect(output);
    return gain;
  }

  function tone(output,start,type,from,to,duration,volume,offset=0) {
    start+=offset;
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from,start);
    oscillator.frequency.exponentialRampToValueAtTime(to,start+duration);
    oscillator.connect(envelope(output,start,duration,volume));
    oscillator.start(start);
    oscillator.stop(start+duration);
  }

  function noise(output,start,filterType,frequency,duration,volume,offset=0) {
    start+=offset;
    if (!texture) {
      texture = context.createBuffer(1,context.sampleRate,context.sampleRate);
      const data = texture.getChannelData(0);
      for (let i=0;i<data.length;i++) data[i]=Math.random()*2-1;
    }
    const grain = context.createBufferSource();
    grain.buffer = texture;
    const filter = context.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = .72;
    grain.connect(filter);
    filter.connect(envelope(output,start,duration,volume));
    grain.start(start,Math.random()*(1-duration));
    grain.stop(start+duration);
  }

  const cues = {
    select: [.055, (tone) => tone('sine',530,830,.08,.19)],
    move: [.075, (tone) => {
      tone('triangle',350,510,.09,.20);
      tone('sine',630,800,.08,.15,.065);
    }],
    cancel: [.075, (tone) => tone('triangle',440,215,.11,.16)],
    build: [.12, (tone,noise) => {
      tone('triangle',145,72,.19,.29);
      noise('lowpass',900,.17,.27);
      tone('triangle',185,120,.13,.19,.115);
    }],
    queue: [.07, (tone) => {
      tone('square',288,420,.065,.065);
      tone('sine',610,680,.12,.18,.05);
    }],
    ready: [.24, (tone) => {
      tone('triangle',440,440,.13,.20);
      tone('triangle',554,554,.15,.18,.085);
      tone('sine',740,699,.23,.22,.17);
    }],
    mining: [.62, (tone,noise) => {
      noise('bandpass',1400,.12,.23);
      tone('triangle',428,174,.10,.11);
    }],
    cash: [.16, (tone) => {
      tone('sine',960,740,.18,.21);
      tone('triangle',1230,1000,.14,.16,.071);
    }],
    alert: [.35, (tone) => {
      tone('triangle',720,500,.16,.21);
      tone('triangle',720,500,.18,.19,.16);
    }],
    attack: [.12, (tone) => {
      tone('triangle',245,370,.14,.23);
      tone('square',430,270,.11,.07,.06);
    }],
    rifle: [.09, (tone,noise) => {
      noise('bandpass',2400,.14,.62);
      tone('triangle',160,58,.105,.44);
    }],
    cannon: [.13, (tone,noise) => {
      noise('lowpass',1300,.36,.58);
      tone('triangle',140,38,.34,.69);
    }],
    rocket: [.17, (tone,noise) => {
      noise('bandpass',1550,.19,.43);
      tone('triangle',325,94,.20,.29);
    }],
    mortar: [.20, (tone,noise) => {
      tone('triangle',185,62,.23,.42);
      noise('lowpass',950,.16,.42);
    }],
    laser: [.16, (tone,noise) => {
      tone('triangle',2050,530,.155,.32);
      tone('sine',790,228,.19,.36,.022);
      noise('bandpass',2600,.10,.15);
    }],
    explosion: [.18, (tone,noise) => {
      noise('lowpass',750,.56,.67);
      tone('triangle',104,31,.49,.65);
    }],
    bark: [.32, (tone,noise) => {
      tone('sawtooth',320,136,.13,.22);
      noise('bandpass',850,.13,.30);
      tone('triangle',275,132,.10,.20,.15);
    }],
  };

  function play(cue,spatial=null) {
    if (muted || unavailable || !context || document.hidden ||
        (context.state !== 'running' && !resuming)) return;
    const [interval,render] = cues[cue];
    const now=context.currentTime;
    const key=spatial?cue+':'+spatial.source:cue;
    if (now-(lastPlayed.get(key)??-Infinity)<interval) return;
    if (spatial && activeSpatial.size>=MAX_SPATIAL_VOICES) {
      let quietest=null;
      for (const playing of activeSpatial) {
        if (!quietest || playing.level<quietest.level) quietest=playing;
      }
      if (spatial.level<=quietest.level) return;
      quietest.gain.gain.setTargetAtTime(0,now,.012);
      activeSpatial.delete(quietest);
    }
    if (lastPlayed.size>512) {
      for (const [id,time] of lastPlayed) if (now-time>2) lastPlayed.delete(id);
    }
    lastPlayed.set(key,now);

    const gain=context.createGain();
    gain.gain.value=spatial?.level??1;
    let filter=null,stereo=null,tail=gain;
    const voice={gain,level:gain.gain.value};
    if (spatial) {
      activeSpatial.add(voice);
      filter=context.createBiquadFilter();
      filter.type='lowpass';
      filter.frequency.value=spatial.cutoff;
      filter.Q.value=.45;
      gain.connect(filter);
      tail=filter;
      if (context.createStereoPanner) {
        stereo=context.createStereoPanner();
        stereo.pan.value=spatial.pan;
        filter.connect(stereo);
        tail=stereo;
      }
    }
    tail.connect(master);
    const start=now+.008;
    render((...notes)=>tone(gain,start,...notes),(...grains)=>noise(gain,start,...grains));
    // Retire the spatial channel after all notes of the cue have ended.
    setTimeout(()=>{
      activeSpatial.delete(voice);
      gain.disconnect();
      filter?.disconnect();
      stereo?.disconnect();
    },700);
  }

  button.addEventListener('click', () => {
    muted = !muted;
    if (master) {
      master.gain.setTargetAtTime(muted?0:.32,context.currentTime,.015);
    }
    try {
      localStorage.setItem(preference,muted?'1':'0');
    } catch {
      // The current session still keeps the user's choice.
    }
    syncButton();
    if (!muted) {
      unlock();
      play('select');
    }
  });

  for (const type of ['pointerdown','pointerup','keydown','click']) {
    document.addEventListener(type, () => {
      if (context?.state !== 'running') unlock();
    }, {capture:true,passive:true});
  }

  syncButton();
  return {play};
})();
