// Law deck and secret agendas for Tiny Parliament.
// Each law is data plus optional rule hooks. The engine asks the active laws
// for answers (vote weight, pass threshold, timers...) instead of special-casing
// them in the game loop, so adding a law never means rewriting the loop.

export const TAGS = {
  power: { name: 'Power', icon: '👑' },
  money: { name: 'Money', icon: '💰' },
  speech: { name: 'Speech', icon: '📣' },
  chaos: { name: 'Chaos', icon: '🌀' },
};

export const LAWS = {
  double_speaker: {
    id: 'double_speaker',
    name: 'Double Speaker Act',
    tag: 'power',
    text: "The Speaker's vote counts twice.",
    voteWeight: (s, pid) => (pid === s.speakerId ? 2 : 1),
  },
  secret_ballot: {
    id: 'secret_ballot',
    name: 'Secret Ballot',
    tag: 'power',
    text: 'Only vote totals are shown, never who voted what.',
    conflicts: ['free_press'],
    voteVisibility: () => 'totals',
  },
  supermajority: {
    id: 'supermajority',
    name: 'Supermajority Act',
    tag: 'power',
    text: 'Laws need two thirds of the votes to pass.',
    passThreshold: () => 2 / 3,
  },
  wealth_tax: {
    id: 'wealth_tax',
    name: 'Wealth Tax',
    tag: 'money',
    text: 'At the end of each round, the leader loses 1 Influence and last place gains 1.',
    onRoundEnd: (s, fx) => {
      const ps = activePlayers(s);
      if (ps.length < 2) return;
      const vals = ps.map((p) => p.influence);
      const hi = Math.max(...vals);
      const lo = Math.min(...vals);
      if (hi === lo) return;
      ps.filter((p) => p.influence === hi).forEach((p) => fx.change(p, -1, 'Wealth Tax'));
      ps.filter((p) => p.influence === lo).forEach((p) => fx.change(p, +1, 'Wealth Tax'));
    },
  },
  lobbying: {
    id: 'lobbying',
    name: 'Lobbying Act',
    tag: 'money',
    text: 'Each round, any minister may pay 1 Influence to add 1 extra vote.',
    allowsLobbying: () => true,
  },
  stimulus: {
    id: 'stimulus',
    name: 'Stimulus Package',
    tag: 'money',
    text: 'Everyone gains 1 Influence now, and again every time another Money law passes.',
    onEnact: (s, fx) => activePlayers(s).forEach((p) => fx.change(p, +1, 'Stimulus')),
    onLawPassed: (s, fx, law) => {
      if (law.tag === 'money' && law.id !== 'stimulus') {
        activePlayers(s).forEach((p) => fx.change(p, +1, 'Stimulus'));
      }
    },
  },
  free_press: {
    id: 'free_press',
    name: 'Free Press Act',
    tag: 'speech',
    text: 'Every vote is shown live, the moment it is cast.',
    conflicts: ['secret_ballot'],
    voteVisibility: () => 'live',
  },
  gag_order: {
    id: 'gag_order',
    name: 'Gag Order',
    tag: 'speech',
    text: 'The Speaker may not vote on their own proposal.',
    canVote: (s, pid) => pid !== s.speakerId,
  },
  right_to_repeal: {
    id: 'right_to_repeal',
    name: 'Right to Repeal',
    tag: 'speech',
    text: 'The Speaker may propose repealing an active law instead of a new one.',
    allowsRepeal: () => true,
  },
  speed_session: {
    id: 'speed_session',
    name: 'Speed Session',
    tag: 'chaos',
    text: 'Voting time drops to 10 seconds.',
    voteSeconds: () => 10,
  },
  contrarian: {
    id: 'contrarian',
    name: 'Contrarian Act',
    tag: 'chaos',
    text: 'If everyone votes the same way, the proposal fails and everyone loses 1 Influence.',
    unanimityPenalty: () => true,
  },
  agenda_shuffle: {
    id: 'agenda_shuffle',
    name: 'Agenda Shuffle',
    tag: 'chaos',
    decree: true,
    text: 'Decree: every secret agenda passes one seat to the left. Takes effect once.',
    onEnact: (s, fx) => {
      const ps = activePlayers(s);
      if (ps.length < 2) return;
      const agendas = ps.map((p) => p.agendaId);
      ps.forEach((p, i) => {
        p.agendaId = agendas[(i + 1) % ps.length];
      });
      fx.note('Every secret agenda moved one seat to the left. Check yours.');
    },
  },
};

export const LAW_IDS = Object.keys(LAWS);

export const AGENDAS = {
  power2: { id: 'power2', text: 'At least 2 Power laws are active at the end', bonus: 4, tag: 'power' },
  money2: { id: 'money2', text: 'At least 2 Money laws are active at the end', bonus: 4, tag: 'money' },
  speech2: { id: 'speech2', text: 'At least 2 Speech laws are active at the end', bonus: 4, tag: 'speech' },
  chaos2: { id: 'chaos2', text: 'At least 2 Chaos laws pass during the game (Decrees count)', bonus: 4, tag: 'chaos' },
  loyal: { id: 'loyal', text: 'You vote with the result in 6 or more rounds', bonus: 3 },
  proposer: { id: 'proposer', text: '3 of your own proposals pass', bonus: 3 },
  full: { id: 'full', text: 'The Constitution is full (5 laws) at the end', bonus: 3 },
  minimal: { id: 'minimal', text: 'No more than 2 laws are active at the end', bonus: 4 },
};

export const AGENDA_IDS = Object.keys(AGENDAS);

export function agendaMet(s, player) {
  const a = AGENDAS[player.agendaId];
  if (!a) return false;
  const active = s.constitution.map((id) => LAWS[id]);
  const countTag = (t) => active.filter((l) => l.tag === t).length;
  switch (a.id) {
    case 'power2':
      return countTag('power') >= 2;
    case 'money2':
      return countTag('money') >= 2;
    case 'speech2':
      return countTag('speech') >= 2;
    case 'chaos2':
      return s.chaosPassed >= 2;
    case 'loyal':
      return player.votedWith >= 6;
    case 'proposer':
      return player.proposalsPassed >= 3;
    case 'full':
      return s.constitution.length >= 5;
    case 'minimal':
      return s.constitution.length <= 2;
    default:
      return false;
  }
}

export const MINISTRIES = [
  'Minister of Socks',
  'Minister of Suspicious Weather',
  'Minister of Snacks',
  'Minister of Naps',
  'Minister of Loud Opinions',
  'Minister of Lost Umbrellas',
  'Minister of Pigeons',
  'Minister of Fancy Hats',
  'Minister of Puddles',
  'Minister of Second Breakfast',
  'Minister of Mild Panic',
  'Minister of Paperwork',
];

// Players who hold a seat in this game (not spectators).
export function activePlayers(s) {
  return s.players.filter((p) => !p.spectator);
}
