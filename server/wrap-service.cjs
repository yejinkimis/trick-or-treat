const fs = require('node:fs/promises');
const path = require('node:path');
const { createCipheriv, createDecipheriv, createHmac, randomBytes } = require('node:crypto');
const { AuthError } = require('./errors.cjs');
const { authenticatedUid } = require('./auth-service.cjs');

// 10/31 이벤트 결산 이미지는 사람마다 미리 만들어 wrap/에 둔다. 레포가 공개라서 파일은 GAME_WRAP_KEY로
// 암호화하고 이름도 UID 대신 열쇠로 만든 해시를 쓴다. 로그인 토큰의 UID에 맞는 파일만 풀어서 내려준다.
const KINDS = new Set(['cert', 'mine']);
const IV_BYTES = 12, TAG_BYTES = 16;
const wrapDir = () => process.env.GAME_WRAP_DIR || path.join(__dirname, '..', 'wrap');

function wrapKey(value = process.env.GAME_WRAP_KEY) {
  const key = Buffer.from(String(value || ''), 'base64');
  if (key.length !== 32) throw new AuthError(503, 'wrap-unavailable', '결산 이미지가 아직 준비되지 않았어요.');
  return key;
}

const wrapFileName = (key, uid, kind) => `${createHmac('sha256', key).update(`${uid}:${kind}`).digest('hex').slice(0, 32)}.bin`;

function sealWrap(key, png) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(png), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function openWrap(key, sealed) {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES));
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

async function wrapImage(authorization, kind) {
  if (!KINDS.has(kind)) throw new AuthError(400, 'invalid-kind', '결산 이미지 종류를 확인해 주세요.');
  const uid = await authenticatedUid(authorization);
  const key = wrapKey();
  let sealed;
  try {
    sealed = await fs.readFile(path.join(wrapDir(), wrapFileName(key, uid, kind)));
  } catch (error) {
    if (error.code === 'ENOENT') throw new AuthError(404, 'wrap-not-found', '이벤트 기록이 없어 결산 이미지가 없어요.');
    throw error;
  }
  return openWrap(key, sealed);
}

module.exports = { wrapImage, wrapKey, wrapFileName, sealWrap, openWrap };
