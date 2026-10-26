(function () {
  'use strict';

  function followUp(hand, card) {
    return '[carl-duel-mode 选牌]\n回合：' + hand.turn_id + '\n卡牌：' + card.title +
      '（' + card.id + '）\n\n' + card.prompt;
  }

  function createController(options) {
    const { hand, getHost, onUpdate = () => {}, onEffect = () => {} } = options;
    let state = { selectedId: null, phase: 'ready', prompt: '' };
    let interacted = false;
    const emit = () => onUpdate({ ...state });
    const save = () => {
      try {
        const host = getHost();
        if (typeof host?.setWidgetState === 'function') {
          Promise.resolve(host.setWidgetState({
            modelContent: { skill: 'carl-duel-mode', turn_id: hand.turn_id,
              selected_id: state.selectedId, phase: state.phase },
            privateContent: { ...(options.getAudioState?.() || {}) }
          })).catch(() => {});
        }
      } catch (_) { /* Persistence is optional and never sends a turn. */ }
    };
    return {
      getState: () => ({ ...state }),
      save,
      restore(snapshot) {
        const saved = snapshot?.modelContent;
        if (interacted || saved?.turn_id !== hand.turn_id ||
            !hand.cards.some(card => card.id === saved.selected_id)) return false;
        const card = hand.cards.find(card => card.id === saved.selected_id);
        state = { selectedId: card.id, phase: 'restored', prompt: followUp(hand, card) };
        emit();
        return true;
      },
      choose(id) {
        if (state.selectedId) return false;
        const card = hand.cards.find(item => item.id === id);
        if (!card) return false;
        interacted = true;
        state = { selectedId: id, phase: 'pending', prompt: followUp(hand, card) };
        emit();
        let result;
        try {
          const host = getHost();
          if (typeof host?.sendFollowUpMessage !== 'function') {
            state.phase = 'unavailable';
            emit();
          } else {
            // Invoke in this click stack, before any animation/audio awaits.
            result = host.sendFollowUpMessage({ prompt: state.prompt, title: '发动「' + card.title + '」' });
            Promise.resolve(result).then(() => {
              state.phase = 'requested'; emit(); save();
            }, () => {
              state.phase = 'error'; emit(); save();
            });
          }
        } catch (_) { state.phase = 'error'; emit(); }
        try { onEffect(card); } catch (_) { /* Sound is independent of the choice. */ }
        save();
        return true;
      }
    };
  }

  const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);
  function tone(ctx, dest, frequency, when, length, gain, type = 'triangle') {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, when);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(gain, when + .012);
    env.gain.exponentialRampToValueAtTime(.0001, when + length);
    osc.connect(env); env.connect(dest);
    osc.start(when); osc.stop(when + length + .02);
  }
  function noise(ctx, dest, when, length, gain, highpass = 2800) {
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const source = ctx.createBufferSource(); source.buffer = buffer;
    const filter = ctx.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = highpass;
    const env = ctx.createGain(); env.gain.setValueAtTime(gain, when);
    env.gain.exponentialRampToValueAtTime(.0001, when + length);
    source.connect(filter); filter.connect(env); env.connect(dest);
    source.start(when); source.stop(when + length);
  }
  function kick(ctx, dest, when) {
    const osc = ctx.createOscillator(); const env = ctx.createGain();
    osc.frequency.setValueAtTime(140, when); osc.frequency.exponentialRampToValueAtTime(42, when + .18);
    env.gain.setValueAtTime(.7, when); env.gain.exponentialRampToValueAtTime(.0001, when + .23);
    osc.connect(env); env.connect(dest); osc.start(when); osc.stop(when + .25);
  }
  function scheduleOpening(ctx, output, start) {
    const bus = ctx.createGain(); bus.connect(output);
    bus.gain.setValueAtTime(.85, start);
    bus.gain.setValueAtTime(.85, start + 6.4);
    bus.gain.linearRampToValueAtTime(0, start + 8);
    const beat = .4; // Original 150 BPM, four bars + a 1.6 second tail.
    const roots = [38, 34, 36, 33];
    const melody = [74,81,77,76,74,72,69,72, 77,81,82,81,77,76,74,72,
      76,79,84,79,76,74,72,76, 73,76,81,79,76,73,69,73];
    for (let step = 0; step < 32; step++) {
      const t = start + step * beat / 2;
      const root = roots[Math.floor(step / 8)];
      tone(ctx, bus, hz(root + (step % 2 ? 12 : 0)), t, .17, .23, 'sawtooth');
      tone(ctx, bus, hz(melody[step]), t, .3, .15, 'sawtooth');
      noise(ctx, bus, t, .055, step % 2 ? .07 : .11, 6500);
      if (step % 2 === 0) kick(ctx, bus, t);
      if (step % 4 === 2) noise(ctx, bus, t, .15, .22, 1200);
      if (step % 8 === 0) {
        [0, 7, 15].forEach((n, i) => tone(ctx, bus, hz(root + 24 + n), t, 1.55, .055 / (i + 1), 'sawtooth'));
      }
    }
    [62, 69, 74].forEach(n => tone(ctx, bus, hz(n), start + 6.4, 1.6, .13, 'triangle'));
    [0, .1, .2].forEach(t => noise(ctx, bus, start + t, .12, .15, 1800));
    return bus;
  }
  function scheduleActivate(ctx, output, start) {
    noise(ctx, output, start, .35, .35, 900);
    [62, 69, 74, 81].forEach((n, i) => tone(ctx, output, hz(n), start + i * .055, .6, .2, 'triangle'));
    kick(ctx, output, start + .18);
  }

  function createAudioEngine(config = {}, env = globalThis, onStatus = () => {}) {
    const clampVolume = value => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : .22;
    let volume = clampVolume(config.volume ?? .22);
    let enabled = config.enabled !== false;
    let ctx, master, opening, media, endTimer;
    let played = false, phase = enabled ? 'idle' : 'off';
    let generation = 0;
    const timers = new Set();
    const timer = (callback, delay) => {
      const id = env.setTimeout(() => { timers.delete(id); callback(); }, delay);
      timers.add(id); return id;
    };
    const report = value => { phase = value; onStatus(value); };
    const readyContext = (gesture, token) => {
      try {
        if (!ctx) {
          const Context = env.AudioContext || env.webkitAudioContext;
          if (!Context) { report('unavailable'); return Promise.resolve(false); }
          ctx = new Context();
          master = ctx.createGain(); master.gain.value = volume;
          const limiter = ctx.createDynamicsCompressor();
          limiter.threshold.value = -14; limiter.knee.value = 12; limiter.ratio.value = 8;
          master.connect(limiter); limiter.connect(ctx.destination);
        }
        if (ctx.state === 'running') return Promise.resolve(true);
        if (!gesture) { report('blocked'); return Promise.resolve(false); }
        return Promise.resolve(ctx.resume()).then(() => {
          const running = ctx.state === 'running';
          if (!running && token === generation) report('blocked');
          return running;
        }).catch(() => { if (token === generation) report('blocked'); return false; });
      } catch (_) { report('unavailable'); return Promise.resolve(false); }
    };
    const stopOpening = () => {
      if (endTimer) { env.clearTimeout(endTimer); timers.delete(endTimer); endTimer = null; }
      if (opening && ctx) {
        const now = ctx.currentTime;
        opening.gain.cancelScheduledValues(now);
        opening.gain.setTargetAtTime(0, now, .06);
        opening = null;
      }
      if (media) { media.pause(); media = null; }
    };
    const finish = () => { stopOpening(); report(enabled ? 'finished' : 'off'); };
    return {
      getState: () => ({ enabled, volume, played, phase }),
      setVolume(value) {
        volume = Math.min(1, Math.max(0, Number(value) || 0));
        if (master && ctx) master.gain.setTargetAtTime(volume, ctx.currentTime, .025);
        if (media) media.volume = volume;
      },
      restore(saved) {
        if (!saved || typeof saved !== 'object') return;
        if (typeof saved.volume === 'number') volume = clampVolume(saved.volume);
        if (typeof saved.enabled === 'boolean') enabled = saved.enabled;
        played = saved.played === true;
        report(!enabled ? 'off' : played ? 'finished' : 'idle');
      },
      stop() {
        enabled = false; generation++;
        stopOpening();
        if (master && ctx) master.gain.setTargetAtTime(0, ctx.currentTime, .025);
        report('off');
      },
      async startOpening(gesture = false, replay = false) {
        if ((!enabled && !gesture) || (played && !replay)) return false;
        enabled = true;
        const token = ++generation;
        stopOpening();
        if (config.source) {
          try {
            if (!media) media = new env.Audio(config.source);
            media.volume = volume;
            const candidate = media;
            await candidate.play();
            if (token !== generation) { candidate.pause(); return false; }
            played = true; report('playing');
            timer(() => {
              if (token !== generation || !media) return;
              const before = media.volume; let step = 0;
              const fade = () => {
                if (token !== generation || !media) return;
                media.volume = before * Math.max(0, 1 - ++step / 16);
                if (step < 16) timer(fade, 100);
              };
              fade();
            }, 6400);
            candidate.onended = () => { if (token === generation) finish(); };
            endTimer = timer(() => { if (token === generation) finish(); }, 8000);
            return true;
          } catch (_) { if (token === generation) { media = null; report('blocked'); } return false; }
        }
        if (!await readyContext(gesture, token) || token !== generation) return false;
        master.gain.setTargetAtTime(volume, ctx.currentTime, .01);
        played = true; opening = scheduleOpening(ctx, master, ctx.currentTime + .025);
        report('playing'); endTimer = timer(finish, 8050);
        return true;
      },
      async activate() {
        if (!enabled) return false;
        const token = ++generation; stopOpening();
        if (!await readyContext(true, token) || token !== generation || !enabled) return false;
        master.gain.setTargetAtTime(volume, ctx.currentTime, .01);
        scheduleActivate(ctx, master, ctx.currentTime + .01);
        report('effect'); timer(() => { if (phase === 'effect') report('finished'); }, 1000);
        return true;
      },
      dispose() {
        generation++; stopOpening();
        timers.forEach(id => env.clearTimeout(id)); timers.clear();
        if (ctx) Promise.resolve(ctx.close()).catch(() => {});
      }
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { followUp, createController, createAudioEngine, scheduleOpening, scheduleActivate };
    return;
  }

  const root = document.getElementById('__ROOT_ID__');
  if (!root) return;
  const hand = JSON.parse(root.querySelector('[data-duel-data]').textContent);
  const role = name => root.querySelector('[data-role="' + name + '"]');
  const status = role('status'); const manual = role('manual');
  const promptArea = role('selection-prompt'); const soundButton = role('audio-toggle');
  const volumeInput = role('volume'); const audioStatus = role('audio-state');
  role('round').textContent = (hand.mode === 'acceptance' ? '验收回合 ' : '行动回合 ') + String(hand.round).padStart(2, '0');
  const cardButtons = new Map();
  const cardSlots = new Map();
  let previewBlocked = false;
  let previewId = null;
  const setPreview = id => {
    if (previewBlocked && id) return;
    previewId = id;
    root.classList.toggle('has-preview', Boolean(id));
    if (id) {
      root.dataset.previewCard = id;
      root.classList.remove('is-dealing');
    } else delete root.dataset.previewCard;
    cardSlots.forEach((slot, cardId) => {
      slot.classList.toggle('is-preview', cardId === id);
      if (cardId !== id) {
        slot.style.removeProperty('--tilt-x');
        slot.style.removeProperty('--tilt-y');
      }
    });
  };
  const attributes = { blade: ['战', '行动 · 执行'], oracle: ['知', '魔法 · 探索'], portal: ['变', '魔法 · 转向'] };
  const make = (tag, className, text) => {
    const element = document.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  hand.cards.forEach((card, index) => {
    const slot = make('div', 'duel-slot');
    slot.dataset.cardId = card.id;
    const button = make('button', 'duel-card cursor-interaction');
    button.type = 'button'; button.dataset.cardId = card.id; button.dataset.art = card.art;
    button.setAttribute('aria-label', card.title + '。' + card.effect + '。点击发动');
    button.setAttribute('aria-pressed', 'false');
    const title = make('span', 'duel-card-title');
    title.append(make('strong', '', card.title), make('span', 'duel-attribute', attributes[card.art][0]));
    const type = make('span', 'duel-card-type', attributes[card.art][1]);
    let art;
    if (card.image) {
      art = make('img', 'duel-art'); art.src = card.image; art.alt = ''; art.draggable = false;
    } else art = make('span', 'duel-art-missing', card.image_missing || '插画暂不可用');
    const effect = make('span', 'duel-effect');
    effect.append(make('span', 'duel-effect-label', '【效果】'), make('span', 'duel-effect-text', card.effect));
    const serial = make('span', 'duel-card-id');
    serial.append(make('span', '', 'CARL · ' + String(index + 1).padStart(3, '0')), make('span', '', '点击发动'));
    button.append(title, type, art, effect, serial);
    slot.append(button); role('hand').append(slot);
    cardButtons.set(card.id, button); cardSlots.set(card.id, slot);
    // The slot keeps its hit area while the card lifts, avoiding hover flicker.
    slot.addEventListener('pointerenter', () => setPreview(card.id));
    slot.addEventListener('pointerleave', () => {
      if (document.activeElement !== button && previewId === card.id) setPreview(null);
    });
    slot.addEventListener('focusin', () => setPreview(card.id));
    slot.addEventListener('focusout', event => {
      if (!slot.contains(event.relatedTarget) && !slot.matches(':hover') && previewId === card.id) setPreview(null);
    });
    slot.addEventListener('pointermove', event => {
      if (previewBlocked || previewId !== card.id || event.pointerType === 'touch') return;
      const box = button.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, (event.clientX - box.left) / box.width * 2 - 1));
      const y = Math.max(-1, Math.min(1, (event.clientY - box.top) / box.height * 2 - 1));
      slot.style.setProperty('--tilt-x', (-y * 4).toFixed(2) + 'deg');
      slot.style.setProperty('--tilt-y', (x * 6).toFixed(2) + 'deg');
    });
  });

  const handElement = role('hand');
  let lastFanSize = '';
  const sizeFan = () => {
    const width = handElement.clientWidth;
    if (!width) return;
    const cardWidth = Math.max(156, Math.min(224, width * .38));
    handElement.style.setProperty('--card-width', cardWidth.toFixed(2) + 'px');
    const height = Math.max(...[...cardButtons.values()].map(button => button.offsetHeight));
    const key = width + ':' + height;
    if (key === lastFanSize) return;
    lastFanSize = key;
    const targetAngle = width < 450 ? 12 : 15;
    const desiredEscape = height * 1.1 * Math.sin(targetAngle * Math.PI / 180);
    const spread = Math.max(12, Math.min(112, (width - cardWidth) / 2 - desiredEscape - 16));
    const room = Math.max(0, (width - cardWidth) / 2 - spread - 16);
    const angle = Math.min(targetAngle, Math.asin(Math.min(1, room / (height * 1.1))) * 180 / Math.PI);
    handElement.style.setProperty('--spread', spread.toFixed(2) + 'px');
    handElement.style.setProperty('--fan-angle', angle.toFixed(2) + 'deg');
  };
  sizeFan();
  const fanObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(sizeFan) : null;
  fanObserver?.observe(handElement);
  cardButtons.forEach(button => fanObserver?.observe(button));
  window.addEventListener('resize', sizeFan);

  const engine = createAudioEngine(hand.audio, window, phase => {
    const descriptions = {
      idle: '', blocked: '声音需要点击启用', playing: '决斗序曲 · 8 秒后淡出',
      finished: '配乐已结束', off: '声音已关闭', unavailable: '当前环境无法播放声音，选牌仍可使用', effect: '发动音效'
    };
    audioStatus.textContent = descriptions[phase] || '';
    soundButton.textContent = phase === 'playing' || phase === 'effect' ? '关闭声音' : phase === 'finished' ? '试听配乐' : '开启声音';
    soundButton.setAttribute('aria-pressed', String(phase === 'playing' || phase === 'effect'));
  });
  volumeInput.value = String(Math.round((hand.audio?.volume ?? .22) * 100));
  let castTimer;
  const controller = createController({
    hand, getHost: () => window.openai,
    getAudioState: () => ({ audio: engine.getState() }),
    onUpdate(state) {
      if (state.selectedId) { previewBlocked = true; setPreview(null); }
      root.classList.toggle('has-selection', Boolean(state.selectedId));
      cardButtons.forEach((button, id) => {
        button.disabled = Boolean(state.selectedId);
        button.classList.toggle('is-selected', state.selectedId === id);
        button.setAttribute('aria-pressed', String(state.selectedId === id));
        cardSlots.get(id).classList.toggle('is-selected', state.selectedId === id);
      });
      const selected = hand.cards.find(card => card.id === state.selectedId);
      const messages = {
        ready: '选择一张牌，继续下一步。', pending: '「' + selected?.title + '」发动 · 正在请求继续',
        requested: '「' + selected?.title + '」已请求继续；如出现宿主确认，请完成确认。',
        unavailable: '当前预览未连接续聊接口。所选指令可手动复制回对话。',
        error: '续聊请求未成功。没有自动重发，可手动复制所选指令。',
        restored: '已恢复上次选牌；未再次发送指令。'
      };
      status.textContent = messages[state.phase];
      manual.hidden = !['unavailable', 'error', 'restored'].includes(state.phase);
      promptArea.value = manual.hidden ? '' : state.prompt;
    },
    onEffect(card) {
      root.classList.remove('is-dealing'); root.classList.add('is-casting');
      cardButtons.get(card.id).classList.add('is-casting');
      clearTimeout(castTimer);
      castTimer = setTimeout(() => {
        root.classList.remove('is-casting'); cardButtons.get(card.id).classList.remove('is-casting');
      }, 1000);
      engine.activate().catch(() => {});
    }
  });
  cardButtons.forEach((button, id) => button.addEventListener('click', () => controller.choose(id)));
  soundButton.addEventListener('click', () => {
    const phase = engine.getState().phase;
    if (phase === 'playing' || phase === 'effect') { engine.stop(); controller.save(); }
    else engine.startOpening(true, true).then(() => controller.save()).catch(() => {});
  });
  volumeInput.addEventListener('input', () => engine.setVolume(Number(volumeInput.value) / 100));
  volumeInput.addEventListener('change', () => controller.save());
  const restore = (snapshot, initial = false) => {
    const savedAudio = snapshot?.privateContent?.audio;
    // Never borrow another hand's state or replay sound while restoring.
    if (initial && snapshot?.modelContent?.turn_id === hand.turn_id && savedAudio) {
      engine.restore(savedAudio);
      volumeInput.value = String(Math.round(engine.getState().volume * 100));
    }
    return controller.restore(snapshot);
  };
  const restored = restore(window.openai?.widgetState, true);
  window.addEventListener('openai:set_globals', event => {
    const snapshot = event.detail?.globals?.widgetState;
    if (snapshot) restore(snapshot);
  });
  if (!restored) {
    root.classList.add('is-dealing');
    setTimeout(() => root.classList.remove('is-dealing'), 850);
    engine.startOpening(false).catch(() => {});
  }
  window.addEventListener('pagehide', () => {
    engine.dispose(); clearTimeout(castTimer); fanObserver?.disconnect();
    window.removeEventListener('resize', sizeFan);
  }, { once: true });
})();
