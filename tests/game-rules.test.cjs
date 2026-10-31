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

test('alchemy rolls follow the 80/14/5/1 table and never come up empty', () => {
  const { brewGain } = require('../server/game-service.cjs');
  assert.deepEqual([0, 79, 80, 93, 94, 98, 99].map((roll) => brewGain(roll)), [2, 2, 5, 5, 10, 10, 20]);
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

const { miniPlan, miniJudge, pickGame, evaluateChallenge } = require('../server/minigames.cjs');
const encode = (taps) => { let prev = 0; return taps.flatMap(({ t, v }) => { const tick = Math.ceil(t / 20); const out = [tick - prev, v]; prev = tick; return out; }); };
function bestPlay(game, plan) {
  if (game === 'whack') return plan.items.filter((item) => !item.bad).map((item) => ({ t: item.from + 100, v: item.k }));
  if (game === 'spell') return plan.items.map((item, i) => ({ t: plan.open + 300 * (i + 1), v: item.k }));
  const taps = [];
  let x = .5, dir = 0;
  for (let time = 20; time <= plan.end; time += 20) {
    const goal = plan.items.find((item) => !item.bad && item.t >= time);
    const want = !goal || Math.abs(goal.x - x) < .02 ? 0 : goal.x < x ? 1 : 2;
    if (want !== dir) { taps.push({ t: time, v: want }); dir = want; }
    const step = want === 1 ? -1 : want === 2 ? 1 : 0;
    x = Math.max(0, Math.min(1, x + step * plan.speed * 20 / 1000));
  }
  return taps;
}

test('every mini game is won by clean play and lost by doing nothing, on every level', () => {
  for (const game of ['whack', 'spell', 'catch']) {
    for (let level = 1; level <= 5; level++) {
      for (const seed of [1, 99, 123456, 0xfffffff0]) {
        const plan = miniPlan(game, level, seed);
        const challenge = { game, level, seed, createdAt: 0 };
        const won = evaluateChallenge(challenge, encode(bestPlay(game, plan)), 90000, 100000);
        assert.deepEqual([game, level, seed, won.valid, won.finished, won.won], [game, level, seed, true, true, true]);
        const idle = evaluateChallenge(challenge, [], 90000, 100000);
        assert.deepEqual([game, idle.valid, idle.finished, idle.won], [game, true, true, false]);
        assert.ok(idle.at < 60000, `${game} ${level} ends in time`);
      }
    }
  }
});

test('mini games wait for the end, reject impossible input and fall back to fishing for old challenges', () => {
  const challenge = { game: 'whack', level: 1, seed: 7, createdAt: 0 };
  assert.equal(evaluateChallenge(challenge, [], 1000, 100000).finished, false);
  assert.equal(evaluateChallenge(challenge, [1, 9], 1000, 100000).valid, false);
  assert.equal(evaluateChallenge({ ...challenge, game: 'catch' }, [5, 0], 1000, 100000).valid, false);
  assert.equal(evaluateChallenge(challenge, [], 9000, 5000).valid, false);
  const spammed = evaluateChallenge(challenge, Array.from({ length: 200 }, (_, i) => (i % 2 ? (i >> 1) % 9 : 1)), 4000, 100000);
  assert.deepEqual([spammed.finished, spammed.won], [true, false]);
  const fishing = evaluateChallenge({ game: 'spell', level: 1, seed: 1, createdAt: 1000, path: [{ t: 0, y: .05 }, { t: 30000, y: .05 }] }, [1, 1], 6000, 8000);
  assert.equal(fishing.won, true);
});

test('hitting poop in the ghost game counts as a mistake', () => {
  const plan = miniPlan('whack', 1, 11), poop = plan.items.find((item) => item.bad);
  const result = miniJudge('whack', plan, [{ t: poop.from + 100, v: poop.k }], poop.from + 120);
  const idle = miniJudge('whack', plan, [], poop.from + 120);
  assert.deepEqual([result.hits, result.misses - idle.misses, result.state[plan.items.indexOf(poop)]], [0, 1, 'miss']);
  const skipped = miniJudge('whack', plan, [], poop.to + 20);
  assert.equal(skipped.state[plan.items.indexOf(poop)], 'pass', 'letting poop go is fine');
});

test('the server only picks games the knocking page can play', () => {
  assert.equal(pickGame(undefined), 'fish');
  const seen = new Set(Array.from({ length: 200 }, () => pickGame(['rhythm', 'whack', 'spell', 'catch', 'nope'])));
  assert.deepEqual([...seen].sort(), ['catch', 'fish', 'spell', 'whack']);
  process.env.GAME_MINIGAMES = 'whack';
  try { assert.equal(pickGame(['spell', 'whack']), 'whack'); } finally { delete process.env.GAME_MINIGAMES; }
});

test('candy rain runs from 22:30 to midnight, and can be changed or turned off', () => {
  const { rainSchedule, checkDrop } = require('../server/candy-rain.cjs');
  const before = process.env.GAME_CANDY_RAIN_AT;
  try {
    delete process.env.GAME_CANDY_RAIN_AT;
    const rains = rainSchedule();
    assert.deepEqual(rains.map((rain) => [new Date(rain.at).toISOString(), rain.ms / 60000]), [['2026-10-31T13:30:00.000Z', 90]]);
    const [last] = rains;
    assert.equal(last.at + last.ms, Date.parse('2026-11-01T00:00:00+09:00'));
    assert.deepEqual(checkDrop(`${last.at}-1349`, last.at + 1349 * 4000), { rain: last.at, i: 1349 });
    assert.ok(checkDrop(`${last.at}-1350`, last.at + 1350 * 4000).error, 'no drop after midnight');
    process.env.GAME_CANDY_RAIN_AT = '';
    assert.deepEqual(rainSchedule(), []);
    process.env.GAME_CANDY_RAIN_AT = '2026-10-31T20:00:00+09:00';
    assert.equal(rainSchedule()[0].ms, 10 * 60000);
  } finally {
    if (before === undefined) delete process.env.GAME_CANDY_RAIN_AT; else process.env.GAME_CANDY_RAIN_AT = before;
  }
});
