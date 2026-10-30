const { apiHandler, requestBody } = require('../../server/api-handler.cjs');
const { getProfile, updateProfile } = require('../../server/auth-service.cjs');

module.exports = apiHandler(['GET', 'PATCH'], async (req) => {
  const profile = req.method === 'GET'
    ? await getProfile(req.headers?.authorization)
    : await updateProfile(req.headers?.authorization, await requestBody(req));
  return { body: { profile } };
});
