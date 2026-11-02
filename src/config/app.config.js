const path = require("node:path");
const fs = require("node:fs");
const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : ".env.development";
const envPath = path.resolve(__dirname, "../..", envFile);
require("dotenv").config({
  path: fs.existsSync(envPath)
    ? envPath
    : path.resolve(__dirname, "../../.env"),
  quiet: true,
});
const integer = (key, fallback) =>
  Number.parseInt(process.env[key], 10) || fallback;
const boolean = (key) => process.env[key] === "true";
const origins = Object.keys(process.env)
  .filter((key) => key.startsWith("ALLOWED_CLIENT_URL_"))
  .map((key) => process.env[key])
  .filter(Boolean);
const maxAccuracyMeters = Number(
  process.env.PROVIDER_GPS_MAX_ACCURACY_METERS || 100,
);
if (
  !Number.isFinite(maxAccuracyMeters) ||
  maxAccuracyMeters < 1 ||
  maxAccuracyMeters > 1000
)
  throw new Error(
    "PROVIDER_GPS_MAX_ACCURACY_METERS must be between 1 and 1000",
  );
module.exports = {
  app: {
    name: process.env.APP_NAME || "RoadAssist-Server",
    version: process.env.APP_VERSION || "1.0.0",
    env: process.env.NODE_ENV || "development",
    port: integer("SERVER_PORT", 9898),
    // A comma-separated allowlist of proxy IPs/CIDRs; do not trust arbitrary forwarded headers.
    trustProxy: process.env.TRUST_PROXY
      ? process.env.TRUST_PROXY.split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : false,
    isProduction: process.env.NODE_ENV === "production",
  },
  db: {
    host: process.env.DB_HOST || "localhost",
    port: integer("DB_PORT", 5432),
    name: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    reset: boolean("DB_RESET"),
    force_reset: boolean("DB_FORCE_RESET"),
  },
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: integer("REDIS_PORT", 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  cors(origin, callback) {
    if (!origin || origins.includes(origin)) return callback(null, true);
    const {
      ForbiddenException,
    } = require("../common/exceptions/BaseException");
    callback(new ForbiddenException("Origin không được phép truy cập"));
  },
  jwt: {
    secret: process.env.JWT_SECRET || null,
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "30d",
  },
  cookies: {
    secure: process.env.NODE_ENV === "production",
    sameSite: (
      process.env.AUTH_COOKIE_SAME_SITE ||
      (process.env.NODE_ENV === "production" ? "none" : "lax")
    ).toLowerCase(),
  },
  login: {
    rateLimitEnabled: process.env.LOGIN_RATE_LIMIT_ENABLED !== "false",
    maxAttempts: integer("LOGIN_MAX_ATTEMPTS", 5),
    windowSeconds: integer("LOGIN_WINDOW_SECONDS", 900),
  },
  emailVerification: {
    keyPrefix: process.env.AUTH_REDIS_PREFIX || "auth:v2:",
    otpTtlSeconds: 300,
    otpMaxAttempts: 3,
    otpSecret: process.env.AUTH_OTP_SECRET || process.env.JWT_SECRET || null,
  },
  mail: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: integer("SMTP_PORT", 587),
    secure: boolean("SMTP_SECURE"),
    user: process.env.SMTP_USER || null,
    password: process.env.SMTP_PASS || null,
    from: process.env.MAIL_FROM || null,
  },
  sepay: {
    apiUrl: process.env.SEPAY_API_URL || "https://my.sepay.vn/userapi",
    apiKey: process.env.SEPAY_API_KEY || null,
    accountNumber: process.env.SEPAY_ACCOUNT_NUMBER || null,
    bankCode: process.env.SEPAY_BANK_CODE || null,
    webhookToken: process.env.SEPAY_WEBHOOK_TOKEN || null,
    webhookAuth: process.env.SEPAY_WEBHOOK_AUTH || "apikey",
    webhookSecret: process.env.SEPAY_WEBHOOK_SECRET || "",
    accountName: process.env.SEPAY_ACCOUNT_NAME || "",
    gatewayName:
      process.env.SEPAY_GATEWAY_NAME || process.env.SEPAY_BANK_CODE || "",
    subAccount: process.env.SEPAY_SUB_ACCOUNT || "",
    transferPrefix: process.env.SEPAY_TRANSFER_PREFIX || "",
    holdDays: Number(process.env.PAYOUT_HOLD_DAYS ?? 7),
    paymentTtlMinutes: Number(process.env.PAYMENT_TTL_MINUTES ?? 15),
    commissionRate: Number(process.env.PLATFORM_COMMISSION_RATE ?? 0.1),
  },
  maps: {
    vietmapApiToken: process.env.VIETMAP_API_TOKEN || null,
    maptilerApiKey: process.env.MAPTILER_API_KEY || null,
    valhallaRouterUrl:
      process.env.VALHALLA_ROUTER_URL || "http://valhalla:8002/route",
  },
  operations: {
    disputeResponseHours: Number(process.env.DISPUTE_RESPONSE_HOURS ?? 48),
    cashGraceHours: Number(process.env.CASH_DEBT_GRACE_HOURS ?? 24),
    cashMaxUnpaidTickets: Number(
      process.env.CASH_MAX_UNPAID_COMPLETED_REQUESTS ?? 2,
    ),
    queueTtlMinutes: Number(process.env.DISPATCH_QUEUE_TTL_MINUTES ?? 15),
    arrivalTimeoutMinutes: Number(
      process.env.DISPATCH_ARRIVAL_TIMEOUT_MINUTES ?? 30,
    ),
    noProgressMinutes: Number(process.env.DISPATCH_NO_PROGRESS_MINUTES ?? 10),
    minProgressMeters: Number(process.env.DISPATCH_MIN_PROGRESS_METERS ?? 100),
    maxRematches: Number(process.env.DISPATCH_MAX_REMATCHES ?? 3),
    intakeReplyMinutes: Number(process.env.INTAKE_REPLY_MINUTES ?? 5),
    intakeHoldMinutes: Number(process.env.INTAKE_HOLD_MINUTES ?? 120),
  },
  dispatch: {
    sosCallOutFee: process.env.DISPATCH_SOS_CALLOUT_FEE || "30000",
    sosPerKm: process.env.DISPATCH_SOS_PER_KM || "5000",
    towBaseFee: process.env.DISPATCH_TOW_BASE_FEE || "150000",
    towPerKm: process.env.DISPATCH_TOW_PER_KM || "10000",
    waitingPerMinute: process.env.DISPATCH_WAITING_PER_MINUTE || "2000",
  },
  s3: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    region: process.env.AWS_REGION || "ap-southeast-1",
    bucketName: process.env.AWS_S3_BUCKET_NAME || "picare-s3",
    endpoint: process.env.AWS_S3_ENDPOINT || undefined,
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || "",
    folder: "roadassist",
    visibility: "public",
    uploadTimeoutMs: integer("S3_UPLOAD_TIMEOUT_MS", 60000),
  },
  socket: {
    pingTimeout: integer("SOCKET_PING_TIMEOUT", 60000),
    pingInterval: integer("SOCKET_PING_INTERVAL", 25000),
  },
  providers: {
    redisPrefix: process.env.PROVIDER_REDIS_PREFIX || "",
    locationTtlSeconds: 900,
    maxAccuracyMeters,
    maxPlausibleSpeedMps: 60,
  },
  swagger: { public: boolean("SWAGGER_PUBLIC") },
};
