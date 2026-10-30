const { randomUUID } = require('node:crypto');
const { services } = require('./firebase-admin.cjs');
const { authenticatedUid, getProfile } = require('./auth-service.cjs');
const { AuthError } = require('./errors.cjs');
const { MAX_LEVEL, STALE_CHALLENGE_MS, createCandySeed, evaluateCandyChallenge } = require('./candy-challenge.cjs');

const PRICES = { lantern: 2, web: 2, pumpkin: 3, cauldron: 4, bats: 5 };
const roundOf = (event) => event?.id || 'practice';
const balance = (player, event) => player.round === roundOf(event) ? player.candies : 10;
const isAdmin = (uid) => (process.env.GAME_ADMIN_UIDS || '').split(',').map((id) => id.trim()).includes(uid);
const fail = (message, status = 400) => { throw new AuthError(status, 'game-action-rejected', message); };
async function finalResults(tx, db, event, cutoff) {
  if (event.results) return event.results;
  const participants = await tx.get(db.collection('gamePlayers'));
  return participants.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((p) => p.costume && (p.readyAt || p.joinedAt || 0) <= cutoff)
    .map((p) => ({ id: p.id, nick: p.nick, costume: p.costume, n: balance(p, event) }))
    .sort((a, b) => b.n - a.n || a.nick.localeCompare(b.nick, 'ko'));
}

async function session(authorization) {
  const profile = await getProfile(authorization);
  const { db } = services();
  const ref = db.collection('gamePlayers').doc(profile.uid);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (!existing.exists) tx.create(ref, { ...profile, readyAt: profile.costume ? Date.now() : 0, pumpkins: 0, knocks: [], notes: [], decor: {}, candies: 10, round: 'practice' });
    else tx.update(ref, { ...profile, ...(profile.costume && !existing.data().readyAt ? { readyAt: Date.now() } : {}) });
  });
  return { isAdmin: isAdmin(profile.uid), uid: profile.uid };
}

async function action(authorization, input) {
  const uid = await authenticatedUid(authorization);
  if (!input || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.requestId || '')) fail('요청 번호를 확인해 주세요.');
  const { db } = services();
  const playerRef = db.collection('gamePlayers').doc(uid);
  const eventRef = db.doc('game/event');
  const receiptRef = db.collection('gameRequests').doc(`${uid}_${input.requestId}`);
  const challengeRef = db.collection('gameChallenges').doc(uid);
  return db.runTransaction(async (tx) => {
    const [receipt, playerDoc, eventDoc] = await Promise.all([tx.get(receiptRef), tx.get(playerRef), tx.get(eventRef)]);
    if (receipt.exists) return receipt.data().result;
    if (!playerDoc.exists) fail('다시 로그인해 주세요.', 401);
    const player = playerDoc.data(), event = eventDoc.exists ? eventDoc.data() : null;
    const now = Date.now(), round = roundOf(event);
    const count = balance(player, event);
    const type = input.type;
    let result = {};
    if (type === 'event-start' || type === 'event-stop') {
      if (!isAdmin(uid)) fail('운영자만 이벤트를 변경할 수 있어요.', 403);
      if (type === 'event-start') {
        if (event && event.endsAt > now) fail('이벤트가 이미 진행 중이에요.');
        if (event) {
          const results = await finalResults(tx, db, event, event.endsAt);
          tx.set(db.collection('gameRounds').doc(event.id), { ...event, results });
        }
        result.event = { id: randomUUID(), startedAt: now, endsAt: now + 86400000 };
      } else {
        if (!event || event.results) fail('진행 중인 이벤트가 없어요.');
        const cutoff = Math.min(event.endsAt, now);
        const results = await finalResults(tx, db, event, cutoff);
        result.event = { ...event, endsAt: cutoff, results };
        tx.set(db.collection('gameRounds').doc(event.id), result.event);
      }
      tx.set(eventRef, result.event);
    } else {
      if (!player.costume) fail('분장을 먼저 골라 주세요.');
      if (event && event.endsAt <= now) fail('이벤트가 끝났어요. 결과가 보존됩니다.');
      if (type === 'harvest') {
        if (now - (player.harvestAt || 0) < 1500) fail('조금 뒤 다른 호박을 따 주세요.', 429);
        const pumpkins = Math.min(3, (player.pumpkins || 0) + 1);
        tx.update(playerRef, { pumpkins, harvestAt: now });
        result = { pumpkins };
      } else if (type === 'decor') {
        const price = PRICES[input.item];
        if (!price) fail('장식을 확인해 주세요.');
        if (player.decor?.[input.item]?.round === round) fail('이미 설치한 장식이에요.');
        if (count < price) fail('사탕이 부족해요.');
        tx.update(playerRef, { round, candies: count - price, decor: { ...(player.decor || {}), [input.item]: { at: now, round } } });
        result = { candies: count - price };
      } else if (type === 'mural') {
        if (typeof input.mural !== 'string' || !/^[.1-8]{288}$/.test(input.mural)) fail('지붕 그림을 확인해 주세요.');
        tx.update(playerRef, { mural: input.mural });
      } else if (type === 'note') {
        const text = typeof input.text === 'string' ? input.text.replace(/\s+/gu, ' ').trim() : '';
        if (!text || Array.from(text).length > 80 || input.host === uid || !/^[a-f0-9]{32}$/.test(input.host || '')) fail('방명록 내용을 확인해 주세요.');
        const host = await tx.get(db.collection('gamePlayers').doc(input.host));
        if (!host.exists || !host.data().costume) fail('집을 찾을 수 없어요.');
        if (now - (player.noteAt || 0) < 2000) fail('잠시 뒤 다시 남겨 주세요.', 429);
        tx.update(playerRef, { noteAt: now, notes: [...(player.notes || []), { h: input.host, text, at: now }].slice(-100) });
      } else if (type === 'knock-start') {
        if (input.host === uid || !/^[a-f0-9]{32}$/.test(input.host || '')) fail('노크할 집을 확인해 주세요.');
        if ((player.pumpkins || 0) < 3) fail('호박 3개로 바구니를 먼저 만드세요.');
        const [host, pending] = await Promise.all([
          tx.get(db.collection('gamePlayers').doc(input.host)), tx.get(challengeRef),
        ]);
        if (!host.exists || !host.data().costume) fail('집을 찾을 수 없어요.');
        if (now - (player.knockAt || 0) < 2000) fail('잠시 뒤 다시 노크해 주세요.', 429);
        const prior = pending.exists ? pending.data() : {};
        if (prior.round === round && !prior.used && now - (prior.createdAt || 0) < STALE_CHALLENGE_MS) fail('진행 중인 노크를 먼저 마쳐 주세요.');
        const sameTarget = prior.streakHost === input.host && prior.streakRound === round;
        const level = sameTarget ? Math.min(MAX_LEVEL, (prior.streakCount || 1) + 1) : 1;
        const challenge = {
          id: randomUUID(), host: input.host, round, createdAt: now, used: false,
          level, seed: createCandySeed(),
          streakHost: input.host, streakRound: round, streakCount: level,
        };
        tx.set(challengeRef, challenge);
        result = { challenge: { id: challenge.id, host: challenge.host, round, createdAt: now, level, seed: challenge.seed } };
      } else if (type === 'knock-finish') {
        const challengeDoc = await tx.get(challengeRef);
        const challenge = challengeDoc.exists ? challengeDoc.data() : null;
        if (!challenge || challenge.id !== input.challengeId || challenge.used || challenge.round !== round) fail('도전이 끝났거나 다시 시작됐어요. 다시 시도해 주세요.');
        const hostRef = db.collection('gamePlayers').doc(challenge.host);
        const hostDoc = await tx.get(hostRef);
        if (!hostDoc.exists) fail('집을 찾을 수 없어요.');
        const outcome = evaluateCandyChallenge(challenge, input.inputs, input.elapsedMs, now);
        if (!outcome.valid) fail(outcome.message || '조작 기록을 확인해 주세요.');
        if (!outcome.finished) fail('도전이 아직 끝나지 않았어요.');
        const win = outcome.won;
        const hostCount = balance(hostDoc.data(), event);
        const moved = win && hostCount > 0;
        const entry = { h: challenge.host, r: win ? 'win' : 'lose', at: now, c: player.costume, round, moved, level: challenge.level };
        const playerUpdate = { round, candies: count + (moved ? 1 : 0), knockAt: now };
        if (win) playerUpdate.knocks = [...(player.knocks || []), entry].slice(-100);
        tx.update(playerRef, playerUpdate);
        if (moved) tx.update(hostRef, { round, candies: hostCount - 1 });
        tx.update(challengeRef, { used: true });
        result = { entry, candies: count + (moved ? 1 : 0), hostCandies: hostCount - (moved ? 1 : 0) };
      } else fail('지원하지 않는 행동이에요.');
    }
    tx.create(receiptRef, { uid, type, result, createdAt: now });
    return result;
  }, { maxAttempts: 20 });
}

module.exports = { session, action, balance, roundOf, evaluateCandyChallenge };
