const { Op } = require("sequelize");
const { AdminAlert, User } = require("../models");
const { NotFoundException } = require("../common/exceptions/BaseException");
const definitions = {
  PROVIDER_REVIEW: { title: "Hồ sơ đối tác chờ thẩm định", panel: "providers" },
  HAZARD_CONFIRMED: {
    title: "Sự cố đã đủ xác nhận cộng đồng",
    panel: "hazards",
  },
  DISPUTE_OPENED: { title: "Có khiếu nại mới cần xử lý", panel: "disputes" },
};
function dto(row) {
  const definition = definitions[row.kind];
  return {
    id: row.id,
    kind: row.kind,
    referenceId: row.referenceId,
    title: definition.title,
    message: row.message,
    href: `/dashboard/${definition.panel}?id=${row.referenceId}`,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}
module.exports = {
  // Called within the domain transaction: rolled-back events cannot leave alerts.
  async enqueue(kind, referenceId, occurrenceKey, message, transaction) {
    if (!definitions[kind] || !transaction)
      throw new Error("Invalid admin alert");
    const admins = await User.findAll({
      where: {
        role: "admin",
        status: "ACTIVE",
        emailVerifiedAt: { [Op.ne]: null },
      },
      attributes: ["userId"],
      transaction,
    });
    const recipients = [];
    for (const admin of admins) {
      const [, created] = await AdminAlert.findOrCreate({
        where: { userId: admin.userId, kind, occurrenceKey },
        defaults: { referenceId, message: String(message).slice(0, 160) },
        transaction,
      });
      if (created) recipients.push(admin.userId);
    }
    if (recipients.length)
      await require("./finance_notification.service").enqueue(
        recipients,
        "operations-alert",
        { kind, referenceId },
        transaction,
      );
  },
  async list(actor, { limit = 20, offset = 0 } = {}) {
    const where = { userId: actor.userId };
    const [result, unreadCount] = await Promise.all([
      AdminAlert.findAndCountAll({
        where,
        limit,
        offset,
        order: [
          ["createdAt", "DESC"],
          ["id", "DESC"],
        ],
      }),
      AdminAlert.count({ where: { ...where, readAt: null } }),
    ]);
    return { total: result.count, unreadCount, items: result.rows.map(dto) };
  },
  async read(actor, id) {
    const where = { id, userId: actor.userId };
    await AdminAlert.update(
      { readAt: new Date() },
      { where: { ...where, readAt: null } },
    );
    const row = await AdminAlert.findOne({ where });
    if (!row) throw new NotFoundException();
    return dto(row);
  },
};
