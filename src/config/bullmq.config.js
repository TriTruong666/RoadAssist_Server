const config = require("./app.config");

/**
 * BullMQ configuration
 * Shared Redis connection options for Queues, Workers, and Schedulers.
 */
const bullMQConfig = {
  connection: {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
  },
  // Default settings for jobs
  defaultJobOptions: {
    removeOnComplete: {
      age: 3600, // keep up to 1 hour
      count: 1000, // keep up to 1000 jobs
    },
    removeOnFail: {
      age: 24 * 3600, // keep up to 24 hours
    },
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  },
};

module.exports = bullMQConfig;
