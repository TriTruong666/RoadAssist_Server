# Giai đoạn 5 (Ngày 9 – Ngày 11): Điều Phối Cứu Hộ Đa Phương Thức (Dispatch & Assist)

> **Mục tiêu**: Xây dựng phân hệ nghiệp vụ cốt lõi và phức tạp nhất của RoadAssist: Điều phối cứu hộ đường bộ với **15 Trạng thái (`DISPATCH_STATUS`)**, quản lý xung đột xe đang bận (`HTTP 409`), xử lý 3 luồng dịch vụ chuyên biệt (**Sửa tại tiệm cố định `WALK_IN`**, **Cấp cứu SOS lưu động `MOBILE_SHOP`**, **Xe kéo cứu hộ `TOW`**), cơ chế đếm giờ tính phí chờ (`Waiting Fee`), và chuyển giao tự động khi không sửa được (`Handoff & Retarget`).

---

## 1. Thiết Kế Mô Hình Dữ Liệu (Models & Schemas)

### 1.1 Model Phiếu Cứu Hộ (`DispatchTicket`) — `src/models/dispatch_ticket.model.js`

```javascript
const { DataTypes } = require("sequelize");
const sequelize = require("../config/postgres.config");

const DispatchTicket = sequelize.define(
  "DispatchTicket",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    code: {
      type: DataTypes.STRING(20),
      allowNull: false,
      unique: true, // Mã phiếu hiển thị: RA-SOS-10023, RA-TOW-10024...
    },
    journeyId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "journey_id", // Gom các cuốc liên quan vào 1 hành trình thanh toán
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "user_id", // Khách gọi cứu hộ (Rider)
    },
    vehicleProfileId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "vehicle_profile_id", // Xe gặp sự cố (Bắt buộc)
    },
    providerId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "provider_id", // Đối tác nhận cuốc
    },
    // 3 Phương thức: WALK_IN (Tại tiệm), SOS (Thợ lưu động), TOW (Xe kéo)
    type: {
      type: DataTypes.ENUM("WALK_IN", "SOS", "TOW"),
      allowNull: false,
    },
    // 15 Trạng thái chuẩn
    status: {
      type: DataTypes.ENUM(
        "1",  // PENDING
        "2",  // MATCHED
        "3",  // ARRIVED
        "4",  // RESOLVED
        "5",  // CANCELLED
        "6",  // IN_PROGRESS
        "7",  // READY
        "8",  // DECLINED
        "9",  // QUOTED
        "10", // IN_SHOP
        "11", // FINAL_QUOTED
        "12", // RESOLVED_UNFIXABLE
        "13", // ESTIMATED
        "14", // EST_APPROVED
        "15"  // UNFIXABLE
      ),
      defaultValue: "1",
      allowNull: false,
    },
    // Tọa độ đón khách / Điểm gặp sự cố
    pickupLatitude: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      field: "pickup_latitude",
    },
    pickupLongitude: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      field: "pickup_longitude",
    },
    pickupAddress: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: "pickup_address",
    },
    // Điểm giao xe (Bắt buộc đối với cuốc TOW)
    dropoffLatitude: {
      type: DataTypes.DOUBLE,
      allowNull: true,
      field: "dropoff_latitude",
    },
    dropoffLongitude: {
      type: DataTypes.DOUBLE,
      allowNull: true,
      field: "dropoff_longitude",
    },
    dropoffAddress: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: "dropoff_address",
    },
    dropoffShopId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "dropoff_shop_id", // Tiệm sửa xe đích tiếp nhận
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    images: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: [], // Tối đa 5 ảnh sự cố
    },
    // Chi phí & Báo giá
    callOutFee: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
      field: "call_out_fee",
    },
    travelFee: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
      field: "travel_fee",
    },
    quoteAmount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      field: "quote_amount", // Báo giá sửa chữa ràng buộc 1 lần duy nhất
    },
    waitingFee: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
      field: "waiting_fee", // Phí chờ xe kéo tại điểm đón
    },
    totalAmount: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
      field: "total_amount",
    },
    // Đếm giờ chờ xe kéo
    arrivedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "arrived_at", // Mốc thời gian xe kéo đến <= 200m
    },
    waitingMinutes: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: "waiting_minutes",
    },
    // Lý do hủy hoặc báo không sửa được
    unfixableReason: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: "unfixable_reason", // NO_PARTS, BEYOND_REPAIR, SAFETY, OTHER
    },
    unfixableImages: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: [],
      field: "unfixable_images",
    },
    cancelReason: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: "cancel_reason",
    },
    formerAssignedShopIds: {
      type: DataTypes.ARRAY(DataTypes.UUID),
      defaultValue: [],
      field: "former_assigned_shop_ids", // Các tài xế / tiệm đã hủy hoặc từ chối
    },
    chatVersion: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
      field: "chat_version", // Tăng version khi đổi đối tác để tách riêng phòng chat
    },
    linkedTicketIds: {
      type: DataTypes.ARRAY(DataTypes.UUID),
      defaultValue: [],
      field: "linked_ticket_ids", // Liên kết phiếu SOS -> TOW -> WALK_IN
    },
  },
  {
    tableName: "dispatch_tickets",
    timestamps: true,
    indexes: [
      { fields: ["user_id", "status"] },
      { fields: ["vehicle_profile_id", "status"] },
      { fields: ["provider_id", "status"] },
    ],
  }
);

module.exports = DispatchTicket;
```

---

## 2. Các Quy Tắc Nghiệp Vụ Điều Phối

### 2.1 Ràng Buộc Xe Bận (`VEHICLE_BUSY` — HTTP 409)
Trước khi tạo bất kỳ phiếu cứu hộ mới nào (`WALK_IN`, `SOS`, `TOW`), hệ thống thực hiện kiểm tra nghiêm ngặt:
- Phương tiện `vehicleProfileId` có đang tồn tại phiếu nào ở trạng thái **chưa kết thúc** (`status NOT IN ('4', '5', '8', '12', '15')`) hay không?
- Nếu có, máy chủ lập tức chặn và trả về lỗi **HTTP 409 Conflict** kèm mã `VEHICLE_BUSY` và ID của phiếu đang chạy. Tuyệt đối không cho phép tạo đè phiếu.

### 2.2 Luồng 1: Sửa Chữa Tại Tiệm Cố Định (`WALK_IN`)
1. **Kiểm tra loại xe**: Chỉ áp dụng cho Xe máy (`SOLO_BIKE`).
2. **Điểm danh "Tôi đã đến" (`checkInAtShop`)**:
   - Khách phải đứng cách tọa độ tiệm **`<= 200m` GPS thực tế**.
   - Tiệm sửa xe phải đang bật trực ca (`accepting = true`) và không bị đình chỉ.
   - Phiếu được khởi tạo ở trạng thái `"1" PENDING`.
3. **Tiếp nhận & Báo giá duy nhất**:
   - Tiệm bấm Nhận việc (`"2" MATCHED`).
   - Tiệm gửi **1 báo giá ràng buộc duy nhất** (`POST /api/v1/dispatch/:id/quote` → `"9" QUOTED`).
4. **Cổng Chặn Thanh Toán (`fundedForApproval`)**:
   - Khách **không thể duyệt báo giá** nếu hóa đơn chưa đảm bảo thanh toán (Trạng thái thanh toán phải là `SEPAY: HELD/CONFIRMED` hoặc `CASH: PENDING/CONFIRMED`).
   - Khi đã nộp tiền tạm giữ, khách mới bấm được Duyệt báo giá để tiệm chuyển sang `"6" IN_PROGRESS`.
5. **Nghiệm thu hoặc Báo không sửa được**:
   - Tiệm sửa xong bấm `"7" READY`. Khách nhận xe nghiệm thu bấm `"4" RESOLVED`.
   - Nếu tiệm không sửa được: Bắt buộc chụp ảnh bằng chứng và chọn lý do → chuyển sang `"15" UNFIXABLE`.
6. **Đề nghị Kéo xe Trả về tận nơi**: Khi tiệm báo `"7" READY`, nếu GPS của khách cách tiệm `> 1 km`, hệ thống cho phép tạo cuốc kéo xe `TOW` đưa xe về vị trí khách.

### 2.3 Luồng 2: Cứu Hộ SOS Lưu Động (`MOBILE_SHOP`)
1. **Phát sóng 15 km**: Hệ thống quét Redis GEO tìm các thợ `MOBILE_SHOP` đang trực ca trong bán kính 15 km và bắn thông báo khẩn cấp (`dispatch-urgent`).
2. **Thợ nhận việc & Di chuyển**: Thợ bấm nhận (`"2" MATCHED`), ứng dụng mở dẫn đường. Khi tới nơi cách khách `<= 200m`, khách hoặc thợ bấm `"3" ARRIVED`.
3. **Cơ cấu Phí Dịch Vụ**:
   - Tổng cước sửa xong = `Phí gọi thợ` + `Phí di chuyển` + `Phí sửa chữa`.
   - **Miễn phí gọi thợ 1 km**: Nếu thợ ở cách khách `<= 1 km` lúc nhận cuốc, `callOutFee` tự động tính là `0 VND`.
4. **Xử lý Không sửa được (`UNFIXABLE` — "15")**:
   - Thợ bắt buộc chụp ít nhất 1 ảnh bằng chứng và chọn lý do.
   - Toàn bộ phí di chuyển và sửa chữa bị hủy bỏ, khách **chỉ thanh toán Phí gọi thợ** (hoặc `0 VND` nếu thuộc diện miễn phí).
   - Mở 2 nhánh cứu viện:
     - **Thợ đề nghị kéo xe**: `DIRECT` (nếu thợ có xe kéo liên kết) hoặc `NETWORK` (phát sóng tìm xe kéo khác).
     - **Chuyển tiếp SOS**: Khách chọn tiếp tục gọi thợ khác; hệ thống sinh phiếu SOS mới kế thừa ảnh hiện trường cũ.

### 2.4 Luồng 3: Cứu Hộ Kéo Xe (`TOW`)
1. **Bắt buộc chọn Điểm Giao Xe**: Khách phải chọn tiệm sửa xe hoặc vị trí hạ xe trước khi phát sóng cuốc kéo trong bán kính 15 km.
2. **Báo giá Sơ bộ từ Tiệm Đích (`Pre-arrival Estimate`)**:
   - Tiệm đích có thể gửi báo giá ước tính (`"13" ESTIMATED`, thời hạn 24h). Khách có quyền chấp nhận (`"14"`) hoặc từ chối để đổi tiệm đích khác.
3. **Đồng hồ Tính Phí Chờ (`Waiting Fee`)**:
   - Kích hoạt khi xe kéo đã đến điểm đón (`<= 200m`) ở trạng thái `"3" ARRIVED`.
   - Miễn phí **10 phút ân hạn đầu tiên**, sau đó tính phí theo từng phút bắt đầu, tối đa không quá **60 phút**.
4. **Tự Động Phục Hồi Khi Tài Xế Hủy Giữa Chừng**:
   - Nếu tài xế xe kéo hủy cuốc ở `"2"` hoặc `"3"` (bắt buộc kèm lý do hủy), hệ thống đưa tài xế đó vào `formerAssignedShopIds` (cấm nhận lại cuốc này) và **tự động đưa cuốc về hàng đợi phát sóng `"1" PENDING"`** để tìm tài xế khác mà khách không phải tạo lại đơn.
5. **Tự động Sinh Phiếu Sửa Xe Khi Hạ Xe**: Khi xe kéo hạ xe tại tiệm đích thành công và hoàn tất cuốc (`"4" RESOLVED`), hệ thống tự động sinh một phiếu `WALK_IN` mới liên kết với cuốc kéo.

---

## 3. Đặc Tả Danh Sách Endpoints (API Contracts)

### 3.1 Phân hệ Điều Phối Cứu Hộ (`/api/v1/dispatch`)
| Method | Endpoint | Mô Tả Nghiệp Vụ | Phân Quyền |
|---|---|---|---|
| `POST` | `/api/v1/dispatch/walk-in` | Tạo phiếu sửa xe tại tiệm (Kiểm tra GPS <= 200m quanh tiệm) | Rider (`activeVehicle`) |
| `POST` | `/api/v1/dispatch/sos` | Phát sóng yêu cầu cứu hộ SOS lưu động bán kính 15 km | Rider (`activeVehicle`) |
| `POST` | `/api/v1/dispatch/tow` | Phát sóng yêu cầu xe kéo cứu hộ kèm điểm giao xe | Rider (`activeVehicle`) |
| `GET` | `/api/v1/dispatch/my-requests` | Lấy danh sách phiếu cứu hộ của khách (lọc active / history) | Rider |
| `GET` | `/api/v1/dispatch/provider-feed` | Bảng nhận việc dành cho đối tác (cuốc đang chờ trong 15 km) | Active Provider |
| `GET` | `/api/v1/dispatch/:id` | Xem chi tiết phiếu cứu hộ, trạng thái, vị trí đối tác, báo giá | Rider / Provider liên quan |
| `POST` | `/api/v1/dispatch/:id/accept` | Đối tác bấm nhận cuốc (`"1" PENDING` → `"2" MATCHED`) | Provider |
| `POST` | `/api/v1/dispatch/:id/arrive` | Xác nhận thợ/xe kéo đã đến điểm đón (`"3" ARRIVED`) | Rider / Provider |
| `POST` | `/api/v1/dispatch/:id/quote` | Tiệm/thợ gửi báo giá ràng buộc chính thức (`"9" QUOTED`) | Assigned Provider |
| `POST` | `/api/v1/dispatch/:id/approve-quote` | Khách duyệt báo giá (Kiểm tra điều kiện đã nộp tiền tạm giữ) | Owner Rider |
| `POST` | `/api/v1/dispatch/:id/ready` | Tiệm/thợ sửa xong, chờ khách nghiệm thu bàn giao (`"7" READY`) | Assigned Provider |
| `POST` | `/api/v1/dispatch/:id/resolve` | Khách nghiệm thu hoàn tất cuốc (`"4" RESOLVED`) | Owner Rider |
| `POST` | `/api/v1/dispatch/:id/unfixable` | Báo không sửa được kèm lý do & >= 1 ảnh bằng chứng (`"15"`) | Assigned Provider |
| `POST` | `/api/v1/dispatch/:id/cancel` | Hủy phiếu cứu hộ theo đúng phân quyền vai trò | Rider / Provider |
| `POST` | `/api/v1/dispatch/:id/tow-offer` | Thợ SOS đề nghị kéo xe cho khách (`DIRECT` hoặc `NETWORK`) | Assigned Provider |

---

## 4. Kế Hoạch Push Commit Chi Tiết

### Đợt 9 (Ngày 9) — `feat(dispatch-walkin)`: Luồng Sửa Xe Tại Tiệm Cố Định & Điểm Danh Đến Nơi
- **Mục tiêu**: Xây dựng Model `DispatchTicket`, logic điểm danh trong bán kính 200m, gửi 1 báo giá ràng buộc, và cổng chặn thanh toán trước khi duyệt giá.
- **Các bước thực hiện**:
  1. Tạo `src/models/dispatch_ticket.model.js` với 15 trạng thái và các trường chi phí/vị trí.
  2. Viết kiểm tra xung đột `VEHICLE_BUSY` trong `src/services/dispatch.service.js`.
  3. Xây dựng API điểm danh `POST /dispatch/walk-in` và gửi báo giá `POST /dispatch/:id/quote`.
  4. Viết logic kiểm tra trạng thái thanh toán tạm giữ khi gọi `POST /dispatch/:id/approve-quote`.
- **Git Commit Message**:
  ```text
  feat(dispatch-walkin): implement walk-in shop dispatch flow, 200m gps check-in, binding quote and escrow approval gate
  ```

### Đợt 10 (Ngày 10) — `feat(dispatch-sos)`: Cứu Hộ SOS Lưu Động, Miễn Phí 1km & Handoff Không Sửa Được
- **Mục tiêu**: Xây dựng luồng SOS phát sóng 15 km, logic miễn phí gọi thợ khi `<= 1km`, xử lý trạng thái `UNFIXABLE` (chỉ tính phí gọi thợ) và cơ chế chuyển giao đề nghị kéo xe.
- **Các bước thực hiện**:
  1. Viết logic phát sóng Redis GEO 15 km và đẩy thông báo realtime qua Socket.io / Push Service cho các thợ lưu động.
  2. Xây dựng API `POST /dispatch/:id/unfixable` bắt buộc ảnh và lý do, tính toán lại chi phí.
  3. Viết API `POST /dispatch/:id/tow-offer` xử lý liên kết xe kéo của thợ hoặc phát sóng mạng lưới.
  4. Viết API tiếp tục sinh phiếu SOS mới khi lần cứu hộ trước không sửa được.
- **Git Commit Message**:
  ```text
  feat(dispatch-sos): implement mobile shop sos emergency dispatch, 1km callout waiver, unfixable evidence and tow handoff
  ```

### Đợt 11 (Ngày 11) — `feat(dispatch-tow)`: Cứu Hộ Xe Kéo, Tính Phí Chờ & Tự Động Phục Hồi Hủy Cuốc
- **Mục tiêu**: Xây dựng luồng xe kéo `TOW`, đồng hồ đếm thời gian tính phí chờ tại điểm đón (miễn 10 phút đầu, tối đa 60 phút), cơ chế tự động tìm xe khác khi tài xế hủy giữa chừng và tự động sinh phiếu sửa tại tiệm khi hạ xe.
- **Các bước thực hiện**:
  1. Xây dựng API tạo cuốc `TOW` bắt buộc chọn điểm giao xe.
  2. Viết logic tính `waitingFee` theo mốc thời gian `arrivedAt` (cron hoặc background worker cập nhật).
  3. Triển khai phương thức hủy cuốc an toàn của tài xế xe kéo: đưa vào `formerAssignedShopIds` và trả cuốc về `"1" PENDING`.
  4. Tự động khởi tạo phiếu `WALK_IN` liên kết khi cuốc `TOW` giao xe thành công tại tiệm đối tác.
- **Git Commit Message**:
  ```text
  feat(dispatch-tow): implement tow dispatch flow, waiting fee timer, auto queue recovery on driver cancel and walk-in spawn
  ```

