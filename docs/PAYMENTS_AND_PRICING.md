# Payments & Pricing — hợp đồng server

Áp dụng cho ticket mới. Backend PostgreSQL/Sequelize, tiền VND nguyên đồng. Client chưa chuyển sang hợp đồng mới trong đợt này.

## Bill và journey

Một ticket mới có một Bill (`ticketId` unique). SOS, TOW, sửa tại tiệm và TOW chiều về có bill riêng và đối tác nhận tiền riêng. `journeyId` chỉ liên kết các bill để điều hướng và tóm tắt; không dùng một QR để trả nhiều bill. Bill và BillItem là dữ liệu đối soát được lưu, được tính lại từ ticket trong cùng transaction. Không nhận số tiền hay người thụ hưởng do client khai khi tạo thanh toán.

BillItem vẫn chia khoản phí: SOS_CALLOUT, SOS_TRAVEL, TOW_FARE, WAITING_FEE, SHOP_REPAIR. `GET /bills/:id` trả thêm `ticket` chứa quoteItems, quoteVersion, quoteHistory, towFare. Mỗi payment allocation gắn một item và đối tác; QR intent có thể gồm nhiều item của cùng bill.

Migration trước sync bỏ unique journey_id. Bill cũ chỉ có một ticket được bổ sung ticketId mà giữ nguyên ID và mọi tham chiếu tiền. Bill lịch sử chứa nhiều ticket giữ ticketId=null và giữ cơ chế cũ cho journey đó để không chuyển giao dịch giữa hóa đơn. Không reset DB, không chia lại charge hoặc payout cũ.

## Bảng giá đối tác

Provider create/update nhận các field optional (null là dùng giá nền tảng):

| Field | Loại đối tác | Giới hạn VND |
| --- | --- | --- |
| towBaseFee | TOW | 100.000–300.000 |
| towPerKmFee | TOW | 8.000–15.000 |
| callOutFee | MOBILE_SHOP | 0–100.000 |
| travelPerKmFee | MOBILE_SHOP | 3.000–10.000 |

Service kiểm tra cả loại đối tác và giới hạn, kể cả khi được gọi trực tiếp. Giá được dùng tại lúc nhận cuốc; sửa hồ sơ sau đó không thay giá đã chụp vào ticket.

## Xe kéo

Tại lúc tạo yêu cầu có giá tham khảo theo card nền tảng. Nhận cuốc ghi `towFare` gồm estimate, ceiling, loadedKm, baseFee, perKmFee, includedKm, night, nightMultiplier, vehicleClass, distanceSource, final.

`estimate = round1k((base + perKm × max(0, loadedKm − includedKm)) × nightMultiplier)`.

Mặc định xe máy: base 150.000, perKm 10.000, includedKm 3. Ô tô: base 500.000, perKm 25.000, includedKm 10. Base/perKm đối tác được ưu tiên khi có. Ban đêm 22:00–06:00 Asia/Ho_Chi_Minh, hệ số 1,5. `ceiling = round1k(estimate × 1,1)`; round1k làm tròn gần nhất đến 1.000 VND.

Đổi điểm giao trước khi chạy tính lại bằng card và hệ số đêm đã chụp, giữ nguyên ceiling; estimate mới không vượt ceiling. Khi khách nghiệm thu, final=min(estimate,ceiling); phí chờ nằm ở dòng riêng.

Khoảng cách hiện dùng đường thẳng hai điểm (`distanceSource=STRAIGHT_LINE`) và được chụp để giá không đổi khi đọc lại. Chưa dùng GPS hành trình để tăng/giảm cước. Chưa áp dụng khoản hủy deadhead/breakdown: hủy khách vẫn void phí theo quy tắc hiện có.

Cho phép bảo đảm thanh toán trước khi bắt đầu vận chuyển: chọn CASH là cam kết, SEPAY cần HELD/CONFIRMED; start kiểm tra đủ tiền sau khi đóng phí chờ. Tiền online chỉ được chốt CONFIRMED khi khách nghiệm thu; final chốt cùng transaction. Đối tác xác nhận tiền mặt ở trạng thái đang vận chuyển phải có bằng chứng bàn giao DELIVERY đã xác nhận và GPS hợp lệ ở điểm giao.

## SOS

Nhận cuốc yêu cầu GPS mới theo policy hiện có. Trong 1.000 m miễn call-out; ngoài phạm vi dùng giá đối tác hoặc cấu hình nền tảng (mặc định 30.000). Travel = round1k(khoảng cách km × perKm), ưu tiên giá đối tác, mặc định 5.000/km. Quote sửa chữa cộng vào call-out và travel. UNFIXABLE giữ call-out và bỏ travel/repair. Tái yêu cầu tạo ticket/bill riêng.

## Báo giá sửa chữa

`POST /api/v1/dispatch/:id/quote`:

```json
{"amount":150000,"items":[{"name":"Thay lốp","qty":2,"unitPrice":75000}],"expectedRevision":2}
```

items optional để tương thích API cũ. Khi có, từ 1–100 dòng; qty nguyên 1–1.000; đơn giá không âm, nguyên VND. Server tính amount từng dòng, tổng phải bằng amount. Lưu quoteItems, quoteVersion, quoteHistory. Trong QUOTED (9) có thể sửa; lưu bản trước vào lịch sử, tăng version và hủy intent PENDING cũ. Đã có tiền HELD/CONFIRMED thì từ chối sửa, yêu cầu xử lý hỗ trợ/hoàn tiền. Sau duyệt không sửa giá trực tiếp; chưa có endpoint hóa đơn cuối khác giá hoặc phụ thu tự động.

`POST /api/v1/dispatch/:id/approve-quote` có thể nhận `{"method":"CASH"}` để tạo/reuse cam kết tiền mặt và bắt đầu việc trong cùng transaction. Với SEPAY, hoặc không gửi method, dùng cổng funding hiện hành: phải có CASH PENDING/CONFIRMED hoặc SEPAY HELD/CONFIRMED đủ cho ticket và đối tác hiện tại.

## Tiền mặt, SePay và hoàn tất

CASH PENDING là cam kết, không cộng vào paidAmount. Chủ đối tác nhận tiền gọi `POST /payments/confirm-cash` với paymentId. Khách không thể resolve ticket khi còn CASH PENDING trên ticket đó. Việc xác nhận lần hai vẫn idempotent. Tiền mặt đối tác đã giữ không được trả thêm qua payout; server ghi nợ hoa hồng để cấn trừ.

SEPAY vẫn dùng create-sepay-qr, sandbox checkout/IPN, live bank webhook và inbox hiện có. HELD là tiền đã nhận đang giữ trên sổ ứng dụng. Không phải tài khoản escrow ngân hàng riêng. Webhook không tự duyệt báo giá hoặc hoàn tất công việc.

## Hoa hồng, refunds và payout

TOW mặc định 15%, các loại khác mặc định 10%. `PLATFORM_TOW_COMMISSION_RATE` và `PLATFORM_COMMISSION_RATE` là tỷ lệ 0–1; admin settings hỗ trợ `sepay.towCommissionRate` và `sepay.commissionRate`. Basis points được chụp vào allocation lúc tạo. Giá trị áp dụng, hoa hồng và payout được đối soát lại khi khoản thu bị giảm; tỷ lệ lịch sử giữ nguyên.

Giữ nguyên quy trình hoàn tiền thủ công có biên nhận ngân hàng duy nhất, payout lô, cấn trừ nợ hoa hồng, thời gian giữ mặc định 7 ngày và chặn khi tranh chấp. Tài liệu chi tiết: [BILLING_AND_PAYMENTS.md](BILLING_AND_PAYMENTS.md). Chưa có chuyển khoản tự động.

## Kiểm thử

`RUN_DB_TESTS=1 node --test test/billing.integration.test.js` kiểm tra bill riêng cùng journey, funding độc lập, báo giá theo dòng/sửa phiên bản/hủy cam kết cũ, chặn sửa sau duyệt, chặn hoàn tất khi chưa nhận tiền mặt, cùng các hồi quy webhook/refund/payout. `node --test test/pricing.test.js` kiểm tra giá ngày/đêm, km bao gồm, giá đối tác và tổng hạng mục.
