# Dữ liệu demo cũ — không tự nạp

Server hiện chỉ seed một tài khoản admin; không tự tạo khách, đối tác, phương tiện, cuốc cứu hộ, hóa đơn hay thanh toán mock. Bộ fixture bên dưới chỉ dành cho các lần chạy test/script chủ động, không phản ánh dữ liệu sau reset thông thường.

Reset development: dừng server, chạy `npm run db:reset`, rồi bật lại. Giữ `DB_FORCE_RESET=false`, `DB_RESET=false`, `SEED_DEMO_DATA=false`.

## Dữ liệu có sẵn

- 4 cuốc sửa tại tiệm hoàn thành, thanh toán SePay mock, hóa đơn và đánh giá; thời gian cuốc được đặt về 2–8 ngày trước để xem biểu đồ.
- 1 cuốc tiệm đã báo giá, có hội thoại khách–tiệm; 1 cuốc SOS đã nhận; 1 cuốc TOW đang chờ.
- 3 cảnh báo giao thông quanh Quận 1, thời hạn 24 giờ, và 2 địa điểm đã lưu cho mỗi tài khoản demo (10 mục tổng cộng).
- SHOP/MOBILE_SHOP hoạt động theo quy trình đăng ký thực; TOW giữ trạng thái PENDING, không giả lập giấy tờ đã duyệt.

Các dữ liệu mới đều có tiền tố `Demo`. Phiếu, hóa đơn, thanh toán mock và chat được tạo qua service thật, không bypass phân quyền. Cuốc và GPS vẫn chịu timeout của hệ thống: chạy lại script để làm mới GPS; tài khoản đối tác có thể bật trực lại trong UI. Script không tự phục hồi một cuốc đã hết hạn/hủy khi được chạy lại.

## Dashboard cũ

Mở **http://localhost:5173/dashboard/classic** sau khi đăng nhập, hoặc chọn **Dashboard cũ** trong menu bản đồ. Bố cục sidebar, thẻ thống kê, biểu đồ và bộ chọn kỳ dùng lại các component dashboard gốc, với dữ liệu RoadAssist theo quyền tài khoản. Các menu nghiệp vụ mở panel tương ứng trên bản đồ; chưa chuyển chúng thành trang bảng riêng trong sidebar.

Bản đồ vẫn ở **`/dashboard`**; có nút chuyển qua lại. Dashboard admin thống kê KPI toàn hệ thống; biểu đồ chỉ tổng hợp 100 cuốc đang mở và 100 cuốc hoàn thành gần nhất. Dashboard tài khoản dùng các cuốc gần nhất do API trả về; không hiển thị dữ liệu giả khi API lỗi.
