const { Op } = require("sequelize");
const { randomUUID, createHash } = require("node:crypto");
const db = require("../config/postgres.config");
const {
  DispatchTicket: Ticket,
  DispatchEvent: Event,
  DispatchNotification: Notification,
  Provider,
  User,
  S3Asset,
} = require("../models");
const Policy = require("./dispatch_policy.service");
const Availability = require("./provider_availability.service");
const Capabilities = require("./provider_capability.service");
const Chat = require("./chat.service");
const Notify = require("./dispatch_notification.service");
const Payment = require("./dispatch_payment.service");
const Money = require("../utils/money.util");
const retry = require("../utils/transaction_retry.util");
const { distanceMeters } = require("../utils/geo.util");
const {
  STATUS: S,
  TERMINAL,
  PENDING,
  KIND,
} = require("../common/dispatch.constants");
const {
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} = require("../common/exceptions/BaseException");
const errors = require("../common/exceptions/error_codes");
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, stable(value[k])]),
        )
      : value;
class Dispatch {
  static async transaction(work) {
    try {
      return await retry(() =>
        db.transaction(async (transaction) => {
          await db.query("SET LOCAL lock_timeout = '3s'", { transaction });
          await db.query("SET LOCAL statement_timeout = '15s'", {
            transaction,
          });
          return work(transaction);
        }),
      );
    } catch (error) {
      if (
        error.name === "SequelizeUniqueConstraintError" &&
        /dispatch_tickets_vehicle_profile_id/.test(
          error.original?.constraint || "",
        )
      ) {
        const vehicleId =
          error.fields?.vehicle_profile_id || error.fields?.vehicleProfileId;
        const active = vehicleId
          ? await Ticket.findOne({
              where: {
                vehicleProfileId: vehicleId,
                status: { [Op.notIn]: TERMINAL },
              },
            })
          : null;
        throw new ConflictException(
          errors.VEHICLE_BUSY,
          active ? { dispatchTicketId: active.id } : null,
        );
      }
      throw error;
    }
  }
  static async assets(actor, ids, reference, transaction, min = 0, max = 5) {
    if (
      !Array.isArray(ids) ||
      ids.length < min ||
      ids.length > max ||
      new Set(ids).size !== ids.length
    )
      throw new BadRequestException("Số ảnh không hợp lệ");
    const urls = [];
    for (const id of [...ids].sort()) {
      const asset = await S3Asset.findOne({
        where: { id, userId: actor.userId, attachedTo: null },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!asset || !asset.mimeType.startsWith("image/"))
        Policy.fail(
          "DISPATCH_INVALID_EVIDENCE",
          "Ảnh không thuộc tài khoản hoặc đã được sử dụng",
          400,
        );
      await asset.update({ attachedTo: reference }, { transaction });
      urls.push(asset.s3Url);
    }
    return urls;
  }
  static async change(
    ticket,
    actor,
    action,
    fields,
    transaction,
    details = {},
  ) {
    const from = ticket.status;
    await ticket.update(
      { ...fields, revision: ticket.revision + 1 },
      { transaction },
    );
    await Event.create(
      {
        ticketId: ticket.id,
        actorId: actor.system ? null : actor.userId,
        action,
        fromStatus: from,
        toStatus: ticket.status,
        revision: ticket.revision,
        details,
      },
      { transaction },
    );
    const system = await Chat.systemMessage(
      ticket,
      action === "UNFIXABLE"
        ? "UNFIXABLE"
        : action === "TOW_OFFER"
          ? "TOW_OFFER"
          : "STATUS_CHANGED",
      `${action}: ${ticket.status}`,
      transaction,
    );
    transaction.afterCommit(() => {
      try {
        Notify.broadcastChat(ticket, Chat.dto(system));
      } catch (error) {
        console.error("[Dispatch chat delivery]", error.message);
      }
    });
    if (ticket.providerId) {
      const p = await Provider.findByPk(ticket.providerId, { transaction });
      if (p) Availability.afterDispatchChange(p, transaction);
    }
    await require("./bill.service").syncJourney(ticket.journeyId, transaction);
    await Notify.enqueue(ticket, actor.userId, "dispatch-updated", transaction);
    return ticket;
  }
  static async fresh(actor, id, data, work) {
    return this.transaction(async (transaction) => {
      const snapshot = await Ticket.findByPk(id, { transaction });
      if (!snapshot)
        throw new NotFoundException(errors.DISPATCH_TICKET_NOT_FOUND);
      await Policy.locks(actor, snapshot, data, transaction);
      const ticket = await Ticket.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        ["providerId", "dropoffShopId", "targetProviderId"].some(
          (key) => ticket[key] !== snapshot[key],
        )
      ) {
        const e = new Error("Assignment changed");
        e.original = { code: "40001" };
        throw e;
      }
      if (
        data.expectedRevision !== undefined &&
        data.expectedRevision !== ticket.revision
      )
        Policy.fail(
          "DISPATCH_STALE_REVISION",
          "Phiếu đã thay đổi, vui lòng tải lại",
          409,
          { revision: ticket.revision },
        );
      return work(ticket, transaction);
    });
  }
  static async destination(actor, data, requirements, transaction) {
    if (data.dropoffShopId) {
      const p = await Provider.findByPk(data.dropoffShopId, { transaction });
      if (
        !p ||
        p.kind !== "SHOP" ||
        p.userId === actor.userId ||
        p.status !== "ACTIVE" ||
        p.suspended ||
        (p.requiresApproval && p.reviewedRevision !== p.profileRevision) ||
        !Capabilities.matches(p, {
          vehicleType: requirements.vehicleType,
          requiredCapabilities: requirements.repairCapabilities || [],
        })
      )
        Policy.fail(
          "DISPATCH_DESTINATION_UNAVAILABLE",
          "Tiệm đích không hợp lệ hoặc không phục vụ loại xe",
        );
      const owner = await User.findOne({
        where: { userId: p.userId },
        transaction,
      });
      if (owner?.status !== "ACTIVE" || !owner.emailVerifiedAt)
        Policy.fail(
          "DISPATCH_DESTINATION_UNAVAILABLE",
          "Tiệm đích không hoạt động",
        );
      return {
        dropoffShopId: p.id,
        dropoffLatitude: p.latitude,
        dropoffLongitude: p.longitude,
        dropoffAddress: p.address,
      };
    }
    if (
      !Number.isFinite(data.dropoffLatitude) ||
      !Number.isFinite(data.dropoffLongitude)
    )
      throw new BadRequestException("Cuốc kéo xe bắt buộc có điểm giao xe");
    return {
      dropoffShopId: null,
      dropoffLatitude: data.dropoffLatitude,
      dropoffLongitude: data.dropoffLongitude,
      dropoffAddress: data.dropoffAddress || null,
    };
  }
  static async createRecord(actor, type, data, transaction, source) {
    const { vehicle, snapshot } = await Policy.vehicle(
      actor.userId,
      source?.vehicleProfileId || data.vehicleProfileId,
      transaction,
    );
    await Policy.busy(vehicle.id, transaction);
    if (
      type === "WALK_IN" &&
      !source &&
      (snapshot.type !== "BIKE" || snapshot.rideMode !== "SOLO")
    )
      Policy.fail(
        "DISPATCH_WALK_IN_BIKE_ONLY",
        "Điểm danh trực tiếp chỉ áp dụng cho xe máy đi SOLO",
        400,
      );
    const requirements = Policy.requirements(
      type,
      snapshot,
      data.requiredCapabilities ||
        source?.requirements.repairCapabilities ||
        source?.requirements.requiredCapabilities.filter((c) => c !== "TOWING"),
    );
    const pricingSnapshot = source ? source.pricingSnapshot : Policy.pricing();
    let pickupLatitude = data.pickupLatitude ?? source?.pickupLatitude,
      pickupLongitude = data.pickupLongitude ?? source?.pickupLongitude,
      pickupAddress = data.pickupAddress ?? source?.pickupAddress;
    let targetProviderId = data.providerId || null;
    if (type === "WALK_IN") {
      const shop = await Provider.findByPk(targetProviderId, { transaction });
      if (!shop || shop.kind !== "SHOP" || shop.userId === actor.userId)
        throw new NotFoundException(errors.PROVIDER_NOT_FOUND);
      if (!source) {
        await Availability.lockForAssignment(
          shop.id,
          requirements,
          transaction,
        );
        Policy.location(data.location, shop);
      }
      pickupLatitude = shop.latitude;
      pickupLongitude = shop.longitude;
      pickupAddress = shop.address;
    }
    if (type === "TOW" && targetProviderId) {
      const direct = await Availability.lockForAssignment(
        targetProviderId,
        requirements,
        transaction,
      );
      Policy.providerKind(direct, type);
      if (direct.userId === actor.userId)
        Policy.fail("DISPATCH_SELF_ASSIGNMENT", "Không thể tự nhận cuốc");
    }
    const destination =
      type === "TOW"
        ? await this.destination(actor, data, requirements, transaction)
        : {};
    if (!Number.isFinite(pickupLatitude) || !Number.isFinite(pickupLongitude))
      throw new BadRequestException("Cần tọa độ điểm đón");
    const previousOwner = source?.providerId
      ? await Provider.findByPk(source.providerId, {
          transaction,
          attributes: ["userId"],
        })
      : null;
    const id = randomUUID();
    const images = source
      ? source.images
      : await this.assets(
          actor,
          data.assetIds || [],
          `dispatch:${id}`,
          transaction,
        );
    const ticket = await Ticket.create(
      {
        id,
        code: `RA-${type === "WALK_IN" ? "WI" : type}-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
        journeyId: source?.journeyId || randomUUID(),
        userId: actor.userId,
        vehicleProfileId: vehicle.id,
        vehicleSnapshot: snapshot,
        pricingSnapshot,
        requirements,
        type,
        pickupLatitude,
        pickupLongitude,
        pickupAddress,
        ...destination,
        targetProviderId,
        description: data.description ?? source?.description,
        images,
        ...(source && {
          parentTicketId: source.id,
          handoffKind: data.handoffKind,
          formerAssignedUserIds:
            source.type === type
              ? [
                  ...new Set([
                    ...(source.formerAssignedUserIds || []),
                    ...(previousOwner ? [previousOwner.userId] : []),
                  ]),
                ]
              : [],
          formerAssignedShopIds: [
            ...new Set([
              ...source.formerAssignedShopIds,
              ...(source.providerId ? [source.providerId] : []),
            ]),
          ],
        }),
        ...(data.clientRequestId && {
          clientRequestId: data.clientRequestId,
          requestFingerprint: createHash("sha256")
            .update(JSON.stringify(stable({ ...data, type })))
            .digest("hex"),
        }),
      },
      { transaction },
    );
    if (type === "TOW") {
      ticket.travelFee = Money.add(
        pricingSnapshot.towBaseFee,
        Money.amount(
          Math.ceil(
            distanceMeters(
              { latitude: pickupLatitude, longitude: pickupLongitude },
              {
                latitude: ticket.dropoffLatitude,
                longitude: ticket.dropoffLongitude,
              },
            ) / 1000,
          ) * Money.cents(pricingSnapshot.towPerKm),
        ),
      );
      ticket.totalAmount = Policy.total(ticket);
      await ticket.save({ transaction });
    }
    await Event.create(
      {
        ticketId: ticket.id,
        actorId: actor.system ? null : actor.userId,
        action: "CREATED",
        toStatus: ticket.status,
        revision: ticket.revision,
      },
      { transaction },
    );
    await Chat.synchronizeDispatch(ticket, transaction);
    await require("./bill.service").syncJourney(ticket.journeyId, transaction);
    await Notify.enqueue(ticket, actor.userId, "dispatch-created", transaction);
    return ticket;
  }
  static async create(actor, type, data) {
    const result = await this.transaction(async (transaction) => {
      await Policy.locks(actor, null, data, transaction);
      if (data.clientRequestId) {
        const existing = await Ticket.findOne({
          where: {
            userId: actor.userId,
            clientRequestId: data.clientRequestId,
          },
          transaction,
        });
        if (existing) {
          const hash = createHash("sha256")
            .update(JSON.stringify(stable({ ...data, type })))
            .digest("hex");
          if (existing.requestFingerprint !== hash)
            Policy.fail(
              "DISPATCH_IDEMPOTENCY_CONFLICT",
              "Mã yêu cầu đã dùng cho nội dung khác",
            );
          return existing;
        }
      }
      return this.createRecord(actor, type, data, transaction);
    });
    return this.dto(result);
  }
  static async accept(actor, id, data) {
    return this.fresh(actor, id, data, async (t, transaction) => {
      const p = await Provider.findOne({
        where: { id: data.providerId, userId: actor.userId },
        transaction,
      });
      if (!p || p.userId === t.userId)
        throw new NotFoundException(errors.PROVIDER_NOT_FOUND);
      if (t.providerId === p.id && t.status === S.MATCHED) return this.dto(t);
      Policy.state(t, PENDING);
      Policy.providerKind(p, t.type);
      if (t.targetProviderId && t.targetProviderId !== p.id)
        Policy.fail("DISPATCH_TARGET_MISMATCH", "Phiếu dành cho đối tác khác");
      if (
        t.formerAssignedShopIds.includes(p.id) ||
        t.formerAssignedUserIds.includes(actor.userId)
      )
        Policy.fail(
          "DISPATCH_PROVIDER_EXCLUDED",
          "Đối tác đã hủy hoặc từ chối phiếu này",
        );
      const profile = await Availability.lockForAssignment(
        p.id,
        t.requirements,
        transaction,
      );
      if (profile.kind !== "SHOP") Policy.freshFix(profile);
      const distance = distanceMeters(profile, {
        latitude: t.pickupLatitude,
        longitude: t.pickupLongitude,
      });
      if (distance > 15000)
        Policy.fail("DISPATCH_OUT_OF_RANGE", "Cuốc nằm ngoài bán kính 15km");
      let fields = {
        providerId: p.id,
        status: S.MATCHED,
        acceptedAt: new Date(),
        cancelReason: null,
        arrivedAt: null,
        waitingEndedAt: null,
        waitingMinutes: 0,
        waitingFee: "0.00",
        assignmentDistanceMeters: distance,
      };
      if (t.type === "SOS") {
        fields.callOutFee =
          distance <= 1000 ? "0.00" : t.pricingSnapshot.sosCallOutFee;
        fields.travelFee = Money.amount(
          Math.ceil(distance / 1000) * Money.cents(t.pricingSnapshot.sosPerKm),
        );
      }
      Object.assign(fields, {
        totalAmount: Policy.total({ ...t.get(), ...fields }),
      });
      await this.change(t, actor, "ACCEPT", fields, transaction);
      return this.dto(t);
    });
  }
  static async action(actor, id, action, data = {}) {
    return this.fresh(actor, id, data, async (t, transaction) => {
      const riderActions = [
        "approve-quote",
        "resolve",
        "start",
        "acknowledge-unfixable",
        "approve-estimate",
        "reject-estimate",
      ];
      let p;
      if (riderActions.includes(action)) Policy.rider(actor, t);
      else if (action === "arrive") {
        if (t.userId !== actor.userId)
          p = await Policy.profileActor(actor, t, transaction);
      } else if (action === "estimate")
        p = await Policy.profileActor(actor, t, transaction, {
          destination: true,
        });
      else
        p = await Policy.profileActor(actor, t, transaction, {
          target: action === "decline",
        });
      let fields = {};
      let details = {};
      switch (action) {
        case "arrive":
          if (t.type === "WALK_IN")
            Policy.fail(
              "DISPATCH_INVALID_STATE_TRANSITION",
              "Xe đã điểm danh tại tiệm khi tạo phiếu",
            );
          if (t.status === S.ARRIVED) return this.dto(t);
          Policy.state(t, [S.MATCHED]);
          p = await Provider.findByPk(t.providerId, { transaction });
          Policy.trustedLocation(p, {
            latitude: t.pickupLatitude,
            longitude: t.pickupLongitude,
          });
          fields = { status: S.ARRIVED, arrivedAt: new Date() };
          break;
        case "in-shop":
          if (t.type !== "WALK_IN")
            Policy.fail(
              "DISPATCH_INVALID_STATE_TRANSITION",
              "Chỉ tiệm được bắt đầu kiểm tra xe",
            );
          if (t.status === S.IN_SHOP) return this.dto(t);
          Policy.state(t, [S.MATCHED]);
          fields = { status: S.IN_SHOP };
          break;
        case "quote":
          if (Money.cents(data.amount) % 100)
            Policy.fail(
              "PAYMENT_VND_INTEGER_REQUIRED",
              "Báo giá VND phải nguyên đồng",
              400,
            );
          if (t.type === "TOW")
            Policy.fail(
              "DISPATCH_INVALID_STATE_TRANSITION",
              "Cước kéo xe được tính phía server",
            );
          if (t.quoteAmount !== null) {
            if (Money.cents(t.quoteAmount) === Money.cents(data.amount))
              return this.dto(t);
            throw new ConflictException(
              errors.DISPATCH_QUOTE_ALREADY_SUBMITTED,
            );
          }
          Policy.state(
            t,
            t.type === "WALK_IN" ? [S.MATCHED, S.IN_SHOP] : [S.ARRIVED],
          );
          fields = {
            quoteAmount: Money.amount(Money.cents(data.amount)),
            status: t.estimateStatus === "APPROVED" ? S.FINAL_QUOTED : S.QUOTED,
          };
          fields.totalAmount = Policy.total({ ...t.get(), ...fields });
          break;
        case "approve-quote":
          if (t.status === S.IN_PROGRESS) return this.dto(t);
          Policy.state(t, [S.QUOTED, S.FINAL_QUOTED]);
          await Payment.fundedForApproval(t, transaction);
          fields = { status: S.IN_PROGRESS };
          break;
        case "start":
          if (t.type !== "TOW")
            Policy.fail(
              "DISPATCH_INVALID_STATE_TRANSITION",
              "Chỉ xe kéo dùng thao tác bắt đầu vận chuyển",
            );
          if (t.status === S.IN_PROGRESS) return this.dto(t);
          Policy.state(t, [S.ARRIVED]);
          const waitingEnd = new Date();
          fields = {
            ...Policy.waiting(t, waitingEnd),
            waitingEndedAt: waitingEnd,
            status: S.IN_PROGRESS,
          };
          fields.totalAmount = Policy.total({ ...t.get(), ...fields });
          await Payment.fundedForApproval(
            { ...t.get(), ...fields },
            transaction,
          );
          break;
        case "ready":
          if (t.type === "TOW")
            Policy.fail(
              "DISPATCH_INVALID_STATE_TRANSITION",
              "Cuốc kéo xe nghiệm thu tại điểm giao",
            );
          if (t.status === S.READY) return this.dto(t);
          Policy.state(t, [S.IN_PROGRESS]);
          fields = { status: S.READY };
          break;
        case "resolve":
          if (t.status === S.RESOLVED) return this.dto(t);
          Policy.state(t, t.type === "TOW" ? [S.IN_PROGRESS] : [S.READY]);
          if (t.type === "TOW") {
            p = await Provider.findByPk(t.providerId, { transaction });
            Policy.trustedLocation(p, {
              latitude: t.dropoffLatitude,
              longitude: t.dropoffLongitude,
            });
          }
          fields = { status: S.RESOLVED, resolvedAt: new Date() };
          break;
        case "unfixable":
          if (t.type === "TOW")
            Policy.fail(
              "DISPATCH_INVALID_STATE_TRANSITION",
              "Xe kéo không báo lỗi sửa chữa",
            );
          if (t.status === S.UNFIXABLE) return this.dto(t);
          Policy.state(
            t,
            t.type === "WALK_IN"
              ? [S.MATCHED, S.IN_SHOP, S.QUOTED, S.FINAL_QUOTED, S.IN_PROGRESS]
              : [S.ARRIVED, S.QUOTED, S.IN_PROGRESS],
          );
          fields = {
            status: S.UNFIXABLE,
            unfixableReason: data.reason,
            unfixableImages: await this.assets(
              actor,
              data.assetIds || [],
              `unfixable:${t.id}`,
              transaction,
              1,
            ),
            quoteVoided: true,
            travelFee: "0.00",
            waitingFee: "0.00",
            totalAmount: t.type === "SOS" ? t.callOutFee : "0.00",
            resolvedAt: new Date(),
          };
          details = {
            previousTotal: t.totalAmount,
            paymentReconciliationRequired: true,
          };
          break;
        case "acknowledge-unfixable":
          if (t.status === S.RESOLVED_UNFIXABLE) return this.dto(t);
          Policy.state(t, [S.UNFIXABLE]);
          fields = { status: S.RESOLVED_UNFIXABLE, resolvedAt: new Date() };
          break;
        case "decline":
          Policy.state(t, [S.PENDING]);
          if (t.type !== "WALK_IN")
            Policy.fail(
              "DISPATCH_INVALID_STATE_TRANSITION",
              "Chỉ tiệm đích được từ chối phiếu tại tiệm",
            );
          fields = { status: S.DECLINED, cancelReason: data.reason };
          break;
        case "estimate":
          if (Money.cents(data.amount) % 100)
            Policy.fail(
              "PAYMENT_VND_INTEGER_REQUIRED",
              "Báo giá VND phải nguyên đồng",
              400,
            );
          if (t.type !== "TOW")
            Policy.fail(
              "DISPATCH_INVALID_STATE_TRANSITION",
              "Báo giá sơ bộ chỉ dành cho tiệm đích của cuốc kéo",
            );
          Policy.state(t, [...PENDING, S.MATCHED, S.ARRIVED]);
          if (
            p.status !== "ACTIVE" ||
            p.suspended ||
            (p.requiresApproval && p.reviewedRevision !== p.profileRevision)
          )
            Policy.fail(
              "DISPATCH_DESTINATION_UNAVAILABLE",
              "Tiệm đích không hoạt động",
            );
          if (t.estimateStatus === "APPROVED")
            Policy.fail(
              "DISPATCH_ESTIMATE_LOCKED",
              "Khách đã duyệt ước tính; cần thay tiệm để thay báo giá",
            );
          if (
            t.estimateStatus === "PENDING" &&
            Money.cents(t.estimateAmount) === Money.cents(data.amount) &&
            t.estimateExpiresAt > new Date()
          )
            return this.dto(t);
          fields = {
            estimateAmount: Money.amount(Money.cents(data.amount)),
            estimateExpiresAt: new Date(Date.now() + 86400000),
            estimateVersion: t.estimateVersion + 1,
            estimateStatus: "PENDING",
            ...(PENDING.includes(t.status) && { status: S.ESTIMATED }),
          };
          break;
        case "approve-estimate":
        case "reject-estimate":
          if (t.type !== "TOW")
            Policy.fail(
              "DISPATCH_INVALID_STATE_TRANSITION",
              "Phiếu không có ước tính tiệm đích",
            );
          Policy.state(t, [...PENDING, S.MATCHED, S.ARRIVED]);
          if (t.estimateVersion !== data.estimateVersion)
            Policy.fail("DISPATCH_STALE_ESTIMATE", "Báo giá sơ bộ đã thay đổi");
          if (!t.estimateExpiresAt || t.estimateExpiresAt <= new Date())
            Policy.fail(
              "DISPATCH_ESTIMATE_EXPIRED",
              "Ước tính đã hết hạn 24 giờ",
            );
          if (t.estimateStatus === "APPROVED" && action === "approve-estimate")
            return this.dto(t);
          if (t.estimateStatus !== "PENDING")
            Policy.fail(
              "DISPATCH_INVALID_STATE_TRANSITION",
              "Ước tính không chờ duyệt",
            );
          fields = {
            estimateStatus:
              action === "approve-estimate" ? "APPROVED" : "REJECTED",
            ...(PENDING.includes(t.status) && {
              status:
                action === "approve-estimate" ? S.EST_APPROVED : S.PENDING,
            }),
          };
          break;
        default:
          throw new BadRequestException("Thao tác không được hỗ trợ");
      }
      await this.change(
        t,
        actor,
        action.toUpperCase().replaceAll("-", "_"),
        fields,
        transaction,
        details,
      );
      if (action === "resolve" && t.type === "TOW" && t.dropoffShopId) {
        const child = await this.createRecord(
          { userId: t.userId },
          "WALK_IN",
          {
            providerId: t.dropoffShopId,
            handoffKind: "TOW_DELIVERY",
            requiredCapabilities: t.requirements.repairCapabilities || [],
            pickupLatitude: t.dropoffLatitude,
            pickupLongitude: t.dropoffLongitude,
          },
          transaction,
          t,
        );
        if (t.estimateStatus === "APPROVED" && t.estimateExpiresAt > new Date())
          await child.update(
            {
              estimateAmount: t.estimateAmount,
              estimateStatus: "APPROVED",
              estimateExpiresAt: t.estimateExpiresAt,
            },
            { transaction },
          );
        await this.link(t, child, transaction);
      }
      return action === "decline" ? Notify.summary(t) : this.dto(t);
    });
  }
  static async link(parent, child, transaction) {
    await parent.update(
      {
        childTicketId: child.id,
        linkedTicketIds: [...new Set([...parent.linkedTicketIds, child.id])],
      },
      { transaction },
    );
    await child.update(
      {
        linkedTicketIds: [
          ...new Set([
            parent.id,
            ...parent.linkedTicketIds.filter((id) => id !== child.id),
          ]),
        ],
      },
      { transaction },
    );
  }
  static async cancel(actor, id, data) {
    return this.fresh(actor, id, data, async (t, transaction) => {
      let p;
      const rider = t.userId === actor.userId;
      if (!rider)
        p = await Policy.profileActor(actor, t, transaction, { target: true });
      if (rider && t.status === S.CANCELLED) return this.dto(t);
      if (rider)
        Policy.state(t, [
          ...PENDING,
          S.MATCHED,
          S.ARRIVED,
          S.IN_SHOP,
          S.QUOTED,
          S.FINAL_QUOTED,
        ]);
      else Policy.state(t, [S.MATCHED, S.ARRIVED]);
      const old = t.providerId
        ? await Provider.findByPk(t.providerId, { transaction })
        : null;
      let fields = {
        status: S.CANCELLED,
        cancelReason: data.reason,
        waitingEndedAt: new Date(),
        chargesVoided: true,
      };
      if (!rider && t.type !== "WALK_IN")
        fields = {
          status: S.PENDING,
          providerId: null,
          targetProviderId: null,
          acceptedAt: null,
          arrivedAt: null,
          waitingEndedAt: null,
          waitingMinutes: 0,
          waitingFee: "0.00",
          callOutFee: "0.00",
          cancelReason: data.reason,
          formerAssignedUserIds: [
            ...new Set([...t.formerAssignedUserIds, p.userId]),
          ],
          formerAssignedShopIds: [
            ...new Set([...t.formerAssignedShopIds, p.id]),
          ],
          ...(t.type === "SOS" && { travelFee: "0.00" }),
          assignmentDistanceMeters: null,
        };
      else if (t.type === "TOW") Object.assign(fields, Policy.waiting(t));
      fields.totalAmount =
        rider || t.type === "WALK_IN"
          ? "0.00"
          : Policy.total({ ...t.get(), ...fields });
      await this.change(t, actor, "CANCEL", fields, transaction, {
        cancelledBy: rider ? "RIDER" : "PROVIDER",
        paymentReconciliationRequired: true,
      });
      if (old) Availability.afterDispatchChange(old, transaction);
      return this.dto(t);
    });
  }
  static async retarget(actor, id, data) {
    return this.fresh(actor, id, data, async (t, transaction) => {
      Policy.rider(actor, t);
      if (t.type !== "TOW")
        Policy.fail(
          "DISPATCH_INVALID_STATE_TRANSITION",
          "Chỉ cuốc kéo xe được đổi điểm giao",
        );
      Policy.state(t, [...PENDING, S.MATCHED, S.ARRIVED]);
      const destination = await this.destination(
        actor,
        data,
        t.requirements,
        transaction,
      );
      const travelFee = Money.add(
        t.pricingSnapshot.towBaseFee,
        Money.amount(
          Math.ceil(
            distanceMeters(
              { latitude: t.pickupLatitude, longitude: t.pickupLongitude },
              {
                latitude: destination.dropoffLatitude,
                longitude: destination.dropoffLongitude,
              },
            ) / 1000,
          ) * Money.cents(t.pricingSnapshot.towPerKm),
        ),
      );
      const fields = {
        ...destination,
        travelFee,
        totalAmount: Money.add(travelFee, t.waitingFee),
        estimateAmount: null,
        estimateExpiresAt: null,
        estimateStatus: null,
        estimateVersion: t.estimateVersion + 1,
        ...(PENDING.includes(t.status) && { status: S.PENDING }),
      };
      await this.change(t, actor, "RETARGET", fields, transaction, {
        paymentReconciliationRequired: true,
      });
      return this.dto(t);
    });
  }
  static async towOffer(actor, id, data) {
    return this.fresh(actor, id, data, async (t, transaction) => {
      await Policy.profileActor(actor, t, transaction);
      if (t.type !== "SOS")
        Policy.fail(
          "DISPATCH_INVALID_STATE_TRANSITION",
          "Chỉ thợ SOS được đề nghị kéo xe",
        );
      Policy.state(t, [S.UNFIXABLE, S.RESOLVED_UNFIXABLE]);
      if (data.mode === "DIRECT") {
        const p = await Provider.findOne({
          where: {
            id: data.directProviderId,
            userId: actor.userId,
            kind: "TOW",
          },
          transaction,
        });
        if (!p)
          Policy.fail(
            "DISPATCH_DIRECT_TOW_INVALID",
            "Xe kéo trực tiếp phải thuộc cùng chủ thợ",
          );
        await Availability.lockForAssignment(
          p.id,
          Policy.requirements("TOW", t.vehicleSnapshot),
          transaction,
        );
      }
      const offer = {
        mode: data.mode,
        directProviderId: data.mode === "DIRECT" ? data.directProviderId : null,
      };
      if (JSON.stringify(t.towOffer) === JSON.stringify(offer))
        return this.dto(t);
      await this.change(
        t,
        actor,
        "TOW_OFFER",
        { towOffer: offer },
        transaction,
      );
      return this.dto(t);
    });
  }
  static async handoff(actor, id, kind, data) {
    return this.fresh(actor, id, data, async (t, transaction) => {
      Policy.rider(actor, t);
      if (t.childTicketId) {
        const existing = await Ticket.findByPk(t.childTicketId, {
          transaction,
        });
        if (existing?.handoffKind === kind) return this.dto(existing);
        Policy.fail(
          "DISPATCH_HANDOFF_EXISTS",
          "Phiếu đã có yêu cầu cứu viện tiếp nối",
        );
      }
      let type = kind === "RETRY_SOS" ? "SOS" : "TOW";
      let payload = { ...data, handoffKind: kind };
      if (kind === "RETURN_TOW") {
        if (t.type === "TOW")
          Policy.fail(
            "DISPATCH_INVALID_STATE_TRANSITION",
            "Chỉ sửa chữa hoàn tất được gọi kéo trả xe",
          );
        Policy.state(t, [S.READY]);
        const shop = await Provider.findByPk(t.providerId, { transaction });
        const pickup =
          t.type === "WALK_IN"
            ? shop
            : { latitude: t.pickupLatitude, longitude: t.pickupLongitude };
        Policy.location(data.location, data.location);
        if (
          distanceMeters(data.location, pickup) - data.location.accuracy <=
          1000
        )
          Policy.fail(
            "DISPATCH_RETURN_TOO_CLOSE",
            "Chỉ gọi kéo trả khi khách cách điểm nhận xe trên 1km",
          );
        payload = {
          ...payload,
          pickupLatitude: pickup.latitude,
          pickupLongitude: pickup.longitude,
          dropoffShopId: null,
          dropoffLatitude: data.location.latitude,
          dropoffLongitude: data.location.longitude,
        };
        await this.change(
          t,
          actor,
          "RETURN_ACCEPTED",
          { status: S.RESOLVED, resolvedAt: new Date() },
          transaction,
        );
      } else {
        Policy.state(t, [S.UNFIXABLE, S.RESOLVED_UNFIXABLE]);
        if (t.type !== "SOS" && kind === "RETRY_SOS")
          Policy.fail(
            "DISPATCH_INVALID_STATE_TRANSITION",
            "Chỉ SOS không sửa được được gọi lại thợ",
          );
      }
      if (kind === "TOW_HANDOFF" && t.towOffer?.mode === "DIRECT")
        payload.providerId = t.towOffer.directProviderId;
      const child = await this.createRecord(
        actor,
        type,
        payload,
        transaction,
        t,
      );
      await this.link(t, child, transaction);
      return this.dto(child);
    });
  }
  static dto(ticket) {
    const result = ticket.toJSON ? ticket.toJSON() : { ...ticket };
    delete result.requestFingerprint;
    delete result.formerAssignedUserIds;
    const waiting = Policy.waiting(result);
    if (result.type === "TOW" && result.status === S.ARRIVED) {
      Object.assign(result, waiting);
      result.totalAmount = Policy.total(result);
    }
    result.estimateExpired =
      !!result.estimateExpiresAt &&
      new Date(result.estimateExpiresAt) <= new Date();
    return result;
  }
  static async mine(actor, { active, limit = 50, offset = 0 } = {}) {
    const result = await Ticket.findAndCountAll({
      where: {
        userId: actor.userId,
        ...(active !== undefined && {
          status: { [active ? Op.notIn : Op.in]: TERMINAL },
        }),
      },
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
    });
    return { total: result.count, items: result.rows.map((t) => this.dto(t)) };
  }
  static async providerRequests(
    actor,
    { providerId, active, limit = 50, offset = 0 },
  ) {
    if (
      !(await Provider.findOne({
        where: { id: providerId, userId: actor.userId },
      }))
    )
      throw new NotFoundException(errors.PROVIDER_NOT_FOUND);
    const result = await Ticket.findAndCountAll({
      where: {
        [Op.or]: [
          { providerId },
          { targetProviderId: providerId, providerId: null },
        ],
        ...(active !== undefined && {
          status: { [active ? Op.notIn : Op.in]: TERMINAL },
        }),
      },
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
    });
    return {
      total: result.count,
      items: result.rows.map((t) =>
        t.providerId === providerId ? this.dto(t) : Notify.summary(t),
      ),
    };
  }
  static async feed(actor, { providerId, limit = 50, offset = 0 }) {
    const p = await Provider.findOne({
      where: { id: providerId, userId: actor.userId },
    });
    if (!p) throw new NotFoundException(errors.PROVIDER_NOT_FOUND);
    if (!(await Availability.describe(p)).available)
      Policy.fail("PROVIDER_NOT_AVAILABLE", "Đối tác chưa sẵn sàng nhận việc");
    const distance = require("../utils/geo.util")
      .distanceSql(p.latitude, p.longitude)
      .replaceAll('"Provider"."latitude"', '"DispatchTicket"."pickup_latitude"')
      .replaceAll(
        '"Provider"."longitude"',
        '"DispatchTicket"."pickup_longitude"',
      );
    const literal = require("sequelize").literal;
    const escapedId = db.escape(p.id);
    const conditions = [
      literal(`(${distance}) <= 15000`),
      literal(`NOT (${escapedId}::uuid = ANY("former_assigned_shop_ids"))`),
      literal(
        `NOT (${db.escape(actor.userId)}::uuid = ANY("former_assigned_user_ids"))`,
      ),
      literal(
        `("requirements"->'requiredCapabilities') <@ ${db.escape(JSON.stringify(p.capabilities))}::jsonb`,
      ),
      literal(
        `"requirements"->>'vehicleType' IN (${p.supportedVehicleTypes.map((type) => db.escape(type)).join(",")})`,
      ),
    ];
    if (p.kind === "TOW")
      for (const [field, value] of [
        ["vehicleWeightKg", p.towMaxWeightKg],
        ["vehicleWidth", p.towMaxWidth],
        ["vehicleHeight", p.towMaxHeight],
        ["vehicleLength", p.towMaxLength],
      ])
        conditions.push(
          literal(
            `("requirements"->>${db.escape(field)})::numeric <= ${db.escape(value)}`,
          ),
        );
    const rows = await Ticket.findAll({
      where: {
        type: Object.keys(KIND).find((key) => KIND[key] === p.kind),
        status: { [Op.in]: PENDING },
        userId: { [Op.ne]: actor.userId },
        [Op.and]: conditions,
        [Op.or]: [{ targetProviderId: null }, { targetProviderId: p.id }],
      },
      order: [
        ["createdAt", "ASC"],
        ["id", "ASC"],
      ],
      limit,
      offset,
    });
    return rows.map((t) => Notify.summary(t));
  }
  static async detail(actor, id) {
    const t = await Ticket.findByPk(id);
    if (!t) throw new NotFoundException(errors.DISPATCH_TICKET_NOT_FOUND);
    const profiles = await Provider.findAll({
      where: { userId: actor.userId },
    });
    const ids = profiles.map((p) => p.id);
    if (
      t.userId !== actor.userId &&
      !ids.includes(t.providerId) &&
      ids.includes(t.targetProviderId)
    )
      return Notify.summary(t);
    if (
      t.userId !== actor.userId &&
      !ids.includes(t.providerId) &&
      !ids.includes(t.dropoffShopId)
    ) {
      if (PENDING.includes(t.status)) {
        for (const p of profiles)
          if (
            (await Notify.candidates(t)).some(
              (candidate) => candidate.id === p.id,
            )
          )
            return Notify.summary(t);
      }
      throw new NotFoundException(errors.DISPATCH_TICKET_NOT_FOUND);
    }
    if (
      t.userId !== actor.userId &&
      !ids.includes(t.providerId) &&
      ids.includes(t.dropoffShopId)
    )
      return {
        ...Notify.summary(t),
        dropoffShopId: t.dropoffShopId,
        estimateAmount: t.estimateAmount,
        estimateStatus: t.estimateStatus,
        estimateVersion: t.estimateVersion,
        estimateExpiresAt: t.estimateExpiresAt,
        description: t.description,
        images: t.images,
        vehicle: {
          type: t.vehicleSnapshot.type,
          brand: t.vehicleSnapshot.brand,
          modelName: t.vehicleSnapshot.modelName,
        },
      };
    const data = this.dto(t);
    data.events = await Event.findAll({
      where: { ticketId: id },
      order: [
        ["createdAt", "ASC"],
        ["id", "ASC"],
      ],
    });
    if (t.providerId && !TERMINAL.includes(t.status)) {
      const p = await Provider.findByPk(t.providerId);
      data.providerLocation = p
        ? {
            latitude: p.latitude,
            longitude: p.longitude,
            recordedAt: p.lastTrustedRecordedAt,
            quality: p.locationQuality,
            stale:
              p.locationQuality !== "GOOD" ||
              !p.lastTrustedLocationAt ||
              Date.now() - new Date(p.lastTrustedLocationAt) > 120000,
          }
        : null;
    }
    return data;
  }
  static async expireEstimates() {
    const rows = await Ticket.findAll({
      where: {
        type: "TOW",
        status: { [Op.notIn]: TERMINAL },
        estimateStatus: { [Op.in]: ["PENDING", "APPROVED"] },
        estimateExpiresAt: { [Op.lte]: new Date() },
      },
      limit: 100,
    });
    for (const row of rows)
      await this.fresh(
        { userId: row.userId, system: true },
        row.id,
        {},
        async (t, transaction) => {
          if (
            !["PENDING", "APPROVED"].includes(t.estimateStatus) ||
            t.estimateExpiresAt > new Date()
          )
            return;
          await this.change(
            t,
            { userId: t.userId, system: true },
            "ESTIMATE_EXPIRED",
            {
              estimateStatus: "EXPIRED",
              ...(PENDING.includes(t.status) && { status: S.PENDING }),
            },
            transaction,
          );
        },
      );
  }
  static async notifications(actor, { limit = 50, offset = 0 }) {
    return Notification.findAll({
      where: { recipientId: actor.userId },
      limit,
      offset,
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
    });
  }
}
module.exports = Dispatch;
