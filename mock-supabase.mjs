// 測試用的「假 Supabase」：只實作 Worker 會呼叫的幾個端點（記憶體內資料表）。
// 驗證：Authorization: Bearer tok_<uid>_<name>；PostgREST：apikey 必須是 "svc"。
import http from 'node:http';
const tables = { rooms: [], room_members: [], room_bans: [], player_state: [] };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); let body = ''; for await (const c of req) body += c;
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
  if (u.pathname === '/__dump') return send(200, tables);
  if (u.pathname === '/auth/v1/user') {
    const m = /^Bearer tok_([^_]+)_(.+)$/.exec(req.headers.authorization || '');
    return m ? send(200, { id: m[1], email: m[2] + '@x.test', user_metadata: { name: m[2] } }) : send(401, { msg: 'bad token' });
  }
  const m = /^\/rest\/v1\/(\w+)$/.exec(u.pathname);
  if (!m || !tables[m[1]] || req.headers.apikey !== 'svc') return send(404, {});
  const filt = r => [...u.searchParams].every(([k, v]) => ['select', 'on_conflict', 'order'].includes(k) || !v.startsWith('eq.') || String(r[k]) === v.slice(3));
  if (req.method === 'GET') return send(200, tables[m[1]].filter(filt));
  if (req.method === 'POST') {
    const row = JSON.parse(body), oc = u.searchParams.get('on_conflict'), rows = tables[m[1]];
    if (oc) { const keys = oc.split(','), i = rows.findIndex(r => keys.every(k => r[k] === row[k])); if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push(row); } else rows.push(row);
    return (req.headers.prefer || '').includes('return=representation') ? send(201, [row]) : send(201);
  }
  if (req.method === 'DELETE') { tables[m[1]] = tables[m[1]].filter(r => !filt(r)); return send(204); }
  send(405, {});
}).listen(9999, '127.0.0.1', () => console.log('mock supabase on :9999'));
