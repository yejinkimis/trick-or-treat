const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { signup, updateProfile } = require('../server/auth-service.cjs');
const { session, action, balance } = require('../server/game-service.cjs');
const { services } = require('../server/firebase-admin.cjs');

async function player(prefix) {
  const account = await signup({ nickname: `${prefix}${randomUUID().slice(0, 8)}`, password: 'game-password-8' });
  const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo-api-key', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: account.customToken, returnSecureToken: true }),
  });
  const token = (await response.json()).idToken;
  const authorization = `Bearer ${token}`;
  await updateProfile(authorization, { costume: 'ghost', introSeen: true, guideSeen: true });
  await session(authorization);
  return { ...account, authorization, token };
}
const act = (p, data) => action(p.authorization, { requestId: randomUUID(), ...data });
const saved = async (p) => (await services().db.collection('gamePlayers').doc(p.uid).get()).data();

async function winningChallenge(visitor, host) {
  const { challenge } = await act(visitor, { type: 'knock-start', host: host.uid });
  const path = [{ t: 0, y: .05 }, { t: 6000, y: .05 }];
  await services().db.collection('gameChallenges').doc(visitor.uid).update({ createdAt: Date.now() - 6000, path });
  return { challengeId: challenge.id, inputs: [1, 1], elapsedMs: 6000, level: challenge.level };
}

test('server stores atomic candy transfers, deduplicates retries, resets rounds and freezes final results', async () => {
  const [owner, first, second, host] = await Promise.all(['운', '첫', '둘', '집'].map(player));
  process.env.GAME_ADMIN_UIDS = owner.uid;
  await assert.rejects(act(first, { type: 'event-start' }), (error) => error.status === 403);
  const start = await act(owner, { type: 'event-start' });
  await assert.rejects(act(first, { type: 'knock-start', host: host.uid }), /바구니/);
  for (const p of [first, second]) await services().db.collection('gamePlayers').doc(p.uid).update({ pumpkins: 3 });
  await services().db.collection('gamePlayers').doc(host.uid).update({ round: start.event.id, candies: 1 });
  const [one, two] = await Promise.all([winningChallenge(first, host), winningChallenge(second, host)]);
  const requestId = randomUUID();
  const [a, b] = await Promise.all([
    act(first, { type: 'knock-finish', ...one, requestId }), act(second, { type: 'knock-finish', ...two }),
  ]);
  assert.equal(Number(a.entry.moved) + Number(b.entry.moved), 1);
  assert.equal(balance(await saved(first), start.event) + balance(await saved(second), start.event) + balance(await saved(host), start.event), 21);
  assert.equal(balance(await saved(host), start.event), 0);
  assert.deepEqual(await act(first, { type: 'knock-finish', ...one, requestId }), a);
  await assert.rejects(act(first, { type: 'knock-finish', ...one }), /끝났거나/);
  await services().db.collection('gamePlayers').doc(second.uid).update({ knockAt: 0 });
  await act(second, { type: 'knock-start', host: host.uid });
  await services().db.collection('gamePlayers').doc(second.uid).update({ knockAt: 0 });
  await assert.rejects(act(second, { type: 'knock-start', host: host.uid }), (error) => error.status === 429 && /진행 중인 도전/.test(error.message));
  await services().db.collection('gameChallenges').doc(second.uid).update({ used: true });
  await assert.rejects(act(first, { type: 'candies', candies: 999 }), /지원하지/);
  const before = balance(await saved(first), start.event);
  await act(first, { type: 'decor', item: 'lantern' });
  assert.equal(balance(await saved(first), start.event), before - 2);
  await assert.rejects(act(first, { type: 'decor', item: 'lantern' }), /이미 설치/);
  const stopped = await act(owner, { type: 'event-stop' });
  const finalFirst = stopped.event.results.find((p) => p.id === first.uid);
  assert.equal(finalFirst.n, before - 2);
  await updateProfile(first.authorization, { costume: 'witch' });
  await assert.rejects(updateProfile(first.authorization, { costume: null }), /다른 분장/);
  assert.deepEqual((await services().db.doc('game/event').get()).data().results, stopped.event.results);
  await assert.rejects(act(first, { type: 'decor', item: 'web' }), /끝났/);
  await assert.rejects(act(first, { type: 'knock-start', host: host.uid }), /끝났/);
  const next = await act(owner, { type: 'event-start' });
  assert.notEqual(next.event.id, start.event.id);
  assert.deepEqual((await services().db.collection('gameRounds').doc(start.event.id).get()).data().results, stopped.event.results);
  assert.equal(balance(await saved(first), next.event), 10);
  await act(first, { type: 'decor', item: 'lantern' });
  assert.equal(balance(await saved(first), next.event), 8);
  await services().db.collection('gamePlayers').doc(first.uid).update({ knockAt: 0 });
  const failed = (await act(first, { type: 'knock-start', host: host.uid })).challenge;
  assert.equal(failed.level, 1, 'a new event resets the challenger streak');
  await services().db.collection('gameChallenges').doc(first.uid).update({ createdAt: Date.now() - 4000,
    path: [{ t: 0, y: .05 }, { t: 3000, y: .05 }] });
  const lost = await act(first, { type: 'knock-finish', challengeId: failed.id, inputs: [], elapsedMs: 2800 });
  assert.equal(lost.candies, 8);
  assert.equal(lost.hostCandies, 10);
  await services().db.collection('gamePlayers').doc(first.uid).update({ knockAt: 0, candies: 0 });
  const empty = (await act(first, { type: 'knock-start', host: host.uid })).challenge;
  assert.equal(empty.level, 1, 'failure resets that house difficulty');
  await services().db.collection('gameChallenges').doc(first.uid).update({ createdAt: Date.now() - 4000,
    path: [{ t: 0, y: .05 }, { t: 3000, y: .05 }] });
  const noCandy = await act(first, { type: 'knock-finish', challengeId: empty.id, inputs: [], elapsedMs: 2800 });
  assert.equal(noCandy.candies, 0);
  assert.equal(noCandy.hostCandies, 10);
  assert.equal(noCandy.entry.moved, false);
  await act(owner, { type: 'event-stop' });
});

test('public scores are readable but direct client edits and private challenge reads are denied', async () => {
  const p = await player('규');
  const base = 'http://127.0.0.1:8080/v1/projects/demo-trick-or-treat/databases/(default)/documents';
  for (const [path, method, expected] of [
    [`gamePlayers/${p.uid}`, 'GET', 200], [`gamePlayers/${p.uid}`, 'DELETE', 403],
    [`gameChallenges/${p.uid}`, 'GET', 403], [`gameRequests/anything`, 'GET', 403],
  ]) {
    const result = await fetch(`${base}/${path}`, { method, headers: { authorization: `Bearer ${p.token}` } });
    assert.equal(result.status, expected);
  }
});

test('Realtime Database enforces identity, payload validation and per-session cleanup', async () => {
  const [a, b] = await Promise.all([player('접'), player('속')]);
  const base = 'http://127.0.0.1:9000';
  const request = (path, token, method = 'GET', body) => fetch(`${base}/${path}.json?ns=demo-trick-or-treat-default-rtdb${token ? `&auth=${token}` : ''}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const position = { x: 208, y: 72, f: 1, m: false, at: { '.sv': 'timestamp' } };
  assert.equal((await request(`presence/${a.uid}/tab1`, a.token, 'PUT', position)).status, 200);
  assert.equal((await request('presence', b.token)).status, 200);
  assert.equal((await request(`presence/${a.uid}/tab2`, b.token, 'PUT', position)).status, 401);
  assert.equal((await request(`presence/${a.uid}/tab2`, a.token, 'PUT', { ...position, candies: 999 })).status, 401);
  assert.equal((await request('presence', null)).status, 401);
  assert.equal((await request(`events/${a.uid}`, a.token, 'PUT', { id: randomUUID(), kind: 'chat', text: '안녕', at: { '.sv': 'timestamp' } })).status, 200);
  assert.equal((await request(`events/${a.uid}`, b.token, 'PUT', { id: randomUUID(), kind: 'chat', text: '사칭', at: { '.sv': 'timestamp' } })).status, 401);
  assert.equal((await request(`presence/${a.uid}/tab1`, a.token, 'DELETE')).status, 200);
  assert.equal(await (await request(`presence/${a.uid}`, b.token)).json(), null);
});
