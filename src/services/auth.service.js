const { randomUUID, createHash, timingSafeEqual } = require("node:crypto");
const bcrypt = require("bcrypt");
const sequelize = require("../config/postgres.config");
const config = require("../config/app.config");
const { User, AuthSession } = require("../models");
const JWTService = require("./jwt.service");
const RateLimit = require("./login_rate_limit.service");
const Verification = require("./login_verification.service");
const {
  BaseException,
  UnauthorizedException,
  ConflictException,
} = require("../common/exceptions/BaseException");
const errors = require("../common/exceptions/error_codes");
const jwt = require("jsonwebtoken");
const INVALID_HASH =
  "$2b$12$tOw8wGFPGISwIZEiuQYj/em5OAo2TMLkJpMIoi3Jz3gTgAVYIA0Kq";
class AuthService {
  static hash(token) {
    return createHash("sha256").update(token).digest("hex");
  }
  static normalizeTrustedIps(user) {
    return (user.trustedIpRecords || [])
      .filter(
        (record) =>
          record.ipAddress && Date.parse(record.expiresAt) > Date.now(),
      )
      .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))
      .slice(0, config.login.maxTrustedIps);
  }
  static assertUser(user, expectedVersion) {
    if (
      !user ||
      user.status !== "ACTIVE" ||
      (expectedVersion !== undefined && user.sessionVersion !== expectedVersion)
    ) {
      throw new UnauthorizedException(errors.AUTH_SESSION_EXPIRED);
    }
  }
  static async issueSession(user, context, transaction, session = null) {
    JWTService.assertConfigured();
    const id = session?.id || randomUUID();
    const refreshToken = jwt.sign(
      {
        userId: user.userId,
        sessionVersion: user.sessionVersion,
        tokenUse: "refresh",
        nonce: randomUUID(),
      },
      config.jwt.secret,
      {
        algorithm: "HS256",
        issuer: "roadassist",
        audience: "roadassist-web",
        expiresIn: config.jwt.refreshExpiresIn,
        jwtid: id,
      },
    );
    const values = {
      userId: user.userId,
      tokenHash: this.hash(refreshToken),
      sessionVersion: user.sessionVersion,
      expiresAt: new Date(jwt.decode(refreshToken).exp * 1000),
      ipAddress: context.ipAddress,
      userAgent: (context.userAgent || "").slice(0, 512),
    };
    if (session) await session.update(values, { transaction });
    else await AuthSession.create({ ...values, id }, { transaction });
    return {
      token: JWTService.signUser(
        user.name,
        user.role,
        user.userId,
        user.sessionVersion,
        { jwtid: id },
      ),
      refreshToken,
      tokenType: "Bearer",
      requiresVerification: false,
      user: user.toJSON(),
    };
  }
  static async recordLogin(user, context, transaction) {
    const now = new Date();
    const records = this.normalizeTrustedIps(user).filter(
      (record) => record.ipAddress !== context.ipAddress,
    );
    records.unshift({
      ipAddress: context.ipAddress,
      trustedAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + config.login.trustedIpTtlDays * 86400000,
      ).toISOString(),
      userAgent: (context.userAgent || "").slice(0, 512),
    });
    await user.update(
      {
        trustedIpRecords: records.slice(0, config.login.maxTrustedIps),
        loginIp: context.ipAddress,
        loginAt: now,
      },
      { transaction },
    );
  }
  static async register(data, context, provider = false) {
    try {
      return await sequelize.transaction(async (transaction) => {
        const user = await User.create(
          {
            email: data.email,
            password: data.password,
            phone: data.phone,
            name: data.name,
            role: provider ? "provider" : "guest",
            services: provider ? ["RIDER", data.providerKind] : ["RIDER"],
          },
          { transaction },
        );
        await this.recordLogin(user, context, transaction);
        return this.issueSession(user, context, transaction);
      });
    } catch (error) {
      if (error.name === "SequelizeUniqueConstraintError")
        throw new ConflictException(errors.USER_ALREADY_EXISTS);
      throw error;
    }
  }
  static registerProvider(data, context) {
    return this.register(data, context, true);
  }
  static async completeLogin({ userId, sessionVersion, ...context }) {
    const result = await sequelize.transaction(async (transaction) => {
      const user = await User.findOne({
        where: { userId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      this.assertUser(user, sessionVersion);
      await this.recordLogin(user, context, transaction);
      return this.issueSession(user, context, transaction);
    });
    await RateLimit.clearAccountFailures({
      email: result.user.email,
      ipAddress: context.ipAddress,
    });
    return result;
  }
  static async login({ email, password, ...context }) {
    await RateLimit.assertAllowed({ email, ...context });
    const user = await User.findOne({ where: { email } });
    const matched = await bcrypt.compare(
      password,
      user?.password || INVALID_HASH,
    );
    if (!user || !matched) {
      await RateLimit.recordFailure({ email, ...context });
      throw new UnauthorizedException(errors.AUTH_INVALID_CREDENTIALS);
    }
    if (user.status !== "ACTIVE")
      throw new UnauthorizedException(errors.AUTH_ACCOUNT_INACTIVE);
    const trusted = this.normalizeTrustedIps(user).some(
      (record) => record.ipAddress === context.ipAddress,
    );
    if (config.login.verificationEnabled && !trusted) {
      const challenge = await Verification.createChallenge({
        user,
        ipAddress: context.ipAddress,
      });
      return { requiresVerification: true, ...challenge };
    }
    return this.completeLogin({
      userId: user.userId,
      sessionVersion: user.sessionVersion,
      ...context,
    });
  }
  static async verifyLogin(data, context) {
    const verified = await Verification.verifyChallenge({
      ...data,
      ipAddress: context.ipAddress,
    });
    return this.completeLogin({ ...verified, ...context });
  }
  static async refresh(refreshToken, context) {
    const decoded = JWTService.verify(refreshToken);
    if (
      !decoded?.jti ||
      decoded.tokenUse !== "refresh" ||
      typeof decoded.userId !== "string"
    )
      throw new UnauthorizedException(errors.AUTH_SESSION_EXPIRED);
    return sequelize.transaction(async (transaction) => {
      const user = await User.findOne({
        where: { userId: decoded.userId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      this.assertUser(user, decoded.sessionVersion);
      const session = await AuthSession.findOne({
        where: { id: decoded.jti, userId: user.userId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const submittedHash = this.hash(refreshToken);
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= new Date() ||
        session.sessionVersion !== user.sessionVersion ||
        !timingSafeEqual(
          Buffer.from(session.tokenHash),
          Buffer.from(submittedHash),
        )
      )
        throw new UnauthorizedException(errors.AUTH_SESSION_EXPIRED);
      return this.issueSession(user, context, transaction, session);
    });
  }
  static async logout(userId) {
    return sequelize.transaction(async (transaction) => {
      const user = await User.findOne({
        where: { userId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!user) throw new UnauthorizedException();
      await user.update(
        { sessionVersion: user.sessionVersion + 1, logoutAt: new Date() },
        { transaction },
      );
      await AuthSession.update(
        { revokedAt: new Date() },
        { where: { userId, revokedAt: null }, transaction },
      );
      return { loggedOut: true };
    });
  }
  static async forgotPassword({ email }, context) {
    await RateLimit.limitResetRequest({ email, ...context });
    const user = await User.findOne({ where: { email } });
    let challengeId = randomUUID();
    if (user?.status === "ACTIVE") {
      try {
        ({ challengeId } = await Verification.createChallenge({
          user,
          ipAddress: context.ipAddress,
          purpose: "password-reset",
        }));
      } catch (error) {
        if (!(error instanceof BaseException)) throw error;
        // Return the same response for unknown users, cooldowns and delivery failures.
        if (error.errorCode === errors.AUTH_MAIL_UNAVAILABLE.code)
          console.error("[MAIL]: Password reset delivery failed");
      }
    }
    return {
      challengeId,
      expiresIn: config.login.otpTtlSeconds,
      message:
        "Nếu tài khoản tồn tại, mã đặt lại mật khẩu sẽ được gửi qua email.",
    };
  }
  static async resetPassword(data, context) {
    const verified = await Verification.verifyChallenge({
      ...data,
      ipAddress: context.ipAddress,
      purpose: "password-reset",
    });
    await sequelize.transaction(async (transaction) => {
      const user = await User.findOne({
        where: { userId: verified.userId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      this.assertUser(user, verified.sessionVersion);
      await user.update(
        { password: data.password, trustedIpRecords: [] },
        { transaction },
      );
      await AuthSession.update(
        { revokedAt: new Date() },
        { where: { userId: user.userId, revokedAt: null }, transaction },
      );
    });
    return { passwordReset: true };
  }
}
module.exports = AuthService;
