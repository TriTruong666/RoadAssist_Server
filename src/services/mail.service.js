const transport = require("../config/mail.config");
class MailService {
  static async sendLoginVerificationMail({ to, code, ipAddress }) {
    return transport.sendMail({
      to,
      subject: "RoadAssist: Xác thực đăng nhập mới",
      text: `Mã xác thực của bạn: ${code}\nHết hạn sau 5 phút. Yêu cầu đăng nhập từ IP: ${ipAddress}.\nNếu không phải bạn, hãy đổi mật khẩu. Không chia sẻ mã này.`,
    });
  }
  static async sendPasswordResetMail({ to, code }) {
    return transport.sendMail({
      to,
      subject: "RoadAssist: Đặt lại mật khẩu",
      text: `Mã đặt lại mật khẩu: ${code}\nHết hạn sau 5 phút. Không chia sẻ mã này. Bỏ qua email nếu bạn không yêu cầu.`,
    });
  }
}
module.exports = MailService;
