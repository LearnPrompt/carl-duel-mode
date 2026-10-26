'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createController, createAudioEngine } = require('../assets/runtime.js');

const hand = {
  turn_id: 'turn-中文-42',
  cards: [
    { id: 'research', title: '深度「检索」 & <资料>', prompt: '先核实 A < B 与 "双引号"。\n再给出完整结论：不要省略此行。' },
    { id: 'build', title: '立即构筑', prompt: '实现当前方案，并验证可观察结果。' },
    { id: 'end', title: '结束决斗', prompt: '关闭决斗模式，保留当前成果。' }
  ]
};

const flushPromises = async () => {
  // Host resolution, state updates, and optional persistence use separate microtasks.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function makeAudioEnvironment({ state = 'running', resume, play } = {}) {
  let now = 0;
  let nextTimer = 1;
  const pendingTimers = new Map();
  const contexts = [];
  const media = [];
  const param = () => ({
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    cancelScheduledValues() {},
    setTargetAtTime(value) { this.value = value; }
  });
  const node = () => ({ connect() {}, gain: param() });
  class AudioContext {
    constructor() {
      this.state = state;
      this.currentTime = 0;
      this.sampleRate = 1000;
      this.destination = {};
      this.scheduledSources = 0;
      this.resumeCalls = 0;
      this.closeCalls = 0;
      contexts.push(this);
    }
    createGain() { return node(); }
    createDynamicsCompressor() {
      return { connect() {}, threshold: param(), knee: param(), ratio: param() };
    }
    createOscillator() {
      return {
        connect() {}, frequency: param(), start: () => { this.scheduledSources++; }, stop() {}
      };
    }
    createBuffer(_channels, length) { return { getChannelData: () => new Float32Array(length) }; }
    createBufferSource() {
      return { connect() {}, start: () => { this.scheduledSources++; }, stop() {} };
    }
    createBiquadFilter() { return { connect() {}, frequency: param() }; }
    resume() {
      this.resumeCalls++;
      if (resume) return resume(this);
      this.state = 'running';
      return Promise.resolve();
    }
    close() { this.closeCalls++; this.state = 'closed'; return Promise.resolve(); }
  }
  class Audio {
    constructor(source) { this.source = source; this.pauseCalls = 0; this.playCalls = 0; media.push(this); }
    play() { this.playCalls++; return play ? play(this) : Promise.resolve(); }
    pause() { this.pauseCalls++; }
  }
  const env = {
    AudioContext, Audio,
    setTimeout(callback, delay) {
      const id = nextTimer++;
      pendingTimers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) { pendingTimers.delete(id); }
  };
  const advance = milliseconds => {
    const until = now + milliseconds;
    for (;;) {
      const entry = [...pendingTimers.entries()]
        .filter(([, timer]) => timer.due <= until)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!entry) break;
      const [id, timer] = entry;
      pendingTimers.delete(id);
      now = timer.due;
      timer.callback();
    }
    now = until;
  };
  return { env, contexts, media, advance, pendingTimers };
}

test('a valid click calls the host synchronously before effects or persistence and sends the whole choice', async () => {
  const resolution = deferred();
  const events = [];
  const requests = [];
  const controller = createController({
    hand,
    getHost: () => ({
      sendFollowUpMessage(request) { events.push('host'); requests.push(request); return resolution.promise; },
      setWidgetState() { events.push('persist'); }
    }),
    onUpdate(state) { events.push('update:' + state.phase); },
    onEffect() { events.push('effect'); }
  });

  assert.equal(controller.choose('research'), true);
  assert.equal(requests.length, 1, 'host is called before choose returns');
  assert.ok(events.indexOf('host') < events.indexOf('effect'));
  assert.ok(events.indexOf('host') < events.indexOf('persist'));
  assert.equal(controller.getState().phase, 'pending');
  assert.match(requests[0].prompt, /回合：turn-中文-42/);
  assert.ok(requests[0].prompt.includes(hand.cards[0].title));
  assert.ok(requests[0].prompt.includes('（research）'));
  assert.ok(requests[0].prompt.endsWith(hand.cards[0].prompt));
  assert.equal(requests[0].title, '发动「' + hand.cards[0].title + '」');

  resolution.resolve();
  await flushPromises();
  assert.equal(controller.getState().phase, 'requested', 'host return only means requested');
});

test('rapid and later repeated clicks submit exactly once', async () => {
  let calls = 0;
  let effects = 0;
  const controller = createController({ hand, getHost: () => ({ sendFollowUpMessage() { calls++; } }),
    onEffect() { effects++; } });
  assert.equal(controller.choose('build'), true);
  assert.equal(controller.choose('research'), false);
  assert.equal(controller.choose('build'), false);
  await flushPromises();
  assert.equal(controller.choose('end'), false);
  assert.equal(calls, 1);
  assert.equal(effects, 1);
  assert.equal(controller.getState().selectedId, 'build');
});

test('an unknown card does not consume the next valid choice', () => {
  let calls = 0;
  const controller = createController({ hand, getHost: () => ({ sendFollowUpMessage() { calls++; } }) });
  assert.equal(controller.choose('missing'), false);
  assert.equal(controller.getState().phase, 'ready');
  assert.equal(controller.choose('build'), true);
  assert.equal(calls, 1);
});

for (const [name, getHost, phase] of [
  ['missing bridge', () => undefined, 'unavailable'],
  ['missing method', () => ({}), 'unavailable'],
  ['throwing host lookup', () => { throw new Error('host lookup'); }, 'error'],
  ['throwing send method', () => ({ sendFollowUpMessage() { throw new Error('send'); } }), 'error'],
  ['rejected host request', () => ({ sendFollowUpMessage() { return Promise.reject(new Error('rejected')); } }), 'error']
]) {
  test(name + ' retains the selected prompt and never retries automatically', async () => {
    let effects = 0;
    let lookups = 0;
    const controller = createController({ hand, getHost() { lookups++; return getHost(); },
      onEffect() { effects++; } });
    assert.equal(controller.choose('research'), true);
    await flushPromises();
    assert.equal(controller.getState().phase, phase);
    assert.equal(controller.getState().selectedId, 'research');
    assert.ok(controller.getState().prompt.endsWith(hand.cards[0].prompt));
    const afterSettlement = lookups;
    assert.equal(controller.choose('build'), false);
    await flushPromises();
    assert.equal(lookups, afterSettlement, 'no automatic resend or host lookup');
    assert.equal(effects, 1);
  });
}

for (const failure of ['throw', 'reject']) {
  test('optional persistence ' + failure + ' does not prevent a successful choice', async () => {
    const requests = [];
    const saves = [];
    const controller = createController({ hand, getAudioState: () => ({ enabled: false, volume: .4, played: true }),
      getHost: () => ({
        sendFollowUpMessage(request) { requests.push(request); },
        setWidgetState(snapshot) {
          saves.push(snapshot);
          if (failure === 'throw') throw new Error('storage');
          return Promise.reject(new Error('storage'));
        }
      }) });
    assert.equal(controller.choose('build'), true);
    await flushPromises();
    assert.equal(requests.length, 1);
    assert.equal(controller.getState().phase, 'requested');
    assert.ok(saves.length > 0);
    assert.equal(saves[0].modelContent.turn_id, hand.turn_id);
    assert.equal(saves[0].modelContent.selected_id, 'build');
    assert.deepEqual(saves[0].privateContent, { enabled: false, volume: .4, played: true });
  });
}

test('restoring a choice never sends or saves and cannot override a user click', async () => {
  let sends = 0, saves = 0, effects = 0;
  const options = { hand,
    getHost: () => ({ sendFollowUpMessage() { sends++; }, setWidgetState() { saves++; } }),
    onEffect() { effects++; } };
  const snapshot = { modelContent: { turn_id: hand.turn_id, selected_id: 'research', phase: 'requested' } };
  const restored = createController(options);
  assert.equal(restored.restore(snapshot), true);
  await flushPromises();
  assert.equal(restored.getState().phase, 'restored');
  assert.equal(restored.getState().selectedId, 'research');
  assert.equal(restored.choose('build'), false);
  assert.equal(sends, 0); assert.equal(saves, 0); assert.equal(effects, 0);

  const current = createController(options);
  assert.equal(current.restore({ modelContent: { turn_id: 'another-turn', selected_id: 'research' } }), false);
  assert.equal(current.restore({ modelContent: { turn_id: hand.turn_id, selected_id: 'unknown' } }), false);
  assert.equal(current.getState().phase, 'ready');
  assert.equal(current.choose('build'), true);
  assert.equal(current.restore(snapshot), false);
  await flushPromises();
  assert.equal(current.getState().selectedId, 'build');
  assert.equal(sends, 1);
});

test('throwing audio or visual effects do not change a successful host request', async () => {
  let sends = 0;
  const controller = createController({ hand,
    getHost: () => ({ sendFollowUpMessage() { sends++; } }),
    onEffect() { throw new Error('speaker unavailable'); } });
  assert.equal(controller.choose('build'), true);
  await flushPromises();
  assert.equal(sends, 1);
  assert.equal(controller.getState().phase, 'requested');
});

for (const mode of ['unsupported', 'autoplay blocked', 'user disabled']) {
  test(mode + ' audio does not block card submission', async () => {
    const fixture = makeAudioEnvironment({ state: mode === 'autoplay blocked' ? 'suspended' : 'running',
      resume: () => Promise.reject(new Error('autoplay')) });
    if (mode === 'unsupported') delete fixture.env.AudioContext;
    const audio = createAudioEngine({ enabled: mode !== 'user disabled' }, fixture.env);
    let sends = 0;
    const effects = [];
    const controller = createController({ hand,
      getHost: () => ({ sendFollowUpMessage() { sends++; } }),
      onEffect() { effects.push(audio.activate()); } });
    assert.equal(controller.choose('build'), true);
    assert.equal(sends, 1);
    assert.equal(await effects[0], false);
    await flushPromises();
    assert.equal(controller.getState().phase, 'requested');
    assert.equal(audio.getState().phase,
      mode === 'unsupported' ? 'unavailable' : mode === 'user disabled' ? 'off' : 'blocked');
    audio.dispose();
  });
}

test('suspended context asks for user activation and can start after a gesture', async () => {
  const fixture = makeAudioEnvironment({ state: 'suspended' });
  const audio = createAudioEngine({}, fixture.env);
  assert.equal(await audio.startOpening(), false);
  assert.equal(audio.getState().phase, 'blocked');
  assert.equal(fixture.contexts[0].resumeCalls, 0);
  assert.equal(await audio.startOpening(true), true);
  assert.equal(fixture.contexts[0].resumeCalls, 1);
  assert.equal(audio.getState().played, true);
  fixture.advance(8100);
  assert.equal(audio.getState().phase, 'finished');
  audio.dispose();
});

test('disabled audio does not create a context until explicitly enabled', async () => {
  const fixture = makeAudioEnvironment();
  const audio = createAudioEngine({ enabled: false }, fixture.env);
  assert.equal(await audio.startOpening(), false);
  assert.equal(await audio.activate(), false);
  assert.equal(fixture.contexts.length, 0);
  assert.equal(await audio.startOpening(true), true);
  assert.equal(fixture.contexts.length, 1);
  audio.dispose();
});

test('volume changes and restored values stay inside zero to one', () => {
  const audio = createAudioEngine();
  for (const [input, expected] of [[-.7, 0], [2, 1], [.37, .37], ['0.6', .6], ['bad', 0]]) {
    audio.setVolume(input);
    assert.equal(audio.getState().volume, expected);
  }
  audio.restore({ volume: 4 });
  assert.equal(audio.getState().volume, 1);
  audio.restore({ volume: -.4 });
  assert.equal(audio.getState().volume, 0);
});

test('initial volume is clamped just like later volume changes', () => {
  assert.equal(createAudioEngine({ volume: 4 }).getState().volume, 1);
  assert.equal(createAudioEngine({ volume: -.4 }).getState().volume, 0);
});

test('stopping an opening and restoring a played opening never auto-replay it', async () => {
  const fixture = makeAudioEnvironment();
  const audio = createAudioEngine({}, fixture.env);
  assert.equal(await audio.startOpening(), true);
  const scheduled = fixture.contexts[0].scheduledSources;
  assert.ok(scheduled > 0);
  audio.stop();
  assert.equal(audio.getState().phase, 'off');
  assert.equal(await audio.startOpening(), false);
  assert.equal(await audio.startOpening(true), false, 'a gesture alone does not replay played music');
  assert.equal(fixture.contexts[0].scheduledSources, scheduled);
  assert.equal(fixture.pendingTimers.size, 0);

  const restoredFixture = makeAudioEnvironment();
  const restored = createAudioEngine({}, restoredFixture.env);
  restored.restore({ played: true, enabled: true, volume: .25 });
  assert.equal(restored.getState().phase, 'finished');
  assert.equal(await restored.startOpening(), false);
  assert.equal(await restored.startOpening(true), false);
  assert.equal(restoredFixture.contexts.length, 0);
  assert.equal(await restored.startOpening(true, true), true, 'explicit replay remains available');
  restored.dispose(); audio.dispose();
});

test('external audio rejection reports blocked and can be retried with a gesture', async () => {
  let attempts = 0;
  const fixture = makeAudioEnvironment({ play: () => ++attempts === 1
    ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve() });
  const audio = createAudioEngine({ source: './opening.wav' }, fixture.env);
  assert.equal(await audio.startOpening(), false);
  assert.equal(audio.getState().phase, 'blocked');
  assert.equal(audio.getState().played, false);
  assert.equal(await audio.startOpening(true), true);
  assert.equal(audio.getState().phase, 'playing');
  fixture.advance(8100);
  assert.equal(audio.getState().phase, 'finished');
  assert.ok(fixture.media.at(-1).pauseCalls > 0);
  audio.dispose();
});

test('stop during an in-flight opening prevents delayed audio from starting', async () => {
  const gate = deferred();
  const fixture = makeAudioEnvironment({ state: 'suspended', resume: context => gate.promise.then(() => { context.state = 'running'; }) });
  const audio = createAudioEngine({}, fixture.env);
  const opening = audio.startOpening(true);
  audio.stop();
  gate.resolve();
  assert.equal(await opening, false);
  assert.equal(audio.getState().phase, 'off');
  assert.equal(fixture.contexts[0].scheduledSources, 0);
  audio.dispose();
});

test('stop during an in-flight effect prevents delayed audio from starting', async () => {
  const gate = deferred();
  const fixture = makeAudioEnvironment({ state: 'suspended', resume: context => gate.promise.then(() => { context.state = 'running'; }) });
  const audio = createAudioEngine({}, fixture.env);
  const effect = audio.activate();
  audio.stop();
  gate.resolve();
  assert.equal(await effect, false);
  assert.equal(audio.getState().phase, 'off');
  assert.equal(fixture.contexts[0].scheduledSources, 0);
  audio.dispose();
});
