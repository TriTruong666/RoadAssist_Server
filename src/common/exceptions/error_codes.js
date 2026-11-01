module.exports = {
  AUTH_MAIL_UNAVAILABLE: { code: "AUTH_MAIL_UNAVAILABLE", message: "Dịch vụ email tạm thời không khả dụng", statusCode: 503 },
  "SUCCESS": {
    "code": "SUCCESS",
    "message": "Thành công",
    "statusCode": 200
  },
  "INTERNAL_SERVER_ERROR": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "Đã có lỗi xảy ra phía máy chủ",
    "statusCode": 500
  },
  "DATABASE_ERROR": {
    "code": "DATABASE_ERROR",
    "message": "Lỗi cơ sở dữ liệu",
    "statusCode": 500
  },
  "BAD_REQUEST": {
    "code": "BAD_REQUEST",
    "message": "Dữ liệu yêu cầu không hợp lệ",
    "statusCode": 400
  },
  "VALIDATION_ERROR": {
    "code": "VALIDATION_ERROR",
    "message": "Dữ liệu đầu vào không hợp lệ",
    "statusCode": 400
  },
  "AUTH_OTP_INVALID_OR_EXPIRED": {
    "code": "AUTH_OTP_INVALID_OR_EXPIRED",
    "message": "Auth otp invalid or expired",
    "statusCode": 400
  },
  "VEHICLE_ACTIVE_REQUIRED": {
    "code": "VEHICLE_ACTIVE_REQUIRED",
    "message": "Vehicle active required",
    "statusCode": 400
  },
  "VEHICLE_DIMENSIONS_INVALID": {
    "code": "VEHICLE_DIMENSIONS_INVALID",
    "message": "Vehicle dimensions invalid",
    "statusCode": 400
  },
  "DISPATCH_SHOP_OUT_OF_RANGE": {
    "code": "DISPATCH_SHOP_OUT_OF_RANGE",
    "message": "Dispatch shop out of range",
    "statusCode": 400
  },
  "SEPAY_TRANSACTION_MISMATCH": {
    "code": "SEPAY_TRANSACTION_MISMATCH",
    "message": "Sepay transaction mismatch",
    "statusCode": 400
  },
  "UNAUTHORIZED": {
    "code": "UNAUTHORIZED",
    "message": "Phiên đăng nhập không hợp lệ",
    "statusCode": 401
  },
  "AUTH_INVALID_CREDENTIALS": {
    "code": "AUTH_INVALID_CREDENTIALS",
    "message": "Auth invalid credentials",
    "statusCode": 401
  },
  "AUTH_SESSION_EXPIRED": {
    "code": "AUTH_SESSION_EXPIRED",
    "message": "Auth session expired",
    "statusCode": 401
  },
  "SEPAY_WEBHOOK_UNAUTHORIZED": {
    "code": "SEPAY_WEBHOOK_UNAUTHORIZED",
    "message": "Sepay webhook unauthorized",
    "statusCode": 401
  },
  "FORBIDDEN": {
    "code": "FORBIDDEN",
    "message": "Bạn không có quyền thực hiện hành động này",
    "statusCode": 403
  },
  "AUTH_ACCOUNT_INACTIVE": {
    "code": "AUTH_ACCOUNT_INACTIVE",
    "message": "Auth account inactive",
    "statusCode": 403
  },
  "PROVIDER_NOT_ACTIVE": {
    "code": "PROVIDER_NOT_ACTIVE",
    "message": "Provider not active",
    "statusCode": 403
  },
  "PROVIDER_TOW_PENDING_APPROVAL": {
    "code": "PROVIDER_TOW_PENDING_APPROVAL",
    "message": "Provider tow pending approval",
    "statusCode": 403
  },
  "PROVIDER_DUTY_SWITCH_DISABLED": {
    "code": "PROVIDER_DUTY_SWITCH_DISABLED",
    "message": "Provider duty switch disabled",
    "statusCode": 403
  },
  "DISPATCH_CANCEL_NOT_ALLOWED": {
    "code": "DISPATCH_CANCEL_NOT_ALLOWED",
    "message": "Dispatch cancel not allowed",
    "statusCode": 403
  },
  "PAYMENT_UNFUNDED_FOR_APPROVAL": {
    "code": "PAYMENT_UNFUNDED_FOR_APPROVAL",
    "message": "Payment unfunded for approval",
    "statusCode": 403
  },
  "DISPUTE_WINDOW_EXPIRED": {
    "code": "DISPUTE_WINDOW_EXPIRED",
    "message": "Dispute window expired",
    "statusCode": 403
  },
  "NOT_FOUND": {
    "code": "NOT_FOUND",
    "message": "Không tìm thấy tài nguyên yêu cầu",
    "statusCode": 404
  },
  "USER_NOT_FOUND": {
    "code": "USER_NOT_FOUND",
    "message": "User not found",
    "statusCode": 404
  },
  "VEHICLE_NOT_FOUND": {
    "code": "VEHICLE_NOT_FOUND",
    "message": "Vehicle not found",
    "statusCode": 404
  },
  "PROVIDER_NOT_FOUND": {
    "code": "PROVIDER_NOT_FOUND",
    "message": "Provider not found",
    "statusCode": 404
  },
  "DISPATCH_TICKET_NOT_FOUND": {
    "code": "DISPATCH_TICKET_NOT_FOUND",
    "message": "Dispatch ticket not found",
    "statusCode": 404
  },
  "BILL_NOT_FOUND": {
    "code": "BILL_NOT_FOUND",
    "message": "Bill not found",
    "statusCode": 404
  },
  "CONFLICT": {
    "code": "CONFLICT",
    "message": "Dữ liệu xung đột",
    "statusCode": 409
  },
  "DUPLICATE_ENTRY": {
    "code": "DUPLICATE_ENTRY",
    "message": "Dữ liệu đã tồn tại",
    "statusCode": 409
  },
  "USER_ALREADY_EXISTS": {
    "code": "USER_ALREADY_EXISTS",
    "message": "User already exists",
    "statusCode": 409
  },
  "VEHICLE_BUSY": {
    "code": "VEHICLE_BUSY",
    "message": "Vehicle busy",
    "statusCode": 409
  },
  "PROVIDER_ALREADY_EXISTS": {
    "code": "PROVIDER_ALREADY_EXISTS",
    "message": "Provider already exists",
    "statusCode": 409
  },
  "DISPATCH_INVALID_STATE_TRANSITION": {
    "code": "DISPATCH_INVALID_STATE_TRANSITION",
    "message": "Dispatch invalid state transition",
    "statusCode": 409
  },
  "DISPATCH_QUOTE_ALREADY_SUBMITTED": {
    "code": "DISPATCH_QUOTE_ALREADY_SUBMITTED",
    "message": "Dispatch quote already submitted",
    "statusCode": 409
  },
  "PAYMENT_ALREADY_SETTLED": {
    "code": "PAYMENT_ALREADY_SETTLED",
    "message": "Payment already settled",
    "statusCode": 409
  },
  "PAYLOAD_TOO_LARGE": {
    "code": "PAYLOAD_TOO_LARGE",
    "message": "Dữ liệu vượt quá giới hạn cho phép",
    "statusCode": 413
  },
  "AUTH_LOGIN_RATE_LIMITED": {
    "code": "AUTH_LOGIN_RATE_LIMITED",
    "message": "Auth login rate limited",
    "statusCode": 429
  }
};
