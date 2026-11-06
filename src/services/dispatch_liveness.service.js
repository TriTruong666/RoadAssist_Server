const { Op } = require("sequelize");
const {
  DispatchTicket: Ticket,
  Provider,
  DispatchSupportCase: Support,
} = require("../models");
const { distanceMeters } = require("../utils/geo.util");
const Policy = require("./dispatch_policy.service");
const Intake = require("./shop_intake.service");
const config = require("../config/app.config").operations;
const { PENDING } = require("../common/dispatch.constants");
class Liveness {
  static queueDeadline(now = Date.now()) {
    return new Date(now + config.queueTtlMinutes * 60000);
  }
  static near(profile, t) {
    return (
      profile?.locationQuality === "GOOD" &&
      profile.lastTrustedLocationAt &&
      Date.now() - new Date(profile.lastTrustedLocationAt) < 120000 &&
      Number.isFinite(profile.lastAccuracy) &&
      distanceMeters(profile, {
        latitude: t.pickupLatitude,
        longitude: t.pickupLongitude,
      }) +
        profile.lastAccuracy <=
        200
    );
  }
  static status(t, profile) {
    const now = Date.now(),
      progress = t.lastProgressAt || t.acceptedAt;
    const arrival =
      t.arrivalDueAt ||
      (t.acceptedAt &&
        new Date(
          +new Date(t.acceptedAt) + config.arrivalTimeoutMinutes * 60000,
        ));
    const expired =
      !!t.queueExpiresAt && new Date(t.queueExpiresAt) <= new Date();
    const stale =
      !!progress &&
      now - new Date(progress) >= config.noProgressMinutes * 60000;
    const missed = !!arrival && new Date(arrival) <= new Date();
    return {
      queueExpiresAt: t.queueExpiresAt,
      queueExpired: expired,
      arrivalDueAt: arrival,
      lastProgressAt: progress,
      rematchCount: t.rematchCount,
      maxRematches: config.maxRematches,
      noProgress: stale,
      missedArrivalDeadline: missed,
      rematchEligible:
        t.status === "2" &&
        t.type !== "WALK_IN" &&
        (stale || missed) &&
        !this.near(profile, t) &&
        t.rematchCount < config.maxRematches,
    };
  }
  static async recordProgress(profile, transaction) {
    if (
      profile.kind === "SHOP" ||
      profile.locationQuality !== "GOOD" ||
      !profile.lastTrustedRecordedAt ||
      Date.now() - new Date(profile.lastTrustedRecordedAt) > 120000 ||
      new Date(profile.lastTrustedRecordedAt) > new Date(Date.now() + 30000)
    )
      return;
    const rows = await Ticket.findAll({
      where: { providerId: profile.id, status: "2" },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const t of rows) {
      const distance = distanceMeters(profile, {
        latitude: t.pickupLatitude,
        longitude: t.pickupLongitude,
      });
      const prior = t.lastProgressDistanceMeters ?? t.assignmentDistanceMeters;
      if (
        Number.isFinite(prior) &&
        prior - distance >= config.minProgressMeters
      )
        await t.update(
          {
            lastProgressAt: new Date(),
            lastProgressDistanceMeters: distance,
            noShowDetectedAt: null,
          },
          { transaction },
        );
    }
  }
  static async rematch(actor, id, data) {
    const Dispatch = require("./dispatch.service");
    return Dispatch.fresh(actor, id, data, async (t, transaction) => {
      Policy.rider(actor, t);
      if (t.type === "WALK_IN")
        Policy.fail(
          "DISPATCH_REMATCH_NOT_ALLOWED",
          "Phiếu tại tiệm không tự chuyển cho thợ khác",
        );
      Policy.state(t, ["2"]);
      const p = await Provider.findByPk(t.providerId, { transaction });
      const state = this.status(t, p);
      if (this.near(p, t))
        Policy.fail(
          "DISPATCH_PROVIDER_ALREADY_NEAR",
          "Đối tác đã gần điểm đón; hãy xác nhận đến nơi hoặc gọi hỗ trợ",
        );
      if (t.rematchCount >= config.maxRematches)
        Policy.fail(
          "DISPATCH_REMATCH_LIMIT",
          "Đã hết lượt tìm lại; hãy yêu cầu hỗ trợ",
        );
      if (
        data.reason === "NO_PROGRESS"
          ? !state.noProgress
          : !state.missedArrivalDeadline
      )
        Policy.fail(
          "DISPATCH_REMATCH_NOT_DUE",
          "Chưa đến hạn yêu cầu tìm lại đối tác",
        );
      const fields = {
        status: "1",
        providerId: null,
        targetProviderId: null,
        acceptedAt: null,
        arrivedAt: null,
        arrivalDueAt: null,
        lastProgressAt: null,
        lastProgressDistanceMeters: null,
        noShowDetectedAt: null,
        safetyEscalatedAt: null,
        queueExpiresAt: this.queueDeadline(),
        rematchCount: t.rematchCount + 1,
        waitingEndedAt: null,
        waitingMinutes: 0,
        waitingFee: "0.00",
        callOutFee: "0.00",
        assignmentDistanceMeters: null,
        formerAssignedShopIds: [...new Set([...t.formerAssignedShopIds, p.id])],
        formerAssignedUserIds: [
          ...new Set([...t.formerAssignedUserIds, p.userId]),
        ],
        ...(t.type === "SOS" && { travelFee: "0.00" }),
      };
      fields.totalAmount = Policy.total({ ...t.get(), ...fields });
      await Dispatch.change(t, actor, "RIDER_REMATCH", fields, transaction, {
        reason: data.reason,
        note: data.note || null,
        previousProviderId: p.id,
        paymentReconciliationRequired: true,
      });
      AvailabilityRefresh(p, transaction);
      const open = await Support.findOne({
        where: {
          ticketId: id,
          status: "OPEN",
          reason: { [Op.in]: ["NO_PROGRESS", "MISSED_ETA"] },
        },
        transaction,
      });
      if (open)
        await open.update(
          {
            status: "RESOLVED",
            resolution: "Đã tìm lại theo yêu cầu khách",
            resolvedBy: actor.userId,
            resolvedAt: new Date(),
          },
          { transaction },
        );
      return Dispatch.dto(t);
    });
  }
  static async check(t, transaction) {
    const Dispatch = require("./dispatch.service");
    const system = { userId: t.userId, system: true };
    if (await Intake.expire(t, transaction))
      await Dispatch.change(t, system, "INTAKE_EXPIRED", {}, transaction);
    if (
      PENDING.includes(t.status) &&
      !t.providerId &&
      t.queueExpiresAt &&
      t.queueExpiresAt <= new Date()
    ) {
      if (t.handoffKind === "TOW_DELIVERY") {
        if (!t.safetyEscalatedAt) {
          await Dispatch.change(
            t,
            system,
            "INTAKE_TIMEOUT_DETECTED",
            { safetyEscalatedAt: new Date() },
            transaction,
          );
          await require("./dispatch_support.service").open(
            t,
            system,
            {
              reason: "INTAKE_TIMEOUT",
              note: "Xe đã giao, tiệm chưa tiếp nhận; giữ nguyên trách nhiệm và chỗ",
            },
            transaction,
          );
        }
      } else
        await Dispatch.change(
          t,
          system,
          "QUEUE_EXPIRED",
          {
            status: "5",
            cancelReason: "NO_PROVIDER_TIMEOUT",
            chargesVoided: true,
            totalAmount: "0.00",
          },
          transaction,
        );
      return;
    }
    if (t.status === "2" && t.type !== "WALK_IN") {
      const profile = await Provider.findByPk(t.providerId, { transaction });
      const state = this.status(t, profile);
      if (
        (state.noProgress || state.missedArrivalDeadline) &&
        !this.near(profile, t) &&
        !t.noShowDetectedAt
      )
        await Dispatch.change(
          t,
          system,
          "NO_PROGRESS_DETECTED",
          { noShowDetectedAt: new Date() },
          transaction,
          { lastProgressAt: t.lastProgressAt, arrivalDueAt: t.arrivalDueAt },
        );
    }
    if (t.status === "6" && t.type === "TOW" && !t.safetyEscalatedAt) {
      const p = await Provider.findByPk(t.providerId, { transaction });
      const trusted = p?.lastTrustedLocationAt;
      const stale =
        !trusted ||
        Date.now() - new Date(trusted) >= config.noProgressMinutes * 60000;
      const shop = t.dropoffShopId
        ? await Provider.findByPk(t.dropoffShopId, { transaction })
        : null;
      const unavailable =
        t.dropoffShopId &&
        (!shop || shop.status !== "ACTIVE" || shop.suspended);
      if (stale || unavailable) {
        await Dispatch.change(
          t,
          system,
          "TRANSPORT_ASSISTANCE_REQUIRED",
          { safetyEscalatedAt: new Date() },
          transaction,
        );
        await require("./dispatch_support.service").open(
          t,
          system,
          {
            reason: unavailable
              ? "DESTINATION_UNAVAILABLE"
              : "GPS_LOST_IN_TRANSIT",
            note: "Chỉ cảnh báo hỗ trợ; không tự hủy cuốc hoặc nhả xe đang chở",
          },
          transaction,
        );
      }
    }
  }
  static async backfillIntakes() {
    const rows = await Ticket.findAll({
      where: {
        type: "TOW",
        dropoffShopId: { [Op.ne]: null },
        intakeReservationId: null,
        status: { [Op.in]: ["1", "13", "14", "2", "3", "6"] },
      },
      limit: 100,
    });
    const Dispatch = require("./dispatch.service");
    for (const row of rows)
      await Dispatch.fresh(
        { userId: row.userId, system: true },
        row.id,
        {},
        async (t, transaction) => {
          if (!t.intakeReservationId)
            await Intake.request(t, transaction, {
              legacyTransit: t.status === "6",
            });
        },
      );
    return rows.length;
  }
  static async run() {
    const Dispatch = require("./dispatch.service");
    await require('./dispatch_offer.service').sweep();
    let cursor;
    // Walk stable UUID pages, not updatedAt: unchanged old rows must not starve later work.
    for (;;) {
      const rows = await Ticket.findAll({
        where: {
          status: { [Op.notIn]: ["4", "5", "8", "12", "15"] },
          ...(cursor && { id: { [Op.gt]: cursor } }),
        },
        order: [["id", "ASC"]],
        limit: 200,
      });
      if (!rows.length) break;
      for (const t of rows)
        try {
          await Dispatch.fresh(
            { userId: t.userId, system: true },
            t.id,
            {},
            async (current, transaction) => {
              if (
                current.type === "TOW" &&
                current.dropoffShopId &&
                !current.intakeReservationId &&
                ["1", "13", "14", "2", "3", "6"].includes(current.status)
              )
                await Intake.request(current, transaction, {
                  legacyTransit: current.status === "6",
                });
              await Intake.backfillDelivered(current, transaction);
              await this.check(current, transaction);
            },
          );
        } catch (error) {
          console.error(
            "[Dispatch operations]",
            t.id,
            error.errorCode || error.name,
          );
        }
      cursor = rows.at(-1).id;
    }
  }
}
function AvailabilityRefresh(profile, transaction) {
  if (profile)
    require("./provider_availability.service").afterDispatchChange(
      profile,
      transaction,
    );
}
module.exports = Liveness;
