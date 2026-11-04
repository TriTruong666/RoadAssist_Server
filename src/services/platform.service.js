const { Op, literal, fn, col } = require("sequelize");
const db = require("../config/postgres.config");
const {
  User,
  Provider,
  HazardFlag,
  DispatchTicket,
  Dispute,
  BillPayment,
  PayoutBatch,
  Announcement,
  AnnouncementReceipt,
  UserDevice,
  AnnouncementDelivery,
} = require("../models");
const Policy = require("./dispatch_policy.service");
const ProviderService = require("./provider.service");
const { TERMINAL } = require("../common/dispatch.constants");
// Aggregate DECIMAL values without floating-point rounding or per-payment limits.
function sumAmounts(values) {
  const cents = values.reduce((sum, value) => {
    const [whole, fraction = ""] = String(value ?? "0").split(".");
    return sum + BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  }, 0n);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
class Platform {
  static audience(target) {
    return {
      status: "ACTIVE",
      ...(target === "PROVIDER"
        ? { role: "provider" }
        : target === "RIDER"
          ? { services: { [Op.contains]: ["RIDER"] } }
          : {}),
    };
  }
  static async providers({ limit = 50, offset = 0, kind, status, q } = {}) {
    const result = await Provider.findAndCountAll({
      where: {
        ...(kind && { kind }),
        ...(status &&
          (status === "SUSPENDED" ? { suspended: true } : { status })),
        ...(q && {
          [Op.or]: [
            { name: { [Op.iLike]: `%${q}%` } },
            { plateNumber: { [Op.iLike]: `%${q}%` } },
          ],
        }),
      },
      include: [
        {
          model: User,
          as: "owner",
          attributes: ["userId", "name", "email", "phone", "status"],
        },
      ],
      limit,
      offset,
      order: [
        ["createdAt", "DESC"],
        ["id", "ASC"],
      ],
    });
    return { items: result.rows, total: result.count };
  }
  static async hazards({ limit = 50, offset = 0, category, status } = {}) {
    const result = await HazardFlag.findAndCountAll({
      where: { ...(category && { category }), ...(status && { status }) },
      limit,
      offset,
      order: [
        ["createdAt", "DESC"],
        ["id", "ASC"],
      ],
    });
    return {
      total: result.count,
      items: await Promise.all(
        result.rows.map((row) => require("./flag.service").detail(row.id)),
      ),
    };
  }
  static async dispatches({ limit = 50, offset = 0, status, q } = {}) {
    const result = await DispatchTicket.findAndCountAll({
      where: {
        ...(status ? { status } : { status: { [Op.notIn]: TERMINAL } }),
        ...(q && { code: { [Op.iLike]: `%${q}%` } }),
      },
      limit,
      offset,
      order: [
        ["createdAt", "DESC"],
        ["id", "ASC"],
      ],
    });
    const ids = [
      ...new Set(result.rows.map((t) => t.providerId).filter(Boolean)),
    ];
    const providers = ids.length
      ? await Provider.findAll({ where: { id: { [Op.in]: ids } } })
      : [];
    return {
      total: result.count,
      items: result.rows.map((ticket) => ({
        ...ticket.toJSON(),
        provider:
          providers.find((p) => p.id === ticket.providerId)?.toJSON() || null,
      })),
    };
  }
  static async monitor({ latitude, longitude, radiusKm = 15 }) {
    const distance = require("../utils/geo.util")
      .distanceSql(latitude, longitude)
      .replaceAll('"Provider"', '"HazardFlag"');
    const [providers, hazards, dispatches] = await Promise.all([
      ProviderService.search({
        latitude,
        longitude,
        radiusKm,
        acceptingOnly: true,
        limit: 100,
      }),
      HazardFlag.findAll({
        where: {
          status: { [Op.ne]: "4" },
          expiresAt: { [Op.gt]: new Date() },
          [Op.and]: literal(`(${distance}) <= ${radiusKm * 1000}`),
        },
        limit: 1000,
        order: [["createdAt", "DESC"]],
      }),
      this.dispatches({ limit: 100 }),
    ]);
    const visible = new Map(
      providers.map((provider) => [provider.id, provider]),
    );
    for (const ticket of dispatches.items)
      if (
        ticket.provider &&
        Number.isFinite(ticket.provider.latitude) &&
        Number.isFinite(ticket.provider.longitude)
      )
        visible.set(ticket.provider.id, {
          ...ticket.provider,
          available: false,
          state: "BUSY",
        });
    return {
      providers: [...visible.values()],
      hazards,
      dispatches: dispatches.items,
      truncated: {
        providers: providers.length === 100,
        hazards: hazards.length === 1000,
        dispatches: dispatches.total > 100,
      },
      sampledAt: new Date(),
    };
  }
  static async stats() {
    const [
      users,
      providers,
      pendingProviders,
      activeDispatches,
      openDisputes,
      hazards,
      payouts,
      payments,
      unbatched,
    ] = await Promise.all([
      User.count(),
      Provider.count({ where: { status: "ACTIVE", suspended: false } }),
      Provider.count({ where: { status: "PENDING" } }),
      DispatchTicket.count({ where: { status: { [Op.notIn]: TERMINAL } } }),
      Dispute.count({ where: { status: { [Op.in]: ["OPEN", "REVIEW"] } } }),
      HazardFlag.count({
        where: { status: { [Op.ne]: "4" }, expiresAt: { [Op.gt]: new Date() } },
      }),
      PayoutBatch.findAll({
        attributes: [
          "status",
          [fn("COUNT", col("id")), "count"],
          [fn("SUM", col("gross")), "gross"],
          [fn("SUM", col("commission")), "commission"],
          [fn("SUM", col("net")), "net"],
        ],
        group: ["status"],
        raw: true,
      }),
      BillPayment.findAll({
        attributes: [
          "status",
          [fn("SUM", col("applied_amount")), "gross"],
          [fn("SUM", col("commission_amount")), "commission"],
        ],
        group: ["status"],
        raw: true,
      }),
      BillPayment.findAll({
        attributes: [[fn("SUM", col("payout_amount")), "net"]],
        where: { status: "CONFIRMED", method: "SEPAY", payoutBatchId: null },
        raw: true,
      }),
    ]);
    const unbatchedOnline = sumAmounts(unbatched.map((row) => row.net));
    const pendingBatchNet = sumAmounts(
      payouts.filter((row) => row.status === "PENDING").map((row) => row.net),
    );
    return {
      financial: {
        grossGmv: sumAmounts(
          payments
            .filter((row) => ["HELD", "CONFIRMED"].includes(row.status))
            .map((row) => row.gross),
        ),
        platformCommission: sumAmounts(
          payments
            .filter((row) => row.status === "CONFIRMED")
            .map((row) => row.commission),
        ),
        unbatchedOnline,
        pendingBatchNet,
        pendingPayouts: sumAmounts([unbatchedOnline, pendingBatchNet]),
        settledPayouts: sumAmounts(
          payouts
            .filter((row) => row.status === "SETTLED")
            .map((row) => row.net),
        ),
      },
      users,
      providers,
      pendingProviders,
      activeDispatches,
      openDisputes,
      hazards,
      payouts,
      payments,
    };
  }
  static async dispatchDetail(id, actor) {
    if (actor?.role !== "admin") Policy.fail("FORBIDDEN", "Chỉ quản trị viên được xem điều phối", 403);
    const ticket = await DispatchTicket.findByPk(id);
    if (!ticket)
      Policy.fail(
        "DISPATCH_TICKET_NOT_FOUND",
        "Không tìm thấy cuốc cứu hộ",
        404,
      );
    const provider = ticket.providerId
      ? await Provider.findByPk(ticket.providerId)
      : null;
    return {
      ...require("./dispatch.service").dto(ticket),
      provider,
      intakes: await require("./shop_intake.service").read(actor, ticket),
      supportCases: await require("../models").DispatchSupportCase.findAll({ where: { ticketId: id }, order: [["createdAt","DESC"]] }),
      events: await require("../models").DispatchEvent.findAll({
        where: { ticketId: id },
        order: [["createdAt", "ASC"]],
      }),
      handovers: await require("../models").Handover.findAll({
        where: { ticketId: id },
        order: [["createdAt", "ASC"]],
      }),
    };
  }
  static async announce(actor, data, app) {
    const row = await db.transaction(async (transaction) => {
      const recipients = await User.findAll({
        where: this.audience(data.target),
        attributes: ["userId"],
        transaction,
      });
      const announcement = await Announcement.create(
        { ...data, createdBy: actor.userId, recipientCount: recipients.length },
        { transaction },
      );
      const imageUrls = [
        ...data.content.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi),
      ].map((match) => match[1].replaceAll("&amp;", "&"));
      if (imageUrls.length)
        await require("../models").S3Asset.update(
          { attachedTo: `announcement:${announcement.id}` },
          {
            where: { userId: actor.userId, s3Url: { [Op.in]: imageUrls } },
            transaction,
          },
        );
      // Snapshot recipients: a later role change must not expose historical private broadcasts.
      await AnnouncementReceipt.bulkCreate(
        recipients.map((user) => ({
          announcementId: announcement.id,
          userId: user.userId,
        })),
        { transaction },
      );
      transaction.afterCommit(() => {
        const io = app?.get("chatIO");
        if (io)
          for (const user of recipients)
            io.to(`user:${user.userId}`).emit("announcement:new", {
              id: announcement.id,
              priority: announcement.priority,
            });
      });
      return announcement;
    });
    return row;
  }
  static async announcements(
    actor,
    { limit = 30, offset = 0, deviceId } = {},
    admin = false,
  ) {
    if (admin) {
      const result = await Announcement.findAndCountAll({
        limit,
        offset,
        order: [
          ["createdAt", "DESC"],
          ["id", "ASC"],
        ],
      });
      return {
        total: result.count,
        items: await Promise.all(
          result.rows.map(async (row) => ({
            ...row.toJSON(),
            deliveredCount: await AnnouncementReceipt.count({
              where: { announcementId: row.id, deliveredAt: { [Op.ne]: null } },
            }),
            readCount: await AnnouncementReceipt.count({
              where: { announcementId: row.id, readAt: { [Op.ne]: null } },
            }),
            deliveredDeviceCount: await AnnouncementDelivery.count({
              where: { announcementId: row.id },
            }),
          })),
        ),
      };
    }
    const receipts = await AnnouncementReceipt.findAndCountAll({
      where: { userId: actor.userId },
      limit,
      offset,
      order: [
        ["createdAt", "DESC"],
        ["id", "ASC"],
      ],
    });
    const ids = receipts.rows.map((row) => row.announcementId);
    const device =
      deviceId &&
      (await UserDevice.findOne({
        where: { userId: actor.userId, clientDeviceId: deviceId },
      }));
    if (device && ids.length)
      await AnnouncementDelivery.bulkCreate(
        ids.map((announcementId) => ({
          announcementId,
          userId: actor.userId,
          deviceId: device.id,
          deliveredAt: new Date(),
        })),
        { ignoreDuplicates: true },
      );
    if (ids.length)
      await AnnouncementReceipt.update(
        { deliveredAt: new Date() },
        {
          where: {
            userId: actor.userId,
            announcementId: { [Op.in]: ids },
            deliveredAt: null,
          },
        },
      );
    const announcements = ids.length
      ? await Announcement.findAll({ where: { id: { [Op.in]: ids } } })
      : [];
    return {
      total: receipts.count,
      items: receipts.rows.map((receipt) => ({
        ...announcements
          .find((row) => row.id === receipt.announcementId)
          ?.toJSON(),
        readAt: receipt.readAt,
      })),
    };
  }
  static async read(actor, id) {
    const row = await AnnouncementReceipt.findOne({
      where: { announcementId: id, userId: actor.userId },
    });
    if (!row) Policy.fail("NOT_FOUND", "Không tìm thấy thông báo", 404);
    return row.update({
      deliveredAt: row.deliveredAt || new Date(),
      readAt: row.readAt || new Date(),
    });
  }
}
module.exports = Platform;
