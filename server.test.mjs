// 伺服器端到端測試（需先啟動 mock-supabase 與 wrangler dev，見 run-all.sh）。Node 22+（內建 WebSocket）
const BASE = 'ws://127.0.0.1:8787/ws', DB = 'http://127.0.0.1:9999/__dump';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const open = (room, name, { token, qs = '' } = {}) => new Promise(res => {
  const ws = new WebSocket(`${BASE}?room=${room}&name=${encodeURIComponent(name)}${qs}`, token ? ['mc', 'jwt.' + token] : ['mc']), msgs = [];
  ws.onmessage = e => msgs.push(JSON.parse(e.data)); ws.onerror = () => res({ ws, msgs, error: true }); ws.onopen = () => setTimeout(() => res({ ws, msgs }), 450);
});
const send = (c, o) => c.ws.send(JSON.stringify(o));
const find = (c, t) => c.msgs.find(m => m.t === t);
const R = n => n + Date.now().toString(36);          // 每次測試用全新房間
const dump = async () => (await fetch(DB)).json();

// ---- 睡覺投票（伺服器時間被 DEV_TIME_OFFSET_MS 調成夜晚）----
{
  const room = R('sl'), a = await open(room, 'A'), b = await open(room, 'B'), c = await open(room, 'C');
  const initA = find(a, 'init'); ok(initA && initA.now > 0 && initA.skip >= 0, '睡覺：init 帶有伺服器時間與 skip');
  send(a, { t: 'pos', x: 5, y: 40, z: 5, yaw: 0, pitch: 0 }); send(b, { t: 'pos', x: 6, y: 40, z: 5, yaw: 0, pitch: 0 }); await sleep(200);
  send(a, { t: 'sleep' }); await sleep(300);
  const sl = b.msgs.find(m => m.t === 'sleepers'); ok(sl && sl.n === 1 && sl.need === 2, '3 人房：1 人睡覺 → 廣播 1/2');
  ok(!b.msgs.some(m => m.t === 'skip'), '尚未過半，不會快轉');
  send(b, { t: 'sleep' }); await sleep(400);
  const sk = c.msgs.find(m => m.t === 'skip'); ok(sk && sk.skip > 0, '過半數睡覺 → 全員收到 skip（快轉到清晨）');
  [a, b, c].forEach(x => x.ws.close());
}
// ---- 訪客 / 登入 / 私人房間 / 邀請碼 / 封鎖 ----
{
  const g = await open(R('pub'), 'Guy'); const gi = find(g, 'init');
  ok(gi && gi.authed === false && !gi.owner, 'Supabase 模式：訪客可進公開房間（authed=false）');
  const bad = await open(R('x'), 'Z', { token: 'bogus' }); ok(find(bad, 'deny') && /過期/.test(find(bad, 'deny').reason), '無效 token → 拒絕');
  const room = R('secret');
  const alice = await open(room, 'x', { token: 'tok_u1_Alice', qs: '&private=1' }), ai = find(alice, 'init');
  ok(ai && ai.owner && ai.authed && typeof ai.invite === 'string' && ai.invite.length >= 8, '登入者建立私人房間 → 成為房主並取得邀請碼');
  let db = await dump(); ok(db.rooms.some(r => r.slug === room && r.private && r.owner === 'u1'), '房間資料已寫入 Supabase(rooms)');
  const guest = await open(room, 'G'); ok(/私人房間/.test((find(guest, 'deny') || {}).reason || ''), '訪客進私人房間 → 拒絕');
  const nocode = await open(room, 'x', { token: 'tok_u2_Bob' }); ok(/邀請碼/.test((find(nocode, 'deny') || {}).reason || ''), '沒有邀請碼 → 拒絕');
  const wrong = await open(room, 'x', { token: 'tok_u2_Bob', qs: '&code=nope' }); ok(find(wrong, 'deny'), '錯誤邀請碼 → 拒絕');
  let bob = await open(room, 'x', { token: 'tok_u2_Bob', qs: '&code=' + ai.invite }); ok(find(bob, 'init'), '正確邀請碼 → 加入');
  db = await dump(); ok(db.room_members.some(m => m.room === room && m.user_id === 'u2'), '加入後成為成員（room_members）');
  bob.ws.close(); await sleep(300);
  bob = await open(room, 'x', { token: 'tok_u2_Bob' }); ok(find(bob, 'init'), '成員再次加入不需邀請碼');
  const dup = await open(room, 'x', { token: 'tok_u2_Bob' }); await sleep(200);
  ok(bob.msgs.some(m => m.t === 'deny' && /其他地方/.test(m.reason)), '同帳號重複登入 → 舊連線被踢');
  send(dup, { t: 'chat', m: '/kick Alice' }); await sleep(300); ok(dup.msgs.some(m => m.t === 'sys' && /房主/.test(m.m)), '非房主使用指令 → 被拒絕');
  send(alice, { t: 'chat', m: '/ban Bob' }); await sleep(500);
  ok(dup.msgs.some(m => m.t === 'deny' && /封鎖/.test(m.reason)), '房主 /ban → 目標收到封鎖通知');
  db = await dump(); ok(db.room_bans.some(b => b.room === room && b.user_id === 'u2'), '封鎖名單已寫入 Supabase');
  const again = await open(room, 'x', { token: 'tok_u2_Bob' }); ok(/封鎖/.test((find(again, 'deny') || {}).reason || ''), '被封鎖者無法再進入');
  send(alice, { t: 'chat', m: '/unban Bob' }); await sleep(400);
  const back = await open(room, 'x', { token: 'tok_u2_Bob' }); ok(find(back, 'init'), '/unban 後可再次進入');
}
// ---- 玩家進度存檔 + 驗證 ----
{
  const room = R('st'), kit = { inv: { 9: 2, 10: 4 }, hp: 20, food: 20, qi: 0, stat: { wood: 0, stone: 0, coal: 0, iron: 0, kills: 0, crafted: {} }, dur: {}, p: null, sel: 0 };
  const c1 = await open(room, 'x', { token: 'tok_u3_Carol' }), c2 = await open(room, 'x', { token: 'tok_u4_Dave' });
  ok(find(c1, 'init').state === null, '新玩家 state=null（用預設裝備）');
  await sleep(8300);                                          // 伺服器限制：每 8 秒最多存一次
  send(c1, { t: 'state', d: { ...kit, inv: { 9: 2, 10: 4, 2: 50, 43: 3 }, hp: 15, qi: 2, p: { x: 1, y: 40, z: 2 } } });
  send(c2, { t: 'state', d: { ...kit, inv: { 9: 2, 10: 4, 3: 99999 } } });
  await sleep(600);
  const db = await dump(), r1 = db.player_state.find(r => r.user_id === 'u3' && r.room === room), r2 = db.player_state.find(r => r.user_id === 'u4' && r.room === room);
  ok(r1 && r1.data.inv[2] === 50 && r1.data.inv[43] === 3 && r1.data.hp === 15, '合法進度寫入 Supabase(player_state)');
  ok(!r2, '作弊進度（數量超限）被拒絕、不寫入');
  ok(c2.msgs.some(m => m.t === 'state' && m.d.inv[9] === 2), '被拒絕時，伺服器回傳原進度讓客戶端還原');
  c1.ws.close(); await sleep(300);
  const c1b = await open(room, 'x', { token: 'tok_u3_Carol' }); const st = find(c1b, 'init').state;
  ok(st && st.inv[2] === 50 && st.p.x === 1, '重新登入後，init 帶回上次的背包與位置');
}
// ---- 位置反作弊 ----
{
  const room = R('ac'), a = await open(room, 'A'), b = await open(room, 'B');
  send(a, { t: 'pos', x: 5, y: 40, z: 5, yaw: 0, pitch: 0 }); await sleep(250);
  send(a, { t: 'pos', x: 6, y: 40, z: 5, yaw: 0, pitch: 0 }); await sleep(250);
  ok(!a.msgs.some(m => m.t === 'rubber'), '正常移動不會被拉回');
  send(a, { t: 'pos', x: 600, y: 40, z: 600, yaw: 0, pitch: 0 }); await sleep(300);
  const rb = find(a, 'rubber'); ok(rb && Math.abs(rb.x - 6) < 0.01, '瞬移 → 收到 rubber 並拉回上一個合法位置');
  send(a, { t: 'respawn' }); await sleep(100); send(a, { t: 'pos', x: 300, y: 60, z: 300, yaw: 0, pitch: 0 }); await sleep(300);
  ok(b.msgs.some(m => m.t === 'pos' && m.x === 300), '重生後的第一次瞬移被允許');
  // 方塊：距離與速率；b 不是房主（a 先進入）
  send(b, { t: 'pos', x: 10, y: 40, z: 10, yaw: 0, pitch: 0 }); await sleep(200);
  send(b, { t: 'blk', e: [[10, 40, 11, 3 | 64, 0], [10, 40, 12, 9 | 128, 9], [10, 40, 13, 9, 0], [400, 40, 400, 3, 0], [1, 40, 1, 0, 3], [10, 0, 10, 0, 3]] }); await sleep(400);
  const blk = a.msgs.filter(m => m.t === 'blk').flatMap(m => m.e);
  ok(blk.length === 3 && !blk.some(e => e[0] === 400 || e[1] === 0), '方塊：超出觸及距離與破壞基岩層的修改被過濾');
  const c = await open(room, 'C'), edits = find(c, 'init').edits.map(e => e.join());
  ok(edits.includes('10,40,11,67') && edits.includes('10,40,13,9') && !edits.includes('10,40,12,137'), '存檔：保留 placed 旗標；「流動水」(旗標 128) 不寫入');
}
// ---- 無 token 的舊行為（公開房間 + 多人同步）----
{
  const room = R('pl'), a = await open(room, 'Alice'), b = await open(room, 'Bob');
  const ia = find(a, 'init'), ib = find(b, 'init');
  ok(ib.seed === ia.seed && ib.players.length === 1 && ib.host === ia.id, '同房間同種子、看得到對方、房主是先進入者');
  a.ws.close(); await sleep(500);
  ok(b.msgs.some(m => m.t === 'leave') && b.msgs.some(m => m.t === 'host' && m.id === ib.id), '房主離開 → leave + 房主轉移');
}
console.log(fails ? `\n${fails} 項失敗` : '\n全部通過'); process.exit(fails ? 1 : 0);
