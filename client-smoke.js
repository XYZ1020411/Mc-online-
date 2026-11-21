const fs = require('fs');
const MODE = process.argv[2] || 'solo';
const html = fs.readFileSync(require('path').join(__dirname, '../public/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const errs = [];
const mk = () => new Proxy(function () {}, {
  get: (t, k) => k === Symbol.toPrimitive ? () => 0 : k === Symbol.iterator ? () => [][Symbol.iterator]() : (k in t ? t[k] : (t[k] = mk())),
  apply: () => mk(), construct: () => mk(), set: (t, k, v) => { t[k] = v; return true }
});
const els = {};
const getEl = id => els[id] || (els[id] = (() => { const h = {}; const e = mk(); e.addEventListener = (ev, fn) => { (h[ev] = h[ev] || []).push(fn); }; e.__h = h; e.getContext = () => mk(); return e; })());
global.THREE = mk();
global.document = { getElementById: getEl, createElement: () => { const e = mk(); e.getContext = () => mk(); return e; }, addEventListener: () => {}, body: mk(), documentElement: mk(), exitPointerLock: () => {} };
global.window = global; global.ImageData = class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4); } };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.innerWidth = 900; global.innerHeight = 400; global.devicePixelRatio = 1;
global.navigator = { maxTouchPoints: 1 }; global.screen = { orientation: { lock: () => Promise.resolve() } };
global.location = { protocol: 'https:', host: 'x.test', origin: 'https://x.test', pathname: '/', search: '' };
global.URLSearchParams = URLSearchParams;
global.addEventListener = () => {}; global.confirm = () => false; global.AudioContext = undefined;
global.setTimeout = (f) => 0; global.clearTimeout = () => {};
const sent = [], wsList = [];
global.WebSocket = class { constructor(u) { this.url = u; this.readyState = 1; wsList.push(this); setImmediate(() => this.onmessage({ data: JSON.stringify({ t: 'init', id: 'abcd1234', seed: 777, hs: 3.3, now: Date.now() + 5000, host: 'abcd1234', players: [{ id: 'ffff0000', name: 'Bob', x: 10, y: 70, z: 10, yaw: 0, pitch: 0, t: 1 }], edits: [[8, 30, 8, 3], [9, 30, 8, 67]] }) })); } send(m) { sent.push(JSON.parse(m)); } };
let raf = null; global.requestAnimationFrame = f => { raf = f; };
process.on('uncaughtException', e => errs.push('UNCAUGHT ' + e.stack.split('\n').slice(0, 3).join(' | ')));
process.on('unhandledRejection', e => errs.push('REJECT ' + (e && e.stack || e)));
const sleep = () => new Promise(r => setImmediate(r));
(async () => {
  for (const s of scripts) { try { (0, eval)(s); } catch (e) { errs.push('INIT: ' + e.stack.split('\n').slice(0, 4).join(' | ')); } }
  els.nameIn = getEl('nameIn'); els.nameIn.value = 'Tester'; els.roomIn = getEl('roomIn'); els.roomIn.value = 'r1';
  if (MODE === 'online') getEl('btnMulti').onclick(); else getEl('btnSolo').onclick();
  for (let i = 0; i < 20 && !raf; i++) await sleep();
  if (!raf) errs.push('主迴圈未啟動');
  const s = getEl('start');
  try { s.__h.pointerdown[0]({ pointerType: 'touch' }); s.__h.click[0](); } catch (e) { errs.push('START ' + e.stack.split('\n').slice(0, 3).join(' | ')); }
  let t = 1000; const run = n => { for (let i = 0; i < n && raf; i++) { t += 50; const f = raf; raf = null; try { f(t); } catch (e) { errs.push('FRAME: ' + e.stack.split('\n').slice(0, 4).join(' | ')); return; } } };
  run(200);
  if (MODE === 'online') {
    const ws = wsList[0], msg = o => ws.onmessage({ data: JSON.stringify(o) });
    msg({ t: 'join', id: 'eeee1111', name: 'Cat' }); msg({ t: 'pos', id: 'ffff0000', x: 11, y: 70, z: 11, yaw: 1, pitch: 0.2 });
    msg({ t: 'blk', e: [[8, 40, 8, 3], [9, 40, 8, 67], [8, 41, 8, 0]] }); msg({ t: 'chat', id: 'ffff0000', name: 'Bob', m: 'hi' });
    run(100); msg({ t: 'leave', id: 'eeee1111' }); msg({ t: 'host', id: 'ffff0000' }); run(100);
    const kinds = {}; sent.forEach(m => kinds[m.t] = (kinds[m.t] || 0) + 1);
    console.log('client sent:', JSON.stringify(kinds));
    if (!kinds.pos) errs.push('沒有送出位置');
  }
  console.log(MODE + ': ' + (errs.length ? errs.join('\n') : 'NO ERRORS'));
  process.exit(0);
})();
