const { Op } = require("sequelize");
const {
  ShopIntakeReservation: Reservation,
  DispatchSupportCase: Support,
  Provider,
  User,
  DispatchTicket: Ticket,
} = require("../models");
const Availability = require("./provider_availability.service");
const Capabilities = require("./provider_capability.service");
const Policy = require("./dispatch_policy.service");
const config = require("../config/app.config").operations;
const fail = Policy.fail;
const slots = ["ACCEPTED", "IN_TRANSIT", "DELIVERED"];
class Intake {
  static async current(t, transaction) {
    return t.intakeReservationId
      ? Reservation.findOne({
          where: { id: t.intakeReservationId, ticketId: t.id },
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : null;
  }
  static async update(row, data, transaction) {
    await row.update(data, { transaction });
    const shop = await Provider.findByPk(row.shopId, { transaction });
    if (shop) Availability.afterDispatchChange(shop, transaction);
    return row;
  }
  static async release(row, reason, transaction) {
    if (row && ["REQUESTED", "ACCEPTED"].includes(row.status))
      await this.update(row, { status: "RELEASED", reason }, transaction);
  }
  static async request(
    t,
    transaction,
    { candidateShopId, legacyTransit = false } = {},
  ) {
    const candidate = !!candidateShopId;
    const shopId = candidateShopId || t.dropoffShopId;
    if (!shopId) return null;
    const old = candidate
      ? t.candidateIntakeReservationId &&
        (await Reservation.findByPk(t.candidateIntakeReservationId, {
          transaction,
        }))
      : await this.current(t, transaction);
    if (
      old &&
      old.shopId === shopId &&
      ((old.status === "REQUESTED" && old.requestExpiresAt > new Date()) ||
        (old.status === "ACCEPTED" && old.holdUntil > new Date()) ||
        ["IN_TRANSIT", "DELIVERED"].includes(old.status))
    )
      return old;
    await this.release(old, "REPLACED_REQUEST", transaction);
    const version = t.intakeVersion + 1;
    const row = await Reservation.create(
      {
        ticketId: t.id,
        shopId,
        version,
        status: legacyTransit ? "IN_TRANSIT" : "REQUESTED",
        requestExpiresAt: new Date(
          Date.now() + config.intakeReplyMinutes * 60000,
        ),
        ...(legacyTransit && { reason: "LEGACY_TRANSPORT_IN_PROGRESS" }),
      },
      { transaction },
    );
    await t.update(
      {
        intakeVersion: version,
        ...(candidate
          ? { candidateShopId: shopId, candidateIntakeReservationId: row.id }
          : { intakeReservationId: row.id }),
      },
      { transaction },
    );
    if (legacyTransit) {
      const shop = await Provider.findByPk(shopId, { transaction });
      if (shop) Availability.afterDispatchChange(shop, transaction);
    }
    return row;
  }
  static async backfillDelivered(child, transaction) {
    if (
      child.type !== "WALK_IN" ||
      child.handoffKind !== "TOW_DELIVERY" ||
      child.providerId ||
      !child.parentTicketId
    )
      return;
    const parent = await Ticket.findByPk(child.parentTicketId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (
      !parent ||
      parent.type !== "TOW" ||
      parent.childTicketId !== child.id ||
      parent.intakeReservationId ||
      !parent.dropoffShopId
    )
      return;
    const row = await Reservation.create(
      {
        ticketId: parent.id,
        shopId: parent.dropoffShopId,
        childTicketId: child.id,
        version: parent.intakeVersion + 1,
        status: "DELIVERED",
        requestExpiresAt: child.createdAt,
        reason: "LEGACY_DELIVERY_AWAITING_INTAKE",
      },
      { transaction },
    );
    await parent.update(
      { intakeVersion: row.version, intakeReservationId: row.id },
      { transaction },
    );
    const shop = await Provider.findByPk(row.shopId, { transaction });
    if (shop) Availability.afterDispatchChange(shop, transaction);
  }
  static async valid(row, t, transaction) {
    if (
      !row ||
      row.shopId !== t.dropoffShopId ||
      row.status !== "ACCEPTED" ||
      !row.holdUntil ||
      row.holdUntil <= new Date()
    )
      fail(
        "INTAKE_CONFIRMATION_REQUIRED",
        "Tiệm đích chưa xác nhận hoặc chỗ giữ đã hết hạn",
      );
    const shop = await Provider.findByPk(row.shopId, { transaction });
    const owner = shop
      ? await User.findOne({ where: { userId: shop.userId }, transaction })
      : null;
    if (
      !shop ||
      shop.status !== "ACTIVE" ||
      shop.suspended ||
      (shop.requiresApproval &&
        shop.reviewedRevision !== shop.profileRevision) ||
      owner?.status !== "ACTIVE" ||
      !owner.emailVerifiedAt ||
      !Capabilities.matches(shop, {
        vehicleType: t.vehicleSnapshot.type,
        requiredCapabilities: t.requirements.repairCapabilities || [],
      })
    )
      fail(
        "INTAKE_DESTINATION_UNAVAILABLE",
        "Tiệm đích hiện không thể tiếp nhận, cần chọn lại hoặc yêu cầu hỗ trợ",
      );
    return shop;
  }
  static async beforeStart(t, transaction) {
    if (t.type !== "TOW" || !t.dropoffShopId) return;
    const row = await this.current(t, transaction);
    await this.valid(row, t, transaction);
    await this.update(row, { status: "IN_TRANSIT" }, transaction);
  }
  static async delivered(t, child, transaction) {
    if (!t.dropoffShopId) return;
    const row = await this.current(t, transaction);
    if (!row || row.status !== "IN_TRANSIT" || row.shopId !== t.dropoffShopId)
      fail(
        "INTAKE_RESERVATION_MISSING",
        "Thiếu cam kết tiếp nhận đang vận chuyển",
      );
    await this.update(
      row,
      { status: "DELIVERED", childTicketId: child.id },
      transaction,
    );
  }
  static async consume(child, shopId, transaction) {
    const row = await Reservation.findOne({
      where: { childTicketId: child.id, status: "DELIVERED" },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (row) {
      if (row.shopId !== shopId)
        fail("INTAKE_SHOP_MISMATCH", "Tiệm nhận không khớp cam kết");
      await this.update(row, { status: "CONSUMED" }, transaction);
    }
    return row;
  }
  static async onChange(t, action, transaction) {
    if (t.type === "TOW") {
      if (action === "RETARGET") {
        await this.release(
          await this.current(t, transaction),
          "DESTINATION_CHANGED",
          transaction,
        );
        const candidate = t.candidateIntakeReservationId
          ? await Reservation.findByPk(t.candidateIntakeReservationId, {
              transaction,
            })
          : null;
        await this.release(candidate, "DESTINATION_CHANGED", transaction);
        await t.update(
          {
            intakeReservationId: null,
            candidateIntakeReservationId: null,
            candidateShopId: null,
          },
          { transaction },
        );
        if (t.dropoffShopId) await this.request(t, transaction);
      }
      if (["5", "8", "12", "15"].includes(t.status)) {
        await this.release(
          await this.current(t, transaction),
          "TICKET_CLOSED",
          transaction,
        );
        const candidate = t.candidateIntakeReservationId
          ? await Reservation.findByPk(t.candidateIntakeReservationId, {
              transaction,
            })
          : null;
        await this.release(candidate, "TICKET_CLOSED", transaction);
      }
    } else if (
      t.type === "WALK_IN" &&
      ["4", "5", "8", "12", "15"].includes(t.status)
    ) {
      const row = await Reservation.findOne({
        where: { childTicketId: t.id, status: "DELIVERED" },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (row)
        await this.update(
          row,
          { status: "RELEASED", reason: "INTAKE_ENDED" },
          transaction,
        );
    }
  }
  static async read(actor, t, transaction) {
    const ids = [t.intakeReservationId, t.candidateIntakeReservationId].filter(
      Boolean,
    );
    if (!ids.length) return [];
    let rows = await Reservation.findAll({
      where: { id: { [Op.in]: ids } },
      transaction,
    });
    if (actor.userId !== t.userId && actor.role !== "admin") {
      const owned = await Provider.findAll({
        where: { userId: actor.userId },
        attributes: ["id"],
        transaction,
      });
      const ownIds = owned.map((p) => p.id);
      if (!ownIds.includes(t.providerId))
        rows = rows.filter((r) => ownIds.includes(r.shopId));
    }
    return rows.map((row) => ({
      ...row.toJSON(),
      isCandidate: row.id === t.candidateIntakeReservationId,
      expired:
        row.status === "REQUESTED"
          ? row.requestExpiresAt <= new Date()
          : row.status === "ACCEPTED"
            ? row.holdUntil <= new Date()
            : false,
    }));
  }
  static async decide(actor, id, decision, data) {
    const Dispatch = require("./dispatch.service");
    return Dispatch.fresh(actor, id, data, async (t, transaction) => {
      if (t.type !== "TOW")
        fail("INTAKE_NOT_APPLICABLE", "Chỉ cuốc kéo xe có cam kết tiệm đích");
      const allowed = [t.intakeReservationId, t.candidateIntakeReservationId];
      if (!allowed.includes(data.reservationId))
        fail("INTAKE_STALE_REQUEST", "Yêu cầu tiếp nhận đã thay đổi");
      const row = await Reservation.findOne({
        where: { id: data.reservationId, ticketId: id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const shop = row
        ? await Provider.findOne({
            where: { id: row.shopId, userId: actor.userId },
            transaction,
          })
        : null;
      if (!shop) fail("DISPATCH_TICKET_NOT_FOUND", "Không tìm thấy phiếu", 404);
      const candidate = row.id === t.candidateIntakeReservationId;
      if (["IN_TRANSIT", "DELIVERED", "CONSUMED"].includes(row.status))
        fail(
          "INTAKE_IN_TRANSIT_LOCKED",
          "Không được bỏ cam kết khi xe đã vận chuyển; hãy yêu cầu hỗ trợ",
        );
      if (decision === "accept") {
        if (row.status === "ACCEPTED" && row.holdUntil > new Date()) return row;
        if (row.status !== "REQUESTED" || row.requestExpiresAt <= new Date())
          fail(
            "INTAKE_REQUEST_EXPIRED",
            "Yêu cầu đã hết hạn hoặc không chờ xác nhận",
          );
        if (
          (!candidate && !["1", "13", "14", "2", "3"].includes(t.status)) ||
          (candidate && t.status !== "6")
        )
          fail(
            "DISPATCH_INVALID_STATE_TRANSITION",
            "Giai đoạn cuốc không nhận xác nhận này",
          );
        await Availability.lockForAssignment(
          shop.id,
          {
            vehicleType: t.vehicleSnapshot.type,
            requiredCapabilities: t.requirements.repairCapabilities || [],
          },
          transaction,
        );
        await this.update(
          row,
          {
            status: "ACCEPTED",
            acceptedAt: new Date(),
            holdUntil: new Date(Date.now() + config.intakeHoldMinutes * 60000),
          },
          transaction,
        );
      } else {
        if (row.status === "DECLINED") return row;
        if (!["REQUESTED", "ACCEPTED"].includes(row.status))
          fail("INTAKE_REQUEST_EXPIRED", "Yêu cầu không còn hiệu lực");
        await this.update(
          row,
          { status: "DECLINED", reason: data.reason },
          transaction,
        );
      }
      await Dispatch.change(
        t,
        actor,
        decision === "accept" ? "INTAKE_ACCEPTED" : "INTAKE_DECLINED",
        {},
        transaction,
        { reservationId: row.id, shopId: shop.id, reason: data.reason || null },
      );
      return row;
    });
  }
  static async requestAgain(actor, id, data) {
    const Dispatch = require("./dispatch.service");
    return Dispatch.fresh(actor, id, data, async (t, transaction) => {
      Policy.rider(actor, t);
      if (t.type !== "TOW" || !t.dropoffShopId)
        fail("INTAKE_NOT_APPLICABLE", "Phiếu không có tiệm đích");
      Policy.state(t, ["1", "13", "14", "2", "3"]);
      const before = t.intakeReservationId;
      const row = await this.request(t, transaction);
      if (before !== row.id)
        await Dispatch.change(t, actor, "INTAKE_REQUESTED", {}, transaction, {
          reservationId: row.id,
        });
      return row;
    });
  }
  static async propose(actor, id, data) {
    const Dispatch = require("./dispatch.service");
    return Dispatch.fresh(actor, id, data, async (t, transaction) => {
      await require("./finance_lock.service").admin(actor, transaction);
      if (t.type !== "TOW" || t.status !== "6")
        fail(
          "DISPATCH_INVALID_STATE_TRANSITION",
          "Chỉ điều phối hỗ trợ cuốc đang vận chuyển",
        );
      if (
        !(await Support.findOne({
          where: { ticketId: id, status: "OPEN" },
          transaction,
        }))
      )
        fail(
          "DISPATCH_SUPPORT_REQUIRED",
          "Cần hồ sơ hỗ trợ đang mở trước khi điều hướng xe đang chở",
        );
      if (data.dropoffShopId === t.dropoffShopId)
        fail("INTAKE_SAME_DESTINATION", "Cần chọn tiệm khác");
      await Dispatch.destination(
        { userId: t.userId },
        data,
        t.requirements,
        transaction,
      );
      const row = await this.request(t, transaction, {
        candidateShopId: data.dropoffShopId,
      });
      await Dispatch.change(
        t,
        actor,
        "ALTERNATIVE_INTAKE_REQUESTED",
        {},
        transaction,
        { reservationId: row.id, reason: data.reason, fareUnchanged: true },
      );
      return row;
    });
  }
  static async confirmAlternative(actor, id, data, reject = false) {
    const Dispatch = require("./dispatch.service");
    return Dispatch.fresh(actor, id, data, async (t, transaction) => {
      Policy.rider(actor, t);
      Policy.state(t, ["6"]);
      if (
        t.type !== "TOW" ||
        !t.candidateIntakeReservationId ||
        t.candidateIntakeReservationId !== data.reservationId
      )
        fail("INTAKE_STALE_REQUEST", "Không có phương án đích tương ứng");
      const row = await Reservation.findByPk(t.candidateIntakeReservationId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (reject) {
        await this.release(row, "RIDER_DECLINED", transaction);
        await Dispatch.change(
          t,
          actor,
          "ALTERNATIVE_INTAKE_REJECTED",
          { candidateShopId: null, candidateIntakeReservationId: null },
          transaction,
          { reservationId: row.id },
        );
        return Dispatch.dto(t);
      }
      const destination = await Dispatch.destination(
        { userId: t.userId },
        { dropoffShopId: row.shopId },
        t.requirements,
        transaction,
      );
      await this.valid(
        row,
        { ...t.get(), dropoffShopId: row.shopId },
        transaction,
      );
      const previous = await this.current(t, transaction);
      if (previous) {
        if (previous.status !== "IN_TRANSIT")
          fail("INTAKE_IN_TRANSIT_LOCKED", "Cam kết gốc không khớp giai đoạn");
        await this.update(
          previous,
          { status: "RELEASED", reason: "ASSISTED_RETARGET" },
          transaction,
        );
      }
      await this.update(row, { status: "IN_TRANSIT" }, transaction);
      await Dispatch.change(
        t,
        actor,
        "DESTINATION_CONFIRMED",
        {
          ...destination,
          intakeReservationId: row.id,
          candidateShopId: null,
          candidateIntakeReservationId: null,
          estimateAmount: null,
          estimateExpiresAt: null,
          estimateStatus: null,
          estimateVersion: t.estimateVersion + 1,
        },
        transaction,
        { reservationId: row.id, fareUnchanged: true },
      );
      return Dispatch.dto(t);
    });
  }
  static async expire(t, transaction) {
    const rows = await Reservation.findAll({
      where: {
        id: {
          [Op.in]: [
            t.intakeReservationId,
            t.candidateIntakeReservationId,
          ].filter(Boolean),
        },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    let changed = false;
    for (const row of rows)
      if (
        (row.status === "REQUESTED" && row.requestExpiresAt <= new Date()) ||
        (row.status === "ACCEPTED" && row.holdUntil <= new Date())
      ) {
        await this.update(
          row,
          { status: "EXPIRED", reason: "DEADLINE_REACHED" },
          transaction,
        );
        changed = true;
      }
    return changed;
  }
}
Intake.SLOT_STATUSES = slots;
module.exports = Intake;
