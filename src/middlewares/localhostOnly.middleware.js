const ResponseHandler = require("../common/response.handler");

/**
 * Middleware: restrictLocalhost
 * Chỉ cho phép truy cập từ localhost (127.0.0.1, ::1, ::ffff:127.0.0.1)
 * Được dùng chủ yếu cho Swagger /api-docs để tránh việc public docs ra ngoài
 */
const restrictLocalhost = (req, res, next) => {
  if (require("../config/app.config").swagger.public) return next();
  const clientIp = req.ip || req.connection.remoteAddress;

  // IPv4 localhost, IPv6 localhost, and IPv4-mapped IPv6 localhost
  const allowedIps = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

  if (!allowedIps.includes(clientIp)) {
    return ResponseHandler.error(
      res,
      "Access Denied",
      403,
      "Documentation is only accessible from Localhost",
    );
  }

  next();
};

module.exports = restrictLocalhost;
