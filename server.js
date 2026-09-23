// Fudbal Manager — zero-dependency server (Node >= 22.13, uses built-in node:sqlite)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'fudbal.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  position TEXT NOT NULL DEFAULT 'MID',
  rating INTEGER NOT NULL DEFAULT 3,
  is_admin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_at TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  team_size INTEGER NOT NULL DEFAULT 6,
  team_a_name TEXT NOT NULL DEFAULT 'Whites',
  team_b_name TEXT NOT NULL DEFAULT 'Colours',
  formation_a TEXT NOT NULL DEFAULT '',
  formation_b TEXT NOT NULL DEFAULT '',
  lineup_published INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'upcoming',
  score_a INTEGER, score_b INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS attendance (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  PRIMARY KEY (match_id, player_id)
);
CREATE TABLE IF NOT EXISTS lineups (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team TEXT NOT NULL,
  slot INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id)
);
`);

// ---------- helpers ----------
const normPhone = (p) => {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  return d;
};
// Match numbers regardless of +381 / 0 prefix: compare the last 8 digits (and require >= 8 digits)
const phoneKey = (p) => normPhone(p).slice(-8);

const hashPw = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
};
const checkPw = (pw, stored) => {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex');
  const b = crypto.scryptSync(String(pw), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);

// ---------- bootstrap ----------
if (!getSetting('group_password')) {
  const pw = process.env.GROUP_PASSWORD || 'fudbal';
  setSetting('group_password', hashPw(pw));
  console.log(`[setup] Group password set to "${pw}" (change it in Admin > Settings)`);
}
if (!db.prepare('SELECT 1 FROM players LIMIT 1').get()) {
  const phone = process.env.ADMIN_PHONE;
  const name = process.env.ADMIN_NAME || 'Admin';
  if (phone) {
    db.prepare('INSERT INTO players(name, phone, is_admin) VALUES(?,?,1)').run(name, normPhone(phone));
    console.log(`[setup] Created admin ${name} (${normPhone(phone)})`);
  } else {
    console.log('[setup] No players yet. Set ADMIN_PHONE (and ADMIN_NAME) env vars and restart to create the first admin.');
  }
}

// ---------- tiny http framework ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, ...opts });
};
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (!chunks.length) return resolve({});
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Bad JSON')); }
  });
  req.on('error', reject);
});
const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

const currentUser = (req) => {
  const token = parseCookies(req.headers.cookie).fm_session;
  if (!token) return null;
  return db.prepare(`SELECT p.* FROM sessions s JOIN players p ON p.id=s.player_id WHERE s.token=? AND p.active=1`).get(token) || null;
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const PUBLIC = path.join(__dirname, 'public');
const serveStatic = (req, res, urlPath) => {
  let p = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!p.startsWith(PUBLIC)) p = path.join(PUBLIC, 'index.html');
  fs.stat(p, (err, st) => {
    if (err || !st.isFile()) p = path.join(PUBLIC, 'index.html');
    fs.readFile(p, (e2, buf) => {
      if (e2) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  });
};

// Simple login rate limit per IP
const attempts = new Map();
const limited = (ip) => {
  const now = Date.now(); const a = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  attempts.set(ip, a); return a.length >= 10;
};

// ---------- domain ----------
const pubPlayer = (p, admin) => ({
  id: p.id, name: p.name, position: p.position, rating: p.rating, is_admin: !!p.is_admin, active: !!p.active,
  ...(admin ? { phone: p.phone } : {}),
});

const matchDetail = (id, user) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(id);
  if (!m) throw new HttpError(404, 'Match not found');
  const att = db.prepare(`SELECT a.player_id, a.status, a.updated_at FROM attendance a JOIN players p ON p.id=a.player_id
    WHERE a.match_id=? AND p.active=1 ORDER BY a.updated_at ASC`).all(id);
  const cap = m.team_size * 2;
  let n = 0;
  const attendance = att.map((a) => ({ player_id: a.player_id, status: a.status, at: a.updated_at, reserve: a.status === 'in' ? ++n > cap : false }));
  const showLineup = m.lineup_published || user.is_admin;
  const lineup = showLineup ? db.prepare('SELECT player_id, team, slot FROM lineups WHERE match_id=?').all(id) : [];
  const mine = att.find((a) => a.player_id === user.id);
  return { ...m, lineup_published: !!m.lineup_published, capacity: cap, attendance, lineup, my_status: mine ? mine.status : null };
};

const requireAdmin = (u) => { if (!u.is_admin) throw new HttpError(403, 'Admins only'); };
const int = (v, name, min, max) => {
  const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) bad(`${name} must be ${min}–${max}`); return n;
};
const POSITIONS = ['GK', 'DEF', 'MID', 'FWD'];

// ---------- routes: auth ----------
route('POST', '/api/login', async (req, res, { body }) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (limited(ip)) throw new HttpError(429, 'Too many attempts. Try again in 10 minutes.');
  const key = phoneKey(body.phone);
  const pwOk = checkPw(body.password || '', getSetting('group_password'));
  const player = key.length >= 8 ? db.prepare('SELECT * FROM players WHERE active=1').all().find((p) => phoneKey(p.phone) === key) : null;
  if (!pwOk || !player) {
    attempts.get(ip).push(Date.now());
    throw new HttpError(401, !pwOk ? 'Wrong group password.' : 'This number is not on the squad list. Ask an admin to add you.');
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token, player_id) VALUES(?,?)').run(token, player.id);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  send(res, 200, { user: pubPlayer(player, true) }, {
    'Set-Cookie': `fm_session=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax${secure}`,
  });
}, { public: true });

route('POST', '/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).fm_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  send(res, 200, { ok: true }, { 'Set-Cookie': 'fm_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' });
});

route('GET', '/api/me', (req, res, { user }) => send(res, 200, { user: pubPlayer(user, true) }));

// ---------- routes: players ----------
route('GET', '/api/players', (req, res, { user }) => {
  const rows = db.prepare(`SELECT * FROM players ${user.is_admin ? '' : 'WHERE active=1'} ORDER BY name COLLATE NOCASE`).all();
  send(res, 200, { players: rows.map((p) => pubPlayer(p, user.is_admin)) });
});

const playerFields = (b, existing = {}) => {
  const name = String(b.name ?? existing.name ?? '').trim();
  if (!name) bad('Name is required');
  const phone = normPhone(b.phone ?? existing.phone);
  if (phone.length < 8) bad('Phone number looks too short');
  const position = String(b.position ?? existing.position ?? 'MID').toUpperCase();
  if (!POSITIONS.includes(position)) bad('Position must be GK, DEF, MID or FWD');
  const rating = int(b.rating ?? existing.rating ?? 3, 'Rating', 1, 5);
  const is_admin = (b.is_admin ?? !!existing.is_admin) ? 1 : 0;
  const active = (b.active ?? (existing.active ?? 1)) ? 1 : 0;
  return { name, phone, position, rating, is_admin, active };
};
const phoneTaken = (phone, exceptId = 0) =>
  db.prepare('SELECT id, phone FROM players WHERE id<>?').all(exceptId).some((p) => phoneKey(p.phone) === phoneKey(phone));

route('POST', '/api/players', (req, res, { user, body }) => {
  requireAdmin(user);
  const f = playerFields(body);
  if (phoneTaken(f.phone)) bad('A player with this phone number already exists');
  const r = db.prepare('INSERT INTO players(name,phone,position,rating,is_admin,active) VALUES(?,?,?,?,?,?)')
    .run(f.name, f.phone, f.position, f.rating, f.is_admin, f.active);
  send(res, 201, { id: Number(r.lastInsertRowid) });
});

route('PUT', '/api/players/:id', (req, res, { user, body, params }) => {
  requireAdmin(user);
  const ex = db.prepare('SELECT * FROM players WHERE id=?').get(params.id);
  if (!ex) throw new HttpError(404, 'Player not found');
  const f = playerFields(body, ex);
  if (phoneTaken(f.phone, ex.id)) bad('A player with this phone number already exists');
  if (ex.id === user.id && (!f.is_admin || !f.active)) bad("You can't remove your own admin rights or deactivate yourself");
  db.prepare('UPDATE players SET name=?, phone=?, position=?, rating=?, is_admin=?, active=? WHERE id=?')
    .run(f.name, f.phone, f.position, f.rating, f.is_admin, f.active, ex.id);
  if (!f.active) db.prepare('DELETE FROM sessions WHERE player_id=?').run(ex.id);
  send(res, 200, { ok: true });
});

route('DELETE', '/api/players/:id', (req, res, { user, params }) => {
  requireAdmin(user);
  if (Number(params.id) === user.id) bad("You can't delete yourself");
  db.prepare('DELETE FROM players WHERE id=?').run(params.id);
  send(res, 200, { ok: true });
});

// ---------- routes: matches ----------
route('GET', '/api/matches', (req, res, { user }) => {
  const rows = db.prepare(`SELECT m.*,
      (SELECT COUNT(*) FROM attendance a JOIN players p ON p.id=a.player_id WHERE a.match_id=m.id AND a.status='in' AND p.active=1) AS in_count
    FROM matches m ORDER BY m.starts_at DESC LIMIT 100`).all();
  const now = new Date().toISOString().slice(0, 16);
  const upcoming = rows.filter((m) => m.status === 'upcoming').sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const next = upcoming.find((m) => m.starts_at >= now.slice(0, 10)) || upcoming[upcoming.length - 1] || null;
  send(res, 200, { matches: rows.map((m) => ({ ...m, lineup_published: !!m.lineup_published })), next_id: next ? next.id : null });
});

route('GET', '/api/matches/:id', (req, res, { user, params }) => send(res, 200, { match: matchDetail(Number(params.id), user) }));

const matchFields = (b, ex = {}) => {
  const starts_at = String(b.starts_at ?? ex.starts_at ?? '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(starts_at)) bad('Pick a date and time');
  return {
    starts_at,
    location: String(b.location ?? ex.location ?? '').trim().slice(0, 120),
    team_size: int(b.team_size ?? ex.team_size ?? 6, 'Team size', 3, 11),
    team_a_name: String(b.team_a_name ?? ex.team_a_name ?? 'Whites').trim().slice(0, 30) || 'Whites',
    team_b_name: String(b.team_b_name ?? ex.team_b_name ?? 'Colours').trim().slice(0, 30) || 'Colours',
    notes: String(b.notes ?? ex.notes ?? '').trim().slice(0, 500),
    status: ['upcoming', 'played', 'cancelled'].includes(b.status ?? ex.status) ? (b.status ?? ex.status) : 'upcoming',
    score_a: b.score_a === '' || b.score_a == null ? (b.score_a === undefined ? ex.score_a ?? null : null) : int(b.score_a, 'Score', 0, 99),
    score_b: b.score_b === '' || b.score_b == null ? (b.score_b === undefined ? ex.score_b ?? null : null) : int(b.score_b, 'Score', 0, 99),
  };
};

route('POST', '/api/matches', (req, res, { user, body }) => {
  requireAdmin(user);
  const f = matchFields(body);
  const r = db.prepare('INSERT INTO matches(starts_at,location,team_size,team_a_name,team_b_name,notes) VALUES(?,?,?,?,?,?)')
    .run(f.starts_at, f.location, f.team_size, f.team_a_name, f.team_b_name, f.notes);
  send(res, 201, { id: Number(r.lastInsertRowid) });
});

route('PUT', '/api/matches/:id', (req, res, { user, body, params }) => {
  requireAdmin(user);
  const ex = db.prepare('SELECT * FROM matches WHERE id=?').get(params.id);
  if (!ex) throw new HttpError(404, 'Match not found');
  const f = matchFields(body, ex);
  db.prepare(`UPDATE matches SET starts_at=?, location=?, team_size=?, team_a_name=?, team_b_name=?, notes=?, status=?, score_a=?, score_b=? WHERE id=?`)
    .run(f.starts_at, f.location, f.team_size, f.team_a_name, f.team_b_name, f.notes, f.status, f.score_a, f.score_b, ex.id);
  send(res, 200, { ok: true });
});

route('DELETE', '/api/matches/:id', (req, res, { user, params }) => {
  requireAdmin(user);
  db.prepare('DELETE FROM matches WHERE id=?').run(params.id);
  send(res, 200, { ok: true });
});

route('POST', '/api/matches/:id/attendance', (req, res, { user, body, params }) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(params.id);
  if (!m) throw new HttpError(404, 'Match not found');
  let pid = user.id;
  if (body.player_id != null && Number(body.player_id) !== user.id) { requireAdmin(user); pid = Number(body.player_id); }
  if (m.status !== 'upcoming' && !user.is_admin) bad('This match is closed');
  const status = body.status;
  if (status === null || status === 'none') {
    db.prepare('DELETE FROM attendance WHERE match_id=? AND player_id=?').run(m.id, pid);
  } else if (['in', 'out'].includes(status)) {
    const ex = db.prepare('SELECT status FROM attendance WHERE match_id=? AND player_id=?').get(m.id, pid);
    if (!ex || ex.status !== status) {
      db.prepare(`INSERT INTO attendance(match_id,player_id,status,updated_at) VALUES(?,?,?,strftime('%Y-%m-%d %H:%M:%f','now'))
        ON CONFLICT(match_id,player_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`).run(m.id, pid, status);
    }
  } else bad('Status must be in or out');
  if (status !== 'in') db.prepare('DELETE FROM lineups WHERE match_id=? AND player_id=?').run(m.id, pid);
  send(res, 200, { match: matchDetail(m.id, user) });
});

route('PUT', '/api/matches/:id/lineup', (req, res, { user, body, params }) => {
  requireAdmin(user);
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(params.id);
  if (!m) throw new HttpError(404, 'Match not found');
  const entries = Array.isArray(body.lineup) ? body.lineup : bad('lineup must be a list');
  const seen = new Set(); const slots = new Set();
  for (const e of entries) {
    if (!['A', 'B'].includes(e.team)) bad('Bad team');
    const slot = int(e.slot, 'slot', 0, 199);
    if (seen.has(e.player_id)) bad('Player listed twice');
    if (slots.has(e.team + slot)) bad('Two players in one slot');
    seen.add(e.player_id); slots.add(e.team + slot);
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM lineups WHERE match_id=?').run(m.id);
    const ins = db.prepare('INSERT INTO lineups(match_id,player_id,team,slot) VALUES(?,?,?,?)');
    for (const e of entries) ins.run(m.id, Number(e.player_id), e.team, Number(e.slot));
    db.prepare('UPDATE matches SET formation_a=?, formation_b=?, lineup_published=? WHERE id=?')
      .run(String(body.formation_a || ''), String(body.formation_b || ''), body.publish ? 1 : 0, m.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  send(res, 200, { match: matchDetail(m.id, user) });
});

// ---------- routes: stats ----------
route('GET', '/api/stats', (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.position,
      COUNT(x.mid) AS played,
      SUM(CASE WHEN (x.team='A' AND x.sa>x.sb) OR (x.team='B' AND x.sb>x.sa) THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN x.sa=x.sb THEN 1 ELSE 0 END) AS drawn,
      SUM(CASE WHEN (x.team='A' AND x.sa<x.sb) OR (x.team='B' AND x.sb<x.sa) THEN 1 ELSE 0 END) AS lost,
      SUM(CASE WHEN x.team='A' THEN x.sa ELSE x.sb END) AS gf,
      SUM(CASE WHEN x.team='A' THEN x.sb ELSE x.sa END) AS ga
    FROM players p
    LEFT JOIN (SELECT l.player_id, l.team, m.id AS mid, m.score_a AS sa, m.score_b AS sb FROM lineups l JOIN matches m ON m.id=l.match_id
      WHERE m.status='played' AND m.score_a IS NOT NULL AND m.score_b IS NOT NULL) x ON x.player_id=p.id
    WHERE p.active=1
    GROUP BY p.id`).all();
  const signups = db.prepare(`SELECT a.player_id, SUM(a.status='in') AS ins, SUM(a.status='out') AS outs FROM attendance a
    JOIN matches m ON m.id=a.match_id WHERE m.status<>'cancelled' GROUP BY a.player_id`).all();
  const sMap = Object.fromEntries(signups.map((s) => [s.player_id, s]));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM matches WHERE status='played'`).get().n;
  send(res, 200, {
    total_played: total,
    players: rows.map((r) => ({ ...r, won: r.won || 0, drawn: r.drawn || 0, lost: r.lost || 0, gf: r.gf || 0, ga: r.ga || 0,
      signed_in: sMap[r.id]?.ins || 0, signed_out: sMap[r.id]?.outs || 0 })),
  });
});

// ---------- routes: settings ----------
route('PUT', '/api/settings/password', (req, res, { user, body }) => {
  requireAdmin(user);
  const pw = String(body.password || '');
  if (pw.length < 4) bad('Password must be at least 4 characters');
  setSetting('group_password', hashPw(pw));
  send(res, 200, { ok: true });
});

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, decodeURIComponent(url.pathname));
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const mt = url.pathname.match(r.re);
      if (!mt) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(mt[i + 1])]));
      const user = currentUser(req);
      if (!r.public && !user) throw new HttpError(401, 'Please log in');
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      return await r.handler(req, res, { user, body, params, query: url.searchParams });
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error' : e.message });
  }
});
server.listen(PORT, () => console.log(`Fudbal Manager running on http://localhost:${PORT}`));
