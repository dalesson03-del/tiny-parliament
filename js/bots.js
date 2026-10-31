// Bot ministers, run by the host. They let one person try the game alone and
// fill seats in small groups. Bots follow their secret agenda with a little noise.

import { LAWS, AGENDAS, activePlayers } from './laws.js';
import { propose, markReady, castVote, canVote, getPlayer } from './engine.js';

function likes(bot, lawId, kind, s) {
  const agenda = AGENDAS[bot.agendaId];
  const law = LAWS[lawId];
  if (!agenda || !law) return 0;
  let score = 0;
  if (agenda.tag && agenda.tag === law.tag) score += 2;
  if (agenda.id === 'full') score += 1;
  if (agenda.id === 'minimal') score -= 2;
  if (agenda.id === 'proposer' && s.speakerId === bot.id) score += 2;
  if (law.id === 'wealth_tax') {
    const max = Math.max(...activePlayers(s).map((p) => p.influence));
    if (bot.influence === max) score -= 1;
  }
  return kind === 'repeal' ? -score : score;
}

export function runBots(s, now, rng = Math.random) {
  let acted = false;
  const elapsed = now - s.phaseStartedAt;

  if (s.phase === 'proposal') {
    const sp = getPlayer(s, s.speakerId);
    if (sp?.isBot && elapsed > 2500 && s.offered.length) {
      const ranked = s.offered
        .map((id) => ({ id, score: likes(sp, id, 'enact', s) + rng() }))
        .sort((a, b) => b.score - a.score);
      propose(s, sp.id, { lawId: ranked[0].id }, now);
      acted = true;
    }
  }

  if (s.phase === 'debate') {
    // Bots never hold up the debate; humans decide when to call the vote.
    activePlayers(s)
      .filter((p) => p.isBot && !s.ready[p.id])
      .forEach((p) => {
        s.ready[p.id] = true;
        acted = true;
      });
    if (acted) {
      s.version += 1;
      const anyHuman = activePlayers(s).find((p) => p.connected && !p.isBot);
      if (anyHuman && s.ready[anyHuman.id]) markReady(s, anyHuman.id, now);
    }
  }

  if (s.phase === 'vote') {
    const bots = activePlayers(s).filter((p) => p.isBot);
    for (const [i, bot] of bots.entries()) {
      if (s.phase !== 'vote') break;
      if (s.votes[bot.id] || !canVote(s, bot.id)) continue;
      if (elapsed < 1200 + i * 650) continue;
      const score = likes(bot, s.motion.lawId, s.motion.kind, s) + (rng() * 3 - 1.2);
      castVote(s, bot.id, score >= 0 ? 'aye' : 'nay', now);
      acted = true;
    }
  }

  return acted;
}
