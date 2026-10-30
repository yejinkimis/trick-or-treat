const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DURATION_MS, evaluateCandyChallenge } = require('../server/candy-challenge.cjs');
const challenge = { createdAt: 1000, duration: DURATION_MS, level: 1, path: [{ t: 0, y: .05 }, { t: DURATION_MS, y: .05 }] };
test('server replays candy-bar inputs instead of trusting a claimed result', () => {
  const won = evaluateCandyChallenge(challenge, [{ t: 20, down: true }], 6000, 8000);
  assert.equal(won.valid, true);
  assert.equal(won.won, true);
  assert.equal(won.finished, true);

  const missed = evaluateCandyChallenge({ ...challenge, path: [{ t: 0, y: .05 }, { t: DURATION_MS, y: .05 }] }, [], 2800, 6000);
  assert.equal(missed.valid, true);
  assert.equal(missed.won, false);
  assert.equal(missed.finished, true);

  const unfinished = evaluateCandyChallenge(challenge, [{ t: 20, down: true }], 2000, 8000);
  assert.equal(unfinished.finished, false);
  assert.equal(evaluateCandyChallenge(challenge, [], DURATION_MS, 2000).valid, false);
  assert.equal(evaluateCandyChallenge(challenge, [{ t: NaN, down: true }], 2000, 6000).valid, false);
  assert.equal(evaluateCandyChallenge(challenge, [{ t: 20, down: true }, { t: 40, down: false }], 2000, 6000).valid, false);
});
