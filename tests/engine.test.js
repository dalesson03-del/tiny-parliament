import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame,
  addPlayer,
  act,
  tick,
  viewFor,
  setConnected,
  CONFIG,
  getPlayer,
} from '../js/engine.js';
import { runBots } from '../js/bots.js';
import { LAWS } from '../js/laws.js';

// Deterministic RNG so tests are repeatable.
function seeded(seed = 42) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

function setup(n = 4, rng = seeded()) {
  const s = createGame('ABCD');
  for (let i = 0; i < n; i++) addPlayer(s, { id: 'p' + i, name: 'Player' + i }, rng);
  return s;
}

function start(s, rng = seeded()) {
  const r = act(s, s.hostId, { type: 'start' }, 0, rng);
  assert.equal(r.ok, true, r.error);
}

// Force a specific motion onto the table, then run the vote.
function passLaw(s, lawId, votes, now = 1000) {
  s.phase = 'proposal';
  s.offered = [lawId, s.deck.find((id) => id !== lawId && !s.constitution.includes(id))];
  s.deck = s.deck.filter((id) => !s.offered.includes(id));
  assert.equal(act(s, s.speakerId, { type: 'propose', lawId }, now).ok, true);
  s.players.forEach((p) => act(s, p.id, { type: 'ready' }, now));
  assert.equal(s.phase, 'vote');
  Object.entries(votes).forEach(([pid, choice]) => act(s, pid, { type: 'vote', choice }, now));
  if (s.phase === 'vote') tick(s, s.phaseEndsAt + 1);
  return s.lastResult;
}

test('lobby: names, duplicates, host, minimum players', () => {
  const s = createGame('ABCD');
  assert.equal(addPlayer(s, { id: 'a', name: '  Ann  ' }).ok, true);
  assert.equal(s.hostId, 'a');
  assert.equal(addPlayer(s, { id: 'b', name: 'ann' }).ok, false);
  assert.equal(addPlayer(s, { id: 'c', name: '' }).ok, false);
  addPlayer(s, { id: 'b', name: 'Ben' });
  assert.equal(act(s, 'a', { type: 'start' }, 0).ok, false, 'needs 3');
  assert.equal(act(s, 'b', { type: 'addBot' }, 0).ok, false, 'only host adds bots');
  assert.equal(act(s, 'a', { type: 'addBot' }, 0).ok, true);
  assert.equal(act(s, 'a', { type: 'start' }, 0).ok, true);
  assert.equal(s.phase, 'proposal');
});

test('late joiner becomes a spectator and rejoin keeps the seat', () => {
  const s = setup(3);
  start(s);
  const r = addPlayer(s, { id: 'late', name: 'Late' });
  assert.equal(r.player.spectator, true);
  const agenda = getPlayer(s, 'p1').agendaId;
  setConnected(s, 'p1', false);
  const again = addPlayer(s, { id: 'p1', name: 'whatever' });
  assert.equal(again.rejoined, true);
  assert.equal(getPlayer(s, 'p1').agendaId, agenda);
});

test('secrets never leak into other players views', () => {
  const s = setup(4);
  start(s);
  const other = s.players.find((p) => p.id !== s.speakerId);
  const v = viewFor(s, other.id, 0);
  assert.deepEqual(v.offered, [], 'only the speaker sees the offered laws');
  const json = JSON.stringify(v);
  s.players
    .filter((p) => p.id !== other.id)
    .forEach((p) => assert.ok(!json.includes(`"agendaId":"${p.agendaId}"`) || p.agendaId === other.agendaId));
  assert.equal(viewFor(s, s.speakerId, 0).offered.length, 2);
});

test('majority passes, ties fail, scoring', () => {
  const s = setup(4);
  start(s);
  const sp = s.speakerId;
  const ids = s.players.map((p) => p.id);
  const others = ids.filter((id) => id !== sp);
  const r = passLaw(s, 'lobbying', { [sp]: 'aye', [others[0]]: 'aye', [others[1]]: 'aye', [others[2]]: 'nay' });
  assert.equal(r.passed, true);
  assert.ok(s.constitution.includes('lobbying'));
  assert.equal(getPlayer(s, sp).influence, 3 + 2 + 1);
  assert.equal(getPlayer(s, others[2]).influence, 3);

  const s2 = setup(4);
  start(s2);
  const sp2 = s2.speakerId;
  const o2 = s2.players.map((p) => p.id).filter((id) => id !== sp2);
  const r2 = passLaw(s2, 'lobbying', { [sp2]: 'aye', [o2[0]]: 'aye', [o2[1]]: 'nay', [o2[2]]: 'nay' });
  assert.equal(r2.passed, false, 'ties fail');
});

test('no vote counts as Nay', () => {
  const s = setup(3);
  start(s);
  const sp = s.speakerId;
  const r = passLaw(s, 'lobbying', { [sp]: 'aye' });
  assert.equal(r.passed, false);
  assert.equal(r.nays, 2);
});

test('Double Speaker, Supermajority and Gag Order change voting', () => {
  const s = setup(4);
  start(s);
  s.constitution = ['double_speaker'];
  const sp = s.speakerId;
  const o = s.players.map((p) => p.id).filter((id) => id !== sp);
  let r = passLaw(s, 'lobbying', { [sp]: 'aye', [o[0]]: 'aye', [o[1]]: 'nay', [o[2]]: 'nay' });
  assert.equal(r.ayes, 3);
  assert.equal(r.passed, true);

  s.constitution = ['supermajority'];
  r = passLaw(s, 'wealth_tax', { [sp]: 'aye', [o[0]]: 'aye', [o[1]]: 'nay', [o[2]]: 'aye' });
  assert.equal(r.passed, true, '3 of 4 is over two thirds');
  s.constitution = ['supermajority'];
  r = passLaw(s, 'free_press', { [sp]: 'aye', [o[0]]: 'aye', [o[1]]: 'nay', [o[2]]: 'nay' });
  assert.equal(r.passed, false);

  s.constitution = ['gag_order'];
  r = passLaw(s, 'contrarian', { [sp]: 'aye', [o[0]]: 'aye', [o[1]]: 'aye', [o[2]]: 'nay' });
  assert.equal(r.ballots.find((b) => b.id === sp), undefined, 'speaker may not vote');
  assert.equal(r.ayes, 2);
});

test('Secret Ballot and Free Press repeal each other and change visibility', () => {
  const s = setup(3);
  start(s);
  const all = (c) => Object.fromEntries(s.players.map((p) => [p.id, c]));
  passLaw(s, 'secret_ballot', all('aye'));
  assert.deepEqual(s.constitution, ['secret_ballot']);
  passLaw(s, 'free_press', all('aye'));
  assert.deepEqual(s.constitution, ['free_press']);
  const v = viewFor(s, 'p0', 0);
  assert.equal(v.rules.visibility, 'live');
  s.constitution = ['secret_ballot'];
  const r = passLaw(s, 'lobbying', all('aye'));
  assert.equal(r.visibility, 'totals');
  assert.deepEqual(viewFor(s, 'p0', 0).lastResult.ballots, []);
});

test('Constitution holds 5 laws, the oldest is repealed', () => {
  const s = setup(3);
  start(s);
  s.constitution = ['double_speaker', 'supermajority', 'lobbying', 'wealth_tax', 'speed_session'];
  s.deck = s.deck.filter((id) => !s.constitution.includes(id));
  const all = Object.fromEntries(s.players.map((p) => [p.id, 'aye']));
  passLaw(s, 'gag_order', all);
  assert.equal(s.constitution.length, 5);
  assert.ok(!s.constitution.includes('double_speaker'));
  assert.ok(s.deck.includes('double_speaker'));
});

test('Agenda Shuffle is a decree and rotates agendas', () => {
  const s = setup(3);
  start(s);
  const before = s.players.map((p) => p.agendaId);
  const all = Object.fromEntries(s.players.map((p) => [p.id, 'aye']));
  passLaw(s, 'agenda_shuffle', all);
  assert.ok(!s.constitution.includes('agenda_shuffle'));
  assert.deepEqual(
    s.players.map((p) => p.agendaId),
    [before[1], before[2], before[0]]
  );
  assert.equal(s.chaosPassed, 1);
});

test('Contrarian Act punishes unanimous votes', () => {
  const s = setup(3);
  start(s);
  s.constitution = ['contrarian'];
  const all = Object.fromEntries(s.players.map((p) => [p.id, 'aye']));
  const before = s.players.map((p) => p.influence);
  const r = passLaw(s, 'lobbying', all);
  assert.equal(r.passed, false);
  assert.equal(r.unanimous, true);
  s.players.forEach((p, i) => assert.equal(p.influence, before[i] - 1));
});

test('Stimulus, Wealth Tax and Lobbying move Influence', () => {
  const s = setup(3);
  start(s);
  const all = Object.fromEntries(s.players.map((p) => [p.id, 'aye']));
  passLaw(s, 'stimulus', all);
  // 3 start +1 stimulus +1 voted with, speaker +2 more
  const sp = getPlayer(s, s.speakerId);
  assert.equal(sp.influence, 7);
  const others = s.players.filter((p) => p.id !== sp.id);
  others.forEach((p) => assert.equal(p.influence, 5));
  passLaw(s, 'lobbying', all); // money law -> stimulus +1 everyone
  assert.equal(others[0].influence, 7);

  s.constitution = ['lobbying'];
  s.phase = 'proposal';
  s.offered = ['gag_order', 'speed_session'];
  act(s, s.speakerId, { type: 'propose', lawId: 'gag_order' }, 0);
  s.players.forEach((p) => act(s, p.id, { type: 'ready' }, 0));
  const lobbyist = others[0];
  const inf = lobbyist.influence;
  assert.equal(act(s, lobbyist.id, { type: 'lobby' }, 0).ok, true);
  assert.equal(act(s, lobbyist.id, { type: 'lobby' }, 0).ok, false, 'once per round');
  assert.equal(lobbyist.influence, inf - 1);
  act(s, lobbyist.id, { type: 'vote', choice: 'nay' }, 0);
  act(s, others[1].id, { type: 'vote', choice: 'aye' }, 0);
  act(s, sp.id, { type: 'vote', choice: 'aye' }, 0);
  assert.equal(s.lastResult.nays, 2);
  assert.equal(s.lastResult.passed, false, '2 vs 2 tie fails');

  s.constitution = ['wealth_tax'];
  s.players.forEach((p, i) => (p.influence = [10, 5, 1][i]));
  passLaw(s, 'speed_session', { p0: 'nay', p1: 'nay', p2: 'nay' });
  // nobody voted with an aye... all nay, law failed -> each +1, then tax
  assert.equal(getPlayer(s, 'p0').influence, 10);
  assert.equal(getPlayer(s, 'p2').influence, 3);
});

test('Right to Repeal lets the Speaker repeal an active law', () => {
  const s = setup(3);
  start(s);
  s.constitution = ['right_to_repeal', 'supermajority'];
  s.phase = 'proposal';
  s.offered = ['gag_order', 'speed_session'];
  assert.equal(act(s, s.speakerId, { type: 'propose', repealId: 'supermajority' }, 0).ok, true);
  s.players.forEach((p) => act(s, p.id, { type: 'ready' }, 0));
  s.players.forEach((p) => act(s, p.id, { type: 'vote', choice: 'aye' }, 0));
  assert.equal(s.lastResult.passed, true);
  assert.deepEqual(s.constitution, ['right_to_repeal']);
});

test('absent speaker gets an automatic proposal after 15s; pause below 3', () => {
  const s = setup(3);
  start(s);
  setConnected(s, s.speakerId, false);
  tick(s, 0);
  assert.equal(s.phase, 'paused');
  addPlayer(s, { id: s.speakerId, name: 'x' });
  tick(s, 100);
  assert.equal(s.phase, 'proposal');
  const s2 = setup(4);
  start(s2);
  setConnected(s2, s2.speakerId, false);
  tick(s2, CONFIG.speakerAbsentSeconds * 1000 + 1);
  assert.equal(s2.phase, 'debate');
});

test('a full 8-round game with bots reaches the final screen with agenda bonuses', () => {
  const rng = seeded(7);
  const s = createGame('WXYZ');
  addPlayer(s, { id: 'human', name: 'Edwin' }, rng);
  for (let i = 0; i < 5; i++) act(s, 'human', { type: 'addBot' }, 0, rng);
  start(s, rng);
  let now = 0;
  let guard = 0;
  while (s.phase !== 'final' && guard++ < 5000) {
    now += 500;
    if (s.speakerId === 'human' && s.phase === 'proposal') act(s, 'human', { type: 'propose', lawId: s.offered[0] }, now);
    if (s.phase === 'debate') act(s, 'human', { type: 'ready' }, now);
    if (s.phase === 'vote' && !s.votes.human) act(s, 'human', { type: 'vote', choice: rng() > 0.5 ? 'aye' : 'nay' }, now);
    runBots(s, now, rng);
    tick(s, now, rng);
    assert.ok(s.constitution.length <= 5);
    assert.ok(s.offered.every((id) => LAWS[id]));
  }
  assert.equal(s.phase, 'final');
  assert.equal(s.round, 8);
  assert.equal(s.finalScores.length, 6);
  const top = s.finalScores[0];
  assert.ok(s.finalScores.every((r) => r.total <= top.total));
  // Deck + constitution always account for every law.
  const all = new Set([...s.deck, ...s.constitution]);
  assert.equal(all.size, 12);

  assert.equal(act(s, 'human', { type: 'playAgain' }, now).ok, true);
  assert.equal(s.phase, 'lobby');
  assert.ok(s.players.every((p) => p.influence === 3));
});
