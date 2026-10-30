const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateChallenge } = require('../server/game-service.cjs');
const challenge = { createdAt: 1000, speed: 1, phase: .5, zone: .28, centers: [.5, .6, .7] };
test('server validates timing inputs instead of trusting a claimed win', () => {
  assert.equal(evaluateChallenge(challenge, [0, 100, 200], 2000), true);
  assert.equal(evaluateChallenge(challenge, [500], 2000), false);
  assert.equal(evaluateChallenge(challenge, [], 8000), false);
  assert.throws(() => evaluateChallenge(challenge, [0, 100, 10000], 20000), /입력 시간/);
  assert.throws(() => evaluateChallenge(challenge, [0, 100, 200], 0), /입력 시간/);
  assert.throws(() => evaluateChallenge(challenge, [0, NaN], 2000), /입력 시간/);
  assert.throws(() => evaluateChallenge(challenge, [0, 100, 50], 2000), /입력 시간/);
});
