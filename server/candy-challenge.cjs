const { randomInt } = require('node:crypto');

const STEP_MS = 20;
const DURATION_MS = 18000;
const MAX_LEVEL = 5;
const MAX_INPUTS = 240;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function createCandyPath(level) {
  const stage = clamp(Math.floor(level) || 1, 1, MAX_LEVEL);
  const minSegment = 880 - (stage - 1) * 120;
  const maxSegment = 1320 - (stage - 1) * 130;
  const point = () => .08 + randomInt(0, 8401) / 10000;
  const path = [{ t: 0, y: point() }];
  let time = 0;
  while (time < DURATION_MS) {
    time = Math.min(DURATION_MS, time + randomInt(minSegment, maxSegment + 1));
    path.push({ t: time, y: point() });
  }
  return path;
}

function candyYAt(path, time) {
  if (time <= path[0].t) return path[0].y;
  for (let i = 1; i < path.length; i++) {
    const next = path[i];
    if (time > next.t) continue;
    const prev = path[i - 1];
    const progress = (time - prev.t) / Math.max(1, next.t - prev.t);
    return prev.y + (next.y - prev.y) * progress;
  }
  return path[path.length - 1].y;
}

function evaluateCandyChallenge(challenge, inputs, elapsedMs, now = Date.now()) {
  const invalid = (message) => ({ valid: false, message, won: false, finished: true });
  if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS) return invalid('조작 기록을 확인해 주세요.');
  if (!Number.isFinite(elapsedMs) || elapsedMs < STEP_MS || elapsedMs > challenge.duration || elapsedMs % STEP_MS !== 0) {
    return invalid('도전 시간을 확인해 주세요.');
  }
  if (elapsedMs > now - challenge.createdAt + 1000) return invalid('도전 입력 시간이 올바르지 않아요.');
  if (!Array.isArray(challenge.path) || challenge.path.length < 2 || challenge.path.length > 64) return invalid('도전 경로가 올바르지 않아요.');

  let previousAt = -1;
  let previousDown = false;
  for (const input of inputs) {
    if (!input || !Number.isInteger(input.t) || input.t < STEP_MS || input.t > elapsedMs
      || input.t % STEP_MS !== 0 || typeof input.down !== 'boolean' || input.down === previousDown
      || input.t <= previousAt || (previousAt >= 0 && input.t - previousAt < 60)) {
      return invalid('조작 기록을 확인해 주세요.');
    }
    previousAt = input.t;
    previousDown = input.down;
  }

  const level = clamp(Math.floor(challenge.level) || 1, 1, MAX_LEVEL);
  const barHeight = .30 - (level - 1) * .025;
  let barY = (1 - barHeight) / 2;
  let velocity = 0;
  let progress = .5;
  let held = false;
  let inputIndex = 0;
  const seconds = STEP_MS / 1000;
  const gain = .12 - (level - 1) * .004;

  for (let time = STEP_MS; time <= elapsedMs; time += STEP_MS) {
    while (inputIndex < inputs.length && inputs[inputIndex].t <= time) {
      held = inputs[inputIndex].down;
      inputIndex++;
    }

    velocity = clamp(velocity + (held ? -3.8 : 4.6) * seconds, -1.7, 1.7);
    barY += velocity * seconds;
    if (barY < 0) { barY = 0; velocity = Math.max(0, velocity); }
    if (barY > 1 - barHeight) { barY = 1 - barHeight; velocity = Math.min(0, velocity); }

    const candyY = candyYAt(challenge.path, time);
    const inBar = candyY >= barY - .018 && candyY <= barY + barHeight + .018;
    progress = clamp(progress + (inBar ? gain : -.18) * seconds, 0, 1);
    if (progress >= 1) return { valid: true, won: true, finished: true, progress, at: time };
    if (progress <= 0) return { valid: true, won: false, finished: true, progress, at: time };
  }

  if (elapsedMs >= challenge.duration) return { valid: true, won: false, finished: true, progress, at: elapsedMs };
  return { valid: true, won: false, finished: false, progress, at: elapsedMs };
}

module.exports = {
  STEP_MS,
  DURATION_MS,
  MAX_LEVEL,
  MAX_INPUTS,
  createCandyPath,
  candyYAt,
  evaluateCandyChallenge,
};
