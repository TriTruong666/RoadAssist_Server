/**
 * Response Handler Utility
 * Dùng để chuẩn hóa toàn bộ dữ liệu trả về của API trên toàn hệ thống.
 * Giúp Frontend dễ dàng xử lý vì Response luôn có cùng cấu trúc.
 */

const ErrorCodes = require("./exceptions/error_codes");

class ResponseHandler {
  /**
   * Phản hồi thành công (200 OK)
   */
  static success(res, data = null, message = "Thành công", statusCode = 200) {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
    });
  }

  /**
   * Phản hồi khi tạo mới dữ liệu thành công (201 Created)
   */
  static created(res, data = null, message = "Tạo record thành công") {
    return this.success(res, data, message, 201);
  }

  /**
   * Phản hồi khi task được chấp nhận và đẩy vào background (202 Accepted)
   */
  static accepted(
    res,
    data = null,
    message = "Yêu cầu đã được tiếp nhận và đang xử lý trong nền"
  ) {
    return res.status(202).json({
      success: true,
      message,
      data,
    });
  }

  /**
   * Phản hồi khi có lỗi từ phía Client (400, 401, 403, 404)
   */
  static error(
    res,
    message = "Có lỗi đã xảy ra",
    statusCode = 400,
    errorCode = null,
    details = null,
  ) {
    return res.status(statusCode).json({
      success: false,
      message,
      error_code: errorCode || statusCode,
      details,
    });
  }

  /**
   * Phản hồi lỗi hệ thống (500 Internal Server Error)
   */
  static internalError(
    res,
    message = "Lỗi hệ thống",
    error = null,
    errorCode = ErrorCodes.INTERNAL_SERVER_ERROR.code,
    details = null,
    statusCode = 500,
  ) {
    const isDev = process.env.NODE_ENV === "development";

    return res.status(statusCode).json({
      success: false,
      message,
      error_code: errorCode,
      details,
      ...(isDev && { stack_trace: error?.stack || error }),
    });
  }

  /**
   * Phản hồi dành riêng cho danh sách có phân trang
   */
  static paginate(res, rows, count, page, limit, message = "Thành công") {
    return res.status(200).json({
      success: true,
      message,
      pagination: {
        totalRecords: count,
        totalPages: Math.ceil(count / limit),
        currentPage: parseInt(page),
        pageSize: parseInt(limit),
      },
      data: rows,
    });
  }
}

module.exports = ResponseHandler;
