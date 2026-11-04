const { fn, col } = require("sequelize");
const db = require("../config/postgres.config");
const { Rating, DispatchTicket: Ticket, Provider } = require("../models");
const Policy = require("./dispatch_policy.service");
const fail = Policy.fail;
class Ratings {
  static async submit(actor, data) {
    const snapshot = await Ticket.findByPk(data.ticketId);
    if (!snapshot)
      fail("DISPATCH_TICKET_NOT_FOUND", "Không tìm thấy cuốc cứu hộ", 404);
    return db.transaction(async (transaction) => {
      await Policy.locks(actor, snapshot, {}, transaction);
      const ticket = await Ticket.findByPk(snapshot.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (ticket.status !== "4" || !ticket.providerId)
        fail(
          "RATING_TICKET_NOT_COMPLETED",
          "Chỉ đánh giá cuốc đã nghiệm thu",
          409,
        );
      const provider = await Provider.findByPk(ticket.providerId, {
        transaction,
      });
      const rider = actor.userId === ticket.userId;
      if (
        !provider ||
        (!rider && actor.userId !== provider.userId) ||
        provider.userId === ticket.userId
      )
        fail("FORBIDDEN", "Bạn không thuộc hai bên của cuốc cứu hộ", 403);
      const targetKind = rider ? "SHOP" : "RIDER";
      const values = {
        ticketId: ticket.id,
        authorId: actor.userId,
        providerId: provider.id,
        targetUserId: rider ? provider.userId : ticket.userId,
        targetKind,
        stars: data.stars,
        content: data.content || "",
      };
      const existing = await Rating.findOne({
        where: { ticketId: ticket.id, authorId: actor.userId },
        transaction,
      });
      const row = existing
        ? await existing.update(values, { transaction })
        : await Rating.create(values, { transaction });
      const [aggregate] = await Rating.findAll({
        attributes: [
          [fn("AVG", col("stars")), "average"],
          [fn("COUNT", col("id")), "count"],
        ],
        where: { providerId: provider.id, targetKind: "SHOP" },
        raw: true,
        transaction,
      });
      await provider.update(
        {
          ratingAvg: Number(aggregate.average || 5),
          ratingCount: Number(aggregate.count),
        },
        { transaction, auditAction: "RATING_UPDATED" },
      );
      return row;
    });
  }
  static async reply(actor, id, content) {
    const row = await Rating.findByPk(id);
    if (!row) fail("RATING_NOT_FOUND", "Không tìm thấy đánh giá", 404);
    if (row.targetUserId !== actor.userId)
      fail("FORBIDDEN", "Chỉ bên được đánh giá có quyền phản hồi", 403);
    return row.update({ replyContent: content, repliedAt: new Date() });
  }
  static async listProvider(id, { limit = 30, offset = 0 } = {}) {
    const provider = await Provider.findByPk(id);
    if (!provider || provider.status !== "ACTIVE" || provider.suspended)
      fail("PROVIDER_NOT_FOUND", "Không tìm thấy đối tác", 404);
    const result = await Rating.findAndCountAll({
      where: { providerId: id, targetKind: "SHOP" },
      order: [
        ["updatedAt", "DESC"],
        ["id", "ASC"],
      ],
      limit,
      offset,
    });
    // Public reviews never reveal private user ids, emails, phone or location.
    return {
      total: result.count,
      average: provider.ratingAvg,
      items: result.rows.map((row) => ({
        id: row.id,
        stars: row.stars,
        content: row.content,
        replyContent: row.replyContent,
        repliedAt: row.repliedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    };
  }
  static async mine(actor, ticketId) {
    const ticket = await Ticket.findByPk(ticketId);
    const provider =
      ticket?.providerId && (await Provider.findByPk(ticket.providerId));
    if (
      !ticket ||
      (ticket.userId !== actor.userId &&
        provider?.userId !== actor.userId &&
        actor.role !== "admin")
    )
      fail("NOT_FOUND", "Không tìm thấy cuốc", 404);
    return Rating.findAll({
      where: { ticketId },
      order: [["createdAt", "ASC"]],
    });
  }
  static async riderSummary(userId) {
    const [result] = await Rating.findAll({
      attributes: [
        [fn("AVG", col("stars")), "average"],
        [fn("COUNT", col("id")), "count"],
      ],
      where: { targetUserId: userId, targetKind: "RIDER" },
      raw: true,
    });
    return {
      average: result.average ? Number(result.average) : null,
      count: Number(result.count),
    };
  }
}
module.exports = Ratings;
