# Giai đoạn 1 (Ngày 1 – Ngày 2): Setup Server Độc Lập & Dọn Dẹp Mã Nguồn

> **Mục tiêu**: Biến dự án từ bản clone WMS thành một Node.js Server độc lập hoàn toàn cho **RoadAssist**, loại bỏ gRPC và các module WMS cũ (kho hàng, vận chuyển, kiểm kê...), giữ nguyên khung kiến trúc nhiều tầng (Layered MVC), chuẩn hóa `index.js`, cấu hình môi trường `.env`, hệ thống mã lỗi và xử lý ngoại lệ tập trung.

---

## 1. Phân Tích & Kế Hoạch Dọn Dẹp (Refactoring Checklist)

### 1.1 Loại bỏ các phụ thuộc gRPC & Core Hub
- **Xóa**:
  - Thư mục `proto/` (các file `.proto` của Hub/Salesforce).
  - File cấu hình `src/config/grpc.config.js` và `src/config/salesforce_grpc.config.js`.
  - Service `src/services/grpc_server/` và các gRPC client tương ứng.
- **Gỡ bỏ dependencies trong `package.json`**:
  - `@grpc/grpc-js`, `@grpc/proto-loader`.
  - Các thư viện không còn dùng: `pdf-lib`, `pdfkit` (WMS in phiếu kho), `exceljs`, `csv-stringify` (nếu không cần xuất Excel kho).
- **Thêm dependencies cần thiết**:
  - `crypto` (built-in Node.js).
  - `nodemailer` (cho MailService OTP).
  - `socket.io` (Realtime events cho app & dashboard, đã có sẵn trong `package.json`).
  > [!IMPORTANT]
  > **Tuyệt đối KHÔNG sử dụng Firebase (không Firebase Auth, không Firestore/Realtime DB)**. Toàn bộ thực thể dữ liệu (Users, Auth Sessions, Devices, Vehicles, Providers, Flags, Dispatch Tickets, Chat, Bills, Payments) đều được quản lý 100% bằng **PostgreSQL thông qua Sequelize ORM (`src/config/postgres.config.js`)** và bộ đệm Redis.

### 1.2 Dọn dẹp các Module WMS Cũ nhưng Giữ lại Khung Cấu trúc
Dự án RoadAssist sẽ giữ nguyên các thư mục cốt lõi của WMS:
```text
RoadAssist_Server/
├── index.js                     # Điểm khởi chạy server chính
├── .env.development             # Cấu hình môi trường dev
├── .env.production              # Cấu hình môi trường prod
├── docs/                        # Tài liệu nghiệp vụ & roadmap
│   ├── BUSINESS_DOCS.md
│   └── roadmap/
├── src/
│   ├── common/                  # Enums, BaseException, ResponseHandler, ErrorCodes
│   ├── config/                  # App, Postgres, Redis, Swagger, Upload, Mail
│   ├── controllers/             # Tiếp nhận request & điều hướng
│   ├── jobs/                    # BullMQ queues & node-cron jobs
│   ├── middlewares/             # Auth, validation, error handler, rate limiter
│   ├── models/                  # Sequelize models & associations
│   ├── routes/                  # Express Router (/api/v1/...)
│   ├── schemas/                 # DTOs & Validation schemas
│   ├── seeds/                   # Dữ liệu khởi tạo (Admin, cấu hình hệ thống)
│   ├── services/                # Business logic, third-party integrations
│   └── utils/                   # Hàm phụ trợ (Geo, format, crypto...)
```

- **Các file WMS cần xóa bỏ hoặc thay thế**:
  - `src/models/inbound/`, `src/models/shipping/`, `src/models/warehouse/`, `src/models/stocktaking/`, `src/models/product/`, `src/models/stock*.model.js`, `src/models/company.model.js`.
  - `src/controllers/inbound.*`, `src/controllers/shipping.*`, `src/controllers/warehouse.*`, v.v.
  - `src/routes/inbound.*`, `src/routes/shipping.*`, `src/routes/warehouse.*`, v.v.
  - `src/services/stock.*`, `src/services/inbound.*`, `src/services/shipping.*`, v.v.
  - Các seed cũ: `seedCompanies`, `seedShippingLocations`, `seedAppIntegrations`.

---

## 2. Chuẩn Hóa `index.js` (Không gRPC, Comment Seed Cũ)

Giữ nguyên luồng khởi chạy an toàn của `index.js`, chỉ comment các phần seed cũ của WMS và tắt gRPC Server:

```javascript
// index.js (RoadAssist Standalone Server)
const express = require("express");
const http = require("http");
const morgan = require("morgan");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const config = require("./src/config/app.config");
const sequelize = require("./src/config/postgres.config");
const {
  runStartupDatabaseMigrations,
} = require("./src/config/database.migrations");
require("./src/models");
const apiRoutes = require("./src/routes");
const globalErrorHandler = require("./src/middlewares/error.handler");
const redis = require("./src/config/redis.config");

// [ROADASSIST SEEDING]: Sẽ kích hoạt sau khi thiết lập models Admin & Config
// const { seedSystemAdmin } = require("./src/seeds/admin.seed");
// const { seedSystemConfigs } = require("./src/seeds/config.seed");

const { initJobs } = require("./src/jobs");
const { initCronJobs } = require("./src/jobs/cron");

// Khởi tạo ứng dụng express
const app = express();
const server = http.createServer(app);

/**
 * Middlewares cơ bản
 */
app.use(morgan("dev"));
app.use(cors({ origin: config.cors, credentials: true }));
app.use(express.json({ limit: "10mb" })); // Tăng limit để nhận ảnh base64/upload hiện trường
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

/**
 * Health Check Endpoint
 */
app.get("/health", async (req, res) => {
  const redisStatus = redis.status === "ready" ? "Connected" : "Disconnected";

  res.status(200).json({
    status: "Running",
    app: config.app.name,
    version: config.app.version,
    env: config.app.env,
    database: "Connected",
    redis: redisStatus,
    uptime: process.uptime(),
  });
});

const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./src/config/swagger.config");
const restrictLocalhost = require("./src/middlewares/localhostOnly.middleware");

// Định tuyến API v1
app.use("/api", apiRoutes);

// Cấu hình Swagger UI (Chỉ localhost hoặc bật theo cờ env)
app.use(
  "/api-docs",
  restrictLocalhost,
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec),
);

// Global Error Handler
app.use(globalErrorHandler);

/**
 * Khởi động Server
 */
const startServer = async () => {
  try {
    await sequelize.authenticate();
    console.log("[DATABASE]: Kết nối Database thành công!");

    // Đồng bộ cấu trúc DB theo cờ config
    if (config.db.force_reset) {
      console.log("[DATABASE]: Đang force sync database...");
      await sequelize.sync({ force: true });
      await redis.flushall();
      console.log("[REDIS]: Đã flushall cache khi force reset.");
    } else {
      await sequelize.sync({ alter: true });
      console.log("[DATABASE]: Database đã đồng bộ cấu trúc.");
    }

    // Chạy migration tự động nếu có
    if (typeof runStartupDatabaseMigrations === "function") {
      await runStartupDatabaseMigrations(sequelize);
    }

    // [COMMENTED WMS SEEDS]:
    // await seedAppIntegrations();
    // await seedCompanies();
    // await seedShippingLocations();
    // require("./src/services/stock_notification.service").start();

    // Khởi tạo Background Jobs & Cron (Quản lý TTL sự cố, hết hạn báo giá, ping trực ca)
    await initJobs();
    await initCronJobs();

    // [DISABLED gRPC SERVER]: RoadAssist chạy là một Web API / WebSocket Server độc lập
    // startGrpcServer(config.app.grpcPort);

    const { port, name, version, env } = config.app;
    server.listen(port, () => {
      console.log(`==========================================`);
      console.log(`  🚗 ${name.toUpperCase()} SERVER (${version})`);
      console.log(`  Môi trường: ${env.toUpperCase()}`);
      console.log(`  URL: http://localhost:${port}`);
      console.log(`  Health Check: http://localhost:${port}/health`);
      console.log(`  API Docs: http://localhost:${port}/api-docs`);
      console.log(`==========================================`);
    });
  } catch (error) {
    console.error("Không thể khởi động Server:", error);
    process.exit(1);
  }
};

startServer();
```

---

## 3. Cấu Hình Biến Môi Trường (`.env.production` & `.env.development`)

Bổ sung các tham số cho **SePay**, **JWT Auth**, **Mail OTP**, và **VietMap/Valhalla**:

```env
# ----------------------------------------------------
# 1. DATABASE CONFIGURATION (PostgreSQL)
# ----------------------------------------------------
DB_NAME=wdp_road_assist_db
DB_USER=picare_dev
DB_PASSWORD=M@tkhau123
DB_PORT=5432
DB_HOST=picare-wms-postgres
DB_FORCE_RESET=false
DB_RESET=false

# ----------------------------------------------------
# 2. CACHE & QUEUE (Redis)
# ----------------------------------------------------
REDIS_HOST=wdp-road-assist-redis
REDIS_PORT=6379
REDIS_PASSWORD=M@tkhau123

# ----------------------------------------------------
# 3. APP SERVER CONFIGURATION
# ----------------------------------------------------
SERVER_PORT=9898
NODE_ENV=production
APP_NAME=RoadAssist-Server
APP_VERSION=1.0.0

# CORS Origins
ALLOWED_CLIENT_URL_1=https://roadassist.picare.vn
ALLOWED_CLIENT_URL_2=http://localhost:5173
ALLOWED_CLIENT_URL_3=http://localhost:8081

# ----------------------------------------------------
# 4. AUTH & SECURITY (Cloned from Picare Core)
# ----------------------------------------------------
JWT_SECRET=super_secret_jwt_roadassist_key_2026_xyz
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d

# Login Rate Limit & Security
LOGIN_RATE_LIMIT_ENABLED=true
LOGIN_MAX_ATTEMPTS=5
LOGIN_WINDOW_SECONDS=900
LOGIN_TRUSTED_IP_TTL_DAYS=30
LOGIN_MAX_TRUSTED_IPS=10

# ----------------------------------------------------
# 5. SMTP MAIL SERVICE (Gửi mã OTP xác thực)
# ----------------------------------------------------
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=picare.noreply@gmail.com
SMTP_PASS=app_password_here
MAIL_FROM="RoadAssist Security <picare.noreply@gmail.com>"

# ----------------------------------------------------
# 6. PAYMENT GATEWAY: SEPAY (https://developer.sepay.vn/)
# ----------------------------------------------------
SEPAY_API_URL=https://my.sepay.vn/userapi
SEPAY_API_KEY=YOUR_SEPAY_API_KEY_HERE
SEPAY_ACCOUNT_NUMBER=0123456789
SEPAY_BANK_CODE=MBBank
SEPAY_WEBHOOK_TOKEN=sepay_webhook_secure_secret_token_2026
PLATFORM_COMMISSION_RATE=0.10 # 10% hoa hồng nền tảng

# ----------------------------------------------------
# 7. ROUTING & MAPS (VietMap / Valhalla / MapTiler)
# ----------------------------------------------------
VIETMAP_API_TOKEN=4a2596178e4c8407f13d8f130da4cc0d72790441646afc4b
MAPTILER_API_KEY=your_maptiler_key_here
VALHALLA_ROUTER_URL=http://valhalla:8002/route

# ----------------------------------------------------
# 8. REALTIME (Socket.io - Gắn vào HTTP Server)
# ----------------------------------------------------
# Không sử dụng Firebase. Toàn bộ socket events và trạng thái phiên được quản lý trực tiếp qua Socket.io & Redis Adapter.
SOCKET_PING_TIMEOUT=60000
SOCKET_PING_INTERVAL=25000
```

---

## 4. Chuẩn Hóa Mã Lỗi & Xử Lý Ngoại Lệ (`BaseException` & `ResponseHandler`)

Tái sử dụng chuẩn Response và Exception của WMS nhưng bổ sung mã lỗi đặc thù cho RoadAssist trong `src/common/exceptions/error_codes.js`:

```javascript
module.exports = {
  // Hệ thống & Xác thực chung
  SUCCESS: "SUCCESS",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_ERROR: "VALIDATION_ERROR",

  // Auth & Session
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  AUTH_ACCOUNT_INACTIVE: "AUTH_ACCOUNT_INACTIVE",
  AUTH_LOGIN_RATE_LIMITED: "AUTH_LOGIN_RATE_LIMITED",
  AUTH_OTP_INVALID_OR_EXPIRED: "AUTH_OTP_INVALID_OR_EXPIRED",
  AUTH_SESSION_EXPIRED: "AUTH_SESSION_EXPIRED",
  USER_ALREADY_EXISTS: "USER_ALREADY_EXISTS",
  USER_NOT_FOUND: "USER_NOT_FOUND",

  // Phương tiện & Xe đang dùng
  VEHICLE_NOT_FOUND: "VEHICLE_NOT_FOUND",
  VEHICLE_ACTIVE_REQUIRED: "VEHICLE_ACTIVE_REQUIRED",
  VEHICLE_DIMENSIONS_INVALID: "VEHICLE_DIMENSIONS_INVALID",
  VEHICLE_BUSY: "VEHICLE_BUSY", // Xe đang có cuốc cứu hộ chưa hoàn thành (HTTP 409)

  // Đối tác & Trực ca
  PROVIDER_ALREADY_EXISTS: "PROVIDER_ALREADY_EXISTS",
  PROVIDER_NOT_FOUND: "PROVIDER_NOT_FOUND",
  PROVIDER_NOT_ACTIVE: "PROVIDER_NOT_ACTIVE",
  PROVIDER_TOW_PENDING_APPROVAL: "PROVIDER_TOW_PENDING_APPROVAL",
  PROVIDER_DUTY_SWITCH_DISABLED: "PROVIDER_DUTY_SWITCH_DISABLED",

  // Cứu hộ & Điều phối
  DISPATCH_TICKET_NOT_FOUND: "DISPATCH_TICKET_NOT_FOUND",
  DISPATCH_INVALID_STATE_TRANSITION: "DISPATCH_INVALID_STATE_TRANSITION",
  DISPATCH_CANCEL_NOT_ALLOWED: "DISPATCH_CANCEL_NOT_ALLOWED",
  DISPATCH_QUOTE_ALREADY_SUBMITTED: "DISPATCH_QUOTE_ALREADY_SUBMITTED",
  DISPATCH_SHOP_OUT_OF_RANGE: "DISPATCH_SHOP_OUT_OF_RANGE", // Khách cách tiệm > 200m

  // Thanh toán & Hóa đơn & SePay
  BILL_NOT_FOUND: "BILL_NOT_FOUND",
  PAYMENT_UNFUNDED_FOR_APPROVAL: "PAYMENT_UNFUNDED_FOR_APPROVAL", // Chưa thanh toán tạm giữ, không được duyệt báo giá
  PAYMENT_ALREADY_SETTLED: "PAYMENT_ALREADY_SETTLED",
  SEPAY_WEBHOOK_UNAUTHORIZED: "SEPAY_WEBHOOK_UNAUTHORIZED",
  SEPAY_TRANSACTION_MISMATCH: "SEPAY_TRANSACTION_MISMATCH",
  DISPUTE_WINDOW_EXPIRED: "DISPUTE_WINDOW_EXPIRED", // Quá thời hạn 7 ngày khiếu nại
};
```

---

## 5. Kế Hoạch Push Commit Chi Tiết

### Đợt 1 (Ngày 1) — `chore(setup)`: Dọn dẹp WMS & loại bỏ gRPC
- **Mục tiêu**: Xóa bỏ các model/route/service WMS thừa, gỡ gRPC packages, chuẩn hóa `package.json` và thiết lập thư mục skeleton.
- **Các bước thực hiện**:
  1. Xóa các model WMS cũ trong `src/models/` (chỉ giữ file `src/models/index.js` khung trống).
  2. Xóa các controllers, routes, schemas không liên quan trong `src/`.
  3. Xóa thư mục `proto/`, file `grpc.config.js`, `salesforce_grpc.config.js`.
  4. Cập nhật `package.json`: gỡ `@grpc/grpc-js`, `@grpc/proto-loader`.
  5. Cập nhật `src/routes/index.js` chỉ gắn `/v1` skeleton.
- **Git Commit Message**:
  ```text
  chore(setup): remove grpc and legacy wms modules, establish clean layered skeleton
  ```

### Đợt 2 (Ngày 2) — `feat(core)`: Cấu hình môi trường, DB sync, Exception & Error Handler
- **Mục tiêu**: Cập nhật `index.js`, file cấu hình app/postgres/redis, bổ sung mã lỗi nghiệp vụ RoadAssist, kiểm tra `/health`.
- **Các bước thực hiện**:
  1. Cập nhật `index.js` (comment seeds cũ, tắt gRPC server, tăng giới hạn body parser `10mb`).
  2. Cập nhật `src/config/app.config.js` đọc biến môi trường mới (JWT, SePay, Mail, VietMap).
  3. Bổ sung `error_codes.js` đầy đủ cho các nghiệp vụ RoadAssist.
  4. Kiểm tra khởi động server bằng `npm run dev` đảm bảo cổng `9898` kết nối thành công PostgreSQL và Redis, endpoint `GET /health` trả về `200 OK`.
- **Git Commit Message**:
  ```text
  feat(core): configure standalone database connection, redis, app config and centralized error codes
  ```


---

## 6. Kết quả triển khai (2026-11-02)

- Đã xóa module, proto, gRPC client/server, seed, migration, job, script và test WMS cũ; giữ skeleton Layered MVC.
- Đã cập nhật dependencies/lockfile, thêm Nodemailer; `crypto` dùng built-in Node.js.
- Đã chuẩn hóa cấu hình RoadAssist, `.env.development`, `.env.production`, `.env.example`, Swagger và hệ thống exception, gồm `ConflictException`.
- `index.js` kiểm tra PostgreSQL/Redis trước khi listen, body limit 10 MB, trả lỗi JSON tập trung và đóng kết nối khi shutdown.
- `/health` kiểm tra dependency thực tế: HTTP 200 khi cả hai sẵn sàng, HTTP 503 nếu có lỗi.
- Reset mặc định tắt; từ chối `DB_RESET` cũ và hai cờ reset đồng thời. Force reset chỉ flush Redis database đang chọn thay vì `flushall` toàn instance.
- Đã cập nhật Dockerfile sang cổng 9898, bỏ proto; workflow production chuyển sang image/path/secrets RoadAssist, bỏ seed và Google key WMS.
- Xác minh: `npm test` **8/8 pass**; `npm run dev` khởi động thành công; gọi `http://localhost:9898/health` trả HTTP 200, PostgreSQL và Redis đều `Connected`; Docker image `roadassist-server:phase1` build thành công.
- `npm audit` sau cập nhật còn 6 cảnh báo mức moderate từ dependencies gián tiếp (minimatch/uuid). Không áp dụng `audit fix --force` vì đề xuất downgrade/breaking changes.
- Chưa commit/push: workspace chưa khởi tạo Git và chưa có remote. Chưa deploy production; cần thiết lập `ROADASSIST_PRODUCTION_ENV` và infrastructure theo README.
- Mã cũ được lưu tại thư mục cùng cấp `../RoadAssist_Server_phase1_backup/` trước khi dọn dẹp.
