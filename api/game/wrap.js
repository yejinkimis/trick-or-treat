const { apiHandler } = require('../../server/api-handler.cjs');
const { wrapImage } = require('../../server/wrap-service.cjs');

module.exports = apiHandler(['GET'], async (req) => {
  const kind = new URL(req.url, 'http://local').searchParams.get('kind');
  return { body: await wrapImage(req.headers?.authorization, kind), contentType: 'image/png', cacheControl: 'private, no-store' };
});
