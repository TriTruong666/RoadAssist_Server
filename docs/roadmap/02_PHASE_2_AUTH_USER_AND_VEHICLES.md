# Giai đoạn 2 (Ngày 3 – Ngày 4): Xác Thực (Auth), Phân Quyền 3 Roles & Quản Lý Phương Tiện

> **Mục tiêu**: Tái hiện toàn bộ logic bảo mật mạnh mẽ từ `Picare_Core_Server` thành phiên bản độc lập trong `RoadAssist_Server`: Hệ thống xác thực JWT kèm `sessionVersion`, rate limiter chống brute-force bằng Redis Lua script, xác thực OTP qua Mail, quản lý 3 Roles (`admin`, `guest`, `provider`), và phân hệ Quản lý Hồ sơ Phương tiện (`VehicleProfile` & `RideConfig`) phục vụ toàn bộ nền tảng Web.

> [!IMPORTANT]
> **Quy định Kiến trúc Xác thực & Nền tảng Vận hành**:
> - **100% Vận hành trên Nền tảng Web (Web Application / Web Platform)**: Toàn bộ tương tác của cả 3 đối tượng (Admin trên Web Quản trị, Khách hàng Rider trên Web App, Đối tác Provider trên Web Cứu hộ) đều chạy hoàn toàn trên trình duyệt Web, **tuyệt đối không có ứng dụng di động native**.
> - **Tuyệt đối KHÔNG sử dụng Firebase Auth hay Firebase SDK**: Toàn bộ dữ liệu tài khoản, mật khẩu băm (`bcrypt`), phiên đăng nhập, `sessionVersion`, IP tin cậy và `webPushToken` đều được lưu trữ và truy vấn trực tiếp trên cơ sở dữ liệu **PostgreSQL thông qua Sequelize ORM (`src/config/postgres.config.js`)**.
> - Phía Web Application sẽ gọi trực tiếp các API xác thực chuẩn RESTful của RoadAssist Server (`/api/v1/auth/login`, `/api/v1/auth/register`...) và sử dụng cookie HttpOnly `road_as_token` do máy chủ thiết lập.

> **Quyết định nghiệp vụ mới (ưu tiên hơn các ví dụ ban đầu bên dưới):** OTP dùng để xác minh chủ sở hữu email lúc đăng ký, không xác minh IP khi đăng nhập. Đăng nhập tài khoản đã xác minh chỉ cần đúng email/mật khẩu và trạng thái ACTIVE. Lựa chọn dịch vụ lưu ở requestedServices; services chỉ cấp theo hồ sơ đối tác ACTIVE đã được duyệt. Chi tiết hợp đồng hiện hành xem README và Swagger.

---

## 1. Thiết Kế Mô Hình Dữ Liệu (Models & Schemas)

### 1.1 Model Người Dùng (`User`) — `src/models/user.model.js`
Kế thừa và mở rộng từ `Picare_Core_Server/src/models/user.model.js`:

```javascript
const { DataTypes } = require("sequelize");
const sequelize = require("../config/postgres.config");
const bcrypt = require("bcrypt");

const User = sequelize.define(
  "User",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      allowNull: false,
      unique: true,
      field: "user_id",
    },
    name: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(150),
      allowNull: false,
      unique: true,
      validate: { isEmail: true },
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: false,
      unique: true,
    },
    // 3 Roles cốt lõi: 'admin' (hệ thống), 'guest' (người đi đường / rider), 'provider' (đối tác cứu hộ)
    role: {
      type: DataTypes.ENUM("admin", "guest", "provider"),
      defaultValue: "guest",
      allowNull: false,
    },
    // Mảng dịch vụ người dùng được cấp phép: RIDER, SHOP, MOBILE_SHOP, TOW
    services: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: ["RIDER"],
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("ACTIVE", "INACTIVE", "BANNED"),
      defaultValue: "ACTIVE",
      allowNull: false,
    },
    onboarded: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    activeVehicleId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "active_vehicle_id",
    },
    sessionVersion: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      allowNull: false,
      field: "session_version",
    },
    emailVerifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "email_verified_at",
    },
    requestedServices: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: ["RIDER"],
      allowNull: false,
      field: "requested_services",
    },
    loginIp: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: "login_ip",
    },
    loginAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "login_at",
    },
    logoutAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "logout_at",
    },
    // Lưu Web Push Token của trình duyệt Web trực tiếp vào PostgreSQL
    webPushToken: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: "web_push_token",
    },
  },
  {
    tableName: "users",
    timestamps: true,
    hooks: {
      beforeCreate: async (user) => {
        if (user.password) {
          const salt = await bcrypt.genSalt(12);
          user.password = await bcrypt.hash(user.password, salt);
        }
      },
      beforeUpdate: async (user) => {
        if (user.changed("password")) {
          const salt = await bcrypt.genSalt(12);
          user.password = await bcrypt.hash(user.password, salt);
        }
        // Tăng sessionVersion để tự động vô hiệu hóa các JWT cũ khi có thay đổi quan trọng
        const invalidates = ["password", "status", "role", "email"].some(f => user.changed(f));
        if (invalidates && !user.changed("sessionVersion")) {
          user.sessionVersion = Number(user.sessionVersion || 0) + 1;
        }
      },
    },
  }
);

User.prototype.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = User;
```

### 1.2 Model Hồ Sơ Phương Tiện (`VehicleProfile` & `RideConfig`)
- **`VehicleProfile`**: Lưu thông số kích thước vật lý của xe.
  - Phân loại: `BIKE` (rộng mặc định 0.7m, cao 1.1m) hoặc `CAR` (rộng mặc định 1.9m, cao 1.5m).
  - Ràng buộc: Chiều rộng `0.3m – 3.0m`, chiều cao `0.5m – 3.0m`.
  - Biển số (`plateNumber`): Chuẩn hóa chữ in hoa không khoảng trắng.
- **`RideConfig`**: Cấu hình chuyến đi tải trọng (`SOLO`, `PASSENGER`, `CARGO`) kèm kích thước thực tế sau khi xếp đồ/chở người.

```javascript
// src/models/vehicle_profile.model.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/postgres.config");

const VehicleProfile = sequelize.define(
  "VehicleProfile",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "user_id",
    },
    type: {
      type: DataTypes.ENUM("BIKE", "CAR"),
      allowNull: false,
    },
    plateNumber: {
      type: DataTypes.STRING(20),
      allowNull: false,
      field: "plate_number",
    },
    brand: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    modelName: {
      type: DataTypes.STRING(50),
      allowNull: false,
      field: "model_name",
    },
    color: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    baseWidth: {
      type: DataTypes.FLOAT, // mét
      allowNull: false,
      field: "base_width",
      validate: { min: 0.3, max: 3.0 },
    },
    baseHeight: {
      type: DataTypes.FLOAT, // mét
      allowNull: false,
      field: "base_height",
      validate: { min: 0.5, max: 3.0 },
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: "is_active",
    },
  },
  {
    tableName: "vehicle_profiles",
    timestamps: true,
  }
);

module.exports = VehicleProfile;
```

---

## 2. Dịch Vụ Bảo Mật & Xác Thực (Services)

### 2.1 JWT Service Với Quản Lý Phiên (`sessionVersion`) — `src/services/jwt.service.js`
- `signUser(name, role, userId, sessionVersion, options)`: Ký token chứa `userId`, `role`, và `sessionVersion`.
- `verifyUserSession(token)`: Giải mã và truy vấn DB; nếu `status !== 'ACTIVE'` hoặc `decoded.sessionVersion !== user.sessionVersion`, lập tức từ chối (`401 Unauthorized`), ép đăng xuất phía client.

### 2.2 Login Rate Limiter (Redis Lua Script) — `src/services/login_rate_limit.service.js`
- Giới hạn **5 lần thất bại liên tiếp trong 15 phút** (`900s`) theo cả IP và Email.
- Sử dụng atomic Lua script trên Redis để tránh race condition khi nhiều luồng brute-force cùng lúc.
- Khi bị khóa, trả về mã lỗi `AUTH_LOGIN_RATE_LIMITED` kèm trường `retryAfter` (số giây còn lại).

### 2.3 Xác Minh Email Đăng Ký & Mail Service
- `src/services/email_verification.service.js`: OTP 6 chữ số, Redis hash chứa HMAC, TTL 5 phút, tối đa 3 lần sai, dùng một lần, phân biệt mục đích đăng ký/reset mật khẩu. Không ràng buộc IP.
- `src/models/pending_registration.model.js`: draft đăng ký lưu PostgreSQL, password đã bcrypt, hết hạn 15 phút. Chưa tạo User/chưa cấp phiên trước OTP đúng.
- `src/services/mail.service.js`: gửi OTP xác minh email hoặc reset mật khẩu qua Nodemailer. Không gửi OTP đăng nhập.
- Có resend cooldown 60 giây và rate limit chống spam email. Account cũ chưa xác minh dùng `/auth/send-verification` để gửi mã sau khi nhập đúng mật khẩu.

### 2.4 Auth Service Độc Lập — `src/services/auth.service.js`
- `register(...)` và `registerProvider(...)`: validate trùng email/phone đã có tài khoản, lưu draft + password hash, gửi OTP; trả registrationId/challengeId, không trả token.
- `verifyEmail(...)`: OTP đúng mới tạo User guest, `services: ["RIDER"]`, `requestedServices` theo lựa chọn, emailVerifiedAt và cấp phiên. Alias HTTP `/verify-otp` cũng chỉ xác minh email.
- `login(...)`: kiểm tra mật khẩu, rate limit, status ACTIVE và email đã xác minh; cấp phiên ngay, không kiểm tra IP tin cậy.
- `issueSession(...)`: access JWT và refresh JWT rotation, lưu hash refresh token ở AuthSession PostgreSQL.
- `forgotPassword/resetPassword`: OTP email riêng biệt với OTP đăng ký; reset xác minh chủ mail và thu hồi toàn bộ phiên cũ.
- `ProviderAccessService`: quyền dịch vụ suy ra từ hồ sơ ACTIVE đã duyệt, không suspended và xe hợp lệ. Không cấp quyền provider qua register/onboard.

---

## 3. Middleware Bảo Vệ & Phân Quyền

Thay thế toàn bộ `grpcClient.verifyToken` cũ trong `src/middlewares/auth.middleware.js`:

```javascript
const JWTService = require("../services/jwt.service");
const { UnauthorizedException, ForbiddenException } = require("../common/exceptions/BaseException");
const ErrorCodes = require("../common/exceptions/error_codes");

// Middleware xác thực danh tính
const protect = async (req, res, next) => {
  try {
    const token = req.cookies?.road_as_token;

    if (!token) {
      throw new UnauthorizedException(ErrorCodes.UNAUTHORIZED);
    }

    const payload = await JWTService.verifyUserSession(token);
    if (!payload) {
      throw new UnauthorizedException(ErrorCodes.AUTH_SESSION_EXPIRED);
    }

    // Gán dữ liệu vào context của request
    req.user = payload; // { userId, name, role, sessionVersion }
    next();
  } catch (error) {
    next(error);
  }
};

// Middleware kiểm tra Role (admin / guest / provider)
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new ForbiddenException(ErrorCodes.FORBIDDEN);
    }
    next();
  };
};

// Middleware kiểm tra Giấy phép dịch vụ (RIDER, SHOP, MOBILE_SHOP, TOW)
const requireServices = (...requiredServices) => {
  return async (req, res, next) => {
    const User = require("../models/user.model");
    const user = await User.findOne({ where: { userId: req.user.userId } });
    
    const userServices = user?.services || [];
    const hasPermission = requiredServices.some(s => userServices.includes(s));

    if (!hasPermission) {
      throw new ForbiddenException("Vai trò này chưa hỗ trợ cho tài khoản của bạn.");
    }
    next();
  };
};

module.exports = { protect, restrictTo, requireServices };
```

---

## 4. Đặc Tả Danh Sách Endpoints (API Contracts)

### 4.1 Phân hệ Xác Thực (`/api/v1/auth`)
| Method | Endpoint | Mô Tả Nghiệp Vụ | Phân Quyền |
|---|---|---|---|
| `POST` | `/api/v1/auth/register` | Đăng ký tài khoản Người đi đường (Rider) (`email`, `password`, `phone`, `name`) | Public |
| `POST` | `/api/v1/auth/register-provider` | Đăng ký tài khoản Đối tác Cứu hộ (`provider`) | Public |
| `POST` | `/api/v1/auth/login` | Đăng nhập hệ thống, kiểm tra mật khẩu, email đã xác minh & rate limit | Public |
| `POST` | `/api/v1/auth/verify-otp` | Alias xác minh email đăng ký, không xác minh IP | Public |
| `POST` | `/api/v1/auth/verify-email` | Xác minh chủ email, hoàn tất đăng ký và cấp phiên | Public |
| `POST` | `/api/v1/auth/resend-verification` | Gửi lại OTP cho registrationId còn hạn | Public |
| `POST` | `/api/v1/auth/send-verification` | Gửi OTP cho tài khoản cũ chưa xác minh, yêu cầu email/password | Public |
| `POST` | `/api/v1/auth/refresh-token` | Làm mới JWT token bằng refresh token | Public |
| `POST` | `/api/v1/auth/logout` | Đăng xuất, ghi nhận `logoutAt` và xóa session cookie | Cookie `road_as_token` |
| `POST` | `/api/v1/auth/forgot-password` | Gửi email yêu cầu đặt lại mật khẩu | Public |
| `POST` | `/api/v1/auth/reset-password` | Đặt lại mật khẩu mới thông qua token/OTP | Public |

### 4.2 Phân hệ Người Dùng & Onboarding (`/api/v1/users`)
| Method | Endpoint | Mô Tả Nghiệp Vụ | Phân Quyền |
|---|---|---|---|
| `GET` | `/api/v1/users/me` | Lấy thông tin cá nhân, vai trò, mảng `services`, và xe `activeVehicle` | Cookie `road_as_token` |
| `PUT` | `/api/v1/users/me` | Cập nhật thông tin hiển thị (`name`, avatar) | Cookie `road_as_token` |
| `PUT` | `/api/v1/users/onboard` | Hoàn thành Onboarding Wizard chọn vai trò và cấu hình ban đầu | Cookie `road_as_token` |
| `PUT` | `/api/v1/users/active-vehicle` | Chọn 1 xe làm `activeVehicle` dùng cho định tuyến & gọi cứu hộ | Cookie `road_as_token` (`RIDER`) |

### 4.3 Phân hệ Phương Tiện (`/api/v1/vehicles`)
| Method | Endpoint | Mô Tả Nghiệp Vụ | Phân Quyền |
|---|---|---|---|
| `GET` | `/api/v1/vehicles` | Lấy danh sách hồ sơ xe của người dùng hiện tại kèm cấu hình tải | Cookie `road_as_token` (`RIDER`) |
| `POST` | `/api/v1/vehicles` | Tạo hồ sơ xe mới (`type`, `plateNumber`, `width`, `height`), tự gắn `SOLO` | Cookie `road_as_token` (`RIDER`) |
| `PUT` | `/api/v1/vehicles/:id` | Sửa thông số xe và cấu hình tải trọng (`RideConfig`) | Cookie `road_as_token` (`RIDER`) |
| `DELETE` | `/api/v1/vehicles/:id` | Xóa xe (Cảnh báo: Nếu đang liên kết `TOW` hoặc `MOBILE_SHOP`, tự động thu hồi giấy phép) | Cookie `road_as_token` (`RIDER`) |

---

## 5. Kế Hoạch Push Commit Chi Tiết

### Đợt 3 (Ngày 3) — `feat(auth)`: Triển khai Auth Models, JWT, Rate Limiter & Mail Service
- **Mục tiêu**: Xây dựng xong nền tảng bảo mật độc lập: `User` model, `JWTService` có `sessionVersion`, `LoginRateLimitService`, `LoginVerificationService`, `MailService`.
- **Các bước thực hiện**:
  1. Tạo `src/models/user.model.js` với 3 roles và mảng `services`.
  2. Viết `src/services/jwt.service.js` hỗ trợ giải mã và kiểm tra `sessionVersion`.
  3. Viết `src/services/login_rate_limit.service.js` với Lua script trên Redis.
  4. Viết `src/services/mail.service.js` gửi template OTP qua SMTP.
  5. Viết `src/services/auth.service.js` và `src/controllers/auth.controller.js`.
  6. Khởi tạo `src/routes/auth.routes.js` gắn vào router chính.
- **Git Commit Message**:
  ```text
  feat(auth): implement standalone user model, jwt session with versioning, redis rate limiter and otp mailer
  ```

### Đợt 4 (Ngày 4) — `feat(user-vehicle)`: Đăng ký Rider/Provider, Onboarding & CRUD Phương tiện
- **Mục tiêu**: Hoàn thiện các API đăng ký, phân quyền 3 roles (`protect`, `restrictTo`), onboarding wizard và quản lý hồ sơ xe (`VehicleProfile`).
- **Các bước thực hiện**:
  1. Xây dựng middleware `protect`, `restrictTo`, `requireServices` trong `src/middlewares/auth.middleware.js`.
  2. Tạo model `VehicleProfile` và `VehicleRideConfig`.
  3. Viết `vehicle.service.js` và `vehicle.controller.js` hỗ trợ kiểm tra kích thước `[0.3-3.0m]` x `[0.5-3.0m]` và chuẩn hóa biển số.
  4. Bổ sung API `PUT /users/active-vehicle` và kiểm tra logic ràng buộc xóa xe.
  5. Viết unit/integration test cơ bản kiểm tra luồng login -> tạo xe -> lấy thông tin `me`.
- **Git Commit Message**:
  ```text
  feat(user-vehicle): add user registration for 3 roles, onboarding wizard and vehicle profile management apis
  ```


---

## 6. Kết quả triển khai ban đầu (lịch sử trước điều chỉnh ở mục 7)

- Hoàn thành cả hai đợt chức năng. Theo yêu cầu sau triển khai, lịch sử được tổ chức thành tổng cộng 12 commit: giữ 2 commit hiện có và bổ sung 10 commit Phase 2 theo nhóm chức năng.
- Models PostgreSQL: `User`, `AuthSession`, `VehicleProfile`, `VehicleRideConfig`; đầy đủ associations, bcrypt cost 12 và hooks tăng `sessionVersion` khi password/status/role/email thay đổi.
- Đủ 16 API theo bảng hợp đồng; đăng ký không cho tự gán admin, cập nhật profile không cho sửa role/status/services.
- JWT access/refresh phân biệt mục đích, HS256 với issuer/audience; đối chiếu trạng thái tài khoản, phiên PostgreSQL và `sessionVersion`. Refresh token lưu hash, rotation có khóa transaction; logout/reset password vô hiệu hóa phiên cũ.
- Redis Lua thực hiện đếm lỗi atomic theo email/IP và challenge OTP dùng một lần, TTL 300 giây, tối đa 3 lần nhập sai, ràng buộc IP và mục đích login/reset. Có cooldown gửi mã 60 giây.
- SMTP Nodemailer gửi OTP đăng nhập kèm cảnh báo IP lạ và mã reset password. `LOGIN_VERIFICATION_ENABLED=true` mặc định; cần điền SMTP thật để gửi mail. Không có API trả OTP hoặc ghi OTP ra log.
- Quên mật khẩu trả cùng thông báo cho tài khoản có/không tồn tại. Thay mật khẩu xóa danh sách IP tin cậy và thu hồi các session.
- Hồ sơ xe có dimension defaults, giới hạn kích thước, chuẩn hóa biển số, SOLO mặc định, CRUD và chọn xe đang dùng có kiểm tra owner trong transaction.
- Phần thu hồi giấy phép có adapter cho `sequelize.models.Provider`: khi Phase 3 đăng ký model, xóa xe sẽ set liên kết MOBILE_SHOP/TOW sang DENIED, tắt duty, suspend, tháo liên kết và bỏ service tương ứng trong cùng transaction. Đã kiểm thử adapter và rollback bằng model Provider thử nghiệm trong schema riêng; không tạo model Provider production trước Phase 3.
- Onboarding trả session mới sau khi đổi role. Lựa chọn service provider ở Phase 2 không thay thế duyệt hồ sơ/quyền trực ca ở Phase 3.
- Seed admin tùy chọn qua `ADMIN_SEED_EMAIL/PASSWORD/PHONE/NAME`, không hardcode mật khẩu, không tự nâng quyền tài khoản đã có.
- Swagger mô tả đầy đủ 16 operations và payloads. README và `.env.example` có hướng dẫn token rotation, OTP/reset password, reverse proxy và seed admin.
- Kiểm tra: 12 bài kiểm tra không cần hạ tầng và 17 bài integration PostgreSQL/Redis đều pass; integration tạo schema/Redis namespace riêng và dọn sau chạy, SMTP được giả lập. Chưa kiểm chứng gửi email qua SMTP thật vì chưa có credentials.
- `npm run dev` khởi động thành công ở cổng 9898; `/health` HTTP 200 với PostgreSQL/Redis `Connected`, `/api-docs/` HTTP 200.
- Docker image `roadassist-server:phase2` build thành công; kiểm tra import runtime Node 20 trong container thành công.


## 7. Điều chỉnh nghiệp vụ Auth và phương tiện

- Đăng ký tạo PendingRegistration (PostgreSQL, password đã bcrypt), gửi OTP email và chưa cấp token/chưa tạo User. OTP đúng mới tạo User với emailVerifiedAt và cấp phiên.
- Thêm `/auth/verify-email`, `/auth/resend-verification` và `/auth/send-verification` (cho tài khoản cũ chưa xác minh). `/verify-otp` chỉ còn là alias xác minh email.
- Xóa LoginVerificationService và danh sách IP tin cậy. Đổi mạng/IP không yêu cầu OTP; IP chỉ phục vụ audit/rate limit. OTP email vẫn TTL 300 giây, 3 lần nhập sai, chống replay, cooldown 60 giây.
- requestedServices là nhu cầu đăng ký; services và role provider được suy ra từ hồ sơ ACTIVE, không suspended, có xe hợp lệ (TOW cần CAR). API onboarding không tự cấp quyền.
- Sửa/xóa xe bị chặn HTTP 409 khi xe hoặc đối tác gắn xe đang có cuốc mở. Sửa thông tin quan trọng khi xe rảnh đưa hồ sơ đã duyệt về PENDING, tắt duty và thu hồi quyền chờ duyệt lại.
- Provider/DispatchTicket đầy đủ vẫn thuộc Phase 3/5. Đã kiểm thử các adapter nghiệp vụ qua bảng fixture PostgreSQL trong schema riêng; Phase 5 phải dùng cùng quy tắc khóa bản ghi khi tạo/nhận cuốc để tránh race.
- SMTP integration dùng transport giả lập trong test; gửi email thật cần cấu hình SMTP.
- Xác minh sau điều chỉnh: `RUN_DB_TESTS=1 npm test` **39/39 pass**, không skip; bao gồm PostgreSQL/Redis, OTP registration, đăng nhập nhiều IP không gửi OTP, grants theo hồ sơ, xe bận/reapproval/rollback, migration và seed JSON. Docker build và import runtime Node 20 thành công; `/health` và `/api-docs/` trả HTTP 200.


## 8. Cookie Authentication

- Mọi API người dùng chỉ đọc access JWT từ cookie HttpOnly `road_as_token`; không nhận Authorization/Bearer hoặc cookie `token` cũ.
- Refresh JWT lưu trong cookie HttpOnly `road_as_refresh_token`, Path=/api/v1/auth. Refresh endpoint không nhận token trong body và tự rotate cả hai cookie.
- Login, verify-email/verify-otp và onboarding set cookie; response JSON không chứa token/refreshToken/tokenType. Web dùng fetch credentials: include hoặc Axios withCredentials: true.
- Development: SameSite=Lax, không Secure. Production: SameSite=None + Secure (HTTPS), giống Core. Expiration theo JWT, set/clear dùng cùng Path/SameSite/Secure.
- Logout thu hồi phiên qua cookie access hoặc refresh hợp lệ; kể cả access hết hạn vẫn đăng xuất được bằng refresh. Luôn clear cả hai cookie, idempotent khi đã đăng xuất. Reset password cũng clear cookie.
- CORS chỉ cho origin cấu hình; request browser cross-site ghi dữ liệu mà không có Origin bị từ chối. Swagger dùng cookie security và withCredentials.
- Xác minh cookie Auth: `RUN_DB_TESTS=1 npm test` **45/45 pass**, gồm cookie-only authentication, không lộ token JSON, refresh rotation/replay, cookie production HttpOnly/Secure, CORS/Origin và logout khi access hết hạn. Docker image `roadassist-server:cookie-auth` build thành công.
