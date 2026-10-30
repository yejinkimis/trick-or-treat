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
