const { apiHandler } = require('../../server/api-handler.cjs');
const { duels } = require('../../server/game-service.cjs');

module.exports = apiHandler(['GET'], async (req) => ({
  body: await duels(req.headers?.authorization, new URL(req.url, 'http://local').searchParams.get('duelId')),
}));
