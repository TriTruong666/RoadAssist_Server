const Redis = require("ioredis");
const config = require("./app.config");
const redis = new Redis({
  ...config.redis,
  lazyConnect: true,
  connectTimeout: 10000,
  maxRetriesPerRequest: 1,
  retryStrategy: times => times <= 3 ? Math.min(times * 200, 2000) : null,
});
redis.on("error", error => console.error("[REDIS]:", error.message));
module.exports = redis;
