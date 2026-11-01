const Redis = require('ioredis');
const config = require('./src/config/app.config');

async function flushRedis() {
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
  });

  try {
    await redis.flushall();
    console.log("Redis cache flushed successfully!");
  } catch (err) {
    console.error("Failed to flush redis:", err);
  } finally {
    process.exit(0);
  }
}

flushRedis();
