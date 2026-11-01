const { createHash } = require('node:crypto');
const redis = require('../config/redis.config');
const config = require('../config/app.config');
const { BaseException } = require('../common/exceptions/BaseException');
const errors = require('../common/exceptions/error_codes');
const CHECK = `
local limited = false
local retry = 0
for _,key in ipairs(KEYS) do
  if tonumber(redis.call('GET', key) or '0') >= tonumber(ARGV[1]) then
    limited = true
    retry = math.max(retry, redis.call('TTL', key))
  end
end
return {limited and 1 or 0, retry}
`;
const FAILURE = `
local limited = false
local retry = 0
for _,key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  if count == 1 then redis.call('EXPIRE', key, ARGV[1]) end
  if count >= tonumber(ARGV[2]) then
    limited = true
    retry = math.max(retry, redis.call('TTL', key))
  end
end
return {limited and 1 or 0, retry}
`;
class LoginRateLimitService {
  static keys({ email, ipAddress }, purpose = 'login') {
    const hash = value => createHash('sha256').update(String(value)).digest('hex');
    return [`${config.login.keyPrefix}rate:${purpose}:ip:${hash(ipAddress)}`, `${config.login.keyPrefix}rate:${purpose}:email:${hash(email.toLowerCase())}`];
  }
  static limited(retryAfter) {
    return new BaseException(errors.AUTH_LOGIN_RATE_LIMITED, { retryAfter: Math.max(1, Number(retryAfter)) });
  }
  static async assertAllowed(context) {
    if (!config.login.rateLimitEnabled) return;
    const [limited, retry] = await redis.eval(CHECK, 2, ...this.keys(context), config.login.maxAttempts);
    if (limited) throw this.limited(retry);
  }
  static async recordFailure(context) {
    if (!config.login.rateLimitEnabled) return;
    const [limited, retry] = await redis.eval(FAILURE, 2, ...this.keys(context), config.login.windowSeconds, config.login.maxAttempts);
    if (limited) throw this.limited(retry);
  }
  static async clearAccountFailures(context) {
    if (config.login.rateLimitEnabled) await redis.del(this.keys(context)[1]);
    // Keep the shared IP counter: authenticating one account must not unlock an attacking IP.
  }
  static async limitResetRequest(context) {
    const [limited, retry] = await redis.eval(FAILURE, 2, ...this.keys(context, 'password-reset'), 900, 6);
    if (limited) throw this.limited(retry);
  }
}
module.exports = LoginRateLimitService;
