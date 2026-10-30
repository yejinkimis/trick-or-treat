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
  const path = [{ t: 0, y: .05 }, { t: challenge.duration, y: .05 }];
  await services().db.collection('gameChallenges').doc(visitor.uid).update({ createdAt: Date.now() - 6000, path });
  return { challengeId: challenge.id, inputs: [{ t: 20, down: true }], elapsedMs: 6000, level: challenge.level };
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
  await assert.rejects(act(first, { type: 'knock-finish', ...one }), /만료/);
  await services().db.collection('gamePlayers').doc(second.uid).update({ knockAt: 0 });
  await act(second, { type: 'knock-start', host: host.uid });
  await services().db.collection('gamePlayers').doc(second.uid).update({ knockAt: 0 });
  await assert.rejects(act(second, { type: 'knock-start', host: host.uid }), (error) => error.status === 429 && /\d+초 뒤 다시/.test(error.message));
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
    path: [{ t: 0, y: .05 }, { t: failed.duration, y: .05 }] });
  const lost = await act(first, { type: 'knock-finish', challengeId: failed.id, inputs: [], elapsedMs: 2800 });
  assert.equal(lost.candies, 8);
  assert.equal(lost.hostCandies, 10);
  await services().db.collection('gamePlayers').doc(first.uid).update({ knockAt: 0, candies: 0 });
  const empty = (await act(first, { type: 'knock-start', host: host.uid })).challenge;
  assert.equal(empty.level, 2, 'a repeat challenge to the same house is harder');
  await services().db.collection('gameChallenges').doc(first.uid).update({ createdAt: Date.now() - 4000,
    path: [{ t: 0, y: .05 }, { t: empty.duration, y: .05 }] });
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
    [`villages/${(await saved(p)).village}`, 'GET', 200], ['villages/1', 'DELETE', 403], ['game/villages', 'GET', 403],
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
  assert.equal((await request(`presence/1/${a.uid}/tab1`, a.token, 'PUT', position)).status, 200);
  assert.equal((await request('presence/1', b.token)).status, 200);
  assert.equal((await request('presence', b.token)).status, 401, 'nobody downloads every village at once');
  assert.equal((await request(`presence/1/${a.uid}/tab2`, b.token, 'PUT', position)).status, 401);
  assert.equal((await request(`presence/1/${a.uid}/tab2`, a.token, 'PUT', { ...position, candies: 999 })).status, 401);
  assert.equal((await request(`presence/${a.uid}/tab2`, a.token, 'PUT', position)).status, 401, 'the old path without a village is closed');
  assert.equal((await request('presence/1', null)).status, 401);
  const now = { '.sv': 'timestamp' };
  assert.equal((await request(`events/2/${a.uid}`, a.token, 'PUT', { id: randomUUID(), kind: 'bonk', to: 'peer', at: now })).status, 200);
  assert.equal((await request(`events/2/${b.uid}`, a.token, 'PUT', { id: randomUUID(), kind: 'bonk', to: 'peer', at: now })).status, 401);
  assert.equal((await request(`events/x/${b.uid}`, b.token, 'PUT', { id: randomUUID(), kind: 'bonk', to: 'peer', at: now })).status, 401);
  assert.equal((await request(`events/2/${b.uid}`, b.token, 'PUT', { id: randomUUID(), kind: 'chat', text: '마을 채팅', at: now })).status, 401, 'chat lives on the shared channel');
  assert.equal((await request(`chat/${a.uid}`, a.token, 'PUT', { id: randomUUID(), kind: 'chat', text: '안녕', v: 2, at: now })).status, 200);
  assert.equal((await request(`chat/${a.uid}`, b.token, 'PUT', { id: randomUUID(), kind: 'chat', text: '사칭', v: 2, at: now })).status, 401);
  assert.equal((await request(`chat/${b.uid}`, b.token, 'PUT', { id: randomUUID(), kind: 'chat', text: '마을 없음', at: now })).status, 401);
  assert.equal((await request('chat', b.token)).status, 200);
  assert.equal((await request(`online/${a.uid}/tab1`, a.token, 'PUT', { v: 3, at: now })).status, 200);
  assert.equal((await request(`online/${a.uid}/tab2`, b.token, 'PUT', { v: 3, at: now })).status, 401);
  assert.equal((await request(`online/${a.uid}/tab2`, a.token, 'PUT', { v: 3, x: 1, at: now })).status, 401);
  assert.equal((await request('online', b.token)).status, 200);
  assert.equal((await request('online', null)).status, 401);
  assert.equal((await request(`presence/1/${a.uid}/tab1`, a.token, 'DELETE')).status, 200);
  assert.equal(await (await request(`presence/1/${a.uid}`, b.token)).json(), null);
});

test('costumed players fill villages of eight in order and visits across villages reach the host', async () => {
  const made = [];
  for (let i = 0; i < 9; i++) made.push(await player('마'));
  const villages = await Promise.all(made.map(async (p) => (await saved(p)).village));
  for (let i = 1; i < villages.length; i++) assert.ok(villages[i] >= villages[i - 1], 'later costumes never move to an earlier village');
  assert.ok(villages.at(-1) > villages[0], 'nine costumes cannot all fit in one village');
  const members = await services().db.collection('gamePlayers').where('village', '==', villages.at(-1)).get();
  assert.ok(members.size <= 8);
  const named = await services().db.collection('villages').doc(String(villages.at(-1))).get();
  assert.match(named.data().name, /^(피눈물|목없는|썩은호박|울부짖는|검은안개|거미줄|해골|저주받은|새벽없는|관뚜껑|박쥐떼|귀신불)(골|동|리|마을|숲|고개|늪|묘지)( \d+)?$/);
  assert.equal((await session(made[0].authorization)).village, villages[0], 'logging in again keeps the same village');

  const visitor = made.at(-1), host = made[0];
  process.env.GAME_ADMIN_UIDS = host.uid;
  await act(host, { type: 'event-start' });
  await services().db.collection('gamePlayers').doc(visitor.uid).update({ pumpkins: 3 });
  await act(visitor, { type: 'note', host: host.uid, text: '옆 마을에서 왔어요' });
  const finish = await act(visitor, { type: 'knock-finish', ...await winningChallenge(visitor, host) });
  assert.equal(finish.entry.r, 'win');
  const guests = (await saved(host)).guests;
  assert.deepEqual(guests.map((g) => [g.v, g.text ? 'note' : g.r]), [[visitor.uid, 'note'], [visitor.uid, 'win']]);
  assert.equal(guests[0].nick, visitor.profile.nick);
  await act(host, { type: 'event-stop' });
});

test('a player gets a village when picking a costume after joining', async () => {
  const account = await signup({ nickname: `늦${randomUUID().slice(0, 8)}`, password: 'game-password-8' });
  const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo-api-key', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: account.customToken, returnSecureToken: true }),
  });
  const authorization = `Bearer ${(await response.json()).idToken}`;
  const waiting = await session(authorization);
  assert.ok(waiting.village >= 1, 'the lobby shows the newest village before a costume is chosen');
  assert.equal((await services().db.collection('gamePlayers').doc(account.uid).get()).data().village, undefined);
  await updateProfile(authorization, { costume: 'mummy' });
  const placed = (await services().db.collection('gamePlayers').doc(account.uid).get()).data();
  assert.ok(placed.village >= waiting.village);
  assert.ok(placed.readyAt > 0);
});
