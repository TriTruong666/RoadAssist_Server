# Dữ liệu tình huống cho môi trường development

Chạy `npm run seed:scenarios` sau khi server đã tạo bảng. Lệnh này không reset DB, không thay đổi mật khẩu hoặc quyền của tài khoản hiện có, và có thể chạy lại mà không tạo trùng tài khoản, hồ sơ hay yêu cầu.

Mật khẩu chung của **tài khoản mới**: `RoadAssistTest@123`.

| Tài khoản | Tình huống |
| --- | --- |
| `cuahang@scenario.roadassist.test` | Tiệm đang hoạt động, nhận yêu cầu tại tiệm; có phiếu chờ, đã nhận, đang kiểm tra, chờ báo giá, hoàn tất, hủy. |
| `luudong@scenario.roadassist.test` | Thợ lưu động đang hoạt động, đã nhận một yêu cầu SOS. |
| `xekeoduyet@scenario.roadassist.test` | Đối tác xe kéo có hồ sơ chờ thẩm định. |
| `khachhang@scenario.roadassist.test` | Khách có một yêu cầu hoàn tất và một yêu cầu đã hủy. |
| `choduyet@scenario.roadassist.test` | Khách đã thiết lập nhưng tài khoản chưa được duyệt. |
| `chuathietlap@scenario.roadassist.test` | Tài khoản chưa thiết lập, dùng kiểm tra luồng setup. |

Tài khoản khách hiện có được dùng thêm cho các yêu cầu tại tiệm, SOS, xe kéo, ba cảnh báo giao thông và địa điểm đã lưu. Yêu cầu cứu hộ dùng thông tin xe của sự cố, không bắt khách đăng ký phương tiện. Tài khoản đối tác xe kéo hiện có được giữ nguyên ca trực; chủ tài khoản có thể bật ca để thử nhận yêu cầu xe kéo đang chờ.

Seed không tự chạy khi khởi động server hay reset DB. Sau mỗi lần reset, chạy lại lệnh trên nếu cần bộ tình huống này.
