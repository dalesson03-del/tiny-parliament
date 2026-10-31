// End-to-end playthrough: a host and two players in separate tabs, plus a bot,
// play a full 8-round game. Networking uses tests/fake-peer.js so it runs
// offline. Usage: serve the repo on :5173, then `node tests/e2e.mjs`.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:5173/';
const SHOTS = process.env.SHOTS || 'test-shots';
mkdirSync(SHOTS, { recursive: true });
const fake = readFileSync(new URL('./fake-peer.js', import.meta.url), 'utf8');

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await ctx.addInitScript(fake);
await ctx.route(/unpkg\.com|jsdelivr\.net/, (r) => r.abort());

const errors = [];
const page = async (name) => {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/fonts|Failed to load resource/.test(m.text()) && errors.push(`${name}: ${m.text()}`));
  p.on('dialog', (d) => d.accept());
  return p;
};
const shot = (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const phase = (p) => p.evaluate(() => document.getElementById('app').dataset.phase || 'home');

// Host creates a room.
const host = await page('host');
await host.goto(BASE);
await shot(host, '01-home');
await host.fill('#name', 'Edwin');
await host.click('[data-intent="create"]');
await host.waitForSelector('.codeplate-code');
const code = (await host.textContent('.codeplate-code')).trim();
console.log('room', code);

// Two players join with the invite link.
const players = [host];
for (const name of ['Amina', 'Kofi']) {
  const p = await page(name);
  await p.goto(`${BASE}?join=${code}`);
  await p.fill('#name', name);
  await p.click('[data-intent="join"]');
  await p.waitForSelector('.codeplate-code');
  players.push(p);
}
// Wrong code and duplicate name are rejected cleanly.
const bad = await page('bad');
await bad.goto(`${BASE}?join=ZZZZ`);
await bad.fill('#name', 'Lost');
await bad.click('[data-intent="join"]');
await bad.waitForSelector('.form-error', { timeout: 20000 });
console.log('bad code ->', await bad.textContent('.form-error'));
await bad.goto(`${BASE}?join=${code}`);
await bad.fill('#name', 'amina');
await bad.click('[data-intent="join"]');
await bad.waitForSelector('.form-error', { timeout: 20000 });
console.log('dup name ->', await bad.textContent('.form-error'));
await bad.close();

await host.click('[data-act="addBot"]');
await sleep(400);
await shot(host, '02-lobby-host');
await shot(players[1], '03-lobby-player');
await host.click('[data-act="start"]');

const seen = new Set();
let reloadedPlayer = false;
let reloadedHost = false;
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  const ph = await phase(host);
  if (ph === 'final') break;
  for (const [i, p] of players.entries()) {
    const pph = await phase(p);
    const key = `${pph}-${i}`;
    if (!seen.has(key) && ['proposal', 'debate', 'vote', 'result'].includes(pph)) {
      seen.add(key);
      await shot(p, `10-${pph}-p${i}`);
    }
    try {
      if (pph === 'proposal' && (await p.$('[data-act="propose"]'))) {
        await p.click('[data-act="propose"] >> nth=0');
      } else if (pph === 'debate' && (await p.$('[data-act="ready"]:not([disabled])'))) {
        if (i === 0 && !seen.has('react')) {
          seen.add('react');
          await p.click('[data-react="😂"]');
        }
        await p.click('[data-act="ready"]');
      } else if (pph === 'vote' && (await p.$('[data-act="vote"]'))) {
        await p.click(`[data-act="vote"][data-choice="${Math.random() > 0.4 ? 'aye' : 'nay'}"]`);
      }
    } catch {
      /* the screen re-rendered mid-click; next pass */
    }
  }
  // Mid-game reconnect checks.
  const round = await host.evaluate(() => document.querySelector('.tb-round')?.textContent || '');
  if (!reloadedPlayer && round.startsWith('Round 3')) {
    reloadedPlayer = true;
    const agendaBefore = await players[1].evaluate(() => sessionStorage.getItem('tp-session'));
    await players[1].reload();
    await players[1].waitForSelector('.topbar', { timeout: 20000 });
    const agendaAfter = await players[1].evaluate(() => sessionStorage.getItem('tp-session'));
    console.log('player refresh rejoined same seat:', agendaBefore === agendaAfter);
  }
  if (!reloadedHost && round.startsWith('Round 5')) {
    reloadedHost = true;
    await host.reload();
    await host.waitForSelector('.topbar', { timeout: 60000 });
    console.log('host refresh reopened room:', (await host.textContent('.tb-code')).trim() === code);
  }
  await sleep(350);
}

const finalPhase = await phase(host);
console.log('final phase:', finalPhase, 'after', Math.round((Date.now() - t0) / 1000), 's');
await sleep(4000);
for (const [i, p] of players.entries()) await shot(p, `20-final-p${i}`);
const winners = await Promise.all(players.map((p) => p.textContent('.stage-title').catch(() => '?')));
console.log('winner as seen by each player:', winners);

// Open the Constitution sheet once for a screenshot.
await host.click('[data-act="playAgain"]');
await sleep(500);
console.log('play again ->', await phase(players[2]));

// Desktop layout check.
await host.setViewportSize({ width: 1280, height: 860 });
await shot(host, '30-desktop-lobby');

console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(finalPhase === 'final' && errors.length === 0 ? 0 : 1);
