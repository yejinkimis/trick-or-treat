const { randomUUID } = require('node:crypto');
const { services } = require('./firebase-admin.cjs');
const { authenticatedUid } = require('./auth-service.cjs');
const { AuthError } = require('./errors.cjs');

const isAdmin = (uid) => (process.env.GAME_ADMIN_UIDS || '').split(',').map((id) => id.trim()).includes(uid);
const reject = (status, code, message) => { throw new AuthError(status, code, message); };
async function requireAdmin(authorization) {
  const uid = await authenticatedUid(authorization);
  if (!isAdmin(uid)) reject(403, 'admin-required', '운영자만 사용할 수 있어요.');
  return uid;
}

async function searchUsers(authorization, query) {
  await requireAdmin(authorization);
  const q = String(query || '').trim().slice(0, 40).toLocaleLowerCase('ko');
  if (q.length < 1) reject(400, 'search-required', '닉네임이나 사용자 ID를 입력해 주세요.');
  const { db } = services();
  const [snap, eventDoc] = await Promise.all([db.collection('gamePlayers').limit(300).get(), db.doc('game/event').get()]);
  const round = eventDoc.exists ? eventDoc.data().id : 'practice';
  const matches = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((p) => p.id.toLowerCase().includes(q) || String(p.nick || '').toLocaleLowerCase('ko').includes(q))
    .slice(0, 20);
  return { users: await Promise.all(matches.map(async (p) => {
    const [ban, activities] = await Promise.all([
      db.collection('gameBans').doc(p.id).get(),
      db.collection('gameActivity').doc(p.id).collection('entries').orderBy('at', 'desc').limit(30).get(),
    ]);
    const chatSnapshot = await services().database.ref(`chat/${p.id}`).get();
    const activity = activities.docs.map((doc) => doc.data());
    for (const item of p.knocks || []) activity.push({ uid: p.id, type: 'knock-finish', host: item.h, at: item.at, outcome: item.r, moved: item.moved, level: item.level });
    for (const item of p.brews || []) activity.push({ uid: p.id, type: 'brew', at: item.at });
    for (const item of p.notes || []) activity.push({ uid: p.id, type: 'note', host: item.h, at: item.at });
    const recentActivity = [...new Map(activity.map((item) => [`${item.uid}:${item.type}:${item.at}:${item.host || ''}`, item])).values()]
      .sort((a, b) => b.at - a.at).slice(0, 30);
    return {
      id: p.id, nick: p.nick || '이름 없음', costume: p.costume || null, village: p.village || null,
      candies: p.round === round ? p.candies : 10, pumpkins: Number(p.pumpkins) || 0,
      rankExcluded: p.rankExcluded === true, houseHidden: p.houseHidden === true,
      banned: ban.exists && ban.data().banned === true,
      banReason: ban.exists ? ban.data().reason || '' : '', activity: recentActivity,
      latestChat: chatSnapshot.exists() ? chatSnapshot.val() : null,
      notes: (p.notes || []).slice(-50).reverse().map((note) => ({ host: note.h, at: note.at, text: note.text })),
    };
  })) };
}

async function moderate(authorization, input) {
  const actor = await requireAdmin(authorization);
  const { db, auth, database } = services();
  const { type, target, reason = '', host, guest, at } = input || {};
  if (!/^[a-f0-9]{32}$/.test(target || '') || !['ban', 'unban', 'rank', 'house', 'delete-note', 'delete-chat'].includes(type)) {
    reject(400, 'invalid-admin-action', '대상이나 작업을 확인해 주세요.');
  }
  if (target === actor && type === 'ban') reject(400, 'cannot-ban-self', '운영자 본인은 밴할 수 없어요.');
  if (type === 'rank' && typeof input.excluded !== 'boolean') reject(400, 'invalid-value', '순위 제외 여부를 확인해 주세요.');
  if (type === 'house' && typeof input.hidden !== 'boolean') reject(400, 'invalid-value', '집 숨김 여부를 확인해 주세요.');
  const reasonText = String(reason).replace(/\s+/gu, ' ').trim().slice(0, 120);
  const playerRef = db.collection('gamePlayers').doc(target);
  const player = await playerRef.get();
  if (!player.exists) reject(404, 'player-not-found', '사용자를 찾을 수 없어요.');
  const now = Date.now();
  let detail = {};
  if (type === 'ban' || type === 'unban') {
    if (type === 'ban' && !reasonText) reject(400, 'reason-required', '밴 사유를 적어 주세요.');
    const banned = type === 'ban';
    if (banned) {
      await db.collection('gameBans').doc(target).set({ banned: true, reason: reasonText, by: actor, at: now });
      await playerRef.update({ banned: true, rankExcluded: true });
      await database.ref(`bannedUsers/${target}`).set(true);
      await auth.updateUser(target, { disabled: true });
    } else {
      await auth.updateUser(target, { disabled: false });
      await db.collection('gameBans').doc(target).delete();
      await database.ref(`bannedUsers/${target}`).remove();
      await playerRef.update({ banned: false });
    }
    detail = { banned, reason: reasonText };
  } else if (type === 'rank') {
    const excluded = input.excluded === true;
    await playerRef.update({ rankExcluded: excluded });
    detail = { excluded };
  } else if (type === 'house') {
    const hidden = input.hidden === true;
    await playerRef.update({ houseHidden: hidden });
    detail = { hidden };
  } else if (type === 'delete-note') {
    if (!/^[a-f0-9]{32}$/.test(host || '') || !/^[a-f0-9]{32}$/.test(guest || '') || !Number.isFinite(at)) {
      reject(400, 'invalid-note', '삭제할 글을 확인해 주세요.');
    }
    const hostRef = db.collection('gamePlayers').doc(host);
    const guestRef = db.collection('gamePlayers').doc(guest);
    await db.runTransaction(async (tx) => {
      const [hostDoc, guestDoc] = await Promise.all([tx.get(hostRef), tx.get(guestRef)]);
      if (!hostDoc.exists || !guestDoc.exists) reject(404, 'note-not-found', '글을 찾을 수 없어요.');
      tx.update(hostRef, { guests: (hostDoc.data().guests || []).filter((entry) => !(entry.v === guest && entry.at === at && entry.text !== undefined)) });
      tx.update(guestRef, { notes: (guestDoc.data().notes || []).filter((entry) => !(entry.h === host && entry.at === at)) });
    });
    detail = { host, guest, at };
  } else {
    if (typeof input.chatId !== 'string') reject(400, 'invalid-chat', '삭제할 채팅을 확인해 주세요.');
    await database.ref(`chat/${target}`).transaction((current) => current === null || current.id === input.chatId ? null : undefined);
    detail = { deletedChat: true };
  }
  if (['ban', 'unban', 'rank'].includes(type)) {
    await db.runTransaction(async (tx) => {
      const moderationRef = db.doc('game/moderation');
      const [current, moderation] = await Promise.all([tx.get(playerRef), tx.get(moderationRef)]);
      const excluded = new Set(moderation.exists ? moderation.data().excluded || [] : []);
      if (current.data().banned || current.data().rankExcluded) excluded.add(target);
      else excluded.delete(target);
      tx.set(moderationRef, { excluded: [...excluded] });
    });
  }
  await db.collection('gameAdminActivity').doc(randomUUID()).set({ actor, target, type, detail, at: now });
  return { ok: true };
}

module.exports = { searchUsers, moderate };
