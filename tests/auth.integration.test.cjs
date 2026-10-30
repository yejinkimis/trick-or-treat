const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signup, login, getProfile, updateProfile } = require('../server/auth-service.cjs');

const PROJECT_ID = 'demo-trick-or-treat';
const AUTH_ENDPOINT = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo-api-key';
const FIRESTORE_ENDPOINT = `http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function exchangeCustomToken(token) {
  const response = await fetch(AUTH_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, returnSecureToken: true }),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

function uidFromIdToken(token) {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return claims.sub || claims.user_id || null;
}

async function firestoreRequest(documentPath, { token, method = 'GET' } = {}) {
  const response = await fetch(`${FIRESTORE_ENDPOINT}/${documentPath}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test('concurrent signups reserve a normalized nickname exactly once', async () => {
  const nickname = `호박 ${Date.now().toString(36).slice(-8)}`;
  const duplicate = `  호박   ${nickname.slice('호박 '.length)}  `;
  const attempts = await Promise.allSettled([
    signup({ nickname, password: 'pumpkin-password-1' }),
    signup({ nickname: duplicate, password: 'pumpkin-password-2' }),
  ]);
  const successes = attempts.filter((result) => result.status === 'fulfilled');
  const failures = attempts.filter((result) => result.status === 'rejected');
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason.status, 409);
  assert.match(failures[0].reason.message, /이미 사용 중/);
  assert.match(successes[0].value.uid, /^[0-9a-f]{32}$/);
  assert.equal(successes[0].value.profile.nick, nickname);
  assert.equal('password' in successes[0].value.profile, false);
});

test('wrong passwords fail generically and separate devices receive the same UID', async () => {
  const nickname = `재${Date.now().toString(36).slice(-8)}`;
  const created = await signup({ nickname, password: 'pumpkin-password-3' });
  await assert.rejects(login({ nickname, password: 'not-the-password' }), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message, '닉네임이나 비밀번호를 확인해 주세요.');
    return true;
  });

  const returning = await login({ nickname, password: 'pumpkin-password-3' });
  assert.equal(returning.uid, created.uid);
  const [firstDevice, secondDevice] = await Promise.all([
    exchangeCustomToken(created.customToken),
    exchangeCustomToken(returning.customToken),
  ]);
  assert.equal(uidFromIdToken(firstDevice.idToken), created.uid);
  assert.equal(uidFromIdToken(secondDevice.idToken), created.uid);
  const profile = await getProfile(`Bearer ${secondDevice.idToken}`);
  assert.equal(profile.uid, created.uid);
  assert.equal(profile.nick, nickname);
  assert.equal('hash' in profile, false);

  const updated = await updateProfile(`Bearer ${secondDevice.idToken}`, { costume: 'ghost', guideSeen: true, introSeen: true });
  assert.equal(updated.costume, 'ghost');
  await assert.rejects(updateProfile(`Bearer ${secondDevice.idToken}`, { nick: '사칭 닉네임' }), /저장할 수 없는 정보/);
  assert.equal((await getProfile(`Bearer ${secondDevice.idToken}`)).nick, nickname);
});

test('case, fullwidth letters and decomposed Hangul cannot create a second login identity', async () => {
  const nickname = `가Ab${Date.now().toString(36).slice(-7)}`;
  const created = await signup({ nickname, password: 'normalized-password-1' });
  const variants = [nickname.toLowerCase(), `  ${nickname.toUpperCase()}  `,
    nickname.normalize('NFD'), nickname.replace('Ab', 'Ａｂ')];
  for (const variant of variants) {
    await assert.rejects(signup({ nickname: variant, password: 'impostor-password-2' }), (error) => error.status === 409);
    const returning = await login({ nickname: variant, password: 'normalized-password-1' });
    assert.equal(returning.uid, created.uid);
    await assert.rejects(login({ nickname: variant, password: 'impostor-password-2' }), (error) => error.status === 401);
  }
});

test('Firestore rules keep hashes and nickname claims private and block client profile writes', async () => {
  const created = await signup({ nickname: `규${Date.now().toString(36).slice(-8)}`, password: 'pumpkin-password-4' });
  const other = await signup({ nickname: `다${Date.now().toString(36).slice(-8)}`, password: 'pumpkin-password-5' });
  const session = await exchangeCustomToken(created.customToken);
  const anonymousProfile = await firestoreRequest(`profiles/${created.uid}`);
  const ownProfile = await firestoreRequest(`profiles/${created.uid}`, { token: session.idToken });
  const otherProfile = await firestoreRequest(`profiles/${other.uid}`, { token: session.idToken });
  const privateAccount = await firestoreRequest(`privateAccounts/${created.uid}`, { token: session.idToken });
  const nicknameClaim = await firestoreRequest(`nicknameClaims/${created.profile.nick.toLowerCase()}`, { token: session.idToken });
  const rateLimit = await firestoreRequest('authRateLimits/not-a-public-document', { token: session.idToken });
  const profileWrite = await firestoreRequest(`profiles/${created.uid}`, { token: session.idToken, method: 'DELETE' });

  assert.equal(anonymousProfile.status, 403);
  assert.equal(ownProfile.status, 200);
  assert.equal(otherProfile.status, 403);
  assert.equal(privateAccount.status, 403);
  assert.equal(nicknameClaim.status, 403);
  assert.equal(rateLimit.status, 403);
  assert.equal(profileWrite.status, 403);
});
