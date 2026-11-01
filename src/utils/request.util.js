// Only trust Express's resolved IP; forwarded headers require an explicit trusted-proxy configuration.
function requestContext(req) {
  return { ipAddress: (req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, ''), userAgent: req.get('user-agent') || '' };
}
module.exports = { requestContext };
