const Service = require('../services/provider.service');
const Response = require('../common/response.handler');
const { requestContext } = require('../utils/request.util');
const { setSessionCookies } = require('../utils/auth_cookie.util');
function send(res, result, created = false) {
  const { session, ...data } = result;
  if (session) setSessionCookies(res, session);
  return created ? Response.created(res, data) : Response.success(res, data);
}
module.exports = {
  register: async (req, res) => send(res, await Service.registerProvider(req.user, req.validated, requestContext(req)), true),
  me: async (req, res) => Response.success(res, await Service.me(req.user.userId)),
  get: async (req, res) => Response.success(res, await Service.get(req.validated.id, req.user)),
  update: async (req, res) => { const { id, ...data } = req.validated; return send(res, await Service.update(req.user, id, data, requestContext(req))); },
  duty: async (req, res) => send(res, await Service.toggleDuty(req.user, req.validated.id, req.validated, requestContext(req))),
  location: async (req, res) => send(res, await Service.heartbeat(req.user, req.validated, requestContext(req))),
  revoke: async (req, res) => send(res, await Service.revoke(req.user, req.validated.id, requestContext(req))),
  search: async (req, res) => Response.success(res, await Service.search(req.validated)),
  pending: async (req, res) => Response.success(res, await Service.pending(req.user, req.validated)),
  pendingTows: async (req, res) => Response.success(res, await Service.pending(req.user, { ...req.validated, kind: 'TOW' })),
  approve: async (req, res) => send(res, await Service.review(req.user, req.validated.id, 'approve', {}, requestContext(req))),
  deny: async (req, res) => send(res, await Service.review(req.user, req.validated.id, 'deny', req.validated, requestContext(req))),
  suspend: async (req, res) => send(res, await Service.review(req.user, req.validated.id, 'suspend', req.validated, requestContext(req))),
};
