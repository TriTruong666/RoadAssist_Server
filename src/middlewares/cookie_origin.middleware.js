const { ForbiddenException } = require('../common/exceptions/BaseException');
// CORS already rejects unlisted Origin headers before a handler runs. Protect unsafe browser
// requests without Origin as well, including deployments using SameSite=None cookies.
module.exports = (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('sec-fetch-site') === 'cross-site' && !req.get('origin')) {
    return next(new ForbiddenException('Cross-site browser requests must include an allowed Origin'));
  }
  next();
};
