const { randomInt } = require('node:crypto');

const STEP_MS = 20;
const MAX_LEVEL = 5;
const MAX_INPUTS = 1000;
const STALE_CHALLENGE_MS = 60 * 60 * 1000;
const CHALLENGE_LOCK_TTL_MS = 60 * 1000;
const BAR_UP_SPEED = .72;
const BAR_DOWN_SPEED = .82;
const BAR_ACCELERATION = 2.6;
const BAR_BRAKING = 8;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function createCandySeed() {
  return randomInt(0, 0x100000000);
}

function createCandyPathLookup(level, seed) {
  const stage = clamp(Math.floor(level) || 1, 1, MAX_LEVEL);
  const minSegment = 880 - (stage - 1) * 120;
  const maxSegment = 1320 - (stage - 1) * 130;
  let state = seed | 0;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const point = () => .08 + random() * .84;
  const path = [{ t: 0, y: point() }];
  let cursor = 1;

  return (time) => {
    while (path[path.length - 1].t <= time) {
      const previous = path[path.length - 1];
      const segment = minSegment + Math.floor(random() * (maxSegment - minSegment + 1));
      path.push({ t: previous.t + segment, y: point() });
    }
    while (cursor < path.length - 1 && time > path[cursor].t) cursor++;
    const previous = path[cursor - 1], next = path[cursor];
    const progress = (time - previous.t) / Math.max(1, next.t - previous.t);
    return previous.y + (next.y - previous.y) * progress;
  };
}

function candyYAt(path, time) {
  if (time <= path[0].t) return path[0].y;
  for (let i = 1; i < path.length; i++) {
    const next = path[i];
    if (time > next.t) continue;
    const previous = path[i - 1];
    const progress = (time - previous.t) / Math.max(1, next.t - previous.t);
    return previous.y + (next.y - previous.y) * progress;
  }
  return path[path.length - 1].y;
}

function evaluateCandyChallenge(challenge, inputs, elapsedMs, now = Date.now()) {
  const invalid = (message) => ({ valid: false, message, won: false, finished: true });
  if (!Array.isArray(inputs) || inputs.length % 2 !== 0 || inputs.length / 2 > MAX_INPUTS) {
    return invalid('조작 기록을 확인해 주세요.');
  }
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < STEP_MS || elapsedMs % STEP_MS !== 0) {
    return invalid('도전 시간을 확인해 주세요.');
  }
  if (!Number.isFinite(challenge.createdAt) || elapsedMs > now - challenge.createdAt + 1000) {
    return invalid('도전 입력 시간이 올바르지 않아요.');
  }

  const level = clamp(Math.floor(challenge.level) || 1, 1, MAX_LEVEL);
  let candyAt;
  if (challenge.path !== undefined) {
    const path = challenge.path;
    if (!Array.isArray(path) || path.length < 2 || path.length > 64
      || path.some((point, index) => !Number.isFinite(point?.t) || !Number.isFinite(point?.y)
        || point.y < 0 || point.y > 1 || (index === 0 ? point.t !== 0 : point.t <= path[index - 1].t))) {
      return invalid('도전 경로가 올바르지 않아요.');
    }
    candyAt = (time) => candyYAt(path, time);
  } else {
    if (!Number.isInteger(challenge.seed) || challenge.seed < 0 || challenge.seed > 0xffffffff) {
      return invalid('도전 경로가 올바르지 않아요.');
    }
    candyAt = createCandyPathLookup(level, challenge.seed);
  }

  const transitions = [];
  let previousTick = 0;
  let previousAt = 0;
  let previousDown = false;
  for (let index = 0; index < inputs.length; index += 2) {
    const deltaTicks = inputs[index], down = inputs[index + 1];
    const tick = previousTick + deltaTicks;
    const at = tick * STEP_MS;
    if (!Number.isInteger(deltaTicks) || deltaTicks < 1 || (down !== 0 && down !== 1)
      || at > elapsedMs || Boolean(down) === previousDown || (previousAt > 0 && at - previousAt < 60)) {
      return invalid('조작 기록을 확인해 주세요.');
    }
    transitions.push({ t: at, down: Boolean(down) });
    previousTick = tick;
    previousAt = at;
    previousDown = Boolean(down);
  }

  const barHeight = .30 - (level - 1) * .025;
  let barY = (1 - barHeight) / 2;
  let velocity = 0;
  let progress = .5;
  let held = false;
  let inputIndex = 0;
  const seconds = STEP_MS / 1000;
  const gain = .12 - (level - 1) * .004;

  for (let time = STEP_MS; time <= elapsedMs; time += STEP_MS) {
    while (inputIndex < transitions.length && transitions[inputIndex].t <= time) {
      held = transitions[inputIndex].down;
      inputIndex++;
    }

    const targetVelocity = held ? -BAR_UP_SPEED : BAR_DOWN_SPEED;
    const reversing = velocity !== 0 && Math.sign(velocity) !== Math.sign(targetVelocity);
    const acceleration = reversing ? BAR_BRAKING : BAR_ACCELERATION;
    const velocityChange = acceleration * seconds;
    velocity += clamp(targetVelocity - velocity, -velocityChange, velocityChange);
    barY += velocity * seconds;
    if (barY < 0) { barY = 0; velocity = Math.max(0, velocity); }
    if (barY > 1 - barHeight) { barY = 1 - barHeight; velocity = Math.min(0, velocity); }

    const candyY = candyAt(time);
    const inBar = candyY >= barY - .018 && candyY <= barY + barHeight + .018;
    progress = clamp(progress + (inBar ? gain : -.18) * seconds, 0, 1);
    if (progress >= 1) return { valid: true, won: true, finished: true, progress, at: time };
    if (progress <= 0) return { valid: true, won: false, finished: true, progress, at: time };
  }

  return { valid: true, won: false, finished: false, progress, at: elapsedMs };
}

module.exports = {
  STEP_MS,
  MAX_LEVEL,
  MAX_INPUTS,
  STALE_CHALLENGE_MS,
  CHALLENGE_LOCK_TTL_MS,
  createCandySeed,
  createCandyPathLookup,
  evaluateCandyChallenge,
};
