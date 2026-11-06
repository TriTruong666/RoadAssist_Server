# Bán kính nhận cuốc và đề xuất riêng qua SSE

Provider lưu receiveRadiusKm (nguyên 1–50 km, mặc định 10). POST /api/v1/providers/:id/toggle-duty nhận thêm receiveRadiusKm. Bán kính tính từ tọa độ đáng tin cậy của hồ sơ, không theo điểm người dùng kéo bản đồ. SHOP dùng tọa độ tiệm; đối tác lưu động dùng GPS. Feed, thông báo đối tác và API nhận cuốc cùng kiểm tra phạm vi; cuốc đã nhận vẫn hiện để tiếp tục xử lý dù ra khỏi phạm vi.

Với yêu cầu SOS/TOW chưa có đối tác và không chỉ định trực tiếp, server lọc hồ sơ đang bật, đang hoạt động, còn năng lực tiếp nhận, đúng loại dịch vụ, đúng loại xe/capability/tải kéo, trong bán kính đã chọn, có GPS mới theo policy nhận cuốc. Sau đó xếp khoảng cách tăng dần; bằng nhau ưu tiên hồ sơ tạo trước rồi UUID. Không nới yêu cầu bắt buộc của khách để tìm người gần hơn.

Một cuốc được đề xuất riêng một lần: offeredProviderId và offerExpiresAt (5 phút). Một tài khoản chỉ giữ một đề xuất đang còn hạn, kể cả có nhiều hồ sơ. Advisory lock PostgreSQL tuần tự hóa việc chọn người; khóa ticket trong transaction chặn người khác nhận cuốc đang được giữ. Không gán providerId trước khi đối tác đồng ý. Nếu không có ai đủ điều kiện, cuốc vẫn công khai trong phạm vi cho các đối tác phù hợp.

Từ chối chỉ kết thúc quyền ưu tiên, ghi offerPublicAt và thông báo lại các đối tác phù hợp. Không thêm người từ chối vào formerAssignedShopIds/formerAssignedUserIds: họ vẫn có thể nhận cuốc công khai sau đó. Đây khác thao tác hủy một cuốc đã nhận, vốn vẫn dùng quy tắc loại trừ cũ.

Hết 5 phút, kiểm tra feed/detail/accept coi cuốc là công khai ngay theo thời gian server. Worker mỗi 10 giây lưu offerPublicAt và phát lại thông báo; không đề xuất riêng lần hai. Hệ thống kéo dài hạn chờ khi cần để người được đề xuất có đủ 5 phút. Cuốc công khai vẫn chịu hạn chờ chung của dispatch; không tồn tại vô hạn sau khi hết hạn tìm đối tác.

API:

- GET /api/v1/dispatch/offers/stream: cookie auth, text/event-stream, event `offers` chứa `{items:[summary],feed:[summary]}` (items là đề xuất riêng, feed là yêu cầu trong phạm vi và đúng điều kiện). Snapshot đầu tiên giúp phục hồi sau reconnect; thay đổi trong cùng tiến trình được đẩy sau commit, snapshot kiểm tra lại mỗi 2 giây giúp đồng bộ khi có nhiều tiến trình. Không gửi dữ liệu của tài khoản khác. Cookie/session được kiểm tra lại trên stream; đóng kết nối dọn timer. SSE dùng HTTP credential/CORS hiện có.
- GET /api/v1/dispatch/offers/mine: snapshot cùng cấu trúc, dùng phục hồi/polling dự phòng.
- POST /api/v1/dispatch/:id/reject-offer: chỉ chủ hồ sơ được đề xuất được phép công khai cuốc.
- POST /api/v1/dispatch/:id/accept: API nhận cuốc hiện có; kiểm tra đồng thời quyền ưu tiên, trạng thái, bán kính và năng lực.

Client hiển thị vòng tròn nhận cuốc và badge bán kính, danh sách yêu cầu trợ giúp cho provider. Modal mở khi có đề xuất còn hạn, có đếm ngược, từ chối và vuốt xác nhận nhận cuốc. Chỉ cập nhật trạng thái sau phản hồi server. `alert.wav` phát một lần cho mỗi cặp ticket/offerExpiresAt; bộ nhớ và localStorage chống phát lại khi snapshot/reconnect. Browser có thể chặn âm thanh trước lần tương tác đầu tiên; modal vẫn hiển thị.

Bán kính 10 km là mặc định cho mọi hồ sơ cũ khi sync schema, không reset DB. Không sửa luồng cứu hộ chỉ định trực tiếp hay phiếu tiếp nhận tại tiệm WALK_IN thành đề xuất tự động.
