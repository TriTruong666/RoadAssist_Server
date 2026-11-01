const crypto = require("node:crypto");
const redis = require("../config/redis.config");
const config = require("../config/app.config");
const errors = require("../common/exceptions/error_codes");
const {
  BaseException,
  BadRequestException,
} = require("../common/exceptions/BaseException");
const MailService = require("./mail.service");
const CREATE = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
local previous = redis.call('GET', KEYS[2])
if previous then redis.call('DEL', ARGV[8] .. previous) end
redis.call('HSET', KEYS[1], 'userId', ARGV[1], 'codeHash', ARGV[2], 'ipAddress', ARGV[3], 'purpose', ARGV[4], 'sessionVersion', ARGV[5], 'attempts', 0)
redis.call('EXPIRE', KEYS[1], ARGV[6])
redis.call('SET', KEYS[2], ARGV[7], 'EX', ARGV[6])
redis.call('SET', KEYS[3], '1', 'EX', 60)
return 1
`;
const VERIFY = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'INVALID'} end
if redis.call('GET', KEYS[2]) ~= ARGV[5] then return {'INVALID'} end
if redis.call('HGET', KEYS[1], 'purpose') ~= ARGV[3] then return {'INVALID'} end
if redis.call('HGET', KEYS[1], 'ipAddress') ~= ARGV[1] then return {'INVALID'} end
if redis.call('HGET', KEYS[1], 'codeHash') ~= ARGV[2] then
  local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
  if attempts >= tonumber(ARGV[4]) then redis.call('DEL', KEYS[1], KEYS[2]) end
  return {'INVALID', tostring(math.max(0, tonumber(ARGV[4]) - attempts))}
end
local result = {'VERIFIED', redis.call('HGET', KEYS[1], 'userId'), redis.call('HGET', KEYS[1], 'sessionVersion')}
redis.call('DEL', KEYS[1], KEYS[2])
return result
`;
class LoginVerificationService {
  static hashCode(id, code) {
    if (!config.login.otpSecret)
      throw new Error("OTP secret is not configured");
    return crypto
      .createHmac("sha256", config.login.otpSecret)
      .update(`${id}:${code}`)
      .digest("hex");
  }
  static pointer(userId, purpose) {
    return `${config.login.keyPrefix}challenge-active:${purpose}:${userId}`;
  }
  static async createChallenge({ user, ipAddress, purpose = "login" }) {
    const challengeId = crypto.randomUUID();
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const key = `${config.login.keyPrefix}challenge:${challengeId}`;
    const pointer = this.pointer(user.userId, purpose);
    const created = await redis.eval(
      CREATE,
      3,
      key,
      pointer,
      `${pointer}:cooldown`,
      user.userId,
      this.hashCode(challengeId, code),
      ipAddress,
      purpose,
      user.sessionVersion,
      config.login.otpTtlSeconds,
      challengeId,
      `${config.login.keyPrefix}challenge:`,
    );
    if (!created)
      throw new BaseException(errors.AUTH_LOGIN_RATE_LIMITED, {
        retryAfter: Math.max(1, await redis.ttl(`${pointer}:cooldown`)),
      });
    try {
      const method =
        purpose === "login"
          ? "sendLoginVerificationMail"
          : "sendPasswordResetMail";
      await MailService[method]({ to: user.email, code, ipAddress });
    } catch (error) {
      await redis.del(key);
      // The pointer is harmless once its challenge is gone; never delete a newer challenge's pointer.
      throw new BaseException(errors.AUTH_MAIL_UNAVAILABLE);
    }
    const [local, domain] = user.email.split("@");
    return {
      challengeId,
      expiresIn: config.login.otpTtlSeconds,
      maskedEmail: `${local[0]}***@${domain}`,
    };
  }
  static async verifyChallenge({
    challengeId,
    code,
    ipAddress,
    purpose = "login",
  }) {
    const key = `${config.login.keyPrefix}challenge:${challengeId}`;
    const userId = await redis.hget(key, "userId");
    const pointer = this.pointer(userId || "missing", purpose);
    const [status, value, version] = await redis.eval(
      VERIFY,
      2,
      key,
      pointer,
      ipAddress,
      this.hashCode(challengeId, code),
      purpose,
      config.login.otpMaxAttempts,
      challengeId,
    );
    if (status !== "VERIFIED")
      throw new BadRequestException(
        errors.AUTH_OTP_INVALID_OR_EXPIRED,
        value === undefined ? null : { attemptsRemaining: Number(value) },
      );
    return { userId: value, sessionVersion: Number(version) };
  }
}
module.exports = LoginVerificationService;
