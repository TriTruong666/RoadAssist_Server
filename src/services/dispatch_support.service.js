const { DispatchSupportCase: Case, Provider } = require("../models");
const Policy = require("./dispatch_policy.service");
const { TERMINAL } = require("../common/dispatch.constants");
class Support {
  static async open(t, actor, data, transaction) {
    let row = await Case.findOne({
      where: { ticketId: t.id, status: "OPEN" },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (row) return row;
    row = await Case.create(
      {
        ticketId: t.id,
        requesterId: actor.system ? null : actor.userId,
        reason: data.reason,
        note: data.note || null,
      },
      { transaction },
    );
    await require("./dispatch.service").change(
      t,
      actor,
      "SUPPORT_REQUESTED",
      {},
      transaction,
      { caseId: row.id, reason: data.reason },
    );
    return row;
  }
  static async request(actor, id, data) {
    return require("./dispatch.service").fresh(
      actor,
      id,
      data,
      async (t, transaction) => {
        const profiles = await Provider.findAll({
          where: { userId: actor.userId },
          attributes: ["id"],
          transaction,
        });
        if (
          t.userId !== actor.userId &&
          !profiles.some((p) =>
            [
              t.providerId,
              t.dropoffShopId,
              t.candidateShopId,
              t.targetProviderId,
            ].includes(p.id),
          )
        )
          Policy.fail("DISPATCH_TICKET_NOT_FOUND", "Không tìm thấy phiếu", 404);
        if (TERMINAL.includes(t.status))
          Policy.fail("DISPATCH_INVALID_STATE_TRANSITION", "Cuốc đã kết thúc");
        return this.open(t, actor, data, transaction);
      },
    );
  }
  static async detail(actor, id) {
    await require("./finance_lock.service").admin(actor);
    const row = await Case.findByPk(id);
    if (!row)
      Policy.fail("SUPPORT_CASE_NOT_FOUND", "Không tìm thấy hồ sơ hỗ trợ", 404);
    const { DispatchTicket: Ticket, User } = require("../models");
    const t = await Ticket.findByPk(row.ticketId);
    const rider = await User.findOne({
      where: { userId: t.userId },
      attributes: ["name", "phone"],
    });
    const provider = t.providerId
      ? await Provider.findByPk(t.providerId, {
          attributes: ["id", "name", "phone"],
        })
      : null;
    return {
      case: row,
      ticket: require("./dispatch.service").dto(t),
      rider: { name: rider?.name, phone: rider?.phone },
      provider,
    };
  }
  static async list(actor, { limit = 50, offset = 0 }) {
    await require("./finance_lock.service").admin(actor);
    const result = await Case.findAndCountAll({
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
    });
    return { total: result.count, items: result.rows };
  }
  static async resolve(actor, id, data) {
    const snapshot = await Case.findByPk(id);
    if (!snapshot)
      Policy.fail("SUPPORT_CASE_NOT_FOUND", "Không tìm thấy hồ sơ hỗ trợ", 404);
    return require("./dispatch.service").fresh(
      actor,
      snapshot.ticketId,
      {},
      async (t, transaction) => {
        await require("./finance_lock.service").admin(actor, transaction);
        const row = await Case.findByPk(id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (row.status === "RESOLVED") {
          if (row.resolution !== data.resolution)
            Policy.fail(
              "SUPPORT_ALREADY_RESOLVED",
              "Hồ sơ đã được chốt với nội dung khác",
            );
          return row;
        }
        await row.update(
          {
            status: "RESOLVED",
            resolution: data.resolution,
            resolvedBy: actor.userId,
            resolvedAt: new Date(),
          },
          { transaction },
        );
        await require("./dispatch.service").change(
          t,
          actor,
          "SUPPORT_RESOLVED",
          {},
          transaction,
          { caseId: id },
        );
        return row;
      },
    );
  }
}
module.exports = Support;
