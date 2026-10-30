const { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { services } = require('./firebase-admin.cjs');
const { AuthError } = require('./errors.cjs');
const { readVillagePlan } = require('./village.cjs');

const scryptAsync = promisify(scrypt);
const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keyLength: 64 });
const DUMMY_SALT = Buffer.alloc(16, 0x5a);
const DUMMY_HASH = Buffer.from('0sSYEgpobiIsYvpXJRDk6RMFliZP5vD_zHcdr1tOMyc_5GWnizC-SgcoooFH5yCvB_ecoZyQPIQvG9SotnUWtw', 'base64url');
const PASSWORD_MIN = 8;
const PASSWORD_MAX_BYTES = 128;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 10;
const NICK_RESERVED = new Set(['admin', 'administrator', '관리자', '운영자', 'root', 'system']);
const COSTUMES = new Set(['ghost', 'witch', 'pumpkin', 'dracula', 'mummy', 'cat', 'skeleton', 'blanket']);
const PROFILE_FIELDS = new Set(['costume', 'door', 'guideSeen', 'introSeen']);
const CUSTOM_TOKEN_AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

function cleanNickname(value) {
  if (typeof value !== 'string') throw new AuthError(400, 'invalid-nickname', '닉네임을 확인해 주세요.');
  const nickname = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const length = Array.from(nickname).length;
  if (length < 1 || length > 12 || !/^[\p{L}\p{N}_ -]+$/u.test(nickname)) {
    throw new AuthError(400, 'invalid-nickname', '닉네임은 한글·영문·숫자·공백·_·-로 1~12자까지 정할 수 있어요.');
  }
  if (NICK_RESERVED.has(nickname.toLowerCase())) throw new AuthError(400, 'reserved-nickname', '이 닉네임은 사용할 수 없어요.');
  return { nickname, key: nickname.toLowerCase() };
}

function validatePassword(value, { signup = false } = {}) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > PASSWORD_MAX_BYTES || (signup && Array.from(value).length < PASSWORD_MIN)) {
    throw new AuthError(400, 'invalid-password', `비밀번호는 ${PASSWORD_MIN}자 이상, ${PASSWORD_MAX_BYTES}바이트 이하여야 해요.`);
  }
  return value;
}

async function derivePassword(password, salt, params = SCRYPT) {
  const maxmem = Math.max(64 * 1024 * 1024, 128 * params.N * params.r + 1024 * 1024);
  return Buffer.from(await scryptAsync(password, salt, params.keyLength || SCRYPT.keyLength, {
    N: params.N || SCRYPT.N,
    r: params.r || SCRYPT.r,
    p: params.p || SCRYPT.p,
    maxmem,
  }));
}

async function makePasswordRecord(password) {
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return {
    algorithm: 'scrypt', version: 1,
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString('base64url'), hash: hash.toString('base64url'),
  };
}

async function verifyPassword(password, record) {
  const candidateSalt = record?.salt ? Buffer.from(record.salt, 'base64url') : Buffer.alloc(0);
  const candidateHash = record?.hash ? Buffer.from(record.hash, 'base64url') : Buffer.alloc(0);
  const validRecord = record?.algorithm === 'scrypt' && record.version === 1
    && record.N === SCRYPT.N && record.r === SCRYPT.r && record.p === SCRYPT.p
    && candidateSalt.length === 16 && candidateHash.length === SCRYPT.keyLength;
  const salt = validRecord ? candidateSalt : DUMMY_SALT;
  const expected = validRecord ? candidateHash : DUMMY_HASH;
  const actual = await derivePassword(password, salt, SCRYPT);
  return validRecord && timingSafeEqual(expected, actual);
}

function publicProfile(uid, value) {
  return {
    uid,
    nick: value.nick,
    costume: COSTUMES.has(value.costume) ? value.costume : null,
    door: Number.isInteger(value.door) && value.door >= 1 && value.door <= 5 ? value.door : 1,
    guideSeen: value.guideSeen === true,
    introSeen: value.introSeen === true,
    joinedAt: Number(value.joinedAt) || 0,
  };
}

function createEmulatorCustomToken(uid, projectId) {
  const now = Math.floor(Date.now() / 1000);
  const email = `${projectId}@appspot.gserviceaccount.com`;
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: email, sub: email, aud: CUSTOM_TOKEN_AUD,
    iat: now, exp: now + 3600, uid,
  })).toString('base64url');
  return `${header}.${payload}.`;
}

async function customToken(uid, firebase) {
  return firebase.emulator
    ? createEmulatorCustomToken(uid, firebase.projectId)
    : firebase.auth.createCustomToken(uid);
}

function limitRef(db, nicknameKey) {
  const digest = createHash('sha256').update(nicknameKey).digest('hex');
  return db.collection('authRateLimits').doc(digest);
}

async function checkLoginLimit(db, nicknameKey) {
  const ref = limitRef(db, nicknameKey);
  const now = Date.now();
  let blocked = false;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const previous = snapshot.exists ? snapshot.data() : {};
    if (previous.lockedUntil > now) { blocked = true; return; }
    const inWindow = Number(previous.windowStartedAt) > now - LOGIN_WINDOW_MS;
    const attempts = inWindow ? Number(previous.attempts) || 0 : 0;
    if (attempts >= LOGIN_ATTEMPT_LIMIT) { blocked = true; return; }
    transaction.set(ref, {
      windowStartedAt: inWindow ? previous.windowStartedAt : now,
      attempts: attempts + 1,
      lockedUntil: null,
    });
  }, { maxAttempts: 20 });
  if (blocked) throw new AuthError(429, 'login-rate-limited', '로그인 시도가 많아요. 15분 뒤 다시 해 주세요.');
  return ref;
}

async function signup({ nickname: rawNickname, password: rawPassword }) {
  const { nickname, key } = cleanNickname(rawNickname);
  if (/\p{Default_Ignorable_Code_Point}/u.test(nickname)) {
    throw new AuthError(400, 'invalid-nickname', '보이지 않는 문자는 닉네임에 사용할 수 없어요.');
  }
  const password = validatePassword(rawPassword, { signup: true });
  const firebase = services();
  const claimRef = firebase.db.collection('nicknameClaims').doc(key);
  if ((await claimRef.get()).exists) throw new AuthError(409, 'nickname-in-use', '이미 사용 중인 닉네임이에요.');

  const uid = randomUUID().replace(/-/g, '');
  const [passwordRecord, token] = await Promise.all([
    makePasswordRecord(password),
    customToken(uid, firebase),
  ]);
  const profile = {
    nick: nickname, costume: null, door: 1,
    guideSeen: false, introSeen: false,
    joinedAt: Date.now(),
  };
  const claim = {
    uid, createdAt: profile.joinedAt,
  };
  try {
    await firebase.db.runTransaction(async (transaction) => {
      const existing = await transaction.get(claimRef);
      if (existing.exists) throw new AuthError(409, 'nickname-in-use', '이미 사용 중인 닉네임이에요.');
      transaction.create(claimRef, claim);
      transaction.create(firebase.db.collection('privateAccounts').doc(uid), passwordRecord);
      transaction.create(firebase.db.collection('profiles').doc(uid), profile);
    }, { maxAttempts: 20 });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw error;
  }
  return { uid, customToken: token, profile: publicProfile(uid, profile) };
}

async function login({ nickname: rawNickname, password: rawPassword }) {
  const { key } = cleanNickname(rawNickname);
  const password = validatePassword(rawPassword);
  if (!password) throw new AuthError(401, 'invalid-credentials', '닉네임이나 비밀번호를 확인해 주세요.');
  const firebase = services();
  const rateRef = await checkLoginLimit(firebase.db, key);
  const claimSnapshot = await firebase.db.collection('nicknameClaims').doc(key).get();
  const uid = claimSnapshot.exists ? claimSnapshot.data().uid : null;
  const privateSnapshot = uid ? await firebase.db.collection('privateAccounts').doc(uid).get() : null;
  const record = privateSnapshot?.exists ? privateSnapshot.data() : null;
  const valid = await verifyPassword(password, record);
  const profileSnapshot = valid && uid ? await firebase.db.collection('profiles').doc(uid).get() : null;
  if (!valid || !profileSnapshot?.exists) {
    throw new AuthError(401, 'invalid-credentials', '닉네임이나 비밀번호를 확인해 주세요.');
  }
  await rejectBanned(uid);
  const token = await customToken(uid, firebase);
  await rateRef.delete();
  return { uid, customToken: token, profile: publicProfile(uid, profileSnapshot.data()) };
}

function readBearer(value) {
  const match = typeof value === 'string' && value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new AuthError(401, 'unauthorized', '다시 로그인해 주세요.');
  return match[1];
}

async function rejectBanned(uid) {
  const banned = await services().db.collection('gameBans').doc(uid).get();
  if (banned.exists && banned.data().banned === true) {
    throw new AuthError(403, 'account-banned', '이 계정은 게임 이용이 제한됐어요. 운영자에게 문의해 주세요.');
  }
}

async function authenticatedUid(authorization, { checkBan = true } = {}) {
  let decoded;
  try { decoded = await services().auth.verifyIdToken(readBearer(authorization)); }
  catch { throw new AuthError(401, 'unauthorized', '다시 로그인해 주세요.'); }
  if (checkBan) await rejectBanned(decoded.uid);
  return decoded.uid;
}

async function getProfile(authorization) {
  const uid = await authenticatedUid(authorization);
  const firebase = services();
  const snapshot = await firebase.db.collection('profiles').doc(uid).get();
  if (!snapshot.exists) throw new AuthError(404, 'profile-not-found', '계정 정보를 찾을 수 없어요.');
  return publicProfile(uid, snapshot.data());
}

function validateProfilePatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError(400, 'invalid-profile', '저장할 정보를 확인해 주세요.');
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([key]) => !PROFILE_FIELDS.has(key))) {
    throw new AuthError(400, 'invalid-profile', '저장할 수 없는 정보가 포함되어 있어요.');
  }
  const patch = {};
  for (const [key, item] of entries) {
    if (key === 'costume') {
      if (item !== null && !COSTUMES.has(item)) throw new AuthError(400, 'invalid-profile', '분장 정보를 확인해 주세요.');
      patch[key] = item;
    } else if (key === 'door') {
      if (!Number.isInteger(item) || item < 1 || item > 5) throw new AuthError(400, 'invalid-profile', '지붕 색을 확인해 주세요.');
      patch[key] = item;
    } else {
      if (typeof item !== 'boolean') throw new AuthError(400, 'invalid-profile', '진행 정보를 확인해 주세요.');
      patch[key] = item;
    }
  }
  return patch;
}

async function updateProfile(authorization, value) {
  const uid = await authenticatedUid(authorization);
  const patch = validateProfilePatch(value);
  const firebase = services();
  const ref = firebase.db.collection('profiles').doc(uid);
  await firebase.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const playerRef = firebase.db.collection('gamePlayers').doc(uid);
    const player = await transaction.get(playerRef);
    if (!snapshot.exists) throw new AuthError(404, 'profile-not-found', '계정 정보를 찾을 수 없어요.');
    if (patch.costume === null && player.exists && player.data().costume) throw new AuthError(400, 'invalid-profile', '다른 분장으로 갈아입어 주세요.');
    const prior = player.exists ? player.data() : null;
    const readyAt = prior?.readyAt || Date.now();
    const plan = prior && patch.costume && !prior.village ? await readVillagePlan(transaction, firebase.db, { id: uid, readyAt }) : null;
    transaction.update(ref, patch);
    plan?.write(uid);
    if (player.exists) transaction.update(playerRef, { ...patch,
      ...(patch.costume && !prior.readyAt ? { readyAt } : {}),
      ...(plan ? { village: plan.villageOf.get(uid) } : {}),
    });
  }, { maxAttempts: 20 });
  const snapshot = await ref.get();
  return publicProfile(uid, snapshot.data());
}

module.exports = {
  AuthError, SCRYPT, PASSWORD_MIN, PASSWORD_MAX_BYTES,
  cleanNickname, validatePassword, derivePassword, verifyPassword,
  publicProfile, validateProfilePatch, createEmulatorCustomToken,
  signup, login, getProfile, updateProfile, authenticatedUid,
};
