const { Op, literal } = require("sequelize");
const sequelize = require("../config/postgres.config");
const {
  Provider,
  ProviderLocationHistory,
  User,
  VehicleProfile,
} = require("../models");
const Access = require("./provider_access.service");
const VehicleService = require("./vehicle.service");
const VehiclePolicy = require("./vehicle_policy.service");
const Location = require("./location.service");
const Auth = require("./auth.service");
const {
  normalizePlate,
  isValidVietnamesePlate,
} = require("../utils/plate.util");
const { distanceSql } = require("../utils/geo.util");
const {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} = require("../common/exceptions/BaseException");
const errors = require("../common/exceptions/error_codes");
const TERMINAL = ["4", "5", "8", "12", "15"];
const pick = (data, fields) =>
  Object.fromEntries(
    fields
      .filter((key) => data[key] !== undefined)
      .map((key) => [key, data[key]]),
  );
class ProviderService {
  static async admin(actor) {
    const user =
      actor &&
      (await User.findOne({
        where: { userId: actor.userId, role: "admin", status: "ACTIVE" },
      }));
    if (!user?.emailVerifiedAt) throw new ForbiddenException();
  }
  static async checkHistory(userId, kind, transaction) {
    const histories = await Provider.findAll({
      where: { userId, kind },
      transaction,
    });
    if (histories.some((profile) => profile.adminSuspendedAt))
      throw new ForbiddenException(errors.PROVIDER_DUTY_SWITCH_DISABLED);
    return histories;
  }
  static async ensureUnique(userId, kind, transaction, exceptId) {
    const existing = await Provider.findOne({
      where: {
        userId,
        kind,
        status: { [Op.ne]: "DENIED" },
        ...(exceptId && { id: { [Op.ne]: exceptId } }),
      },
      transaction,
    });
    if (existing) throw new ConflictException(errors.PROVIDER_ALREADY_EXISTS);
  }
  static async vehicleFor(userId, data, transaction, approval = false) {
    if (data.kind === "SHOP") {
      if (data.vehicleProfileId || data.plateNumber)
        throw new BadRequestException(errors.PROVIDER_VEHICLE_INVALID);
      return null;
    }
    if (!data.vehicleProfileId)
      throw new BadRequestException(errors.PROVIDER_VEHICLE_INVALID);
    const vehicle = await VehicleService.owned(
      userId,
      data.vehicleProfileId,
      transaction,
    );
    const plate = normalizePlate(data.plateNumber || vehicle.plateNumber);
    if (
      !vehicle.isActive ||
      !isValidVietnamesePlate(plate) ||
      plate !== normalizePlate(vehicle.plateNumber) ||
      (data.kind === "TOW" && vehicle.type !== "CAR")
    ) {
      throw new BadRequestException(errors.PROVIDER_VEHICLE_INVALID);
    }
    if (
      (data.kind === "MOBILE_SHOP" || approval) &&
      !data.licenseNumber?.trim()
    )
      throw new BadRequestException("Vui lòng cung cấp số giấy phép");
    return vehicle;
  }
  static async openDispatch(provider, transaction) {
    const Ticket = sequelize.models.DispatchTicket;
    return Ticket
      ? Ticket.findOne({
          where: { providerId: provider.id, status: { [Op.notIn]: TERMINAL } },
          transaction,
          ...(transaction && { lock: transaction.LOCK.UPDATE }),
        })
      : null;
  }
  static async assertIdle(provider, vehicle, transaction) {
    if (vehicle)
      return VehiclePolicy.assertNotBusy(vehicle, [provider], transaction);
    if (await this.openDispatch(provider, transaction))
      throw new ConflictException(errors.PROVIDER_BUSY);
  }
  static validVehicleCondition() {
    const table = sequelize
      .getQueryInterface()
      .queryGenerator.quoteTable(VehicleProfile.getTableName());
    return literal(
      `("Provider"."kind" = 'SHOP' OR EXISTS (SELECT 1 FROM ${table} AS v WHERE v."id" = "Provider"."vehicle_profile_id" AND v."user_id" = "Provider"."user_id" AND v."is_active" = true AND ("Provider"."kind" != 'TOW' OR v."type" = 'CAR')))`,
    );
  }
  static async nearbyWarning(data, transaction, exceptId) {
    if (!["SHOP", "MOBILE_SHOP"].includes(data.kind)) return [];
    const distance = distanceSql(Number(data.latitude), Number(data.longitude));
    const rows = await Provider.findAll({
      attributes: ["id", "name", "kind", [literal(distance), "distanceMeters"]],
      where: {
        kind: { [Op.in]: ["SHOP", "MOBILE_SHOP"] },
        status: "ACTIVE",
        suspended: false,
        ...(exceptId && { id: { [Op.ne]: exceptId } }),
        [Op.and]: [literal(`${distance} <= 300`), this.validVehicleCondition()],
        [Op.or]: [
          { kind: "SHOP" },
          {
            kind: "MOBILE_SHOP",
            accepting: true,
            lastHeartbeatAt: { [Op.gt]: new Date(Date.now() - 900000) },
          },
        ],
      },
      include: [
        {
          model: User,
          as: "owner",
          attributes: [],
          required: true,
          where: { status: "ACTIVE", emailVerifiedAt: { [Op.ne]: null } },
        },
      ],
      order: [[literal('"distanceMeters"'), "ASC"]],
      limit: 20,
      transaction,
    });
    const nearby = rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      distanceMeters: Math.round(Number(row.get("distanceMeters"))),
    }));
    if (nearby.length && !data.confirmNearby)
      throw new ConflictException(
        errors.PROVIDER_LOCATION_CONFIRMATION_REQUIRED,
        { nearby },
      );
    return nearby;
  }
  static async completeMutation(
    user,
    actor,
    transaction,
    result,
    oldVersion,
    context,
  ) {
    await Access.synchronize(user, transaction);
    if (actor.userId === user.userId && oldVersion !== user.sessionVersion)
      result.session = await Auth.issueSession(user, context, transaction);
    return result;
  }
  static async registerProvider(actor, data, context) {
    try {
      return await sequelize.transaction(async (transaction) => {
        const user = await VehicleService.lockUser(actor.userId, transaction);
        const oldVersion = user.sessionVersion;
        await this.ensureUnique(user.userId, data.kind, transaction);
        const histories = await this.checkHistory(
          user.userId,
          data.kind,
          transaction,
        );
        const vehicle = await this.vehicleFor(user.userId, data, transaction);
        if (vehicle)
          await VehiclePolicy.assertNotBusy(
            vehicle,
            await VehiclePolicy.linkedProviders(vehicle, transaction),
            transaction,
          );
        if (data.kind === "SHOP" && !data.serviceSegments?.length)
          throw new BadRequestException(
            "Tiệm cần chọn ít nhất một phân khúc phục vụ",
          );
        if (
          data.kind !== "SHOP" &&
          data.openHours &&
          Object.keys(data.openHours).length
        )
          throw new BadRequestException(
            "Giờ mở cửa chỉ áp dụng cho tiệm cố định",
          );
        const nearby = await this.nearbyWarning(data, transaction);
        const requiresApproval =
          data.kind === "TOW" ||
          histories.some((profile) => profile.requiresApproval);
        const profile = await Provider.create(
          {
            ...pick(data, [
              "kind",
              "name",
              "phone",
              "licenseNumber",
              "latitude",
              "longitude",
              "address",
              "serviceSegments",
              "openHours",
            ]),
            userId: user.userId,
            vehicleProfileId: vehicle?.id || null,
            plateNumber: vehicle ? normalizePlate(vehicle.plateNumber) : null,
            serviceSegments: data.serviceSegments || [
              vehicle?.type === "CAR" ? "CAR" : "SOLO_BIKE",
            ],
            status: requiresApproval ? "PENDING" : "ACTIVE",
            requiresApproval,
            accepting: false,
          },
          { transaction },
        );
        await user.update(
          {
            requestedServices: [
              ...new Set([...user.requestedServices, data.kind]),
            ],
          },
          { transaction },
        );
        return this.completeMutation(
          user,
          actor,
          transaction,
          { provider: profile.toJSON(), nearby },
          oldVersion,
          context,
        );
      });
    } catch (error) {
      if (error.name === "SequelizeUniqueConstraintError")
        throw new ConflictException(errors.PROVIDER_ALREADY_EXISTS);
      throw error;
    }
  }
  static async mutate(actor, id, action, context = {}) {
    if (actor.role === "admin") await this.admin(actor);
    const snapshot = await Provider.findByPk(id);
    if (
      !snapshot ||
      (actor.role !== "admin" && snapshot.userId !== actor.userId)
    )
      throw new NotFoundException(errors.PROVIDER_NOT_FOUND);
    return sequelize.transaction(async (transaction) => {
      const user =
        actor.role === "admin"
          ? await User.findOne({
              where: { userId: snapshot.userId },
              transaction,
              lock: transaction.LOCK.UPDATE,
            })
          : await VehicleService.lockUser(snapshot.userId, transaction);
      if (!user) throw new NotFoundException(errors.USER_NOT_FOUND);
      const oldVersion = user.sessionVersion;
      const current = await Provider.findByPk(id, { transaction });
      if (!current) throw new NotFoundException(errors.PROVIDER_NOT_FOUND);
      const vehicle = current.vehicleProfileId
        ? await VehicleService.owned(
            user.userId,
            current.vehicleProfileId,
            transaction,
          )
        : null;
      const profile = await Provider.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const result = await action({ user, profile, vehicle, transaction });
      return this.completeMutation(
        user,
        actor,
        transaction,
        result,
        oldVersion,
        context,
      );
    });
  }
  static async update(actor, id, data, context) {
    return this.mutate(
      actor,
      id,
      async ({ user, profile, vehicle, transaction }) => {
        // Admin approval APIs are separate; even admins cannot mutate another owner's business details here.
        if (actor.userId !== user.userId) throw new ForbiddenException();
        await this.checkHistory(user.userId, profile.kind, transaction);
        await this.assertIdle(profile, vehicle, transaction);
        if (profile.status === "DENIED" && !data.resubmit)
          throw new ConflictException(errors.PROVIDER_INVALID_TRANSITION);
        if (data.resubmit && profile.status !== "DENIED")
          throw new ConflictException(errors.PROVIDER_INVALID_TRANSITION);
        if (data.resubmit)
          await this.ensureUnique(
            user.userId,
            profile.kind,
            transaction,
            profile.id,
          );
        if (
          profile.kind !== "SHOP" &&
          (data.latitude !== undefined ||
            data.longitude !== undefined ||
            data.openHours !== undefined)
        )
          throw new BadRequestException(
            "Đối tác lưu động cập nhật GPS qua API location",
          );
        const fields = pick(data, [
          "name",
          "phone",
          "licenseNumber",
          "address",
          "latitude",
          "longitude",
          "serviceSegments",
          "openHours",
          "vehicleProfileId",
          "plateNumber",
        ]);
        const merged = { ...profile.get(), ...fields };
        const newVehicle = await this.vehicleFor(
          user.userId,
          merged,
          transaction,
        );
        if (newVehicle && newVehicle.id !== vehicle?.id)
          await VehiclePolicy.assertNotBusy(
            newVehicle,
            await VehiclePolicy.linkedProviders(newVehicle, transaction),
            transaction,
          );
        if (profile.kind === "SHOP" && !merged.serviceSegments?.length)
          throw new BadRequestException(
            "Tiệm cần ít nhất một phân khúc phục vụ",
          );
        const identityChanged = [
          "vehicleProfileId",
          "plateNumber",
          "licenseNumber",
        ].some(
          (field) =>
            fields[field] !== undefined &&
            (field === "plateNumber"
              ? normalizePlate(fields[field]) !== profile.plateNumber
              : fields[field] !== profile[field]),
        );
        if (data.resubmit || (identityChanged && profile.status === "ACTIVE"))
          Object.assign(fields, {
            status: "PENDING",
            requiresApproval: true,
            accepting: false,
            denialReason: null,
            revokedAt: null,
          });
        if (newVehicle)
          Object.assign(fields, {
            vehicleProfileId: newVehicle.id,
            plateNumber: normalizePlate(newVehicle.plateNumber),
          });
        const moved =
          profile.kind === "SHOP" &&
          (fields.latitude !== undefined || fields.longitude !== undefined);
        const nearby = moved
          ? await this.nearbyWarning(
              { ...merged, confirmNearby: data.confirmNearby },
              transaction,
              profile.id,
            )
          : [];
        await profile.update(fields, { transaction });
        return { provider: profile.toJSON(), nearby };
      },
      context,
    );
  }
  static assertDuty(profile, vehicle) {
    if (profile.status === "PENDING" && profile.kind === "TOW")
      throw new ForbiddenException(errors.PROVIDER_TOW_PENDING_APPROVAL);
    if (
      profile.status !== "ACTIVE" ||
      profile.suspended ||
      (profile.kind !== "SHOP" &&
        (!vehicle?.isActive ||
          (profile.kind === "TOW" && vehicle.type !== "CAR")))
    ) {
      throw new ForbiddenException(errors.PROVIDER_DUTY_SWITCH_DISABLED);
    }
  }
  static async recordPosition(
    profile,
    data,
    transaction,
    accepting = profile.accepting,
  ) {
    if (data.latitude === undefined || data.longitude === undefined)
      throw new BadRequestException(
        "Cần tọa độ GPS hiện tại khi bật ca lưu động",
      );
    const now = new Date();
    const recordedAt = data.recordedAt
      ? new Date(data.recordedAt)
      : new Date(
          Math.max(
            now.getTime(),
            new Date(profile.lastLocationRecordedAt || 0).getTime() + 1,
          ),
        );
    if (
      !Number.isFinite(recordedAt.getTime()) ||
      recordedAt > new Date(now.getTime() + 120000) ||
      recordedAt < new Date(now.getTime() - 900000) ||
      (profile.lastLocationRecordedAt &&
        recordedAt <= profile.lastLocationRecordedAt)
    )
      throw new ConflictException(errors.PROVIDER_LOCATION_STALE);
    await ProviderLocationHistory.create(
      {
        providerId: profile.id,
        latitude: data.latitude,
        longitude: data.longitude,
        recordedAt,
        ...pick(data, ["speed", "accuracy"]),
      },
      { transaction },
    );
    await profile.update(
      {
        latitude: data.latitude,
        longitude: data.longitude,
        lastHeartbeatAt: now,
        lastLocationRecordedAt: recordedAt,
        accepting,
      },
      { transaction },
    );
  }
  static async toggleDuty(actor, id, data, context) {
    return this.mutate(
      actor,
      id,
      async ({ user, profile, vehicle, transaction }) => {
        if (actor.userId !== user.userId) throw new ForbiddenException();
        this.assertDuty(profile, vehicle);
        if (data.accepting && profile.kind !== "SHOP")
          await this.recordPosition(profile, data, transaction, true);
        else {
          if (
            profile.kind === "SHOP" &&
            (data.latitude !== undefined || data.longitude !== undefined)
          )
            throw new BadRequestException(
              "Tiệm cố định không gửi GPS heartbeat",
            );
          await profile.update({ accepting: data.accepting }, { transaction });
        }
        return { provider: profile.toJSON() };
      },
      context,
    );
  }
  static async heartbeat(actor, data, context) {
    return this.mutate(
      actor,
      data.providerId,
      async ({ user, profile, vehicle, transaction }) => {
        if (actor.userId !== user.userId || profile.kind === "SHOP")
          throw new ForbiddenException();
        this.assertDuty(profile, vehicle);
        if (
          !profile.accepting &&
          !(await this.openDispatch(profile, transaction))
        )
          throw new ForbiddenException(errors.PROVIDER_NOT_ACTIVE);
        await this.recordPosition(profile, data, transaction);
        return {
          providerId: profile.id,
          lastHeartbeatAt: profile.lastHeartbeatAt,
        };
      },
      context,
    );
  }
  static async revoke(actor, id, context) {
    return this.mutate(
      actor,
      id,
      async ({ profile, vehicle, transaction }) => {
        await this.assertIdle(profile, vehicle, transaction);
        await profile.update(
          { status: "DENIED", accepting: false, revokedAt: new Date() },
          { transaction },
        );
        return { provider: profile.toJSON() };
      },
      context,
    );
  }
  static async review(actor, id, action, data, context) {
    await this.admin(actor);
    return this.mutate(
      actor,
      id,
      async ({ user, profile, vehicle, transaction }) => {
        if (action === "suspend") {
          await profile.update(
            {
              suspended: data.suspended,
              accepting: false,
              adminSuspendedAt: data.suspended ? new Date() : null,
              suspensionReason: data.suspended ? data.reason : null,
            },
            { transaction },
          );
        } else {
          if (profile.status !== "PENDING")
            throw new ConflictException(errors.PROVIDER_INVALID_TRANSITION);
          await this.assertIdle(profile, vehicle, transaction);
          if (action === "approve") {
            if (user.status !== "ACTIVE" || !user.emailVerifiedAt)
              throw new ForbiddenException(errors.PROVIDER_NOT_ACTIVE);
            if (profile.adminSuspendedAt || profile.suspended)
              throw new ForbiddenException(errors.PROVIDER_NOT_ACTIVE);
            await this.vehicleFor(user.userId, profile, transaction, true);
          }
          await profile.update(
            {
              status: action === "approve" ? "ACTIVE" : "DENIED",
              accepting: false,
              requiresApproval: true,
              denialReason: action === "deny" ? data.reason : null,
              reviewedAt: new Date(),
              reviewedBy: actor.userId,
            },
            { transaction },
          );
        }
        return { provider: profile.toJSON() };
      },
      context,
    );
  }
  static publicProfile(profile) {
    const data = profile.get ? profile.get({ plain: true }) : profile;
    const fields = [
      "id",
      "kind",
      "name",
      "phone",
      "address",
      "serviceSegments",
      "openHours",
      "ratingAvg",
      "ratingCount",
      "accepting",
    ];
    const result = pick(data, fields);
    const visibleLocation =
      data.kind === "SHOP" || (data.accepting && Location.fresh(data));
    return {
      ...result,
      available: Boolean(data.accepting && visibleLocation),
      latitude: visibleLocation ? data.latitude : null,
      longitude: visibleLocation ? data.longitude : null,
      ...(data.distanceMeters !== undefined && {
        distanceMeters: Math.round(Number(data.distanceMeters)),
      }),
    };
  }
  static async me(userId) {
    return Provider.findAll({
      where: { userId },
      order: [["createdAt", "DESC"]],
      limit: 100,
    });
  }
  static async get(id, actor) {
    const profile = await Provider.findByPk(id, {
      include: [
        { model: User, as: "owner", attributes: ["status", "emailVerifiedAt"] },
        {
          model: VehicleProfile,
          as: "vehicle",
          attributes: ["id", "userId", "type", "isActive"],
        },
      ],
    });
    if (!profile) throw new NotFoundException(errors.PROVIDER_NOT_FOUND);
    if (actor && (actor.userId === profile.userId || actor.role === "admin")) {
      const data = profile.get({ plain: true });
      delete data.owner;
      delete data.vehicle;
      delete data.geoVersion;
      return data;
    }
    if (
      profile.status !== "ACTIVE" ||
      profile.suspended ||
      profile.owner?.status !== "ACTIVE" ||
      !profile.owner.emailVerifiedAt
    )
      throw new NotFoundException(errors.PROVIDER_NOT_FOUND);
    if (
      profile.kind !== "SHOP" &&
      (!profile.vehicle?.isActive ||
        profile.vehicle.userId !== profile.userId ||
        (profile.kind === "TOW" && profile.vehicle.type !== "CAR"))
    )
      throw new NotFoundException(errors.PROVIDER_NOT_FOUND);
    return this.publicProfile(profile);
  }
  static async pending(actor, { page = 1, limit = 50, kind } = {}) {
    await this.admin(actor);
    const { rows, count } = await Provider.findAndCountAll({
      where: { status: "PENDING", ...(kind && { kind }) },
      order: [["createdAt", "ASC"]],
      limit,
      offset: (page - 1) * limit,
    });
    return { items: rows, total: count, page, limit };
  }
  static async search({
    latitude,
    longitude,
    radiusKm = 50,
    kinds = ["SHOP", "MOBILE_SHOP", "TOW"],
    minRating = 0,
    acceptingOnly = false,
    sortBy = "distance",
    limit = 20,
  }) {
    const cachedIds = await Location.nearby({ latitude, longitude, radiusKm });
    const distance = distanceSql(latitude, longitude);
    const validVehicle = this.validVehicleCondition();
    const common = {
      status: "ACTIVE",
      suspended: false,
      ratingAvg: { [Op.gte]: minRating },
      ...(acceptingOnly && { accepting: true }),
      [Op.and]: [literal(`${distance} <= ${radiusKm * 1000}`), validVehicle],
    };
    const order =
      sortBy === "rating"
        ? [
            ["ratingAvg", "DESC"],
            [literal('"distanceMeters"'), "ASC"],
            ["id", "ASC"],
          ]
        : [
            [literal('"distanceMeters"'), "ASC"],
            ["id", "ASC"],
          ];
    const query = (where) =>
      Provider.findAll({
        attributes: { include: [[literal(distance), "distanceMeters"]] },
        where,
        include: [
          {
            model: User,
            as: "owner",
            attributes: [],
            required: true,
            where: { status: "ACTIVE", emailVerifiedAt: { [Op.ne]: null } },
          },
        ],
        order,
        limit,
      });
    const mobileKinds = kinds.filter((kind) => kind !== "SHOP");
    const mobile = {
      ...common,
      kind: { [Op.in]: mobileKinds },
      accepting: true,
      lastHeartbeatAt: { [Op.gt]: new Date(Date.now() - 900000) },
    };
    // Fill missing cache members from PostgreSQL, including after Redis loss/restarts.
    const groups = await Promise.all([
      kinds.includes("SHOP") ? query({ ...common, kind: "SHOP" }) : [],
      mobileKinds.length && cachedIds.length
        ? query({ ...mobile, id: { [Op.in]: cachedIds } })
        : [],
      mobileKinds.length
        ? query({
            ...mobile,
            ...(cachedIds.length && { id: { [Op.notIn]: cachedIds } }),
          })
        : [],
    ]);
    const rows = groups.flat();
    rows.sort(
      (a, b) =>
        (sortBy === "rating" ? b.ratingAvg - a.ratingAvg : 0) ||
        Number(a.get("distanceMeters")) - Number(b.get("distanceMeters")) ||
        a.id.localeCompare(b.id),
    );
    return rows.slice(0, limit).map((profile) => this.publicProfile(profile));
  }
}
module.exports = ProviderService;
