# Giai đoạn 7 (Ngày 14): Trò Chuyện Phiên Bản, Đánh Giá 2 Chiều, Khiếu Nại & Kiểm Thử

> **Mục tiêu**: Hoàn thiện các phân hệ vận hành và chăm sóc khách hàng: **Trò chuyện phân tách theo phiên bản (`Versioned Chat`)**, **Đánh giá 2 chiều (`2-Way Ratings`)**, **Khiếu nại bảo vệ quyền lợi 7 ngày (`Disputes`)**, xuất bản tài liệu **Swagger OpenAPI UI**, và kiểm thử tích hợp toàn diện (E2E Integration Testing).

---

## 1. Thiết Kế Mô Hình Dữ Liệu (Models & Schemas)

### 1.1 Model Trò Chuyện Hiện Trường (`ChatRoom` & `ChatMessage`) — `src/models/chat.model.js`

```javascript
const { DataTypes } = require("sequelize");
const sequelize = require("../config/postgres.config");

const ChatRoom = sequelize.define(
  "ChatRoom",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    // Scope: DISPATCH (Theo phiếu cứu hộ) hoặc HAZARD (Theo sự cố giao thông)
    scope: {
      type: DataTypes.ENUM("DISPATCH", "HAZARD"),
      allowNull: false,
    },
    referenceId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "reference_id", // ticketId hoặc flagId
    },
    // Phiên bản chat: Tăng lên khi đổi tài xế để bảo mật riêng tư
    version: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
      allowNull: false,
    },
    isArchived: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      field: "is_archived", // Khóa chỉ đọc khi phiếu kết thúc hoặc chuyển sang phiên bản mới
    },
  },
  { tableName: "chat_rooms", timestamps: true }
);

const ChatMessage = sequelize.define(
  "ChatMessage",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    roomId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "room_id",
    },
    senderId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "sender_id",
    },
    senderRole: {
      type: DataTypes.STRING(20),
      allowNull: false, // RIDER, PROVIDER, SYSTEM
      field: "sender_role",
    },
    content: {
      type: DataTypes.STRING(1000),
      allowNull: true,
    },
    images: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: [], // Tối đa 3 ảnh đính kèm
    },
    systemEvent: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: "system_event", // STATUS_CHANGED, UNFIXABLE, TOW_OFFER...
    },
  },
  { tableName: "chat_messages", timestamps: true }
);

module.exports = { ChatRoom, ChatMessage };
```

### 1.2 Model Đánh Giá 2 Chiều (`Rating`) — `src/models/rating.model.js`
- **Khách đánh giá Đối tác (`targetKind: "SHOP"`)**: Điểm từ 1 – 5 sao kèm nhận xét tối đa 280 ký tự. Cho phép người dùng chỉnh sửa (upsert).
- **Đối tác đánh giá lại Khách (`targetKind: "RIDER"`)**: Điểm sao trung bình của khách sẽ được hiển thị cho các thợ/tài xế khác ở các cuốc sau.
- **Phản hồi đánh giá (`replyContent`)**: Cho phép bên được đánh giá viết 1 phản hồi hiển thị bên dưới.

### 1.3 Model Khiếu Nại & Trọng Tài Admin (`Dispute`) — `src/models/dispute.model.js`

```javascript
const { DataTypes } = require("sequelize");
const sequelize = require("../config/postgres.config");

const Dispute = sequelize.define(
  "Dispute",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    ticketId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "ticket_id",
    },
    claimantId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "claimant_id", // Người khiếu nại (Rider hoặc Provider)
    },
    respondentId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "respondent_id",
    },
    reason: {
      type: DataTypes.STRING(50),
      allowNull: false, // LATE, NO_SHOW, OVERCHARGE, UNSAFE, RUDE, POOR_QUALITY...
    },
    note: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    evidenceImage: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "evidence_image",
    },
    status: {
      type: DataTypes.ENUM("OPEN", "RESOLVED", "REJECTED"),
      defaultValue: "OPEN",
    },
    adminResolution: {
      type: DataTypes.ENUM("FAVOR_RIDER", "FAVOR_PROVIDER", "PARTIAL_REFUND", "NO_ACTION"),
      allowNull: true,
      field: "admin_resolution",
    },
    adminNote: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "admin_note",
    },
  },
  { tableName: "disputes", timestamps: true }
);

module.exports = Dispute;
```

---

## 2. Quy Tắc Nghiệp Vụ Vận Hành

### 2.1 Bảo Mật Phòng Chat Theo Phiên Bản (`Versioned Chat`)
- Khi một tài xế xe kéo hoặc thợ hủy cuốc giữa chừng và hệ thống điều phối sang đối tác mới:
  - Máy chủ tự động tăng `chatVersion` trên phiếu cứu hộ.
  - Tạo một phòng chat `ChatRoom` mới toanh tương ứng với version mới.
  - Đối tác mới **không thể đọc tin nhắn trao đổi riêng tư của đối tác trước đó**.
  - Các bên tham gia trước đó vẫn xem lại được phòng cũ ở trạng thái **Đã lưu trữ — chỉ đọc (`isArchived = true`)**.

### 2.2 Thời Hạn Khiếu Nại 7 Ngày & Hiệu Lực Đóng Băng Tiền (`Dispute Hold`)
1. **Cửa sổ thời gian khiếu nại (`DISPUTE_WINDOW_MS`)**:
   - Khách hàng chỉ được quyền gửi khiếu nại trong vòng **7 ngày** kể từ thời điểm cuốc cứu hộ được xác nhận hoàn thành (`status = "4" RESOLVED`). Quá 7 ngày, hệ thống từ chối tiếp nhận với mã lỗi `DISPUTE_WINDOW_EXPIRED`.
2. **Hiệu lực Đóng băng Tiền (`disputeHold = true`)**:
   - Ngay khi có khiếu nại mở (`OPEN`), hệ thống **lập tức tạm dừng mọi lệnh giải ngân đối soát (Payout)** liên quan đến cuốc cứu hộ đó.
   - Quản trị viên (`Admin`) là người duy nhất có thẩm quyền xem xét bằng chứng và đưa ra phán quyết (`adminResolution`):
     - `FAVOR_RIDER`: Hoàn tiền tạm giữ lại cho khách hàng.
     - `FAVOR_PROVIDER`: Tiếp tục giải ngân cho đối tác.
     - `PARTIAL_REFUND`: Hoàn một phần chi phí và chi trả phần còn lại.

---

## 3. Đặc Tả Danh Sách Endpoints (API Contracts)

### 3.1 Phân hệ Trò Chuyện & Tin Nhắn (`/api/v1/chat`)
| Method | Endpoint | Mô Tả Nghiệp Vụ | Phân Quyền |
|---|---|---|---|
| `GET` | `/api/v1/chat/:scope/:referenceId` | Lấy tin nhắn phòng chat hiện tại (tự động lọc theo version mới nhất) | Rider / Provider liên quan |
| `POST` | `/api/v1/chat/:scope/:referenceId/messages` | Gửi tin nhắn mới (chữ tối đa 1000 ký tự, tối đa 3 ảnh đính kèm) | Thành viên trong phòng |
| `GET` | `/api/v1/chat/:scope/:referenceId/history` | Xem lại các phòng chat cũ đã lưu trữ của các đối tác trước | Chủ đơn / Đối tác cũ |

### 3.2 Phân hệ Đánh Giá & Phản Hồi (`/api/v1/ratings`)
| Method | Endpoint | Mô Tả Nghiệp Vụ | Phân Quyền |
|---|---|---|---|
| `POST` | `/api/v1/ratings` | Gửi đánh giá 1 – 5 sao và nhận xét sau khi hoàn thành cuốc | Khách hoặc Đối tác cuốc đó |
| `POST` | `/api/v1/ratings/:id/reply` | Viết phản hồi cho nhận xét của đối phương | Bên được đánh giá |
| `GET` | `/api/v1/ratings/provider/:providerId` | Xem danh sách đánh giá công khai của tiệm sửa xe / xe kéo | Public / Auth |

### 3.3 Phân hệ Khiếu Nại (`/api/v1/disputes`)
| Method | Endpoint | Mô Tả Nghiệp Vụ | Phân Quyền |
|---|---|---|---|
| `POST` | `/api/v1/disputes` | Gửi khiếu nại cuốc cứu hộ (Kiểm tra trong hạn 7 ngày, đóng băng tiền) | Rider / Provider |
| `GET` | `/api/v1/disputes/my-disputes` | Xem danh sách khiếu nại của cá nhân | Cookie `road_as_token` |
| `GET` | `/api/v1/admin/disputes` | Quản trị viên xem toàn bộ danh sách khiếu nại đang chờ xử lý | Admin (`role=admin`) |
| `PUT` | `/api/v1/admin/disputes/:id/resolve` | Phán quyết khiếu nại và gỡ bỏ đóng băng tài chính | Admin (`role=admin`) |

---

## 4. Kế Hoạch Push Commit Chi Tiết

### Đợt 14 (Ngày 14) — `feat(chat-dispute-test)`: Chat Phiên Bản, Đánh Giá, Khiếu Nại & Swagger UI
- **Mục tiêu**: Xây dựng xong phân hệ Chat, Rating, Dispute, hoàn thiện tài liệu Swagger UI OpenAPI, và kiểm tra kịch bản kiểm thử E2E từ đầu đến cuối.
- **Các bước thực hiện**:
  1. Tạo models `ChatRoom`, `ChatMessage`, `Rating`, `Dispute`.
  2. Xây dựng dịch vụ và API trò chuyện phiên bản bảo mật và đánh giá 2 chiều.
  3. Viết API khiếu nại có cơ chế đóng băng tiền `disputeHold` và phán quyết Admin.
  4. Cập nhật JSDoc Swagger đầy đủ cho toàn bộ các endpoint tại `src/config/swagger.config.js`.
  5. Chạy test kịch bản luồng E2E: Đăng ký tài khoản → Tạo xe → Báo sự cố → Gọi cứu hộ SOS/TOW → Thanh toán SePay Webhook → Nghiệm thu hoàn thành → Đánh giá đối tác.
- **Git Commit Message**:
  ```text
  feat(chat-dispute-test): implement versioned chat, 2-way ratings, 7-day disputes and swagger documentation
  ```


## Triển khai sớm phân hệ Chat

Chat đã được hợp nhất với hazard Phase 4 bằng ChatRoom/ChatMessage/ChatParticipant, có phiên riêng khi đổi đối tác, lịch sử chỉ đọc theo thành viên, ảnh S3 public trong roadassist/, HTTP và Socket.IO chung xác thực cookie, idempotency và quota. Swagger được tách vào src/swagger/.

Chi tiết tích hợp Dispatch Phase 5: [CHAT_AND_STORAGE.md](../CHAT_AND_STORAGE.md). Dispatch production đã được nối ở Phase 5; ratings, disputes và payment E2E vẫn thuộc các giai đoạn tương ứng.

### Tích hợp tài chính đã có sau Phase 6

Khi mở dispute, khóa ticket và đặt disputeHold=true trong cùng transaction. Payout kiểm tra hold ở cả tạo lô và settle; mặc định chỉ đối soát sau 7 ngày. Khi thay đổi nghĩa vụ tiền, dùng BillService.syncJourney theo cùng thứ tự khóa và tôn trọng reservation/đã settle; không tự sửa BillPayment hay giải ngân/hoàn tiền chỉ bằng cờ trạng thái. Đọc [BILLING_AND_PAYMENTS.md](../BILLING_AND_PAYMENTS.md).
