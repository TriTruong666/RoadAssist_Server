const { randomUUID, createHash, timingSafeEqual } = require("node:crypto");
const bcrypt = require("bcrypt");
const sequelize = require("../config/postgres.config");
const config = require("../config/app.config");
const { User, AuthSession, PendingRegistration } = require("../models");
const { Op } = require("sequelize");
const ProviderAccess = require("./provider_access.service");
const JWTService = require("./jwt.service");
const RateLimit = require("./login_rate_limit.service");
const Verification = require("./email_verification.service");
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
    this.assertUser(user);
    if (!user.emailVerifiedAt)
      throw new BaseException(errors.AUTH_EMAIL_NOT_VERIFIED);
    await ProviderAccess.synchronize(user, transaction);
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
      requiresVerification: false,
      user: user.toJSON(),
    };
  }
  static recordLogin(user, context, transaction) {
    // IP is audit metadata only. It never triggers an authentication challenge.
    return user.update(
      { loginIp: context.ipAddress, loginAt: new Date() },
      { transaction },
    );
  }
  static async register(data, context, provider = false) {
    await RateLimit.limitEmailRequest({ email: data.email, ...context });
    const existing = await User.findOne({
      where: { [Op.or]: [{ email: data.email }, { phone: data.phone }] },
    });
    if (existing) throw new ConflictException(errors.USER_ALREADY_EXISTS);
    await PendingRegistration.destroy({
      where: { expiresAt: { [Op.lt]: new Date() } },
    });
    const draft = await PendingRegistration.create({
      email: data.email,
      phone: data.phone,
      name: data.name,
      passwordHash: await bcrypt.hash(data.password, 12),
      requestedServices: provider ? ["RIDER", data.providerKind] : ["RIDER"],
      expiresAt: new Date(Date.now() + 15 * 60000),
    });
    try {
      const challenge = await Verification.createChallenge({
        user: draft,
        purpose: "registration",
      });
      return {
        requiresVerification: true,
        verificationPurpose: "registration",
        registrationId: draft.id,
        ...challenge,
      };
    } catch (error) {
      await draft.destroy();
      throw error;
    }
  }
  static async resendVerification({ registrationId }, context) {
    const draft = await PendingRegistration.findByPk(registrationId);
    if (!draft || draft.expiresAt <= new Date())
      throw new BaseException(errors.AUTH_OTP_INVALID_OR_EXPIRED);
    await RateLimit.limitEmailRequest({ email: draft.email, ...context });
    const challenge = await Verification.createChallenge({
      user: draft,
      purpose: "registration",
    });
    return {
      requiresVerification: true,
      verificationPurpose: "registration",
      registrationId,
      ...challenge,
    };
  }
  static async sendVerification({ email, password }, context) {
    // Existing unverified accounts prove their password before an email can be sent.
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
    this.assertUser(user);
    if (user.emailVerifiedAt) return { emailVerified: true };
    await RateLimit.limitEmailRequest(
      { email, ...context },
      "email-verification",
    );
    return {
      requiresVerification: true,
      verificationPurpose: "email-verification",
      ...(await Verification.createChallenge({
        user,
        purpose: "email-verification",
      })),
    };
  }
  static async verifyEmail(data, context) {
    const purpose = await Verification.purpose(data.challengeId);
    if (!["registration", "email-verification"].includes(purpose))
      throw new BaseException(errors.AUTH_OTP_INVALID_OR_EXPIRED);
    const verified = await Verification.verifyChallenge({ ...data, purpose });
    try {
      return await sequelize.transaction(async (transaction) => {
        let user;
        if (purpose === "registration") {
          const draft = await PendingRegistration.findByPk(verified.subjectId, {
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (
            !draft ||
            draft.expiresAt <= new Date() ||
            draft.email !== verified.email
          )
            throw new BaseException(errors.AUTH_OTP_INVALID_OR_EXPIRED);
          // The draft already contains a bcrypt hash. No plaintext password is persisted between requests.
          user = await User.create(
            {
              email: draft.email,
              name: draft.name,
              phone: draft.phone,
              password: draft.passwordHash,
              requestedServices: draft.requestedServices,
              services: ["RIDER"],
              role: "guest",
              emailVerifiedAt: new Date(),
            },
            { transaction, hooks: false },
          );
          await draft.destroy({ transaction });
        } else {
          user = await User.findOne({
            where: { userId: verified.subjectId },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          this.assertUser(user, verified.sessionVersion);
          if (user.email !== verified.email)
            throw new BaseException(errors.AUTH_OTP_INVALID_OR_EXPIRED);
          await user.update({ emailVerifiedAt: new Date() }, { transaction });
        }
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
    if (!user.emailVerifiedAt)
      throw new BaseException(errors.AUTH_EMAIL_NOT_VERIFIED);
    return this.completeLogin({
      userId: user.userId,
      sessionVersion: user.sessionVersion,
      ...context,
    });
  }
  static async withRefreshSession(refreshToken, action) {
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
      return action(user, session, transaction);
    });
  }
  static refresh(refreshToken, context) {
    return this.withRefreshSession(refreshToken, (user, session, transaction) =>
      this.issueSession(user, context, transaction, session),
    );
  }
  static async revokeSessions(user, transaction) {
    await user.update(
      { sessionVersion: user.sessionVersion + 1, logoutAt: new Date() },
      { transaction },
    );
    await AuthSession.update(
      { revokedAt: new Date() },
      { where: { userId: user.userId, revokedAt: null }, transaction },
    );
    return { loggedOut: true };
  }
  static logoutByRefreshToken(refreshToken) {
    return this.withRefreshSession(refreshToken, (user, session, transaction) =>
      this.revokeSessions(user, transaction),
    );
  }
  static async logout(userId) {
    return sequelize.transaction(async (transaction) => {
      const user = await User.findOne({
        where: { userId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!user) throw new UnauthorizedException();
      return this.revokeSessions(user, transaction);
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
      expiresIn: config.emailVerification.otpTtlSeconds,
      message:
        "Nếu tài khoản tồn tại, mã đặt lại mật khẩu sẽ được gửi qua email.",
    };
  }
  static async resetPassword(data, context) {
    const verified = await Verification.verifyChallenge({
      ...data,
      purpose: "password-reset",
    });
    await sequelize.transaction(async (transaction) => {
      const user = await User.findOne({
        where: { userId: verified.subjectId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      this.assertUser(user, verified.sessionVersion);
      await user.update(
        { password: data.password, emailVerifiedAt: new Date() },
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
