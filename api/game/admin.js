const { apiHandler, requestBody } = require('../../server/api-handler.cjs');
const { searchUsers, watchAccounts, getAnnouncement, setAnnouncement, moderate } = require('../../server/admin-service.cjs');

module.exports = apiHandler(['GET', 'POST'], async (req) => {
  if (req.method === 'POST') {
    const body = await requestBody(req);
    return { body: body.type === 'announcement'
      ? await setAnnouncement(req.headers?.authorization, body)
      : await moderate(req.headers?.authorization, body) };
  }
  const params = new URL(req.url, 'http://local').searchParams;
  const view = params.get('view');
  if (view === 'watch') return { body: await watchAccounts(req.headers?.authorization) };
  if (view === 'announcement') return { body: await getAnnouncement(req.headers?.authorization) };
  return { body: await searchUsers(req.headers?.authorization, params.get('q')) };
});
