const { randomUUID, randomInt } = require('node:crypto');
const { services } = require('./firebase-admin.cjs');
const { authenticatedUid, getProfile } = require('./auth-service.cjs');
const { AuthError } = require('./errors.cjs');
const { MAX_LEVEL, STALE_CHALLENGE_MS, CHALLENGE_LOCK_TTL_MS, CHALLENGE_MAX_MS, createCandySeed, evaluateCandyChallenge } = require('./candy-challenge.cjs');
const { readVillagePlan } = require('./village.cjs');
const { hourOf } = require('./watch.cjs');

const PRICES = { lantern: 2, web: 2, pumpkin: 3, cauldron: 4, bats: 5 };
const BASKET_PUMPKINS = 3, PUMPKIN_HOLD_MAX = 100, BREW_COST = 30, BREW_COOLDOWN_MS = 10 * 60 * 1000;
const BREW_TABLE = [{ n: 0, weight: 20 }, { n: 2, weight: 50 }, { n: 5, weight: 30 }];
const hasBasket = (player) => player.basket === true || (player.pumpkins || 0) >= BASKET_PUMPKINS;
// 호박은 서버가 밭에 심어 둔 것만 딸 수 있다. 화면은 자리 번호(s)를 마을 풀밭 칸으로 바꿔 그린다.
const MAX_CHALLENGE_LOG = 50, HARVEST_HOURS_KEPT = 25;
const FIELD_SIZE = 6, REGROW_MIN_MS = 6000, REGROW_MAX_MS = 12000, FIELD_CLOCK_SLACK_MS = 1000;
const plantPumpkin = (at) => ({ id: randomUUID().replace(/-/g, '').slice(0, 12), s: randomInt(0, 0x7fffffff), at });
const freshField = (now) => Array.from({ length: FIELD_SIZE }, () => plantPumpkin(now));
const fieldOf = (player, now) => (Array.isArray(player.field) && player.field.length ? player.field : freshField(now));
function brewGain(roll = randomInt(100)) {
  for (const { n, weight } of BREW_TABLE) {
    if (roll < weight) return n;
    roll -= weight;
  }
  return 0;
}
const roundOf = (event) => event?.id || 'practice';
// 잠금은 신호가 끊기거나 도전 시작 후 90초가 지나면 풀린다. 끝나는 순간의 요청이 늦게 와도 받도록 정산에는 여유를 둔다.
const FINISH_SLACK_MS = 10 * 1000;
const lockAlive = (lock, now, slack = 0) => Boolean(lock?.createdAt)
  && now - (lock.heartbeatAt || lock.createdAt) < CHALLENGE_LOCK_TTL_MS && now - lock.createdAt < CHALLENGE_MAX_MS + slack;
const balance = (player, event) => player.round === roundOf(event) ? player.candies : 10;
const isAdmin = (uid) => (process.env.GAME_ADMIN_UIDS || '').split(',').map((id) => id.trim()).includes(uid);
const fail = (message, status = 400) => { throw new AuthError(status, 'game-action-rejected', message); };
const MAX_GUESTS = 100;
// 다른 마을 방문자의 문서는 집주인이 구독하지 않으므로 집주인 문서에도 방문 기록을 남긴다.
const withGuest = (host, guest) => [...(host.guests || []), guest].slice(-MAX_GUESTS);
const rankPlayers = (docs, event, cutoff, includeExcluded = false) => docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  .filter((p) => p.costume && (includeExcluded || (!p.banned && !p.rankExcluded)) && (p.readyAt || p.joinedAt || 0) <= cutoff)
  .map((p) => ({ id: p.id, nick: p.nick, costume: p.costume, n: balance(p, event) }))
  .sort((a, b) => b.n - a.n || a.nick.localeCompare(b.nick, 'ko'));
async function finalResults(tx, db, event, cutoff) {
  if (event.results) return event.results;
  return rankPlayers((await tx.get(db.collection('gamePlayers'))).docs, event, cutoff, true);
}

const LEADERBOARD_MS = 3 * 60 * 1000;
let leaderboardMemo = null;
// 접속자 수와 관계없이 전체 플레이어 읽기가 3분에 한 번을 넘지 않도록 서버와 CDN이 같은 결과를 나눠 준다.
async function leaderboard(now = Date.now()) {
  if (leaderboardMemo && now - leaderboardMemo.at < LEADERBOARD_MS) return leaderboardMemo;
  const { db } = services();
  const [eventDoc, players] = await Promise.all([db.doc('game/event').get(), db.collection('gamePlayers').get()]);
  const event = eventDoc.exists ? eventDoc.data() : null;
  const villageOf = new Map(players.docs.map((doc) => [doc.id, doc.data().village || null]));
  const ended = event && event.endsAt <= now;
  const excluded = new Set(players.docs.filter((doc) => doc.data().rankExcluded || doc.data().banned).map((doc) => doc.id));
  const ranked = (event?.results || rankPlayers(players.docs, event, ended ? event.endsAt : Infinity)).filter((p) => !excluded.has(p.id));
  leaderboardMemo = { at: now, round: roundOf(event), players: ranked.map((p) => ({ ...p, village: villageOf.get(p.id) || null })) };
  return leaderboardMemo;
}

async function session(authorization) {
  const profile = await getProfile(authorization);
  const { db } = services();
  const ref = db.collection('gamePlayers').doc(profile.uid);
  const village = await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    const prior = existing.exists ? existing.data() : null;
    const readyAt = prior?.readyAt || (profile.costume ? Date.now() : 0);
    const plan = await readVillagePlan(tx, db, profile.costume && !prior?.village ? { id: profile.uid, readyAt } : null);
    const home = prior?.village || plan.villageOf.get(profile.uid);
    plan.write(profile.uid);
    const placed = home && !prior?.village ? { village: home } : {};
    const field = Array.isArray(prior?.field) && prior.field.length ? {} : { field: freshField(Date.now()) };
    if (!existing.exists) tx.create(ref, { ...profile, readyAt, pumpkins: 0, knocks: [], notes: [], guests: [], decor: {}, candies: 10, round: 'practice', ...placed, ...field });
    else tx.update(ref, { ...profile, ...(profile.costume && !prior.readyAt ? { readyAt } : {}), ...placed, ...field });
    return home || plan.latest;
  }, { maxAttempts: 20 });
  return { isAdmin: isAdmin(profile.uid), uid: profile.uid, village };
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
    if (player.banned) fail('이 계정은 게임 이용이 제한됐어요.', 403);
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
        if ((player.pumpkins || 0) >= PUMPKIN_HOLD_MAX) fail(`바구니가 꽉 찼어요. 호박은 ${PUMPKIN_HOLD_MAX}개까지 들 수 있어요.`);
        const planted = fieldOf(player, now);
        const picked = planted.find((p) => p.id === input.pumpkin);
        if (!picked) fail('이미 없어진 호박이에요. 다른 호박을 따 주세요.', 409);
        if (picked.at > now + FIELD_CLOCK_SLACK_MS) fail('아직 자라는 중인 호박이에요.', 409);
        const field = [...planted.filter((p) => p !== picked), plantPumpkin(now + randomInt(REGROW_MIN_MS, REGROW_MAX_MS + 1))];
        const pumpkins = (player.pumpkins || 0) + 1;
        const basket = hasBasket({ ...player, pumpkins });
        // 운영자 화면에서 오래 쉬지 않고 따는 계정을 볼 수 있게 시간대별 수확 수를 남긴다.
        const hour = String(hourOf(now));
        const harvestHours = Object.fromEntries(Object.entries({ ...(player.harvestHours || {}), [hour]: (player.harvestHours?.[hour] || 0) + 1 })
          .sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, HARVEST_HOURS_KEPT));
        tx.update(playerRef, { pumpkins, basket, harvestAt: now, field, harvestHours });
        result = { pumpkins, basket, field };
      } else if (type === 'brew') {
        if (!hasBasket(player)) fail('호박 바구니부터 만들어요.');
        if ((player.pumpkins || 0) < BREW_COST) fail(`호박이 ${BREW_COST}개 있어야 솥에 넣을 수 있어요.`);
        const wait = (player.brewAt || 0) + BREW_COOLDOWN_MS - now;
        if (wait > 0) fail(`솥이 아직 식는 중이에요. ${Math.ceil(wait / 60000)}분 뒤 다시 끓일 수 있어요.`, 429);
        const gain = brewGain();
        const pumpkins = player.pumpkins - BREW_COST;
        tx.update(playerRef, { round, candies: count + gain, pumpkins, basket: true, brewAt: now,
          brews: [...(player.brews || []), { at: now, n: gain, round }].slice(-20) });
        result = { gain, candies: count + gain, pumpkins, brewAt: now };
      } else if (type === 'decor') {
        if (typeof input.item !== 'string' || !Object.hasOwn(PRICES, input.item)) fail('장식을 확인해 주세요.');
        const price = PRICES[input.item];
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
        if (!host.exists || !host.data().costume || host.data().houseHidden || host.data().banned) fail('집을 찾을 수 없어요.');
        if (now - (player.noteAt || 0) < 2000) fail('잠시 뒤 다시 남겨 주세요.', 429);
        tx.update(playerRef, { noteAt: now, notes: [...(player.notes || []), { h: input.host, text, at: now }].slice(-100) });
        tx.update(host.ref, { guests: withGuest(host.data(), { v: uid, nick: player.nick, c: player.costume, text, at: now }) });
      } else if (type === 'knock-start') {
        if (input.host === uid || !/^[a-f0-9]{32}$/.test(input.host || '')) fail('노크할 집을 확인해 주세요.');
        if (!hasBasket(player)) fail('호박 3개로 바구니를 먼저 만드세요.');
        const lockRef = db.collection('gameHouseLocks').doc(input.host);
        const [host, pending] = await Promise.all([
          tx.get(db.collection('gamePlayers').doc(input.host)), tx.get(challengeRef),
        ]);
        const lockDoc = await tx.get(lockRef);
        if (!host.exists || !host.data().costume || host.data().houseHidden || host.data().banned) fail('집을 찾을 수 없어요.');
        if (now - (player.knockAt || 0) < 2000) fail('잠시 뒤 다시 노크해 주세요.', 429);
        const prior = pending.exists ? pending.data() : {};
        const priorAge = now - (prior.createdAt || 0);
        const priorIsUnfinished = prior.expiresAt ? prior.expiresAt > now : priorAge < STALE_CHALLENGE_MS;
        if (prior.round === round && !prior.used && priorIsUnfinished) {
          const priorLockRef = db.collection('gameHouseLocks').doc(prior.host);
          const priorLockDoc = prior.host === input.host ? lockDoc : await tx.get(priorLockRef);
          const priorLock = priorLockDoc.exists ? priorLockDoc.data() : null;
          const lastSeen = priorLock?.heartbeatAt || priorLock?.createdAt || 0;
          const priorLockIsActive = priorLock?.challengeId === prior.id && priorLock.challengerUid === uid
            && priorLock.round === round && lockAlive(priorLock, now);
          if (priorLockIsActive) fail('진행 중인 도전을 먼저 마쳐 주세요.', 429);
        }
        const lock = lockDoc.exists ? lockDoc.data() : null;
        const lockIsActive = lock?.round === round && lockAlive(lock, now);
        if (lockIsActive) fail('이 집은 지금 다른 사람이 도전 중이에요.', 429);
        const nextLevelByHost = prior.streakRound === round && prior.nextLevelByHost && typeof prior.nextLevelByHost === 'object'
          ? { ...prior.nextLevelByHost } : {};
        const level = Math.min(MAX_LEVEL, Math.max(1, Number(nextLevelByHost[input.host]) || 1));
        const challenge = {
          id: randomUUID(), host: input.host, round, createdAt: now, used: false,
          level, seed: createCandySeed(), nextLevelByHost, streakRound: round,
        };
        tx.set(challengeRef, challenge);
        tx.set(lockRef, { challengeId: challenge.id, challengerUid: uid, round, createdAt: now, heartbeatAt: now });
        result = { challenge: { id: challenge.id, host: challenge.host, round, createdAt: now, level, seed: challenge.seed } };
      } else if (type === 'knock-heartbeat') {
        const challengeDoc = await tx.get(challengeRef);
        const challenge = challengeDoc.exists ? challengeDoc.data() : null;
        if (!challenge || challenge.id !== input.challengeId || challenge.used || challenge.round !== round) {
          fail('도전이 끝났거나 다시 시작됐어요. 다시 시도해 주세요.');
        }
        const lockRef = db.collection('gameHouseLocks').doc(challenge.host);
        const lockDoc = await tx.get(lockRef);
        const lock = lockDoc.exists ? lockDoc.data() : null;
        if (now - challenge.createdAt >= CHALLENGE_MAX_MS) fail('도전 시간 90초가 지나 실패로 끝났어요. 다시 노크해 주세요.', 409);
        if (lock?.challengeId !== challenge.id || lock.challengerUid !== uid || lock.round !== round || !lockAlive(lock, now)) {
          fail('도전이 끝났거나 잠시 자리를 비워 잠금이 풀렸어요. 다시 도전해 주세요.', 409);
        }
        tx.update(lockRef, { heartbeatAt: now });
      } else if (type === 'knock-finish') {
        const challengeDoc = await tx.get(challengeRef);
        const challenge = challengeDoc.exists ? challengeDoc.data() : null;
        if (!challenge || challenge.id !== input.challengeId || challenge.used || challenge.round !== round) fail('도전이 끝났거나 다시 시작됐어요. 다시 시도해 주세요.');
        const hostRef = db.collection('gamePlayers').doc(challenge.host);
        const lockRef = db.collection('gameHouseLocks').doc(challenge.host);
        const [hostDoc, lockDoc] = await Promise.all([tx.get(hostRef), tx.get(lockRef)]);
        if (!hostDoc.exists) fail('집을 찾을 수 없어요.');
        if (hostDoc.data().houseHidden || hostDoc.data().banned) fail('운영자가 이 집의 도전을 중단했어요.');
        const lock = lockDoc.exists ? lockDoc.data() : null;
        if (lock?.challengeId !== challenge.id || lock.challengerUid !== uid || lock.round !== round || !lockAlive(lock, now, FINISH_SLACK_MS)) {
          fail('이 도전은 더 이상 유효하지 않아요. 다시 노크해 주세요.');
        }
        const outcome = evaluateCandyChallenge(challenge, input.inputs, input.elapsedMs, now);
        if (!outcome.valid) fail(outcome.message || '조작 기록을 확인해 주세요.');
        if (!outcome.finished) fail('도전이 아직 끝나지 않았어요.');
        const win = outcome.won;
        const hostCount = balance(hostDoc.data(), event);
        const moved = win && hostCount > 0;
        const nextLevelByHost = challenge.streakRound === round && challenge.nextLevelByHost
          ? { ...challenge.nextLevelByHost } : {};
        if (win) nextLevelByHost[challenge.host] = Math.min(MAX_LEVEL, challenge.level + 1);
        else delete nextLevelByHost[challenge.host];
        const entry = { h: challenge.host, r: win ? 'win' : 'lose', at: now, c: player.costume, round, moved, level: challenge.level };
        const playerUpdate = { round, candies: count + (moved ? 1 : 0), knockAt: now,
          challenges: [...(player.challenges || []), { at: now, h: challenge.host, w: win, ms: outcome.at, lv: challenge.level, m: moved }].slice(-MAX_CHALLENGE_LOG) };
        if (win) playerUpdate.knocks = [...(player.knocks || []), entry].slice(-100);
        tx.update(playerRef, playerUpdate);
        if (win) tx.update(hostRef, { ...(moved ? { round, candies: hostCount - 1 } : {}),
          guests: withGuest(hostDoc.data(), { ...entry, v: uid, nick: player.nick }) });
        tx.update(challengeRef, { used: true, nextLevelByHost, streakRound: round });
        tx.delete(lockRef);
        result = { entry, candies: count + (moved ? 1 : 0), hostCandies: hostCount - (moved ? 1 : 0) };
      } else fail('지원하지 않는 행동이에요.');
    }
    if (type !== 'knock-heartbeat') {
      tx.create(receiptRef, { uid, type, result, createdAt: now });
      tx.create(db.collection('gameActivity').doc(uid).collection('entries').doc(input.requestId), {
        uid, type, at: now, round, ...(typeof input.host === 'string' && /^[a-f0-9]{32}$/.test(input.host) ? { host: input.host } : {}),
        ...(type === 'knock-finish' && result.entry ? { host: result.entry.h, outcome: result.entry.r, moved: result.entry.moved, level: result.entry.level } : {}),
      });
    }
    return result;
  }, { maxAttempts: 20 });
}

module.exports = { PRICES, FIELD_SIZE, LEADERBOARD_MS, leaderboard, session, action, balance, roundOf, evaluateCandyChallenge, brewGain, BREW_COST, BREW_COOLDOWN_MS, PUMPKIN_HOLD_MAX };
