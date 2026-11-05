# Onboarding và ảnh phương tiện

Client `/setup` bắt đầu bằng hai card Người đi đường / Đối tác.

- Người đi đường: đọc hướng dẫn bản đồ, tìm đường, cứu hộ, thanh toán, nghiệm thu và cảnh báo; gọi `PUT /users/onboard` với `requestedServices: ["RIDER"]`. Không tạo hoặc bắt chọn phương tiện khi onboarding.
- Đối tác: 4 bước hồ sơ cá nhân → loại đối tác và card phương tiện → thông tin hoạt động → hướng dẫn, bảng phí và hoàn tất.
- SHOP không bắt buộc đăng ký xe. MOBILE_SHOP/TOW chọn xe hoạt động và tải ảnh ở bước 2; TOW chỉ chọn CAR.

## API

`POST /api/v1/vehicles/:id/photo` nhận multipart trường `file`, yêu cầu đăng nhập, sở hữu xe và xe không đang bận. Ảnh JPEG/PNG/WebP tối đa 5MB được giải mã, nén và lưu qua S3 service. API trả `{id, url}` của asset. Thay ảnh chỉ xóa ảnh cũ sau khi upload và transaction mới thành công; xóa xe dọn asset liên quan. `GET /vehicles` trả thêm `photo: {id, url} | null`.

`POST /api/v1/providers/:id/documents` vẫn nhận multipart giấy tờ. Với `documentType: "VEHICLE_PHOTO"`, có thể gửi JSON `{documentType, assetId}` để dùng ảnh đã tải cho xe đang liên kết. Service kiểm tra đúng chủ sở hữu, đúng phương tiện, đọc ảnh từ storage và dùng lại toàn bộ kiểm tra fingerprint, trùng bằng chứng và thẩm định hiện có. Bản ảnh chứng từ được lưu độc lập để thay ảnh xe không làm mất chứng từ. Wizard dùng nhánh này cho TOW; MOBILE_SHOP lưu ảnh trên hồ sơ phương tiện và giữ luồng cấp quyền đăng ký thông thường.

Các trường `baseWidth`, `baseHeight`, `length`, `weightKg` ở API tạo/cập nhật xe chấp nhận `null`. Chiều rộng/cao được model điền mặc định theo BIKE/CAR; chiều dài/khối lượng có thể lưu null. Các thao tác cần thông số thực tế, như yêu cầu kéo xe, vẫn kiểm tra riêng trước khi thực hiện.

`GET /api/v1/users/setup-guide` chỉ trả allowlist cấu hình phí hiện hành: SOS call-out/per-km, TOW base/per-km, waiting/minute và commission rate. Không trả cấu hình tài khoản ngân hàng, khóa hoặc các cài đặt nội bộ. Giá sửa chữa do đối tác báo trong cuốc; bảng hướng dẫn không phải báo giá trọn gói.

## Kiểm tra

- Test auth/vehicle: null specs, xóa thông số đã lưu, upload/list ảnh, từ chối upload lên xe của người khác, phí đọc đúng cấu hình.
- Browser integration: Người đi đường hoàn tất mà không có xe; thêm xe bằng card; ảnh ở bước 2; hồ sơ TOW khôi phục đúng khi quay lại setup; duyệt/từ chối và các luồng cứu hộ liên quan.
