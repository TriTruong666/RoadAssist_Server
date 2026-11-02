const { BadRequestException } = require("../common/exceptions/BaseException");
const MAX = 999999999999;
function cents(value) {
  const text = String(value);
  if (!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(text))
    throw new BadRequestException(
      "Số tiền phải không âm, tối đa 2 chữ số thập phân",
    );
  const [whole, fraction = ""] = text.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result > MAX)
    throw new BadRequestException("Số tiền vượt giới hạn");
  return result;
}
function amount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX)
    throw new BadRequestException("Tổng tiền vượt giới hạn");
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}
function add(...values) {
  return amount(values.reduce((total, value) => total + cents(value), 0));
}
module.exports = { cents, amount, add };
