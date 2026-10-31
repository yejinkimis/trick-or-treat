const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCandyChallenge } = require('../server/candy-challenge.cjs');
const challenge = { createdAt: 1000, level: 1, seed: 42, path: [{ t: 0, y: .05 }, { t: 30000, y: .05 }] };
test('server replays candy-bar inputs instead of trusting a claimed result', () => {
  const won = evaluateCandyChallenge(challenge, [1, 1], 6000, 8000);
  assert.equal(won.valid, true);
  assert.equal(won.won, true);
  assert.equal(won.finished, true);

  const missed = evaluateCandyChallenge(challenge, [], 2800, 6000);
  assert.equal(missed.valid, true);
  assert.equal(missed.won, false);
  assert.equal(missed.finished, true);

  const unfinished = evaluateCandyChallenge(challenge, [1, 1], 2000, 8000);
  assert.equal(unfinished.finished, false);
  const longMiss = evaluateCandyChallenge(challenge, [], 20000, 22000);
  assert.equal(longMiss.valid, true);
  assert.equal(longMiss.won, false);
  assert.ok(longMiss.at < 20000, 'the gauge reaching zero ends the game before the supplied trace ends');
  assert.equal(evaluateCandyChallenge(challenge, [], 2000, 1500).valid, false);
  assert.equal(evaluateCandyChallenge(challenge, [NaN, 1], 2000, 6000).valid, false);
  assert.equal(evaluateCandyChallenge(challenge, [1, 1, 2, 0], 2000, 6000).valid, false);
});

test('alchemy costs thirty pumpkins and rolls follow the original 20/50/30 table', () => {
  const { brewGain, BREW_COST, BREW_COOLDOWN_MS } = require('../server/game-service.cjs');
  assert.equal(BREW_COST, 30);
  assert.equal(BREW_COOLDOWN_MS, 5 * 60 * 1000);
  assert.deepEqual([0, 19, 20, 69, 70, 99].map((roll) => brewGain(roll)), [0, 0, 2, 2, 5, 5]);
  const counts = {};
  for (let roll = 0; roll < 100; roll++) {
    const gain = brewGain(roll);
    counts[gain] = (counts[gain] || 0) + 1;
  }
  assert.deepEqual(counts, { 0: 20, 2: 50, 5: 30 });
});

const { WATCH, hourOf, summarize, watchList } = require('../server/watch.cjs');
test('watch numbers cover the last day of challenges, candy flow and active hours, and only mark accounts', () => {
  const now = Date.UTC(2026, 9, 31, 12), HOUR = 3600000, prices = { lantern: 2 };
  const tries = Array.from({ length: 24 }, (_, i) => ({ at: now - i * HOUR, h: i < 12 ? 'alt' : 'other', w: i !== 23, ms: 4000 + i * 100, lv: 1, m: i !== 23 }));
  const bot = {
    id: 'bot', nick: '봇', costume: 'ghost',
    challenges: [...tries, { at: now - 30 * HOUR, h: 'old', w: true, ms: 1, lv: 1, m: true }],
    brews: [{ at: now - HOUR, n: 5 }, { at: now - 40 * HOUR, n: 5 }],
    decor: { lantern: { at: now - HOUR } },
    guests: [{ r: 'win', moved: true, at: now - HOUR, v: 'x' }, { r: 'win', moved: false, at: now - HOUR, v: 'y' }],
    harvestHours: { [hourOf(now)]: 30, [hourOf(now - 30 * HOUR)]: 99 },
  };
  const s = summarize(bot, { now, prices, nickOf: (id) => id });
  assert.equal(s.tries, 24);
  assert.equal(s.wins, 23);
  assert.equal(s.fastestWinMs, 4000);
  assert.deepEqual(s.candy, { knocks: 23, brews: 5, decor: -2, lost: -1, net: 25 });
  assert.equal(s.harvests, 30);
  assert.equal(s.activeHours, 24);
  assert.deepEqual(s.topSource, { id: 'alt', nick: 'alt', wins: 12, share: 12 / 23 });
  assert.deepEqual(s.flags, ['성공률 높음', '오래 쉬지 않음', '한 집에서 몰아 받음']);

  const casual = { id: 'me', nick: '나', costume: 'cat', challenges: [{ at: now, h: 'bot', w: true, ms: 9000, lv: 1, m: true }] };
  const list = watchList([casual, bot, { id: 'idle', nick: '쉼', costume: 'cat' }], { now, prices });
  assert.deepEqual(list.map((u) => u.id), ['bot', 'me'], 'flagged first, inactive left out');
  assert.deepEqual(list[1].flags, []);
  assert.equal(WATCH.minTries, 20);
});

const { CHALLENGE_MAX_MS } = require('../server/candy-challenge.cjs');
test('a challenge still undecided at ninety seconds ends as a loss', () => {
  // 사탕이 막대 안팎을 오가며 잡기 게이지가 끝까지 차지도 비지도 않는 경로
  const path = [{ t: 0, y: 1 }, ...Array.from({ length: 63 }, (_, i) => ({ t: (i + 1) * 1440, y: i % 2 ? 1 : .47 }))];
  const hovering = { createdAt: 0, level: 1, path };
  const before = evaluateCandyChallenge(hovering, [], CHALLENGE_MAX_MS - 20, CHALLENGE_MAX_MS);
  assert.equal(before.finished, false);
  const after = evaluateCandyChallenge(hovering, [], CHALLENGE_MAX_MS, CHALLENGE_MAX_MS + 500);
  assert.deepEqual([after.valid, after.finished, after.won, after.timedOut, after.at], [true, true, false, true, CHALLENGE_MAX_MS]);
});
