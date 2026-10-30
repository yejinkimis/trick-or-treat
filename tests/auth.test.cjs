const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCRYPT, cleanNickname, validatePassword, derivePassword, verifyPassword,
  validateProfilePatch, createEmulatorCustomToken,
} = require('../server/auth-service.cjs');
const { requestBody } = require('../server/api-handler.cjs');

test('nickname policy normalizes Unicode and whitespace before comparison', () => {
  assert.deepEqual(cleanNickname('  ＨＡＬＬＯＷＥＥＮ   호박  '), {
    nickname: 'HALLOWEEN 호박', key: 'halloween 호박',
  });
  assert.equal(cleanNickname('호박   도둑').key, '호박 도둑');
  assert.throws(() => cleanNickname(''), /닉네임/);
  assert.throws(() => cleanNickname('가'.repeat(13)), /닉네임/);
  assert.throws(() => cleanNickname('👻호박'), /닉네임/);
  assert.throws(() => cleanNickname('관리자'), /닉네임/);
});

test('password limits count Unicode characters and UTF-8 bytes', () => {
  assert.equal(validatePassword('pumpkin8', { signup: true }), 'pumpkin8');
  assert.equal(validatePassword('가'.repeat(42), { signup: true }), '가'.repeat(42));
  assert.throws(() => validatePassword('pumpkin', { signup: true }), /8자/);
  assert.throws(() => validatePassword('가'.repeat(43), { signup: true }), /128바이트/);
});

test('password verifier uses salted scrypt and rejects a different password', async () => {
  const salt = Buffer.alloc(16, 0x3c);
  const hash = await derivePassword('pumpkin-password', salt, SCRYPT);
  const record = {
    algorithm: 'scrypt', version: 1,
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString('base64url'), hash: hash.toString('base64url'),
  };
  assert.equal(await verifyPassword('pumpkin-password', record), true);
  assert.equal(await verifyPassword('different-password', record), false);
});

test('profile updates only accept the account onboarding fields', () => {
  assert.deepEqual(validateProfilePatch({ costume: 'ghost', door: 5, introSeen: true, guideSeen: false }), {
    costume: 'ghost', door: 5, introSeen: true, guideSeen: false,
  });
  assert.throws(() => validateProfilePatch({ nick: '다른 사람' }), /저장할 수 없는 정보/);
  assert.throws(() => validateProfilePatch({ knocks: [] }), /저장할 수 없는 정보/);
  assert.throws(() => validateProfilePatch({ costume: 'not-a-costume' }), /분장/);
});

test('emulator custom token is scoped to the demo project and stable UID', () => {
  const token = createEmulatorCustomToken('fixed-user-id', 'demo-trick-or-treat');
  const [header, payload, signature] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'none');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.uid, 'fixed-user-id');
  assert.equal(claims.aud, 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit');
  assert.equal(signature, '');
});

test('account API accepts JSON requests only', async () => {
  assert.deepEqual(await requestBody({
    headers: { 'content-type': 'application/json' },
    body: { nickname: '호박', password: 'pumpkin-password' },
  }), { nickname: '호박', password: 'pumpkin-password' });
  await assert.rejects(requestBody({
    headers: { 'content-type': 'text/plain' },
    body: '{"nickname":"호박"}',
  }), (error) => error.status === 415);
});
