# Dữ liệu demo local

Chạy PostgreSQL/Redis và server local trước, sau đó chạy tại repo server:

```sh
npm run seed:demo
```

Script chỉ chạy ở `development`, PostgreSQL trên localhost và `PAYMENT_GATEWAY_MODE=mock`. Không reset bảng, không thay đổi seed người dùng hiện có, không gửi email hoặc gọi thanh toán ngân hàng. Có thể chạy lại: tài khoản, phương tiện, hồ sơ và cuốc demo được nhận diện để tránh tạo trùng. Tài khoản đã tồn tại không bị đổi mật khẩu. Lần chạy lại bật trực các hồ sơ demo đang ACTIVE và làm mới GPS của thợ lưu động.

Mở **http://localhost:5173/login**. Mật khẩu chung cho các tài khoản mới: **`RoadAssistDemo@123`**.

| Email | Vai trò / giao diện |
| --- | --- |
| `admin@demo.roadassist.test` | Admin: tổng quan hệ thống, điều phối, duyệt đối tác, kiểm duyệt cảnh báo, tài chính |
| `rider@demo.roadassist.test` | Người đi đường: xe, lịch sử và yêu cầu cứu hộ, hóa đơn, địa điểm đã lưu |
| `shop@demo.roadassist.test` | Provider SHOP: tiệm An Tâm, báo giá, chat, đánh giá và doanh thu |
| `mobile@demo.roadassist.test` | Provider MOBILE_SHOP: thợ lưu động đang có cuốc SOS |
| `tow@demo.roadassist.test` | Chủ hồ sơ TOW chờ duyệt; chưa cấp quyền provider khi chưa được thẩm định |

## Dữ liệu có sẵn

- 4 cuốc sửa tại tiệm hoàn thành, thanh toán SePay mock, hóa đơn và đánh giá; thời gian cuốc được đặt về 2–8 ngày trước để xem biểu đồ.
- 1 cuốc tiệm đã báo giá, có hội thoại khách–tiệm; 1 cuốc SOS đã nhận; 1 cuốc TOW đang chờ.
- 3 cảnh báo giao thông quanh Quận 1, thời hạn 24 giờ, và 2 địa điểm đã lưu.
- SHOP/MOBILE_SHOP hoạt động theo quy trình đăng ký thực; TOW giữ trạng thái PENDING, không giả lập giấy tờ đã duyệt.

Các dữ liệu mới đều có tiền tố `Demo`. Phiếu, hóa đơn, thanh toán mock và chat được tạo qua service thật, không bypass phân quyền. Cuốc và GPS vẫn chịu timeout của hệ thống: chạy lại script để làm mới GPS; tài khoản đối tác có thể bật trực lại trong UI. Script không tự phục hồi một cuốc đã hết hạn/hủy khi được chạy lại.

## Dashboard cũ

Mở **http://localhost:5173/dashboard/classic** sau khi đăng nhập, hoặc chọn **Dashboard cũ** trong menu bản đồ. Bố cục sidebar, thẻ thống kê, biểu đồ và bộ chọn kỳ dùng lại các component dashboard gốc, với dữ liệu RoadAssist theo quyền tài khoản. Các menu nghiệp vụ mở panel tương ứng trên bản đồ; chưa chuyển chúng thành trang bảng riêng trong sidebar.

Bản đồ vẫn ở **`/dashboard`**; có nút chuyển qua lại. Dashboard admin thống kê KPI toàn hệ thống; biểu đồ chỉ tổng hợp 100 cuốc đang mở và 100 cuốc hoàn thành gần nhất. Dashboard tài khoản dùng các cuốc gần nhất do API trả về; không hiển thị dữ liệu giả khi API lỗi.
