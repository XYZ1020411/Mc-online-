// Cloudflare Worker：驗證登入（Supabase）→ 檢查房間權限 → 轉給房間 Durable Object；其餘請求交給靜態檔案
const q = encodeURIComponent;
const sbOn = env => !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY && env.SUPABASE_ANON_KEY);
const sb = (env, path, init = {}) => fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
  ...init, headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', ...(init.headers || {}) } });
const sbJson = async (env, path, init) => { const r = await sb(env, path, init); if (!r.ok) throw new Error('supabase ' + r.status); const t = await r.text(); return t ? JSON.parse(t) : []; };

function deny(reason) {                                       // 以 WebSocket 訊息回報拒絕原因（瀏覽器才讀得到原因）
  const [c, s] = Object.values(new WebSocketPair());
  s.accept(); s.send(JSON.stringify({ t: 'deny', reason })); s.close(4003, 'denied');
  return new Response(null, { status: 101, webSocket: c, headers: { 'Sec-WebSocket-Protocol': 'mc' } });
}

// 回傳 { user, name, owner, invite } 或 { deny }
async function authorize(req, env, url, room) {
  const guestName = ((url.searchParams.get('name') || '玩家').slice(0, 12)) + '（訪客）';
  if (!sbOn(env)) return { user: null, name: (url.searchParams.get('name') || '玩家').slice(0, 16), owner: false };   // 未設定 Supabase：維持訪客公開模式
  const protos = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(s => s.trim());
  const jwt = (protos.find(p => p.startsWith('jwt.')) || '').slice(4);
  let user = null;
  if (jwt) {                                                  // 向 Supabase Auth 驗證 token（不論金鑰類型都適用）
    const r = await fetch(env.SUPABASE_URL + '/auth/v1/user', { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + jwt } });
    if (!r.ok) return { deny: '登入已過期，請重新登入' };
    const u = await r.json(); user = { id: u.id, name: ((u.user_metadata && u.user_metadata.name) || (u.email || '玩家').split('@')[0]).slice(0, 16) };
  }
  if (!user && env.REQUIRE_LOGIN === '1') return { deny: '此伺服器需要先登入' };
  const wantPrivate = url.searchParams.get('private') === '1', code = url.searchParams.get('code') || '';
  let info = (await sbJson(env, 'rooms?slug=eq.' + q(room) + '&select=*'))[0];
  if (!info) {
    if (wantPrivate && !user) return { deny: '建立私人房間需要先登入' };
    if (user) {                                               // 第一位登入者成為房主
      const invite = wantPrivate ? crypto.randomUUID().replace(/-/g, '').slice(0, 10) : null;
      info = (await sbJson(env, 'rooms', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ slug: room, owner: user.id, private: wantPrivate, invite_code: invite }) }))[0];
    }
  }
  let owner = false;
  if (info) {
    owner = !!user && info.owner === user.id;
    if (user && !owner && (await sbJson(env, 'room_bans?room=eq.' + q(room) + '&user_id=eq.' + user.id + '&select=user_id')).length) return { deny: '你已被房主封鎖' };
    if (info.private && !owner) {
      if (!user) return { deny: '這是私人房間，請先登入並輸入邀請碼' };
      const member = (await sbJson(env, 'room_members?room=eq.' + q(room) + '&user_id=eq.' + user.id + '&select=user_id')).length > 0;
      if (!member) {
        if (!code || code !== info.invite_code) return { deny: '私人房間：缺少或錯誤的邀請碼' };
        await sbJson(env, 'room_members?on_conflict=room,user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ room, user_id: user.id }) });
      }
    }
  }
  return { user, name: user ? user.name : guestName, owner, invite: owner && info && info.private ? info.invite_code : null };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/config') return Response.json({ supabaseUrl: env.SUPABASE_URL || '', anonKey: env.SUPABASE_ANON_KEY || '', requireLogin: env.REQUIRE_LOGIN === '1' }, { headers: { 'cache-control': 'no-store' } });
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('需要 WebSocket', { status: 426 });
      const room = (url.searchParams.get('room') || 'lobby').toLowerCase().replace(/[^a-z0-9_\-\u4e00-\u9fa5]/g, '').slice(0, 24) || 'lobby';
      let auth; try { auth = await authorize(req, env, url, room); } catch (e) { return deny('驗證服務暫時無法使用，請稍後再試'); }
      if (auth.deny) return deny(auth.deny);
      const r2 = new Request(req); r2.headers.set('x-auth', encodeURIComponent(JSON.stringify({ ...auth, room })));   // 由 Worker 設定，客戶端無法偽造
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(r2);
    }
    return env.ASSETS.fetch(req);
  }
};

// ---------- 玩家進度驗證（防作弊：格式、範圍、成長速度）----------
const KIT = { inv: { 9: 2, 10: 4 }, hp: 20, food: 20, qi: 0, stat: { wood: 0, stone: 0, coal: 0, iron: 0, kills: 0, crafted: {} }, dur: {}, p: null, sel: 0 };
const MAX_BLOCK_ID = 43;   // 方塊 id 上限（client 的網路編碼是 6 bit：0–63；新增方塊/模組時要一起調整）
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
function sanitize(d, prev, dtSec) {
  if (!d || typeof d !== 'object' || !d.inv || typeof d.inv !== 'object') return null;
  const inv = {}; let gain = 0;
  for (const [k, v] of Object.entries(d.inv)) {
    const id = +k; if (!int(id, 1, 120) || !int(v, 0, 9999)) return null;
    inv[id] = v; const pv = (prev && prev.inv && prev.inv[id]) || 0; if (v > pv) gain += v - pv;
  }
  if (prev && gain > 400 + Math.min(dtSec, 600) * 12) return null;   // 短時間內物品暴增 → 視為作弊，拒絕
  const n = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? +v : lo));
  const stat = {}; for (const k of ['wood', 'stone', 'coal', 'iron', 'kills']) stat[k] = int(d.stat && d.stat[k], 0, 1e7) ? d.stat[k] : 0;
  stat.crafted = {}; for (const [k, v] of Object.entries((d.stat && d.stat.crafted) || {})) if (int(+k, 1, 120) && int(v, 0, 1e6)) stat.crafted[k] = v;
  const dur = {}; for (const [k, v] of Object.entries(d.dur || {})) if (int(+k, 1, 120) && int(v, 0, 300)) dur[k] = v;
  const p = d.p && [d.p.x, d.p.y, d.p.z].every(Number.isFinite) ? { x: d.p.x, y: d.p.y, z: d.p.z } : null;
  return { inv, hp: n(d.hp, 0, 20), food: n(d.food, 0, 20), qi: int(d.qi, 0, 50) ? d.qi : 0, stat, dur, p, sel: int(d.sel, 0, 10) ? d.sel : 0 };
}

// 一個房間 = 一個 Durable Object：世界種子與方塊修改、玩家連線、睡覺投票、反作弊
export class Room {
  constructor(state, env) {
    this.state = state; this.env = env; this.cache = new Map();
    state.blockConcurrencyWhile(async () => {
      let seed = await state.storage.get('seed');
      if (seed == null) { seed = (Math.random() * 2147483646 | 0) + 1; await state.storage.put({ seed, hs: Math.random() * 1000 }); }
      this.seed = seed; this.hs = await state.storage.get('hs'); this.skip = (await state.storage.get('skip')) || Number(env.DEV_TIME_OFFSET_MS || 0);   // DEV_TIME_OFFSET_MS 只供自動測試使用   // skip：睡覺快轉累積的毫秒
      this.edits = await state.storage.list({ prefix: 'e:' });                                                            // 'e:x,y,z' → 方塊值
    });
  }
  players(excludeId) { return this.state.getWebSockets().map(w => w.deserializeAttachment()).filter(p => p && p.id !== excludeId); }
  host(excludeId) { const p = this.players(excludeId).sort((a, b) => a.t - b.t)[0]; return p && p.id; }   // 最早加入者負責水流/火勢模擬
  broadcast(m, except) { const s = JSON.stringify(m); for (const w of this.state.getWebSockets()) if (w !== except) { try { w.send(s); } catch (e) {} } }
  tod() { return (((Date.now() + this.skip) / 1000) / 240 + 0.1) % 1; }

  async getState(me) {                                         // 讀玩家進度（Supabase），新玩家給初始裝備
    let c = this.cache.get(me.uid); if (c) return c;
    let data = null;
    if (sbOn(this.env)) { try { const rows = await sbJson(this.env, 'player_state?room=eq.' + q(me.room) + '&user_id=eq.' + me.uid + '&select=data'); data = rows[0] ? rows[0].data : null; } catch (e) {} }
    c = { data: data || KIT, fresh: !data, t: Date.now() }; this.cache.set(me.uid, c); return c;
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('需要 WebSocket', { status: 426 });
    const auth = JSON.parse(decodeURIComponent(req.headers.get('x-auth') || '{}'));
    const [client, server] = Object.values(new WebSocketPair()), hdr = { 'Sec-WebSocket-Protocol': 'mc' };
    if (this.state.getWebSockets().length >= 16) { server.accept(); server.send(JSON.stringify({ t: 'deny', reason: '房間已滿' })); server.close(1013, 'full'); return new Response(null, { status: 101, webSocket: client, headers: hdr }); }
    const uid = auth.user ? auth.user.id : null;
    if (uid) for (const w of this.state.getWebSockets()) { const a = w.deserializeAttachment(); if (a && a.uid === uid) { try { w.send(JSON.stringify({ t: 'deny', reason: '你在其他地方登入了' })); w.close(4004, 'dup'); } catch (e) {} } }
    this.state.acceptWebSocket(server);                         // Hibernation API：沒人說話時 DO 可休眠
    const me = { id: crypto.randomUUID().slice(0, 8), uid, room: auth.room, owner: !!auth.owner, name: (auth.name || '玩家').slice(0, 24), x: 8.5, y: 80, z: 8.5, yaw: 0, pitch: 0, t: Date.now() };
    server.serializeAttachment(me);
    const st = uid ? await this.getState(me) : null;
    const edits = []; for (const [k, v] of this.edits) { const [x, y, z] = k.slice(2).split(',').map(Number); edits.push([x, y, z, v]); }
    server.send(JSON.stringify({ t: 'init', id: me.id, seed: this.seed, hs: this.hs, now: Date.now() + this.skip, skip: this.skip, host: this.host(), owner: me.owner, invite: auth.invite || null, authed: !!uid, state: st && !st.fresh ? st.data : null, players: this.players(me.id), edits }));
    this.broadcast({ t: 'join', id: me.id, name: me.name }, server);
    return new Response(null, { status: 101, webSocket: client, headers: hdr });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 40000) return;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    const me = ws.deserializeAttachment(); if (!me) return;
    const now = Date.now(), n = v => Number.isFinite(v) ? v : 0;
    if (me.viol > 80) { ws.send(JSON.stringify({ t: 'deny', reason: '偵測到異常操作，已中斷連線' })); ws.close(4005, 'cheat'); return; }

    if (m.t === 'pos') {                                        // 位置：限制移動速度（防瞬移/飛天加速）
      const nx = n(m.x), ny = n(m.y), nz = n(m.z), dt = Math.min(2, Math.max(0.05, (now - (me.pt || now)) / 1000));
      if (me.pt && !me.free && (Math.hypot(nx - me.x, nz - me.z) > 14 * dt + 4 || Math.abs(ny - me.y) > 50 * dt + 4)) {
        me.viol = (me.viol || 0) + 2; ws.serializeAttachment(me); ws.send(JSON.stringify({ t: 'rubber', x: me.x, y: me.y, z: me.z })); return;   // 拉回上一個合法位置
      }
      me.free = 0; me.pt = now; me.viol = Math.max(0, (me.viol || 0) - 0.1);
      Object.assign(me, { x: nx, y: ny, z: nz, yaw: n(m.yaw), pitch: n(m.pitch) });
      if (me.sleeping && Math.hypot(me.x - me.bx, me.z - me.bz) > 4) { me.sleeping = false; ws.serializeAttachment(me); this.sleepCheck(); } else ws.serializeAttachment(me);
      this.broadcast({ t: 'pos', id: me.id, x: me.x, y: me.y, z: me.z, yaw: me.yaw, pitch: me.pitch }, ws);

    } else if (m.t === 'respawn') {                             // 死亡/掉出世界後重生：允許下一次位置瞬移（20 秒一次）
      if (now - (me.rc || 0) > 20000) { me.free = 1; me.rc = now; ws.serializeAttachment(me); }

    } else if (m.t === 'blk' && Array.isArray(m.e)) {
      const isHost = me.id === this.host(), cap = isHost ? 600 : 60, R2 = 9.5 ** 2, SIM = [0, 2, 7, 8, 9, 11, 12, 13, 14, 43];   // 房主可在遠處產生的模擬結果
      me.tok = Math.min(cap, (me.tok == null ? cap : me.tok) + (now - (me.tt || now)) / 1000 * (isHost ? 300 : 30)); me.tt = now;   // 速率限制（令牌桶）
      const d2 = (e, x, y, z) => (e[0] + .5 - x) ** 2 + (e[1] + .5 - y) ** 2 + (e[2] + .5 - z) ** 2;
      const list = m.e.slice(0, 200).filter(e => Array.isArray(e) && [e[0], e[1], e[2], e[3]].every(Number.isInteger) && Math.abs(e[0]) <= 100000 && Math.abs(e[2]) <= 100000 && e[1] >= 0 && e[1] <= 63 && e[3] >= 0 && e[3] <= 255 && (e[3] & 63) <= MAX_BLOCK_ID);
      const trig = list.find(e => (e[3] & 63) === 0 && d2(e, me.x, me.y + 1.6, me.z) <= R2);   // 破壞者身邊的移除 = 連鎖崩塌起點
      const ok = [], puts = {}; let bad = 0;
      for (const e of list) {
        const [x, y, z, v, old] = e, b = v & 63;
        const near = d2(e, me.x, me.y + 1.6, me.z) <= R2;
        const allowed = (near || (isHost ? SIM.includes(b) : (b === 0 && trig && d2(e, trig[0] + .5, trig[1] + .5, trig[2] + .5) <= 1600))) && !(y === 0 && b === 0);
        if (!allowed || me.tok < 1) { bad++; continue; }
        me.tok--; ok.push([x, y, z, v]);
        if (!(v & 128) && this.edits.size < 150000) { const k = 'e:' + x + ',' + y + ',' + z; this.edits.set(k, v); puts[k] = v; }   // 只有「流動中的水」不存檔
      }
      if (bad) me.viol = (me.viol || 0) + bad;
      ws.serializeAttachment(me);
      if (ok.length) {
        this.broadcast({ t: 'blk', e: ok }, ws);
        const ks = Object.keys(puts);
        for (let i = 0; i < ks.length; i += 100) await this.state.storage.put(Object.fromEntries(ks.slice(i, i + 100).map(k => [k, puts[k]])));
      }

    } else if (m.t === 'state' && me.uid) {                     // 玩家進度存檔（背包/生命/任務…）→ 驗證後寫入 Supabase
      const c = await this.getState(me), dtSec = (now - c.t) / 1000;
      if (dtSec < 8) return;
      const clean = sanitize(m.d, c.data, dtSec);
      if (!clean) { me.viol = (me.viol || 0) + 10; ws.serializeAttachment(me); ws.send(JSON.stringify({ t: 'state', d: c.data })); return; }   // 拒絕並還原成伺服器上的資料
      c.data = clean; c.t = now; c.fresh = false;
      if (sbOn(this.env)) { try { await sbJson(this.env, 'player_state?on_conflict=room,user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ room: me.room, user_id: me.uid, data: clean, updated_at: new Date().toISOString() }) }); } catch (e) {} }

    } else if (m.t === 'sleep') {                               // 睡覺投票：過半數玩家在床上就快轉到天亮
      const tod = this.tod();
      if (Math.sin(tod * 2 * Math.PI) >= -0.15) { ws.send(JSON.stringify({ t: 'sys', m: '現在不是夜晚，無法睡覺' })); return; }
      me.sleeping = true; me.bx = me.x; me.bz = me.z; ws.serializeAttachment(me); this.sleepCheck();

    } else if (m.t === 'chat' && typeof m.m === 'string') {
      if (m.m.startsWith('/')) return this.command(ws, me, m.m);
      this.broadcast({ t: 'chat', id: me.id, name: me.name, m: m.m.slice(0, 120) }, ws);
    }
  }

  sleepCheck() {
    const ps = this.players(), sl = ps.filter(p => p.sleeping).length, need = Math.max(1, Math.ceil(ps.length / 2));
    if (sl < need) { this.broadcast({ t: 'sleepers', n: sl, need }); return; }
    this.skip += (((0.01 - this.tod()) % 1) + 1) % 1 * 240000;      // 快轉到下一個清晨
    this.state.storage.put('skip', this.skip);
    for (const w of this.state.getWebSockets()) { const a = w.deserializeAttachment(); if (a) { a.sleeping = false; w.serializeAttachment(a); } }
    this.broadcast({ t: 'skip', skip: this.skip });
  }

  async command(ws, me, text) {                                 // 房主指令：/kick /ban /unban
    const sys = s => ws.send(JSON.stringify({ t: 'sys', m: s })), [cmd, ...rest] = text.slice(1).split(/\s+/), arg = rest.join(' ');
    if (!['kick', 'ban', 'unban'].includes(cmd)) return sys('可用指令（僅房主）：/kick 名稱　/ban 名稱　/unban 名稱');
    if (!me.owner) return sys('只有房主可以使用這個指令');
    if (!arg) return sys('請輸入玩家名稱');
    try {
      if (cmd === 'unban') {
        const rows = await sbJson(this.env, 'room_bans?room=eq.' + q(me.room) + '&name=eq.' + q(arg) + '&select=user_id');
        for (const r of rows) await sb(this.env, 'room_bans?room=eq.' + q(me.room) + '&user_id=eq.' + r.user_id, { method: 'DELETE' });
        return sys(rows.length ? '已解除封鎖：' + arg : '封鎖名單中沒有：' + arg);
      }
      const target = this.state.getWebSockets().find(w => { const a = w.deserializeAttachment(); return a && a.name === arg && a.id !== me.id; });
      if (!target) return sys('找不到玩家：' + arg);
      const ta = target.deserializeAttachment();
      if (cmd === 'ban') {
        if (!ta.uid) return sys('訪客沒有帳號，無法封鎖，只能 /kick');
        await sbJson(this.env, 'room_bans?on_conflict=room,user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ room: me.room, user_id: ta.uid, name: ta.name }) });
      }
      target.send(JSON.stringify({ t: 'deny', reason: cmd === 'ban' ? '你已被房主封鎖' : '你被房主踢出房間' })); target.close(4003, 'kicked');
      sys((cmd === 'ban' ? '已封鎖並踢出：' : '已踢出：') + arg);
    } catch (e) { sys('指令執行失敗（資料庫無回應）'); }
  }

  webSocketClose(ws, code, reason) {
    const me = ws.deserializeAttachment();
    try { ws.close(code, reason); } catch (e) {}
    if (me) {
      this.broadcast({ t: 'leave', id: me.id }, ws); this.broadcast({ t: 'host', id: this.host(me.id) }, ws);
      if (me.uid && !this.players(me.id).some(p => p.uid === me.uid)) this.cache.delete(me.uid);
      if (me.sleeping) setTimeout(() => this.sleepCheck(), 0);
    }
  }
  webSocketError(ws) { this.webSocketClose(ws, 1011, 'error'); }
}
