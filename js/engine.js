// Tiny Parliament game engine.
// Pure state + functions, no DOM and no network, so it runs in the host's
// browser and in Node tests alike. The host owns the only copy of the state;
// every other device receives a redacted view from viewFor().

import { LAWS, LAW_IDS, AGENDAS, AGENDA_IDS, MINISTRIES, agendaMet, activePlayers } from './laws.js';

export const CONFIG = {
  maxRounds: 8,
  minPlayers: 3,
  maxPlayers: 8,
  startInfluence: 3,
  maxConstitution: 5,
  proposalSeconds: 40,
  speakerAbsentSeconds: 15,
  debateSeconds: 45,
  voteSeconds: 20,
  resultSeconds: 9,
};

const IN_GAME = ['proposal', 'debate', 'vote', 'result'];

// ---------- helpers ----------

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function bump(s) {
  s.version += 1;
}

export function getPlayer(s, id) {
  return s.players.find((p) => p.id === id) || null;
}

function present(p) {
  return p.connected || p.isBot;
}

function activeLaws(s) {
  return s.constitution.map((id) => LAWS[id]);
}

// Ask every active law for a hook value; return the hook results.
function hooks(s, name, ...args) {
  return activeLaws(s)
    .filter((l) => typeof l[name] === 'function')
    .map((l) => l[name](s, ...args));
}

export function rulesNow(s) {
  const thresholds = hooks(s, 'passThreshold');
  const voteSecs = hooks(s, 'voteSeconds');
  const vis = hooks(s, 'voteVisibility');
  return {
    threshold: thresholds.length ? Math.max(...thresholds) : 0.5,
    voteSeconds: voteSecs.length ? Math.min(...voteSecs) : CONFIG.voteSeconds,
    visibility: vis[0] || 'after', // 'after' | 'totals' | 'live'
    lobbying: hooks(s, 'allowsLobbying').some(Boolean),
    canRepeal: hooks(s, 'allowsRepeal').some(Boolean),
    unanimityPenalty: hooks(s, 'unanimityPenalty').some(Boolean),
  };
}

export function canVote(s, pid) {
  const p = getPlayer(s, pid);
  if (!p || p.spectator) return false;
  return hooks(s, 'canVote', pid).every(Boolean);
}

function voteWeight(s, pid) {
  const w = hooks(s, 'voteWeight', pid);
  return (w.length ? Math.max(...w) : 1) + (s.lobbied[pid] ? 1 : 0);
}

function makeFx(s) {
  const changes = [];
  const notes = [];
  return {
    changes,
    notes,
    change(p, delta, reason) {
      const before = p.influence;
      p.influence = Math.max(0, p.influence + delta);
      const real = p.influence - before;
      if (real !== 0) changes.push({ id: p.id, delta: real, reason });
    },
    note(msg) {
      notes.push(msg);
    },
  };
}

function log(s, msg) {
  s.log.push({ round: s.round, msg });
  if (s.log.length > 60) s.log.shift();
}

function setPhase(s, phase, now, seconds) {
  s.phase = phase;
  s.phaseStartedAt = now;
  s.phaseEndsAt = seconds ? now + seconds * 1000 : 0;
}

// ---------- room / lobby ----------

export function createGame(code) {
  return {
    code,
    version: 1,
    phase: 'lobby',
    round: 0,
    maxRounds: CONFIG.maxRounds,
    hostId: null,
    speakerId: null,
    phaseStartedAt: 0,
    phaseEndsAt: 0,
    deck: [],
    offered: [],
    motion: null,
    constitution: [],
    votes: {},
    lobbied: {},
    ready: {},
    players: [],
    chaosPassed: 0,
    lastResult: null,
    finalScores: null,
    pausedFrom: null,
    log: [],
  };
}

export function cleanName(name) {
  return String(name || '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

export function addPlayer(s, { id, name, isBot = false }, rng = Math.random) {
  const existing = getPlayer(s, id);
  if (existing) {
    existing.connected = true;
    bump(s);
    return { ok: true, player: existing, rejoined: true };
  }
  const clean = cleanName(name);
  if (!clean) return { ok: false, error: 'Enter a name to join.' };
  const twin = s.players.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  if (twin) {
    return { ok: false, error: `Someone here is already called ${twin.name}. Pick another name.` };
  }
  const seated = activePlayers(s).length;
  const spectator = s.phase !== 'lobby' || seated >= CONFIG.maxPlayers;
  const used = new Set(s.players.map((p) => p.ministry));
  const free = MINISTRIES.filter((m) => !used.has(m));
  const ministry = (free.length ? free : MINISTRIES)[Math.floor(rng() * (free.length || MINISTRIES.length))];
  const player = {
    id,
    name: clean,
    ministry,
    influence: CONFIG.startInfluence,
    agendaId: null,
    connected: true,
    isBot,
    spectator,
    votedWith: 0,
    proposalsPassed: 0,
  };
  s.players.push(player);
  if (!s.hostId && !isBot) s.hostId = id;
  log(s, `${clean} ${spectator ? 'is watching from the gallery' : 'took a seat'}.`);
  bump(s);
  return { ok: true, player };
}

export function setConnected(s, id, connected) {
  const p = getPlayer(s, id);
  if (!p || p.connected === connected) return;
  p.connected = connected;
  bump(s);
}

const BOT_NAMES = ['Lord Bumble', 'Dame Fizz', 'Sir Wobble', 'Baron Crumb', 'Lady Squall', 'Count Noodle', 'Duke Puddle'];

export function addBot(s, rng = Math.random) {
  if (s.phase !== 'lobby') return { ok: false, error: 'Bots can only join in the lobby.' };
  if (activePlayers(s).length >= CONFIG.maxPlayers) return { ok: false, error: 'The chamber is full (8 seats).' };
  const taken = new Set(s.players.map((p) => p.name));
  const name = BOT_NAMES.find((n) => !taken.has(n)) || `Bot ${s.players.length + 1}`;
  const id = 'bot-' + Math.floor(rng() * 1e9).toString(36);
  return addPlayer(s, { id, name, isBot: true }, rng);
}

export function removePlayer(s, id) {
  if (s.phase !== 'lobby') return { ok: false, error: 'Players can only be removed in the lobby.' };
  if (id === s.hostId) return { ok: false, error: 'The host cannot be removed.' };
  const before = s.players.length;
  s.players = s.players.filter((p) => p.id !== id);
  if (s.players.length === before) return { ok: false, error: 'That player is not here.' };
  bump(s);
  return { ok: true };
}

// ---------- game flow ----------

export function startGame(s, now, rng = Math.random) {
  if (s.phase !== 'lobby') return { ok: false, error: 'The game has already started.' };
  // Drop anyone who left the lobby.
  s.players = s.players.filter((p) => present(p) || p.id === s.hostId);
  const seated = activePlayers(s);
  if (seated.length < CONFIG.minPlayers) {
    return { ok: false, error: `You need at least ${CONFIG.minPlayers} ministers. Invite friends or add bots.` };
  }
  const agendas = shuffle(AGENDA_IDS, rng);
  seated.forEach((p, i) => {
    p.influence = CONFIG.startInfluence;
    p.agendaId = agendas[i % agendas.length];
    p.votedWith = 0;
    p.proposalsPassed = 0;
  });
  s.deck = shuffle(LAW_IDS, rng);
  s.constitution = [];
  s.chaosPassed = 0;
  s.lastResult = null;
  s.finalScores = null;
  s.round = 1;
  s.speakerId = seated[Math.floor(rng() * seated.length)].id;
  log(s, 'Parliament is in session.');
  beginProposal(s, now);
  return { ok: true };
}

function beginProposal(s, now) {
  s.offered = s.deck.splice(0, 2);
  s.motion = null;
  s.votes = {};
  s.lobbied = {};
  s.ready = {};
  setPhase(s, 'proposal', now, CONFIG.proposalSeconds);
  bump(s);
}

export function propose(s, pid, { lawId, repealId } = {}, now) {
  if (s.phase !== 'proposal') return { ok: false, error: 'It is not time to propose.' };
  if (pid !== s.speakerId) return { ok: false, error: 'Only the Speaker can propose this round.' };
  if (repealId) {
    if (!rulesNow(s).canRepeal) return { ok: false, error: 'Repeals need the Right to Repeal law.' };
    if (!s.constitution.includes(repealId)) return { ok: false, error: 'That law is not active.' };
    s.deck.push(...s.offered);
    s.motion = { kind: 'repeal', lawId: repealId };
  } else {
    if (!s.offered.includes(lawId)) return { ok: false, error: 'Pick one of the two offered laws.' };
    s.deck.push(...s.offered.filter((id) => id !== lawId));
    s.motion = { kind: 'enact', lawId };
  }
  s.offered = [];
  const sp = getPlayer(s, pid);
  log(s, `${sp.name} proposed ${s.motion.kind === 'repeal' ? 'repealing ' : ''}${LAWS[s.motion.lawId].name}.`);
  setPhase(s, 'debate', now, CONFIG.debateSeconds);
  s.ready = {};
  bump(s);
  return { ok: true };
}

function autoPropose(s, now, rng) {
  const lawId = s.offered[Math.floor(rng() * s.offered.length)];
  return propose(s, s.speakerId, { lawId }, now);
}

export function markReady(s, pid, now) {
  if (s.phase !== 'debate') return { ok: false, error: 'Debate is not open.' };
  const p = getPlayer(s, pid);
  if (!p || p.spectator) return { ok: false, error: 'Only ministers can call the vote.' };
  s.ready[pid] = true;
  bump(s);
  const humans = activePlayers(s).filter((x) => x.connected && !x.isBot);
  if (humans.every((x) => s.ready[x.id])) beginVote(s, now);
  return { ok: true };
}

function beginVote(s, now) {
  s.votes = {};
  s.lobbied = {};
  setPhase(s, 'vote', now, rulesNow(s).voteSeconds);
  bump(s);
}

export function castVote(s, pid, choice, now) {
  if (s.phase !== 'vote') return { ok: false, error: 'Voting is closed.' };
  if (choice !== 'aye' && choice !== 'nay') return { ok: false, error: 'Vote Aye or Nay.' };
  if (!canVote(s, pid)) return { ok: false, error: 'You cannot vote on this one.' };
  if (s.votes[pid]) return { ok: false, error: 'You already voted.' };
  s.votes[pid] = choice;
  bump(s);
  const waiting = activePlayers(s).filter((p) => present(p) && canVote(s, p.id) && !s.votes[p.id]);
  if (waiting.length === 0) resolveVote(s, now);
  return { ok: true };
}

export function lobby(s, pid) {
  if (s.phase !== 'vote') return { ok: false, error: 'Lobbying happens during the vote.' };
  if (!rulesNow(s).lobbying) return { ok: false, error: 'Lobbying is not legal right now.' };
  const p = getPlayer(s, pid);
  if (!p || !canVote(s, pid)) return { ok: false, error: 'You cannot vote on this one.' };
  if (s.votes[pid]) return { ok: false, error: 'Lobby before you vote.' };
  if (s.lobbied[pid]) return { ok: false, error: 'You already lobbied this round.' };
  if (p.influence < 1) return { ok: false, error: 'Lobbying costs 1 Influence.' };
  p.influence -= 1;
  s.lobbied[pid] = true;
  bump(s);
  return { ok: true };
}

function repealLaw(s, id, fx, reason) {
  const idx = s.constitution.indexOf(id);
  if (idx === -1) return;
  s.constitution.splice(idx, 1);
  s.deck.push(id);
  fx.note(`${LAWS[id].name} was repealed${reason ? ` (${reason})` : ''}.`);
}

export function resolveVote(s, now) {
  if (s.phase !== 'vote') return;
  const rules = rulesNow(s);
  const fx = makeFx(s);
  const motion = s.motion;
  const law = LAWS[motion.lawId];
  const voters = activePlayers(s).filter((p) => canVote(s, p.id));

  let ayes = 0;
  let nays = 0;
  const ballots = voters.map((p) => {
    const choice = s.votes[p.id] || 'nay';
    const weight = voteWeight(s, p.id);
    if (choice === 'aye') ayes += weight;
    else nays += weight;
    return { id: p.id, choice, weight, cast: !!s.votes[p.id], lobbied: !!s.lobbied[p.id] };
  });
  const total = ayes + nays;
  let passed =
    rules.threshold > 0.5 ? total > 0 && ayes * 3 >= total * 2 - 1e-9 && ayes > 0 : ayes > nays;

  const castBallots = ballots.filter((b) => b.cast);
  const unanimous =
    rules.unanimityPenalty &&
    castBallots.length >= 2 &&
    castBallots.length === ballots.length &&
    castBallots.every((b) => b.choice === castBallots[0].choice);

  if (unanimous) {
    passed = false;
    fx.note('Contrarian Act: everyone voted the same way, so it fails and everyone loses 1.');
    activePlayers(s).forEach((p) => fx.change(p, -1, 'Contrarian Act'));
  }

  const speaker = getPlayer(s, s.speakerId);

  if (passed) {
    if (motion.kind === 'repeal') {
      repealLaw(s, motion.lawId, fx, 'by vote');
    } else if (law.decree) {
      if (law.onEnact) law.onEnact(s, fx);
      if (law.tag === 'chaos') s.chaosPassed += 1;
      s.deck.push(law.id);
      fx.note(`${law.name} took effect once and left the table.`);
    } else {
      (law.conflicts || []).forEach((c) => repealLaw(s, c, fx, `replaced by ${law.name}`));
      s.constitution.push(law.id);
      if (s.constitution.length > CONFIG.maxConstitution) {
        repealLaw(s, s.constitution[0], fx, 'oldest law, the Constitution only holds 5');
      }
      if (law.onEnact) law.onEnact(s, fx);
      if (law.tag === 'chaos') s.chaosPassed += 1;
      fx.note(`${law.name} is now law: ${law.text}`);
    }
    activeLaws(s)
      .filter((l) => l.id !== law.id && typeof l.onLawPassed === 'function' && motion.kind === 'enact')
      .forEach((l) => l.onLawPassed(s, fx, law));
    if (speaker) {
      speaker.proposalsPassed += 1;
      fx.change(speaker, +2, 'Proposal passed');
    }
  } else if (motion.kind === 'enact') {
    s.deck.push(law.id);
  }

  if (!unanimous) {
    ballots
      .filter((b) => b.cast)
      .forEach((b) => {
        if ((b.choice === 'aye') === passed) {
          const p = getPlayer(s, b.id);
          p.votedWith += 1;
          fx.change(p, +1, 'Voted with the result');
        }
      });
  }

  // End-of-round laws (e.g. Wealth Tax) run once per round, right after the vote.
  activeLaws(s)
    .filter((l) => typeof l.onRoundEnd === 'function')
    .forEach((l) => l.onRoundEnd(s, fx));

  s.lastResult = {
    round: s.round,
    motion,
    passed,
    ayes,
    nays,
    threshold: rules.threshold,
    visibility: rules.visibility,
    unanimous,
    ballots,
    changes: fx.changes,
    notes: fx.notes,
  };
  log(s, `${motion.kind === 'repeal' ? 'Repeal of ' : ''}${law.name} ${passed ? 'passed' : 'failed'} ${ayes}–${nays}.`);
  setPhase(s, 'result', now, CONFIG.resultSeconds);
  bump(s);
}

function nextSpeaker(s) {
  const seated = activePlayers(s);
  const idx = seated.findIndex((p) => p.id === s.speakerId);
  for (let k = 1; k <= seated.length; k++) {
    const p = seated[(idx + k) % seated.length];
    if (present(p)) return p.id;
  }
  return seated[(idx + 1) % seated.length].id;
}

function nextRound(s, now) {
  if (s.round >= s.maxRounds) {
    finish(s, now);
    return;
  }
  s.round += 1;
  s.speakerId = nextSpeaker(s);
  beginProposal(s, now);
}

function finish(s, now) {
  const rows = activePlayers(s).map((p) => {
    const met = agendaMet(s, p);
    const bonus = met ? AGENDAS[p.agendaId].bonus : 0;
    return {
      id: p.id,
      name: p.name,
      ministry: p.ministry,
      agendaId: p.agendaId,
      base: p.influence,
      met,
      bonus,
      total: p.influence + bonus,
      proposalsPassed: p.proposalsPassed,
    };
  });
  rows.sort((a, b) => b.total - a.total || b.proposalsPassed - a.proposalsPassed);
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.rank = prev && prev.total === r.total && prev.proposalsPassed === r.proposalsPassed ? prev.rank : i + 1;
  });
  rows.forEach((r) => {
    getPlayer(s, r.id).influence = r.total;
  });
  s.finalScores = rows;
  setPhase(s, 'final', now, 0);
  log(s, `${rows[0].name} wins Tiny Parliament.`);
  bump(s);
}

export function playAgain(s, now) {
  if (s.phase !== 'final') return { ok: false, error: 'The game is still running.' };
  s.players = s.players.filter((p) => present(p) || p.id === s.hostId);
  let seats = 0;
  s.players.forEach((p) => {
    p.spectator = seats >= CONFIG.maxPlayers;
    if (!p.spectator) seats += 1;
    p.influence = CONFIG.startInfluence;
    p.agendaId = null;
    p.votedWith = 0;
    p.proposalsPassed = 0;
  });
  Object.assign(s, {
    phase: 'lobby',
    round: 0,
    speakerId: null,
    deck: [],
    offered: [],
    motion: null,
    constitution: [],
    votes: {},
    lobbied: {},
    ready: {},
    chaosPassed: 0,
    lastResult: null,
    finalScores: null,
    pausedFrom: null,
  });
  setPhase(s, 'lobby', now, 0);
  bump(s);
  return { ok: true };
}

// Moves the host role to the next connected human (used if the host's seat is
// handed over explicitly). Returns the new host id or null.
export function reassignHost(s) {
  const next = s.players.find((p) => p.connected && !p.isBot && p.id !== s.hostId);
  if (!next) return null;
  s.hostId = next.id;
  bump(s);
  return next.id;
}

// ---------- timers ----------

export function tick(s, now, rng = Math.random) {
  const v = s.version;
  const seatedPresent = activePlayers(s).filter(present).length;

  if (IN_GAME.includes(s.phase) && seatedPresent < CONFIG.minPlayers) {
    s.pausedFrom = { phase: s.phase, remaining: Math.max(0, s.phaseEndsAt - now) };
    s.phase = 'paused';
    log(s, 'Too few ministers present. The session is paused.');
    bump(s);
    return true;
  }
  if (s.phase === 'paused') {
    if (seatedPresent >= CONFIG.minPlayers && s.pausedFrom) {
      s.phase = s.pausedFrom.phase;
      s.phaseStartedAt = now;
      s.phaseEndsAt = now + Math.max(5000, s.pausedFrom.remaining);
      s.pausedFrom = null;
      if (s.phase === 'proposal' && !getPlayer(s, s.speakerId)?.connected && !getPlayer(s, s.speakerId)?.isBot) {
        s.phaseStartedAt = now; // give the absent-Speaker countdown a fresh start
      }
      log(s, 'Session resumed.');
      bump(s);
    }
    return s.version !== v;
  }

  if (s.phase === 'proposal') {
    const sp = getPlayer(s, s.speakerId);
    const absent = sp && !present(sp);
    if (now >= s.phaseEndsAt || (absent && now >= s.phaseStartedAt + CONFIG.speakerAbsentSeconds * 1000)) {
      autoPropose(s, now, rng);
      log(s, 'The clerk proposed a law on the Speaker’s behalf.');
    }
  } else if (s.phase === 'debate') {
    if (now >= s.phaseEndsAt) beginVote(s, now);
  } else if (s.phase === 'vote') {
    if (now >= s.phaseEndsAt) resolveVote(s, now);
  } else if (s.phase === 'result') {
    if (now >= s.phaseEndsAt) nextRound(s, now);
  }
  return s.version !== v;
}

// ---------- dispatcher ----------

export function act(s, pid, action, now, rng = Math.random) {
  const isHost = pid === s.hostId;
  switch (action?.type) {
    case 'start':
      if (!isHost) return { ok: false, error: 'Only the host can start the game.' };
      return startGame(s, now, rng);
    case 'addBot':
      if (!isHost) return { ok: false, error: 'Only the host can add bots.' };
      return addBot(s, rng);
    case 'remove':
      if (!isHost) return { ok: false, error: 'Only the host can remove players.' };
      return removePlayer(s, action.id);
    case 'propose':
      return propose(s, pid, action, now);
    case 'ready':
      return markReady(s, pid, now);
    case 'vote':
      return castVote(s, pid, action.choice, now);
    case 'lobby':
      return lobby(s, pid);
    case 'playAgain':
      if (!isHost) return { ok: false, error: 'Only the host can start a new game.' };
      return playAgain(s, now);
    default:
      return { ok: false, error: 'Unknown action.' };
  }
}

// ---------- per-player view (secrets stripped) ----------

export function viewFor(s, pid, now) {
  const me = getPlayer(s, pid);
  const rules = rulesNow(s);
  const isSpeaker = pid === s.speakerId;
  const showLive = s.phase === 'vote' && rules.visibility === 'live';

  let lastResult = null;
  if (s.lastResult) {
    const r = s.lastResult;
    lastResult = {
      ...r,
      ballots: r.visibility === 'totals' ? [] : r.ballots,
    };
  }

  return {
    code: s.code,
    version: s.version,
    phase: s.phase,
    round: s.round,
    maxRounds: s.maxRounds,
    hostId: s.hostId,
    speakerId: s.speakerId,
    remainingMs: s.phaseEndsAt ? Math.max(0, s.phaseEndsAt - now) : 0,
    pausedFrom: s.pausedFrom ? { phase: s.pausedFrom.phase } : null,
    motion: s.motion,
    offered: isSpeaker && s.phase === 'proposal' ? s.offered : [],
    constitution: s.constitution,
    chaosPassed: s.chaosPassed,
    deckCount: s.deck.length,
    rules,
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      ministry: p.ministry,
      influence: p.influence,
      connected: p.connected,
      isBot: p.isBot,
      spectator: p.spectator,
      ready: !!s.ready[p.id],
      hasVoted: !!s.votes[p.id],
      vote: showLive ? s.votes[p.id] || null : null,
      lobbied: s.phase === 'vote' && rules.visibility !== 'totals' ? !!s.lobbied[p.id] : false,
      proposalsPassed: p.proposalsPassed,
    })),
    you: me
      ? {
          id: me.id,
          agendaId: me.agendaId,
          spectator: me.spectator,
          isHost: pid === s.hostId,
          isSpeaker,
          vote: s.votes[pid] || null,
          lobbied: !!s.lobbied[pid],
          ready: !!s.ready[pid],
          canVote: s.phase === 'vote' ? canVote(s, pid) : canVote(s, pid),
          votedWith: me.votedWith,
        }
      : null,
    lastResult,
    finalScores: s.phase === 'final' ? s.finalScores : null,
    log: s.log.slice(-8),
  };
}
