// Local demo dataset shared by development startup and the manual seed command.
// This module never resets tables and never closes shared DB/Redis connections.
const { createHash } = require("node:crypto");
const { Op } = require("sequelize");
const config = require("../config/app.config");
const db = require("../config/postgres.config");
const redis = require("../config/redis.config");
const {
  User,
  Provider,
  VehicleProfile,
  DispatchTicket,
  Bill,
  SavedPlace,
  HazardFlag,
  PlatformSetting,
} = require("../models");
const Vehicles = require("../services/vehicle.service");
const Providers = require("../services/provider.service");
const Dispatch = require("../services/dispatch.service");
const Payments = require("../services/payment.service");
const MockPayments = require("../services/mock_payment.service");
const Ratings = require("../services/rating.service");
const Flags = require("../services/flag.service");
const Chat = require("../services/chat.service");
const context = {
  ipAddress: "127.0.0.1",
  userAgent: "RoadAssist local demo seed",
};
const password = "RoadAssistDemo@123";
const point = { latitude: 10.7769, longitude: 106.7009 };
function key(name) {
  const hex = createHash("sha256")
    .update(`roadassist-demo-v1:${name}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function account(handle, name, index, role = "guest") {
  const [user] = await User.findOrCreate({
    where: { email: `${handle}@demo.roadassist.test` },
    defaults: {
      userId: key(`user:${handle}`),
      name: `Demo · ${name}`,
      password,
      phone: `09000990${String(index).padStart(2, "0")}`,
      role,
      emailVerifiedAt: new Date(),
      onboarded: true,
      status: "ACTIVE",
    },
  });
  // Refuse to adopt a colliding account that was not created by this script.
  if (user.userId !== key(`user:${handle}`))
    throw new Error(`Demo account collision: ${handle}`);
  return user;
}
async function vehicle(user, name, plate, type = "BIKE") {
  const existing = await VehicleProfile.findOne({
    where: { userId: user.userId, plateNumber: plate },
  });
  const row =
    existing ||
    (await Vehicles.create(user.userId, {
      plateNumber: plate,
      type,
      brand: type === "BIKE" ? "Honda" : "Isuzu",
      modelName: name,
      color: "Trắng",
      length: type === "CAR" ? 6 : 1.85,
      weightKg: type === "CAR" ? 3500 : 110,
    }));
  if (!user.activeVehicleId) await user.update({ activeVehicleId: row.id });
  return row;
}
async function profile(user, kind, name, position, linkedVehicle) {
  let row = await Provider.findOne({ where: { userId: user.userId, kind } });
  if (!row) {
    const result = await Providers.registerProvider(
      user,
      {
        kind,
        name: `Demo · ${name}`,
        phone: user.phone,
        ...position,
        address:
          kind === "SHOP"
            ? "Demo · Nguyễn Huệ, Quận 1, TP.HCM"
            : "Demo · Khu vực Quận 1, TP.HCM",
        supportedVehicleTypes: ["BIKE", "CAR"],
        serviceSegments: ["SOLO_BIKE", "CAR"],
        capabilities:
          kind === "TOW"
            ? ["TOWING"]
            : ["TYRE_REPAIR", "BATTERY_JUMPSTART", "ENGINE_REPAIR"],
        maxConcurrentJobs: kind === "SHOP" ? 5 : 1,
        confirmNearby: true,
        ...(linkedVehicle && {
          vehicleProfileId: linkedVehicle.id,
          licenseNumber: "DEMO-LOCAL-ONLY",
        }),
        ...(kind === "TOW" && {
          towMaxWeightKg: 5000,
          towMaxWidth: 2.5,
          towMaxHeight: 3,
          towMaxLength: 7,
          towMethods: ["FLATBED"],
        }),
      },
      context,
    );
    row = await Provider.findByPk(result.provider.id);
  }
  if (row.status === "ACTIVE")
    await Providers.toggleDuty(
      user,
      row.id,
      {
        accepting: true,
        ...(kind !== "SHOP" && {
          ...position,
          accuracy: 10,
          recordedAt: new Date().toISOString(),
        }),
      },
      context,
    );
  await user.reload();
  return row;
}
async function ticket(rider, bike, shop, name, description) {
  const existing = await DispatchTicket.findOne({
    where: { userId: rider.userId, clientRequestId: key(name) },
  });
  if (existing) return Dispatch.dto(existing);
  return Dispatch.create(rider, "WALK_IN", {
    providerId: shop.id,
    vehicleProfileId: bike.id,
    clientRequestId: key(name),
    description: `Demo · ${description}`,
    requiredCapabilities: ["TYRE_REPAIR"],
    location: { ...point, accuracy: 10, recordedAt: new Date().toISOString() },
  });
}
async function complete(rider, shopOwner, shop, bike, index) {
  let t = await ticket(
    rider,
    bike,
    shop,
    `completed:${index}`,
    ["Vá lốp trước", "Thay lốp xe", "Kiểm tra lốp sau", "Bảo dưỡng bánh xe"][
      index
    ],
  );
  if (t.status === "4") return;
  const act = async (actor, action, data = {}) => {
    t = await Dispatch.action(actor, t.id, action, {
      expectedRevision: t.revision,
      ...data,
    });
  };
  if (t.status === "1")
    t = await Dispatch.accept(shopOwner, t.id, {
      providerId: shop.id,
      expectedRevision: t.revision,
    });
  if (t.status === "2") await act(shopOwner, "in-shop");
  if (t.status === "10")
    await act(shopOwner, "quote", {
      amount: [80000, 260000, 120000, 180000][index],
    });
  if (t.status === "9") {
    const bill = await Bill.findOne({ where: { journeyId: t.journeyId } });
    const payment = await Payments.create(rider, "SEPAY", {
      billId: bill.id,
      ticketId: t.id,
      clientRequestId: key(`payment:${index}`),
    }, { demoSeed: true });
    await MockPayments.transfer(rider, payment.id, { demoSeed: true });
    await act(rider, "approve-quote");
  }
  if (t.status === "6") await act(shopOwner, "ready");
  if (t.status === "7") await act(rider, "resolve");
  await Ratings.submit(rider, {
    ticketId: t.id,
    stars: index === 1 ? 4 : 5,
    content: "Demo · Sửa nhanh, tư vấn rõ ràng, chi phí hợp lý.",
  });
  // Only this demo ticket is backdated, after completing the real domain flow.
  const createdAt = new Date(Date.now() - (8 - index * 2) * 86400000);
  await DispatchTicket.update(
    { createdAt, resolvedAt: new Date(createdAt.getTime() + 3600000) },
    { where: { id: t.id, userId: rider.userId }, silent: true },
  );
}
const SEED_MARKER = "demo-dataset-v1";
async function seed() {
  const permitted =
    config.app.env === "development" ||
    (config.app.env === "test" && Boolean(process.env.DB_SCHEMA));
  if (!permitted || config.app.isProduction)
    throw new Error(
      "Demo seed is only available in development or isolated tests",
    );
  if (!["mock", "sandbox"].includes(config.sepay.mode))
    throw new Error("Demo seed requires PAYMENT_GATEWAY_MODE=mock or sandbox");
  await db.authenticate();
  if (redis.status === "wait") await redis.connect();
  const admin = await account("admin", "Quản trị viên", 1, "admin");
  const rider = await account("rider", "Người đi đường", 2);
  const shopOwner = await account("shop", "Chủ tiệm sửa xe", 3);
  const mobileOwner = await account("mobile", "Thợ lưu động", 4);
  const towOwner = await account("tow", "Chủ xe kéo (chờ duyệt)", 5);
  const bike = await vehicle(rider, "Vision", "59A1-99001");
  const otherBike = await vehicle(rider, "Air Blade", "59A1-99002");
  const towBike = await vehicle(rider, "Wave", "59A1-99003");
  if (!towBike.length || !towBike.weightKg)
    await Vehicles.update(rider.userId, towBike.id, {
      length: 1.85,
      weightKg: 110,
    });
  const mobileBike = await vehicle(mobileOwner, "Wave RSX", "59B1-99004");
  const truck = await vehicle(towOwner, "Xe sàn cứu hộ", "51C-99005", "CAR");
  const shop = await profile(shopOwner, "SHOP", "Tiệm An Tâm", point);
  const mobilePoint = { latitude: 10.7801, longitude: 106.704 };
  const mobile = await profile(
    mobileOwner,
    "MOBILE_SHOP",
    "Thợ Minh",
    mobilePoint,
    mobileBike,
  );
  await profile(
    towOwner,
    "TOW",
    "Cứu hộ Sài Gòn",
    { latitude: 10.773, longitude: 106.697 },
    truck,
  );
  for (let index = 0; index < 4; index++)
    await complete(rider, shopOwner, shop, bike, index);
  let active = await ticket(
    rider,
    bike,
    shop,
    "active-shop",
    "Thay lốp sau · chờ khách duyệt báo giá",
  );
  if (active.status === "1")
    active = await Dispatch.accept(shopOwner, active.id, {
      providerId: shop.id,
      expectedRevision: active.revision,
    });
  if (active.status === "2")
    active = await Dispatch.action(shopOwner, active.id, "in-shop", {
      expectedRevision: active.revision,
    });
  if (active.status === "10")
    active = await Dispatch.action(shopOwner, active.id, "quote", {
      amount: 220000,
      expectedRevision: active.revision,
    });
  if (active.status === "9") {
    await Chat.send(rider, "DISPATCH", active.id, {
      clientMessageId: key("chat:rider"),
      content: "Anh kiểm tra giúp em lốp sau, xe bị xuống hơi nhanh ạ.",
    });
    await Chat.send(shopOwner, "DISPATCH", active.id, {
      clientMessageId: key("chat:shop"),
      content: "Lốp bị rách hông, mình đã gửi báo giá thay lốp để bạn xem nhé.",
    });
  }
  let sos = await DispatchTicket.findOne({
    where: { userId: rider.userId, clientRequestId: key("active-sos") },
  });
  if (!sos)
    sos = await Dispatch.create(rider, "SOS", {
      clientRequestId: key("active-sos"),
      vehicleProfileId: otherBike.id,
      ...{
        pickupLatitude: mobilePoint.latitude,
        pickupLongitude: mobilePoint.longitude,
      },
      pickupAddress: "Demo · Lê Thánh Tôn, Quận 1",
      requiredCapabilities: ["BATTERY_JUMPSTART"],
      description: "Demo · Xe hết bình, cần hỗ trợ kích điện",
    });
  if (sos.status === "1")
    await Dispatch.accept(mobileOwner, sos.id, {
      providerId: mobile.id,
      expectedRevision: sos.revision,
    });
  if (
    !(await DispatchTicket.findOne({
      where: { userId: rider.userId, clientRequestId: key("pending-tow") },
    }))
  )
    await Dispatch.create(rider, "TOW", {
      clientRequestId: key("pending-tow"),
      vehicleProfileId: towBike.id,
      pickupLatitude: 10.774,
      pickupLongitude: 106.699,
      dropoffShopId: shop.id,
      requiredCapabilities: ["ENGINE_REPAIR"],
      description: "Demo · Xe chết máy, cần chở về tiệm",
    });
  for (const [index, category] of [
    "FLOOD",
    "ACCIDENT",
    "OBSTRUCTION",
  ].entries()) {
    const description = `Demo · ${["Ngập nhẹ sau mưa, đi chậm", "Va chạm xe, lưu ý khi qua giao lộ", "Công trình chiếm một phần làn đường"][index]}`;
    const existing = await HazardFlag.findOne({
      where: {
        userId: rider.userId,
        description,
        status: { [Op.ne]: "4" },
        expiresAt: { [Op.gt]: new Date() },
      },
    });
    if (!existing)
      await Flags.create(rider, {
        category,
        description,
        latitude: point.latitude + (index - 1) * 0.003,
        longitude: point.longitude + 0.004,
        address: "Demo · Trung tâm Quận 1",
        radiusMeters: 50,
        ttlMinutes: 1440,
      });
  }
  for (const user of [admin, rider, shopOwner, mobileOwner, towOwner])
    for (const [name, category, latitude, longitude] of [
      ["Demo · Nhà", "HOME", 10.771, 106.698],
      ["Demo · Văn phòng", "WORK", 10.783, 106.706],
    ])
      await SavedPlace.findOrCreate({
        where: { userId: user.userId, name },
        defaults: { category, latitude, longitude, address: "Quận 1, TP.HCM" },
      });
  await PlatformSetting.upsert({
    key: SEED_MARKER,
    value: { completed: true, version: 1 },
    updatedBy: admin.userId,
  });
  console.log(
    "[DEMO SEED]: Ready — 5 accounts, 3 providers, 7 rescue tickets, mock bills/payments, ratings, chat, hazards and saved places.",
  );
  for (const user of [admin, rider, shopOwner, mobileOwner, towOwner])
    console.log(`${user.email} — ${(await user.reload()).role}`);
  console.log(`Password for newly created demo accounts: ${password}`);
}
async function seedOnStartup() {
  if (config.app.isProduction || !config.seeds.demo)
    return { seeded: false, reason: "disabled" };
  if (!["mock", "sandbox"].includes(config.sepay.mode)) {
    console.log("[DEMO SEED]: Skipped — PAYMENT_GATEWAY_MODE is not mock or sandbox");
    return { seeded: false, reason: "payment-mode" };
  }
  const marker = await PlatformSetting.findByPk(SEED_MARKER);
  if (marker?.value?.completed)
    return { seeded: false, reason: "already-seeded" };
  await seed();
  return { seeded: true };
}
module.exports = { seed, seedOnStartup, SEED_MARKER };
