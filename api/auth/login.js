const { apiHandler, requestBody } = require('../../server/api-handler.cjs');
const { login } = require('../../server/auth-service.cjs');

module.exports = apiHandler(['POST'], async (req) => ({
  body: await login(await requestBody(req)),
}));
