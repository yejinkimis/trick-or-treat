const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { signup, login, updateProfile } = require('../server/auth-service.cjs');
const { FIELD_SIZE, LEADERBOARD_MS, leaderboard, session, action, balance } = require('../server/game-service.cjs');
const { services } = require('../server/firebase-admin.cjs');
const { FieldValue } = require('firebase-admin/firestore');
const { searchUsers, watchAccounts, moderate } = require('../server/admin-service.cjs');
after(() => services().database.goOffline());

test('admin moderation enforces permissions, bans existing sessions, hides houses and removes matching content', async (t) => {
  const [admin, visitor, host] = await Promise.all(['관', '방', '대'].map(player));
  process.env.GAME_ADMIN_UIDS = admin.uid;
  await act(admin, { type: 'event-start' });
  t.after(async () => {
    process.env.GAME_ADMIN_UIDS = admin.uid;
    const event = (await services().db.doc('game/event').get()).data();
    if (event && !event.results) await act(admin, { type: 'event-stop' });
  });
  await assert.rejects(searchUsers(visitor.authorization, host.uid), (e) => e.status === 403);
  await assert.rejects(moderate(visitor.authorization, { type: 'ban', target: host.uid, reason: 'test' }), (e) => e.status === 403);
  await assert.rejects(moderate(admin.authorization, { type: 'ban', target: admin.uid, reason: 'test' }));
  await act(visitor, { type: 'note', host: host.uid, text: '삭제 대상' });
  const note = (await saved(visitor)).notes.at(-1);
  await moderate(admin.authorization, { type: 'delete-note', target: visitor.uid, guest: visitor.uid, host: host.uid, at: note.at });
  assert.equal((await saved(visitor)).notes.length, 0);
  assert.equal((await saved(host)).guests.length, 0);
  const chatRef = services().database.ref(`chat/${visitor.uid}`);
  await chatRef.set({ id: 'new', text: 'new' });
  await moderate(admin.authorization, { type: 'delete-chat', target: visitor.uid, chatId: 'old' });
  assert.equal((await chatRef.get()).val().id, 'new');
  await moderate(admin.authorization, { type: 'delete-chat', target: visitor.uid, chatId: 'new' });
  assert.equal((await chatRef.get()).exists(), false);
  await moderate(admin.authorization, { type: 'house', target: host.uid, hidden: true });
  await services().db.collection('gamePlayers').doc(visitor.uid).update({ pumpkins: 3 });
  await assert.rejects(act(visitor, { type: 'knock-start', host: host.uid }), /집을 찾을/);
  await moderate(admin.authorization, { type: 'house', target: host.uid, hidden: false });
  await moderate(admin.authorization, { type: 'ban', target: visitor.uid, reason: '도배' });
  await assert.rejects(harvest(visitor), (e) => e.status === 401 || e.status === 403);
  const read = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-trick-or-treat/databases/(default)/documents/gamePlayers/${visitor.uid}`, { headers: { authorization: visitor.authorization } });
  assert.equal(read.status, 403);
  const denied = await fetch(`http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/chat/${visitor.uid}.json?ns=demo-trick-or-treat-default-rtdb&auth=${visitor.token}`, { method: 'PUT', body: JSON.stringify({ id: 'blocked', text: 'x', kind: 'chat', v: 1, at: { '.sv': 'timestamp' } }) });
  assert.equal(denied.status, 401);
  assert.ok((await services().db.doc('game/moderation').get()).data().excluded.includes(visitor.uid));
  await moderate(admin.authorization, { type: 'unban', target: visitor.uid });
  assert.equal((await saved(visitor)).rankExcluded, true);
  await moderate(admin.authorization, { type: 'rank', target: visitor.uid, excluded: false });
  assert.ok(!(await services().db.doc('game/moderation').get()).data().excluded.includes(visitor.uid));
  await harvest(visitor, { host: { invalid: true } });
  const found = (await searchUsers(admin.authorization, visitor.uid)).users[0];
  assert.equal(found.banned, false);
  assert.ok(found.activity.some((item) => item.type === 'harvest'));
  assert.ok(found.activity.every((item) => item.host === undefined || typeof item.host === 'string'));
  await act(admin, { type: 'event-stop' });
});

async function player(prefix) {
  const account = await signup({ nickname: `${prefix}${randomUUID().slice(0, 8)}`, password: 'game-password-8' });
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo-api-key`, {
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
const harvest = async (p, extra = {}) => {
  const ripe = ((await saved(p)).field || []).find((pumpkin) => pumpkin.at <= Date.now());
  return act(p, { type: 'harvest', pumpkin: ripe?.id, ...extra });
};

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
  const contenders = [first, second];
  const starts = await Promise.allSettled(contenders.map((p) => act(p, { type: 'knock-start', host: host.uid })));
  assert.equal(starts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(starts.filter((result) => result.status === 'rejected').length, 1);
  const rejectedStart = starts.find((result) => result.status === 'rejected');
  assert.equal(rejectedStart.reason.status, 429);
  assert.match(rejectedStart.reason.message, /다른 사람이 도전 중/);
  const winnerIndex = starts.findIndex((result) => result.status === 'fulfilled');
  const winner = contenders[winnerIndex], waiting = contenders[1 - winnerIndex];
  const challenge = starts[winnerIndex].value.challenge;
  const one = { challengeId: challenge.id, inputs: [1, 1], elapsedMs: 6000, level: challenge.level };
  const houseLock = services().db.collection('gameHouseLocks').doc(host.uid);
  const firstHeartbeat = (await houseLock.get()).data().heartbeatAt;
  await act(winner, { type: 'knock-heartbeat', challengeId: challenge.id });
  assert.ok((await houseLock.get()).data().heartbeatAt >= firstHeartbeat);
  await services().db.collection('gameChallenges').doc(winner.uid).update({ createdAt: Date.now() - 6000,
    path: [{ t: 0, y: .05 }, { t: 6000, y: .05 }] });
  const requestId = randomUUID();
  const [a, b] = await Promise.all([
    act(winner, { type: 'knock-finish', ...one, requestId }), act(winner, { type: 'knock-finish', ...one, requestId }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(balance(await saved(winner), start.event) + balance(await saved(host), start.event), 11);
  assert.equal(balance(await saved(host), start.event), 0);
  assert.deepEqual(await act(winner, { type: 'knock-finish', ...one, requestId }), a);
  await assert.rejects(act(winner, { type: 'knock-finish', ...one }), /끝났거나/);

  const secondChallenge = (await act(waiting, { type: 'knock-start', host: host.uid })).challenge;
  await services().db.collection('gamePlayers').doc(winner.uid).update({ knockAt: 0 });
  await assert.rejects(act(winner, { type: 'knock-start', host: host.uid }), (error) => error.status === 429 && /다른 사람이 도전 중/.test(error.message));
  await services().db.collection('gamePlayers').doc(waiting.uid).update({ knockAt: 0 });
  await assert.rejects(act(waiting, { type: 'knock-start', host: host.uid }), (error) => error.status === 429 && /진행 중인 도전/.test(error.message));
  await services().db.collection('gameChallenges').doc(waiting.uid).update({ createdAt: Date.now() - 4000,
    path: [{ t: 0, y: .05 }, { t: 3000, y: .05 }] });
  const secondLoss = await act(waiting, { type: 'knock-finish', challengeId: secondChallenge.id, inputs: [], elapsedMs: 2800 });
  assert.equal(secondLoss.entry.moved, false);
  assert.equal(secondLoss.hostCandies, 0);
  await assert.rejects(act(first, { type: 'candies', candies: 999 }), /지원하지/);
  const before = balance(await saved(first), start.event);
  for (const item of ['__proto__', 'constructor', 'toString', ['lantern'], null]) {
    await assert.rejects(act(first, { type: 'decor', item }), /장식을 확인/);
    assert.equal(balance(await saved(first), start.event), before);
  }
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

test('event stop and a winning candy transfer are serialized at the round boundary', async () => {
  const [owner, visitor, host] = await Promise.all(['운영', '도전', '집'].map(player));
  process.env.GAME_ADMIN_UIDS = owner.uid;
  await services().db.collection('gamePlayers').doc(visitor.uid).update({ pumpkins: 3 });
  const started = await act(owner, { type: 'event-start' });
  const attempt = await winningChallenge(visitor, host);

  const [finish, stop] = await Promise.allSettled([
    act(visitor, { type: 'knock-finish', ...attempt }),
    act(owner, { type: 'event-stop' }),
  ]);

  assert.equal(stop.status, 'fulfilled');
  const final = stop.value.event.results;
  const visitorResult = final.find((p) => p.id === visitor.uid);
  const hostResult = final.find((p) => p.id === host.uid);
  assert.ok(visitorResult && hostResult);
  assert.equal(visitorResult.n + hostResult.n, 20);
  if (finish.status === 'fulfilled') {
    assert.equal(visitorResult.n, 11);
    assert.equal(hostResult.n, 9);
  } else {
    assert.match(finish.reason.message, /이벤트가 끝났|도전이 끝났/);
    assert.equal(visitorResult.n, 10);
    assert.equal(hostResult.n, 10);
  }

  assert.deepEqual((await services().db.collection('gameRounds').doc(started.event.id).get()).data().results, final);
  await assert.rejects(act(visitor, { type: 'knock-finish', ...attempt }), /이벤트가 끝났|도전이 끝났/);
});

test('two tabs cannot start separate challenges or double-settle while the host spends their remaining candy', async () => {
  const [owner, visitor, firstHost, secondHost] = await Promise.all(['검관', '검도', '검집', '검옆'].map(player));
  process.env.GAME_ADMIN_UIDS = owner.uid;
  const { event } = await act(owner, { type: 'event-start' });
  const db = services().db;
  await db.collection('gamePlayers').doc(visitor.uid).update({ pumpkins: 3 });
  const hosts = [firstHost, secondHost];
  const starts = await Promise.allSettled(hosts.map((host) => act(visitor, { type: 'knock-start', host: host.uid })));
  assert.equal(starts.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(starts.filter((r) => r.status === 'rejected' && r.reason.status === 429).length, 1);
  const selected = starts.findIndex((r) => r.status === 'fulfilled');
  const host = hosts[selected], unusedHost = hosts[1 - selected];
  const challenge = starts[selected].value.challenge;
  assert.equal((await db.collection('gameHouseLocks').doc(unusedHost.uid).get()).exists, false);
  await db.collection('gameChallenges').doc(visitor.uid).update({ createdAt: Date.now() - 6000,
    path: [{ t: 0, y: .05 }, { t: 6000, y: .05 }] });
  await db.collection('gamePlayers').doc(host.uid).update({ round: event.id, candies: 2 });
  const finish = { type: 'knock-finish', challengeId: challenge.id, inputs: [1, 1], elapsedMs: 6000 };
  const results = await Promise.allSettled([
    act(visitor, finish), act(visitor, finish), act(host, { type: 'decor', item: 'lantern' }),
  ]);
  const settlements = results.slice(0, 2);
  assert.equal(settlements.filter((r) => r.status === 'fulfilled').length, 1, 'distinct request IDs cannot settle one challenge twice');
  assert.equal(settlements.filter((r) => r.status === 'rejected').length, 1);
  const settled = settlements.find((r) => r.status === 'fulfilled').value;
  const visitorCandy = balance(await saved(visitor), event), hostCandy = balance(await saved(host), event);
  assert.ok(hostCandy >= 0);
  if (results[2].status === 'fulfilled') {
    assert.equal(settled.entry.moved, false);
    assert.equal(visitorCandy, 10);
    assert.equal(hostCandy, 0);
  } else {
    assert.match(results[2].reason.message, /사탕이 부족/);
    assert.equal(settled.entry.moved, true);
    assert.equal(visitorCandy, 11);
    assert.equal(hostCandy, 1);
  }
  assert.equal((await db.collection('gameHouseLocks').doc(host.uid).get()).exists, false);
  assert.equal((await db.collection('gameChallenges').doc(visitor.uid).get()).data().used, true);
  await act(owner, { type: 'event-stop' });
});

test('a replaced or previous-round challenge cannot release another challenger house lock', async () => {
  const [owner, first, second, host] = await Promise.all(['관리', '이전', '다음', '대상'].map(player));
  process.env.GAME_ADMIN_UIDS = owner.uid;
  await act(owner, { type: 'event-start' });
  for (const p of [first, second]) await services().db.collection('gamePlayers').doc(p.uid).update({ pumpkins: 3 });
  const prior = await winningChallenge(first, host);
  const lockRef = services().db.collection('gameHouseLocks').doc(host.uid);
  await lockRef.update({ createdAt: Date.now() - 60 * 60 * 1000 - 1, heartbeatAt: Date.now() - 60_001 });
  const next = (await act(second, { type: 'knock-start', host: host.uid })).challenge;
  await assert.rejects(act(first, { type: 'knock-finish', ...prior }), /유효하지/);
  await assert.rejects(act(first, { type: 'knock-heartbeat', challengeId: prior.challengeId }), /잠금이 풀렸/);
  assert.equal((await lockRef.get()).data().challengeId, next.id);
  await act(owner, { type: 'event-stop' });
  await act(owner, { type: 'event-start' });
  await assert.rejects(act(second, { type: 'knock-finish', challengeId: next.id, inputs: [], elapsedMs: 2800 }), /끝났거나/);
  const fresh = await winningChallenge(second, host);
  assert.equal(fresh.level, 1);
  await act(second, { type: 'knock-finish', ...fresh });
  assert.equal((await lockRef.get()).exists, false);
  await act(owner, { type: 'event-stop' });
});

test('public scores are readable but direct client edits and private challenge reads are denied', async () => {
  const p = await player('규');
  const base = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-trick-or-treat/databases/(default)/documents`;
  for (const [path, method, expected] of [
    [`gamePlayers/${p.uid}`, 'GET', 200], [`gamePlayers/${p.uid}`, 'DELETE', 403],
    [`gameChallenges/${p.uid}`, 'GET', 403], [`gameHouseLocks/${p.uid}`, 'GET', 403], [`gameRequests/anything`, 'GET', 403],
    [`villages/${(await saved(p)).village}`, 'GET', 200], ['villages/1', 'DELETE', 403], ['game/villages', 'GET', 403],
  ]) {
    const result = await fetch(`${base}/${path}`, { method, headers: { authorization: `Bearer ${p.token}` } });
    assert.equal(result.status, expected);
  }
});

test('Realtime Database enforces identity, payload validation and per-session cleanup', async () => {
  const [a, b] = await Promise.all([player('접'), player('속')]);
  const base = `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}`;
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
  assert.match(named.data().name, /^(뽀롱뽀롱마을|둠바족|태초마을|구리마을|안드로이드 제국|프론트마을)(\d+)?$/);
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
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo-api-key`, {
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

test('server alchemy keeps the basket, caps the bag, spends pumpkins and enforces the cooldown', async () => {
  await services().db.doc('game/event').delete();
  const [brewer, host] = await Promise.all(['솥', '이웃'].map(player));
  const ref = services().db.collection('gamePlayers').doc(brewer.uid);
  for (let i = 0; i < 3; i++) {
    await harvest(brewer);
    await ref.update({ harvestAt: 0 });
  }
  assert.equal((await saved(brewer)).basket, true);
  await ref.update({ pumpkins: 100 });
  await assert.rejects(harvest(brewer), /꽉 찼어요/);
  await ref.update({ pumpkins: 29 });
  await assert.rejects(act(brewer, { type: 'brew' }), /30개/);
  await ref.update({ pumpkins: 55 });
  const result = await act(brewer, { type: 'brew' });
  assert.ok([0, 2, 5, 10].includes(result.gain));
  assert.equal(result.candies, 10 + result.gain);
  const after = await saved(brewer);
  assert.equal(after.pumpkins, 25);
  assert.equal(after.basket, true);
  assert.equal(after.brews.at(-1).n, result.gain);
  await ref.update({ pumpkins: 60 });
  await assert.rejects(act(brewer, { type: 'brew' }), (error) => error.status === 429 && /분 뒤/.test(error.message));
  const { challenge } = await act(brewer, { type: 'knock-start', host: host.uid });
  assert.ok(challenge.id);
});

test('the leaderboard is computed once per three minutes, shared through the CDN, and refuses cache-busting', async () => {
  const handler = require('../api/game/leaderboard.js');
  const call = async (url) => {
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = JSON.parse(body); } };
    await handler({ method: 'GET', url, headers: {} }, res);
    return res;
  };
  const p = await player('순');
  process.env.GAME_ADMIN_UIDS = p.uid;
  await act(p, { type: 'event-start' });
  const first = await leaderboard(Date.now() + 10 * LEADERBOARD_MS);
  const mine = first.players.find((r) => r.id === p.uid);
  assert.equal(mine.village, (await saved(p)).village);
  assert.ok(first.players.every((r, i, all) => !i || all[i - 1].n >= r.n), 'sorted by candies');

  await services().db.collection('gamePlayers').doc(p.uid).update({ round: first.round, candies: 999 });
  const memo = await leaderboard(first.at + LEADERBOARD_MS - 1);
  assert.equal(memo, first, 'within three minutes nothing is read again');
  const fresh = await leaderboard(first.at + LEADERBOARD_MS);
  assert.equal(fresh.players[0].id, p.uid);

  const ok = await call('/api/game/leaderboard');
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['cache-control'], 'public, max-age=0, s-maxage=180');
  const busted = await call('/api/game/leaderboard?t=1');
  assert.equal(busted.statusCode, 400);
  assert.equal(busted.headers['cache-control'], 'no-store, max-age=0');
  await act(p, { type: 'event-stop' });
});

test('only pumpkins the server planted and grew can be harvested, each once, and a new one regrows later', async () => {
  await services().db.doc('game/event').delete();
  const farmer = await player('밭');
  const ref = services().db.collection('gamePlayers').doc(farmer.uid);
  const field = (await saved(farmer)).field;
  assert.equal(field.length, FIELD_SIZE);
  assert.ok(field.every((p) => /^[a-f0-9]{12}$/.test(p.id) && Number.isInteger(p.s) && p.at <= Date.now()));
  await assert.rejects(act(farmer, { type: 'harvest' }), (e) => e.status === 409);
  await assert.rejects(act(farmer, { type: 'harvest', pumpkin: 'made-up-id' }), (e) => e.status === 409);
  const picked = field[0].id;
  const result = await act(farmer, { type: 'harvest', pumpkin: picked });
  assert.equal(result.pumpkins, 1);
  assert.equal(result.field.length, FIELD_SIZE);
  assert.ok(!result.field.some((p) => p.id === picked));
  const regrown = result.field.at(-1);
  assert.ok(regrown.at >= Date.now() + 4000, 'the replacement is still growing');
  await ref.update({ harvestAt: 0 });
  await assert.rejects(act(farmer, { type: 'harvest', pumpkin: picked }), (e) => e.status === 409, 'the same pumpkin cannot be picked twice');
  await assert.rejects(act(farmer, { type: 'harvest', pumpkin: regrown.id }), /자라는 중/);
  await ref.update({ field: (await saved(farmer)).field.map((p) => ({ ...p, at: 0 })) });
  await act(farmer, { type: 'harvest', pumpkin: regrown.id });
  assert.equal((await saved(farmer)).pumpkins, 2);
});

test('players from before the planted field get one on their next session', async () => {
  const old = await player('옛');
  const ref = services().db.collection('gamePlayers').doc(old.uid);
  await ref.update({ field: FieldValue.delete() });
  await session(old.authorization);
  assert.equal((await saved(old)).field.length, FIELD_SIZE);
});

test('the admin watch list shows who won from whom, how fast, and stays admin-only', async () => {
  await services().db.doc('game/event').delete();
  const [admin, visitor, host] = await Promise.all(['감', '봇', '부'].map(player));
  process.env.GAME_ADMIN_UIDS = admin.uid;
  await services().db.collection('gamePlayers').doc(visitor.uid).update({ pumpkins: 3 });
  await harvest(visitor);
  await act(visitor, { type: 'knock-finish', ...(await winningChallenge(visitor, host)) });
  await assert.rejects(watchAccounts(visitor.authorization), (e) => e.status === 403);
  const row = (await watchAccounts(admin.authorization)).users.find((u) => u.id === visitor.uid);
  assert.equal(row.tries, 1);
  assert.equal(row.wins, 1);
  assert.ok(row.fastestWinMs > 0 && row.fastestWinMs <= 6000);
  assert.equal(row.candy.knocks, 1);
  assert.equal(row.harvests, 1);
  assert.deepEqual(row.topSource && [row.topSource.id, row.topSource.wins], [host.uid, 1]);
  const hostRow = (await watchAccounts(admin.authorization)).users.find((u) => u.id === host.uid);
  assert.equal(hostRow, undefined, 'a host who only lost candy has no activity of their own');
});

test('a ban reaches people already connected: open Realtime Database listeners are cut, their marks disappear and login is refused', async () => {
  const [admin, banned, other] = await Promise.all(['운', '금', '옆'].map(player));
  process.env.GAME_ADMIN_UIDS = admin.uid;
  const base = `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}`;
  const url = (path, token) => `${base}/${path}.json?ns=demo-trick-or-treat-default-rtdb&auth=${token}`;
  const village = (await saved(banned)).village;
  const now = { '.sv': 'timestamp' };
  const put = (path, token, body) => fetch(url(path, token), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put(`presence/${village}/${banned.uid}/tab1`, banned.token, { x: 208, y: 72, f: 1, m: false, at: now })).status, 200);
  assert.equal((await put(`online/${banned.uid}/tab1`, banned.token, { v: village, at: now })).status, 200);
  assert.equal((await fetch(url(`bannedUsers/${banned.uid}`, banned.token))).status, 200, 'a player can watch their own ban mark');
  assert.equal((await fetch(url(`bannedUsers/${banned.uid}`, other.token))).status, 401, 'but not anyone else\'s');

  // 밴 전에 열어 둔 실시간 구독(브라우저가 계속 붙어 있는 상태)을 그대로 흉내 낸다.
  const stream = await fetch(url(`presence/${village}`, banned.token), { headers: { accept: 'text/event-stream' } });
  const reader = stream.body.getReader();
  const events = [];
  const pump = (async () => {
    const decoder = new TextDecoder();
    for (let text = ''; ;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
      for (const match of text.matchAll(/^event: (\w+)$/gm)) events.push(match[1]);
      if (events.includes('cancel')) return;
    }
  })();
  while (!events.includes('put')) await new Promise((resolve) => setTimeout(resolve, 20));

  await moderate(admin.authorization, { type: 'ban', target: banned.uid, reason: '자동 플레이' });
  await Promise.race([pump, new Promise((resolve) => setTimeout(resolve, 5000))]);
  await reader.cancel().catch(() => {});
  assert.ok(events.includes('cancel'), `the rules, not token revocation, cut the open listener (got ${events.join(', ')})`);
  assert.equal((await put(`presence/${village}/${banned.uid}/tab1`, banned.token, { x: 1, y: 1, f: 1, m: false, at: now })).status, 401);
  assert.equal(await (await fetch(url(`presence/${village}/${banned.uid}`, other.token))).json(), null, 'their character disappears for others at once');
  assert.equal(await (await fetch(url(`online/${banned.uid}`, other.token))).json(), null);
  await assert.rejects(login({ nickname: banned.profile.nick, password: 'game-password-8' }), (e) => e.status === 403 && e.code === 'account-banned');
  await moderate(admin.authorization, { type: 'unban', target: banned.uid });
  assert.equal((await login({ nickname: banned.profile.nick, password: 'game-password-8' })).uid, banned.uid);
});
