const { apiHandler } = require('../../server/api-handler.cjs');
const { session } = require('../../server/game-service.cjs');
module.exports = apiHandler(['POST'], async (req) => ({ body: await session(req.headers?.authorization) }));
