const { apiHandler, requestBody } = require('../../server/api-handler.cjs');
const { action } = require('../../server/game-service.cjs');
module.exports = apiHandler(['POST'], async (req) => ({ body: await action(req.headers?.authorization, await requestBody(req)) }));
