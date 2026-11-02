const { Op } = require("sequelize");
const {
  DispatchNotification: Notification,
  DispatchTicket: Ticket,
  Provider,
  User,
} = require("../models");
const Availability = require("./provider_availability.service");
const Capabilities = require("./provider_capability.service");
const { distanceSql } = require("../utils/geo.util");
const { PENDING, KIND } = require("../common/dispatch.constants");
let io;
class Notifications {
  static setIO(value) {
    io = value;
  }
  static broadcastChat(ticket, message) {
    if (io)
      io.to(`chat:${message.roomId}`).emit("chat:message", {
        scope: "DISPATCH",
        referenceId: ticket.id,
        ...message,
      });
  }
  static summary(ticket) {
    return {
      id: ticket.id,
      code: ticket.code,
      type: ticket.type,
      status: ticket.status,
      pickupLatitude: Math.round(ticket.pickupLatitude * 1000) / 1000,
      pickupLongitude: Math.round(ticket.pickupLongitude * 1000) / 1000,
      vehicleType: ticket.vehicleSnapshot.type,
      requiredCapabilities: ticket.requirements.requiredCapabilities,
      createdAt: ticket.createdAt,
    };
  }
  static async candidates(ticket, transaction) {
    const distance = distanceSql(ticket.pickupLatitude, ticket.pickupLongitude);
    const rows = await Provider.findAll({
      where: {
        kind: KIND[ticket.type],
        status: "ACTIVE",
        suspended: false,
        accepting: true,
        ...(ticket.targetProviderId && { id: ticket.targetProviderId }),
        [Op.and]: require("sequelize").literal(`(${distance}) <= 15000`),
      },
      transaction,
      order: [["id", "ASC"]],
    });
    const result = [];
    for (const p of rows) {
      if (
        p.userId === ticket.userId ||
        ticket.formerAssignedShopIds.includes(p.id) ||
        ticket.formerAssignedUserIds.includes(p.userId) ||
        !Capabilities.matches(p, ticket.requirements)
      )
        continue;
      const owner = await User.findOne({
        where: { userId: p.userId },
        transaction,
      });
      if (owner?.status !== "ACTIVE" || !owner.emailVerifiedAt) continue;
      if ((await Availability.describe(p, transaction)).available)
        result.push(p);
    }
    return result;
  }
  static async enqueue(ticket, actorId, event, transaction) {
    const recipients = new Set([ticket.userId]);
    if (ticket.providerId) {
      const provider = await Provider.findByPk(ticket.providerId, {
        transaction,
      });
      if (provider) recipients.add(provider.userId);
    }
    if (ticket.targetProviderId) {
      const target = await Provider.findByPk(ticket.targetProviderId, {
        transaction,
      });
      if (target) recipients.add(target.userId);
    }
    if (ticket.dropoffShopId) {
      const shop = await Provider.findByPk(ticket.dropoffShopId, {
        transaction,
      });
      if (shop) recipients.add(shop.userId);
    }
    const urgent = new Set();
    if (PENDING.includes(ticket.status))
      for (const p of await this.candidates(ticket, transaction)) {
        recipients.add(p.userId);
        urgent.add(p.userId);
      }
    for (const recipientId of recipients)
      await Notification.create(
        {
          ticketId: ticket.id,
          recipientId,
          event: urgent.has(recipientId) ? "dispatch-urgent" : event,
          payload: this.summary(ticket),
        },
        { transaction },
      );
    transaction.afterCommit(async () => {
      try {
        await this.deliver();
      } catch (error) {
        console.error("[Dispatch notifications]", error.message);
      }
    });
  }
  static async deliver() {
    if (!io) return;
    const online = [...io.sockets.adapter.rooms.keys()]
      .filter((room) => room.startsWith("user:"))
      .map((room) => room.slice(5));
    if (!online.length) return;
    const rows = await Notification.findAll({
      where: { deliveredAt: null, recipientId: { [Op.in]: online } },
      limit: 100,
      order: [["createdAt", "ASC"]],
    });
    for (const row of rows) {
      if (!io.sockets.adapter.rooms.has(`user:${row.recipientId}`)) continue;
      try {
        const ticket = await Ticket.findByPk(row.ticketId);
        if (!ticket) continue;
        if (
          row.event === "dispatch-urgent" &&
          !PENDING.includes(ticket.status)
        ) {
          await row.update({ deliveredAt: new Date() });
          continue;
        }
        const permitted =
          ticket.userId === row.recipientId ||
          (ticket.providerId &&
            !!(await Provider.findOne({
              where: { id: ticket.providerId, userId: row.recipientId },
            }))) ||
          (ticket.targetProviderId &&
            !!(await Provider.findOne({
              where: { id: ticket.targetProviderId, userId: row.recipientId },
            }))) ||
          (ticket.dropoffShopId &&
            !!(await Provider.findOne({
              where: { id: ticket.dropoffShopId, userId: row.recipientId },
            }))) ||
          (PENDING.includes(ticket.status) &&
            (await this.candidates(ticket)).some(
              (p) => p.userId === row.recipientId,
            ));
        if (!permitted) {
          await row.update({ deliveredAt: new Date() });
          continue;
        }
        io.to(`user:${row.recipientId}`).emit(row.event, {
          notificationId: row.id,
          ...this.summary(ticket),
        });
        await row.update({
          deliveredAt: new Date(),
          attempts: row.attempts + 1,
        });
      } catch (error) {
        await row.increment("attempts");
        console.error("[Dispatch delivery]", error.message);
      }
    }
  }
}
module.exports = Notifications;
