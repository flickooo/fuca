/* Fudbal Manager — frontend (vanilla JS, no build step) */
'use strict';

// ---------- utilities ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = {}; try { data = await r.json(); } catch {}
  if (r.status === 401 && url !== '/api/login') { S.me = null; renderLogin(); throw new Error(data.error || 'Please log in'); }
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
let toastT;
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' error' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
}
const fail = (e) => toast(e.message, true);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dt = (s) => new Date(s);
const fmtTime = (s) => { const d = dt(s); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const fmtDate = (s) => { const d = dt(s); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const fmtShort = (s) => { const d = dt(s); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const ablCls = (n) => (n >= 8 ? 'g' : n >= 6 ? 'y' : n >= 4 ? 'c' : 'r');
// ability 0-10: number + 10-step bar
const stars = (n) => `<span class="abl"><b class="${ablCls(n)}">${n}</b><span class="stars">${'▮'.repeat(n)}<span class="off">${'▮'.repeat(10 - n)}</span></span></span>`;
const ablOptions = (cur) => Array.from({ length: 11 }, (_, x) => `<option value="${x}" ${x === cur ? 'selected' : ''}>${x} ${'▮'.repeat(x)}${'▯'.repeat(10 - x)}</option>`).join('');
const fmtPts = (x) => (Math.round(x * 100) / 100).toString();
const posBadge = (p) => `<span class="pos ${esc(p)}">${esc(p)}</span>`;
const initials = (name) => name.replace(/\(.*?\)/g, ' ').split(/\s+/).filter((w) => /^\p{L}/u.test(w)).map((w) => w[0]).join('').slice(0, 3).toUpperCase() || name.trim()[0].toUpperCase();
const shortName = (name) => { const w = name.replace(/\(.*?\)/g, ' ').trim().split(/\s+/).filter(Boolean); return w.length > 1 ? w[w.length - 1] : (w[0] || name); };

const clockText = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${DAYS[d.getDay()]} ${p(d.getDate())} ${MONTHS[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}/${p(d.getSeconds())}`; };
setInterval(() => $$('.clock').forEach((c) => (c.textContent = clockText())), 1000);

// ---------- formations ----------
const FORMATIONS = {
  3: ['1-1', '2-0'], 4: ['2-1', '1-2', '1-1-1'], 5: ['2-2', '1-2-1', '2-1-1', '3-1'], 6: ['2-2-1', '3-1-1', '2-1-2', '1-2-2', '3-2'],
  7: ['3-2-1', '2-3-1', '3-1-2', '2-2-2'], 8: ['3-3-1', '3-2-2', '2-3-2', '2-4-1'], 9: ['3-3-2', '4-3-1', '3-4-1'],
  10: ['4-4-1', '3-4-2', '4-3-2'], 11: ['4-4-2', '4-3-3', '3-5-2', '4-5-1', '4-2-3-1'],
};
const BENCH = 4;
function slotLayout(formation, team) {
  // returns [{slot, x, y, role}] with y in % from top; team A defends the bottom goal
  const lines = formation.split('-').map(Number).filter((n) => n > 0);
  const out = [{ slot: 0, x: 50, y: 94, role: 'GK' }];
  let slot = 1;
  const L = lines.length;
  lines.forEach((n, i) => {
    const y = L === 1 ? 72 : 82.5 - (i * (25 / (L - 1)));
    const role = i === 0 ? 'DEF' : i === L - 1 ? 'FWD' : 'MID';
    for (let j = 0; j < n; j++) out.push({ slot: slot++, x: ((j + 1) / (n + 1)) * 100, y, role });
  });
  if (team === 'B') out.forEach((s) => { s.y = 100 - s.y; s.x = 100 - s.x; });
  return out;
}

// ---------- state ----------
const S = { me: null, players: [], pmap: {}, matches: [], nextId: null, tac: null };

async function loadPlayers() {
  const { players } = await api('GET', '/api/players');
  S.players = players; S.pmap = Object.fromEntries(players.map((p) => [p.id, p]));
}
async function loadMatches() {
  const r = await api('GET', '/api/matches'); S.matches = r.matches; S.nextId = r.next_id;
}

// ---------- shell ----------
const TABS = [
  { id: 'match', label: 'Match', page: 302, key: 'red' }, { id: 'tactics', label: 'Teams', page: 303, key: 'green' },
  { id: 'fixtures', label: 'Results', page: 304, key: 'yellow' }, { id: 'stats', label: 'Table', page: 305, key: 'cyan' },
  { id: 'admin', label: 'Admin', page: 399, key: 'magenta', admin: true },
];
function shell(active) {
  const me = S.me;
  return `
  <header class="topbar">
    <div class="pageline"><span class="w">P${location.hash.startsWith('#/live') ? 310 : location.hash.startsWith('#/player') ? 306 : (TABS.find((t) => t.id === active) || TABS[0]).page}</span><span class="c">FUDBAL</span><span class="y clock">${clockText()}</span></div>
    <div class="titleband"><span class="dh">FUDBAL TEXT</span><span class="who"><span class="c">${esc(me.name.toUpperCase())}</span>${me.is_admin ? ' <span class="m">ADMIN</span>' : me.admin_account ? ' <button class="linkbtn m" id="adminpin">[ADMIN]</button>' : ''} <button class="linkbtn" id="logout">[EXIT]</button></span></div>
  </header>
  <main id="view"></main>
  <nav class="tabs fastext">${TABS.filter((t) => !t.admin || me.is_admin).map((t) =>
    `<a class="tab k-${t.key} ${t.id === active ? 'active' : ''}" href="#/${t.id}">${t.label}</a>`).join('')}</nav>`;
}
function mount(active) {
  app.innerHTML = shell(active);
  $('#logout').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); S.me = null; location.hash = ''; renderLogin(); };
  const ap = $('#adminpin');
  if (ap) ap.onclick = async () => { await api('POST', '/api/logout').catch(() => {}); S.me = null; S.wantPin = true; renderLogin(); toast('Log in again with your admin PIN'); };
  return $('#view');
}

// ---------- router ----------
async function route() {
  if (!S.me) return renderLogin();
  const [, page = 'match', arg, arg2] = (location.hash || '#/match').split('/');
  try {
    if (page === 'match') await viewMatch(arg ? Number(arg) : null);
    else if (page === 'tactics') await viewTactics(arg ? Number(arg) : null);
    else if (page === 'live' && arg) await viewLive(Number(arg));
    else if (page === 'player' && arg) await viewProfile(Number(arg));
    else if (page === 'fixtures') await viewFixtures();
    else if (page === 'stats') await viewStats();
    else if (page === 'admin' && S.me.is_admin) await viewAdmin(arg || 'squad', arg2);
    else location.hash = '#/match';
  } catch (e) { if (S.me) fail(e); }
}
window.addEventListener('hashchange', route);

// ---------- login ----------
function renderLogin() {
  app.innerHTML = `
  <div class="login-wrap"><div class="login">
    <div class="pageline"><span class="w">P100</span><span class="c">FUDBAL</span><span class="y clock">${clockText()}</span></div>
    <div class="titleband"><span class="dh">FUDBAL TEXT</span></div>
    <div class="brand"><p class="y">FRIDAY FOOTBALL SERVICE</p><p class="c">SIGN IN TO THE SQUAD</p></div>
    <div class="panel"><div class="panel-h">Login</div><div class="panel-b">
      <form id="lf">
        <label class="f"><span>Your phone number (as in WhatsApp)</span><input type="tel" name="phone" autocomplete="tel" placeholder="+381 64 123 4567" required></label>
        <label class="f"><span>Group password</span><input type="password" name="password" autocomplete="current-password" required></label>
        <label class="f" id="pinrow" ${S.wantPin ? '' : 'hidden'}><span class="m">Admin PIN</span><input type="password" name="pin" inputmode="numeric" autocomplete="off" placeholder="only for admins"></label>
        <div class="err" id="lerr"></div>
        <button class="btn primary" style="width:100%;min-height:48px;font-size:28px">Continue ›</button>
        <p style="text-align:center;margin:14px 0 0"><button type="button" class="linkbtn m" id="pinlink" ${S.wantPin ? 'hidden' : ''}>[ADMIN? ENTER PIN]</button></p>
      </form>
    </div></div>
  </div></div>`;
  try { const saved = localStorage.getItem('fm_phone'); if (saved) $('#lf').phone.value = saved; } catch {}
  $('#pinlink').onclick = () => { $('#pinrow').hidden = false; $('#pinlink').hidden = true; $('#lf').pin.focus(); };
  $('#lf').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; $('#lerr').textContent = '';
    try {
      const { user } = await api('POST', '/api/login', { phone: f.phone.value, password: f.password.value, pin: f.pin.value });
      S.wantPin = false;
      try { localStorage.setItem('fm_phone', f.phone.value); } catch {}
      S.me = user; route();
    } catch (err) { $('#lerr').textContent = err.message; }
  };
}

// ---------- match view ----------
function fixtureHeader(m) {
  const d = dt(m.starts_at);
  const ins = m.attendance.filter((a) => a.status === 'in').length;
  const pct = Math.min(100, Math.round((ins / m.capacity) * 100));
  return `
  <div class="fixture">
    <div class="date-box"><div class="mo">${MONTHS[d.getMonth()]}</div><div class="d">${d.getDate()}</div><div class="wd">${DAYS[d.getDay()]}</div></div>
    <div class="info">
      <div class="time">${fmtTime(m.starts_at)} <span class="tag ${m.status}">${m.status}</span></div>
      <div class="where">${esc(m.location || 'Location TBA')}</div>
      <div class="where">${m.team_size} v ${m.team_size} · <span class="chip-team A"></span> ${esc(m.team_a_name)} vs <span class="chip-team B"></span> ${esc(m.team_b_name)}</div>
    </div>
    <div class="counter"><div class="n">${ins}/${m.capacity}</div><div class="l">Players in</div></div>
  </div>
  <div class="meter"><i class="${ins >= m.capacity ? 'full' : ''}" style="width:${pct}%"></i></div>
  ${m.notes ? `<div class="notes">${esc(m.notes)}</div>` : ''}`;
}

function squadRows(m) {
  const byPid = Object.fromEntries(m.attendance.map((a) => [a.player_id, a]));
  const ins = m.attendance.filter((a) => a.status === 'in' && !a.reserve);
  const res = m.attendance.filter((a) => a.reserve);
  const outs = m.attendance.filter((a) => a.status === 'out');
  const none = S.players.filter((p) => p.active && !p.is_guest && !byPid[p.id]);
  const admin = S.me.is_admin;
  const row = (pid, st, i) => {
    const p = S.pmap[pid]; if (!p) return '';
    const icon = st === 'in' ? '<span class="st in">IN</span>' : st === 'res' ? '<span class="st res">RES</span>' : st === 'out' ? '<span class="st out">OUT</span>' : '<span class="st none">???</span>';
    const cur = st === 'res' ? 'in' : st;
    const ctl = admin && !p.is_guest ? `<select class="admin-status" data-pid="${pid}">
        <option value="none" ${cur === 'none' ? 'selected' : ''}>–</option><option value="in" ${cur === 'in' ? 'selected' : ''}>In</option><option value="out" ${cur === 'out' ? 'selected' : ''}>Out</option></select>` : '';
    const a = byPid[pid];
    const paid = st === 'in' || st === 'res' || (a && a.paid)
      ? (admin ? `<button class="paytog ${a.paid ? 'on' : 'off'}" data-paid="${pid}" data-v="${a.paid ? 0 : 1}">${a.paid ? 'PAID' : 'PAID?'}</button>`
        : a.paid ? '<span class="g">PAID</span>' : '') : '';
    return `<tr class="${pid === S.me.id ? 'sel' : ''}"><td class="num dim">${i ?? ''}</td><td>${icon}</td><td class="name"><a class="plink" href="#/player/${pid}">${esc(p.name)}</a>${p.is_guest ? ` <span class="tag guest">GUEST</span>${a?.invited_by ? ` <span class="dim">+${esc(pname(a.invited_by))}</span>` : ''}${admin || a?.invited_by === S.me.id ? ` <button class="x" data-rmguest="${pid}" title="Remove guest">✕</button>` : ''}` : ''}</td><td class="hide-sm">${posBadge(p.position)}</td><td class="hide-sm">${stars(p.rating)}</td><td>${paid}</td><td class="num">${ctl}</td></tr>`;
  };
  const div = (t, n) => `<tr class="divider"><td colspan="7">${t} (${n})</td></tr>`;
  return `
  ${div('Playing', ins.length)}${ins.map((a, i) => row(a.player_id, 'in', i + 1)).join('') || '<tr><td colspan="7" class="muted">Nobody yet — be the first!</td></tr>'}
  ${res.length ? div('Reserves (waiting list)', res.length) + res.map((a, i) => row(a.player_id, 'res', i + 1)).join('') : ''}
  ${div('Not coming', outs.length)}${outs.map((a) => row(a.player_id, 'out')).join('')}
  ${none.length ? div('No reply', none.length) + none.map((p) => row(p.id, 'none')).join('') : ''}`;
}

async function viewMatch(id) {
  const v = mount('match');
  await Promise.all([loadPlayers(), loadMatches()]);
  id = id || S.nextId;
  if (!id) {
    v.innerHTML = `<div class="panel"><div class="panel-h">Next Match</div><div class="empty-state"><div class="ico">NO MATCH</div>
      <p>No match scheduled yet.</p>${S.me.is_admin ? '<a class="btn primary" href="#/admin/matches/new">Schedule a match</a>' : '<p>Ask an admin to create one.</p>'}</div></div>`;
    return;
  }
  const { match: m } = await api('GET', `/api/matches/${id}`);
  const render = (m) => {
    const mine = m.attendance.find((a) => a.player_id === S.me.id);
    const open = m.status === 'upcoming';
    const played = m.status === 'played' && m.score_a != null;
    v.innerHTML = `
    <div class="grid2">
      <div>
        <div class="panel"><div class="panel-h">${id === S.nextId ? 'Next Match' : 'Match'}<span class="spacer"></span>
          ${S.me.is_admin ? `<button class="btn sm" id="share">Share to WhatsApp</button> <a class="btn sm" href="#/admin/matches/${m.id}">Edit</a>` : ''}</div>
          <div class="panel-b">
            ${fixtureHeader(m)}
            ${played ? `<div class="scoreline">${esc(m.team_a_name)} ${m.score_a} – ${m.score_b} ${esc(m.team_b_name)}<small>Full time</small></div>` : ''}
            ${open ? `
              <div class="big-choice">
                <button class="btn in ${m.my_status === 'in' ? 'chosen' : m.my_status ? 'idle' : ''}" data-st="in">IN</button>
                <button class="btn out ${m.my_status === 'out' ? 'chosen' : m.my_status ? 'idle' : ''}" data-st="out">OUT</button>
              </div>
              <div class="muted" style="text-align:center">${
                !mine ? 'You haven\'t replied yet.' : mine.reserve ? '<span class="y">WAITING LIST</span> — you\'ll move up if someone drops out.' :
                mine.status === 'in' ? '<span class="g flash">YOU\'RE IN.</span> See you on the pitch!' : 'You\'re marked as not coming.'}</div>` : ''}
          </div>
        </div>
        ${m.goals.length || played ? `<div class="panel"><div class="panel-h">${played ? 'Result' : 'Goals'}<span class="spacer"></span>${played ? '<button class="btn sm" id="report">Share report</button>' : ''}</div><div class="panel-b">${m.goals.length ? scorersHtml(m) : '<span class="dim">No goals were recorded live.</span>'}${pointsHtml(m)}</div></div>` : ''}
        ${m.motm ? motmHtml(m) : ''}
        <div class="panel"><div class="panel-h">Teams</div><div class="panel-b">
          ${m.lineup_published ? `<div class="btn-row"><a class="btn" href="#/tactics/${m.id}">View line-up ›</a>
              ${m.status !== 'cancelled' ? `<a class="btn ${m.status === 'upcoming' ? 'danger live-btn' : 'ghost'}" href="#/live/${m.id}">${m.status === 'upcoming' ? '● Live score' : 'Edit goals'}</a>` : ''}</div>`
            : S.me.is_admin ? `<p class="muted">Teams not published yet.</p><a class="btn primary" href="#/tactics/${m.id}">Pick teams ›</a>`
            : '<p class="muted">The manager hasn\'t announced the teams yet.</p>'}
        </div></div>
      </div>
      <div class="panel"><div class="panel-h">Squad<span class="spacer"></span>${open || S.me.is_admin ? '<button class="btn sm" id="addguest">+ Guest</button>' : ''}<span class="sub">${S.me.is_admin && m.attendance.some((a) => a.status === 'in')
          ? `${m.attendance.filter((a) => a.status === 'in' && a.paid).length}/${m.attendance.filter((a) => a.status === 'in').length} paid` : 'first come, first served'}</span></div>
        <div class="table-wrap"><table class="fm"><thead><tr><th class="num">#</th><th></th><th>Name</th><th class="hide-sm">Pos</th><th class="hide-sm">Ability</th><th>Paid</th><th></th></tr></thead>
        <tbody>${squadRows(m)}</tbody></table></div>
      </div>
    </div>`;
    $$('[data-st]', v).forEach((b) => (b.onclick = async () => {
      const st = b.dataset.st === m.my_status ? 'none' : b.dataset.st;
      try { const r = await api('POST', `/api/matches/${m.id}/attendance`, { status: st }); render(r.match); } catch (e) { fail(e); }
    }));
    $$('.admin-status', v).forEach((s) => (s.onchange = async () => {
      try { const r = await api('POST', `/api/matches/${m.id}/attendance`, { status: s.value, player_id: Number(s.dataset.pid) }); render(r.match); toast('Updated'); } catch (e) { fail(e); }
    }));
    $$('[data-paid]', v).forEach((b) => (b.onclick = async () => {
      try { const r = await api('POST', `/api/matches/${m.id}/paid`, { player_id: Number(b.dataset.paid), paid: b.dataset.v === '1' }); render(r.match); } catch (e) { fail(e); }
    }));
    $$('[data-vote]', v).forEach((b) => (b.onclick = async () => {
      try { const r = await api('POST', `/api/matches/${m.id}/motm`, { player_id: Number(b.dataset.vote) }); render(r.match); toast('Vote saved'); } catch (e) { fail(e); }
    }));
    $$('[data-rmguest]', v).forEach((b) => (b.onclick = async () => {
      const g = S.pmap[b.dataset.rmguest];
      if (!confirm(`Remove guest ${g?.name} from this match?`)) return;
      try { const r = await api('DELETE', `/api/matches/${m.id}/guests/${b.dataset.rmguest}`); render(r.match); toast('Guest removed'); } catch (e) { fail(e); }
    }));
    const ag = $('#addguest', v);
    if (ag) ag.onclick = () => guestForm(m, async (fresh) => { await loadPlayers(); render(fresh); });
    const rp = $('#report', v);
    if (rp) rp.onclick = () => shareReport(m);
    const sh = $('#share', v);
    if (sh) sh.onclick = () => shareMatch(m);
  };
  render(m);
}

// ---------- points earned in a match ----------
function pointsHtml(m) {
  const e = Object.entries(m.points || {}).filter(([pid]) => S.pmap[pid]).sort((a, b) => b[1].pts - a[1].pts);
  if (!e.length) return '';
  return `<div class="c" style="margin-top:10px">POINTS THIS MATCH</div><div class="mpts">${e.map(([pid, x]) => {
    const team = m.lineup.find((l) => l.player_id === Number(pid))?.team;
    return `<a class="plink" href="#/player/${pid}"><span class="chip-team ${team}"></span> ${esc(shortName(S.pmap[pid].name).toUpperCase())}${x.gk ? ' 🧤' : ''}
      <b class="${x.pts >= 0 ? 'y' : 'r'}">${x.pts > 0 ? '+' : ''}${fmtPts(x.pts)}</b></a>`;
  }).join('')}</div>`;
}

// ---------- goals / motm helpers ----------
const pname = (id) => (id && S.pmap[id] ? shortName(S.pmap[id].name) : '?');
function goalTally(m) {
  const g = {}, a = {};
  for (const x of m.goals) {
    if (!x.own_goal && x.scorer_id) g[x.scorer_id] = (g[x.scorer_id] || 0) + 1;
    if (x.assist_id) a[x.assist_id] = (a[x.assist_id] || 0) + 1;
  }
  return { g, a };
}
function scorersHtml(m) {
  const side = (team) => {
    const list = [];
    const seen = {};
    for (const x of m.goals.filter((x) => x.team === team)) {
      const key = x.own_goal ? `og${x.scorer_id}` : x.scorer_id;
      if (seen[key]) { seen[key].n++; continue; }
      seen[key] = { n: 1, name: pname(x.scorer_id) + (x.own_goal ? ' (OG)' : '') }; list.push(seen[key]);
    }
    return list.map((s) => `${esc(s.name.toUpperCase())}${s.n > 1 ? ' ' + s.n : ''}`).join(', ') || '<span class="dim">—</span>';
  };
  return `<div class="scorers"><div><span class="chip-team A"></span> <b class="y">${m.score_a ?? 0}</b> ${side('A')}</div>
    <div><span class="chip-team B"></span> <b class="y">${m.score_b ?? 0}</b> ${side('B')}</div></div>`;
}
function motmHtml(m) {
  const mo = m.motm;
  const played = [...new Set(m.lineup.map((l) => l.player_id))];
  const { g, a } = goalTally(m);
  const badge = (pid) => `${'⚽'.repeat(g[pid] || 0)}${' A'.repeat(a[pid] || 0)}`;
  const closes = new Date(mo.closes_at);
  if (!mo.open) {
    if (!mo.winners.length) return `<div class="panel"><div class="panel-h">Man of the match</div><div class="panel-b muted">No votes were cast.</div></div>`;
    const ranked = Object.entries(mo.counts).sort((x, y) => y[1] - x[1]).slice(0, 5);
    return `<div class="panel"><div class="panel-h" style="background:var(--ma);color:#fff">★ Man of the match</div><div class="panel-b">
      <div class="motm-win flash-once">${mo.winners.map((w) => esc((S.pmap[w]?.name || '?').toUpperCase())).join(' &amp; ')}</div>
      <table class="fm"><tbody>${ranked.map(([pid, n]) => `<tr><td class="name">${esc(S.pmap[pid]?.name || '?')}</td><td class="num y">${n} vote${n > 1 ? 's' : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
  }
  return `<div class="panel"><div class="panel-h" style="background:var(--ma);color:#fff">★ Vote: man of the match</div><div class="panel-b">
    <p class="muted" style="margin-top:0">${mo.can_vote ? 'You played — pick one (not yourself).' : 'Only players who played can vote.'}
    Closes ${DAYS[closes.getDay()]} ${fmtTime(closes.toISOString())}. <span class="y">${mo.votes}/${mo.voters} voted</span></p>
    ${mo.can_vote ? played.filter((pid) => pid !== S.me.id && S.pmap[pid]).map((pid) =>
      `<button class="pbtn ${mo.my_vote === pid ? 'me' : ''}" data-vote="${pid}">${esc(S.pmap[pid].name)}<span class="g">${badge(pid)}${mo.my_vote === pid ? ' ✓ YOUR VOTE' : ''}</span></button>`).join('') : ''}
  </div></div>`;
}

// ---------- live scoring ----------
let livePoll = null;
async function viewLive(id) {
  const v = mount('match');
  await loadPlayers();
  let m = (await api('GET', `/api/matches/${id}`)).match;
  let sheet = null; // { scorer, team, goalId? }
  let busy = false;

  const minute = (iso) => {
    if (!m.kicked_off_at) return '';
    const d = Math.floor((new Date(iso) - new Date(m.kicked_off_at)) / 60000) + 1;
    return d > 0 && d < 200 ? d + "'" : '';
  };
  const teamList = (team) => m.lineup.filter((l) => l.team === team).sort((x, y) => x.slot - y.slot).map((l) => l.player_id).filter((pid) => S.pmap[pid]);

  const draw = () => {
    if (!m.lineup_published || !m.lineup.length) {
      v.innerHTML = `<div class="panel"><div class="panel-h">Live score</div><div class="empty-state"><div class="ico">NO TEAMS</div>
        <p>Teams have to be published before the match can be scored.</p><a class="btn" href="#/match/${m.id}">‹ Back</a></div></div>`;
      return;
    }
    const { g, a } = goalTally(m);
    const ended = m.status === 'played';
    const elapsed = m.kicked_off_at ? Math.max(0, Math.floor((Date.now() - new Date(m.kicked_off_at)) / 60000)) : null;
    const col = (team) => `<div class="${team}"><h5>${esc(team === 'A' ? m.team_a_name : m.team_b_name)}</h5>
      ${teamList(team).map((pid) => `<button class="pbtn ${sheet && sheet.scorer === pid ? 'hot' : ''}" data-scorer="${pid}" data-team="${team}">
        <span class="pn">${esc(shortName(S.pmap[pid].name))}</span><span class="g">${'⚽'.repeat(g[pid] || 0)}${' A'.repeat(a[pid] || 0)}</span></button>`).join('')}</div>`;
    const feed = [...m.goals].reverse().map((x) => `<div class="fi" data-goal="${x.id}">
        <span class="min">${minute(x.created_at)}</span><span class="chip-team ${x.team}"></span>
        <span class="what">${esc(pname(x.scorer_id).toUpperCase())}${x.own_goal ? ' <span class="r">OG</span>' : ''}${x.assist_id ? ` <span class="c">(${esc(pname(x.assist_id))})</span>` : ''}</span>
        <span class="by dim">by ${esc(pname(x.created_by))}</span><button class="x" data-del="${x.id}" title="Undo">✕</button></div>`).join('');

    let sheetHtml = '';
    if (sheet) {
      const mates = teamList(sheet.team).filter((pid) => pid !== sheet.scorer);
      const editing = sheet.goalId != null;
      sheetHtml = `<div class="sheet-bg"></div><div class="sheet">
        <h4>${editing ? 'Change assist for' : '⚽'} ${esc(pname(sheet.scorer).toUpperCase())}${editing ? '' : ' scores!'} ${editing ? '' : 'Assist?'}</h4>
        <div class="grid">${mates.map((pid) => `<button class="btn" data-assist="${pid}">${esc(shortName(S.pmap[pid].name))}</button>`).join('')}
          <button class="btn ghost" data-assist="">No assist</button></div>
        <div class="sheet-foot">${editing ? '' : `<button class="btn sm danger" id="og">Own goal</button>`}<span class="spacer"></span><button class="btn sm ghost" id="cancel">Cancel</button></div>
      </div>`;
    }

    v.innerHTML = `
    <div class="live">
      <div class="panel-h" style="background:${ended ? 'var(--gr)' : 'var(--re)'};color:${ended ? '#000' : '#fff'}">${ended ? 'Full time' : m.kicked_off_at ? '<span class="flash">●</span> Live' : 'Ready'}
        <span class="spacer"></span><span class="sub">${fmtShort(m.starts_at)}</span></div>
      <div class="sb"><div class="t ta">${esc(m.team_a_name)}</div><div class="s">${m.score_a ?? 0}-${m.score_b ?? 0}</div><div class="t tb">${esc(m.team_b_name)}</div></div>
      <div class="clk">${ended ? 'FULL TIME' : elapsed != null ? `${elapsed}' · tap the scorer` : '<button class="btn primary" id="ko">▶ Kick off</button> <span class="dim">starts the clock (keepers earn clean-minute points)</span>'}</div>
      <div class="cols">${col('A')}${col('B')}</div>
      ${m.goals.length ? `<div class="panel-h" style="margin-top:12px">Goals<span class="spacer"></span><span class="sub">tap to fix assist · ✕ to undo</span></div><div class="feed">${feed}</div>` : ''}
      <div class="btn-row" style="margin-top:14px;justify-content:space-between">
        <a class="btn ghost" href="#/match/${m.id}">‹ Match</a>
        ${!ended ? `<button class="btn primary" id="ft">Full time</button>` : ''}
      </div>
    </div>${sheetHtml}`;

    $$('[data-scorer]', v).forEach((b) => (b.onclick = () => { sheet = { scorer: Number(b.dataset.scorer), team: b.dataset.team }; draw(); }));
    $$('[data-del]', v).forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const x = m.goals.find((q) => q.id === Number(b.dataset.del));
      if (!confirm(`Remove goal by ${pname(x?.scorer_id)}?`)) return;
      try { m = (await api('DELETE', `/api/matches/${m.id}/goals/${b.dataset.del}`)).match; toast('Goal removed'); draw(); } catch (err) { fail(err); }
    }));
    $$('[data-goal]', v).forEach((row) => (row.onclick = () => {
      const x = m.goals.find((q) => q.id === Number(row.dataset.goal));
      if (!x || x.own_goal) return;
      sheet = { scorer: x.scorer_id, team: x.team, goalId: x.id }; draw();
    }));
    $$('[data-assist]', v).forEach((b) => (b.onclick = async () => {
      if (busy) return; busy = true;
      const assist = b.dataset.assist ? Number(b.dataset.assist) : null;
      try {
        if (sheet.goalId != null) m = (await api('PUT', `/api/matches/${m.id}/goals/${sheet.goalId}`, { assist_id: assist })).match;
        else { m = (await api('POST', `/api/matches/${m.id}/goals`, { scorer_id: sheet.scorer, assist_id: assist })).match; toast(`GOAL! ${pname(sheet.scorer)}`); }
        sheet = null; draw();
      } catch (err) { fail(err); } finally { busy = false; }
    }));
    const og = $('#og', v);
    if (og) og.onclick = async () => {
      if (busy) return; busy = true;
      try { m = (await api('POST', `/api/matches/${m.id}/goals`, { scorer_id: sheet.scorer, own_goal: true })).match; toast('Own goal'); sheet = null; draw(); }
      catch (err) { fail(err); } finally { busy = false; }
    };
    const cancel = $('#cancel', v); if (cancel) cancel.onclick = () => { sheet = null; draw(); };
    const bg = $('.sheet-bg', v); if (bg) bg.onclick = () => { sheet = null; draw(); };
    const ko = $('#ko', v);
    if (ko) ko.onclick = async () => { try { m = (await api('POST', `/api/matches/${m.id}/kickoff`)).match; toast('Kick off!'); draw(); } catch (err) { fail(err); } };
    const ft = $('#ft', v);
    if (ft) ft.onclick = async () => {
      if (!confirm(`End the match at ${m.score_a ?? 0}-${m.score_b ?? 0}? Man-of-the-match voting opens.`)) return;
      try { m = (await api('POST', `/api/matches/${m.id}/fulltime`)).match; location.hash = `#/match/${m.id}`; } catch (err) { fail(err); }
    };
  };
  draw();

  // keep in sync with other people scoring the same match
  clearInterval(livePoll);
  livePoll = setInterval(async () => {
    if (!location.hash.startsWith(`#/live/${id}`)) { clearInterval(livePoll); return; }
    if (document.hidden || sheet || busy) return;
    try {
      const fresh = (await api('GET', `/api/matches/${id}`)).match;
      if (JSON.stringify(fresh.goals) !== JSON.stringify(m.goals) || fresh.status !== m.status || fresh.kicked_off_at !== m.kicked_off_at) { m = fresh; draw(); }
      else { const c = $('.clk', v); if (c && m.kicked_off_at && m.status !== 'played') c.textContent = `${Math.floor((Date.now() - new Date(m.kicked_off_at)) / 60000)}' · tap the scorer`; }
    } catch {}
  }, 4000);
}

// ---------- guests ----------
async function guestForm(m, done) {
  let guests = [];
  try { guests = (await api('GET', '/api/guests')).guests; } catch {}
  const onList = new Set(m.attendance.map((a) => a.player_id));
  const prev = guests.filter((g) => !onList.has(g.id));
  modal('Add a guest', `
    <p class="muted" style="margin-top:0">A one-off player without a login. They take a spot like anyone else and show as <span class="tag guest">GUEST</span> invited by you.</p>
    ${prev.length ? `<div class="c" style="margin-bottom:4px">PLAYED WITH US BEFORE</div>
      <div class="guest-prev">${prev.map((g) => `<button class="pbtn" data-g="${g.id}"><span class="pn">${esc(g.name)}</span><span class="g">${g.games}× ${esc(g.position)}</span></button>`).join('')}</div>
      <div class="c" style="margin:12px 0 4px">OR SOMEONE NEW</div>` : ''}
    <form id="gf">
      <div class="form-grid">
        <label class="f"><span>Name</span><input type="text" name="name" placeholder="e.g. Marko's colleague Ivan" maxlength="40"></label>
        <label class="f"><span>Position</span><select name="position">${['GK', 'DEF', 'MID', 'FWD'].map((x) => `<option ${x === 'MID' ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="f"><span>How good? (for team balance)</span><select name="rating">${ablOptions(5)}</select></label>
      </div>
      <div class="err" id="gerr"></div>
      <div class="btn-row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Add guest</button></div>
    </form>`, (root, close) => {
    const add = async (body) => {
      try { const r = await api('POST', `/api/matches/${m.id}/guests`, body); close(); toast('Guest added'); done(r.match); }
      catch (err) { $('#gerr', root).textContent = err.message; }
    };
    $$('[data-g]', root).forEach((b) => (b.onclick = () => add({ guest_id: Number(b.dataset.g) })));
    $('#gf', root).onsubmit = (e) => { e.preventDefault(); const f = e.target; add({ name: f.name.value, position: f.position.value, rating: Number(f.rating.value) }); };
  });
}

// ---------- WhatsApp match report ----------
function shareReport(m) {
  const d = dt(m.starts_at);
  const scorers = (team) => {
    const c = {}; const order = [];
    for (const x of m.goals.filter((x) => x.team === team)) {
      const k = (x.own_goal ? 'og' : '') + x.scorer_id;
      if (!c[k]) { c[k] = { n: 0, name: pname(x.scorer_id) + (x.own_goal ? ' (OG)' : '') }; order.push(c[k]); }
      c[k].n++;
    }
    return order.map((s) => s.name + (s.n > 1 ? ' ' + s.n : '')).join(', ');
  };
  const pad = (t, n) => (t + ' '.repeat(n)).slice(0, n);
  const A = m.team_a_name.toUpperCase(), B = m.team_b_name.toUpperCase();
  const lines = [
    '```',
    `P304 FUDBAL TEXT  ${DAYS[d.getDay()].toUpperCase()} ${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()].toUpperCase()}`,
    '================================',
    `${pad(A, 12)} ${String(m.score_a ?? 0).padStart(2)} - ${String(m.score_b ?? 0).padEnd(2)} ${B.slice(0, 12)}`,
    '                  FULL TIME',
    '```',
  ];
  const sa = scorers('A'), sb = scorers('B');
  if (sa) lines.push(`⚪ ${sa}`);
  if (sb) lines.push(`🔴 ${sb}`);
  const mo = m.motm;
  if (mo && !mo.open && mo.winners.length) lines.push(`⭐ MOTM: ${mo.winners.map((w) => S.pmap[w]?.name || '?').join(' & ')}`);
  else if (mo && mo.open) lines.push(`⭐ Man of the match voting is open → ${location.origin}/#/match/${m.id}`);
  lines.push('', `${location.origin}/#/match/${m.id}`);
  window.open(`https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`, '_blank');
}

// ---------- player profile ----------
async function viewProfile(id) {
  const v = mount('stats');
  await loadPlayers();
  const { player: p, totals: t, games, best_mate } = await api('GET', `/api/players/${id}/profile`);
  const form = games.slice(0, 5);
  const chip = (r) => `<span class="res res-${r}">${r}</span>`;
  const tile = (n, l, cls = '') => `<div class="tile"><div class="n ${cls}">${n}</div><div class="l">${l}</div></div>`;
  v.innerHTML = `
  <div class="panel"><div class="panel-h">${esc(p.name)}${p.is_guest ? ' <span class="tag guest" style="color:#000">GUEST</span>' : ''}<span class="spacer"></span><span class="sub">${esc(p.position)}</span></div>
    <div class="panel-b">
      <div class="form-line"><span class="c">FORM</span> ${form.length ? form.map((g) => chip(g.result)).join('') : '<span class="dim">no games yet</span>'}</div>
      <div class="tiles">
        ${tile(fmtPts(t.points), 'Points', 'y')}${tile(t.played ? fmtPts(t.ppg) : '–', 'Pts/game', 'g')}${tile(`<span class="${ablCls(p.rating)}">${p.rating}</span>`, 'Ability')}
        ${tile(t.played, 'Apps')}${tile(t.goals, 'Goals', 'y')}${tile(t.assists, 'Assists', 'c')}${tile(t.motm, 'MOTM ★', 'm')}
        ${tile(t.win_pct + '%', 'Win rate', 'g')}${tile(`${t.won}-${t.drawn}-${t.lost}`, 'W-D-L', 'wdl')}
        ${t.played ? tile(((t.goals) / t.played).toFixed(1), 'Goals/game', 'y') : ''}${p.is_guest ? '' : tile(t.signed_in, 'Sign-ups')}
      </div>
      ${best_mate && S.pmap[best_mate.id] ? `<p class="muted">Best partner: <a class="plink" href="#/player/${best_mate.id}">${esc(S.pmap[best_mate.id].name.toUpperCase())}</a>
        — <span class="g">${best_mate.pct}% wins</span> in ${best_mate.games} games together</p>` : ''}
      ${t.own_goals ? `<p class="r" style="margin:0">Own goals: ${t.own_goals} 🙈</p>` : ''}
    </div>
  </div>
  <div class="panel"><div class="panel-h" style="background:var(--re);color:#fff">Recent matches</div>
    <div class="table-wrap"><table class="fm"><tbody>
    ${games.map((g) => `<tr class="click" data-m="${g.match_id}"><td>${chip(g.result)}</td><td>${fmtShort(g.starts_at)}</td>
      <td class="num y">${g.for}-${g.against}</td><td class="hide-sm dim">${esc(g.team_name)}${g.sub ? ' (sub)' : ''}</td>
      <td>${'⚽'.repeat(g.goals)}${g.assists ? ` <span class="c">${'A'.repeat(g.assists)}</span>` : ''}${g.motm ? ' <span class="m">★</span>' : ''}${g.gk ? ' <span class="c">🧤</span>' : ''}</td><td class="num y">${g.pts > 0 ? '+' : ''}${fmtPts(g.pts)}</td></tr>`).join('')
      || '<tr><td class="muted">No played matches yet.</td></tr>'}
    </tbody></table></div>
  </div>
  <a class="btn ghost" href="#/stats">‹ Table</a>`;
  $$('tr[data-m]', v).forEach((tr) => (tr.onclick = () => (location.hash = `#/match/${tr.dataset.m}`)));
}

function shareMatch(m) {
  const ins = m.attendance.filter((a) => a.status === 'in' && !a.reserve).length;
  const url = `${location.origin}/#/match/${m.id}`;
  const text = `⚽ *Football ${fmtShort(m.starts_at)} at ${fmtTime(m.starts_at)}*\n📍 ${m.location || 'TBA'}\n👥 ${m.team_size}v${m.team_size} — ${ins}/${m.capacity} in\n\nSign up here 👉 ${url}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}
function shareLineup(m, lineup) {
  const team = (t) => lineup.filter((l) => l.team === t).sort((a, b) => a.slot - b.slot)
    .map((l) => `${l.slot >= 100 ? '(sub) ' : l.slot === 0 ? '🧤 ' : ''}${S.pmap[l.player_id]?.name || '?'}`).join('\n');
  const text = `⚽ *Teams for ${fmtShort(m.starts_at)} ${fmtTime(m.starts_at)}*\n\n⚪ *${m.team_a_name}*\n${team('A')}\n\n🔴 *${m.team_b_name}*\n${team('B')}\n\n${location.origin}/#/tactics/${m.id}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}

// ---------- tactics (line-up) ----------
async function viewTactics(id) {
  const v = mount('tactics');
  await Promise.all([loadPlayers(), loadMatches()]);
  id = id || S.nextId;
  if (!id) { v.innerHTML = `<div class="panel"><div class="panel-h">Line-up</div><div class="empty-state"><div class="ico">NO MATCH</div><p>No match scheduled.</p></div></div>`; return; }
  const { match: m } = await api('GET', `/api/matches/${id}`);
  const admin = S.me.is_admin;
  if (!admin && !m.lineup_published) {
    v.innerHTML = `<div class="panel"><div class="panel-h">Line-up · ${fmtShort(m.starts_at)}</div><div class="empty-state"><div class="ico">COMING SOON</div>
      <p>The manager is still picking the teams.<br>Check back closer to kick-off.</p><a class="btn" href="#/match/${m.id}">Back to match</a></div></div>`;
    return;
  }
  const forms = FORMATIONS[m.team_size] || FORMATIONS[6];
  const T = S.tac = {
    m, editable: admin, dirty: false, sel: null,
    fa: forms.includes(m.formation_a) ? m.formation_a : forms[0],
    fb: forms.includes(m.formation_b) ? m.formation_b : forms[0],
    // assignment: key "A:3" -> player_id
    asg: {},
  };
  for (const l of m.lineup) if (l.slot >= 100 || l.slot <= m.team_size - 1) T.asg[`${l.team}:${l.slot}`] = l.player_id;
  renderTactics(v);
}

function tacPool(T) {
  const placed = new Set(Object.values(T.asg));
  const ins = T.m.attendance.filter((a) => a.status === 'in');
  return ins.map((a) => ({ ...a, p: S.pmap[a.player_id] })).filter((a) => a.p).map((a) => ({ ...a, placed: placed.has(a.player_id) }))
    .sort((x, y) => (x.reserve - y.reserve) || POS_ORDER[x.p.position] - POS_ORDER[y.p.position] || y.p.rating - x.p.rating || x.p.name.localeCompare(y.p.name));
}
function teamOf(T, pid) { const k = Object.keys(T.asg).find((k) => T.asg[k] === pid); return k ? k.split(':') : null; }

function renderTactics(v) {
  const T = S.tac, m = T.m, ed = T.editable;
  const forms = FORMATIONS[m.team_size] || FORMATIONS[6];
  const la = slotLayout(T.fa, 'A'), lb = slotLayout(T.fb, 'B');
  const slotHtml = (team, s, bench) => {
    const key = `${team}:${s.slot}`; const pid = T.asg[key]; const p = pid && S.pmap[pid];
    const sel = T.sel && T.sel.key === key;
    const target = ed && T.sel && !sel;
    const style = bench ? '' : `style="left:${s.x}%;top:${s.y}%"`;
    const role = bench ? 'SUB' : s.role;
    return `<div class="slot ${team} ${p ? '' : 'empty'} ${role === 'GK' ? 'gk' : ''} ${sel ? 'sel' : ''} ${target ? 'target' : ''}" data-key="${key}" ${style} ${ed && p ? 'draggable="true"' : ''}>
      <div class="shirt">${p ? esc(initials(p.name)) : role}</div><div class="nm">${p ? esc(shortName(p.name)) : ed ? '+' : ''}</div>
      ${p ? `<div class="pa ${!bench && p.position !== role ? 'oop' : ''}" title="${!bench && p.position !== role ? `Natural ${p.position}, playing ${role}` : ''}"><span class="pos ${p.position}">${p.position}</span><span class="an ${ablCls(p.rating)}">${p.rating}</span></div>` : ''}</div>`;
  };
  const benchSlots = (team) => Array.from({ length: BENCH }, (_, i) => slotHtml(team, { slot: 100 + i }, true)).join('');
  const sum = (team) => Object.entries(T.asg).filter(([k]) => k.startsWith(team + ':')).map(([, pid]) => S.pmap[pid]?.rating || 0);
  const ra = sum('A'), rb = sum('B');
  const tot = ra.reduce((a, b) => a + b, 0), totB = rb.reduce((a, b) => a + b, 0);
  const pool = tacPool(T);
  const selPid = T.sel?.pid;

  v.innerHTML = `
  <div class="panel"><div class="panel-h">Tactics · ${fmtShort(m.starts_at)} ${fmtTime(m.starts_at)}<span class="spacer"></span>
    <span class="sub">${m.team_size} v ${m.team_size}${ed ? (m.lineup_published ? ' · <b class="g">Published</b>' : ' · Draft (only admins see it)') : ''}</span></div>
    ${ed ? `<div class="panel-b btn-row" style="justify-content:space-between">
      <div class="btn-row">
        <button class="btn" id="auto" title="Split the IN players into two balanced teams by ability">⚖ Auto-balance</button>
        <button class="btn ghost" id="clear">Clear</button>
      </div>
      <div class="btn-row">
        <button class="btn" id="save">Save draft</button>
        <button class="btn primary" id="publish">${m.lineup_published ? 'Update & publish' : 'Publish teams'}</button>
        ${m.lineup_published ? '<button class="btn ghost" id="unpub">Unpublish</button>' : ''}
        ${m.lineup.length ? '<button class="btn" id="wa">Share</button>' : ''}
      </div></div>` : ''}
  </div>
  <div class="tactics">
    <div class="panel">
      ${ed ? `<div class="hint">${T.sel ? `<b>${esc(S.pmap[selPid]?.name)}</b> selected — tap a position to place ${T.sel.key ? '(or swap)' : ''}, or tap again to cancel.${T.sel.key ? ' <button class="btn sm danger" id="unassign">Remove</button>' : ''}`
        : 'Tap a player in the list, then tap a position on the pitch. Drag &amp; drop works on desktop. <span class="oop-key">DEF</span> = out of position.'}</div>` : ''}
      <div class="panel-b fm-select" style="justify-content:space-between">
        <span><span class="chip-team B"></span> <b>${esc(m.team_b_name)}</b></span>
        ${ed ? `<select id="fb">${forms.map((f) => `<option ${f === T.fb ? 'selected' : ''}>${f}</option>`).join('')}</select>` : `<span class="muted">${esc(T.fb)}</span>`}
      </div>
      <div class="pitch-wrap"><div class="pitch ${ed ? 'editable' : ''}" id="pitch">
        <div class="mk half"></div><div class="mk circle"></div><div class="mk spot"></div>
        <div class="mk box-t"></div><div class="mk six-t"></div><div class="mk box-b"></div><div class="mk six-b"></div>
        ${lb.map((s) => slotHtml('B', s)).join('')}${la.map((s) => slotHtml('A', s)).join('')}
      </div></div>
      <div class="panel-b fm-select" style="justify-content:space-between">
        <span><span class="chip-team A"></span> <b>${esc(m.team_a_name)}</b></span>
        ${ed ? `<select id="fa">${forms.map((f) => `<option ${f === T.fa ? 'selected' : ''}>${f}</option>`).join('')}</select>` : `<span class="muted">${esc(T.fa)}</span>`}
      </div>
      <div class="bench">
        <div><h4><span class="chip-team A"></span> ${esc(m.team_a_name)} subs</h4><div class="slots">${benchSlots('A')}</div></div>
        <div><h4><span class="chip-team B"></span> ${esc(m.team_b_name)} subs</h4><div class="slots">${benchSlots('B')}</div></div>
      </div>
      <div class="strength">
        <span>${ra.length} · ${tot}</span>
        <div class="bar"><i class="a" style="width:${tot + totB ? (tot / (tot + totB)) * 100 : 50}%"></i><i class="b" style="flex:1"></i></div>
        <span>${totB} · ${rb.length}</span>
      </div>
    </div>
    <div class="side">
      <div class="panel drop-pool" id="pool"><div class="panel-h">Available players<span class="spacer"></span><span class="sub">${pool.filter((a) => !a.placed).length} unassigned</span></div>
        <div class="table-wrap"><table class="fm"><thead><tr><th></th><th>Name</th><th>Pos</th><th>Ability</th><th>Team</th></tr></thead><tbody>
        ${pool.map((a) => {
          const tm = teamOf(T, a.player_id);
          return `<tr class="${ed ? 'click' : ''} ${selPid === a.player_id ? 'sel' : ''} ${a.placed && selPid !== a.player_id ? 'placed' : ''}" data-pid="${a.player_id}" ${ed ? 'draggable="true"' : ''}>
            <td>${a.reserve ? '<span class="st res" title="Reserve">RES</span>' : '<span class="st in">IN</span>'}</td>
            <td class="name">${esc(a.p.name)}</td><td>${posBadge(a.p.position)}</td><td>${stars(a.p.rating)}</td>
            <td>${tm ? `<span class="chip-team ${tm[0]}"></span> ${Number(tm[1]) >= 100 ? '<span class="dim">sub</span>' : ''}` : '<span class="dim">—</span>'}</td></tr>`;
        }).join('') || '<tr><td colspan="5" class="muted">Nobody has signed up yet.</td></tr>'}
        </tbody></table></div>
      </div>
      <a class="btn ghost" href="#/match/${m.id}" style="margin-top:8px">‹ Back to match</a>
    </div>
  </div>`;

  if (!ed) return;
  const rerender = () => renderTactics(v);
  $('#fa').onchange = (e) => { T.fa = e.target.value; T.dirty = true; rerender(); };
  $('#fb').onchange = (e) => { T.fb = e.target.value; T.dirty = true; rerender(); };
  $('#auto').onclick = () => { autoBalance(T); T.sel = null; T.dirty = true; rerender(); };
  $('#clear').onclick = () => { T.asg = {}; T.sel = null; T.dirty = true; rerender(); };
  $('#save').onclick = () => saveLineup(false);
  $('#publish').onclick = () => saveLineup(true);
  const un = $('#unpub'); if (un) un.onclick = () => saveLineup(false, 'Teams hidden from players');
  const wa = $('#wa'); if (wa) wa.onclick = () => shareLineup(m, Object.entries(T.asg).map(([k, pid]) => ({ team: k[0], slot: Number(k.slice(2)), player_id: pid })));
  const ua = $('#unassign'); if (ua) ua.onclick = () => { delete T.asg[T.sel.key]; T.sel = null; T.dirty = true; rerender(); };

  // tap interactions
  $$('#pool tr[data-pid]', v).forEach((tr) => (tr.onclick = () => {
    const pid = Number(tr.dataset.pid);
    if (T.sel && T.sel.pid === pid) T.sel = null;
    else { const k = Object.keys(T.asg).find((k) => T.asg[k] === pid); T.sel = { pid, key: k || null }; }
    rerender();
  }));
  $$('.slot', v).forEach((el) => (el.onclick = () => { slotTap(T, el.dataset.key); rerender(); }));

  // drag & drop (desktop)
  let dragPid = null, dragKey = null;
  $$('[draggable=true]', v).forEach((el) => el.addEventListener('dragstart', (e) => {
    dragKey = el.dataset.key || null; dragPid = dragKey ? T.asg[dragKey] : Number(el.dataset.pid);
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragPid));
  }));
  $$('.slot', v).forEach((el) => {
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault(); if (!dragPid) return;
      if (!dragKey) dragKey = Object.keys(T.asg).find((k) => T.asg[k] === dragPid) || null;
      T.sel = { pid: dragPid, key: dragKey }; slotTap(T, el.dataset.key); dragPid = null; rerender();
    });
  });
  const pool$ = $('#pool');
  pool$.addEventListener('dragover', (e) => { if (dragKey) { e.preventDefault(); pool$.classList.add('over'); } });
  pool$.addEventListener('dragleave', () => pool$.classList.remove('over'));
  pool$.addEventListener('drop', (e) => { e.preventDefault(); if (dragKey) { delete T.asg[dragKey]; T.sel = null; T.dirty = true; rerender(); } });
}

function slotTap(T, key) {
  const occupant = T.asg[key];
  if (!T.sel) { if (occupant) T.sel = { pid: occupant, key }; return; }
  if (T.sel.key === key) { T.sel = null; return; }
  const { pid, key: from } = T.sel;
  // remove the selected player from wherever they are
  if (from) delete T.asg[from];
  else { const k = Object.keys(T.asg).find((k) => T.asg[k] === pid); if (k) delete T.asg[k]; }
  // swap occupant into the old spot (if the selected came from a slot); otherwise occupant goes back to the pool
  if (occupant && from) T.asg[from] = occupant;
  T.asg[key] = pid;
  T.sel = null; T.dirty = true;
}

const POS_ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
// Split the IN players into two teams that are even on ability AND on positions
// (both keepers apart, defenders/midfielders/forwards spread evenly), then place them on the pitch.
function balanceSplit(players) {
  const tot = (t) => t.reduce((x, p) => x + p.rating, 0);
  const cnt = (t, pos) => t.filter((p) => p.position === pos).length;
  const W = { GK: 20, DEF: 4, MID: 3, FWD: 4 }; // how much an uneven split of each position hurts
  const cost = (A, B) => {
    let c = Math.abs(tot(A) - tot(B)) * 1.5 + Math.abs(A.length - B.length) * 50;
    for (const pos of Object.keys(W)) {
      const a = cnt(A, pos), b = cnt(B, pos);
      c += W[pos] * (Math.abs(a - b) - ((a + b) % 2)); // odd numbers can't split evenly — don't punish that
    }
    return c;
  };
  // 1. greedy start: each position group best-first, to the side with fewer of that position / weaker side
  const rnd = new Map(players.map((p) => [p.id, Math.random()]));
  const A = [], B = [];
  for (const pos of ['GK', 'DEF', 'MID', 'FWD']) {
    const grp = players.filter((p) => p.position === pos).sort((x, y) => y.rating - x.rating || rnd.get(x.id) - rnd.get(y.id));
    for (const p of grp) {
      const ca = cnt(A, pos), cb = cnt(B, pos);
      let toA;
      if (ca !== cb) toA = ca < cb;
      else if (A.length !== B.length) toA = A.length < B.length;
      else { const ta = tot(A), tb = tot(B); toA = ta !== tb ? ta < tb : Math.random() < 0.5; }
      (toA ? A : B).push(p);
    }
  }
  // 2. improve by swapping players between the teams while it makes things fairer
  let best = cost(A, B);
  for (let round = 0; round < 60; round++) {
    let move = null;
    for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
      [A[i], B[j]] = [B[j], A[i]];
      const c = cost(A, B);
      if (c < best) { best = c; move = [i, j]; }
      [A[i], B[j]] = [B[j], A[i]];
    }
    if (!move) break;
    [A[move[0]], B[move[1]]] = [B[move[1]], A[move[0]]];
  }
  return [A, B];
}

function autoBalance(T) {
  const players = T.m.attendance.filter((a) => a.status === 'in' && !a.reserve).map((a) => S.pmap[a.player_id]).filter(Boolean);
  const [A, B] = balanceSplit(players);
  // who can cover a role if nobody has that exact position (best fit first)
  const FALLBACK = { GK: ['GK', 'DEF', 'MID', 'FWD'], DEF: ['DEF', 'MID', 'FWD', 'GK'], MID: ['MID', 'DEF', 'FWD', 'GK'], FWD: ['FWD', 'MID', 'DEF', 'GK'] };
  const place = (team, list, formation) => {
    const layout = slotLayout(formation, team);
    const pool = [...list].sort((x, y) => y.rating - x.rating);
    const asg = {};
    // fill the scarcest roles first so specialists land in their own position
    const roles = ['GK', 'DEF', 'MID', 'FWD'].sort((r1, r2) =>
      (pool.filter((p) => p.position === r1).length - layout.filter((s) => s.role === r1).length) -
      (pool.filter((p) => p.position === r2).length - layout.filter((s) => s.role === r2).length));
    const starters = Math.min(layout.length, pool.length);
    let placed = 0;
    for (const role of roles) {
      for (const s of layout.filter((x) => x.role === role)) {
        if (placed >= starters) break;
        let i = -1;
        for (const pos of FALLBACK[role]) { i = pool.findIndex((p) => p.position === pos); if (i >= 0) break; }
        if (i < 0) continue;
        asg[s.slot] = pool.splice(i, 1)[0]; placed++;
      }
    }
    pool.sort((x, y) => POS_ORDER[x.position] - POS_ORDER[y.position]).slice(0, BENCH).forEach((p, i) => (asg[100 + i] = p));
    return asg;
  };
  // pick the formation that puts the most players in their natural position (keep the current one on a tie)
  const forms = FORMATIONS[T.m.team_size] || FORMATIONS[6];
  const oop = (team, list, f) => Object.entries(place(team, list, f)).filter(([slot, p]) => Number(slot) < 100 &&
    p.position !== slotLayout(f, team).find((s) => s.slot === Number(slot)).role).length;
  const bestForm = (team, list, cur) => forms.reduce((best, f) => (oop(team, list, f) < oop(team, list, best) ? f : best), cur);
  T.fa = bestForm('A', A, T.fa); T.fb = bestForm('B', B, T.fb);
  T.asg = {};
  for (const [slot, p] of Object.entries(place('A', A, T.fa))) T.asg[`A:${slot}`] = p.id;
  for (const [slot, p] of Object.entries(place('B', B, T.fb))) T.asg[`B:${slot}`] = p.id;
}

async function saveLineup(publish, msg) {
  const T = S.tac;
  const lineup = Object.entries(T.asg).map(([k, pid]) => ({ team: k[0], slot: Number(k.slice(2)), player_id: pid }));
  try {
    const r = await api('PUT', `/api/matches/${T.m.id}/lineup`, { lineup, formation_a: T.fa, formation_b: T.fb, publish });
    T.m = r.match; T.dirty = false;
    toast(msg || (publish ? 'Teams published — everyone can see them now' : 'Draft saved'));
    renderTactics($('#view'));
  } catch (e) { fail(e); }
}
window.addEventListener('beforeunload', (e) => { if (S.tac?.dirty && location.hash.startsWith('#/tactics')) { e.preventDefault(); e.returnValue = ''; } });

// ---------- fixtures ----------
async function viewFixtures() {
  const v = mount('fixtures');
  await loadMatches();
  const up = S.matches.filter((m) => m.status === 'upcoming').sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const past = S.matches.filter((m) => m.status !== 'upcoming');
  const row = (m) => `<tr class="click" data-id="${m.id}">
    <td>${fmtShort(m.starts_at)} <span class="dim">${fmtTime(m.starts_at)}</span></td>
    <td class="hide-sm">${esc(m.location)}</td><td>${m.team_size}v${m.team_size}</td>
    <td>${m.status === 'played' && m.score_a != null ? `<b>${esc(m.team_a_name)} ${m.score_a}–${m.score_b} ${esc(m.team_b_name)}</b>` : m.status === 'upcoming' ? `${m.in_count} in` : ''}</td>
    <td><span class="tag ${m.status}">${m.status}</span></td></tr>`;
  const table = (list, empty) => `<div class="table-wrap"><table class="fm"><thead><tr><th>Date</th><th class="hide-sm">Venue</th><th>Format</th><th>Result</th><th></th></tr></thead>
    <tbody>${list.map(row).join('') || `<tr><td colspan="5" class="muted">${empty}</td></tr>`}</tbody></table></div>`;
  v.innerHTML = `
    <div class="panel"><div class="panel-h">Upcoming<span class="spacer"></span>${S.me.is_admin ? '<a class="btn sm primary" href="#/admin/matches/new">+ New match</a>' : ''}</div>${table(up, 'Nothing scheduled.')}</div>
    <div class="panel"><div class="panel-h">Results</div>${table(past, 'No matches played yet.')}</div>`;
  $$('tr[data-id]', v).forEach((tr) => (tr.onclick = () => (location.hash = `#/match/${tr.dataset.id}`)));
}

// ---------- stats ----------
let statSort = { key: 'pts', dir: -1 };
async function viewStats() {
  const v = mount('stats');
  const { players, total_played, rules: R } = await api('GET', '/api/stats');
  const rows = players.map((p) => ({ ...p, pct: p.played ? Math.round((p.won / p.played) * 100) : 0, pts: p.points, gd: p.gf - p.ga }));
  // [key, label, numeric, hideOnPhone, cell]
  const cols = [
    ['name', 'Player', 0, 0, (r) => `<td class="name"><a class="plink" href="#/player/${r.id}">${esc(r.name)}</a></td>`],
    ['position', 'Pos', 0, 1, (r) => `<td class="hide-sm">${posBadge(r.position)}</td>`],
    ['rating', 'Abl', 1, 0, (r) => `<td class="num"><b class="${ablCls(r.rating)}">${r.rating}</b></td>`],
    ['played', 'Apps', 1, 0, (r) => `<td class="num">${r.played}</td>`],
    ['won', 'W', 1, 1, (r) => `<td class="num hide-sm">${r.won}</td>`],
    ['drawn', 'D', 1, 1, (r) => `<td class="num hide-sm">${r.drawn}</td>`],
    ['lost', 'L', 1, 1, (r) => `<td class="num hide-sm">${r.lost}</td>`],
    ['goals', 'G', 1, 0, (r) => `<td class="num y">${r.goals}</td>`],
    ['assists', 'A', 1, 0, (r) => `<td class="num c">${r.assists}</td>`],
    ['motm', '★', 1, 0, (r) => `<td class="num m">${r.motm}</td>`],
    ['pct', 'Win %', 1, 1, (r) => `<td class="num hide-sm">${r.played ? r.pct + '%' : '–'}</td>`],
    ['gd', 'GD', 1, 1, (r) => `<td class="num hide-sm">${r.gd > 0 ? '+' : ''}${r.gd}</td>`],
    ['ppg', 'P/G', 1, 1, (r) => `<td class="num hide-sm">${r.played ? fmtPts(r.ppg) : '–'}</td>`],
    ['pts', 'Pts', 1, 0, (r) => `<td class="num pts"><b>${fmtPts(r.pts)}</b></td>`],
    ['signed_in', 'Sign-ups', 1, 1, (r) => `<td class="num hide-sm">${r.signed_in}</td>`],
  ];
  const draw = () => {
    const { key, dir } = statSort;
    rows.sort((a, b) => (typeof a[key] === 'string' ? a[key].localeCompare(b[key]) : a[key] - b[key]) * dir || b.pts - a.pts || a.name.localeCompare(b.name));
    v.innerHTML = `<div class="panel"><div class="panel-h">League table<span class="spacer"></span><span class="sub">${total_played} matches played</span></div>
      <div class="table-wrap"><table class="fm stats"><thead><tr><th class="num">#</th>${cols.map(([k, l, n, h]) =>
        `<th class="sortable ${n ? 'num' : ''} ${h ? 'hide-sm' : ''} ${k === key ? 'sorted' : ''}" data-k="${k}">${l}${k === key ? (dir < 0 ? '▾' : '▴') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${r.id === S.me.id ? 'sel' : ''}"><td class="num dim">${i + 1}</td>${cols.map((c) => c[4](r)).join('')}</tr>`).join('')}
      </tbody></table></div>
      </div>
      <div class="panel"><div class="panel-h" style="background:var(--ma);color:#fff">How points work</div><div class="panel-b rules">
        <div class="rgrid">
          <span>Win</span><b class="g">+${R.win}</b><span>Draw</span><b class="y">+${R.draw}</b><span>Loss</span><b>${R.loss >= 0 ? '+' : ''}${R.loss}</b>
          <span>Goal</span><b class="g">+${R.goal}</b><span>Assist</span><b class="g">+${R.assist}</b><span>Own goal</span><b class="r">${R.own_goal}</b>
          <span>Man of the match</span><b class="m">+${R.motm}</b>
        </div>
        <div class="c" style="margin-top:8px">GOALKEEPER (whoever starts in goal)</div>
        <div class="rgrid">
          <span>Every ${R.gk_block_minutes} min without conceding</span><b class="g">+${R.gk_clean_block}</b>
          <span>Every goal conceded</span><b class="r">${R.gk_conceded}</b>
        </div>
        <p class="dim" style="margin:8px 0 0;font-size:17px">Clean minutes are counted from ▶ Kick off to full time, only when goals were recorded live. Abl = ability (0–10). P/G = points per game. ★ = man-of-the-match wins.</p>
        ${S.me.is_admin ? '<a class="btn sm" href="#/admin/settings" style="margin-top:8px">Change rules</a>' : ''}
      </div></div>`;
    $$('th[data-k]', v).forEach((th) => (th.onclick = () => {
      statSort = { key: th.dataset.k, dir: statSort.key === th.dataset.k ? -statSort.dir : (th.dataset.k === 'name' || th.dataset.k === 'position' ? 1 : -1) }; draw();
    }));
  };
  draw();
}

// ---------- admin ----------
async function viewAdmin(sub, arg) {
  const v = mount('admin');
  const subs = [['squad', 'Squad'], ['matches', 'Matches'], ['settings', 'Settings']];
  v.innerHTML = `<div class="subtabs">${subs.map(([k, l]) => `<a class="btn sm ${k === sub ? 'active' : ''}" href="#/admin/${k}">${l}</a>`).join('')}</div><div id="adm"></div>`;
  const el = $('#adm');
  if (sub === 'squad') return adminSquad(el);
  if (sub === 'matches') return adminMatches(el, arg);
  if (sub === 'settings') return adminSettings(el);
}

async function adminSquad(el) {
  await loadPlayers();
  const all = [...S.players].sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));
  const list = all.filter((p) => !p.is_guest), guests = all.filter((p) => p.is_guest);
  el.innerHTML = `
  <div class="panel"><div class="panel-h">Squad<span class="spacer"></span><span class="sub">${list.filter((p) => p.active).length} active</span>
    <button class="btn sm primary" id="add">+ Add player</button><button class="btn sm" id="bulk">Bulk add</button></div>
    <div class="table-wrap"><table class="fm"><thead><tr><th>Name</th><th class="hide-sm">Phone</th><th>Pos</th><th class="hide-sm">Ability</th><th class="hide-sm"></th></tr></thead><tbody>
    ${list.map((p) => `<tr class="click" data-id="${p.id}" style="${p.active ? '' : 'opacity:.5'}"><td class="name">${esc(p.name)}<div class="show-sm dim sub2">${esc(p.phone)} ${stars(p.rating)} ${p.is_admin ? '<span class="tag admin">ADMIN</span>' + (p.has_pin ? '' : ' <span class="r">NO PIN</span>') : ''}${p.active ? '' : ' <span class="tag">INACTIVE</span>'}</div></td><td class="dim hide-sm">${esc(p.phone)}</td>
      <td>${posBadge(p.position)}</td><td class="hide-sm">${stars(p.rating)}</td><td class="hide-sm">${p.is_admin ? '<span class="tag admin">Admin</span>' + (p.has_pin ? '' : ' <span class="r flash">NO PIN</span>') : ''} ${p.active ? '' : '<span class="tag">Inactive</span>'}</td></tr>`).join('')}
    ${guests.length ? `<tr class="divider"><td colspan="5">Guests (${guests.length})</td></tr>
      ${guests.map((p) => `<tr class="click" data-id="${p.id}"><td class="name">${esc(p.name)} <span class="tag guest">GUEST</span></td><td class="dim hide-sm">—</td><td>${posBadge(p.position)}</td><td class="hide-sm">${stars(p.rating)}</td><td class="hide-sm"></td></tr>`).join('')}` : ''}
    </tbody></table></div>
    <div class="panel-b muted" style="font-size:18px">Only phone numbers on this list can log in. Ability drives Auto-balance. Tap a guest to rename them, or add their number to make them a member.</div>
  </div>`;
  $('#add').onclick = () => playerForm(null, () => adminSquad(el));
  $('#bulk').onclick = () => bulkForm(() => adminSquad(el));
  $$('tr[data-id]', el).forEach((tr) => (tr.onclick = () => playerForm(S.pmap[tr.dataset.id], () => adminSquad(el))));
}

function modal(title, bodyHtml, onMount) {
  const md = $('#modal');
  md.innerHTML = `<div class="panel"><div class="panel-h">${esc(title)}<span class="spacer"></span><button class="btn sm ghost" data-close>✕</button></div><div class="panel-b">${bodyHtml}</div></div>`;
  md.hidden = false;
  const close = () => { md.hidden = true; md.innerHTML = ''; };
  md.onclick = (e) => { if (e.target === md || e.target.closest('[data-close]')) close(); };
  onMount($('.panel', md), close);
}

function playerForm(p, done) {
  const isNew = !p; p = p || { name: '', phone: '', position: 'MID', rating: 5, is_admin: false, active: true };
  const guest = !!p.is_guest;
  modal(isNew ? 'New player' : `Edit ${p.name}`, `
    <form id="pf">
      <div class="form-grid">
        <label class="f"><span>Name</span><input type="text" name="name" value="${esc(p.name)}" required></label>
        <label class="f"><span>Phone (WhatsApp)</span><input type="tel" name="phone" value="${esc(guest ? '' : p.phone)}" ${guest ? '' : 'required'} placeholder="${guest ? 'add to make them a member' : '+381641234567'}"></label>
        <label class="f"><span>Position</span><select name="position">${['GK', 'DEF', 'MID', 'FWD'].map((x) => `<option ${x === p.position ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="f"><span>Ability (0–10)</span><select name="rating">${ablOptions(p.rating)}</select></label>
      </div>
      <div ${guest ? 'hidden' : ''}>
      <label class="check"><input type="checkbox" name="is_admin" ${p.is_admin ? 'checked' : ''}> Admin (can create matches &amp; pick teams)</label>
      <label class="f" id="pinf" ${p.is_admin ? '' : 'hidden'}><span class="m">Admin PIN ${p.has_pin ? '(set — type to change)' : '(required for admin rights)'}</span>
        <input type="password" name="pin" inputmode="numeric" autocomplete="new-password" placeholder="4–8 digits"></label>
      <label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Active (can log in, shows in squad)</label>
      </div>
      <div class="err" id="perr"></div>
      <div class="btn-row" style="justify-content:space-between">
        ${isNew ? '<span></span>' : '<button type="button" class="btn danger" id="pdel">Delete</button>'}
        <div class="btn-row"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div>
      </div>
    </form>`, (root, close) => {
    const f = $('#pf', root);
    f.is_admin.onchange = () => { $('#pinf', root).hidden = !f.is_admin.checked; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: f.name.value, phone: f.phone.value, position: f.position.value, rating: Number(f.rating.value), is_admin: f.is_admin.checked, active: f.active.checked, pin: f.pin.value };
      if (guest && !f.phone.value.trim()) { delete body.phone; delete body.is_admin; delete body.active; delete body.pin; }
      try { isNew ? await api('POST', '/api/players', body) : await api('PUT', `/api/players/${p.id}`, body); close(); toast('Saved'); done(); }
      catch (err) { $('#perr', root).textContent = err.message; }
    };
    const del = $('#pdel', root);
    if (del) del.onclick = async () => {
      if (!confirm(`Delete ${p.name} for good? Their history and stats are removed too. (Tip: untick "Active" instead to keep stats.)`)) return;
      try { await api('DELETE', `/api/players/${p.id}`); close(); toast('Deleted'); done(); } catch (err) { $('#perr', root).textContent = err.message; }
    };
  });
}

function bulkForm(done) {
  modal('Bulk add players', `
    <p class="muted" style="margin-top:0">One player per line: <b>Name, phone</b> — optionally <b>, position, ability</b>.<br>
    e.g. <code>Marko Petrović, +381641234567, DEF, 7</code> (ability 0–10)</p>
    <textarea id="bt" rows="10" placeholder="Marko Petrović, +381641234567&#10;Nikola, 0631234567, GK"></textarea>
    <div class="err" id="berr"></div>
    <div class="btn-row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="bgo">Add all</button></div>`,
  (root, close) => {
    $('#bgo', root).onclick = async () => {
      const lines = $('#bt', root).value.split('\n').map((l) => l.trim()).filter(Boolean);
      let ok = 0; const errs = [];
      for (const line of lines) {
        const [name, phone, position, rating] = line.split(/[,;\t]/).map((s) => s.trim());
        try { await api('POST', '/api/players', { name, phone, position: position || 'MID', rating: rating !== undefined && rating !== '' && !isNaN(rating) ? Number(rating) : 5 }); ok++; }
        catch (e) { errs.push(`${name || line}: ${e.message}`); }
      }
      toast(`Added ${ok} player${ok === 1 ? '' : 's'}`);
      if (errs.length) $('#berr', root).innerHTML = errs.map(esc).join('<br>'); else close();
      done();
    };
  });
}

async function adminMatches(el, arg) {
  await loadMatches();
  el.innerHTML = `
  <div class="panel"><div class="panel-h">Matches<span class="spacer"></span><button class="btn sm primary" id="new">+ New match</button></div>
    <div class="table-wrap"><table class="fm"><thead><tr><th>Date</th><th class="hide-sm">Venue</th><th>Format</th><th>In</th><th>Score</th><th></th></tr></thead><tbody>
    ${S.matches.map((m) => `<tr class="click" data-id="${m.id}"><td>${fmtShort(m.starts_at)} <span class="dim">${fmtTime(m.starts_at)}</span></td><td class="hide-sm">${esc(m.location)}</td>
      <td>${m.team_size}v${m.team_size}</td><td>${m.in_count}</td><td>${m.score_a != null ? `${m.score_a}–${m.score_b}` : ''}</td><td><span class="tag ${m.status}">${m.status}</span></td></tr>`).join('')
      || '<tr><td colspan="6" class="muted">No matches yet.</td></tr>'}
    </tbody></table></div></div>`;
  const refresh = () => adminMatches(el);
  $('#new').onclick = () => matchForm(null, refresh);
  $$('tr[data-id]', el).forEach((tr) => (tr.onclick = () => matchForm(S.matches.find((m) => m.id === Number(tr.dataset.id)), refresh)));
  if (arg === 'new') { history.replaceState(null, '', '#/admin/matches'); matchForm(null, refresh); }
  else if (arg) { history.replaceState(null, '', '#/admin/matches'); const m = S.matches.find((m) => m.id === Number(arg)); if (m) matchForm(m, refresh); }
}

function defaultKickoff() {
  // copy the last match's weekday/time one week later, otherwise next day at 20:00
  const last = [...S.matches].sort((a, b) => b.starts_at.localeCompare(a.starts_at))[0];
  let d;
  if (last) { d = dt(last.starts_at); while (d < new Date()) d.setDate(d.getDate() + 7); }
  else { d = new Date(); d.setDate(d.getDate() + 1); d.setHours(20, 0, 0, 0); }
  const p = (n) => String(n).padStart(2, '0');
  return { at: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`, last };
}

function matchForm(m, done) {
  const isNew = !m;
  if (isNew) { const { at, last } = defaultKickoff(); m = { starts_at: at, location: last?.location || '', team_size: last?.team_size || 6, team_a_name: last?.team_a_name || 'Whites', team_b_name: last?.team_b_name || 'Colours', notes: '', status: 'upcoming', score_a: null, score_b: null }; }
  modal(isNew ? 'Schedule match' : 'Edit match', `
    <form id="mf">
      <div class="form-grid">
        <label class="f"><span>Kick-off</span><input type="datetime-local" name="starts_at" value="${esc(m.starts_at)}" required></label>
        <label class="f"><span>Players per side</span><select name="team_size">${[3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `<option value="${n}" ${n === m.team_size ? 'selected' : ''}>${n} v ${n}</option>`).join('')}</select></label>
      </div>
      <label class="f"><span>Venue</span><input type="text" name="location" value="${esc(m.location)}" placeholder="e.g. SC Tašmajdan, pitch 2"></label>
      <div class="form-grid">
        <label class="f"><span>Team A (white)</span><input type="text" name="team_a_name" value="${esc(m.team_a_name)}"></label>
        <label class="f"><span>Team B (red)</span><input type="text" name="team_b_name" value="${esc(m.team_b_name)}"></label>
      </div>
      <label class="f"><span>Notes for players</span><textarea name="notes" rows="2" placeholder="Bring both shirts, 500 din each…">${esc(m.notes)}</textarea></label>
      ${isNew ? '' : `
      <div class="form-grid">
        <label class="f"><span>Status</span><select name="status">${['upcoming', 'played', 'cancelled'].map((s) => `<option ${s === m.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="f"><span>Score ${esc(m.team_a_name)}</span><input type="number" min="0" max="99" name="score_a" value="${m.score_a ?? ''}"></label>
        <label class="f"><span>Score ${esc(m.team_b_name)}</span><input type="number" min="0" max="99" name="score_b" value="${m.score_b ?? ''}"></label>
      </div>
      <p class="muted" style="margin-top:0;font-size:18px">After the game: set status to <b>played</b> and enter the score — it goes into the stats.</p>`}
      <div class="err" id="merr"></div>
      <div class="btn-row" style="justify-content:space-between">
        ${isNew ? '<span></span>' : '<button type="button" class="btn danger" id="mdel">Delete</button>'}
        <div class="btn-row"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${isNew ? 'Create' : 'Save'}</button></div>
      </div>
    </form>`, (root, close) => {
    const f = $('#mf', root);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f)); body.team_size = Number(body.team_size);
      if (body.status === 'played' && (body.score_a === '' || body.score_b === '')) { $('#merr', root).textContent = 'Enter the score for a played match'; return; }
      try {
        if (isNew) { const r = await api('POST', '/api/matches', body); close(); toast('Match scheduled'); location.hash = `#/match/${r.id}`; }
        else { await api('PUT', `/api/matches/${m.id}`, body); close(); toast('Saved'); done(); }
      } catch (err) { $('#merr', root).textContent = err.message; }
    };
    const del = $('#mdel', root);
    if (del) del.onclick = async () => {
      if (!confirm('Delete this match, its sign-ups and line-up?')) return;
      try { await api('DELETE', `/api/matches/${m.id}`); close(); toast('Deleted'); done(); } catch (err) { $('#merr', root).textContent = err.message; }
    };
  });
}

function adminSettings(el) {
  el.innerHTML = `
  <div class="panel"><div class="panel-h">Group password</div><div class="panel-b">
    <p class="muted" style="margin-top:0">Everyone uses this password together with their own phone number. Changing it doesn't log out people who are already signed in.</p>
    <form id="sf" class="btn-row"><input type="text" name="password" placeholder="New group password" style="max-width:260px" required minlength="4"><button class="btn primary">Change</button></form>
  </div></div>
  <div class="panel"><div class="panel-h">Point rules</div><div class="panel-b">
    <p class="muted" style="margin-top:0">Used for the league table. Changing them recalculates every past match too.</p>
    <form id="prf"><div class="form-grid" id="prfields"><span class="dim">Loading…</span></div>
      <div class="btn-row"><button class="btn primary">Save rules</button><button type="button" class="btn ghost" id="prreset">Reset to defaults</button></div></form>
  </div></div>
  <div class="panel"><div class="panel-h">Backup</div><div class="panel-b">
    <p class="muted" style="margin-top:0">Download a copy of everything (players, matches, goals, votes). Keep it somewhere safe — once a month is plenty.</p>
    <a class="btn primary" href="/api/backup" download>Download backup</a>
  </div></div>
  <div class="panel"><div class="panel-h">Admin PIN</div><div class="panel-b">
    <p class="muted" style="margin-top:0">Admins log in with number + group password + their personal PIN. Without the PIN they're a normal player — so a friend who knows your number can't get admin rights.
    Set yours with the <b class="y">ADMIN_PIN</b> variable on Railway, or give other admins a PIN in Squad.</p>
  </div></div>
  <div class="panel"><div class="panel-h">Invite link</div><div class="panel-b">
    <p class="muted" style="margin-top:0">Post this in the WhatsApp group description:</p>
    <div class="btn-row"><input type="text" readonly value="${esc(location.origin)}" style="max-width:320px"><button class="btn" id="cp">Copy</button></div>
  </div></div>`;
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PUT', '/api/settings/password', { password: e.target.password.value }); e.target.reset(); toast('Group password changed'); } catch (err) { fail(err); }
  };
  const LABELS = { win: 'Win', draw: 'Draw', loss: 'Loss', goal: 'Goal', assist: 'Assist', own_goal: 'Own goal', motm: 'Man of the match',
    gk_clean_block: 'GK: clean block', gk_block_minutes: 'GK: block length (min)', gk_conceded: 'GK: per goal conceded', match_minutes: 'Match length if no full time (min)' };
  api('GET', '/api/settings/points').then(({ rules, defaults }) => {
    $('#prfields').innerHTML = Object.keys(defaults).map((k) => `<label class="f"><span>${LABELS[k] || k}</span>
      <input type="number" step="${/minutes/.test(k) ? 1 : 0.05}" name="${k}" value="${rules[k]}"></label>`).join('');
    $('#prreset').onclick = () => { for (const k of Object.keys(defaults)) $('#prf')[k].value = defaults[k]; };
  }).catch(fail);
  $('#prf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PUT', '/api/settings/points', Object.fromEntries(new FormData(e.target))); toast('Point rules saved'); } catch (err) { fail(err); }
  };
  $('#cp').onclick = () => navigator.clipboard?.writeText(location.origin).then(() => toast('Copied'), () => {});
}

// ---------- boot ----------
(async () => {
  try { const { user } = await api('GET', '/api/me'); S.me = user; route(); } catch { renderLogin(); }
})();