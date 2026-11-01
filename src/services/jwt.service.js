const jwt = require("jsonwebtoken");
const config = require("../config/app.config");
const User = require("../models/user.model");
const AuthSession = require("../models/auth_session.model");
class JWTService {
  static assertConfigured() {
    if (!config.jwt.secret || Buffer.byteLength(config.jwt.secret) < 32)
      throw new Error("JWT_SECRET must contain at least 32 bytes");
  }
  static signUser(name, role, userId, sessionVersion = 0, options = {}) {
    this.assertConfigured();
    return jwt.sign(
      {
        name,
        role,
        userId,
        sessionVersion: Number(sessionVersion),
        tokenUse: "access",
      },
      config.jwt.secret,
      {
        algorithm: "HS256",
        issuer: "roadassist",
        audience: "roadassist-web",
        expiresIn: config.jwt.expiresIn,
        ...options,
      },
    );
  }
  static verify(token) {
    try {
      return jwt.verify(token, config.jwt.secret, {
        algorithms: ["HS256"],
        issuer: "roadassist",
        audience: "roadassist-web",
      });
    } catch {
      return null;
    }
  }
  static async verifyUserSession(token) {
    const decoded = this.verify(token);
    if (
      !decoded ||
      decoded.tokenUse !== "access" ||
      typeof decoded.userId !== "string" ||
      !Number.isInteger(decoded.sessionVersion)
    )
      return null;
    const user = await User.findOne({ where: { userId: decoded.userId } });
    if (
      !user ||
      user.status !== "ACTIVE" ||
      decoded.sessionVersion !== user.sessionVersion
    )
      return null;
    if (decoded.jti) {
      const session = await AuthSession.findOne({
        where: { id: decoded.jti, userId: user.userId },
      });
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= new Date() ||
        session.sessionVersion !== user.sessionVersion
      )
        return null;
    }
    return {
      userId: user.userId,
      name: user.name,
      role: user.role,
      services: user.services,
      sessionVersion: user.sessionVersion,
    };
  }
}
module.exports = JWTService;
