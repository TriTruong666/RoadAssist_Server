const nodemailer = require("nodemailer");
const { mail } = require("./app.config");
// No SMTP connection is made until a message is sent.
module.exports = nodemailer.createTransport({
  host: mail.host, port: mail.port, secure: mail.secure,
  ...(mail.user && { auth: { user: mail.user, pass: mail.password } }),
}, { from: mail.from });
