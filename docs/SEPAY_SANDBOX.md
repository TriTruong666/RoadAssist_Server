# SePay Payment Gateway sandbox

Adapter dùng form checkout ký HMAC-SHA256/base64 trên server và API tra cứu đơn hàng bằng Basic Auth. Secret không được trả về client. Đây là môi trường thử nghiệm, không phát sinh chuyển tiền thật.

## Cấu hình development

```dotenv
PAYMENT_GATEWAY_MODE=sandbox
SEPAY_API_URL=https://pgapi-sandbox.sepay.vn
SEPAY_MERCHANT_ID=<sandbox merchant ID>
SEPAY_SECRET_KEY=<sandbox secret key>
SEPAY_IPN_SECRET=<independent IPN secret>
# Chỉ thêm khi client có URL HTTPS public:
# SEPAY_RETURN_BASE_URL=https://your-client.example.com
```

Khóa IPN được cấu hình riêng trong SePay, không phải merchant secret. Nếu chưa đặt `SEPAY_IPN_SECRET`, adapter dùng `SEPAY_WEBHOOK_TOKEN` hiện có. Restart server sau khi sửa env. Adapter từ chối chạy sandbox ở production, khóa `spsk_live_` và API host sai môi trường. `live` hiện vẫn là adapter chuyển khoản ngân hàng cũ; không phải Payment Gateway production.

## Thử thanh toán khi chưa có URL public

1. Tạo khoản thanh toán SePay từ hóa đơn trên RoadAssist.
2. Bấm **Mở thanh toán SePay Sandbox**, trang thử nghiệm mở ở tab mới.
3. Bấm **Giả lập thanh toán** trên trang SePay sandbox.
4. Quay về RoadAssist, bấm **Kiểm tra giao dịch SePay**.

Server gọi `GET /v1/order/detail/{order_invoice_number}`, kiểm tra mã hóa đơn, VND, số tiền, trạng thái CAPTURED và các giao dịch PAYMENT/APPROVED. Sau đó mới ghi nhận vào ledger hiện có. Khoản tiền được tạm giữ đến khi nghiệm thu; gọi lại hoặc nhận trùng IPN không ghi tiền lần hai. Redirect/return URL không phải bằng chứng thanh toán.

## IPN khi có URL public

Trong cấu hình sandbox SePay, đặt URL:

```text
https://your-server.example.com/api/v1/payments/sepay/ipn
```

Dùng xác thực Secret Key với header `X-Secret-Key` trùng `SEPAY_IPN_SECRET` phía server. Endpoint này không dùng cookie đăng nhập. `ORDER_PAID` vẫn phải được API SePay xác minh; `TRANSACTION_VOID` được đưa vào sự kiện tài chính để kiểm tra, không tự động hoàn tiền. Webhook chuyển khoản cũ `/sepay/webhook` chỉ dùng ở mode `live`.

Chưa có URL HTTPS public thì SePay không gửi IPN tới localhost được; dùng nút kiểm tra giao dịch để đối soát. Sau khi có URL, cần kiểm thử thêm việc SePay gửi IPN trực tiếp.

## Dữ liệu demo và kiểm thử

Auto seed hỗ trợ cả mode mock và sandbox. Những giao dịch lịch sử do seed tạo vẫn là mock; giao dịch mới từ giao diện dùng sandbox. Override mock chỉ nằm trong lời gọi nội bộ của seed, không được nhận qua HTTP.

```sh
RUN_DB_TESTS=1 node --test test/sepay-gateway.integration.test.js test/billing.integration.test.js test/demo-seed.integration.test.js
```

Các integration test dùng schema DB và Redis prefix riêng, giả lập phản hồi API SePay; không reset schema development và không tạo giao dịch ngoài SePay. Smoke test qua trình duyệt ngày 2026-11-05 đã mở checkout SePay thật ở sandbox, giả lập 25.000đ và đối soát về trạng thái HELD. IPN thực tế chưa kiểm thử do chưa có URL public.

Tài liệu chính thức: [Sandbox](https://developer.sepay.vn/vi/cong-thanh-toan/sandbox), [Form checkout](https://developer.sepay.vn/vi/cong-thanh-toan/API/don-hang/form-thanh-toan), [IPN](https://developer.sepay.vn/vi/cong-thanh-toan/IPN), [Tra cứu đơn hàng](https://developer.sepay.vn/vi/cong-thanh-toan/API/don-hang/chi-tiet-don-hang).
