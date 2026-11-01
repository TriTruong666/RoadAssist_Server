const transport = require('../config/mail.config');
class MailService {
  static sendRegistrationVerificationMail({ to, code }) {
    return transport.sendMail({ to, subject: 'RoadAssist: Xác minh địa chỉ email',
      text: `Mã xác minh email của bạn: ${code}\nHết hạn sau 5 phút. Nhập mã để hoàn tất đăng ký RoadAssist. Không chia sẻ mã này. Nếu không phải bạn yêu cầu, hãy bỏ qua email.` });
  }
  static sendPasswordResetMail({ to, code }) {
    return transport.sendMail({ to, subject: 'RoadAssist: Đặt lại mật khẩu',
      text: `Mã đặt lại mật khẩu: ${code}\nHết hạn sau 5 phút. Không chia sẻ mã này. Bỏ qua email nếu bạn không yêu cầu.` });
  }
}
module.exports = MailService;
