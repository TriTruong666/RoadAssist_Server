const path = require("node:path");
const fs = require("node:fs");
const envFile = process.env.NODE_ENV === "production" ? ".env.production" : ".env.development";
const envPath = path.resolve(__dirname, "../..", envFile);
require("dotenv").config({ path: fs.existsSync(envPath) ? envPath : path.resolve(__dirname, "../../.env"), quiet: true });
const integer = (key, fallback) => Number.parseInt(process.env[key], 10) || fallback;
const boolean = (key) => process.env[key] === "true";
const origins = Object.keys(process.env).filter(key => key.startsWith("ALLOWED_CLIENT_URL_")).map(key => process.env[key]).filter(Boolean);
module.exports = {
  app: {
    name: process.env.APP_NAME || "RoadAssist-Server",
    version: process.env.APP_VERSION || "1.0.0",
    env: process.env.NODE_ENV || "development",
    port: integer("SERVER_PORT", 9898),
    // A comma-separated allowlist of proxy IPs/CIDRs; do not trust arbitrary forwarded headers.
    trustProxy: process.env.TRUST_PROXY ? process.env.TRUST_PROXY.split(',').map(value => value.trim()).filter(Boolean) : false,
    isProduction: process.env.NODE_ENV === "production",
  },
  db: {
    host: process.env.DB_HOST || "localhost", port: integer("DB_PORT", 5432),
    name: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    reset: boolean("DB_RESET"), force_reset: boolean("DB_FORCE_RESET"),
  },
  redis: {
    host: process.env.REDIS_HOST || "localhost", port: integer("REDIS_PORT", 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  cors(origin, callback) {
    if (!origin || origins.includes(origin)) return callback(null, true);
    const { ForbiddenException } = require("../common/exceptions/BaseException");
    callback(new ForbiddenException("Origin không được phép truy cập"));
  },
  jwt: {
    secret: process.env.JWT_SECRET || null,
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "30d",
  },
  login: {
    rateLimitEnabled: process.env.LOGIN_RATE_LIMIT_ENABLED !== "false",
    maxAttempts: integer("LOGIN_MAX_ATTEMPTS", 5), windowSeconds: integer("LOGIN_WINDOW_SECONDS", 900),
    trustedIpTtlDays: integer("LOGIN_TRUSTED_IP_TTL_DAYS", 30), maxTrustedIps: integer("LOGIN_MAX_TRUSTED_IPS", 10),
    keyPrefix: process.env.AUTH_REDIS_PREFIX || "auth:",
    verificationEnabled: process.env.LOGIN_VERIFICATION_ENABLED !== "false",
    otpTtlSeconds: 300, otpMaxAttempts: 3,
    otpSecret: process.env.AUTH_OTP_SECRET || process.env.JWT_SECRET || null,
  },
  mail: {
    host: process.env.SMTP_HOST || "smtp.gmail.com", port: integer("SMTP_PORT", 587),
    secure: boolean("SMTP_SECURE"), user: process.env.SMTP_USER || null,
    password: process.env.SMTP_PASS || null, from: process.env.MAIL_FROM || null,
  },
  sepay: {
    apiUrl: process.env.SEPAY_API_URL || "https://my.sepay.vn/userapi",
    apiKey: process.env.SEPAY_API_KEY || null, accountNumber: process.env.SEPAY_ACCOUNT_NUMBER || null,
    bankCode: process.env.SEPAY_BANK_CODE || null, webhookToken: process.env.SEPAY_WEBHOOK_TOKEN || null,
    commissionRate: Number(process.env.PLATFORM_COMMISSION_RATE ?? 0.10),
  },
  maps: {
    vietmapApiToken: process.env.VIETMAP_API_TOKEN || null,
    maptilerApiKey: process.env.MAPTILER_API_KEY || null,
    valhallaRouterUrl: process.env.VALHALLA_ROUTER_URL || "http://valhalla:8002/route",
  },
  socket: { pingTimeout: integer("SOCKET_PING_TIMEOUT", 60000), pingInterval: integer("SOCKET_PING_INTERVAL", 25000) },
  swagger: { public: boolean("SWAGGER_PUBLIC") },
};
