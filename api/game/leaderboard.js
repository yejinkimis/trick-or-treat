const { apiHandler } = require('../../server/api-handler.cjs');
const { AuthError } = require('../../server/errors.cjs');
const { LEADERBOARD_MS, leaderboard } = require('../../server/game-service.cjs');

// 완료된 룰렛 ID만 캐시 버전으로 받는다. 임의 쿼리로 전체 읽기를 반복할 수는 없다.
module.exports = apiHandler(['GET'], async (req) => {
  const url = new URL(req.url, 'http://local');
  const rouletteId = url.searchParams.get('roulette');
  if (url.search && (!rouletteId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(rouletteId)
    || url.search !== `?roulette=${rouletteId}`)) throw new AuthError(400, 'invalid-query', '순위 주소를 확인해 주세요.');
  return { body: await leaderboard(Date.now(), rouletteId), cacheControl: `public, max-age=0, s-maxage=${LEADERBOARD_MS / 1000}` };
});
