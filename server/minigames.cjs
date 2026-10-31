const { randomInt } = require('node:crypto');
const { STEP_MS, MAX_LEVEL, MAX_INPUTS, CHALLENGE_MAX_MS, evaluateCandyChallenge } = require('./candy-challenge.cjs');

// 노크하면 이 중 하나가 랜덤으로 나온다. fish는 원래 있던 사탕 낚시다.
const GAMES = ['fish', 'rhythm', 'whack', 'spell', 'catch'];
const INPUT_MAX = { rhythm: 2, whack: 8, spell: 3, catch: 2 };

// 아래 miniPlan·miniJudge는 화면(prototype/trick-or-treat.html)에 같은 코드가 있다. 고치면 둘 다 고친다.
function miniPlan(game, level, seed) {
  const L = Math.max(1, Math.min(5, Math.floor(level) || 1));
  let state = seed | 0;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (a, b) => a + Math.floor(random() * (b - a + 1));
  if (game === 'rhythm') {
    const half = (500 - L * 20) / 2, w = 170 - L * 15, items = [];
    let t = 2000;
    for (let i = 0; i < 16 + L * 2; i++) {
      items.push({ t, k: between(0, 2), from: t - w, to: t + w });
      t += random() < .1 + L * .1 ? half : half * 2;
    }
    return { items, need: items.length - (7 - L), allowed: 7 - L, end: items[items.length - 1].to };
  }
  if (game === 'whack') {
    const show = 1100 - L * 100, items = [];
    let t = 1000;
    for (let i = 0; i < 14 + L * 2; i++) {
      let k = between(0, 8);
      while (items.slice(-2).some((item) => item.k === k)) k = (k + 1) % 9;
      items.push({ t, k, from: t, to: t + show });
      t += between(700 - L * 60, 1100 - L * 80);
    }
    return { items, need: items.length - (7 - L), allowed: 7 - L, end: items[items.length - 1].to };
  }
  if (game === 'spell') {
    const step = 650 - L * 30, items = Array.from({ length: 3 + L }, () => ({ k: between(0, 3) }));
    items.forEach((item, i) => { item.t = 1000 + i * step; });
    const open = 1000 + items.length * step;
    return { items, step, open, need: items.length, allowed: 0, end: open + 4000 + items.length * 1000 };
  }
  if (game === 'catch') {
    // 사탕은 가만히 있으면 못 받게 매번 옆으로 옮기되, 바구니가 따라갈 수 있는 거리까지만 옮긴다.
    // 똥은 앞뒤 사탕을 잇는 길에서 지나온 쪽으로 비켜 떨어뜨려, 사탕을 제때 쫓아가면 피하게 한다.
    const fall = 2200 - L * 150, reach = .15 - L * .01, speed = 1.2, count = 16 + L * 2, items = [];
    let t = 800;
    for (let i = 0; i < count; i++) {
      items.push({ t: t + fall, from: t, x: .5, bad: i > 0 && i < count - 1 && random() < .25 });
      t += between(650 - L * 50, 1000 - L * 70);
    }
    const good = items.filter((item) => !item.bad);
    good.forEach((item, i) => {
      if (i === 0) { item.x = .06 + random() * .88; return; }
      const prev = good[i - 1], move = .25 + random() * (speed * (item.t - prev.t) / 1000 * .7 - .25);
      const left = prev.x - move, right = prev.x + move;
      item.x = left < .06 ? Math.min(.94, right) : right > .94 ? left : random() < .5 ? left : right;
    });
    items.forEach((item, i) => {
      if (!item.bad) return;
      const a = items.slice(0, i).reverse().find((other) => !other.bad), b = items.slice(i + 1).find((other) => !other.bad);
      const line = a.x + (b.x - a.x) * (item.t - a.t) / (b.t - a.t);
      item.x = line - Math.sign(b.x - a.x || 1) * (reach + .12);
      if (item.x < .06 || item.x > .94) { item.bad = false; item.x = line; }
    });
    const allowed = Math.max(1, 5 - L);
    return { items, fall, reach, speed, need: Math.max(1, items.filter((item) => !item.bad).length - allowed), allowed, end: items[items.length - 1].t };
  }
  return null;
}

// taps는 [{ t, v }]를 시간 순으로 받는다. until까지 본 결과와 판정이 난 시각(at)을 돌려준다.
function miniJudge(game, plan, taps, until) {
  const state = plan.items.map(() => null);
  let hits = 0, misses = 0, x = .5;
  const verdict = (at) => (hits >= plan.need ? { won: true, at } : misses > plan.allowed ? { won: false, at } : null);
  const done = (decided) => ({ finished: Boolean(decided), won: Boolean(decided?.won), at: decided ? decided.at : until, hits, misses, state, x });
  if (game === 'spell') {
    for (const tap of taps) {
      if (tap.t > until || tap.t > plan.end) break;
      const item = plan.items[hits];
      if (tap.t < plan.open || tap.v !== item.k) { state[hits] = 'miss'; misses++; return done({ won: false, at: tap.t }); }
      state[hits] = 'hit'; hits++;
      if (hits >= plan.need) return done({ won: true, at: tap.t });
    }
    return done(until >= plan.end ? { won: false, at: plan.end } : null);
  }
  if (game === 'catch') {
    let dir = 0, next = 0, index = 0;
    for (let time = STEP_MS; time <= Math.min(until, plan.end + STEP_MS); time += STEP_MS) {
      while (next < taps.length && taps[next].t <= time) { dir = taps[next].v === 1 ? -1 : taps[next].v === 2 ? 1 : 0; next++; }
      x = Math.max(0, Math.min(1, x + dir * plan.speed * STEP_MS / 1000));
      while (index < plan.items.length && plan.items[index].t <= time) {
        const item = plan.items[index], caught = Math.abs(x - item.x) <= plan.reach;
        if (item.bad) { if (caught) { state[index] = 'miss'; misses++; } else state[index] = 'pass'; } else if (caught) { state[index] = 'hit'; hits++; } else { state[index] = 'miss'; misses++; }
        index++;
        const decided = verdict(time);
        if (decided) return done(decided);
      }
    }
    return done(null);
  }
  let open = 0;
  const expire = (time) => {
    for (; open < plan.items.length && plan.items[open].to < time; open++) {
      if (state[open]) continue;
      state[open] = 'miss'; misses++;
      const decided = verdict(plan.items[open].to);
      if (decided) { open++; return decided; }
    }
    return null;
  };
  for (const tap of taps) {
    if (tap.t > until) break;
    const expired = expire(tap.t);
    if (expired) return done(expired);
    const index = plan.items.findIndex((item, i) => !state[i] && item.k === tap.v && item.from <= tap.t && tap.t <= item.to);
    if (index >= 0) { state[index] = 'hit'; hits++; } else misses++;
    const decided = verdict(tap.t);
    if (decided) return done(decided);
  }
  return done(expire(until));
}

function pickGame(supported) {
  const allowed = (process.env.GAME_MINIGAMES || GAMES.join(',')).split(',').map((game) => game.trim());
  const games = GAMES.filter((game) => allowed.includes(game) && (game === 'fish' || (Array.isArray(supported) && supported.includes(game))));
  return games.length ? games[randomInt(games.length)] : 'fish';
}

function evaluateChallenge(challenge, inputs, elapsedMs, now = Date.now()) {
  const game = challenge.game;
  if (challenge.path !== undefined || !INPUT_MAX[game]) return evaluateCandyChallenge(challenge, inputs, elapsedMs, now);
  const invalid = (message) => ({ valid: false, message, won: false, finished: true });
  if (!Array.isArray(inputs) || inputs.length % 2 !== 0 || inputs.length / 2 > MAX_INPUTS) return invalid('조작 기록을 확인해 주세요.');
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < STEP_MS || elapsedMs % STEP_MS !== 0) return invalid('도전 시간을 확인해 주세요.');
  if (!Number.isFinite(challenge.createdAt) || elapsedMs > now - challenge.createdAt + 1000) return invalid('도전 입력 시간이 올바르지 않아요.');
  if (!Number.isInteger(challenge.seed) || challenge.seed < 0 || challenge.seed > 0xffffffff) return invalid('도전 경로가 올바르지 않아요.');
  const taps = [];
  let tick = 0, previous = 0;
  for (let index = 0; index < inputs.length; index += 2) {
    const delta = inputs[index], v = inputs[index + 1];
    tick += delta;
    if (!Number.isInteger(delta) || delta < 1 || !Number.isInteger(v) || v < 0 || v > INPUT_MAX[game]
      || tick * STEP_MS > elapsedMs || (game === 'catch' && v === previous)) return invalid('조작 기록을 확인해 주세요.');
    taps.push({ t: tick * STEP_MS, v });
    previous = v;
  }
  const plan = miniPlan(game, Math.min(MAX_LEVEL, challenge.level), challenge.seed);
  const result = miniJudge(game, plan, taps, Math.min(elapsedMs, CHALLENGE_MAX_MS));
  if (result.finished) return { valid: true, won: result.won, finished: true, at: Math.ceil(result.at / STEP_MS) * STEP_MS };
  if (elapsedMs >= CHALLENGE_MAX_MS) return { valid: true, won: false, finished: true, timedOut: true, at: CHALLENGE_MAX_MS };
  return { valid: true, won: false, finished: false, at: elapsedMs };
}

module.exports = { GAMES, miniPlan, miniJudge, pickGame, evaluateChallenge };
