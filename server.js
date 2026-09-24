// Fudbal Manager — zero-dependency server (Node >= 22.13, uses built-in node:sqlite)
'use strict';
// Match times are stored as local wall-clock time; interpret them in the group's timezone.
process.env.TZ = process.env.TZ || 'Europe/Belgrade';
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

db.exec(`
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team TEXT NOT NULL,                       -- team credited with the goal (A/B)
  scorer_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  assist_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  own_goal INTEGER NOT NULL DEFAULT 0,      -- 1 = scorer played for the other team
  created_by INTEGER REFERENCES players(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS motm_votes (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  voter_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (match_id, voter_id)
);
`);
db.exec(`CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'post',          -- post | ability
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
  old_val INTEGER, new_val INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES players(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);
// column migrations for databases created by older versions
const addCol = (table, col, def) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
addCol('attendance', 'paid', 'INTEGER NOT NULL DEFAULT 0');
addCol('matches', 'kicked_off_at', 'TEXT');
addCol('matches', 'ended_at', 'TEXT');
addCol('players', 'pin_hash', 'TEXT');
addCol('news', 'match_id', 'INTEGER');
addCol('matches', 'clock_started', 'INTEGER NOT NULL DEFAULT 0');
addCol('news', 'ukey', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS predictions (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  a INTEGER NOT NULL, b INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (match_id, player_id)
);
CREATE TABLE IF NOT EXISTS late_drops (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (match_id, player_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS news_ukey ON news(ukey) WHERE ukey IS NOT NULL;`);
addCol('players', 'is_guest', 'INTEGER NOT NULL DEFAULT 0');
addCol('sessions', 'elevated', 'INTEGER NOT NULL DEFAULT 0');
addCol('attendance', 'invited_by', 'INTEGER');

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
// Ability scale moved from 1-5 to 0-10: double existing ratings once.
if (getSetting('rating_scale') !== '10') {
  const n = db.prepare('UPDATE players SET rating = MIN(10, rating * 2)').run().changes;
  setSetting('rating_scale', '10');
  if (n) console.log(`[setup] Converted ${n} abilities to the 0-10 scale`);
}
// Env values are cleaned (Railway/Docker users often paste quotes or trailing spaces).
const envVal = (k) => {
  const v = process.env[k];
  if (v == null) return '';
  return String(v).trim().replace(/^(["'])(.*)\1$/, '$2').trim();
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// GROUP_PASSWORD: applied on first start, and again whenever the env value changes.
// (A password changed in Admin > Settings stays until GROUP_PASSWORD itself is changed.)
{
  const envPw = envVal('GROUP_PASSWORD');
  if (envPw && getSetting('group_password_env') !== sha(envPw)) {
    setSetting('group_password', hashPw(envPw));
    setSetting('group_password_env', sha(envPw));
    console.log(`[setup] Group password set from GROUP_PASSWORD (${envPw.length} characters)`);
  } else if (!getSetting('group_password')) {
    setSetting('group_password', hashPw('fudbal'));
    console.log('[setup] No GROUP_PASSWORD set - using default password "fudbal"');
  } else {
    console.log('[setup] Group password unchanged');
  }
}

// ADMIN_PHONE: make sure this number exists and is an active admin (every start).
{
  const phone = normPhone(envVal('ADMIN_PHONE'));
  const name = envVal('ADMIN_NAME') || 'Admin';
  if (phone.length >= 8) {
    const ex = db.prepare('SELECT * FROM players').all().find((p) => phoneKey(p.phone) === phoneKey(phone));
    if (!ex) {
      db.prepare('INSERT INTO players(name, phone, is_admin, rating) VALUES(?,?,1,5)').run(name, phone);
      console.log(`[setup] Created admin ${name} (${phone})`);
    } else if (!ex.is_admin || !ex.active) {
      db.prepare('UPDATE players SET is_admin=1, active=1 WHERE id=?').run(ex.id);
      console.log(`[setup] Restored admin rights for ${ex.name}`);
    } else {
      console.log(`[setup] Admin ${ex.name} OK`);
    }
    // ADMIN_PIN: personal PIN for this admin, applied whenever the env value changes.
    const pin = envVal('ADMIN_PIN');
    const me = db.prepare('SELECT * FROM players').all().find((p) => phoneKey(p.phone) === phoneKey(phone));
    if (pin && me && getSetting('admin_pin_env') !== sha(me.id + ':' + pin)) {
      if (!/^\d{4,8}$/.test(pin)) console.log('[setup] ADMIN_PIN must be 4-8 digits - ignored');
      else {
        db.prepare('UPDATE players SET pin_hash=? WHERE id=?').run(hashPw(pin), me.id);
        db.prepare('DELETE FROM sessions WHERE player_id=?').run(me.id); // log out old sessions
        setSetting('admin_pin_env', sha(me.id + ':' + pin));
        console.log(`[setup] Admin PIN set for ${me.name} (${pin.length} digits)`);
      }
    } else if (!pin && me && !me.pin_hash) {
      console.log('[setup] WARNING: no ADMIN_PIN set - anyone with your number and the group password gets admin rights');
    }
  } else if (!db.prepare('SELECT 1 FROM players LIMIT 1').get()) {
    console.log('[setup] No players yet. Set ADMIN_PHONE (and ADMIN_NAME) and restart to create the first admin.');
  }
}
console.log(`[setup] Data stored in ${path.join(DATA_DIR, 'fudbal.db')}`);

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

const currentUser = (req) => currentUserByToken(parseCookies(req.headers.cookie).fm_session);
const currentUserByToken = (token) => {
  if (!token) return null;
  const u = db.prepare(`SELECT p.*, s.elevated FROM sessions s JOIN players p ON p.id=s.player_id WHERE s.token=? AND p.active=1 AND p.is_guest=0`).get(token);
  if (!u) return null;
  // An admin with a PIN only gets admin rights in a session that was opened with that PIN.
  u.admin_account = !!u.is_admin;
  u.is_admin = u.is_admin && (!u.pin_hash || u.elevated) ? 1 : 0;
  return u;
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
  id: p.id, name: p.name, position: p.position, rating: p.rating, is_admin: !!p.is_admin, active: !!p.active, is_guest: !!p.is_guest,
  ...(admin && !p.is_guest ? { phone: p.phone } : {}),
  ...(admin ? { has_pin: !!p.pin_hash } : {}),
});
const meJson = (u) => ({ ...pubPlayer(u, true), admin_account: !!u.admin_account });

// ---- man of the match ----
const VOTE_HOURS = 24;
const voteClosesAt = (m) => {
  if (m.status !== 'played') return null;
  const base = m.ended_at ? new Date(m.ended_at) : new Date(m.starts_at + ':00Z');
  return new Date(base.getTime() + VOTE_HOURS * 3600e3).toISOString();
};
const playedIds = (matchId) => new Set(db.prepare('SELECT player_id FROM lineups WHERE match_id=?').all(matchId).map((r) => r.player_id));
const motmWinners = (matchId) => {
  const rows = db.prepare('SELECT player_id, COUNT(*) AS n FROM motm_votes WHERE match_id=? GROUP BY player_id ORDER BY n DESC').all(matchId);
  if (!rows.length) return [];
  return rows.filter((r) => r.n === rows[0].n).map((r) => r.player_id);
};
const motmInfo = (m, user) => {
  const closes = voteClosesAt(m);
  if (!closes) return null;
  const open = new Date() < new Date(closes);
  const played = playedIds(m.id);
  const voters = db.prepare('SELECT COUNT(*) AS n FROM lineups l JOIN players p ON p.id=l.player_id WHERE l.match_id=? AND p.is_guest=0').get(m.id).n;
  const mine = db.prepare('SELECT player_id FROM motm_votes WHERE match_id=? AND voter_id=?').get(m.id, user.id);
  const total = db.prepare('SELECT COUNT(*) AS n FROM motm_votes WHERE match_id=?').get(m.id).n;
  const counts = open ? null : Object.fromEntries(db.prepare('SELECT player_id, COUNT(*) AS n FROM motm_votes WHERE match_id=? GROUP BY player_id').all(m.id).map((r) => [r.player_id, r.n]));
  return { open, closes_at: closes, can_vote: open && played.has(user.id), my_vote: mine ? mine.player_id : null,
    votes: total, voters, counts, winners: open ? [] : motmWinners(m.id) };
};

// ---- score predictions ----
const PRED_EXACT = 3, PRED_RESULT = 1;
const predLocked = (m) => m.status !== 'upcoming' || !!m.clock_started || Date.now() >= Date.parse(m.starts_at);
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const predScore = (p, m) => {
  if (m.status !== 'played' || m.score_a == null || m.score_b == null) return null;
  if (p.a === m.score_a && p.b === m.score_b) return PRED_EXACT;
  return sign(p.a - p.b) === sign(m.score_a - m.score_b) ? PRED_RESULT : 0;
};
const predInfo = (m, user) => {
  if (m.status === 'cancelled') return null;
  const locked = predLocked(m);
  const all = db.prepare('SELECT player_id, a, b FROM predictions WHERE match_id=? ORDER BY created_at').all(m.id);
  const mine = all.find((p) => p.player_id === user.id) || null;
  return { locked, count: all.length, mine, list: locked ? all.map((p) => ({ ...p, score: predScore(p, m) })) : [] };
};

const matchDetail = (id, user) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(id);
  if (!m) throw new HttpError(404, 'Match not found');
  const att = db.prepare(`SELECT a.player_id, a.status, a.updated_at, a.paid, a.invited_by FROM attendance a JOIN players p ON p.id=a.player_id
    WHERE a.match_id=? AND p.active=1 ORDER BY a.updated_at ASC`).all(id);
  const cap = m.team_size * 2;
  let n = 0;
  const attendance = att.map((a) => ({ player_id: a.player_id, status: a.status, at: a.updated_at, paid: !!a.paid, invited_by: a.invited_by, reserve: a.status === 'in' ? ++n > cap : false }));
  const showLineup = m.lineup_published || user.is_admin;
  const lineup = showLineup ? db.prepare('SELECT player_id, team, slot FROM lineups WHERE match_id=?').all(id) : [];
  const mine = att.find((a) => a.player_id === user.id);
  const goals = db.prepare('SELECT id, team, scorer_id, assist_id, own_goal, created_by, created_at FROM goals WHERE match_id=? ORDER BY id').all(id)
    .map((g) => ({ ...g, own_goal: !!g.own_goal }));
  return { ...m, lineup_published: !!m.lineup_published, capacity: cap, attendance, lineup, goals,
    motm: motmInfo(m, user), points: matchPoints(m), predictions: predInfo(m, user), my_status: mine ? mine.status : null };
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
  const pwOk = checkPw(String(body.password || '').trim(), getSetting('group_password'));
  const player = key.length >= 8 ? db.prepare('SELECT * FROM players WHERE active=1 AND is_guest=0').all().find((p) => phoneKey(p.phone) === key) : null;
  if (!pwOk || !player) {
    attempts.get(ip).push(Date.now());
    throw new HttpError(401, !pwOk ? 'Wrong group password.' : 'This number is not on the squad list. Ask an admin to add you.');
  }
  const pin = String(body.pin || '').trim();
  let elevated = 0;
  if (pin) {
    if (!player.is_admin || !player.pin_hash || !checkPw(pin, player.pin_hash)) {
      attempts.get(ip).push(Date.now());
      throw new HttpError(401, 'Wrong admin PIN.');
    }
    elevated = 1;
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token, player_id, elevated) VALUES(?,?,?)').run(token, player.id, elevated);
  const u = currentUserByToken(token);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  send(res, 200, { user: meJson(u) }, {
    'Set-Cookie': `fm_session=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax${secure}`,
  });
}, { public: true });

route('POST', '/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).fm_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  send(res, 200, { ok: true }, { 'Set-Cookie': 'fm_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' });
});

route('GET', '/api/me', (req, res, { user }) => send(res, 200, { user: meJson(user) }));

// ---------- routes: players ----------
route('GET', '/api/players', (req, res, { user }) => {
  const rows = db.prepare(`SELECT * FROM players ${user.is_admin ? '' : 'WHERE active=1'} ORDER BY is_guest, name COLLATE NOCASE`).all();
  send(res, 200, { players: rows.map((p) => pubPlayer(p, user.is_admin)) });
});

const playerFields = (b, existing = {}) => {
  const name = String(b.name ?? existing.name ?? '').trim();
  if (!name) bad('Name is required');
  const phone = normPhone(b.phone ?? existing.phone);
  if (phone.length < 8) bad('Phone number looks too short');
  const position = String(b.position ?? existing.position ?? 'MID').toUpperCase();
  if (!POSITIONS.includes(position)) bad('Position must be GK, DEF, MID or FWD');
  const rating = int(b.rating ?? existing.rating ?? 5, 'Ability', 0, 10);
  const is_admin = (b.is_admin ?? !!existing.is_admin) ? 1 : 0;
  const active = (b.active ?? (existing.active ?? 1)) ? 1 : 0;
  const pin = b.pin == null ? '' : String(b.pin).trim();
  if (pin && !/^\d{4,8}$/.test(pin)) bad('Admin PIN must be 4–8 digits');
  return { name, phone, position, rating, is_admin, active, pin };
};
const phoneTaken = (phone, exceptId = 0) =>
  db.prepare('SELECT id, phone FROM players WHERE id<>?').all(exceptId).some((p) => phoneKey(p.phone) === phoneKey(phone));

route('POST', '/api/players', (req, res, { user, body }) => {
  requireAdmin(user);
  const f = playerFields(body);
  if (phoneTaken(f.phone)) bad('A player with this phone number already exists');
  const r = db.prepare('INSERT INTO players(name,phone,position,rating,is_admin,active,pin_hash) VALUES(?,?,?,?,?,?,?)')
    .run(f.name, f.phone, f.position, f.rating, f.is_admin, f.active, f.pin ? hashPw(f.pin) : null);
  send(res, 201, { id: Number(r.lastInsertRowid) });
});

route('PUT', '/api/players/:id', (req, res, { user, body, params }) => {
  requireAdmin(user);
  const ex = db.prepare('SELECT * FROM players WHERE id=?').get(params.id);
  if (!ex) throw new HttpError(404, 'Player not found');
  const wasGuest = !!ex.is_guest;
  if (wasGuest && !body.phone) {
    // editing a guest without giving a number: keep them a guest
    const name = String(body.name ?? ex.name).trim() || ex.name;
    const position = POSITIONS.includes(String(body.position || '').toUpperCase()) ? String(body.position).toUpperCase() : ex.position;
    const rating = body.rating != null ? int(body.rating, 'Ability', 0, 10) : ex.rating;
    db.prepare('UPDATE players SET name=?, position=?, rating=? WHERE id=?').run(name, position, rating, ex.id);
  if (ex.rating !== rating && body.announce) {
    const up = rating > ex.rating;
    db.prepare('INSERT INTO news(kind, title, body, player_id, old_val, new_val, created_by) VALUES(?,?,?,?,?,?,?)')
      .run('ability', `${up ? 'ABILITY UP' : 'ABILITY DOWN'}: ${name.toUpperCase()}`, String(body.note || '').trim().slice(0, 300), ex.id, ex.rating, rating, user.id);
  }
    return send(res, 200, { ok: true });
  }
  const f = playerFields(body, wasGuest ? { ...ex, phone: '' } : ex);
  if (phoneTaken(f.phone, ex.id)) bad('A player with this phone number already exists');
  if (ex.id === user.id && (!f.is_admin || !f.active)) bad("You can't remove your own admin rights or deactivate yourself");
  db.prepare('UPDATE players SET name=?, phone=?, position=?, rating=?, is_admin=?, active=?, is_guest=0 WHERE id=?')
    .run(f.name, f.phone, f.position, f.rating, f.is_admin, f.active, ex.id);
  if (f.pin) {
    db.prepare('UPDATE players SET pin_hash=? WHERE id=?').run(hashPw(f.pin), ex.id);
    if (ex.id !== user.id) db.prepare('DELETE FROM sessions WHERE player_id=?').run(ex.id);
  }
  if (!f.active) db.prepare('DELETE FROM sessions WHERE player_id=?').run(ex.id);
  if (ex.rating !== f.rating && body.announce) {
    const up = f.rating > ex.rating;
    db.prepare('INSERT INTO news(kind, title, body, player_id, old_val, new_val, created_by) VALUES(?,?,?,?,?,?,?)')
      .run('ability', `${up ? 'ABILITY UP' : 'ABILITY DOWN'}: ${f.name.toUpperCase()}`, String(body.note || '').trim().slice(0, 300), ex.id, ex.rating, f.rating, user.id);
  }
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
  const ended_at = f.status === 'played' ? (ex.ended_at || new Date().toISOString()) : null;
  db.prepare(`UPDATE matches SET starts_at=?, location=?, team_size=?, team_a_name=?, team_b_name=?, notes=?, status=?, score_a=?, score_b=?, ended_at=? WHERE id=?`)
    .run(f.starts_at, f.location, f.team_size, f.team_a_name, f.team_b_name, f.notes, f.status, f.score_a, f.score_b, ended_at, ex.id);
  if (f.status === 'played') { try { announceMilestones(); } catch (e) { console.error(e); } }
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
  // Dropping out less than 24h before kick-off is remembered (for the "Late dropper" badge). Re-joining clears it.
  const prev = db.prepare('SELECT status FROM attendance WHERE match_id=? AND player_id=?').get(m.id, pid);
  const untilKo = Date.parse(m.starts_at) - Date.now();
  if (prev?.status === 'in' && status !== 'in' && untilKo < 24 * 3600e3 && untilKo > -3 * 3600e3 && pid === user.id)
    db.prepare('INSERT OR IGNORE INTO late_drops(match_id, player_id) VALUES(?,?)').run(m.id, pid);
  if (status === 'in') db.prepare('DELETE FROM late_drops WHERE match_id=? AND player_id=?').run(m.id, pid);
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

// ---------- routes: paid checkbox ----------
route('POST', '/api/matches/:id/paid', (req, res, { user, body, params }) => {
  requireAdmin(user);
  const r = db.prepare('UPDATE attendance SET paid=? WHERE match_id=? AND player_id=?').run(body.paid ? 1 : 0, Number(params.id), Number(body.player_id));
  if (!r.changes) bad('That player has not signed up for this match');
  send(res, 200, { match: matchDetail(Number(params.id), user) });
});

// ---------- routes: live goals (any logged-in player) ----------
const syncScore = (matchId) => {
  const c = db.prepare(`SELECT SUM(team='A') AS a, SUM(team='B') AS b, COUNT(*) AS n FROM goals WHERE match_id=?`).get(matchId);
  db.prepare('UPDATE matches SET score_a=?, score_b=? WHERE id=?').run(c.a || 0, c.b || 0, matchId);
};
const liveMatch = (id) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(id);
  if (!m) throw new HttpError(404, 'Match not found');
  if (m.status === 'cancelled') bad('This match was cancelled');
  return m;
};

// Kick off = the official start of the clock (keepers' clean minutes count from here).
// body: {} = now, { minutes_ago: n } or { at: ISO } when someone forgot to press it.
route('POST', '/api/matches/:id/kickoff', (req, res, { user, body, params }) => {
  const m = liveMatch(Number(params.id));
  if (!m.lineup_published) bad('Teams are not published yet');
  if (m.status === 'played' && !user.is_admin) bad('Only an admin can change the kick-off of a finished match');
  if (m.clock_started && !user.is_admin && !body.fix) bad('The clock is already running');
  let t = Date.now();
  if (body.minutes_ago != null) t -= int(body.minutes_ago, 'Minutes', 0, 180) * 60e3;
  else if (body.at) { t = Date.parse(body.at); if (!Number.isFinite(t)) bad('Bad time'); }
  if (t > Date.now() + 60e3) bad('Kick-off can\'t be in the future');
  const first = db.prepare('SELECT MIN(created_at) AS t FROM goals WHERE match_id=?').get(m.id).t;
  if (first && t > Date.parse(first)) bad('Kick-off must be before the first goal — pick an earlier time');
  if (m.ended_at && t > Date.parse(m.ended_at)) bad('Kick-off must be before full time');
  db.prepare('UPDATE matches SET kicked_off_at=?, clock_started=1 WHERE id=?').run(new Date(t).toISOString(), m.id);
  if (m.score_a == null) db.prepare('UPDATE matches SET score_a=0, score_b=0 WHERE id=?').run(m.id);
  send(res, 200, { match: matchDetail(m.id, user) });
});

route('POST', '/api/matches/:id/goals', (req, res, { user, body, params }) => {
  const m = liveMatch(Number(params.id));
  const lineup = Object.fromEntries(db.prepare('SELECT player_id, team FROM lineups WHERE match_id=?').all(m.id).map((l) => [l.player_id, l.team]));
  const scorer = Number(body.scorer_id);
  const sTeam = lineup[scorer];
  if (!sTeam) bad('Scorer is not in the line-up');
  const own = !!body.own_goal;
  const team = own ? (sTeam === 'A' ? 'B' : 'A') : sTeam;
  let assist = body.assist_id == null || body.assist_id === '' ? null : Number(body.assist_id);
  if (own) assist = null;
  if (assist != null && (lineup[assist] !== sTeam || assist === scorer)) bad('Assist must be a team-mate');
  const recent = db.prepare(`SELECT id FROM goals WHERE match_id=? AND scorer_id=? AND own_goal=? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 seconds')`).get(m.id, scorer, own ? 1 : 0);
  if (recent) throw new HttpError(409, 'Someone just recorded that goal');
  if (!m.kicked_off_at) db.prepare('UPDATE matches SET kicked_off_at=? WHERE id=?').run(new Date().toISOString(), m.id);
  db.prepare('INSERT INTO goals(match_id, team, scorer_id, assist_id, own_goal, created_by) VALUES(?,?,?,?,?,?)')
    .run(m.id, team, scorer, assist, own ? 1 : 0, user.id);
  syncScore(m.id);
  send(res, 201, { match: matchDetail(m.id, user) });
});

route('PUT', '/api/matches/:id/goals/:gid', (req, res, { user, body, params }) => {
  const m = liveMatch(Number(params.id));
  const g = db.prepare('SELECT * FROM goals WHERE id=? AND match_id=?').get(Number(params.gid), m.id);
  if (!g) throw new HttpError(404, 'Goal not found');
  const assist = body.assist_id == null || body.assist_id === '' ? null : Number(body.assist_id);
  if (assist != null) {
    const t = db.prepare('SELECT team FROM lineups WHERE match_id=? AND player_id=?').get(m.id, assist)?.team;
    if (g.own_goal || t !== g.team || assist === g.scorer_id) bad('Assist must be a team-mate');
  }
  db.prepare('UPDATE goals SET assist_id=? WHERE id=?').run(assist, g.id);
  send(res, 200, { match: matchDetail(m.id, user) });
});

route('DELETE', '/api/matches/:id/goals/:gid', (req, res, { user, params }) => {
  const m = liveMatch(Number(params.id));
  db.prepare('DELETE FROM goals WHERE id=? AND match_id=?').run(Number(params.gid), m.id);
  syncScore(m.id);
  send(res, 200, { match: matchDetail(m.id, user) });
});

route('POST', '/api/matches/:id/fulltime', (req, res, { user, params }) => {
  const m = liveMatch(Number(params.id));
  if (!user.is_admin) {
    const started = m.kicked_off_at ? new Date(m.kicked_off_at) : null;
    if (!started || Date.now() - started.getTime() < 30 * 60e3) throw new HttpError(403, 'Only an admin can end the match this early');
  }
  if (m.status !== 'played') {
    syncScore(m.id);
    db.prepare(`UPDATE matches SET status='played', ended_at=? WHERE id=?`).run(new Date().toISOString(), m.id);
    try { announceMilestones(); } catch (e) { console.error(e); }
  }
  send(res, 200, { match: matchDetail(m.id, user) });
});

route('POST', '/api/matches/:id/prediction', (req, res, { user, body, params }) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(Number(params.id));
  if (!m) throw new HttpError(404, 'Match not found');
  if (predLocked(m)) bad('Predictions are locked — the match has started');
  if (body.clear) db.prepare('DELETE FROM predictions WHERE match_id=? AND player_id=?').run(m.id, user.id);
  else {
    const a = int(body.a, 'Score', 0, 30), b = int(body.b, 'Score', 0, 30);
    db.prepare(`INSERT INTO predictions(match_id, player_id, a, b) VALUES(?,?,?,?)
      ON CONFLICT(match_id, player_id) DO UPDATE SET a=excluded.a, b=excluded.b, created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(m.id, user.id, a, b);
  }
  send(res, 200, { match: matchDetail(m.id, user) });
});

route('POST', '/api/matches/:id/motm', (req, res, { user, body, params }) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(Number(params.id));
  if (!m) throw new HttpError(404, 'Match not found');
  const info = motmInfo(m, user);
  if (!info || !info.open) bad('Voting is closed');
  if (!info.can_vote) bad('Only players who played can vote');
  const pid = Number(body.player_id);
  if (pid === user.id) bad("You can't vote for yourself");
  if (!playedIds(m.id).has(pid)) bad('That player did not play');
  db.prepare(`INSERT INTO motm_votes(match_id, voter_id, player_id) VALUES(?,?,?)
    ON CONFLICT(match_id, voter_id) DO UPDATE SET player_id=excluded.player_id`).run(m.id, user.id, pid);
  send(res, 200, { match: matchDetail(m.id, user) });
});

// ---------- routes: guests (one-off players, no login) ----------
const guestPhone = () => 'guest:' + [...crypto.randomBytes(12)].map((b) => String.fromCharCode(97 + (b % 26))).join('');
route('GET', '/api/guests', (req, res) => {
  const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM attendance a WHERE a.player_id=p.id) AS games FROM players p
    WHERE p.is_guest=1 AND p.active=1 ORDER BY p.name COLLATE NOCASE`).all();
  send(res, 200, { guests: rows.map((g) => ({ ...pubPlayer(g, false), games: g.games })) });
});
route('POST', '/api/matches/:id/guests', (req, res, { user, body, params }) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(Number(params.id));
  if (!m) throw new HttpError(404, 'Match not found');
  if (m.status !== 'upcoming' && !user.is_admin) bad('This match is closed');
  let gid = body.guest_id != null ? Number(body.guest_id) : null;
  if (gid) {
    const g = db.prepare('SELECT * FROM players WHERE id=? AND is_guest=1').get(gid);
    if (!g) bad('Guest not found');
  } else {
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) bad('Give the guest a name');
    const position = POSITIONS.includes(String(body.position || '').toUpperCase()) ? String(body.position).toUpperCase() : 'MID';
    const rating = body.rating != null && body.rating !== '' ? int(body.rating, 'Ability', 0, 10) : 5;
    const existing = db.prepare('SELECT id FROM players WHERE is_guest=1 AND name=? COLLATE NOCASE').get(name);
    gid = existing ? existing.id : Number(db.prepare('INSERT INTO players(name, phone, position, rating, is_guest) VALUES(?,?,?,?,1)')
      .run(name, guestPhone(), position, rating).lastInsertRowid);
    if (existing) db.prepare('UPDATE players SET active=1 WHERE id=?').run(gid);
  }
  if (db.prepare('SELECT 1 FROM attendance WHERE match_id=? AND player_id=?').get(m.id, gid)) bad('That guest is already on the list');
  db.prepare(`INSERT INTO attendance(match_id, player_id, status, invited_by, updated_at) VALUES(?,?,'in',?,strftime('%Y-%m-%d %H:%M:%f','now'))`)
    .run(m.id, gid, user.id);
  send(res, 201, { match: matchDetail(m.id, user) });
});
route('DELETE', '/api/matches/:id/guests/:pid', (req, res, { user, params }) => {
  const a = db.prepare(`SELECT a.* FROM attendance a JOIN players p ON p.id=a.player_id WHERE a.match_id=? AND a.player_id=? AND p.is_guest=1`)
    .get(Number(params.id), Number(params.pid));
  if (!a) throw new HttpError(404, 'Guest not on this match');
  if (!user.is_admin && a.invited_by !== user.id) throw new HttpError(403, 'Only the player who invited them or an admin can remove a guest');
  db.prepare('DELETE FROM attendance WHERE match_id=? AND player_id=?').run(a.match_id, a.player_id);
  db.prepare('DELETE FROM lineups WHERE match_id=? AND player_id=?').run(a.match_id, a.player_id);
  send(res, 200, { match: matchDetail(a.match_id, user) });
});

// ---------- routes: player profile ----------
route('GET', '/api/players/:id/profile', (req, res, { user, params }) => {
  const p = db.prepare('SELECT * FROM players WHERE id=?').get(Number(params.id));
  if (!p) throw new HttpError(404, 'Player not found');
  const games = db.prepare(`SELECT m.*, l.team, l.slot
    FROM lineups l JOIN matches m ON m.id=l.match_id
    WHERE l.player_id=? AND m.status='played' AND m.score_a IS NOT NULL AND m.score_b IS NOT NULL
    ORDER BY m.starts_at DESC`).all(p.id);
  const goalsBy = Object.fromEntries(db.prepare(`SELECT match_id, COUNT(*) AS n FROM goals WHERE scorer_id=? AND own_goal=0 GROUP BY match_id`).all(p.id).map((r) => [r.match_id, r.n]));
  const assistsBy = Object.fromEntries(db.prepare(`SELECT match_id, COUNT(*) AS n FROM goals WHERE assist_id=? GROUP BY match_id`).all(p.id).map((r) => [r.match_id, r.n]));
  const ogBy = Object.fromEntries(db.prepare(`SELECT match_id, COUNT(*) AS n FROM goals WHERE scorer_id=? AND own_goal=1 GROUP BY match_id`).all(p.id).map((r) => [r.match_id, r.n]));
  const R = pointRules();
  const list = games.map((g) => {
    const mp = matchPoints(g, R)[p.id] || { pts: 0 };
    const mine = g.team === 'A' ? g.score_a : g.score_b, theirs = g.team === 'A' ? g.score_b : g.score_a;
    const c = voteClosesAt(g);
    const motm = c && new Date() >= new Date(c) && motmWinners(g.id).includes(p.id);
    return { match_id: g.id, starts_at: g.starts_at, team: g.team, team_name: g.team === 'A' ? g.team_a_name : g.team_b_name,
      opp_name: g.team === 'A' ? g.team_b_name : g.team_a_name, for: mine, against: theirs,
      result: mine > theirs ? 'W' : mine < theirs ? 'L' : 'D', sub: g.slot >= 100,
      goals: goalsBy[g.id] || 0, assists: assistsBy[g.id] || 0, own_goals: ogBy[g.id] || 0, motm, pts: mp.pts, gk: !!mp.gk, blocks: mp.blocks || 0 };
  });
  const sum = (k) => list.reduce((a, g) => a + (typeof g[k] === 'boolean' ? (g[k] ? 1 : 0) : g[k]), 0);
  const count = (r) => list.filter((g) => g.result === r).length;
  // most common team-mate and win rate together
  const mates = {};
  for (const g of games) {
    for (const t of db.prepare('SELECT player_id FROM lineups WHERE match_id=? AND team=? AND player_id<>?').all(g.id, g.team, p.id)) {
      const x = mates[t.player_id] || (mates[t.player_id] = { games: 0, wins: 0 });
      x.games++; const mine = g.team === 'A' ? g.score_a : g.score_b, theirs = g.team === 'A' ? g.score_b : g.score_a;
      if (mine > theirs) x.wins++;
    }
  }
  const best = Object.entries(mates).filter(([, x]) => x.games >= 3).map(([id, x]) => ({ id: Number(id), ...x, pct: Math.round(x.wins / x.games * 100) }))
    .sort((a, b) => b.pct - a.pct || b.games - a.games)[0] || null;
  const signups = db.prepare(`SELECT SUM(a.status='in') AS ins, SUM(a.status='out') AS outs FROM attendance a JOIN matches m ON m.id=a.match_id
    WHERE a.player_id=? AND m.status<>'cancelled'`).get(p.id);
  const hist = buildHistory();
  const badges = p.is_guest ? [] : playerBadges(p.id, hist);
  const rel = relations(p.id, hist);
  const ability_history = db.prepare(`SELECT old_val, new_val, body, created_at FROM news WHERE kind='ability' AND player_id=? ORDER BY id DESC LIMIT 10`).all(p.id);
  send(res, 200, { ability_history, badges, ...rel, player: pubPlayer(p, false), totals: {
    played: list.length, won: count('W'), drawn: count('D'), lost: count('L'), goals: sum('goals'), assists: sum('assists'),
    motm: sum('motm'), own_goals: sum('own_goals'), win_pct: list.length ? Math.round(count('W') / list.length * 100) : 0,
    signed_in: signups.ins || 0, signed_out: signups.outs || 0,
    points: r2(list.reduce((x, g) => x + g.pts, 0)), ppg: list.length ? r2(list.reduce((x, g) => x + g.pts, 0) / list.length) : 0,
  }, games: list.slice(0, 30), best_mate: best });
});

// ---------- routes: backup ----------
route('GET', '/api/backup', (req, res, { user }) => {
  requireAdmin(user);
  const tmp = path.join(DATA_DIR, `backup-${process.pid}-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const buf = fs.readFileSync(tmp);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="fudbal-backup-${stamp}.db"`, 'Cache-Control': 'no-store' });
    res.end(buf);
  } finally { fs.rmSync(tmp, { force: true }); }
});

// ---------- points system ----------
const POINT_DEFAULTS = {
  win: 2, draw: 1, loss: 0, goal: 0.5, assist: 0.25, own_goal: -0.25, motm: 1,
  gk_clean_block: 0.25, gk_block_minutes: 5, gk_conceded: -0.25, match_minutes: 60,
};
const POINT_LIMITS = { gk_block_minutes: [1, 30], match_minutes: [10, 180] };
const pointRules = () => {
  let saved = {};
  try { saved = JSON.parse(getSetting('point_rules') || '{}'); } catch {}
  return { ...POINT_DEFAULTS, ...saved };
};
const r2 = (x) => Math.round(x * 100) / 100;

// Points every player earned in one played match: { pid: { pts, gk, blocks, conceded } }
const matchPoints = (m, R = pointRules()) => {
  const out = {};
  if (m.status !== 'played' || m.score_a == null || m.score_b == null) return out;
  const lineup = db.prepare('SELECT player_id, team, slot FROM lineups WHERE match_id=?').all(m.id);
  const goals = db.prepare('SELECT team, scorer_id, assist_id, own_goal, created_at FROM goals WHERE match_id=?').all(m.id);
  const closes = voteClosesAt(m);
  const motm = closes && new Date() >= new Date(closes) ? motmWinners(m.id) : [];
  for (const l of lineup) {
    const f = l.team === 'A' ? m.score_a : m.score_b, a = l.team === 'A' ? m.score_b : m.score_a;
    let pts = f > a ? R.win : f < a ? R.loss : R.draw;
    for (const g of goals) {
      if (g.scorer_id === l.player_id) pts += g.own_goal ? R.own_goal : R.goal;
      if (g.assist_id === l.player_id) pts += R.assist;
    }
    if (motm.includes(l.player_id)) pts += R.motm;
    const row = { pts, gk: false, blocks: 0, conceded: 0, timed: false, live_goals: true };
    if (l.slot === 0) {
      // goalkeeper: penalty per goal conceded, bonus for every full clean block of minutes
      row.gk = true; row.conceded = a;
      pts += a * R.gk_conceded;
      const against = goals.filter((g) => g.team !== l.team);
      row.timed = !!(m.clock_started && m.kicked_off_at);
      row.live_goals = against.length === a;
      if (row.timed && against.length === a) {          // only when ▶ Kick off was used and goals were recorded live
        const start = Date.parse(m.kicked_off_at);
        const endRaw = m.ended_at ? Date.parse(m.ended_at) : NaN;
        const end = endRaw > start && endRaw - start <= 150 * 60e3 ? endRaw : start + R.match_minutes * 60e3;
        const block = R.gk_block_minutes * 60e3;
        let prev = start, blocks = 0;
        for (const t of against.map((g) => Date.parse(g.created_at)).sort((x, y) => x - y)) {
          const tt = Math.min(Math.max(t, start), end);
          blocks += Math.floor((tt - prev) / block); prev = tt;
        }
        blocks += Math.floor((end - prev) / block);
        row.blocks = blocks; pts += blocks * R.gk_clean_block;
      }
    }
    row.pts = r2(pts);
    out[l.player_id] = row;
  }
  return out;
};

route('GET', '/api/settings/points', (req, res) => send(res, 200, { rules: pointRules(), defaults: POINT_DEFAULTS }));
route('PUT', '/api/settings/points', (req, res, { user, body }) => {
  requireAdmin(user);
  const rules = {};
  for (const k of Object.keys(POINT_DEFAULTS)) {
    const v = body[k] === '' || body[k] == null ? POINT_DEFAULTS[k] : Number(body[k]);
    const [lo, hi] = POINT_LIMITS[k] || [-10, 10];
    if (!Number.isFinite(v) || v < lo || v > hi) bad(`${k.replace(/_/g, ' ')} must be between ${lo} and ${hi}`);
    rules[k] = POINT_LIMITS[k] ? Math.round(v) : r2(v);
  }
  setSetting('point_rules', JSON.stringify(rules));
  send(res, 200, { rules });
});

// ---------- match history (used by milestones, badges, rivalries) ----------
// One entry per played match (oldest first) with every line-up player's result, goals, assists, keeper data.
const buildHistory = () => {
  const ms = db.prepare(`SELECT * FROM matches WHERE status='played' AND score_a IS NOT NULL AND score_b IS NOT NULL ORDER BY starts_at, id`).all();
  const lineups = {}, goals = {};
  for (const l of db.prepare('SELECT match_id, player_id, team, slot FROM lineups').all()) (lineups[l.match_id] ||= []).push(l);
  for (const g of db.prepare('SELECT match_id, team, scorer_id, assist_id, own_goal FROM goals').all()) (goals[g.match_id] ||= []).push(g);
  return ms.map((m) => {
    const gs = goals[m.id] || [];
    const players = (lineups[m.id] || []).map((l) => {
      const f = l.team === 'A' ? m.score_a : m.score_b, a = l.team === 'A' ? m.score_b : m.score_a;
      return { pid: l.player_id, team: l.team, gk: l.slot === 0, sub: l.slot >= 100, for: f, against: a,
        res: f > a ? 'W' : f < a ? 'L' : 'D',
        goals: gs.filter((g) => g.scorer_id === l.player_id && !g.own_goal).length,
        assists: gs.filter((g) => g.assist_id === l.player_id).length };
    });
    return { m, players };
  });
};
const guestIds = () => new Set(db.prepare('SELECT id FROM players WHERE is_guest=1').all().map((r) => r.id));
const pnameOf = (id) => db.prepare('SELECT name FROM players WHERE id=?').get(id)?.name || '?';
const scoreLine = (m) => `${m.team_a_name} ${m.score_a}-${m.score_b} ${m.team_b_name}`;
const postNews = (ukey, title, body, player_id, match_id, at) =>
  db.prepare(`INSERT OR IGNORE INTO news(kind, title, body, player_id, match_id, ukey, created_at) VALUES('milestone',?,?,?,?,?,?)`)
    .run(title, body, player_id, match_id, ukey, at);

// ---------- automatic milestone announcements ----------
// Runs after full time and every few minutes; each milestone is posted once (unique ukey).
// Only matches that ended in the last 7 days are announced, so deploying this doesn't flood the news with old records.
const MS_GOALS = [10, 25, 50, 75, 100, 150, 200, 250, 300], MS_APPS = [10, 25, 50, 75, 100, 150, 200], MS_ASSISTS = [10, 25, 50, 75, 100];
const announceMilestones = () => {
  const hist = buildHistory(), guests = guestIds(), now = Date.now();
  const tot = {}; // running totals per player
  for (const { m, players } of hist) {
    const endIso = m.ended_at || new Date(Date.parse(m.starts_at)).toISOString();
    const recent = now - Date.parse(endIso) < 7 * 864e5 && Date.parse(endIso) <= now;
    for (const p of players) {
      const t = tot[p.pid] ||= { apps: 0, goals: 0, assists: 0, streak: 0 };
      const before = { ...t };
      t.apps++; t.goals += p.goals; t.assists += p.assists; t.streak = p.res === 'W' ? t.streak + 1 : 0;
      if (!recent || guests.has(p.pid)) continue;
      const name = pnameOf(p.pid).toUpperCase(), sl = scoreLine(m);
      if (p.goals >= 3) postNews(`hat:${m.id}:${p.pid}`, `⚽ ${p.goals === 3 ? 'HAT-TRICK' : p.goals + ' GOALS'}: ${name}`, `${p.goals} goals · ${sl}`, p.pid, m.id, endIso);
      if (p.assists >= 3) postNews(`ast:${m.id}:${p.pid}`, `🎯 ${p.assists} ASSISTS: ${name}`, `Playmaker of the day · ${sl}`, p.pid, m.id, endIso);
      for (const th of MS_GOALS) if (before.goals < th && t.goals >= th) postNews(`goals:${p.pid}:${th}`, `⚽ ${th} GOALS: ${name}`, `Reached ${th} goals in ${t.apps} games`, p.pid, m.id, endIso);
      for (const th of MS_ASSISTS) if (before.assists < th && t.assists >= th) postNews(`assists:${p.pid}:${th}`, `🎯 ${th} ASSISTS: ${name}`, `Reached ${th} assists in ${t.apps} games`, p.pid, m.id, endIso);
      for (const th of MS_APPS) if (before.apps < th && t.apps >= th) postNews(`apps:${p.pid}:${th}`, `🏟 ${th} GAMES: ${name}`, `${t.goals} goal${t.goals === 1 ? '' : 's'} and ${t.assists} assist${t.assists === 1 ? '' : 's'} so far`, p.pid, m.id, endIso);
      if (t.streak > 0 && t.streak % 5 === 0) postNews(`streak:${p.pid}:${m.id}`, `🔥 ${t.streak} WINS IN A ROW: ${name}`, `Latest: ${sl}`, p.pid, m.id, endIso);
      if (p.gk && !p.sub && p.against === 0) postNews(`cs:${m.id}:${p.pid}`, `🧤 CLEAN SHEET: ${name}`, `Kept a clean sheet · ${sl}`, p.pid, m.id, endIso);
    }
    if (recent) {
      const exact = db.prepare('SELECT player_id FROM predictions WHERE match_id=? AND a=? AND b=?').all(m.id, m.score_a, m.score_b).map((r) => r.player_id);
      if (exact.length) postNews(`pred:${m.id}`, `🔮 CALLED IT: ${exact.map((id) => pnameOf(id).toUpperCase()).join(' & ')}`,
        `Predicted ${m.score_a}-${m.score_b} exactly · +${PRED_EXACT} in the predictor league`, exact[0], m.id, endIso);
    }
  }
};

// ---------- badges ----------
const BADGES = [
  { key: 'iron', icon: '🏋', name: 'Iron Man', desc: 'Played 10 matches in a row', tone: 'good' },
  { key: 'sniper', icon: '⚽', name: 'Sniper', desc: 'Scored a hat-trick', tone: 'good' },
  { key: 'playmaker', icon: '🎯', name: 'Playmaker', desc: '3 assists in one match', tone: 'good' },
  { key: 'wall', icon: '🧤', name: 'The Wall', desc: 'Clean sheet in goal', tone: 'good' },
  { key: 'streak', icon: '🔥', name: 'Hot Streak', desc: '5 wins in a row', tone: 'good' },
  { key: 'veteran', icon: '🏟', name: 'Veteran', desc: '25 matches played', tone: 'good' },
  { key: 'motm', icon: '★', name: 'MOTM King', desc: 'Man of the match 3 times', tone: 'good' },
  { key: 'oracle', icon: '🔮', name: 'Oracle', desc: 'Predicted an exact score', tone: 'good' },
  { key: 'reliable', icon: '✅', name: 'Mr Reliable', desc: '10 sign-ups, never dropped out late', tone: 'good' },
  { key: 'late', icon: '🙈', name: 'Late Dropper', desc: 'Dropped out less than 24h before kick-off', tone: 'shame' },
];
const playerBadges = (pid, hist) => {
  let run = 0, bestRun = 0, streak = 0, bestStreak = 0, sniper = 0, playmaker = 0, wall = 0, apps = 0;
  for (const { players } of hist) {
    const p = players.find((x) => x.pid === pid);
    if (!p) { run = 0; continue; }
    apps++; run++; bestRun = Math.max(bestRun, run);
    streak = p.res === 'W' ? streak + 1 : 0; bestStreak = Math.max(bestStreak, streak);
    if (p.goals >= 3) sniper++;
    if (p.assists >= 3) playmaker++;
    if (p.gk && !p.sub && p.against === 0) wall++;
  }
  let motm = 0;
  for (const { m } of hist) { const c = voteClosesAt(m); if (c && Date.now() >= Date.parse(c) && motmWinners(m.id).includes(pid)) motm++; }
  let oracle = 0;
  for (const pr of db.prepare(`SELECT p.a, p.b, m.* FROM predictions p JOIN matches m ON m.id=p.match_id WHERE p.player_id=? AND m.status='played'`).all(pid))
    if (pr.a === pr.score_a && pr.b === pr.score_b) oracle++;
  const late = db.prepare('SELECT COUNT(*) AS n FROM late_drops WHERE player_id=?').get(pid).n;
  const signups = db.prepare(`SELECT COUNT(*) AS n FROM attendance a JOIN matches m ON m.id=a.match_id WHERE a.player_id=? AND a.status='in' AND m.status<>'cancelled'`).get(pid).n;
  const v = {
    iron: [bestRun >= 10 ? 1 : 0, `best run ${bestRun}/10`], sniper: [sniper, ''], playmaker: [playmaker, ''], wall: [wall, ''],
    streak: [bestStreak >= 5 ? Math.floor(bestStreak / 5) : 0, `best ${bestStreak}/5`], veteran: [apps >= 25 ? 1 : 0, `${apps}/25`],
    motm: [motm >= 3 ? 1 : 0, `${motm}/3`], oracle: [oracle, ''], reliable: [signups >= 10 && !late ? 1 : 0, late ? 'dropped late' : `${signups}/10`], late: [late, ''],
  };
  return BADGES.map((b) => ({ ...b, count: v[b.key][0], earned: v[b.key][0] > 0, progress: v[b.key][1] }));
};

// ---------- partnerships & rivalries ----------
const relations = (pid, hist) => {
  const w = {}, o = {};
  for (const { players } of hist) {
    const me = players.find((x) => x.pid === pid);
    if (!me) continue;
    for (const x of players) {
      if (x.pid === pid) continue;
      const bucket = x.team === me.team ? w : o;
      const r = bucket[x.pid] ||= { games: 0, W: 0, D: 0, L: 0 };
      r.games++; r[me.res]++;
    }
  }
  const list = (b) => Object.entries(b).filter(([id, r]) => r.games >= 3).map(([id, r]) => ({ id: Number(id), ...r, pct: Math.round((r.W / r.games) * 100) }));
  const wl = list(w).sort((a, b) => b.pct - a.pct || b.games - a.games);
  const ol = list(o).sort((a, b) => a.pct - b.pct || b.games - a.games);
  return {
    best_mates: wl.slice(0, 3),
    worst_mate: wl.length > 3 ? wl[wl.length - 1] : null,
    nemesis: ol[0] && ol[0].pct < 50 ? ol[0] : null,
    victim: ol.length > 1 && ol[ol.length - 1].pct > 50 ? ol[ol.length - 1] : null,
  };
};

route('GET', '/api/h2h/:a/:b', (req, res, { params }) => {
  const a = Number(params.a), b = Number(params.b);
  const r = { together: { games: 0, W: 0, D: 0, L: 0 }, against: { games: 0, a: 0, b: 0, draws: 0, a_goals: 0, b_goals: 0 } };
  for (const { players } of buildHistory()) {
    const pa = players.find((x) => x.pid === a), pb = players.find((x) => x.pid === b);
    if (!pa || !pb) continue;
    if (pa.team === pb.team) { r.together.games++; r.together[pa.res]++; }
    else {
      r.against.games++; r.against.a_goals += pa.goals; r.against.b_goals += pb.goals;
      if (pa.res === 'W') r.against.a++; else if (pa.res === 'L') r.against.b++; else r.against.draws++;
    }
  }
  send(res, 200, r);
});

// ---------- automatic man-of-the-match announcements ----------
// Voting closes by time, so check regularly and post once per match (only votes that closed in the last 7 days).
const announceMotm = () => {
  const now = Date.now();
  for (const m of db.prepare(`SELECT * FROM matches WHERE status='played'`).all()) {
    const c = voteClosesAt(m);
    if (!c) continue;
    const closed = Date.parse(c);
    if (closed > now || now - closed > 7 * 864e5) continue;
    if (db.prepare(`SELECT 1 FROM news WHERE kind='motm' AND match_id=?`).get(m.id)) continue;
    const winners = motmWinners(m.id);
    if (!winners.length) continue;
    const names = winners.map((id) => db.prepare('SELECT name FROM players WHERE id=?').get(id)?.name || '?');
    const top = db.prepare('SELECT COUNT(*) AS n FROM motm_votes WHERE match_id=? AND player_id=?').get(m.id, winners[0]).n;
    const total = db.prepare('SELECT COUNT(*) AS n FROM motm_votes WHERE match_id=?').get(m.id).n;
    const body = `${m.team_a_name} ${m.score_a}-${m.score_b} ${m.team_b_name} · ${top} of ${total} vote${total === 1 ? '' : 's'}${winners.length > 1 ? ' each (shared)' : ''}`;
    db.prepare(`INSERT INTO news(kind, title, body, player_id, match_id, created_at) VALUES('motm', ?, ?, ?, ?, ?)`)
      .run(`MAN OF THE MATCH: ${names.join(' & ').toUpperCase()}`, body, winners[0], m.id, new Date(closed).toISOString());
    console.log(`[news] MOTM announced for match ${m.id}: ${names.join(' & ')}`);
  }
};
try { announceMotm(); announceMilestones(); } catch (e) { console.error(e); }
setInterval(() => { try { announceMotm(); announceMilestones(); } catch (e) { console.error(e); } }, 5 * 60e3);

// ---------- routes: news ----------
const newsRow = (n) => ({ ...n, pinned: !!n.pinned });
route('GET', '/api/news', (req, res, { query }) => {
  announceMotm(); announceMilestones();
  const limit = Math.min(Number(query.get('limit')) || 50, 200);
  const rows = db.prepare('SELECT * FROM news ORDER BY pinned DESC, id DESC LIMIT ?').all(limit).map(newsRow);
  const latest = db.prepare('SELECT MAX(id) AS id FROM news').get().id || 0;
  send(res, 200, { news: rows, latest_id: latest });
});
route('POST', '/api/news', (req, res, { user, body }) => {
  requireAdmin(user);
  const title = String(body.title || '').trim().slice(0, 80);
  if (!title) bad('Give the announcement a headline');
  const r = db.prepare('INSERT INTO news(kind, title, body, pinned, created_by) VALUES(?,?,?,?,?)')
    .run('post', title, String(body.body || '').trim().slice(0, 1000), body.pinned ? 1 : 0, user.id);
  send(res, 201, { id: Number(r.lastInsertRowid) });
});
route('PUT', '/api/news/:id', (req, res, { user, body, params }) => {
  requireAdmin(user);
  const n = db.prepare('SELECT * FROM news WHERE id=?').get(Number(params.id));
  if (!n) throw new HttpError(404, 'Not found');
  const title = body.title != null ? String(body.title).trim().slice(0, 80) || n.title : n.title;
  const text = body.body != null ? String(body.body).trim().slice(0, 1000) : n.body;
  const pinned = body.pinned != null ? (body.pinned ? 1 : 0) : n.pinned;
  db.prepare('UPDATE news SET title=?, body=?, pinned=? WHERE id=?').run(title, text, pinned, n.id);
  send(res, 200, { ok: true });
});
route('DELETE', '/api/news/:id', (req, res, { user, params }) => {
  requireAdmin(user);
  db.prepare('DELETE FROM news WHERE id=?').run(Number(params.id));
  send(res, 200, { ok: true });
});

const predictorTable = () => {
  const rows = {};
  for (const x of db.prepare(`SELECT p.player_id, p.a, p.b, m.* FROM predictions p JOIN matches m ON m.id=p.match_id
      JOIN players pl ON pl.id=p.player_id WHERE m.status='played' AND pl.active=1`).all()) {
    const s = predScore(x, x);
    const r = rows[x.player_id] ||= { id: x.player_id, n: 0, exact: 0, result: 0, pts: 0 };
    r.n++; r.pts += s; if (s === PRED_EXACT) r.exact++; else if (s === PRED_RESULT) r.result++;
  }
  return Object.values(rows).sort((a, b) => b.pts - a.pts || b.exact - a.exact || a.n - b.n);
};

// ---------- routes: stats ----------
route('GET', '/api/stats', (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.position, p.rating,
      COUNT(x.mid) AS played,
      SUM(CASE WHEN (x.team='A' AND x.sa>x.sb) OR (x.team='B' AND x.sb>x.sa) THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN x.sa=x.sb THEN 1 ELSE 0 END) AS drawn,
      SUM(CASE WHEN (x.team='A' AND x.sa<x.sb) OR (x.team='B' AND x.sb<x.sa) THEN 1 ELSE 0 END) AS lost,
      SUM(CASE WHEN x.team='A' THEN x.sa ELSE x.sb END) AS gf,
      SUM(CASE WHEN x.team='A' THEN x.sb ELSE x.sa END) AS ga
    FROM players p
    LEFT JOIN (SELECT l.player_id, l.team, m.id AS mid, m.score_a AS sa, m.score_b AS sb FROM lineups l JOIN matches m ON m.id=l.match_id
      WHERE m.status='played' AND m.score_a IS NOT NULL AND m.score_b IS NOT NULL) x ON x.player_id=p.id
    WHERE p.active=1 AND p.is_guest=0
    GROUP BY p.id`).all();
  const signups = db.prepare(`SELECT a.player_id, SUM(a.status='in') AS ins, SUM(a.status='out') AS outs FROM attendance a
    JOIN matches m ON m.id=a.match_id WHERE m.status<>'cancelled' GROUP BY a.player_id`).all();
  const sMap = Object.fromEntries(signups.map((s) => [s.player_id, s]));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM matches WHERE status='played'`).get().n;
  const gMap = Object.fromEntries(db.prepare(`SELECT g.scorer_id AS id, COUNT(*) AS n FROM goals g JOIN matches m ON m.id=g.match_id
    WHERE g.own_goal=0 AND m.status<>'cancelled' GROUP BY g.scorer_id`).all().map((r) => [r.id, r.n]));
  const aMap = Object.fromEntries(db.prepare(`SELECT g.assist_id AS id, COUNT(*) AS n FROM goals g JOIN matches m ON m.id=g.match_id
    WHERE g.assist_id IS NOT NULL AND m.status<>'cancelled' GROUP BY g.assist_id`).all().map((r) => [r.id, r.n]));
  const mMap = {}, pMap = {};
  const R = pointRules();
  for (const m of db.prepare(`SELECT * FROM matches WHERE status='played'`).all()) {
    const c = voteClosesAt(m);
    if (c && new Date() >= new Date(c)) for (const pid of motmWinners(m.id)) mMap[pid] = (mMap[pid] || 0) + 1;
    for (const [pid, x] of Object.entries(matchPoints(m, R))) {
      const t = pMap[pid] || (pMap[pid] = { pts: 0, gk_games: 0, conceded: 0, blocks: 0 });
      t.pts += x.pts; if (x.gk) { t.gk_games++; t.conceded += x.conceded; t.blocks += x.blocks; }
    }
  }
  send(res, 200, {
    total_played: total,
    players: rows.map((r) => ({ ...r, won: r.won || 0, drawn: r.drawn || 0, lost: r.lost || 0, gf: r.gf || 0, ga: r.ga || 0,
      signed_in: sMap[r.id]?.ins || 0, signed_out: sMap[r.id]?.outs || 0, goals: gMap[r.id] || 0, assists: aMap[r.id] || 0, motm: mMap[r.id] || 0,
      rating: r.rating, points: r2(pMap[r.id]?.pts || 0), ppg: r.played ? r2((pMap[r.id]?.pts || 0) / r.played) : 0,
      gk_games: pMap[r.id]?.gk_games || 0, conceded: pMap[r.id]?.conceded || 0, clean_blocks: pMap[r.id]?.blocks || 0 })),
    rules: R,
    predictors: predictorTable(),
  });
});

// ---------- routes: settings ----------
route('PUT', '/api/settings/password', (req, res, { user, body }) => {
  requireAdmin(user);
  const pw = String(body.password || '');
  if (pw.length < 4) bad('Password must be at least 4 characters');
  setSetting('group_password', hashPw(pw.trim()));
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