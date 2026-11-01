const crypto = require('node:crypto');
const redis = require('../config/redis.config');
const { emailVerification: config } = require('../config/app.config');
const errors = require('../common/exceptions/error_codes');
const { BaseException, BadRequestException } = require('../common/exceptions/BaseException');
const MailService = require('./mail.service');
const CREATE = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
local previous = redis.call('GET', KEYS[2])
if previous then redis.call('DEL', ARGV[9] .. previous) end
redis.call('HSET', KEYS[1], 'subjectId', ARGV[1], 'codeHash', ARGV[2], 'purpose', ARGV[3], 'sessionVersion', ARGV[4], 'email', ARGV[5], 'pointer', KEYS[2], 'attempts', 0)
redis.call('EXPIRE', KEYS[1], ARGV[6])
redis.call('SET', KEYS[2], ARGV[7], 'EX', ARGV[6])
redis.call('SET', KEYS[3], '1', 'EX', ARGV[8])
return 1
`;
const VERIFY = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'INVALID'} end
if redis.call('GET', KEYS[2]) ~= ARGV[4] then return {'INVALID'} end
if redis.call('HGET', KEYS[1], 'purpose') ~= ARGV[2] then return {'INVALID'} end
if redis.call('HGET', KEYS[1], 'codeHash') ~= ARGV[1] then
 local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
 if attempts >= tonumber(ARGV[3]) then redis.call('DEL', KEYS[1], KEYS[2]) end
 return {'INVALID', tostring(math.max(0, tonumber(ARGV[3]) - attempts))}
end
local result = {'VERIFIED', redis.call('HGET', KEYS[1], 'subjectId'), redis.call('HGET', KEYS[1], 'sessionVersion'), redis.call('HGET', KEYS[1], 'email')}
redis.call('DEL', KEYS[1], KEYS[2])
return result
`;
class EmailVerificationService {
  static key(id) { return `${config.keyPrefix}challenge:${id}`; }
  static pointer(email, purpose) {
    const hash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
    return `${config.keyPrefix}challenge-active:${purpose}:${hash}`;
  }
  static hashCode(id, code) {
    if (!config.otpSecret) throw new Error('OTP secret is not configured');
    return crypto.createHmac('sha256', config.otpSecret).update(`${id}:${code}`).digest('hex');
  }
  static purpose(id) { return redis.hget(this.key(id), 'purpose'); }
  static async createChallenge({ user, purpose }) {
    if (!['registration', 'email-verification', 'password-reset'].includes(purpose)) throw new Error('Unsupported email challenge purpose');
    const challengeId = crypto.randomUUID();
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const key = this.key(challengeId);
    const pointer = this.pointer(user.email, purpose);
    const created = await redis.eval(CREATE, 3, key, pointer, `${pointer}:cooldown`, user.userId || user.id,
      this.hashCode(challengeId, code), purpose, user.sessionVersion || 0, user.email, config.otpTtlSeconds, challengeId, 60, `${config.keyPrefix}challenge:`);
    if (!created) throw new BaseException(errors.AUTH_LOGIN_RATE_LIMITED, { retryAfter: Math.max(1, await redis.ttl(`${pointer}:cooldown`)) });
    try {
      const method = purpose === 'password-reset' ? 'sendPasswordResetMail' : 'sendRegistrationVerificationMail';
      await MailService[method]({ to: user.email, code });
    } catch {
      await redis.eval(`if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2], KEYS[3]) end return redis.call('DEL', KEYS[1])`, 3, key, pointer, `${pointer}:cooldown`, challengeId);
      throw new BaseException(errors.AUTH_MAIL_UNAVAILABLE);
    }
    const [local, domain] = user.email.split('@');
    return { challengeId, expiresIn: config.otpTtlSeconds, resendAfter: 60, maskedEmail: `${local[0]}***@${domain}` };
  }
  static async verifyChallenge({ challengeId, code, purpose }) {
    const key = this.key(challengeId);
    const pointer = await redis.hget(key, 'pointer') || `${config.keyPrefix}missing`;
    const [status, subjectId, version, email] = await redis.eval(VERIFY, 2, key, pointer, this.hashCode(challengeId, code), purpose, config.otpMaxAttempts, challengeId);
    if (status !== 'VERIFIED') throw new BadRequestException(errors.AUTH_OTP_INVALID_OR_EXPIRED,
      subjectId === undefined ? null : { attemptsRemaining: Number(subjectId) });
    return { subjectId, sessionVersion: Number(version), email };
  }
}
module.exports = EmailVerificationService;
