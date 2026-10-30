const { AuthError } = require('./errors.cjs');

const MAX_BODY_BYTES = 8 * 1024;

async function requestBody(req) {
  const contentType = req.headers?.['content-type'] || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new AuthError(415, 'unsupported-content-type', 'JSON 형식으로 요청해 주세요.');
  }
  if (req.body !== undefined) {
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
      if (Buffer.byteLength(req.body) > MAX_BODY_BYTES) throw new AuthError(413, 'body-too-large', '요청이 너무 커요.');
      try { return JSON.parse(req.body.toString()); }
      catch { throw new AuthError(400, 'invalid-json', '요청을 확인해 주세요.'); }
    }
    if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY_BYTES) throw new AuthError(413, 'body-too-large', '요청이 너무 커요.');
    return req.body;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AuthError(413, 'body-too-large', '요청이 너무 커요.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AuthError(400, 'invalid-json', '요청을 확인해 주세요.'); }
}

function send(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store, max-age=0');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(value));
}

function apiHandler(methods, run) {
  return async (req, res) => {
    if (!methods.includes(req.method)) {
      res.setHeader('allow', methods.join(', '));
      return send(res, 405, { error: 'method-not-allowed', message: '지원하지 않는 요청이에요.' });
    }
    try {
      const result = await run(req);
      return send(res, result.status || 200, result.body);
    } catch (error) {
      if (error instanceof AuthError) return send(res, error.status, { error: error.code, message: error.message });
      console.error('[auth API]', error?.code || error?.name || 'unknown error');
      const status = error?.status === 503 ? 503 : 500;
      return send(res, status, {
        error: status === 503 ? 'service-unavailable' : 'internal-error',
        message: status === 503 ? '인증 서버 설정이 아직 준비되지 않았어요.' : '잠시 뒤 다시 시도해 주세요.',
      });
    }
  };
}

module.exports = { apiHandler, requestBody, send };
