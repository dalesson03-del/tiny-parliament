// Tiny Parliament app: screens, the host loop and the client connection.

import { createGame, addPlayer, act, tick, viewFor, setConnected, cleanName } from './engine.js';
import { runBots } from './bots.js';
import { LAWS, LAW_IDS, TAGS, AGENDAS } from './laws.js';
import { HostNet, ClientNet } from './net.js';

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');
const $reactions = document.getElementById('reactions');

const REACTIONS = ['👏', '😂', '😱', '🙅', '🤔', '🔥'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// ---------- storage ----------

// Room session + host state live in sessionStorage: per tab, kept across a
// refresh, so one person can host in one tab and play in another.
// The player's name is remembered in localStorage.
const area = (k) => (k === 'tp-name' ? localStorage : sessionStorage);
const store = {
  get(k) {
    try {
      return JSON.parse(area(k).getItem(k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      area(k).setItem(k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
  del(k) {
    try {
      area(k).removeItem(k);
    } catch {
      /* private mode */
    }
  },
};

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 24);
}

function newCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// ---------- app state ----------

const ui = {
  mode: 'home', // home | connecting | game
  connectingText: '',
  status: 'connected',
  view: null,
  viewAt: 0,
  renderedVersion: -1,
  seenResult: null,
  seenFinal: false,
  noRoomCount: 0,
  homeError: '',
};

let session = store.get('tp-session'); // { code, id, name, role }
let host = null; // { state, net, loop, lastSent, lastBeat, reactAt }
let client = null;

// ---------- feedback ----------

let toastTimer = null;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 3200);
}

function floatReaction(name, emoji) {
  const el = document.createElement('div');
  el.className = 'bubble';
  el.style.left = 8 + Math.random() * 74 + '%';
  el.innerHTML = `<span class="bubble-emoji">${esc(emoji)}</span><span class="bubble-name">${esc(name)}</span>`;
  $reactions.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ---------- host ----------

function hostHandlers() {
  return {
    onHello(msg) {
      if (typeof msg.id !== 'string' || msg.id.length > 64) return { ok: false, error: 'Bad request.' };
      const r = addPlayer(host.state, { id: msg.id, name: msg.name });
      return r;
    },
    onJoined() {
      hostBroadcast();
    },
    onAction(pid, action) {
      const r = act(host.state, pid, action, Date.now());
      if (!r.ok) host.net.sendTo(pid, { t: 'err', error: r.error });
      hostBroadcast();
    },
    onReact(pid, emoji) {
      hostReact(pid, emoji);
    },
    onDrop(pid) {
      setConnected(host.state, pid, false);
      hostBroadcast();
    },
  };
}

function hostReact(pid, emoji) {
  if (!REACTIONS.includes(emoji)) return;
  const now = Date.now();
  if (now - (host.reactAt[pid] || 0) < 700) return;
  host.reactAt[pid] = now;
  const p = host.state.players.find((x) => x.id === pid);
  if (!p) return;
  host.net.broadcast(() => ({ t: 'react', name: p.name, emoji }));
  floatReaction(p.name, emoji);
}

function hostBroadcast() {
  if (!host) return;
  const now = Date.now();
  host.lastSent = host.state.version;
  host.lastBeat = now;
  store.set('tp-state-' + host.state.code, host.state);
  host.net.broadcast((pid) => ({ t: 'view', view: viewFor(host.state, pid, now) }));
  setView(viewFor(host.state, session.id, now));
}

function startHostLoop() {
  host.loop = setInterval(() => {
    const now = Date.now();
    tick(host.state, now);
    runBots(host.state, now);
    tick(host.state, now);
    if (host.state.version !== host.lastSent || now - host.lastBeat > 2000) hostBroadcast();
  }, 250);
  hostBroadcast();
}

// PeerJS loads from a CDN (with a fallback), so give it a moment.
async function waitForPeer(ms = 10000) {
  const end = Date.now() + ms;
  while (!window.Peer && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return !!window.Peer;
}

async function openHostNet(state, { retryForMs = 0 } = {}) {
  const deadline = Date.now() + retryForMs;
  for (;;) {
    const net = new HostNet(state.code, hostHandlers());
    try {
      await net.open();
      return net;
    } catch (err) {
      if (err?.type === 'unavailable-id' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
}

async function createRoom(name) {
  if (!(await waitForPeer())) return homeFail('The connection library did not load. Check your internet connection and reload.');
  ui.mode = 'connecting';
  ui.connectingText = 'Building your chamber…';
  render();
  const id = uid();
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = createGame(newCode());
    addPlayer(state, { id, name });
    host = { state, net: null, loop: null, lastSent: 0, lastBeat: 0, reactAt: {} };
    try {
      host.net = await openHostNet(state);
      session = { code: state.code, id, name, role: 'host' };
      store.set('tp-session', session);
      ui.mode = 'game';
      startHostLoop();
      history.replaceState(null, '', location.pathname + '?room=' + state.code);
      return;
    } catch (err) {
      host = null;
      if (err?.type === 'unavailable-id') continue;
      return homeFail(netErrorText(err));
    }
  }
  homeFail('Could not reserve a room code. Try again.');
}

async function resumeHost(saved) {
  if (!(await waitForPeer())) return homeFail('The connection library did not load. Check your internet connection and reload.');
  ui.mode = 'connecting';
  ui.connectingText = `Reopening room ${saved.code}…`;
  render();
  saved.players.forEach((p) => {
    if (!p.isBot) p.connected = p.id === session.id;
  });
  host = { state: saved, net: null, loop: null, lastSent: 0, lastBeat: 0, reactAt: {} };
  try {
    host.net = await openHostNet(saved, { retryForMs: 45000 });
    ui.mode = 'game';
    startHostLoop();
    toast('Room reopened. Players will reconnect automatically.');
  } catch (err) {
    host = null;
    clearSession(saved.code);
    homeFail(`Room ${saved.code} could not be reopened. Start a new room.`);
  }
}

function netErrorText(err) {
  if (err?.type === 'browser-incompatible') return 'This browser does not support live connections. Try Chrome, Safari or Firefox.';
  if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err?.type))
    return 'Could not reach the matchmaking server. Check your connection and try again.';
  return 'Something went wrong opening the connection. Try again.';
}

// ---------- client ----------

async function joinRoom(code, name) {
  if (!(await waitForPeer())) return homeFail('The connection library did not load. Check your internet connection and reload.');
  const id = session && session.code === code ? session.id : uid();
  ui.mode = 'connecting';
  ui.connectingText = `Knocking on the door of room ${code}…`;
  ui.noRoomCount = 0;
  render();
  client = new ClientNet(code, { id, name }, {
    onMessage(msg) {
      if (msg.t === 'welcome') {
        session = { code, id, name, role: 'client' };
        store.set('tp-session', session);
        history.replaceState(null, '', location.pathname + '?room=' + code);
      } else if (msg.t === 'reject') {
        client.close();
        client = null;
        if (session?.code === code) clearSession(code);
        homeFail(msg.error);
      } else if (msg.t === 'view') {
        ui.mode = 'game';
        setView(msg.view);
      } else if (msg.t === 'err') {
        toast(msg.error);
      } else if (msg.t === 'react') {
        floatReaction(msg.name, msg.emoji);
      }
    },
    onStatus(status) {
      if (status === 'no-room') {
        ui.noRoomCount += 1;
        if (ui.noRoomCount >= 3) {
          client.close();
          client = null;
          if (session?.code === code) clearSession(code);
          return homeFail(`No room ${code} is open right now. Check the code with your host.`);
        }
        return;
      }
      if (status === 'closed') {
        client?.close();
        client = null;
        clearSession(code);
        return homeFail('The host closed the room.');
      }
      ui.status = status;
      renderStatus();
    },
  });
  client.start();
}

// ---------- actions ----------

function doAct(action) {
  if (host) {
    const r = act(host.state, session.id, action, Date.now());
    if (!r.ok) toast(r.error);
    hostBroadcast();
  } else if (client) {
    client.act(action);
  }
}

function doReact(emoji) {
  if (host) hostReact(session.id, emoji);
  else if (client) client.react(emoji);
}

function clearSession(code) {
  store.del('tp-session');
  if (code) store.del('tp-state-' + code);
  session = null;
}

function leave() {
  const isHost = !!host;
  if (isHost && !confirm('Leaving closes the room for everyone. Close it?')) return;
  if (host) {
    clearInterval(host.loop);
    host.net.close();
    clearSession(host.state.code);
    host = null;
  }
  if (client) {
    client.close();
    clearSession(session?.code);
    client = null;
  }
  ui.mode = 'home';
  ui.view = null;
  history.replaceState(null, '', location.pathname);
  render();
}

function homeFail(msg) {
  ui.mode = 'home';
  ui.homeError = msg;
  ui.view = null;
  render();
}

// ---------- view plumbing ----------

function setView(v) {
  const prev = ui.view;
  ui.view = v;
  ui.viewAt = performance.now();
  if (ui.mode !== 'game') ui.mode = 'game';
  if (!prev || prev.version !== v.version || ui.renderedVersion === -1) render();
  else updateClock();
}

function remaining() {
  const v = ui.view;
  if (!v || !v.remainingMs) return 0;
  return Math.max(0, v.remainingMs - (performance.now() - ui.viewAt));
}

function updateClock() {
  const ms = remaining();
  const secs = Math.ceil(ms / 1000);
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    el.textContent = secs;
  });
  const total = phaseTotal();
  document.querySelectorAll('[data-progress]').forEach((el) => {
    el.style.transform = `scaleX(${total ? Math.min(1, ms / total) : 0})`;
  });
}

function phaseTotal() {
  const v = ui.view;
  if (!v) return 0;
  return { proposal: 40000, debate: 45000, vote: v.rules.voteSeconds * 1000, result: 9000 }[v.phase] || 0;
}

setInterval(updateClock, 200);

function renderStatus() {
  let bar = document.getElementById('netbar');
  const show = client && ui.mode === 'game' && ui.status === 'reconnecting';
  if (!show) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'netbar';
    bar.className = 'netbar';
    bar.textContent = 'Connection to the host dropped. Reconnecting…';
    document.body.appendChild(bar);
  }
}

// ---------- components ----------

function inviteLink(code) {
  return `${location.origin}${location.pathname}?join=${code}`;
}

function lawNumber(id) {
  return LAW_IDS.indexOf(id) + 1;
}

function bill(id, { kind = 'enact', stamp = null, compact = false, button = '' } = {}) {
  const law = LAWS[id];
  const tag = TAGS[law.tag];
  const title = kind === 'repeal' ? `Repeal the ${law.name}` : law.name;
  const text = kind === 'repeal' ? `If this passes, it is struck from the Constitution. It currently says: ${law.text}` : law.text;
  return `<article class="bill tag-${law.tag}${compact ? ' compact' : ''}">
    <header class="bill-head"><span class="bill-tag">${tag.icon} ${tag.name}</span><span class="bill-no">Bill ${lawNumber(id)}${law.decree ? ' · Decree' : ''}</span></header>
    <h3 class="bill-title">${esc(title)}</h3>
    <p class="bill-text">${esc(text)}</p>
    ${button}
    ${stamp || ''}
  </article>`;
}

function me() {
  return ui.view.players.find((p) => p.id === ui.view.you?.id);
}

function playerName(id) {
  return ui.view.players.find((p) => p.id === id)?.name ?? 'Someone';
}

function timer(label) {
  return `<div class="timer"><div class="timer-row"><span>${esc(label)}</span><span class="timer-secs"><span data-countdown>${Math.ceil(
    remaining() / 1000
  )}</span>s</span></div><div class="timer-track"><div class="timer-fill" data-progress></div></div></div>`;
}

function topbar() {
  const v = ui.view;
  const you = me();
  const inGame = v.phase !== 'lobby';
  return `<header class="topbar">
    <div class="tb-left">
      <span class="tb-code" title="Room code">${esc(v.code)}</span>
      ${inGame && v.phase !== 'final' ? `<span class="tb-round">Round ${v.round} of ${v.maxRounds}</span>` : ''}
    </div>
    <div class="tb-right">
      ${inGame ? `<button class="chip" data-open="constitution">Constitution <b>${v.constitution.length}/5</b></button>` : ''}
      ${inGame && v.you?.agendaId && v.phase !== 'final' ? `<button class="chip chip-secret" data-open="agenda">Agenda</button>` : ''}
      ${you && inGame && !you.spectator ? `<span class="tb-inf" title="Your Influence">⚖️ ${you.influence}</span>` : ''}
      <button class="chip chip-quiet" data-open="menu" aria-label="Menu">⋯</button>
    </div>
  </header>`;
}

function chamber({ showVotes = false } = {}) {
  const v = ui.view;
  const seated = v.players.filter((p) => !p.spectator);
  const gallery = v.players.filter((p) => p.spectator);
  const rows = seated
    .map((p) => {
      const badges = [];
      if (p.id === v.speakerId && v.phase !== 'lobby' && v.phase !== 'final') badges.push('<span class="badge badge-speaker">Speaker</span>');
      if (p.id === v.hostId) badges.push('<span class="badge">Host</span>');
      if (p.isBot) badges.push('<span class="badge">Bot</span>');
      if (!p.connected && !p.isBot) badges.push('<span class="badge badge-off">Away</span>');
      let state = '';
      if (v.phase === 'debate' && p.ready) state = '<span class="pstate">Ready</span>';
      if (v.phase === 'vote') {
        if (p.vote) state = `<span class="pstate vote-${p.vote}">${p.vote === 'aye' ? 'Aye' : 'Nay'}</span>`;
        else if (p.hasVoted) state = '<span class="pstate">Voted</span>';
        if (p.lobbied) state += '<span class="pstate">+1 lobbied</span>';
      }
      if (showVotes && v.lastResult) {
        const b = v.lastResult.ballots.find((x) => x.id === p.id);
        if (b) state = `<span class="pstate vote-${b.choice}">${b.cast ? (b.choice === 'aye' ? 'Aye' : 'Nay') : 'No vote'}${b.weight > 1 ? ` ×${b.weight}` : ''}</span>`;
      }
      const isMe = p.id === v.you?.id;
      return `<li class="seat${isMe ? ' seat-me' : ''}${!p.connected && !p.isBot ? ' seat-away' : ''}">
        <div class="seat-who"><span class="seat-name">${esc(p.name)}${isMe ? ' <small>(you)</small>' : ''}</span><span class="seat-min">${esc(
        p.ministry
      )}</span></div>
        <div class="seat-tags">${badges.join('')}${state}</div>
        ${v.phase !== 'lobby' ? `<span class="seat-inf" title="Influence">${p.influence}</span>` : ''}
        ${
          v.phase === 'lobby' && v.you?.isHost && p.id !== v.hostId
            ? `<button class="seat-x" data-act="remove" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">Remove</button>`
            : ''
        }
      </li>`;
    })
    .join('');
  return `<section class="chamber" aria-label="Ministers">
    <h2 class="sec-title">The chamber</h2>
    <ul class="seats">${rows}</ul>
    ${gallery.length ? `<p class="gallery">In the public gallery: ${gallery.map((p) => esc(p.name)).join(', ')}</p>` : ''}
  </section>`;
}

function reactBar() {
  return `<div class="reacts" role="group" aria-label="Reactions">${REACTIONS.map(
    (e) => `<button class="react" data-react="${e}" aria-label="React ${e}">${e}</button>`
  ).join('')}</div>`;
}

function spectatorNote() {
  return ui.view.you?.spectator
    ? `<p class="note note-gallery">You're watching from the public gallery. You'll get a seat when the next game starts.</p>`
    : '';
}

// ---------- screens ----------

function screenHome() {
  const params = new URLSearchParams(location.search);
  const joinCode = (params.get('join') || params.get('room') || '').toUpperCase().slice(0, 4);
  const savedName = store.get('tp-name') || '';
  return `<section class="home">
    <div class="home-hero">
      <svg class="dome" viewBox="0 0 200 120" aria-hidden="true">
        <path d="M30 100 Q100 -10 170 100" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>
        <path d="M60 100 L60 70 M80 100 L80 58 M100 100 L100 54 M120 100 L120 58 M140 100 L140 70" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>
        <path d="M18 104 H182" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
        <path d="M100 34 V12 L118 18 L100 24" fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>
      </svg>
      <h1 class="title">Tiny<br/>Parliament</h1>
      <p class="tagline">A party game where you vote on the rules of your own game. Every law that passes changes how everyone plays, instantly.</p>
    </div>
    <form class="card form" id="homeForm" autocomplete="off">
      <label class="field"><span>Your name</span>
        <input id="name" name="name" maxlength="16" required placeholder="e.g. Edwin" value="${esc(savedName)}" />
      </label>
      ${ui.homeError ? `<p class="form-error" role="alert">${esc(ui.homeError)}</p>` : ''}
      <div class="split">
        <button type="submit" class="btn btn-gold" data-intent="create" ${joinCode ? 'hidden' : ''}>Create a room</button>
        <div class="join">
          <label class="field field-code"><span>Room code</span>
            <input id="code" name="code" maxlength="4" placeholder="ABCD" value="${esc(joinCode)}" autocapitalize="characters" inputmode="text" />
          </label>
          <button type="submit" class="btn ${joinCode ? 'btn-gold' : 'btn-line'}" data-intent="join">Join room</button>
        </div>
        ${joinCode ? `<button type="submit" class="btn btn-ghost" data-intent="create">Create my own room instead</button>` : ''}
      </div>
    </form>
    <p class="home-meta">3–8 players · 15 minutes · any phone or laptop · no login<br/><button class="link" data-open="howto">How to play</button></p>
  </section>`;
}

function screenConnecting() {
  return `<section class="center-screen"><div class="spinner" aria-hidden="true"></div><p>${esc(ui.connectingText)}</p>
    <button class="btn btn-ghost" data-act="cancel">Cancel</button></section>`;
}

function screenLobby() {
  const v = ui.view;
  const seated = v.players.filter((p) => !p.spectator);
  const present = seated.filter((p) => p.connected || p.isBot).length;
  const link = inviteLink(v.code);
  const needed = Math.max(0, 3 - present);
  return `${topbar()}
  <section class="lobby">
    <div class="codeplate">
      <p class="codeplate-label">Room code</p>
      <p class="codeplate-code" aria-label="Room code ${v.code.split('').join(' ')}">${esc(v.code)}</p>
      <p class="codeplate-hint">Friends open <b>${esc(location.host)}</b> and enter this code.</p>
      <button class="btn btn-line btn-small" data-act="invite" data-link="${esc(link)}">Copy invite link</button>
    </div>
    ${chamber()}
    ${
      v.you?.isHost
        ? `<div class="actions">
            <button class="btn btn-line" data-act="addBot" ${seated.length >= 8 ? 'disabled' : ''}>Add a bot minister</button>
            <button class="btn btn-gold" data-act="start" ${needed ? 'disabled' : ''}>Open the session</button>
            <p class="hint">${
              needed
                ? `${needed} more minister${needed > 1 ? 's' : ''} needed. Bots count, so you can try it alone.`
                : `${present} ministers ready. Up to 8 can sit.`
            }</p>
          </div>`
        : `<p class="note">Waiting for ${esc(playerName(v.hostId))} to open the session.</p>`
    }
    ${spectatorNote()}
    ${howToCard()}
  </section>`;
}

function howToCard() {
  return `<section class="card howto">
    <h2 class="sec-title">How to play, in 30 seconds</h2>
    <ol class="steps">
      <li><b>Propose.</b> Each round a different Speaker picks one of two secret bills.</li>
      <li><b>Debate.</b> Argue out loud for up to 45 seconds. Tap ready when you've heard enough.</li>
      <li><b>Vote.</b> Aye or Nay, all at once. Majority passes; ties fail; no vote counts as Nay.</li>
      <li><b>Live with it.</b> A passed law changes the rules for everyone right away. Check the Constitution any time.</li>
    </ol>
    <p class="howto-score">You earn Influence when your bill passes (+2) and when you vote with the result (+1). Your secret agenda adds a bonus at the end. Most Influence after 8 rounds becomes Prime Minister.</p>
  </section>`;
}

function screenProposal() {
  const v = ui.view;
  const amSpeaker = v.you?.isSpeaker;
  if (amSpeaker) {
    const repeal =
      v.rules.canRepeal && v.constitution.length
        ? `<details class="card repeal"><summary>Or propose a repeal (Right to Repeal)</summary>
            <div class="repeal-list">${v.constitution
              .map((id) => `<button class="btn btn-line btn-small" data-act="repeal" data-id="${id}">Repeal ${esc(LAWS[id].name)}</button>`)
              .join('')}</div></details>`
        : '';
    return `${topbar()}
    <section class="stage">
      <p class="kicker">You are the Speaker</p>
      <h2 class="stage-title">Choose the bill Parliament votes on</h2>
      <p class="sub">Only you can see these two. The other goes back in the drawer. If your bill passes, you get +2.</p>
      ${timer('Time to choose')}
      <div class="choices">
        ${v.offered.map((id) => bill(id, { button: `<button class="btn btn-gold bill-btn" data-act="propose" data-id="${id}">Propose this bill</button>` })).join('')}
      </div>
      ${repeal}
    </section>
    ${chamber()}`;
  }
  return `${topbar()}
  <section class="stage">
    <p class="kicker">Round ${v.round}</p>
    <h2 class="stage-title">${esc(playerName(v.speakerId))} is choosing a bill</h2>
    <p class="sub">The Speaker sees two secret bills and puts one to the vote. Start lobbying them now.</p>
    ${timer('Speaker decides in')}
    <div class="drawer" aria-hidden="true"><div class="drawer-card"></div><div class="drawer-card"></div></div>
    ${spectatorNote()}
  </section>
  ${chamber()}`;
}

function screenDebate() {
  const v = ui.view;
  const seated = v.players.filter((p) => !p.spectator && p.connected && !p.isBot);
  const ready = seated.filter((p) => p.ready).length;
  const iAmSeated = v.you && !v.you.spectator;
  return `${topbar()}
  <section class="stage">
    <p class="kicker">Debate · proposed by ${esc(playerName(v.speakerId))}</p>
    ${bill(v.motion.lawId, { kind: v.motion.kind })}
    ${timer('Debate ends in')}
    <p class="sub">Make your case out loud. Voting opens when everyone is ready or the clock runs out.</p>
    ${reactBar()}
    ${
      iAmSeated
        ? `<button class="btn ${v.you.ready ? 'btn-line' : 'btn-gold'} btn-wide" data-act="ready" ${v.you.ready ? 'disabled' : ''}>${
            v.you.ready ? 'Ready. Waiting for the others' : 'I’m ready to vote'
          }</button>`
        : ''
    }
    <p class="hint">${ready} of ${seated.length} ready</p>
    ${spectatorNote()}
  </section>
  ${chamber()}`;
}

function screenVote() {
  const v = ui.view;
  const you = me();
  const seated = v.players.filter((p) => !p.spectator && (p.connected || p.isBot));
  const voters = seated.filter((p) => p.hasVoted).length;
  let actions = '';
  if (v.you?.spectator) {
    actions = '';
  } else if (!v.you?.canVote) {
    actions = `<p class="note">The Gag Order is in force: as Speaker, you can't vote on your own bill.</p>`;
  } else if (v.you.vote) {
    actions = `<p class="voted">You voted <b class="vote-${v.you.vote}">${v.you.vote === 'aye' ? 'Aye' : 'Nay'}</b>. Waiting for the rest of the chamber.</p>`;
  } else {
    const lobby =
      v.rules.lobbying && !v.you.lobbied
        ? `<button class="btn btn-line btn-wide" data-act="lobby" ${you.influence < 1 ? 'disabled' : ''}>Lobby: pay 1 Influence for +1 vote</button>`
        : v.you.lobbied
        ? `<p class="hint">Lobbied. Your vote counts one extra.</p>`
        : '';
    actions = `${lobby}<div class="ballot">
      <button class="btn-vote aye" data-act="vote" data-choice="aye">Aye</button>
      <button class="btn-vote nay" data-act="vote" data-choice="nay">Nay</button>
    </div>`;
  }
  const rulesLine = [
    v.rules.threshold > 0.5 ? 'Needs two thirds to pass' : 'Majority passes, ties fail',
    v.rules.visibility === 'live' ? 'votes are public as they land' : v.rules.visibility === 'totals' ? 'secret ballot' : 'votes revealed after',
  ].join(' · ');
  return `${topbar()}
  <section class="stage">
    <p class="kicker">Division of the house</p>
    ${bill(v.motion.lawId, { kind: v.motion.kind })}
    ${timer('Voting closes in')}
    ${actions}
    <p class="hint">${voters} of ${seated.length} voted · ${esc(rulesLine)}</p>
    ${reactBar()}
    ${spectatorNote()}
  </section>
  ${chamber()}`;
}

function screenResult() {
  const v = ui.view;
  const r = v.lastResult;
  const animate = ui.seenResult !== r.round;
  ui.seenResult = r.round;
  const stamp = `<div class="stamp ${r.passed ? 'stamp-pass' : 'stamp-fail'}${animate ? ' stamp-in' : ''}" aria-hidden="true">${r.passed ? 'Passed' : 'Rejected'}</div>`;
  const changes = r.changes.length
    ? `<ul class="changes">${aggregate(r.changes)
        .map((c) => `<li><span>${esc(playerName(c.id))}</span><span class="${c.delta > 0 ? 'up' : 'down'}">${c.delta > 0 ? '+' : ''}${c.delta}</span><small>${esc(c.reasons)}</small></li>`)
        .join('')}</ul>`
    : '';
  const isLast = v.round >= v.maxRounds;
  return `${topbar()}
  <section class="stage">
    <p class="kicker">The ${r.passed ? 'Ayes' : 'Nays'} have it</p>
    ${bill(r.motion.lawId, { kind: r.motion.kind, stamp })}
    <p class="tally" aria-label="${r.ayes} aye, ${r.nays} nay"><span class="tally-aye">${r.ayes} Aye</span><span class="tally-sep">–</span><span class="tally-nay">${r.nays} Nay</span></p>
    ${r.visibility === 'totals' ? '<p class="hint">Secret Ballot: individual votes stay hidden.</p>' : ''}
    ${r.notes.length ? `<div class="card changed"><h3 class="sec-title">What changed</h3><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
    ${changes ? `<div class="card"><h3 class="sec-title">Influence</h3>${changes}</div>` : ''}
    ${timer(isLast ? 'Final count in' : 'Next round in')}
    ${reactBar()}
  </section>
  ${chamber({ showVotes: r.visibility !== 'totals' })}`;
}

function aggregate(changes) {
  const map = new Map();
  changes.forEach((c) => {
    const e = map.get(c.id) || { id: c.id, delta: 0, reasons: [] };
    e.delta += c.delta;
    e.reasons.push(`${c.reason} ${c.delta > 0 ? '+' : ''}${c.delta}`);
    map.set(c.id, e);
  });
  return [...map.values()].filter((e) => e.delta !== 0).map((e) => ({ ...e, reasons: e.reasons.join(', ') }));
}

function screenPaused() {
  return `${topbar()}
  <section class="center-screen">
    <h2 class="stage-title">Session paused</h2>
    <p class="sub">Fewer than 3 ministers are present. The game resumes as soon as someone reconnects.</p>
  </section>
  ${chamber()}`;
}

function screenFinal() {
  const v = ui.view;
  const rows = v.finalScores || [];
  const animate = !ui.seenFinal;
  ui.seenFinal = true;
  const winner = rows[0];
  const list = rows
    .map((r, i) => {
      const a = AGENDAS[r.agendaId];
      return `<li class="reveal${animate ? ' reveal-in' : ''}" style="--i:${i}">
        <span class="rank">${r.rank}</span>
        <div class="reveal-body">
          <p class="reveal-name">${esc(r.name)} <small>${esc(r.ministry)}</small></p>
          <p class="reveal-agenda">Secret agenda: ${esc(a?.text || 'none')} <b class="${r.met ? 'up' : 'down'}">${r.met ? `met, +${r.bonus}` : 'missed'}</b></p>
        </div>
        <span class="reveal-total">${r.total}</span>
      </li>`;
    })
    .join('');
  return `${topbar()}
  <section class="stage final">
    <p class="kicker">Parliament is dissolved</p>
    <h2 class="stage-title">${winner ? `${esc(winner.name)} is Prime Minister` : 'The session has ended'}</h2>
    <p class="sub">${winner ? `${winner.total} Influence, after secret agendas were revealed.` : ''}</p>
    <ol class="reveals">${list}</ol>
    <div class="card"><h3 class="sec-title">The final Constitution</h3>${
      v.constitution.length ? v.constitution.map((id) => bill(id, { compact: true })).join('') : '<p class="sub">Parliament left no laws standing.</p>'
    }</div>
    ${
      v.you?.isHost
        ? `<button class="btn btn-gold btn-wide" data-act="playAgain">Play again with this room</button>`
        : `<p class="note">${esc(playerName(v.hostId))} can start another game in this room.</p>`
    }
  </section>`;
}

// ---------- sheets ----------

function openSheet(kind) {
  const v = ui.view;
  let body = '';
  if (kind === 'constitution') {
    const rules = v.rules;
    body = `<h2 class="sheet-title">The Constitution</h2>
      <p class="sub">Active laws apply to everyone right now. It holds 5; a sixth repeals the oldest.</p>
      ${v.constitution.length ? v.constitution.map((id) => bill(id, { compact: true })).join('') : '<p class="empty">No laws yet. The first bill that passes lands here.</p>'}
      <ul class="rulebox">
        <li>To pass: ${rules.threshold > 0.5 ? 'two thirds of the votes' : 'more Ayes than Nays'}</li>
        <li>Voting time: ${rules.voteSeconds} seconds</li>
        <li>Votes: ${rules.visibility === 'live' ? 'public as they are cast' : rules.visibility === 'totals' ? 'secret, totals only' : 'revealed after each vote'}</li>
        <li>Chaos laws passed so far: ${v.chaosPassed}</li>
      </ul>`;
  } else if (kind === 'agenda') {
    const a = AGENDAS[v.you?.agendaId];
    body = `<h2 class="sheet-title">Your secret agenda</h2>
      <p class="sub">Only you can see this. Keep your phone close.</p>
      <div class="agenda-card"><p>${esc(a?.text || 'No agenda yet.')}</p><p class="agenda-bonus">+${a?.bonus || 0} Influence at the end</p></div>
      <p class="hint">Agendas are revealed after round 8. Watch out: the Agenda Shuffle decree passes them one seat to the left.</p>`;
  } else if (kind === 'howto') {
    body = howToCard().replace('class="card howto"', 'class="howto"');
  } else if (kind === 'menu') {
    body = `<h2 class="sheet-title">Room ${esc(v.code)}</h2>
      <button class="btn btn-line btn-wide" data-act="invite" data-link="${esc(inviteLink(v.code))}">Copy invite link</button>
      <button class="btn btn-line btn-wide" data-open="howto">How to play</button>
      <button class="btn btn-danger btn-wide" data-act="leave">${host ? 'Close the room' : 'Leave the room'}</button>
      ${host ? '<p class="hint">You are hosting. Keep this tab open: the game runs on your device. If you refresh, the room reopens and everyone reconnects.</p>' : ''}`;
  }
  $sheet.innerHTML = `<div class="sheet-inner">${body}<button class="btn btn-ghost btn-wide" data-close>Close</button></div>`;
  if (!$sheet.open) $sheet.showModal();
}

// ---------- render ----------

function render() {
  if (ui.mode === 'home') {
    $app.innerHTML = screenHome();
    ui.renderedVersion = -1;
    ui.seenFinal = false;
    const form = document.getElementById('homeForm');
    form.addEventListener('submit', onHomeSubmit);
    return;
  }
  if (ui.mode === 'connecting' || !ui.view) {
    $app.innerHTML = screenConnecting();
    return;
  }
  const v = ui.view;
  if (v.phase !== 'final') ui.seenFinal = false;
  const screens = {
    lobby: screenLobby,
    proposal: screenProposal,
    debate: screenDebate,
    vote: screenVote,
    result: screenResult,
    paused: screenPaused,
    final: screenFinal,
  };
  const scrollY = window.scrollY;
  const prevPhase = $app.dataset.phase;
  $app.innerHTML = (screens[v.phase] || screenPaused)();
  $app.dataset.phase = v.phase;
  if (prevPhase === v.phase) window.scrollTo(0, scrollY);
  else window.scrollTo(0, 0);
  ui.renderedVersion = v.version;
  updateClock();
  renderStatus();
  if ($sheet.open && $sheet.dataset.kind === 'constitution') openSheet('constitution');
}

let submitIntent = 'create';
function onHomeSubmit(e) {
  e.preventDefault();
  const intent = e.submitter?.dataset.intent || submitIntent;
  const name = cleanName(document.getElementById('name').value);
  if (!name) {
    ui.homeError = 'Enter your name first.';
    return render();
  }
  store.set('tp-name', name);
  ui.homeError = '';
  if (intent === 'join') {
    const code = document.getElementById('code').value.toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) {
      ui.homeError = 'Room codes are 4 letters.';
      return render();
    }
    joinRoom(code, name);
  } else {
    createRoom(name);
  }
}

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act],[data-open],[data-close],[data-react],[data-intent]');
  if (!t) return;
  if (t.dataset.intent) submitIntent = t.dataset.intent;
  if (t.dataset.close !== undefined) return $sheet.close();
  if (t.dataset.open) {
    $sheet.dataset.kind = t.dataset.open;
    return openSheet(t.dataset.open);
  }
  if (t.dataset.react) return doReact(t.dataset.react);
  const a = t.dataset.act;
  switch (a) {
    case 'start':
    case 'addBot':
    case 'ready':
    case 'lobby':
    case 'playAgain':
      return doAct({ type: a });
    case 'remove':
      return doAct({ type: 'remove', id: t.dataset.id });
    case 'propose':
      return doAct({ type: 'propose', lawId: t.dataset.id });
    case 'repeal':
      return doAct({ type: 'propose', repealId: t.dataset.id });
    case 'vote':
      t.closest('.ballot')?.classList.add('sent');
      return doAct({ type: 'vote', choice: t.dataset.choice });
    case 'invite': {
      const link = t.dataset.link;
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        try {
          await navigator.share({ title: 'Tiny Parliament', text: 'Join my Tiny Parliament room', url: link });
          return;
        } catch {
          /* fall through to copy */
        }
      }
      try {
        await navigator.clipboard.writeText(link);
        toast('Invite link copied.');
      } catch {
        prompt('Copy this invite link:', link);
      }
      return;
    }
    case 'leave':
      $sheet.close();
      return leave();
    case 'cancel':
      client?.close();
      client = null;
      if (host) {
        clearInterval(host.loop);
        host = null;
      }
      return homeFail('');
    default:
  }
});

$sheet.addEventListener('click', (e) => {
  if (e.target === $sheet) $sheet.close();
});

window.addEventListener('beforeunload', (e) => {
  if (host && ui.view && ui.view.phase !== 'lobby' && ui.view.phase !== 'final') {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------- boot ----------

function boot() {
  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get('room') || '').toUpperCase();
  if (session && (!urlRoom || urlRoom === session.code)) {
    if (session.role === 'host') {
      const saved = store.get('tp-state-' + session.code);
      if (saved && saved.phase !== undefined) return resumeHost(saved);
    } else {
      return joinRoom(session.code, session.name);
    }
  }
  render();
  if (params.get('join')) document.getElementById('name')?.focus();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
