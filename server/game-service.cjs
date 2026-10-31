const { randomUUID, randomInt } = require('node:crypto');
const { services } = require('./firebase-admin.cjs');
const { authenticatedUid, getProfile } = require('./auth-service.cjs');
const { AuthError } = require('./errors.cjs');
const { MAX_LEVEL, STALE_CHALLENGE_MS, CHALLENGE_LOCK_TTL_MS, CHALLENGE_MAX_MS, createCandySeed, evaluateCandyChallenge } = require('./candy-challenge.cjs');
const { readVillagePlan } = require('./village.cjs');
const { hourOf } = require('./watch.cjs');

const PRICES = { lantern: 2, web: 2, pumpkin: 3, cauldron: 4, bats: 5 };
const ITEMS = Object.freeze({
  'house-ward': Object.freeze({ price: 5, durationMs: 5 * 60 * 1000, cooldownMs: 20 * 60 * 1000 }),
});
const ITEM_INVENTORY_MAX = 99, MAX_ITEM_PURCHASES = 200;
const DUEL_MAX_STAKE = 10, DUEL_INVITE_MS = 60 * 1000, DUEL_IDLE_MS = 30 * 1000, DUEL_MAX_MS = 90 * 1000;
const DUEL_BONK_RANGE = 22, DUEL_BONK_COOLDOWN_MS = 600, DUEL_BONK_RESET_MS = 6000, DUEL_BONK_TO_STUN = 5;
// 사탕 잡기에 실패하면 사탕은 그대로 두고 장난 하나를 당한다. 화면의 TRICKS와 이름이 같아야 한다.
const TRICK_KINDS = ['doodle', 'reverse', 'slow', 'poop', 'dark'];
const BASKET_PUMPKINS = 3, PUMPKIN_HOLD_MAX = 100, BREW_COST = 30, BREW_COOLDOWN_MS = 5 * 60 * 1000;
const BREW_TABLE = [{ n: 0, weight: 20 }, { n: 2, weight: 50 }, { n: 5, weight: 30 }];
const hasBasket = (player) => player.basket === true || (player.pumpkins || 0) >= BASKET_PUMPKINS;
// 호박은 서버가 밭에 심어 둔 것만 딸 수 있다. 화면은 자리 번호(s)를 마을 풀밭 칸으로 바꿔 그린다.
const MAX_CHALLENGE_LOG = 50, HARVEST_HOURS_KEPT = 25;
const FIELD_SIZE = 6, REGROW_MIN_MS = 6000, REGROW_MAX_MS = 12000, FIELD_CLOCK_SLACK_MS = 1000;
const plantPumpkin = (at) => ({ id: randomUUID().replace(/-/g, '').slice(0, 12), s: randomInt(0, 0x7fffffff), at });
const freshField = (now) => Array.from({ length: FIELD_SIZE }, () => plantPumpkin(now));
const fieldOf = (player, now) => (Array.isArray(player.field) && player.field.length ? player.field : freshField(now));
// 자주 바뀌는 호박·영수증·활동 기록은 본인만 읽는 비공개 문서에 둔다.
// 마을 사람 모두가 구독하는 공개 문서를 덜 바꿔야 호박 하나에 마을 인원만큼 읽기가 생기지 않는다.
const MAX_RECEIPTS = 20, MAX_ACTIVITY = 30;
const privateState = (doc, player, now) => (doc.exists ? doc.data() : {
  pumpkins: Number(player?.pumpkins) || 0, harvestAt: player?.harvestAt || 0, field: fieldOf(player || {}, now),
  harvestHours: player?.harvestHours || {}, inventory: {}, receipts: [], activity: [],
});
function brewGain(roll = randomInt(100)) {
  for (const { n, weight } of BREW_TABLE) {
    if (roll < weight) return n;
    roll -= weight;
  }
  return 0;
}
// 예약된 이벤트는 시작 시각 전까지 연습 기록으로 돈다. 시작 시각이 되면 문서를 바꾸지 않아도 모두 새 라운드(사탕 10개)가 된다.
const roundOf = (event, now = Date.now()) => (event?.id && now >= (event.startedAt || 0) ? event.id : 'practice');
const EVENT_MAX_MS = 48 * 60 * 60 * 1000;
// 잠금은 신호가 끊기거나 도전 시작 후 90초가 지나면 풀린다. 끝나는 순간의 요청이 늦게 와도 받도록 정산에는 여유를 둔다.
const FINISH_SLACK_MS = 10 * 1000;
const KNOCK_EARLY_LEAVE_MS = 5 * 1000;
const lockAlive = (lock, now, slack = 0) => Boolean(lock?.createdAt)
  && now - (lock.heartbeatAt || lock.createdAt) < CHALLENGE_LOCK_TTL_MS && now - lock.createdAt < CHALLENGE_MAX_MS + slack;
const balance = (player, event, now = Date.now()) => player.round === roundOf(event, now) ? player.candies : 10;
const isAdmin = (uid) => (process.env.GAME_ADMIN_UIDS || '').split(',').map((id) => id.trim()).includes(uid);
const fail = (message, status = 400) => { throw new AuthError(status, 'game-action-rejected', message); };
const duelRefFor = (db, input) => {
  if (typeof input?.duelId !== 'string' || !/^[A-Za-z0-9]{20}$/.test(input.duelId)) fail('대전 번호를 확인해 주세요.');
  return db.collection('gameDuels').doc(input.duelId);
};
const duelPeer = (value, uid) => {
  if (typeof value !== 'string') return null;
  const [owner, sid, ...rest] = value.split(':');
  return owner === uid && !rest.length && /^[0-9a-f-]{36}$/i.test(sid) ? sid : null;
};
async function duelPresence(database, village, peer, uid, now) {
  const sid = duelPeer(peer, uid);
  if (!sid) return null;
  const snapshot = await database.ref(`presence/${village}/${uid}/${sid}`).get();
  const presence = snapshot.val();
  const at = Number(presence?.at), x = Number(presence?.x), y = Number(presence?.y);
  if (!presence || !Number.isFinite(at) || at > now + 1000 || now - at > 25000 || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}
const MAX_GUESTS = 100;
// 다른 마을 방문자의 문서는 집주인이 구독하지 않으므로 집주인 문서에도 방문 기록을 남긴다.
const withGuest = (host, guest) => [...(host.guests || []), guest].slice(-MAX_GUESTS);
const rankPlayers = (docs, event, cutoff, includeExcluded = false) => docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  .filter((p) => p.costume && (includeExcluded || (!p.banned && !p.rankExcluded)) && (p.readyAt || p.joinedAt || 0) <= cutoff)
  .map((p) => ({ id: p.id, nick: p.nick, costume: p.costume, n: balance(p, event) }))
  .sort((a, b) => b.n - a.n || a.nick.localeCompare(b.nick, 'ko'));
async function finalResults(tx, db, event, cutoff, suppliedPlayers = null) {
  if (event.results) return event.results;
  return rankPlayers((suppliedPlayers || (await tx.get(db.collection('gamePlayers'))).docs), event, cutoff, true);
}

// Event changes and natural result freezes settle escrow even when both clients have disconnected.
async function readDuelSettlement(tx, db, event, now, { force = false } = {}) {
  const duels = await tx.get(db.collection('gameDuels').where('status', '==', 'active'));
  if (duels.empty) return { players: null, hasLiveDuels: false, apply() {} };
  const expiredDuels = duels.docs.filter((doc) => {
    const duel = doc.data();
    return force || now >= duel.expiresAt || now >= duel.hardDeadline;
  });
  const hasLiveDuels = expiredDuels.length < duels.docs.length;
  if (hasLiveDuels) return { players: null, hasLiveDuels, apply() {} };
  if (!expiredDuels.length) return { players: null, hasLiveDuels, apply() {} };
  const playerDocs = await tx.get(db.collection('gamePlayers'));
  const playerById = new Map(playerDocs.docs.map((doc) => [doc.id, doc]));
  const ids = [...new Set(expiredDuels.flatMap((doc) => doc.data().players || []))];
  const lockRefs = ids.map((id) => db.collection('gameDuelLocks').doc(id));
  const locks = await Promise.all(lockRefs.map((ref) => tx.get(ref)));
  const refunds = new Map();
  for (const duelDoc of expiredDuels) {
    const duel = duelDoc.data();
    for (const id of duel.players || []) {
      const playerDoc = playerById.get(id);
      if (!playerDoc) continue;
      const stake = Number(duel.stake);
      if (Number.isSafeInteger(stake) && stake > 0) refunds.set(id, (refunds.get(id) || 0) + stake);
    }
  }
  const updates = new Map([...refunds].map(([id, amount]) => {
    const player = playerById.get(id).data();
    return [id, { round: roundOf(event, now), candies: balance(player, event, now) + amount }];
  }));
  const players = playerDocs.docs.map((doc) => ({ id: doc.id, data: () => ({ ...doc.data(), ...(updates.get(doc.id) || {}) }) }));
  return {
    players,
    hasLiveDuels,
    apply() {
      for (const [id, update] of updates) tx.update(db.collection('gamePlayers').doc(id), update);
      for (const duelDoc of expiredDuels) {
        tx.update(duelDoc.ref, { status: 'expired', updatedAt: now, completedAt: now, winner: null, loser: null, refunded: true });
      }
      const activeIds = new Set(expiredDuels.map((duel) => duel.id));
      for (let i = 0; i < lockRefs.length; i++) {
        if (activeIds.has(locks[i].data()?.duelId)) tx.delete(lockRefs[i]);
      }
    },
  };
}

const LEADERBOARD_MS = 3 * 60 * 1000;
let leaderboardMemo = null;
// 호박은 1.5초마다 딸 수 있어 가장 자주 오는 요청이다. 호박 따기만 다른 요청이 방금 읽은 이벤트를 10초 동안 다시 쓴다.
// 이벤트가 시간이 되어 끝나는 건 기억한 종료 시각으로 바로 막히고, 운영자가 바꾼 이벤트는 늦어도 10초 뒤 반영된다.
const EVENT_MEMO_MS = 10 * 1000;
let eventMemo = null;
const rememberEvent = (event, at = Date.now()) => { eventMemo = { at, event }; return event; };
const recentEvent = (now) => (eventMemo && now - eventMemo.at < EVENT_MEMO_MS ? eventMemo : null);
// 접속자 수와 관계없이 전체 플레이어 읽기가 3분에 한 번을 넘지 않도록 서버와 CDN이 같은 결과를 나눠 준다.
async function leaderboard(now = Date.now()) {
  if (leaderboardMemo && now - leaderboardMemo.at < LEADERBOARD_MS) return leaderboardMemo;
  const { db } = services();
  const [eventDoc, players] = await Promise.all([db.doc('game/event').get(), db.collection('gamePlayers').get()]);
  const event = rememberEvent(eventDoc.exists ? eventDoc.data() : null);
  const villageOf = new Map(players.docs.map((doc) => [doc.id, doc.data().village || null]));
  const ended = event && event.endsAt <= now;
  // 운영자가 누르지 않아도 끝난 이벤트의 결과는 종료 후 첫 순위 요청에서 한 번 고정해 기록해 둔다.
  const results = event?.results || (ended ? await freezeResults(db) : null);
  const excluded = new Set(players.docs.filter((doc) => doc.data().rankExcluded || doc.data().banned).map((doc) => doc.id));
  const ranked = (results || rankPlayers(players.docs, event, ended ? event.endsAt : Infinity)).filter((p) => !excluded.has(p.id));
  leaderboardMemo = { at: now, round: roundOf(event, now), players: ranked.map((p) => ({ ...p, village: villageOf.get(p.id) || null })) };
  return leaderboardMemo;
}

async function freezeResults(db) {
  const eventRef = db.doc('game/event');
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(eventRef);
    const event = doc.exists ? doc.data() : null;
    if (!event || event.results || event.endsAt > Date.now()) return event?.results || null;
    const settlement = await readDuelSettlement(tx, db, event, Date.now(), { force: true });
    const results = await finalResults(tx, db, event, event.endsAt, settlement.players);
    settlement.apply();
    tx.set(eventRef, { ...event, results });
    tx.set(db.collection('gameRounds').doc(event.id), { ...event, results });
    return results;
  }, { maxAttempts: 20 });
}

// 3시 사탕 보충: 이벤트 중 3시가 지나 다시 접속했을 때 사탕이 10개보다 적으면 한 번만 10개까지 채운다.
// 0개인 사람만 채우면 몇 개 남은 사람보다 많아져 순서가 뒤집히므로 모자란 만큼 채운다.
// 밴되었거나 순위에서 빠진 계정과 끝난 이벤트는 채우지 않는다. 시각은 GAME_REFILL_AT으로 바꿀 수 있다.
const REFILL_ID = 'refill-1031-1500', REFILL_CANDIES = 10;
const refillAt = () => Date.parse(process.env.GAME_REFILL_AT || '2026-10-31T15:00:00+09:00');
function refillOf(player, event, now, escrowedCandies = 0) {
  if (now < refillAt() || !player?.costume || player.banned || player.rankExcluded) return null;
  const have = balance(player, event, now) + escrowedCandies;
  if ((event && event.endsAt <= now) || player.refill?.id === REFILL_ID || have >= REFILL_CANDIES) return null;
  return { round: roundOf(event, now), candies: Math.max(0, REFILL_CANDIES - escrowedCandies),
    refill: { id: REFILL_ID, at: now, n: REFILL_CANDIES - have } };
}

async function session(authorization) {
  const profile = await getProfile(authorization);
  const { db } = services();
  const ref = db.collection('gamePlayers').doc(profile.uid);
  const privateRef = db.collection('gamePrivate').doc(profile.uid);
  const duelLockRef = db.collection('gameDuelLocks').doc(profile.uid);
  const village = await db.runTransaction(async (tx) => {
    const now = Date.now();
    const [existing, privateDoc, eventDoc, duelLockDoc] = await Promise.all([
      tx.get(ref), tx.get(privateRef), tx.get(db.doc('game/event')), tx.get(duelLockRef),
    ]);
    const event = eventDoc.exists ? eventDoc.data() : null;
    const prior = existing.exists ? existing.data() : null;
    const duelLock = duelLockDoc.data();
    let escrowedCandies = 0;
    if (duelLock?.status === 'active' && /^[A-Za-z0-9]{20}$/.test(duelLock.duelId || '')) {
      const duelDoc = await tx.get(db.collection('gameDuels').doc(duelLock.duelId));
      const duel = duelDoc.exists ? duelDoc.data() : null;
      if (duel?.status === 'active' && duel.players?.includes(profile.uid)) escrowedCandies = Number(duel.stake) || 0;
    }
    const refill = refillOf(prior, event, now, escrowedCandies) || {};
    const readyAt = prior?.readyAt || (profile.costume ? Date.now() : 0);
    const plan = await readVillagePlan(tx, db, profile.costume && !prior?.village ? { id: profile.uid, readyAt } : null);
    const home = prior?.village || plan.villageOf.get(profile.uid);
    plan.write(profile.uid);
    const placed = home && !prior?.village ? { village: home } : {};
    if (!privateDoc.exists) tx.set(privateRef, privateState(privateDoc, prior, Date.now()));
    if (!existing.exists) tx.create(ref, { ...profile, readyAt, knocks: [], notes: [], guests: [], decor: {}, candies: 10, round: 'practice', ...placed });
    else tx.update(ref, { ...profile, ...(profile.costume && !prior.readyAt ? { readyAt } : {}), ...placed, ...refill });
    return home || plan.latest;
  }, { maxAttempts: 20 });
  return { isAdmin: isAdmin(profile.uid), uid: profile.uid, village };
}

async function action(authorization, input) {
  // 밴은 트랜잭션 안에서 읽는 내 문서의 banned로 확인해, 요청마다 밴 문서를 따로 읽지 않는다.
  const uid = await authenticatedUid(authorization, { checkBan: false });
  if (!input || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.requestId || '')) fail('요청 번호를 확인해 주세요.');
  const { db } = services();
  const playerRef = db.collection('gamePlayers').doc(uid);
  const eventRef = db.doc('game/event');
  const privateRef = db.collection('gamePrivate').doc(uid);
  const challengeRef = db.collection('gameChallenges').doc(uid);
  const done = await db.runTransaction(async (tx) => {
    const remembered = input.type === 'harvest' ? recentEvent(Date.now()) : null;
    const [privateDoc, playerDoc, eventDoc] = await Promise.all([tx.get(privateRef), tx.get(playerRef), remembered ? null : tx.get(eventRef)]);
    const event = remembered ? remembered.event : rememberEvent(eventDoc.exists ? eventDoc.data() : null);
    if (!playerDoc.exists) fail('다시 로그인해 주세요.', 401);
    const now = Date.now();
    const mine = privateState(privateDoc, playerDoc.data(), now);
    const receipt = (mine.receipts || []).find((item) => item.id === input.requestId);
    if (receipt) return receipt.result;
    const player = { ...playerDoc.data(), pumpkins: mine.pumpkins };
    if (player.banned) fail('이 계정은 게임 이용이 제한됐어요.', 403);
    const round = roundOf(event, now);
    let privateUpdate = {};
    const count = balance(player, event, now);
    const type = input.type;
    let result = {};
    if (type === 'event-start' || type === 'event-stop') {
      if (!isAdmin(uid)) fail('운영자만 이벤트를 변경할 수 있어요.', 403);
      const settlement = await readDuelSettlement(tx, db, event, now);
      if (settlement.hasLiveDuels) fail('진행 중인 1대1 대전이 끝난 뒤 이벤트를 바꿀 수 있어요.', 409);
      if (type === 'event-start') {
        if (event && event.endsAt > now) fail(now < event.startedAt ? '이미 예약된 이벤트가 있어요. 취소한 뒤 다시 예약해 주세요.' : '이벤트가 이미 진행 중이에요.');
        // 시작·종료 시각을 주면 예약하고, 없으면 지금부터 24시간이다.
        const startedAt = input.startAt === undefined ? now : input.startAt;
        const endsAt = input.endAt === undefined ? startedAt + 86400000 : input.endAt;
        if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(endsAt) || startedAt < now - 60000
          || endsAt <= Math.max(startedAt, now) || endsAt - startedAt > EVENT_MAX_MS) fail('이벤트 시작·종료 시각을 확인해 주세요.');
        if (event) {
          const results = await finalResults(tx, db, event, event.endsAt, settlement.players);
          tx.set(db.collection('gameRounds').doc(event.id), { ...event, results });
        }
        result.event = { id: randomUUID(), startedAt, endsAt };
        settlement.apply();
        tx.set(eventRef, result.event);
      } else if (event && !event.results && now < event.startedAt) {
        // 시작 전인 예약은 결과 없이 취소한다. 그동안의 기록은 연습 기록으로 남는다.
        settlement.apply();
        tx.delete(eventRef);
        result.event = null;
      } else {
        if (!event || event.results) fail('진행 중인 이벤트가 없어요.');
        const cutoff = Math.min(event.endsAt, now);
        const results = await finalResults(tx, db, event, cutoff, settlement.players);
        result.event = { ...event, endsAt: cutoff, results };
        settlement.apply();
        tx.set(db.collection('gameRounds').doc(event.id), result.event);
        tx.set(eventRef, result.event);
      }
    } else {
      if (!player.costume) fail('분장을 먼저 골라 주세요.');
      if (event && event.endsAt <= now && !['knock-leave', 'duel-cancel', 'duel-decline', 'duel-expire'].includes(type)) fail('이벤트가 끝났어요. 결과가 보존됩니다.');
      if (type === 'harvest') {
        if (now - (mine.harvestAt || 0) < 1500) fail('조금 뒤 다른 호박을 따 주세요.', 429);
        if ((player.pumpkins || 0) >= PUMPKIN_HOLD_MAX) fail(`바구니가 꽉 찼어요. 호박은 ${PUMPKIN_HOLD_MAX}개까지 들 수 있어요.`);
        const planted = fieldOf(mine, now);
        const picked = planted.find((p) => p.id === input.pumpkin);
        if (!picked) fail('이미 없어진 호박이에요. 다른 호박을 따 주세요.', 409);
        if (picked.at > now + FIELD_CLOCK_SLACK_MS) fail('아직 자라는 중인 호박이에요.', 409);
        const field = [...planted.filter((p) => p !== picked), plantPumpkin(now + randomInt(REGROW_MIN_MS, REGROW_MAX_MS + 1))];
        const pumpkins = (player.pumpkins || 0) + 1;
        const basket = hasBasket({ ...player, pumpkins });
        // 운영자 화면에서 오래 쉬지 않고 따는 계정을 볼 수 있게 시간대별 수확 수를 남긴다.
        const hour = String(hourOf(now));
        const harvestHours = Object.fromEntries(Object.entries({ ...(mine.harvestHours || {}), [hour]: (mine.harvestHours?.[hour] || 0) + 1 })
          .sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, HARVEST_HOURS_KEPT));
        privateUpdate = { pumpkins, harvestAt: now, field, harvestHours };
        // 공개 문서는 바구니를 처음 만드는 한 번만 바꾼다. 다른 사람 화면에는 바구니 여부만 필요하다.
        if (basket && player.basket !== true) tx.update(playerRef, { basket: true });
        result = { pumpkins, basket, field };
      } else if (type === 'brew') {
        if (!hasBasket(player)) fail('호박 바구니부터 만들어요.');
        if ((player.pumpkins || 0) < BREW_COST) fail(`호박이 ${BREW_COST}개 있어야 솥에 넣을 수 있어요.`);
        const wait = (player.brewAt || 0) + BREW_COOLDOWN_MS - now;
        if (wait > 0) fail(`솥이 아직 식는 중이에요. ${Math.ceil(wait / 60000)}분 뒤 다시 끓일 수 있어요.`, 429);
        const gain = brewGain();
        const pumpkins = player.pumpkins - BREW_COST;
        tx.update(playerRef, { round, candies: count + gain, basket: true, brewAt: now,
          brews: [...(player.brews || []), { at: now, n: gain, round }].slice(-20) });
        privateUpdate = { pumpkins };
        result = { gain, candies: count + gain, pumpkins, brewAt: now };
      } else if (type === 'decor') {
        if (typeof input.item !== 'string' || !Object.hasOwn(PRICES, input.item)) fail('장식을 확인해 주세요.');
        const price = PRICES[input.item];
        if (player.decor?.[input.item]?.round === round) fail('이미 설치한 장식이에요.');
        if (count < price) fail('사탕이 부족해요.');
        tx.update(playerRef, { round, candies: count - price, decor: { ...(player.decor || {}), [input.item]: { at: now, round } } });
        result = { candies: count - price };
      } else if (type === 'item-buy') {
        if (typeof input.item !== 'string' || !Object.hasOwn(ITEMS, input.item)) fail('아이템을 확인해 주세요.');
        const item = ITEMS[input.item];
        const inventory = mine.inventory && typeof mine.inventory === 'object' && !Array.isArray(mine.inventory) ? { ...mine.inventory } : {};
        const held = Number(inventory[input.item] || 0);
        if (!Number.isSafeInteger(held) || held < 0 || held >= ITEM_INVENTORY_MAX) fail(`아이템은 ${ITEM_INVENTORY_MAX}개까지 보유할 수 있어요.`);
        if (count < item.price) fail('사탕이 부족해요.');
        const purchase = { item: input.item, price: item.price, at: now, round };
        inventory[input.item] = held + 1;
        tx.update(playerRef, { round, candies: count - item.price,
          itemPurchases: [...(player.itemPurchases || []), purchase].slice(-MAX_ITEM_PURCHASES) });
        privateUpdate = { inventory };
        result = { candies: count - item.price, inventory, purchase, round };
      } else if (type === 'item-use') {
        if (typeof input.item !== 'string' || !Object.hasOwn(ITEMS, input.item)) fail('아이템을 확인해 주세요.');
        const item = ITEMS[input.item];
        const inventory = mine.inventory && typeof mine.inventory === 'object' && !Array.isArray(mine.inventory) ? { ...mine.inventory } : {};
        const held = Number(inventory[input.item] || 0);
        if (!Number.isSafeInteger(held) || held <= 0) fail('사용할 아이템이 없어요.');
        const usedAt = Number(mine.houseGuardUsedAt) || 0;
        const wait = usedAt + item.cooldownMs - now;
        if (wait > 0) fail(`호박 수호 부적은 아직 다시 쓸 수 없어요. ${Math.ceil(wait / 60000)}분 뒤 사용해 주세요.`, 429);
        if ((Number(player.guardUntil) || 0) > now) fail('호박 수호 부적이 이미 작동 중이에요.', 429);
        inventory[input.item] = held - 1;
        const guardUntil = now + item.durationMs;
        tx.update(playerRef, { guardUntil });
        privateUpdate = { inventory, houseGuardUsedAt: now };
        result = { inventory, usedAt: now, guardUntil };
      } else if (type === 'duel-offer') {
        const targetUid = input.opponent;
        const stake = input.stake;
        const village = input.village;
        if (typeof targetUid !== 'string' || !/^[a-f0-9]{32}$/.test(targetUid) || targetUid === uid) fail('대전 상대를 확인해 주세요.');
        if (!Number.isSafeInteger(stake) || stake < 1 || stake > DUEL_MAX_STAKE) fail(`사탕은 1개부터 ${DUEL_MAX_STAKE}개까지 걸 수 있어요.`);
        if (!Number.isSafeInteger(village) || village < 1 || village > 9999) fail('같은 마을에 있는 사람에게만 대전을 신청할 수 있어요.');
        const targetRef = db.collection('gamePlayers').doc(targetUid);
        const senderLockRef = db.collection('gameDuelLocks').doc(uid);
        const targetLockRef = db.collection('gameDuelLocks').doc(targetUid);
        const [targetDoc, senderLockDoc, targetLockDoc] = await Promise.all([tx.get(targetRef), tx.get(senderLockRef), tx.get(targetLockRef)]);
        if (!targetDoc.exists || !targetDoc.data().costume || targetDoc.data().houseHidden || targetDoc.data().banned) fail('대전 상대를 찾을 수 없어요.');
        const { database } = services();
        const [challengerPresence, opponentPresence] = await Promise.all([
          duelPresence(database, village, input.challengerPeer, uid, now),
          duelPresence(database, village, input.opponentPeer, targetUid, now),
        ]);
        if (!challengerPresence || !opponentPresence
          || Math.hypot(challengerPresence.x - opponentPresence.x, challengerPresence.y - opponentPresence.y) > DUEL_BONK_RANGE) {
          fail('같은 마을에서 상대 캐릭터 가까이 다가가 주세요.', 409);
        }
        const unavailable = (doc) => doc.exists && (doc.data().status === 'active' || (doc.data().status === 'pending' && doc.data().until > now));
        if (unavailable(senderLockDoc)) fail('이미 대기 중이거나 진행 중인 대전이 있어요.', 409);
        if (unavailable(targetLockDoc)) fail('상대가 이미 대기 중이거나 진행 중인 대전이 있어요.', 409);
        if (count < stake) fail(`사탕이 ${stake}개 있어야 해요.`);
        const duelRef = db.collection('gameDuels').doc();
        const duel = { id: duelRef.id, players: [uid, targetUid], challenger: uid, opponent: targetUid, stake,
          round, village, challengerPeer: input.challengerPeer, opponentPeer: input.opponentPeer,
          status: 'pending', createdAt: now, updatedAt: now, expiresAt: now + DUEL_INVITE_MS };
        tx.create(duelRef, duel);
        tx.set(senderLockRef, { duelId: duel.id, status: 'pending', until: duel.expiresAt });
        tx.set(targetLockRef, { duelId: duel.id, status: 'pending', until: duel.expiresAt });
        result = duel;
      } else if (type === 'duel-accept') {
        const duelRef = duelRefFor(db, input);
        const duelDoc = await tx.get(duelRef);
        const duel = duelDoc.exists ? duelDoc.data() : null;
        if (!duel || duel.status !== 'pending' || duel.opponent !== uid) fail('받을 수 있는 대전 신청이 없어요.', 409);
        if (duel.expiresAt <= now) fail('대전 신청 시간이 끝났어요.', 409);
        if (duel.round !== round || input.village !== duel.village) fail('마을이나 이벤트가 바뀌어 대전을 시작할 수 없어요.', 409);
        const challengerRef = db.collection('gamePlayers').doc(duel.challenger);
        const challengerLockRef = db.collection('gameDuelLocks').doc(duel.challenger);
        const opponentLockRef = db.collection('gameDuelLocks').doc(uid);
        const [challengerDoc, challengerLockDoc, opponentLockDoc] = await Promise.all([
          tx.get(challengerRef), tx.get(challengerLockRef), tx.get(opponentLockRef),
        ]);
        if (!challengerDoc.exists || !challengerDoc.data().costume || challengerDoc.data().banned || challengerDoc.data().houseHidden) fail('대전 상대를 찾을 수 없어요.');
        if (challengerLockDoc.data()?.duelId !== duel.id || opponentLockDoc.data()?.duelId !== duel.id) fail('대전 신청이 이미 바뀌었어요.', 409);
        const { database } = services();
        const [challengerPresence, opponentPresence] = await Promise.all([
          duelPresence(database, duel.village, duel.challengerPeer, duel.challenger, now),
          duelPresence(database, duel.village, input.peer, uid, now),
        ]);
        if (!challengerPresence || !opponentPresence
          || Math.hypot(challengerPresence.x - opponentPresence.x, challengerPresence.y - opponentPresence.y) > DUEL_BONK_RANGE) {
          fail('두 사람 모두 같은 마을에서 가까이 있어야 해요.', 409);
        }
        const challengerBalance = balance(challengerDoc.data(), event, now);
        if (count < duel.stake || challengerBalance < duel.stake) fail('두 사람 모두 걸 사탕이 충분해야 해요.');
        const roundBoundary = event ? (event.startedAt > now ? event.startedAt : event.endsAt) : Infinity;
        const hardDeadline = Math.min(now + DUEL_MAX_MS, roundBoundary - 5000);
        if (hardDeadline - now < DUEL_MAX_MS) fail('이벤트 종료가 가까워 새 대전을 시작할 수 없어요.', 409);
        const expiresAt = Math.min(now + DUEL_IDLE_MS, hardDeadline);
        const hits = { [duel.challenger]: { count: 0, at: 0 }, [uid]: { count: 0, at: 0 } };
        tx.update(playerRef, { round, candies: count - duel.stake });
        tx.update(challengerRef, { round, candies: challengerBalance - duel.stake });
        tx.update(duelRef, { status: 'active', acceptedAt: now, updatedAt: now, hits, lastHitAt: {}, hardDeadline, expiresAt });
        tx.set(challengerLockRef, { duelId: duel.id, status: 'active', until: expiresAt });
        tx.set(opponentLockRef, { duelId: duel.id, status: 'active', until: expiresAt });
        result = { ...duel, status: 'active', acceptedAt: now, hits, hardDeadline, expiresAt };
      } else if (type === 'duel-decline' || type === 'duel-cancel') {
        const duelRef = duelRefFor(db, input);
        const duelDoc = await tx.get(duelRef);
        const duel = duelDoc.exists ? duelDoc.data() : null;
        const allowed = duel?.status === 'pending' && (type === 'duel-decline' ? duel.opponent === uid : duel.challenger === uid);
        if (!allowed) fail('취소할 수 있는 대전 신청이 없어요.', 409);
        const challengerLockRef = db.collection('gameDuelLocks').doc(duel.challenger);
        const opponentLockRef = db.collection('gameDuelLocks').doc(duel.opponent);
        const [challengerLockDoc, opponentLockDoc] = await Promise.all([tx.get(challengerLockRef), tx.get(opponentLockRef)]);
        const status = type === 'duel-cancel' ? 'cancelled' : 'declined';
        tx.update(duelRef, { status, updatedAt: now, completedAt: now });
        if (challengerLockDoc.data()?.duelId === duel.id) tx.delete(challengerLockRef);
        if (opponentLockDoc.data()?.duelId === duel.id) tx.delete(opponentLockRef);
        result = { id: duel.id, status };
      } else if (type === 'duel-expire') {
        const duelRef = duelRefFor(db, input);
        const duelDoc = await tx.get(duelRef);
        const duel = duelDoc.exists ? duelDoc.data() : null;
        if (!duel || !duel.players?.includes(uid) || !['pending', 'active'].includes(duel.status)) fail('끝낼 대전이 없어요.', 409);
        if (now < duel.expiresAt) fail('대전 제한 시간이 아직 남아 있어요.', 409);
        const challengerRef = db.collection('gamePlayers').doc(duel.challenger);
        const opponentRef = db.collection('gamePlayers').doc(duel.opponent);
        const challengerLockRef = db.collection('gameDuelLocks').doc(duel.challenger);
        const opponentLockRef = db.collection('gameDuelLocks').doc(duel.opponent);
        const [challengerDoc, opponentDoc, challengerLockDoc, opponentLockDoc] = await Promise.all([
          tx.get(challengerRef), tx.get(opponentRef), tx.get(challengerLockRef), tx.get(opponentLockRef),
        ]);
        if (duel.status === 'active') {
          if (!challengerDoc.exists || !opponentDoc.exists) fail('두 사람의 사탕을 돌려주지 못했어요. 운영자에게 알려 주세요.', 409);
          const challengerBalance = balance(challengerDoc.data(), event, now) + duel.stake;
          const opponentBalance = balance(opponentDoc.data(), event, now) + duel.stake;
          tx.update(challengerRef, { round: duel.round, candies: challengerBalance });
          tx.update(opponentRef, { round: duel.round, candies: opponentBalance });
        }
        tx.update(duelRef, { status: 'expired', updatedAt: now, completedAt: now, winner: null, loser: null, refunded: duel.status === 'active' });
        if (challengerLockDoc.data()?.duelId === duel.id) tx.delete(challengerLockRef);
        if (opponentLockDoc.data()?.duelId === duel.id) tx.delete(opponentLockRef);
        result = { id: duel.id, status: 'expired', refunded: duel.status === 'active' };
      } else if (type === 'duel-hit') {
        const duelRef = duelRefFor(db, input);
        const duelDoc = await tx.get(duelRef);
        const duel = duelDoc.exists ? duelDoc.data() : null;
        if (!duel || duel.status !== 'active' || !duel.players?.includes(uid)) fail('진행 중인 대전이 없어요.', 409);
        const victimUid = duel.players.find((id) => id !== uid);
        if (input.victim !== victimUid) fail('대전 상대를 확인해 주세요.');
        if (now >= duel.hardDeadline || now >= duel.expiresAt) fail('대전 시간이 끝났어요. 사탕을 돌려받을게요.', 409);
        const victimRef = db.collection('gamePlayers').doc(victimUid);
        const victimDoc = await tx.get(victimRef);
        if (!victimDoc.exists) fail('상대 정보를 찾을 수 없어 대전을 끝낼 수 없어요.', 409);
        const { database } = services();
        const [attackerPresence, victimPresence] = await Promise.all([
          duelPresence(database, duel.village, input.attackerPeer, uid, now),
          duelPresence(database, duel.village, input.victimPeer, victimUid, now),
        ]);
        if (!attackerPresence || !victimPresence
          || Math.hypot(attackerPresence.x - victimPresence.x, attackerPresence.y - victimPresence.y) > DUEL_BONK_RANGE) {
          fail('상대가 뿅망치 거리 안에 없어요.', 409);
        }
        const lastHitAt = { ...(duel.lastHitAt || {}) };
        if (now - (Number(lastHitAt[uid]) || 0) < DUEL_BONK_COOLDOWN_MS) fail('뿅망치가 아직 식는 중이에요.', 429);
        lastHitAt[uid] = now;
        const hits = { ...(duel.hits || {}) };
        const prior = hits[victimUid] || { count: 0, at: 0 };
        const hit = { count: now - (prior.at || 0) > DUEL_BONK_RESET_MS ? 1 : prior.count + 1, at: now };
        hits[victimUid] = hit;
        const knockedOut = hit.count >= DUEL_BONK_TO_STUN;
        const expiresAt = Math.min(now + DUEL_IDLE_MS, duel.hardDeadline);
        if (knockedOut) {
          const winner = uid, loser = victimUid;
          const winnerDoc = winner === uid ? player : victimDoc.data();
          const winnings = balance(winnerDoc, event, now) + duel.stake * 2;
          const winnerRef = winner === uid ? playerRef : victimRef;
          tx.update(winnerRef, { round: duel.round, candies: winnings });
          const status = 'completed';
          tx.update(duelRef, { status, winner, loser, hits, lastHitAt, updatedAt: now, completedAt: now, expiresAt: now });
          const winnerLockRef = db.collection('gameDuelLocks').doc(winner);
          const loserLockRef = db.collection('gameDuelLocks').doc(loser);
          tx.delete(winnerLockRef); tx.delete(loserLockRef);
          result = { id: duel.id, status, winner, loser, knockedOut: victimUid, hits: DUEL_BONK_TO_STUN, candies: winnings };
        } else {
          tx.update(duelRef, { hits, lastHitAt, updatedAt: now, expiresAt });
          const lockUpdate = { duelId: duel.id, status: 'active', until: expiresAt };
          tx.set(db.collection('gameDuelLocks').doc(uid), lockUpdate);
          tx.set(db.collection('gameDuelLocks').doc(victimUid), lockUpdate);
          result = { id: duel.id, status: 'active', hitCount: hit.count, remaining: DUEL_BONK_TO_STUN - hit.count, expiresAt };
        }
      } else if (type === 'mural') {
        if (typeof input.mural !== 'string' || !/^[.1-8]{288}$/.test(input.mural)) fail('지붕 그림을 확인해 주세요.');
        tx.update(playerRef, { mural: input.mural });
      } else if (type === 'doodle') {
        if (typeof input.doodle !== 'string' || !/^[.1-8]{256}$/.test(input.doodle)) fail('몸 낙서를 확인해 주세요.');
        tx.update(playerRef, { doodle: input.doodle });
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
        if ((Number(host.data().guardUntil) || 0) > now) fail('호박 수호 부적이 이 집을 지키고 있어요.', 429);
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
        const hostCount = balance(hostDoc.data(), event, now);
        const protectedByGuard = win && (Number(hostDoc.data().guardUntil) || 0) > now;
        const moved = win && !protectedByGuard && hostCount > 0;
        const nextLevelByHost = challenge.streakRound === round && challenge.nextLevelByHost
          ? { ...challenge.nextLevelByHost } : {};
        if (win) nextLevelByHost[challenge.host] = Math.min(MAX_LEVEL, challenge.level + 1);
        else delete nextLevelByHost[challenge.host];
        const entry = { h: challenge.host, r: win ? 'win' : 'lose', at: now, c: player.costume, round, moved, level: challenge.level,
          ...(protectedByGuard ? { protected: true } : {}),
          ...(win ? {} : { k: TRICK_KINDS[randomInt(TRICK_KINDS.length)] }) };
        const playerUpdate = { round, candies: count + (moved ? 1 : 0), knockAt: now,
          challenges: [...(player.challenges || []), { at: now, h: challenge.host, w: win, ms: outcome.at, lv: challenge.level, m: moved }].slice(-MAX_CHALLENGE_LOG) };
        // 실패도 남겨야 마을 사람들 화면에 낙서·똥 같은 장난이 보인다.
        playerUpdate.knocks = [...(player.knocks || []), entry].slice(-100);
        tx.update(playerRef, playerUpdate);
        if (win) tx.update(hostRef, { ...(moved ? { round, candies: hostCount - 1 } : {}),
          guests: withGuest(hostDoc.data(), { ...entry, v: uid, nick: player.nick }) });
        tx.update(challengeRef, { used: true, nextLevelByHost, streakRound: round });
        tx.delete(lockRef);
        result = { entry, candies: count + (moved ? 1 : 0), hostCandies: hostCount - (moved ? 1 : 0) };
      } else if (type === 'knock-leave') {
        const challengeDoc = await tx.get(challengeRef);
        const challenge = challengeDoc.exists ? challengeDoc.data() : null;
        if (!challenge || challenge.id !== input.challengeId || challenge.used || challenge.round !== round) fail('도전이 끝났거나 다시 시작됐어요. 다시 시도해 주세요.');
        const hostRef = db.collection('gamePlayers').doc(challenge.host);
        const lockRef = db.collection('gameHouseLocks').doc(challenge.host);
        const [hostDoc, lockDoc] = await Promise.all([tx.get(hostRef), tx.get(lockRef)]);
        if (!hostDoc.exists) fail('집을 찾을 수 없어요.');
        if (hostDoc.data().houseHidden || hostDoc.data().banned) fail('운영자가 이 집의 도전을 중단했어요.');
        const lock = lockDoc.exists ? lockDoc.data() : null;
        if (lock?.challengeId !== challenge.id || lock.challengerUid !== uid || lock.round !== round) {
          fail('이 도전은 더 이상 유효하지 않아요. 다시 노크해 주세요.');
        }
        const elapsedMs = Math.max(0, now - challenge.createdAt);
        const nextLevelByHost = challenge.streakRound === round && challenge.nextLevelByHost
          ? { ...challenge.nextLevelByHost } : {};
        if (elapsedMs < KNOCK_EARLY_LEAVE_MS) {
          tx.update(challengeRef, { used: true, nextLevelByHost, streakRound: round });
          tx.delete(lockRef);
          result = { left: true, penalized: false, elapsedMs, level: challenge.level, host: challenge.host };
        } else {
          const entry = { h: challenge.host, r: 'lose', at: now, c: player.costume, round, moved: false, level: challenge.level,
            abandoned: true, k: TRICK_KINDS[randomInt(TRICK_KINDS.length)] };
          tx.update(playerRef, { round, candies: count, knockAt: now,
            challenges: [...(player.challenges || []), { at: now, h: challenge.host, w: false, ms: elapsedMs, lv: challenge.level, m: false }].slice(-MAX_CHALLENGE_LOG),
            knocks: [...(player.knocks || []), entry].slice(-100) });
          tx.update(challengeRef, { used: true, nextLevelByHost, streakRound: round });
          tx.delete(lockRef);
          result = { left: true, penalized: true, elapsedMs, level: challenge.level, host: challenge.host, entry, candies: count };
        }
      } else fail('지원하지 않는 행동이에요.');
    }
    if (type !== 'knock-heartbeat') {
      const activity = { uid, type, at: now, round, ...(typeof input.host === 'string' && /^[a-f0-9]{32}$/.test(input.host) ? { host: input.host } : {}),
        ...(type === 'knock-finish' && result.entry ? { host: result.entry.h, outcome: result.entry.r, moved: result.entry.moved, level: result.entry.level } : {}),
        ...(type === 'knock-leave' ? { host: result.host, outcome: result.penalized ? 'lose' : 'quit', moved: false, level: result.level } : {}) };
      tx.set(privateRef, { ...mine, ...privateUpdate,
        receipts: [...(mine.receipts || []), { id: input.requestId, result }].slice(-MAX_RECEIPTS),
        activity: [...(mine.activity || []), activity].slice(-MAX_ACTIVITY) });
    }
    return result;
  }, { maxAttempts: 20 });
  // 이벤트를 바꾼 서버는 기억해 둔 이벤트를 버려 바로 다음 호박 따기부터 새 이벤트를 읽게 한다.
  if (input.type === 'event-start' || input.type === 'event-stop') eventMemo = null;
  return done;
}

module.exports = { TRICK_KINDS, PRICES, ITEMS, FIELD_SIZE, LEADERBOARD_MS, leaderboard, session, action, balance, roundOf, evaluateCandyChallenge, brewGain, BREW_COST, BREW_COOLDOWN_MS, PUMPKIN_HOLD_MAX };
