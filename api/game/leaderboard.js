const { apiHandler } = require('../../server/api-handler.cjs');
const { AuthError } = require('../../server/errors.cjs');
const { LEADERBOARD_MS, leaderboard } = require('../../server/game-service.cjs');

// 주소 뒤에 값을 붙여 CDN 저장본을 우회하면 매번 전체를 다시 읽게 되므로 막는다.
module.exports = apiHandler(['GET'], async (req) => {
  if (new URL(req.url, 'http://local').search) throw new AuthError(400, 'invalid-query', '순위 주소를 확인해 주세요.');
  return { body: await leaderboard(), cacheControl: `public, max-age=0, s-maxage=${LEADERBOARD_MS / 1000}` };
});
