const { apiHandler, requestBody } = require('../../server/api-handler.cjs');
const { signup } = require('../../server/auth-service.cjs');

module.exports = apiHandler(['POST'], async (req) => ({
  status: 201,
  body: await signup(await requestBody(req)),
}));
