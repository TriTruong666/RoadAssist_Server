const { ConflictException } = require("../common/exceptions/BaseException");
const transient = new Set(["40P01", "40001", "55P03"]);
module.exports = async function retry(work) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const codeCollision =
        error.name === "SequelizeUniqueConstraintError" &&
        (Object.hasOwn(error.fields || {}, "code") ||
          /dispatch_tickets_code_key/.test(error.original?.constraint || ""));
      if (
        !codeCollision &&
        !transient.has(error.original?.code || error.parent?.code)
      )
        throw error;
      if (attempt >= 2)
        throw new ConflictException({
          code: "DISPATCH_CONCURRENT_CHANGE",
          message: "Dữ liệu đang được cập nhật, vui lòng thử lại",
          statusCode: 409,
        });
      await new Promise((resolve) =>
        setTimeout(resolve, 20 * (attempt + 1) + Math.random() * 30),
      );
    }
  }
};
