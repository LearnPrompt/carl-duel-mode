#!/usr/bin/env node
'use strict';

// Run with the bundled Playwright package; never attaches to the user's browser.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
if (args.includes('--help')) {
  console.log('Usage: node tests/browser_smoke.cjs --fragment /absolute/hand.html --bridge /absolute/standalone-host-bridge.js [--out /absolute/results] [--chrome /absolute/chrome]');
  process.exit(0);
}
const requiredOption = name => {
  const value = option(name);
  if (!value || value.startsWith('--')) throw new Error('Missing required option: ' + name);
  return value;
};
const { chromium } = require('playwright');
const skillRoot = path.resolve(__dirname, '..');
const fragmentPath = path.resolve(requiredOption('--fragment'));
const bridgePath = path.resolve(requiredOption('--bridge'));
const out = path.resolve(option('--out', path.join(skillRoot, 'work/browser-results')));
const chromePath = option('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const fragment = fs.readFileSync(fragmentPath, 'utf8');
const bridge = fs.readFileSync(bridgePath, 'utf8');
const runtime = fs.readFileSync(path.join(skillRoot, 'assets/runtime.js'), 'utf8');
const dataPattern = /(<script\s+type="application\/json"\s+data-duel-data>)([\s\S]*?)(<\/script>)/;
const dataMatch = fragment.match(dataPattern);
assert.ok(dataMatch, 'fragment contains serialized hand data');
const hand = JSON.parse(dataMatch[2]);
const expectedPrompt = card => '[carl-duel-mode 选牌]\n回合：' + hand.turn_id + '\n卡牌：' + card.title +
  '（' + card.id + '）\n\n' + card.prompt;
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
const results = {
  generated_at: new Date().toISOString(),
  environment: { browser: chromePath, fragment: fragmentPath, bridge: bridgePath, sandbox: 'allow-scripts', isolated: true },
  source_sha256: Object.fromEntries(Object.entries({ fragment, bridge, runtime }).map(([name, source]) =>
    [name, createHash('sha256').update(source).digest('hex')])),
  evidence_layers: {
    simulated_host: 'Local MessageChannel receiver only; no real AI or Codex conversation is called.',
    independent_browser: 'System Chrome headless, isolated Playwright context.',
    real_codex: 'pending: user must complete three real rounds, mode-off and free-text acceptance.',
    audio_listening: 'pending: offline rendering and wave statistics do not prove that a human heard the sound.'
  },
  checks: [],
  browser_errors: []
};
fs.mkdirSync(out, { recursive: true });
function record(name, detail) {
  results.checks.push({ name, status: 'passed', details: detail });
  fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify(results, null, 2) + '\n');
}

function frameDocument(mode) {
  let content = fragment;
  if (mode === 'long-text') {
    const longHand = JSON.parse(JSON.stringify(hand));
    longHand.cards.forEach(card => {
      card.title = '超越界限的最终幻想行动决斗之王牌'; // Exactly 16 Chinese characters.
      card.effect = '这是用于窄屏阅读验收的卡牌效果文字。'.repeat(8).slice(0, 100);
    });
    assert.equal(longHand.cards[0].title.length, 16);
    assert.equal(longHand.cards[0].effect.length, 100);
    content = content.replace(dataPattern, (_match, open, _data, close) => open + json(longHand) + close);
  }
  const snapshot = mode === 'restored' ? {
    modelContent: { skill: 'carl-duel-mode', turn_id: hand.turn_id, selected_id: hand.cards[0].id, phase: 'requested' },
    privateContent: { audio: { enabled: true, volume: .22, played: true, phase: 'finished' } }
  } : null;
  const bridgeScript = mode === 'no-bridge' ? '' :
    '<script id="codex-visualization-widget-state" type="application/json">' +
    json({ widgetState: snapshot, statePersistence: 'host' }) + '</script><script>' + bridge + '</script>';
  const audioFailure = mode === 'broken-audio' ?
    '<script>window.AudioContext = window.webkitAudioContext = class { constructor() { throw new Error("test audio unavailable"); } };</script>' : '';
  return '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>html,body{margin:0;background:#0c100e}body{padding:16px;box-sizing:border-box}@media(max-width:600px){body{padding:8px}}</style></head><body>' +
    bridgeScript + audioFailure + content + '</body></html>';
}

function hostDocument(mode) {
  return '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>html,body{margin:0;background:#0c100e}iframe{display:block;width:100%;height:1400px;border:0}</style></head><body>' +
    '<iframe id="duel" sandbox="allow-scripts" title="本地决斗卡牌验收"></iframe><script>' +
    'window.hostEvents=[];window.hostReady=false;window.hostStateAcks=0;const frame=document.getElementById("duel");' +
    'frame.onload=()=>{const channel=new MessageChannel();channel.port1.onmessage=event=>{const data=event.data;window.hostEvents.push(data);' +
    'if(data.type==="height"){window.hostReady=true;frame.style.height=data.height+"px";}' +
    'if(data.type==="widget-state-write"){window.hostStateAcks++;channel.port1.postMessage({type:"widget-state-result",id:data.id,ok:true});}};' +
    'channel.port1.start();frame.contentWindow.postMessage({type:"codex-visualization-initialize"},"*",[channel.port2]);};' +
    'frame.src=' + json('/frames/' + mode) + ';</script></body></html>';
}

const modes = new Set(['default', 'no-bridge', 'broken-audio', 'restored', 'long-text']);
const server = http.createServer((request, response) => {
  const target = request.url.split('?')[0];
  const mode = target.startsWith('/frames/') ? target.slice(8) : target.slice(1) || 'default';
  if (!modes.has(mode)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(target.startsWith('/frames/') ? frameDocument(mode) : hostDocument(mode));
});

let browser;
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1 });
  await context.route('**/*', route => {
    const url = route.request().url();
    return url.startsWith(base + '/') || url.startsWith('data:') ? route.continue() : route.abort();
  });
  const open = async (mode = 'default', options = {}) => {
    const page = await context.newPage();
    page.on('pageerror', error => results.browser_errors.push({ mode, message: error.message }));
    if (options.width || options.height) await page.setViewportSize({ width: options.width || 1000, height: options.height || 900 });
    if (options.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(base + '/' + mode);
    if (mode !== 'no-bridge') await page.waitForFunction(() => window.hostReady === true);
    const frame = page.frames().find(candidate => candidate.url().includes('/frames/'));
    assert.ok(frame, 'child frame loaded');
    await frame.locator('.duel-card').first().waitFor();
    await frame.waitForFunction(() => document.querySelectorAll('.duel-card').length === 3 &&
      [...document.images].every(image => image.complete && image.naturalWidth > 0));
    await frame.waitForFunction(() => !document.querySelector('.duel-surface').classList.contains('is-dealing'));
    return { page, frame };
  };
  const events = page => page.evaluate(() => window.hostEvents.filter(event => event.type === 'follow-up'));
  const inspectGeometry = async frame => frame.evaluate(() => {
    const surface = document.querySelector('.duel-surface').getBoundingClientRect();
    const targets = [...document.querySelectorAll('.duel-card-title,.duel-effect-text,[data-role="status"],[data-role="audio-toggle"],[data-role="volume"]')];
    const bounds = targets.map(element => {
      const box = element.getBoundingClientRect();
      return { selector: element.className || element.dataset.role, x: box.x, y: box.y, width: box.width, height: box.height,
        within_surface: box.left >= surface.left - 1 && box.right <= surface.right + 1 && box.top >= surface.top - 1 && box.bottom <= surface.bottom + 1,
        text_overflow: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1 };
    });
    const card_bounds = [...document.querySelectorAll('.duel-card')].map(element => {
      const box = element.getBoundingClientRect();
      const overflow = {
        left: Math.max(0, surface.left - box.left), right: Math.max(0, box.right - surface.right),
        top: Math.max(0, surface.top - box.top), bottom: Math.max(0, box.bottom - surface.bottom)
      };
      return { card_id: element.dataset.cardId, x: box.x, y: box.y, width: box.width, height: box.height,
        overflow_px: overflow, within_surface: Object.values(overflow).every(value => value <= 1) };
    });
    return { viewport_width: innerWidth, document_width: document.documentElement.scrollWidth,
      surface: { x: surface.x, y: surface.y, width: surface.width, height: surface.height }, bounds, card_bounds };
  });
  const assertGeometry = geometry => {
    assert.ok(geometry.document_width <= geometry.viewport_width + 1, 'no horizontal document overflow');
    assert.ok(geometry.bounds.every(box => box.within_surface), 'all key contents fit inside the clipped surface');
    assert.ok(geometry.bounds.every(box => !box.text_overflow), 'key text and controls do not overflow their own boxes');
    assert.ok(geometry.card_bounds.every(box => box.within_surface), 'whole card border boxes fit inside the clipped surface');
  };
  const inspectFan = async frame => frame.evaluate(() => {
    const cards = [...document.querySelectorAll('.duel-card')].map(card => {
      const box = card.getBoundingClientRect();
      const slot = card.closest('.duel-slot');
      return { card_id: card.dataset.cardId, wrapped: Boolean(slot), x: box.x, y: box.y,
        width: box.width, height: box.height, slot_z_index: slot ? getComputedStyle(slot).zIndex : null };
    });
    const overlaps = cards.slice(0, -1).map((card, index) => {
      const next = cards[index + 1];
      const overlap = Math.max(0, Math.min(card.x + card.width, next.x + next.width) - Math.max(card.x, next.x));
      return { cards: [card.card_id, next.card_id], overlap_px: overlap,
        overlap_fraction: overlap / Math.min(card.width, next.width) };
    });
    return { cards, overlaps };
  });
  const assertFan = fan => {
    assert.equal(fan.cards.length, 3);
    assert.ok(fan.cards.every(card => card.wrapped), 'each card has a stable hover slot');
    assert.ok(fan.cards.every(card => card.height > card.width * 1.15), 'all cards remain visibly portrait');
    assert.ok(fan.overlaps.every(pair => pair.overlap_fraction >= .25), 'adjacent cards have substantial fan overlap');
  };
  const previewMetrics = async (frame, cardId) => frame.evaluate(id => {
    const card = [...document.querySelectorAll('.duel-card')].find(element => element.dataset.cardId === id);
    const slot = card.closest('.duel-slot');
    const box = card.getBoundingClientRect();
    const matrixScale = element => {
      const transform = getComputedStyle(element).transform;
      const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
      return Math.hypot(matrix.a, matrix.b);
    };
    const effects = card.querySelector('.duel-effect-text');
    const effectBox = effects.getBoundingClientRect();
    const sample = (element, rect) => [.12, .5, .88].flatMap(x => [.12, .5, .88].map(y => {
      const px = rect.left + rect.width * x, py = rect.top + rect.height * y;
      return { x: px, y: py, topmost: document.elementFromPoint(px, py)?.closest('.duel-card') === card };
    }));
    const clipping = [];
    for (let ancestor = effects.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(style.overflowX) &&
          (effectBox.left < bounds.left - 1 || effectBox.right > bounds.right + 1)) clipping.push('horizontal:' + ancestor.className);
      if (/hidden|clip|auto|scroll/.test(style.overflowY) &&
          (effectBox.top < bounds.top - 1 || effectBox.bottom > bounds.bottom + 1)) clipping.push('vertical:' + ancestor.className);
    }
    return {
      card_id: id, x: box.x, y: box.y, width: box.width, height: box.height,
      scale: matrixScale(card) * (slot ? matrixScale(slot) : 1),
      slot_preview: slot?.classList.contains('is-preview') === true,
      root_preview: document.querySelector('.duel-surface').classList.contains('has-preview'),
      active_preview_card: document.querySelector('.duel-surface').dataset.previewCard || null,
      slot_hover: slot?.matches(':hover') === true,
      slot_z_index: Number(getComputedStyle(slot || card).zIndex) || 0,
      other_slot_z_indices: [...document.querySelectorAll('.duel-slot')].filter(element => element !== slot)
        .map(element => Number(getComputedStyle(element).zIndex) || 0),
      effect_text_overflow: effects.scrollWidth > effects.clientWidth + 1 || effects.scrollHeight > effects.clientHeight + 1,
      effect_clipping: clipping, effect_samples: sample(effects, effectBox)
    };
  }, cardId);
  const moveOntoVisibleCard = async (page, frame, cardId) => {
    const point = await frame.evaluate(id => {
      const card = [...document.querySelectorAll('.duel-card')].find(element => element.dataset.cardId === id);
      const box = card.getBoundingClientRect();
      let firstVisible = null;
      for (let ix = 1; ix < 50; ix++) {
        for (let iy = 1; iy < 50; iy++) {
          const fx = ix / 50, fy = iy / 50;
          const x = box.left + box.width * fx, y = box.top + box.height * fy;
          const hits = (px, py) => document.elementFromPoint(px, py)?.closest('.duel-card') === card;
          if (!hits(x, y)) continue;
          firstVisible ||= { x, y };
          if ([[-3, 0], [3, 0], [0, -3], [0, 3]].every(([dx, dy]) => hits(x + dx, y + dy))) return { x, y };
        }
      }
      return firstVisible;
    }, cardId);
    if (!point) {
      const width = await frame.evaluate(() => innerWidth);
      results.observations ||= {};
      results.observations.missing_visible_card = { width, card_id: cardId, geometry: await inspectGeometry(frame) };
      await page.screenshot({ path: path.join(out, 'width-' + width + '-missing-' + cardId + '.png'), fullPage: true });
    }
    assert.ok(point, 'a visible portion of ' + cardId + ' can receive pointer input');
    const iframe = await page.locator('#duel').boundingBox();
    await page.mouse.move(iframe.x + point.x, iframe.y + point.y);
    await page.waitForTimeout(350);
    return point;
  };
  const assertPreview = (before, after, width = 'desktop') => {
    const label = width + 'px/' + after.card_id + ': ';
    assert.ok(before.y - after.y >= 50, label + 'hover lift is ' + (before.y - after.y).toFixed(2) + 'px; expected at least 50px');
    assert.ok(after.scale / before.scale >= 1.05, label + 'hover scale ratio is ' + (after.scale / before.scale).toFixed(3) + '; expected at least 1.05');
    assert.ok(after.slot_preview && after.root_preview, 'preview classes belong to the slot and surface');
    assert.ok(after.other_slot_z_indices.every(z => after.slot_z_index > z), label + 'hovered slot must be above other slots');
    assert.equal(after.effect_text_overflow, false, label + 'the complete effect must fit its text box');
    assert.deepEqual(after.effect_clipping, [], label + 'no ancestor may clip the complete effect');
    assert.ok(after.effect_samples.every(point => point.topmost), label + 'effect samples obscured: ' +
      JSON.stringify(after.effect_samples.filter(point => !point.topmost)));
  };

  const desktop = await open();
  const images = await desktop.frame.locator('.duel-art').evaluateAll(nodes => nodes.map(image => ({
    loaded: image.complete && image.naturalWidth > 0, embedded: image.src.startsWith('data:'), width: image.naturalWidth, height: image.naturalHeight
  })));
  assert.equal(images.length, 3); assert.ok(images.every(image => image.loaded && image.embedded));
  const desktopGeometry = await inspectGeometry(desktop.frame);
  assertGeometry(desktopGeometry);
  const desktopFan = await inspectFan(desktop.frame);
  assertFan(desktopFan);
  await desktop.page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true });
  const card = desktop.frame.locator('.duel-card').first();
  const before = await previewMetrics(desktop.frame, hand.cards[0].id);
  const desktopPointer = await moveOntoVisibleCard(desktop.page, desktop.frame, hand.cards[0].id);
  const after = await previewMetrics(desktop.frame, hand.cards[0].id);
  results.observations = { desktop_preview: { pointer: desktopPointer, before, after } };
  await desktop.page.screenshot({ path: path.join(out, 'desktop-hover.png'), fullPage: true });
  assertPreview(before, after);
  assert.equal((await events(desktop.page)).length, 0, 'hovering is a pure preview and never sends a follow-up');
  assertGeometry(await inspectGeometry(desktop.frame));
  await desktop.page.mouse.move(1, 1);
  await desktop.page.waitForTimeout(350);
  const withdrawn = await previewMetrics(desktop.frame, hand.cards[0].id);
  assert.equal(withdrawn.root_preview, false);
  assert.equal(withdrawn.slot_preview, false);
  for (const dimension of ['x', 'y', 'width', 'height', 'scale']) {
    assert.ok(Math.abs(withdrawn[dimension] - before[dimension]) <= 1, 'pointer withdrawal restores ' + dimension);
  }
  assert.equal((await events(desktop.page)).length, 0);
  record('hover-preview-withdrawal', { fan: desktopFan, before, after, withdrawn, follow_up_count: 0, screenshot: 'desktop-hover.png' });

  await moveOntoVisibleCard(desktop.page, desktop.frame, hand.cards[0].id);
  await card.dblclick({ delay: 20 });
  await desktop.page.waitForFunction(() => window.hostEvents.some(event => event.type === 'follow-up'));
  await desktop.page.waitForTimeout(100);
  const clicks = await events(desktop.page);
  assert.equal(clicks.length, 1, 'rapid double click sends only one message');
  assert.equal(clicks[0].prompt, expectedPrompt(hand.cards[0]));
  const requestedStatus = await desktop.frame.locator('[data-role="status"]').textContent();
  assert.match(requestedStatus, /已请求继续/);
  assert.doesNotMatch(requestedStatus, /AI已收到|AI 已收到|已成功发送|对话已继续/);
  const acknowledgedWrites = await desktop.page.evaluate(() => window.hostStateAcks);
  assert.ok(acknowledgedWrites > 0, 'simulated host acknowledged actual widget-state writes');
  record('simulated-host-real-click', { received_count: clicks.length, complete_turn_card_prompt: true,
    native_bridge: true, widget_state_acknowledged: acknowledgedWrites, status: requestedStatus, images, hover_lift_px: before.y - after.y });
  record('desktop-layout', { geometry: desktopGeometry, screenshot: 'desktop.png' });
  console.log('桌面扇形、抽牌放大、完整效果、收回恢复及真实双击仅一次通过。');

  const mobile = await open('default', { width: 360 });
  const mobileGeometry = await inspectGeometry(mobile.frame);
  assertGeometry(mobileGeometry);
  assertFan(await inspectFan(mobile.frame));
  await mobile.page.screenshot({ path: path.join(out, 'mobile-360.png'), fullPage: true });
  const mobileBefore = await previewMetrics(mobile.frame, hand.cards[0].id);
  const mobilePointer = await moveOntoVisibleCard(mobile.page, mobile.frame, hand.cards[0].id);
  const mobileAfter = await previewMetrics(mobile.frame, hand.cards[0].id);
  results.observations.mobile_preview = { pointer: mobilePointer, before: mobileBefore, after: mobileAfter };
  await mobile.page.screenshot({ path: path.join(out, 'mobile-360-hover.png'), fullPage: true });
  assertPreview(mobileBefore, mobileAfter, 360);
  assertGeometry(await inspectGeometry(mobile.frame));
  assert.equal((await events(mobile.page)).length, 0);
  record('mobile-360-layout', { geometry: mobileGeometry, screenshot: 'mobile-360.png' });
  console.log('360px 截图和关键内容边界检查通过。');

  const keyboard = await open();
  const focusBefore = await previewMetrics(keyboard.frame, hand.cards[1].id);
  await keyboard.frame.locator('.duel-card').nth(1).focus();
  await keyboard.page.waitForTimeout(350);
  const focusPreview = await previewMetrics(keyboard.frame, hand.cards[1].id);
  assertPreview(focusBefore, focusPreview);
  assert.equal((await events(keyboard.page)).length, 0, 'focus only previews the card');
  await keyboard.page.keyboard.press('Enter');
  await keyboard.page.waitForFunction(() => window.hostEvents.some(event => event.type === 'follow-up'));
  assert.equal((await events(keyboard.page))[0].prompt, expectedPrompt(hand.cards[1]));
  record('keyboard-enter', { focus_preview: focusPreview, focus_follow_up_count: 0, complete_prompt: true });

  const reduced = await open('default', { reducedMotion: true });
  await reduced.frame.locator('.duel-card').first().click();
  const motion = await reduced.frame.locator('.duel-card').first().evaluate(element =>
    [element.closest('.duel-slot'), element].map(node => {
      const style = getComputedStyle(node);
      return { element: node.className, animation: style.animationName, transition: style.transitionProperty };
    }));
  assert.ok(motion.every(node => node.animation === 'none' && node.transition === 'none'));
  record('reduced-motion', motion);

  const noBridge = await open('no-bridge');
  await noBridge.frame.locator('.duel-card').first().click();
  const unavailableStatus = await noBridge.frame.locator('[data-role="status"]').textContent();
  assert.match(unavailableStatus, /未连接续聊接口/);
  assert.equal(await noBridge.frame.locator('[data-role="selection-prompt"]').inputValue(), expectedPrompt(hand.cards[0]));
  assert.equal((await events(noBridge.page)).length, 0);
  record('missing-bridge', { status: unavailableStatus, manual_prompt_complete: true, sends: 0 });

  const broken = await open('broken-audio');
  await broken.frame.locator('.duel-card').first().click();
  await broken.page.waitForFunction(() => window.hostEvents.some(event => event.type === 'follow-up'));
  assert.equal((await events(broken.page)).length, 1);
  assert.match(await broken.frame.locator('[data-role="audio-state"]').textContent(), /无法播放声音/);
  record('audio-constructor-failure', { host_sends: 1, audio_unavailable: true });

  const restored = await open('restored');
  const restoredStatus = await restored.frame.locator('[data-role="status"]').textContent();
  assert.match(restoredStatus, /已恢复上次选牌；未再次发送/);
  assert.equal((await events(restored.page)).length, 0);
  assert.equal(await restored.frame.locator('.duel-card:disabled').count(), 3);
  assert.equal(await restored.frame.locator('[data-role="selection-prompt"]').inputValue(), expectedPrompt(hand.cards[0]));
  const writes = await restored.page.evaluate(() => window.hostEvents.filter(event => event.type === 'widget-state-write').length);
  assert.equal(writes, 0);
  assert.match(await restored.frame.locator('[data-role="audio-state"]').textContent(), /配乐已结束/);
  record('restore-without-resend', { sends: 0, persistence_writes: writes, all_cards_locked: true, played_audio_not_replayed: true });

  // Fit this deliberately tall fixture without fullPage capture resizing the viewport mid-hover.
  const longText = await open('long-text', { width: 360, height: 1200 });
  const longBefore = await previewMetrics(longText.frame, hand.cards[0].id);
  await moveOntoVisibleCard(longText.page, longText.frame, hand.cards[0].id);
  const longPreview = await previewMetrics(longText.frame, hand.cards[0].id);
  assertPreview(longBefore, longPreview, '360/long-text');
  const longGeometry = await inspectGeometry(longText.frame);
  assertGeometry(longGeometry);
  await longText.page.screenshot({ path: path.join(out, 'long-text-360.png'), fullPage: true });
  record('long-text-360', { title_characters: 16, effect_characters: 100, geometry: longGeometry, preview: longPreview, screenshot: 'long-text-360.png' });

  const hostWidths = [];
  for (const width of [320, 360, 650, 736, 1000]) {
    const probe = await open('default', { width });
    const geometry = await inspectGeometry(probe.frame);
    const fan = await inspectFan(probe.frame);
    assertFan(fan);
    const previews = [];
    for (const item of hand.cards) {
      const baseline = await previewMetrics(probe.frame, item.id);
      await moveOntoVisibleCard(probe.page, probe.frame, item.id);
      const preview = await previewMetrics(probe.frame, item.id);
      assertPreview(baseline, preview, width);
      previews.push({ card_id: item.id, baseline, preview, geometry: await inspectGeometry(probe.frame) });
      assert.equal((await events(probe.page)).length, 0, 'width ' + width + ' preview must not send a follow-up');
    }
    await probe.page.mouse.move(1, 1);
    await probe.page.waitForTimeout(350);
    assert.equal(await probe.frame.locator('.duel-slot.is-preview').count(), 0, 'leaving the fan releases the preview at ' + width + 'px');
    hostWidths.push({ width, geometry, fan, previews, direct_pointer_switching: true });
    await probe.page.close();
  }
  const geometryOverflows = geometry => geometry.document_width > geometry.viewport_width + 1 ||
    geometry.bounds.some(box => !box.within_surface || box.text_overflow) ||
    geometry.card_bounds.some(box => !box.within_surface);
  const overflowedWidths = hostWidths.filter(probe => geometryOverflows(probe.geometry) ||
    probe.previews.some(preview => geometryOverflows(preview.geometry)));
  results.checks.push({ name: 'host-width-card-boundaries', status: overflowedWidths.length ? 'failed' : 'passed', details: hostWidths });
  fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify(results, null, 2) + '\n');
  assert.equal(overflowedWidths.length, 0, 'whole-card boundary overflow at viewport widths: ' +
    overflowedWidths.map(probe => probe.width).join(', '));

  const renderedAudio = await desktop.page.evaluate(async source => {
    const module = { exports: {} };
    new Function('module', 'exports', source)(module, module.exports);
    const sampleRate = 44100;
    const context = new OfflineAudioContext(1, Math.ceil(sampleRate * 8.1), sampleRate);
    const master = context.createGain(); master.gain.value = .22;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -14; limiter.knee.value = 12; limiter.ratio.value = 8;
    master.connect(limiter); limiter.connect(context.destination);
    module.exports.scheduleOpening(context, master, .025);
    const buffer = await context.startRendering();
    const channel = buffer.getChannelData(0);
    const rms = (from, until) => {
      let squares = 0;
      const a = Math.floor(from * sampleRate), b = Math.floor(until * sampleRate);
      for (let i = a; i < b; i++) squares += channel[i] * channel[i];
      return Math.sqrt(squares / (b - a));
    };
    let peak = 0;
    const wave = new ArrayBuffer(44 + channel.length * 2), view = new DataView(wave);
    const word = (offset, text) => [...text].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
    word(0, 'RIFF'); view.setUint32(4, 36 + channel.length * 2, true); word(8, 'WAVE');
    word(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    word(36, 'data'); view.setUint32(40, channel.length * 2, true);
    for (let i = 0; i < channel.length; i++) {
      peak = Math.max(peak, Math.abs(channel[i]));
      const sample = Math.max(-1, Math.min(1, channel[i]));
      view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    const bytes = new Uint8Array(wave);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { base64: btoa(binary), duration_seconds: buffer.duration, sample_rate: sampleRate, channels: 1,
      peak, rms_main: rms(.05, 6.4), rms_early_tail: rms(6.45, 6.8), rms_late_tail: rms(7.8, 8), rms_ending: rms(8.05, 8.1) };
  }, runtime);
  fs.writeFileSync(path.join(out, 'opening.wav'), Buffer.from(renderedAudio.base64, 'base64'));
  delete renderedAudio.base64;
  assert.ok(renderedAudio.peak > .01 && renderedAudio.peak <= 1);
  assert.ok(renderedAudio.rms_main > .005);
  assert.ok(renderedAudio.rms_late_tail < renderedAudio.rms_early_tail * .2);
  assert.ok(renderedAudio.rms_ending < .0001);
  record('offline-opening-render', { ...renderedAudio, file: 'opening.wav', human_listening: 'pending' });
  assert.deepEqual(results.browser_errors, []);
  results.overall = 'passed: independent-browser and simulated-host checks; real Codex and human listening pending';
  fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log('浏览器验收全部通过：' + results.checks.length + ' 项；真实 Codex 与人工听音待验收。');
  await context.close();
}

main().catch(error => {
  results.overall = 'failed';
  results.failure = error.stack;
  fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify(results, null, 2) + '\n');
  console.error(error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
});
