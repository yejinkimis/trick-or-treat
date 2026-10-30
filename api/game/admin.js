const { apiHandler, requestBody } = require('../../server/api-handler.cjs');
const { searchUsers, watchAccounts, moderate } = require('../../server/admin-service.cjs');

module.exports = apiHandler(['GET', 'POST'], async (req) => {
  if (req.method === 'POST') return { body: await moderate(req.headers?.authorization, await requestBody(req)) };
  const params = new URL(req.url, 'http://local').searchParams;
  return { body: params.get('view') === 'watch' ? await watchAccounts(req.headers?.authorization) : await searchUsers(req.headers?.authorization, params.get('q')) };
});
