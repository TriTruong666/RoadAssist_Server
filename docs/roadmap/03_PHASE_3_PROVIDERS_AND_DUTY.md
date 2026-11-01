# Giai đoạn 3 (Ngày 5 – Ngày 6): Hồ Sơ Đối Tác (Provider), Quản Lý Trực Ca & Nhịp Tim GPS

> **Mục tiêu**: Xây dựng phân hệ Quản lý Đối tác Cứu hộ đường bộ cho 3 loại hình (`SHOP`, `MOBILE_SHOP`, `TOW`), cơ chế xác thực biển số chuẩn Việt Nam, luồng xét duyệt xe kéo dành cho Quản trị viên (`Admin`), quản lý công tắc trực ca (`Duty`), và hệ thống lưu trữ/tìm kiếm tọa độ thời gian thực (Redis GEO Heartbeat).

> **Quy tắc quyền dịch vụ hiện hành:** register/onboard chỉ lưu requestedServices, không cấp services. Khi tạo/duyệt/từ chối/thu hồi/suspend hồ sơ, khóa User và gọi ProviderAccessService.synchronize(user, transaction). Chỉ hồ sơ ACTIVE không suspended mới cấp quyền; MOBILE_SHOP/TOW phải có xe sở hữu đang active, TOW bắt buộc CAR. Sửa thông tin quan trọng của xe đưa hồ sơ đã duyệt về PENDING và tắt duty, kể cả MOBILE_SHOP đã từng được tự duyệt lúc đăng ký lần đầu. Hồ sơ PENDING vì đổi xe phải qua xét duyệt lại trước khi nhận cuốc.

---

## 1. Thiết Kế Mô Hình Dữ Liệu (Models & Geo-Spatial)

### 1.1 Model Đơn Vị Cung Cấp (`Provider`) — `src/models/provider.model.js`

```javascript
const { DataTypes } = require("sequelize");
const sequelize = require("../config/postgres.config");

const Provider = sequelize.define(
  "Provider",
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
    // 3 Loại hình: SHOP (Tiệm cố định), MOBILE_SHOP (Tiệm lưu động SOS), TOW (Xe kéo)
    kind: {
      type: DataTypes.ENUM("SHOP", "MOBILE_SHOP", "TOW"),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(120),
      allowNull: false, // Tên tiệm hoặc tên đội cứu hộ
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    // Liên kết với xe nếu là MOBILE_SHOP hoặc TOW
    vehicleProfileId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "vehicle_profile_id",
    },
    plateNumber: {
      type: DataTypes.STRING(20),
      allowNull: true,
      field: "plate_number",
    },
    licenseNumber: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: "license_number", // Số giấy phép kinh doanh / bằng lái cứu hộ
    },
    // Vị trí cố định (cho SHOP) hoặc điểm xuất phát
    latitude: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    longitude: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    address: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // Cấu hình phục vụ của SHOP: ['SOLO_BIKE', 'CAR']
    serviceSegments: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: ["SOLO_BIKE"],
      field: "service_segments",
    },
    // Giờ mở cửa hàng ngày: { "MON": "08:00-20:00", ... }
    openHours: {
      type: DataTypes.JSONB,
      defaultValue: {},
      field: "open_hours",
    },
    // Trạng thái phê duyệt: ACTIVE (SHOP & MOBILE duyệt ngay), PENDING (TOW chờ admin), DENIED
    status: {
      type: DataTypes.ENUM("ACTIVE", "PENDING", "DENIED"),
      defaultValue: "ACTIVE",
      allowNull: false,
    },
    // Công tắc trực ca: Bật để nhận cuốc
    accepting: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    suspended: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    ratingAvg: {
      type: DataTypes.FLOAT,
      defaultValue: 5.0,
      field: "rating_avg",
    },
    ratingCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: "rating_count",
    },
    lastHeartbeatAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "last_heartbeat_at",
    },
  },
  {
    tableName: "providers",
    timestamps: true,
  }
);

module.exports = Provider;
```

---

## 2. Quy Tắc Nghiệp Vụ Cốt Lõi

### 2.1 Giới Hạn Đăng Ký & Chuẩn Hóa Biển Số
1. **Giới hạn số lượng**: Mỗi tài khoản chỉ được phép sở hữu tối đa **1 `SHOP`**, **1 `MOBILE_SHOP`** và **1 `TOW`** ở trạng thái khác `DENIED`. Nếu bị từ chối (`DENIED`), cho phép người dùng gửi lại đơn mới hoặc cập nhật hồ sơ.
2. **Biển số xe Việt Nam**:
   - Biểu thức chính quy: `/^\d{2}[A-Z0-9]{1,3}\d{4,6}$/`
   - Chuẩn hóa: Loại bỏ khoảng trắng, dấu gạch nối, dấu chấm và viết in hoa toàn bộ (ví dụ: `51A-999.88` → `51A99988`).
3. **Kiểm tra trùng vị trí bán kính 300m**:
   - Khi đăng ký `SHOP` hoặc `MOBILE_SHOP`, hệ thống quét bán kính 300 mét xung quanh tọa độ khai báo. Nếu có tiệm khác đã đăng ký, trả về thông tin cảnh báo kèm danh sách tiệm lân cận để người dùng kiểm tra xác nhận.

### 2.2 Quy Trình Xét Duyệt Xe Cứu Hộ (`TOW`)
- Khác với `SHOP` và `MOBILE_SHOP` được kích hoạt ngay (`ACTIVE`), đối tác đăng ký xe kéo `TOW` bắt buộc phải là xe ô tô `CAR` và ban đầu được gán trạng thái **`PENDING`**.
- Chỉ tài khoản có vai trò **`admin`** mới có quyền gọi API xét duyệt:
  - Phê duyệt (`PUT /api/v1/admin/providers/:id/approve`): Chuyển trạng thái sang `ACTIVE`, tự động bổ sung `"TOW"` vào mảng `services` của user.
  - Từ chối (`PUT /api/v1/admin/providers/:id/deny`): Kèm theo lý do từ chối để đối tác bổ sung giấy tờ.

---

## 3. Quản Lý Trực Ca (`Duty`) & Nhịp Tim Vị Trí (`Location Heartbeats`)

### 3.1 Chính Sách Gửi Tọa Độ
- **Người đi đường (`RIDER`)**: Tuyệt đối **không gửi vị trí nền** lên máy chủ. Tọa độ của rider chỉ gửi khi chủ động tìm đường, tạo phiếu cứu hộ hoặc gửi báo cáo sự cố.
- **Tiệm sửa xe cố định (`SHOP`)**: Không gửi nhịp tim vị trí (vị trí cố định lưu trên bảng `providers`).
- **Thợ lưu động (`MOBILE_SHOP`) & Xe kéo (`TOW`)**:
  - Gửi nhịp tim GPS thông qua API `POST /api/v1/providers/location`:
    - **Ngay lập tức** khi gạt công tắc bật trực ca (`accepting = true`).
    - **Mỗi 5 phút (300,000 ms)** khi rảnh ca và đang mở app.
    - **Mỗi 60 giây (60,000 ms)** khi đang có cuốc cứu hộ (`MATCHED` / `ARRIVED`) hoặc đang bật chế độ dẫn đường.

### 3.2 Tối Ưu Hóa Tìm Kiếm Không Gian Bằng Redis GEO
Nhịp tim GPS của các đối tác đang bật trực ca được lưu trữ đồng thời trên Postgres (lịch sử) và **Redis Geospatial Index** để tìm kiếm siêu tốc:
- Key Redis: `geo:providers:active`
- Lệnh Redis:
  ```text
  GEOADD geo:providers:active <longitude> <latitude> <providerId>
  ```
- Kèm theo hash lưu metadata: `provider:duty:<providerId>` gồm `kind`, `accepting`, `updatedAt`.
- TTL độ tươi vị trí: **15 phút**. Khi tìm đối tác cứu hộ trong bán kính 15 km, hệ thống chỉ lọc các đối tác có nhịp tim trong vòng 15 phút gần nhất.

---

## 4. Đặc Tả Danh Sách Endpoints (API Contracts)

### 4.1 Phân hệ Đối Tác Cứu Hộ (`/api/v1/providers`)
| Method | Endpoint | Mô Tả Nghiệp Vụ | Phân Quyền |
|---|---|---|---|
| `POST` | `/api/v1/providers` | Đăng ký hồ sơ đối tác mới (`SHOP`, `MOBILE_SHOP`, `TOW`) | Cookie `road_as_token` |
| `GET` | `/api/v1/providers/me` | Lấy danh sách các giấy phép/hồ sơ đối tác của tài khoản hiện tại | Cookie `road_as_token` |
| `GET` | `/api/v1/providers/:id` | Xem chi tiết hồ sơ đối tác và đánh giá | Public / Auth |
| `PUT` | `/api/v1/providers/:id` | Cập nhật thông tin tiệm (tên, giờ mở cửa, số điện thoại, phân khúc) | Owner (`provider`) |
| `POST` | `/api/v1/providers/:id/toggle-duty` | Bật/tắt công tắc trực ca (`accepting`). Chặn nếu đang `PENDING`/`DENIED` | Owner (`provider`) |
| `POST` | `/api/v1/providers/location` | Bắn nhịp tim vị trí GPS (`latitude`, `longitude`, `speed`, `accuracy`) | Active `MOBILE`/`TOW` |
| `POST` | `/api/v1/providers/:id/revoke` | Thu hồi giấy phép đối tác (giữ nguyên hồ sơ xe) | Owner / Admin |
| `POST` | `/api/v1/providers/search` | Tìm kiếm tiệm sửa xe trong bán kính (50km, lọc sao, lọc `accepting`) | Public / Rider |

### 4.2 Phân hệ Quản Trị Xét Duyệt (`/api/v1/admin/providers`)
| Method | Endpoint | Mô Tả Nghiệp Vụ | Phân Quyền |
|---|---|---|---|
| `GET` | `/api/v1/admin/providers/pending-tows` | Lấy danh sách xe cứu hộ `TOW` đang chờ phê duyệt biển số & giấy phép | Admin (`role=admin`) |
| `PUT` | `/api/v1/admin/providers/:id/approve` | Phê duyệt xe cứu hộ `TOW` (`PENDING` → `ACTIVE`) | Admin (`role=admin`) |
| `PUT` | `/api/v1/admin/providers/:id/deny` | Từ chối đơn đăng ký xe cứu hộ kèm lý do | Admin (`role=admin`) |
| `PUT` | `/api/v1/admin/providers/:id/suspend` | Đình chỉ hoạt động đối tác vi phạm quy chế | Admin (`role=admin`) |

---

## 5. Kế Hoạch Push Commit Chi Tiết

### Đợt 5 (Ngày 5) — `feat(provider)`: Đăng ký Đối tác, Chuẩn hóa Biển số & Admin Duyệt TOW
- **Mục tiêu**: Xây dựng Model `Provider`, logic đăng ký 3 loại hình, kiểm tra trùng tiệm lân cận 300m và hệ thống xét duyệt của Quản trị viên.
- **Các bước thực hiện**:
  1. Tạo `src/models/provider.model.js` và thiết lập quan hệ với `User` & `VehicleProfile`.
  2. Viết helper chuẩn hóa biển số Việt Nam regex `/^\d{2}[A-Z0-9]{1,3}\d{4,6}$/` trong `src/utils/plate.util.js`.
  3. Xây dựng `src/services/provider.service.js` với phương thức `registerProvider`, kiểm tra giới hạn 1 tiệm/loại xe và quét trùng bán kính 300m.
  4. Viết controller và routes cho đối tác và admin (`/api/v1/admin/providers`).
- **Git Commit Message**:
  ```text
  feat(provider): implement provider models, 3-category registration, vn plate validator and admin tow approval flow
  ```

### Đợt 6 (Ngày 6) — `feat(duty)`: Quản lý Trực ca & Nhịp tim GPS với Redis GEO
- **Mục tiêu**: Hoàn thiện công tắc trực ca (`Duty`), API gửi nhịp tim vị trí GPS nền, lưu trữ Redis Geospatial và truy vấn tiệm sửa xe quanh đây.
- **Các bước thực hiện**:
  1. Cấu hình Redis GEO trong `src/services/location.service.js` (`GEOADD`, `GEOSEARCH`).
  2. Xây dựng API `POST /api/v1/providers/location` ghi nhận GPS và cập nhật `lastHeartbeatAt`.
  3. Viết API `POST /api/v1/providers/:id/toggle-duty` kiểm tra điều kiện kích hoạt.
  4. Xây dựng API `POST /api/v1/providers/search` hỗ trợ tìm tiệm bán kính 50 km, lọc tiệm đang mở ca (`acceptingOnly`).
- **Git Commit Message**:
  ```text
  feat(duty): implement provider duty toggle, background gps heartbeat tracking and redis geo spatial search
  ```



---

## 6. Kết quả triển khai

- Models Provider và ProviderLocationHistory đã đăng ký thật với associations User/VehicleProfile; có partial unique index ngăn trùng hồ sơ khác DENIED theo owner/kind.
- Đủ 12 endpoint trong roadmap, bổ sung GET /api/v1/admin/providers/pending để admin xử lý cả MOBILE_SHOP chờ duyệt lại; tất cả quyền người dùng dùng cookie road_as_token.
- SHOP/MOBILE_SHOP lần đầu được ACTIVE sau validation; TOW PENDING và phải có CAR, biển số khớp xe, licenseNumber trước khi duyệt. Request không thể tự gán status/suspended/services/rating.
- Cảnh báo 300m trả HTTP 409 kèm details.nearby; confirmNearby=true để xác nhận. Không dùng GPS mobile tắt ca/cũ trong cảnh báo vị trí.
- Owner quản lý hồ sơ đang chờ/denied mà không cần có role provider trước; quyền nhận cuốc vẫn chỉ lấy từ hồ sơ ACTIVE, không suspended và xe hợp lệ.
- Admin approve/deny/suspend/resume, owner/admin revoke, resubmit DENIED; lưu reason/reviewer/timestamp. Không thể né đình chỉ bằng revoke rồi tạo mới. Lịch sử cần duyệt lại không được tự ACTIVE qua đăng ký mới.
- Owner mutation đổi role sẽ set cookie phiên mới; admin mutation có thể khiến owner phải đăng nhập lại bằng mật khẩu khi sessionVersion thay đổi.
- Bật ca lưu động phải gửi GPS ngay; SHOP không heartbeat. Giờ mở cửa hỗ trợ qua đêm nhưng chỉ là thông tin, accepting là điều kiện nhận mới.
- GPS lưu lịch sử PostgreSQL; GEO/metadata Redis atomic, freshness 900 giây, version chống callback cũ, sync sau commit. Có fallback SQL khi mất/lỗi cache và cron reconcile/prune mỗi phút, dừng cron khi shutdown.
- Search bán kính tối đa 50km, lọc kind/rating/duty, sort distance/rating. Public DTO ẩn license, reviewer, userId và tọa độ mobile tắt ca/cũ; owner inactive bị loại ngay cả khi Redis còn dữ liệu mới.
- Chặn sửa hồ sơ/xe hoặc thu hồi giấy phép khi có cuốc mở. Model DispatchTicket đầy đủ vẫn thuộc Phase 5; hiện test dùng ticket fixture để kiểm chứng ràng buộc. Tắt ca không thu hồi giấy phép; heartbeat của cuốc đang chạy khi tắt ca chỉ lưu riêng tư, không public GEO.
- Quy tắc TOW thiếu license: được lưu draft hồ sơ PENDING, nhưng admin chưa được approve cho đến khi bổ sung số giấy phép.
- README và Swagger mô tả 13 operations cùng payload, cookie, cảnh báo vị trí và lifecycle duyệt lại.
- Xác minh: `RUN_DB_TESTS=1 npm test` **70/70 pass**, không skip; bao gồm regression Auth/cookie/xe và PostgreSQL/Redis thật cho Provider/Duty. Fixture DispatchTicket nằm trong schema test riêng, không tạo model ticket production trước Phase 5.
- `npm run dev` khởi động trên cổng 9898; `/health` trả HTTP 200 với PostgreSQL/Redis Connected, `/api-docs/` HTTP 200, POST `/api/v1/providers/search` hoạt động trên schema local thật.
- Docker image `roadassist-server:phase3` build thành công; import runtime Node 20 và Swagger (33 operations kể cả health) thành công.
