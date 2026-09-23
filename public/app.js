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
const stars = (n) => `<span class="stars">${'■'.repeat(n)}<span class="off">${'■'.repeat(5 - n)}</span></span>`;
const posBadge = (p) => `<span class="pos ${esc(p)}">${esc(p)}</span>`;
const initials = (name) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
const shortName = (name) => { const w = name.trim().split(/\s+/); return w.length > 1 ? w[w.length - 1] : name; };

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
  const out = [{ slot: 0, x: 50, y: 93.5, role: 'GK' }];
  let slot = 1;
  const L = lines.length;
  lines.forEach((n, i) => {
    const y = L === 1 ? 72 : 81 - (i * (21 / (L - 1)));
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
    <div class="pageline"><span class="w">P${location.hash.startsWith('#/live') ? 310 : (TABS.find((t) => t.id === active) || TABS[0]).page}</span><span class="c">FUDBAL</span><span class="y clock">${clockText()}</span></div>
    <div class="titleband"><span class="dh">FUDBAL TEXT</span><span class="who"><span class="c">${esc(me.name.toUpperCase())}</span>${me.is_admin ? ' <span class="m">ADMIN</span>' : ''} <button class="linkbtn" id="logout">[EXIT]</button></span></div>
  </header>
  <main id="view"></main>
  <nav class="tabs fastext">${TABS.filter((t) => !t.admin || me.is_admin).map((t) =>
    `<a class="tab k-${t.key} ${t.id === active ? 'active' : ''}" href="#/${t.id}">${t.label}</a>`).join('')}</nav>`;
}
function mount(active) {
  app.innerHTML = shell(active);
  $('#logout').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); S.me = null; location.hash = ''; renderLogin(); };
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
        <div class="err" id="lerr"></div>
        <button class="btn primary" style="width:100%;min-height:48px;font-size:28px">Continue ›</button>
      </form>
    </div></div>
  </div></div>`;
  try { const saved = localStorage.getItem('fm_phone'); if (saved) $('#lf').phone.value = saved; } catch {}
  $('#lf').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; $('#lerr').textContent = '';
    try {
      const { user } = await api('POST', '/api/login', { phone: f.phone.value, password: f.password.value });
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
  const none = S.players.filter((p) => p.active && !byPid[p.id]);
  const admin = S.me.is_admin;
  const row = (pid, st, i) => {
    const p = S.pmap[pid]; if (!p) return '';
    const icon = st === 'in' ? '<span class="st in">IN</span>' : st === 'res' ? '<span class="st res">RES</span>' : st === 'out' ? '<span class="st out">OUT</span>' : '<span class="st none">???</span>';
    const cur = st === 'res' ? 'in' : st;
    const ctl = admin ? `<select class="admin-status" data-pid="${pid}">
        <option value="none" ${cur === 'none' ? 'selected' : ''}>–</option><option value="in" ${cur === 'in' ? 'selected' : ''}>In</option><option value="out" ${cur === 'out' ? 'selected' : ''}>Out</option></select>` : '';
    const a = byPid[pid];
    const paid = st === 'in' || st === 'res' || (a && a.paid)
      ? (admin ? `<button class="paytog ${a.paid ? 'on' : 'off'}" data-paid="${pid}" data-v="${a.paid ? 0 : 1}">${a.paid ? 'PAID' : 'PAID?'}</button>`
        : a.paid ? '<span class="g">PAID</span>' : '') : '';
    return `<tr class="${pid === S.me.id ? 'sel' : ''}"><td class="num dim">${i ?? ''}</td><td>${icon}</td><td class="name">${esc(p.name)}</td><td class="hide-sm">${posBadge(p.position)}</td><td class="hide-sm">${stars(p.rating)}</td><td>${paid}</td><td class="num">${ctl}</td></tr>`;
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
        ${m.goals.length ? `<div class="panel"><div class="panel-h">Goals</div><div class="panel-b">${scorersHtml(m)}</div></div>` : ''}
        ${m.motm ? motmHtml(m) : ''}
        <div class="panel"><div class="panel-h">Teams</div><div class="panel-b">
          ${m.lineup_published ? `<div class="btn-row"><a class="btn" href="#/tactics/${m.id}">View line-up ›</a>
              ${m.status !== 'cancelled' ? `<a class="btn ${m.status === 'upcoming' ? 'danger live-btn' : 'ghost'}" href="#/live/${m.id}">${m.status === 'upcoming' ? '● Live score' : 'Edit goals'}</a>` : ''}</div>`
            : S.me.is_admin ? `<p class="muted">Teams not published yet.</p><a class="btn primary" href="#/tactics/${m.id}">Pick teams ›</a>`
            : '<p class="muted">The manager hasn\'t announced the teams yet.</p>'}
        </div></div>
      </div>
      <div class="panel"><div class="panel-h">Squad<span class="spacer"></span><span class="sub">${S.me.is_admin && m.attendance.some((a) => a.status === 'in')
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
    const sh = $('#share', v);
    if (sh) sh.onclick = () => shareMatch(m);
  };
  render(m);
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
      <div class="clk">${ended ? 'FULL TIME' : elapsed != null ? `${elapsed}' · tap the scorer` : 'Tap a scorer to start the clock'}</div>
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
  return ins.map((a) => ({ ...a, p: S.pmap[a.player_id] })).filter((a) => a.p).map((a) => ({ ...a, placed: placed.has(a.player_id) }));
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
      <div class="shirt">${p ? esc(initials(p.name)) : role}</div><div class="nm">${p ? esc(shortName(p.name)) : ed ? '+' : ''}</div></div>`;
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
        : 'Tap a player in the list, then tap a position on the pitch. Drag &amp; drop works on desktop.'}</div>` : ''}
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
          return `<tr class="${ed ? 'click' : ''} ${selPid === a.player_id ? 'sel' : ''}" data-pid="${a.player_id}" ${ed ? 'draggable="true"' : ''}>
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

function autoBalance(T) {
  const m = T.m;
  const players = T.m.attendance.filter((a) => a.status === 'in' && !a.reserve).map((a) => S.pmap[a.player_id]).filter(Boolean);
  // sort by ability with a random tie-break so repeated clicks give different (but fair) splits
  players.sort((a, b) => b.rating - a.rating || Math.random() - 0.5);
  // keep goalkeepers apart
  const gks = players.filter((p) => p.position === 'GK');
  const rest = players.filter((p) => p.position !== 'GK');
  const A = [], B = []; let sa = 0, sb = 0;
  gks.forEach((p, i) => { if (i % 2 === 0) { A.push(p); sa += p.rating; } else { B.push(p); sb += p.rating; } });
  // greedy: give the next-best player to the weaker side (ties: smaller side)
  for (const p of rest) {
    const toA = A.length < B.length || (A.length === B.length && (sa < sb || (sa === sb && Math.random() < 0.5)));
    if (toA) { A.push(p); sa += p.rating; } else { B.push(p); sb += p.rating; }
  }
  const ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
  const place = (team, list, formation) => {
    const layout = slotLayout(formation, team);
    const starters = [...list];
    const asg = {};
    // fill slots role by role, preferring players whose position matches
    for (const role of ['GK', 'DEF', 'FWD', 'MID']) {
      for (const s of layout.filter((s) => s.role === role)) {
        let i = starters.findIndex((p) => p.position === role);
        if (i < 0) i = role === 'GK' ? starters.length - 1 : starters.findIndex((p) => p.position !== 'GK'); // weakest outfielder in goal if no GK
        if (i < 0) i = 0;
        if (!starters.length) break;
        asg[s.slot] = starters.splice(i, 1)[0];
      }
    }
    starters.sort((a, b) => ORDER[a.position] - ORDER[b.position]).slice(0, BENCH).forEach((p, i) => (asg[100 + i] = p));
    return asg;
  };
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
let statSort = { key: 'played', dir: -1 };
async function viewStats() {
  const v = mount('stats');
  const { players, total_played } = await api('GET', '/api/stats');
  const rows = players.map((p) => ({ ...p, pct: p.played ? Math.round((p.won / p.played) * 100) : 0, pts: p.won * 3 + p.drawn, gd: p.gf - p.ga }));
  // [key, label, numeric, hideOnPhone, cell]
  const cols = [
    ['name', 'Player', 0, 0, (r) => `<td class="name">${esc(r.name)}</td>`],
    ['position', 'Pos', 0, 1, (r) => `<td class="hide-sm">${posBadge(r.position)}</td>`],
    ['played', 'Apps', 1, 0, (r) => `<td class="num">${r.played}</td>`],
    ['won', 'W', 1, 0, (r) => `<td class="num">${r.won}</td>`],
    ['drawn', 'D', 1, 1, (r) => `<td class="num hide-sm">${r.drawn}</td>`],
    ['lost', 'L', 1, 0, (r) => `<td class="num">${r.lost}</td>`],
    ['goals', 'G', 1, 0, (r) => `<td class="num y">${r.goals}</td>`],
    ['assists', 'A', 1, 0, (r) => `<td class="num c">${r.assists}</td>`],
    ['motm', '★', 1, 0, (r) => `<td class="num m">${r.motm}</td>`],
    ['pct', 'Win %', 1, 1, (r) => `<td class="num hide-sm">${r.played ? r.pct + '%' : '–'}</td>`],
    ['gd', 'GD', 1, 1, (r) => `<td class="num hide-sm">${r.gd > 0 ? '+' : ''}${r.gd}</td>`],
    ['pts', 'Pts', 1, 0, (r) => `<td class="num"><b>${r.pts}</b></td>`],
    ['signed_in', 'Sign-ups', 1, 1, (r) => `<td class="num hide-sm">${r.signed_in}</td>`],
  ];
  const draw = () => {
    const { key, dir } = statSort;
    rows.sort((a, b) => (typeof a[key] === 'string' ? a[key].localeCompare(b[key]) : a[key] - b[key]) * dir || b.pts - a.pts || a.name.localeCompare(b.name));
    v.innerHTML = `<div class="panel"><div class="panel-h">Player Stats<span class="spacer"></span><span class="sub">${total_played} matches played</span></div>
      <div class="table-wrap"><table class="fm stats"><thead><tr><th class="num">#</th>${cols.map(([k, l, n, h]) =>
        `<th class="sortable ${n ? 'num' : ''} ${h ? 'hide-sm' : ''} ${k === key ? 'sorted' : ''}" data-k="${k}">${l}${k === key ? (dir < 0 ? '▾' : '▴') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${r.id === S.me.id ? 'sel' : ''}"><td class="num dim">${i + 1}</td>${cols.map((c) => c[4](r)).join('')}</tr>`).join('')}
      </tbody></table></div>
      <div class="panel-b muted" style="font-size:18px">Apps, W/D/L and GD: played matches with a score, for everyone in the line-up (subs included). G/A: goals and assists recorded live. ★: man-of-the-match wins.</div></div>`;
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
  const list = [...S.players].sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));
  el.innerHTML = `
  <div class="panel"><div class="panel-h">Squad<span class="spacer"></span><span class="sub">${list.filter((p) => p.active).length} active</span>
    <button class="btn sm primary" id="add">+ Add player</button><button class="btn sm" id="bulk">Bulk add</button></div>
    <div class="table-wrap"><table class="fm"><thead><tr><th>Name</th><th>Phone</th><th>Pos</th><th>Ability</th><th></th></tr></thead><tbody>
    ${list.map((p) => `<tr class="click" data-id="${p.id}" style="${p.active ? '' : 'opacity:.5'}"><td class="name">${esc(p.name)}</td><td class="dim">${esc(p.phone)}</td>
      <td>${posBadge(p.position)}</td><td>${stars(p.rating)}</td><td>${p.is_admin ? '<span class="tag admin">Admin</span>' : ''} ${p.active ? '' : '<span class="tag">Inactive</span>'}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="panel-b muted" style="font-size:18px">Only phone numbers on this list can log in. "Ability" is only visible to players as stars and drives Auto-balance.</div>
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
  const isNew = !p; p = p || { name: '', phone: '', position: 'MID', rating: 3, is_admin: false, active: true };
  modal(isNew ? 'New player' : `Edit ${p.name}`, `
    <form id="pf">
      <div class="form-grid">
        <label class="f"><span>Name</span><input type="text" name="name" value="${esc(p.name)}" required></label>
        <label class="f"><span>Phone (WhatsApp)</span><input type="tel" name="phone" value="${esc(p.phone)}" required placeholder="+381641234567"></label>
        <label class="f"><span>Position</span><select name="position">${['GK', 'DEF', 'MID', 'FWD'].map((x) => `<option ${x === p.position ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="f"><span>Ability (1–5)</span><select name="rating">${[1, 2, 3, 4, 5].map((x) => `<option value="${x}" ${x === p.rating ? 'selected' : ''}>${'■'.repeat(x)}${'□'.repeat(5 - x)}</option>`).join('')}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="is_admin" ${p.is_admin ? 'checked' : ''}> Admin (can create matches &amp; pick teams)</label>
      <label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Active (can log in, shows in squad)</label>
      <div class="err" id="perr"></div>
      <div class="btn-row" style="justify-content:space-between">
        ${isNew ? '<span></span>' : '<button type="button" class="btn danger" id="pdel">Delete</button>'}
        <div class="btn-row"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div>
      </div>
    </form>`, (root, close) => {
    const f = $('#pf', root);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: f.name.value, phone: f.phone.value, position: f.position.value, rating: Number(f.rating.value), is_admin: f.is_admin.checked, active: f.active.checked };
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
    e.g. <code>Marko Petrović, +381641234567, DEF, 4</code></p>
    <textarea id="bt" rows="10" placeholder="Marko Petrović, +381641234567&#10;Nikola, 0631234567, GK"></textarea>
    <div class="err" id="berr"></div>
    <div class="btn-row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="bgo">Add all</button></div>`,
  (root, close) => {
    $('#bgo', root).onclick = async () => {
      const lines = $('#bt', root).value.split('\n').map((l) => l.trim()).filter(Boolean);
      let ok = 0; const errs = [];
      for (const line of lines) {
        const [name, phone, position, rating] = line.split(/[,;\t]/).map((s) => s.trim());
        try { await api('POST', '/api/players', { name, phone, position: position || 'MID', rating: Number(rating) || 3 }); ok++; }
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
  <div class="panel"><div class="panel-h">Invite link</div><div class="panel-b">
    <p class="muted" style="margin-top:0">Post this in the WhatsApp group description:</p>
    <div class="btn-row"><input type="text" readonly value="${esc(location.origin)}" style="max-width:320px"><button class="btn" id="cp">Copy</button></div>
  </div></div>`;
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PUT', '/api/settings/password', { password: e.target.password.value }); e.target.reset(); toast('Group password changed'); } catch (err) { fail(err); }
  };
  $('#cp').onclick = () => navigator.clipboard?.writeText(location.origin).then(() => toast('Copied'), () => {});
}

// ---------- boot ----------
(async () => {
  try { const { user } = await api('GET', '/api/me'); S.me = user; route(); } catch { renderLogin(); }
})();