const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { signup, login, updateProfile } = require('../server/auth-service.cjs');
const { TRICK_KINDS, FIELD_SIZE, LEADERBOARD_MS, leaderboard, session, action, balance } = require('../server/game-service.cjs');
const { services } = require('../server/firebase-admin.cjs');
const { searchUsers, watchAccounts, getAnnouncement, setAnnouncement, moderate } = require('../server/admin-service.cjs');
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
  const chatRef = services().database.ref(`chat/${visitor.uid}`), logRef = services().database.ref('chatLog');
  await chatRef.set({ id: 'new', text: 'new' });
  await logRef.update({ new: { id: 'new', by: visitor.uid, text: 'new' }, theirs: { id: 'theirs', by: host.uid, text: 'keep' } });
  await moderate(admin.authorization, { type: 'delete-chat', target: visitor.uid, chatId: 'old' });
  assert.equal((await chatRef.get()).val().id, 'new');
  await moderate(admin.authorization, { type: 'delete-chat', target: visitor.uid, chatId: 'theirs' });
  assert.equal((await logRef.child('theirs').get()).exists(), true, 'another person\'s line stays');
  await moderate(admin.authorization, { type: 'delete-chat', target: visitor.uid, chatId: 'new' });
  assert.equal((await chatRef.get()).exists(), false);
  assert.equal((await logRef.child('new').get()).exists(), false);
  await assert.rejects(moderate(admin.authorization, { type: 'delete-chat', target: visitor.uid, chatId: '../chat' }), /삭제할 채팅/);
  await moderate(admin.authorization, { type: 'house', target: host.uid, hidden: true });
  await services().db.collection('gamePlayers').doc(visitor.uid).update({ basket: true });
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

test('admin review shows recent challenge detail and keeps high success rate as information only', async () => {
  const [admin, visitor, host] = await Promise.all(['통계운영', '통계도전', '통계집'].map(player));
  process.env.GAME_ADMIN_UIDS = admin.uid;
  const { event } = await act(admin, { type: 'event-start' });
  await services().db.collection('gamePrivate').doc(visitor.uid).update({ pumpkins: 3 });
  await services().db.collection('gamePlayers').doc(host.uid).update({ round: event.id, candies: 1 });
  const attempt = await winningChallenge(visitor, host);
  const finish = await act(visitor, { type: 'knock-finish', ...attempt });

  const found = (await searchUsers(admin.authorization, visitor.uid)).users[0];
  assert.equal(found.challengeStats.completed, 1);
  assert.equal(found.challengeStats.wins, 1);
  assert.equal(found.challengeStats.successRate, 100);
  assert.equal(found.challengeStats.candyDelta, 1);
  assert.equal(found.banned, false, 'success rate is displayed for review and never triggers an automatic ban');
  const detail = found.activity.find((item) => item.type === 'knock-finish');
  assert.equal(detail.durationMs > 0, true);
  assert.equal(detail.candyDelta, 1);
  assert.equal(detail.hostCandyDelta, -1);
  await act(admin, { type: 'event-stop' });
});

test('only admins can publish announcements and signed-in players can read them but not write them', async () => {
  const [admin, visitor] = await Promise.all(['공운', '공플'].map(player));
  process.env.GAME_ADMIN_UIDS = admin.uid;
  await assert.rejects(setAnnouncement(visitor.authorization, { action: 'publish', text: '운영 안내' }), (error) => error.status === 403);
  await assert.rejects(getAnnouncement(visitor.authorization), (error) => error.status === 403);
  await assert.rejects(setAnnouncement(admin.authorization, { action: 'publish', text: '   ' }), (error) => error.status === 400);
  await assert.rejects(setAnnouncement(admin.authorization, { action: 'publish', text: '가'.repeat(241) }), (error) => error.status === 400);

  const published = await setAnnouncement(admin.authorization, { action: 'publish', text: '  오늘 밤 10시에 이벤트를 시작합니다.  ' });
  assert.equal(published.announcement.text, '오늘 밤 10시에 이벤트를 시작합니다.');
  const base = `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}`;
  const url = `${base}/announcements/current.json?ns=demo-trick-or-treat-default-rtdb&auth=${visitor.token}`;
  const read = await fetch(url);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).text, published.announcement.text);
  const deniedWrite = await fetch(url, { method: 'PUT', body: JSON.stringify({ id: 'spoof', text: '가짜 공지', at: Date.now() }) });
  assert.equal(deniedWrite.status, 401);

  const withdrawn = await setAnnouncement(admin.authorization, { action: 'withdraw' });
  assert.equal(withdrawn.announcement, null);
  assert.equal((await (await fetch(url)).json()), null);
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
const secret = async (p) => (await services().db.collection('gamePrivate').doc(p.uid).get()).data();
const harvest = async (p, extra = {}) => {
  const ripe = ((await secret(p)).field || []).find((pumpkin) => pumpkin.at <= Date.now());
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
  for (const p of [first, second]) await services().db.collection('gamePlayers').doc(p.uid).update({ basket: true });
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

test('a knock picks a random mini game the page can play and settles it on the server', async (t) => {
  const { miniPlan } = require('../server/minigames.cjs');
  const [owner, visitor, host] = await Promise.all(['운', '놀', '집'].map(player));
  process.env.GAME_ADMIN_UIDS = owner.uid;
  await services().db.collection('gamePlayers').doc(visitor.uid).update({ basket: true });
  await act(owner, { type: 'event-start' });
  t.after(async () => { delete process.env.GAME_MINIGAMES; process.env.GAME_ADMIN_UIDS = owner.uid; await act(owner, { type: 'event-stop' }); });
  const old = (await act(visitor, { type: 'knock-start', host: host.uid })).challenge;
  assert.equal(old.game, 'fish', 'a page without mini games keeps fishing');
  await act(visitor, { type: 'knock-leave', challengeId: old.id });
  process.env.GAME_MINIGAMES = 'whack';
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const { challenge } = await act(visitor, { type: 'knock-start', host: host.uid, games: ['whack', 'spell', 'catch'] });
  assert.equal(challenge.game, 'whack');
  await services().db.collection('gameChallenges').doc(visitor.uid).update({ createdAt: Date.now() - 30000 });
  let previous = 0;
  const inputs = miniPlan('whack', challenge.level, challenge.seed).items.flatMap((item) => {
    const tick = Math.ceil((item.from + 100) / 20), packed = [tick - previous, item.k];
    previous = tick;
    return packed;
  });
  const finish = await act(visitor, { type: 'knock-finish', challengeId: challenge.id, inputs, elapsedMs: 30000 });
  assert.equal(finish.entry.r, 'win');
  assert.equal(finish.candies, 11);
  assert.equal((await saved(visitor)).challenges.at(-1).g, 'whack');
});

test('event stop and a winning candy transfer are serialized at the round boundary', async () => {
  const [owner, visitor, host] = await Promise.all(['운영', '도전', '집'].map(player));
  process.env.GAME_ADMIN_UIDS = owner.uid;
  await services().db.collection('gamePlayers').doc(visitor.uid).update({ basket: true });
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
  await db.collection('gamePlayers').doc(visitor.uid).update({ basket: true });
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
  for (const p of [first, second]) await services().db.collection('gamePlayers').doc(p.uid).update({ basket: true });
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

test('a body doodle is saved by the server, checked for shape, and readable by the neighbours', async () => {
  await services().db.doc('game/event').delete();
  const [p, neighbour] = await Promise.all([player('낙'), player('서')]);
  const doodle = '.'.repeat(36) + '7777' + '.'.repeat(216);
  await act(p, { type: 'doodle', doodle });
  assert.equal((await saved(p)).doodle, doodle);
  for (const bad of ['.'.repeat(255), '.'.repeat(257), '9'.repeat(256), 'x'.repeat(256), 42]) {
    await assert.rejects(act(p, { type: 'doodle', doodle: bad }), /몸 낙서를 확인해 주세요/, String(bad).slice(0, 4));
  }
  assert.equal((await saved(p)).doodle, doodle, 'a rejected doodle leaves the saved one');
  const base = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-trick-or-treat/databases/(default)/documents`;
  const read = await (await fetch(`${base}/gamePlayers/${p.uid}`, { headers: { authorization: `Bearer ${neighbour.token}` } })).json();
  assert.equal(read.fields.doodle.stringValue, doodle);
  const write = await fetch(`${base}/gamePlayers/${neighbour.uid}?updateMask.fieldPaths=doodle`, {
    method: 'PATCH', headers: { authorization: `Bearer ${neighbour.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fields: { doodle: { stringValue: doodle } } }),
  });
  assert.equal(write.status, 403, 'the doodle is only written through the server');
});

test('a harvest reuses the event another request just read, but an event stop on this server applies to the very next harvest', async () => {
  await services().db.doc('game/event').delete();
  const [admin, farmer] = await Promise.all([player('수확관'), player('농부')]);
  process.env.GAME_ADMIN_UIDS = admin.uid;
  const { Transaction } = require('@google-cloud/firestore');
  const { get } = Transaction.prototype;
  const events = [];
  Transaction.prototype.get = function (ref) { if (ref?.path === 'game/event') events.push(ref.path); return get.call(this, ref); };
  try {
    await act(admin, { type: 'event-start' });
    await act(farmer, { type: 'mural', mural: '.'.repeat(288) });
    events.length = 0;
    await harvest(farmer);
    assert.equal(events.length, 0, 'the harvest did not read the event document again');
    await act(admin, { type: 'event-stop' });
    await assert.rejects(harvest(farmer), /이벤트가 끝났어요/, 'the stop is seen at once on the same server');
  } finally {
    Transaction.prototype.get = get;
    await services().db.doc('game/event').delete();
  }
});

test('after three o\'clock a reconnect tops a bag up to ten once, and skips bags of ten or more, excluded accounts and ended events', async () => {
  await services().db.doc('game/event').delete();
  const [admin, empty, few, rich, excluded] = await Promise.all(['보충관', '빈손', '세개', '부자', '제외'].map(player));
  process.env.GAME_ADMIN_UIDS = admin.uid;
  const { event } = await act(admin, { type: 'event-start' });
  const players = services().db.collection('gamePlayers');
  const set = (p, candies, extra = {}) => players.doc(p.uid).update({ round: event.id, candies, ...extra });
  await Promise.all([set(empty, 0), set(few, 3), set(rich, 12), set(excluded, 0, { rankExcluded: true })]);
  try {
    process.env.GAME_REFILL_AT = new Date(Date.now() + 60000).toISOString();
    await session(empty.authorization);
    assert.equal((await saved(empty)).candies, 0, 'nothing happens before three o\'clock');

    process.env.GAME_REFILL_AT = new Date(Date.now() - 1000).toISOString();
    await Promise.all([empty, few, rich, excluded].map((p) => session(p.authorization)));
    const filled = await saved(empty);
    assert.equal(filled.candies, 10);
    assert.equal(filled.round, event.id);
    assert.equal(filled.refill.n, 10);
    const topped = await saved(few);
    assert.equal(topped.candies, 10, 'three left is topped up to ten, so nobody overtakes them');
    assert.equal(topped.refill.n, 7);
    assert.equal((await saved(rich)).candies, 12, 'ten or more is left alone');
    assert.equal((await saved(excluded)).candies, 0, 'excluded accounts are not refilled');

    await set(empty, 0);
    await session(empty.authorization);
    assert.equal((await saved(empty)).candies, 0, 'only once per person');

    await services().db.doc('game/event').update({ endsAt: Date.now() - 1 });
    await set(rich, 0);
    await session(rich.authorization);
    assert.equal((await saved(rich)).candies, 0, 'an ended event is not refilled');
  } finally {
    delete process.env.GAME_REFILL_AT;
    await services().db.doc('game/event').delete();
  }
});

test('public scores are readable but direct client edits and private challenge reads are denied', async () => {
  const [p, other] = await Promise.all([player('규'), player('남')]);
  const base = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-trick-or-treat/databases/(default)/documents`;
  for (const [path, method, expected] of [
    [`gamePlayers/${p.uid}`, 'GET', 200], [`gamePlayers/${p.uid}`, 'DELETE', 403],
    [`gameChallenges/${p.uid}`, 'GET', 403], [`gameHouseLocks/${p.uid}`, 'GET', 403], [`gameRequests/anything`, 'GET', 403],
    [`gamePrivate/${p.uid}`, 'GET', 200], [`gamePrivate/${other.uid}`, 'GET', 403], [`gamePrivate/${p.uid}`, 'PATCH', 403],
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
  await services().db.collection('gamePlayers').doc(visitor.uid).update({ basket: true });
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
  const ref = services().db.collection('gamePrivate').doc(brewer.uid);
  for (let i = 0; i < 3; i++) {
    await harvest(brewer);
    await ref.update({ harvestAt: 0 });
  }
  assert.equal((await saved(brewer)).basket, true);
  await ref.update({ pumpkins: 100 });
  await assert.rejects(harvest(brewer), /꽉 찼어요/);
  await ref.update({ pumpkins: 9 });
  await assert.rejects(act(brewer, { type: 'brew' }), /10개/);
  await ref.update({ pumpkins: 35 });
  const result = await act(brewer, { type: 'brew' });
  assert.ok([2, 5, 10, 20].includes(result.gain));
  assert.equal(result.candies, 10 + result.gain);
  const after = await saved(brewer);
  assert.equal((await secret(brewer)).pumpkins, 25);
  assert.equal(after.basket, true);
  assert.equal(after.brews.at(-1).n, result.gain);
  await ref.update({ pumpkins: 60 });
  await assert.rejects(act(brewer, { type: 'brew' }), (error) => error.status === 429 && /분 뒤/.test(error.message));
  const { challenge } = await act(brewer, { type: 'knock-start', host: host.uid });
  assert.ok(challenge.id);
});

test('a newcomer is announced once when their house is placed, and later logins do not announce again', async () => {
  const newcomer = await player('새크루');
  const joins = async () => Object.values((await services().database.ref('announcements').get()).val() || {}).filter((a) => a.kind === 'join' && a.uid === newcomer.uid);
  const [announced, ...extra] = await joins();
  assert.equal(extra.length, 0);
  assert.equal(announced.v, (await saved(newcomer)).village);
  assert.equal(announced.nick, (await saved(newcomer)).nick);
  await session(newcomer.authorization);
  await updateProfile(newcomer.authorization, { costume: 'cat' });
  assert.equal((await joins()).length, 1, 'changing costume or logging in again is not a new arrival');
});

test('every brew is announced to every village once, and players can read but not fake announcements', async () => {
  const brewer = await player('솥홍보');
  const privateRef = services().db.collection('gamePrivate').doc(brewer.uid), playerRef = services().db.collection('gamePlayers').doc(brewer.uid);
  await Promise.all([playerRef.update({ basket: true }), privateRef.update({ pumpkins: 10 })]);
  const announcements = services().database.ref('announcements');
  const mine = async () => Object.values((await announcements.get()).val() || {}).filter((a) => a.kind === 'brew' && a.uid === brewer.uid);
  const requestId = randomUUID();
  const { gain } = await action(brewer.authorization, { requestId, type: 'brew' });
  const [announced, ...extra] = await mine();
  assert.equal(extra.length, 0);
  assert.equal(announced.kind, 'brew');
  assert.equal(announced.n, gain, 'small brews are announced too');
  assert.equal(announced.nick, (await playerRef.get()).data().nick);
  await action(brewer.authorization, { requestId, type: 'brew' });
  assert.equal((await mine()).length, 1, 'replaying the same request does not announce again');
  const base = `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}`, ns = 'ns=demo-trick-or-treat-default-rtdb';
  assert.equal((await fetch(`${base}/announcements.json?${ns}&auth=${brewer.token}&orderBy="$key"&limitToLast=1`)).status, 200, 'players can read announcements');
  assert.equal((await fetch(`${base}/announcements/fake.json?${ns}&auth=${brewer.token}`, { method: 'PUT', body: JSON.stringify({ kind: 'brew', n: 20 }) })).status, 401, 'players cannot fake one');
});

test('chat history lines can only be added together with a new rate-limited chat line', async () => {
  const [talker, other] = await Promise.all(['수다', '옆집'].map(player));
  const base = `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}`, ns = 'ns=demo-trick-or-treat-default-rtdb';
  const patch = async (who, body) => (await fetch(`${base}/.json?${ns}&auth=${who.token}`, { method: 'PATCH', body: JSON.stringify(body) })).status;
  const at = { '.sv': 'timestamp' };
  const chat = (id, text = '안녕') => ({ [`chat/${talker.uid}`]: { id, kind: 'chat', text, v: 1, at } });
  const log = (id, extra = {}) => ({ [`chatLog/${id}`]: { id, by: talker.uid, text: '안녕', v: 1, at, ...extra } });
  const wait = () => new Promise((resolve) => setTimeout(resolve, 650));
  const first = `-A${randomUUID().slice(0, 18)}`, second = `-B${randomUUID().slice(0, 18)}`, third = `-C${randomUUID().slice(0, 18)}`;

  assert.equal(await patch(talker, { ...chat(first), ...log(first) }), 200);
  assert.equal(await patch(talker, log(second)), 401, 'a history line without a new chat line');
  await wait();
  assert.equal(await patch(talker, { ...chat(second), ...log(second), ...log(third) }), 401, 'two history lines for one chat line');
  assert.equal(await patch(talker, { ...chat(second), ...log(second, { by: other.uid }) }), 401, 'a line under someone else');
  assert.equal(await patch(talker, { ...chat(second), ...log(second) }), 200);
  assert.equal(await patch(talker, { ...chat(third), ...log(third) }), 401, 'faster than the chat rate limit');
  assert.equal(await patch(other, { [`chatLog/${first}`]: null }), 401, 'nobody can delete history from the client');
  const read = async (id) => (await fetch(`${base}/chatLog/${id}.json?${ns}&auth=${other.token}`)).json();
  assert.equal((await read(first)).text, '안녕');
  assert.equal((await read(second)).by, talker.uid);
  assert.equal(await read(third), null);
});

test('the leaderboard is computed once per minute, shared through the CDN, and refuses cache-busting', async () => {
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
  assert.equal(ok.headers['cache-control'], 'public, max-age=0, s-maxage=60');
  const busted = await call('/api/game/leaderboard?t=1');
  assert.equal(busted.statusCode, 400);
  assert.equal(busted.headers['cache-control'], 'no-store, max-age=0');
  await act(p, { type: 'event-stop' });
});

test('only pumpkins the server planted and grew can be harvested, each once, and a new one regrows later', async () => {
  await services().db.doc('game/event').delete();
  const farmer = await player('밭');
  const ref = services().db.collection('gamePrivate').doc(farmer.uid);
  const field = (await secret(farmer)).field;
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
  await ref.update({ field: (await secret(farmer)).field.map((p) => ({ ...p, at: 0 })) });
  await act(farmer, { type: 'harvest', pumpkin: regrown.id });
  assert.equal((await secret(farmer)).pumpkins, 2);
  assert.equal((await saved(farmer)).field, undefined, 'the field never touches the public document');
});

test('players from before the private document keep their pumpkins and get a field on their next session', async () => {
  const old = await player('옛');
  await services().db.collection('gamePrivate').doc(old.uid).delete();
  await services().db.collection('gamePlayers').doc(old.uid).update({ pumpkins: 7, basket: true });
  await session(old.authorization);
  const mine = await secret(old);
  assert.equal(mine.pumpkins, 7);
  assert.equal(mine.field.length, FIELD_SIZE);
});

test('the admin watch list shows who won from whom, how fast, and stays admin-only', async () => {
  await services().db.doc('game/event').delete();
  const [admin, visitor, host] = await Promise.all(['감', '봇', '부'].map(player));
  process.env.GAME_ADMIN_UIDS = admin.uid;
  await services().db.collection('gamePlayers').doc(visitor.uid).update({ basket: true });
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

test('heartbeats alone cannot keep a house locked past ninety seconds, and a timed-out game settles as a loss', async () => {
  await services().db.doc('game/event').delete();
  const [alt, rival, host] = await Promise.all(['부캐', '도전', '부자'].map(player));
  for (const p of [alt, rival]) await services().db.collection('gamePlayers').doc(p.uid).update({ basket: true });
  const { challenge } = await act(alt, { type: 'knock-start', host: host.uid });
  await act(alt, { type: 'knock-heartbeat', challengeId: challenge.id });
  await assert.rejects(act(rival, { type: 'knock-start', host: host.uid }), /다른 사람이 도전 중/);

  // 신호를 계속 보내 잠금은 살아 있지만, 도전을 시작한 지 90초가 지난 상황
  const lockRef = services().db.collection('gameHouseLocks').doc(host.uid);
  const longAgo = Date.now() - 91_000;
  await lockRef.update({ createdAt: longAgo, heartbeatAt: Date.now() });
  await services().db.collection('gameChallenges').doc(alt.uid).update({ createdAt: longAgo });
  await assert.rejects(act(alt, { type: 'knock-heartbeat', challengeId: challenge.id }), (e) => e.status === 409 && /90초/.test(e.message));
  const taken = (await act(rival, { type: 'knock-start', host: host.uid })).challenge;
  assert.equal((await lockRef.get()).data().challengeId, taken.id, 'the house opens for someone else');

  // 화면이 90초에서 끝낸 도전은 지연된 정산 요청도 실패로 기록되고 잠금을 푼다
  await lockRef.update({ createdAt: Date.now() - 95_000, heartbeatAt: Date.now() });
  await services().db.collection('gameChallenges').doc(rival.uid).update({ createdAt: Date.now() - 95_000 });
  const settled = await act(rival, { type: 'knock-finish', challengeId: taken.id, inputs: [], elapsedMs: 90_000 });
  assert.equal(settled.entry.r, 'lose');
  assert.equal(settled.candies, 10);
  assert.equal(settled.hostCandies, 10, 'a failure keeps both sides\' candy');
  assert.ok(TRICK_KINDS.includes(settled.entry.k), 'but the challenger gets a trick');
  assert.equal((await saved(rival)).knocks.at(-1).k, settled.entry.k, 'stored where the village can see it');
  assert.equal((await lockRef.get()).exists, false);
});

test('a harvest writes only the private document, and retries of the same request are answered once', async () => {
  await services().db.doc('game/event').delete();
  const farmer = await player('절약');
  await harvest(farmer);
  const publicBefore = (await services().db.collection('gamePlayers').doc(farmer.uid).get()).updateTime;
  await services().db.collection('gamePrivate').doc(farmer.uid).update({ harvestAt: 0 });
  const ripe = (await secret(farmer)).field.find((p) => p.at <= Date.now());
  const requestId = randomUUID();
  const first = await action(farmer.authorization, { requestId, type: 'harvest', pumpkin: ripe.id });
  const again = await action(farmer.authorization, { requestId, type: 'harvest', pumpkin: ripe.id });
  assert.deepEqual(again, first);
  assert.equal((await secret(farmer)).pumpkins, 2);
  const publicAfter = (await services().db.collection('gamePlayers').doc(farmer.uid).get()).updateTime;
  assert.ok(publicAfter.isEqual(publicBefore), 'neighbors subscribed to the public document are not woken up');
  assert.ok((await secret(farmer)).activity.some((item) => item.type === 'harvest'));
});

test('a scheduled event keeps practice going until it starts, can be cancelled, and resets everyone to ten candies at the start time', async () => {
  await services().db.doc('game/event').delete();
  const [admin, visitor, host] = await Promise.all(['예약', '연습', '이웃집'].map(player));
  process.env.GAME_ADMIN_UIDS = admin.uid;
  const eventRef = services().db.doc('game/event');
  const now = Date.now(), startAt = now + 60 * 60 * 1000, endAt = startAt + 14 * 60 * 60 * 1000;
  await assert.rejects(act(admin, { type: 'event-start', startAt: endAt, endAt: startAt }), /시각을 확인/);
  await assert.rejects(act(admin, { type: 'event-start', startAt: now - 10 * 60 * 1000, endAt }), /시각을 확인/);
  await assert.rejects(act(admin, { type: 'event-start', startAt, endAt: startAt + 49 * 60 * 60 * 1000 }), /시각을 확인/);
  await assert.rejects(act(visitor, { type: 'event-start', startAt, endAt }), (e) => e.status === 403);

  const { event } = await act(admin, { type: 'event-start', startAt, endAt });
  assert.deepEqual([event.startedAt, event.endsAt], [startAt, endAt]);
  await assert.rejects(act(admin, { type: 'event-start', startAt, endAt }), /이미 예약된/);

  // 시작 전에는 연습으로 계속 놀고, 그 사탕은 연습 기록에 남는다.
  await services().db.collection('gamePlayers').doc(visitor.uid).update({ basket: true });
  await act(visitor, { type: 'knock-finish', ...(await winningChallenge(visitor, host)) });
  assert.deepEqual([(await saved(visitor)).round, (await saved(visitor)).candies], ['practice', 11]);

  const cancelled = await act(admin, { type: 'event-stop' });
  assert.equal(cancelled.event, null);
  assert.equal((await eventRef.get()).exists, false, 'a cancelled schedule leaves no event behind');
  assert.equal((await saved(visitor)).candies, 11, 'and does not touch practice candy');

  const again = (await act(admin, { type: 'event-start', startAt, endAt })).event;
  await eventRef.update({ startedAt: Date.now() - 1000 }); // 시작 시각이 지난 상황
  const board = await leaderboard(Date.now() + 20 * LEADERBOARD_MS);
  assert.equal(board.round, again.id);
  assert.equal(board.players.find((r) => r.id === visitor.uid).n, 10, 'everyone starts the event with ten candies');
  await services().db.collection('gamePlayers').doc(visitor.uid).update({ knockAt: 0 });
  const won = await act(visitor, { type: 'knock-finish', ...(await winningChallenge(visitor, host)) });
  assert.deepEqual([won.entry.round, won.candies, won.hostCandies], [again.id, 11, 9]);
  await eventRef.delete();
});

test('when the end time passes nothing can change candy, and the results are frozen and kept without an operator', async () => {
  await services().db.doc('game/event').delete();
  const [admin, visitor, host] = await Promise.all(['마감', '참가', '상대'].map(player));
  process.env.GAME_ADMIN_UIDS = admin.uid;
  const eventRef = services().db.doc('game/event');
  const { event } = await act(admin, { type: 'event-start' });
  await services().db.collection('gamePlayers').doc(visitor.uid).update({ basket: true });
  await act(visitor, { type: 'knock-finish', ...(await winningChallenge(visitor, host)) });
  await services().db.collection('gamePlayers').doc(visitor.uid).update({ knockAt: 0 });
  const pending = (await act(visitor, { type: 'knock-start', host: admin.uid })).challenge;

  await eventRef.update({ endsAt: Date.now() - 1 }); // 자정이 막 지난 상황(참가자들은 그 전에 들어옴)
  for (const input of [
    { type: 'knock-finish', challengeId: pending.id, inputs: [1, 1], elapsedMs: 4000 }, { type: 'knock-start', host: host.uid },
    { type: 'brew' }, { type: 'decor', item: 'lantern' }, { type: 'note', host: host.uid, text: '늦었다' }, { type: 'mural', mural: '.'.repeat(288) },
    { type: 'doodle', doodle: '.'.repeat(256) },
  ]) await assert.rejects(act(visitor, input), /이벤트가 끝났어요/, input.type);
  await assert.rejects(harvest(visitor), /이벤트가 끝났어요/);

  const board = await leaderboard(Date.now() + 30 * LEADERBOARD_MS);
  const stored = (await eventRef.get()).data();
  assert.ok(Array.isArray(stored.results), 'the first ranking request after the end freezes the results');
  assert.deepEqual((await services().db.collection('gameRounds').doc(event.id).get()).data().results, stored.results, 'and keeps a copy');
  assert.equal(stored.results.find((r) => r.id === visitor.uid).n, 11);
  assert.equal(stored.results.find((r) => r.id === host.uid).n, 9);
  assert.equal(board.players.find((r) => r.id === visitor.uid).n, 11);

  // 끝난 뒤 운영자가 부정 계정을 순위에서 빼도 저장된 결과는 그대로이고, 보이는 순위에서만 빠진다.
  await moderate(admin.authorization, { type: 'rank', target: visitor.uid, excluded: true });
  const after = await leaderboard(Date.now() + 40 * LEADERBOARD_MS);
  assert.equal(after.players.some((r) => r.id === visitor.uid), false);
  assert.deepEqual((await eventRef.get()).data().results, stored.results);
  await assert.rejects(act(admin, { type: 'event-stop' }), /진행 중인 이벤트가 없어요/, 'frozen results cannot be overwritten');
  await eventRef.delete();
});


test('leaving enforces the server five-second boundary, preserves levels and settles only once', async (t) => {
  const [owner, visitor, host] = await Promise.all(['퇴관', '퇴도', '퇴집'].map(player));
  process.env.GAME_ADMIN_UIDS = owner.uid;
  await act(owner, { type: 'event-start' });
  const { db } = services();
  const playerRef = db.collection('gamePlayers').doc(visitor.uid);
  const challengeRef = db.collection('gameChallenges').doc(visitor.uid);
  const lockRef = db.collection('gameHouseLocks').doc(host.uid);
  await playerRef.update({ basket: true });
  const fixedNow = Date.now();
  t.mock.method(Date, 'now', () => fixedNow);
  try {
    let failures = 0;
    for (const elapsedMs of [4999, 5000, 5001]) {
      await playerRef.update({ knockAt: 0 });
      const { challenge } = await act(visitor, { type: 'knock-start', host: host.uid });
      await challengeRef.update({ createdAt: fixedNow - elapsedMs, level: 3, nextLevelByHost: { [host.uid]: 3, other: 4 } });
      const request = { type: 'knock-leave', challengeId: challenge.id, elapsedMs: 0, requestId: randomUUID() };
      const left = await act(visitor, request);
      assert.equal(left.penalized, elapsedMs >= 5000, 'client duration cannot bypass the server clock');
      if (left.penalized) {
        failures++;
        assert.equal(left.entry.r, 'lose');
        assert.ok(TRICK_KINDS.includes(left.entry.k));
      }
      assert.equal((await saved(visitor)).knocks.length, failures);
      assert.equal(((await saved(visitor)).challenges || []).length, failures);
      assert.equal((await lockRef.get()).exists, false);
      assert.deepEqual((await challengeRef.get()).data().nextLevelByHost, { [host.uid]: 3, other: 4 });
      assert.deepEqual(await act(visitor, request), left);
      assert.equal((await saved(visitor)).knocks.length, failures, 'a retry must not apply another penalty');
      await assert.rejects(act(visitor, { type: 'knock-finish', challengeId: challenge.id, inputs: [], elapsedMs: 6000 }), /끝났거나/);
      await playerRef.update({ knockAt: 0 });
      const restarted = await act(visitor, { type: 'knock-start', host: host.uid });
      assert.equal(restarted.challenge.level, 3);
      await act(visitor, { type: 'knock-leave', challengeId: restarted.challenge.id });
      assert.equal((await saved(visitor)).candies, 10);
      assert.equal(balance(await saved(host), (await db.doc('game/event').get()).data()), 10);
    }
  } finally {
    t.mock.restoreAll();
    await act(owner, { type: 'event-stop' });
  }
});
