const { createHash } = require("node:crypto");
const { Op } = require("sequelize");
const { Handover, Provider, DispatchTicket: Ticket } = require("../models");
const Policy = require("./dispatch_policy.service");
const digest = (data) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
class Handovers {
  static async recipient(t, phase, transaction) {
    if (phase === "PICKUP" || !t.dropoffShopId) return t.userId;
    return (await Provider.findByPk(t.dropoffShopId, { transaction }))?.userId;
  }
  static async propose(actor, id, data) {
    const Dispatch = require("./dispatch.service");
    return Dispatch.fresh(actor, id, data, async (t, transaction) => {
      if (t.type !== "TOW")
        Policy.fail(
          "HANDOVER_NOT_APPLICABLE",
          "Biên bản vận chuyển chỉ dành cho cuốc kéo xe",
        );
      Policy.state(t, data.phase === "PICKUP" ? ["3"] : ["6"]);
      const provider = await Provider.findOne({
        where: { id: t.providerId, userId: actor.userId },
        transaction,
      });
      if (!provider)
        Policy.fail("DISPATCH_TICKET_NOT_FOUND", "Không tìm thấy cuốc", 404);
      const recipientId = await this.recipient(t, data.phase, transaction);
      if (!recipientId || recipientId === actor.userId)
        Policy.fail(
          "HANDOVER_PARTIES_REQUIRED",
          "Cần hai tài khoản độc lập để xác nhận bàn giao",
        );
      Policy.trustedLocation(provider, {
        latitude:
          data.phase === "PICKUP" ? t.pickupLatitude : t.dropoffLatitude,
        longitude:
          data.phase === "PICKUP" ? t.pickupLongitude : t.dropoffLongitude,
      });
      const fingerprint = digest({
        phase: data.phase,
        assetIds: [...data.assetIds].sort(),
        condition: data.condition,
        damages: data.damages || [],
      });
      const previous = await Handover.findOne({
        where: { ticketId: id, phase: data.phase },
        order: [["version", "DESC"]],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        previous?.fingerprint === fingerprint &&
        previous.providerId === t.providerId &&
        previous.recipientId === recipientId &&
        previous.destinationShopId ===
          (data.phase === "DELIVERY" ? t.dropoffShopId : null) &&
        ["PENDING", "CONFIRMED"].includes(previous.status)
      )
        return previous;
      if (
        previous?.status === "CONFIRMED" &&
        previous.providerId === t.providerId &&
        previous.recipientId === recipientId &&
        previous.destinationShopId ===
          (data.phase === "DELIVERY" ? t.dropoffShopId : null)
      )
        Policy.fail(
          "HANDOVER_ALREADY_CONFIRMED",
          "Biên bản đã xác nhận không được sửa",
        );
      if (previous && ["PENDING", "CONFIRMED"].includes(previous.status))
        await previous.update({ status: "SUPERSEDED" }, { transaction });
      const images = await Dispatch.assets(
        actor,
        data.assetIds,
        `handover:${id}:${data.phase}`,
        transaction,
        2,
        8,
      );
      const row = await Handover.create(
        {
          ticketId: id,
          phase: data.phase,
          version: (previous?.version || 0) + 1,
          providerId: t.providerId,
          authorId: actor.userId,
          recipientId,
          destinationShopId: data.phase === "DELIVERY" ? t.dropoffShopId : null,
          images,
          assetIds: data.assetIds,
          condition: data.condition,
          damages: data.damages || [],
          fingerprint,
          locationSnapshot: {
            latitude: provider.latitude,
            longitude: provider.longitude,
            accuracy: provider.lastAccuracy,
            trustedAt: provider.lastTrustedLocationAt,
          },
        },
        { transaction },
      );
      await Dispatch.change(t, actor, "HANDOVER_PROPOSED", {}, transaction, {
        handoverId: row.id,
        phase: row.phase,
        version: row.version,
      });
      return row;
    });
  }
  static async respond(actor, id, data, reject = false) {
    const Dispatch = require("./dispatch.service");
    return Dispatch.fresh(actor, id, data, async (t, transaction) => {
      const row = await Handover.findOne({
        where: { id: data.handoverId, ticketId: id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        !row ||
        row.recipientId !== actor.userId ||
        actor.userId === row.authorId
      )
        Policy.fail(
          "HANDOVER_NOT_FOUND",
          "Không tìm thấy biên bản được phép xác nhận",
          404,
        );
      if (
        row.providerId !== t.providerId ||
        row.recipientId !== (await this.recipient(t, row.phase, transaction)) ||
        (row.phase === "DELIVERY" && row.destinationShopId !== t.dropoffShopId)
      )
        Policy.fail("HANDOVER_STALE", "Đối tác hoặc đích bàn giao đã đổi");
      const desired = reject ? "REJECTED" : "CONFIRMED";
      if (row.status === desired) return row;
      Policy.state(t, row.phase === "PICKUP" ? ["3"] : ["6"]);
      if (row.status !== "PENDING")
        Policy.fail("HANDOVER_STALE", "Biên bản không còn chờ xác nhận");
      const images = await Dispatch.assets(
        actor,
        data.assetIds || [],
        `handover-response:${row.id}`,
        transaction,
        0,
        8,
      );
      await row.update(
        {
          status: desired,
          confirmedAt: reject ? null : new Date(),
          responseNote: data.note || null,
          responseImages: images,
        },
        { transaction },
      );
      await Dispatch.change(
        t,
        actor,
        reject ? "HANDOVER_REJECTED" : "HANDOVER_CONFIRMED",
        {},
        transaction,
        {
          handoverId: row.id,
          phase: row.phase,
          version: row.version,
          note: data.note || null,
        },
      );
      return row;
    });
  }
  static async require(t, phase, transaction) {
    if (!t.handoverRequired) return;
    const row = await Handover.findOne({
      where: {
        ticketId: t.id,
        phase,
        status: "CONFIRMED",
        providerId: t.providerId,
      },
      order: [["version", "DESC"]],
      transaction,
    });
    if (
      !row ||
      row.recipientId !== (await this.recipient(t, phase, transaction)) ||
      (phase === "DELIVERY" && row.destinationShopId !== t.dropoffShopId)
    )
      Policy.fail(
        "HANDOVER_CONFIRMATION_REQUIRED",
        "Cần biên bản ảnh và xác nhận của bên giao/nhận đúng cuốc",
      );
  }
  static async list(actor, id) {
    const Dispatch = require("./dispatch.service");
    return Dispatch.fresh(actor, id, {}, async (t, transaction) => {
      const owned = await Provider.findAll({
        where: { userId: actor.userId },
        attributes: ["id"],
        transaction,
      });
      const current =
        t.userId === actor.userId ||
        owned.some((p) => p.id === t.providerId || p.id === t.dropoffShopId);
      const rows = await Handover.findAll({
        where: {
          ticketId: id,
          ...(!current && {
            [Op.or]: [
              { authorId: actor.userId },
              { recipientId: actor.userId },
            ],
          }),
        },
        order: [["createdAt", "ASC"]],
        transaction,
      });
      if (!current && !rows.length)
        Policy.fail("DISPATCH_TICKET_NOT_FOUND", "Không tìm thấy cuốc", 404);
      return rows;
    });
  }
}
module.exports = Handovers;
