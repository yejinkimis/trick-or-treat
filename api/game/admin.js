const { apiHandler, requestBody } = require('../../server/api-handler.cjs');
const { searchUsers, moderate } = require('../../server/admin-service.cjs');

module.exports = apiHandler(['GET', 'POST'], async (req) => req.method === 'GET'
  ? { body: await searchUsers(req.headers?.authorization, new URL(req.url, 'http://local').searchParams.get('q')) }
  : { body: await moderate(req.headers?.authorization, await requestBody(req)) });
