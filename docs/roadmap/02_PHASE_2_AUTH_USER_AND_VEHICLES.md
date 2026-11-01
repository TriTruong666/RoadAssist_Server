# Giai đoạn 2 (Ngày 3 – Ngày 4): Xác Thực (Auth), Phân Quyền 3 Roles & Quản Lý Phương Tiện

> **Mục tiêu**: Tái hiện toàn bộ logic bảo mật mạnh mẽ từ `Picare_Core_Server` thành phiên bản độc lập trong `RoadAssist_Server`: Hệ thống xác thực JWT kèm `sessionVersion`, rate limiter chống brute-force bằng Redis Lua script, xác thực OTP qua Mail, quản lý 3 Roles (`admin`, `guest`, `provider`), và phân hệ Quản lý Hồ sơ Phương tiện (`VehicleProfile` & `RideConfig`) phục vụ toàn bộ nền tảng Web.

> [!IMPORTANT]
> **Quy định Kiến trúc Xác thực & Nền tảng Vận hành**:
> - **100% Vận hành trên Nền tảng Web (Web Application / Web Platform)**: Toàn bộ tương tác của cả 3 đối tượng (Admin trên Web Quản trị, Khách hàng Rider trên Web App, Đối tác Provider trên Web Cứu hộ) đều chạy hoàn toàn trên trình duyệt Web, **tuyệt đối không có ứng dụng di động native**.
> - **Tuyệt đối KHÔNG sử dụng Firebase Auth hay Firebase SDK**: Toàn bộ dữ liệu tài khoản, mật khẩu băm (`bcrypt`), phiên đăng nhập, `sessionVersion`, IP tin cậy và `webPushToken` đều được lưu trữ và truy vấn trực tiếp trên cơ sở dữ liệu **PostgreSQL thông qua Sequelize ORM (`src/config/postgres.config.js`)**.
> - Phía Web Application sẽ gọi trực tiếp các API xác thực chuẩn RESTful của RoadAssist Server (`/api/v1/auth/login`, `/api/v1/auth/register`...) và sử dụng Bearer JWT Token do chính máy chủ cấp phát.

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
    trustedIpRecords: {
      type: DataTypes.JSONB,
      defaultValue: [],
      field: "trusted_ip_records",
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

### 2.3 Login Verification (OTP Challenge) & Mail Service
- `src/services/login_verification.service.js`:
  - Sinh mã OTP 6 chữ số ngẫu nhiên lưu trong Redis hash (`auth:challenge:<id>`) với TTL 5 phút.
  - Tối đa 3 lần nhập sai; vượt quá số lần tự động hủy challenge.
  - Chống replay attack và kiểm tra đúng IP yêu cầu.
- `src/services/mail.service.js`:
  - Cấu hình SMTP Nodemailer gửi template mã OTP và thông báo cảnh báo đăng nhập lạ.

### 2.4 Auth Service Độc Lập — `src/services/auth.service.js`
- `register({ email, password, phone, name })`:
  - Kiểm tra trùng lặp email và số điện thoại.
  - Gán role mặc định `"guest"`, mảng services `["RIDER"]`.
  - Sinh JWT và trả về phiên làm việc.
- `registerProvider({ email, password, phone, name, providerKind })`:
  - Tạo tài khoản với role `"provider"`, mảng services khởi tạo `["RIDER", providerKind]`.
- `login({ email, password, ipAddress, userAgent })`:
  - Kiểm tra rate limit.
  - Đối chiếu mật khẩu (`user.comparePassword`).
  - Kiểm tra IP tin cậy: Nếu là IP mới, kích hoạt luồng OTP (hoặc bypass theo cấu hình).
  - Cập nhật `loginIp`, `loginAt`, reset rate limiter khi đăng nhập thành công.
- `completeLogin(...)`: Ghi nhận IP tin cậy và cấp token.

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
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

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
| `POST` | `/api/v1/auth/login` | Đăng nhập hệ thống, kiểm tra rate limit & IP verification | Public |
| `POST` | `/api/v1/auth/verify-otp` | Xác thực mã OTP thử thách khi phát hiện IP mới | Public |
| `POST` | `/api/v1/auth/refresh-token` | Làm mới JWT token bằng refresh token | Public |
| `POST` | `/api/v1/auth/logout` | Đăng xuất, ghi nhận `logoutAt` và xóa session cookie | Bearer Token |
| `POST` | `/api/v1/auth/forgot-password` | Gửi email yêu cầu đặt lại mật khẩu | Public |
| `POST` | `/api/v1/auth/reset-password` | Đặt lại mật khẩu mới thông qua token/OTP | Public |

### 4.2 Phân hệ Người Dùng & Onboarding (`/api/v1/users`)
| Method | Endpoint | Mô Tả Nghiệp Vụ | Phân Quyền |
|---|---|---|---|
| `GET` | `/api/v1/users/me` | Lấy thông tin cá nhân, vai trò, mảng `services`, và xe `activeVehicle` | Bearer Token |
| `PUT` | `/api/v1/users/me` | Cập nhật thông tin hiển thị (`name`, avatar) | Bearer Token |
| `PUT` | `/api/v1/users/onboard` | Hoàn thành Onboarding Wizard chọn vai trò và cấu hình ban đầu | Bearer Token |
| `PUT` | `/api/v1/users/active-vehicle` | Chọn 1 xe làm `activeVehicle` dùng cho định tuyến & gọi cứu hộ | Bearer Token (`RIDER`) |

### 4.3 Phân hệ Phương Tiện (`/api/v1/vehicles`)
| Method | Endpoint | Mô Tả Nghiệp Vụ | Phân Quyền |
|---|---|---|---|
| `GET` | `/api/v1/vehicles` | Lấy danh sách hồ sơ xe của người dùng hiện tại kèm cấu hình tải | Bearer Token (`RIDER`) |
| `POST` | `/api/v1/vehicles` | Tạo hồ sơ xe mới (`type`, `plateNumber`, `width`, `height`), tự gắn `SOLO` | Bearer Token (`RIDER`) |
| `PUT` | `/api/v1/vehicles/:id` | Sửa thông số xe và cấu hình tải trọng (`RideConfig`) | Bearer Token (`RIDER`) |
| `DELETE` | `/api/v1/vehicles/:id` | Xóa xe (Cảnh báo: Nếu đang liên kết `TOW` hoặc `MOBILE_SHOP`, tự động thu hồi giấy phép) | Bearer Token (`RIDER`) |

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

