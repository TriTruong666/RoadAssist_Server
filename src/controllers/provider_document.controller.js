const Service = require('../services/provider_document.service');
const Providers = require('../services/provider.service');
const Response = require('../common/response.handler');
const { requestContext } = require('../utils/request.util');
const { setSessionCookies } = require('../utils/auth_cookie.util');
function send(res, result, created = false) {
  const { session, ...data } = result;
  if (session) setSessionCookies(res, session);
  return created ? Response.created(res, data) : Response.success(res, data);
}
module.exports = {
  upload: async (req, res) => send(res, await Service.upload(req.user, req.validated.id, req.validated.documentType, req.file, requestContext(req)), true),
  list: async (req, res) => Response.success(res, await Service.list(req.user, req.validated.id)),
  async content(req, res) {
    const document = await Service.content(req.user, req.validated.id, req.validated.documentId);
    if (document.url) return res.redirect(302, document.url);
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.attachment(document.originalName).type(document.mimeType).send(document.content);
  },
  withdraw: async (req, res) => send(res, await Service.withdraw(req.user, req.validated.id, req.validated.documentId, requestContext(req))),
  history: async (req, res) => Response.success(res, await Service.history(req.user, req.validated.id, req.validated)),
  async availability(req, res) {
    const profile = await Providers.get(req.validated.id, req.user);
    const keys = ['onDuty', 'available', 'state', 'reason', 'maxConcurrentJobs', 'activeJobs', 'freeSlots'];
    return Response.success(res, profile.availability || Object.fromEntries(keys.map(key => [key, profile[key]])));
  },
};
