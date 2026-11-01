const fs = require("node:fs");
const path = require("node:path");
const { Op } = require("sequelize");
const User = require("../models/user.model");

/**
 * Seed system admin from environment variables (explicit credentials).
 * Used for deployment pipelines and integration tests.
 */
async function seedSystemAdmin() {
  const email = process.env.ADMIN_SEED_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_SEED_PASSWORD;
  const phone = process.env.ADMIN_SEED_PHONE;
  if (!email && !password && !phone) return;
  if (
    !email ||
    !password ||
    !phone ||
    password.length < 8 ||
    Buffer.byteLength(password) > 72 ||
    !/^\+?\d{9,15}$/.test(phone)
  ) {
    throw new Error(
      "Admin seed requires a valid ADMIN_SEED_EMAIL, ADMIN_SEED_PHONE and an 8–72 byte ADMIN_SEED_PASSWORD",
    );
  }
  const existing = await User.findOne({
    where: { [Op.or]: [{ email }, { phone }] },
  });
  if (existing) {
    if (
      existing.role !== "admin" ||
      existing.email !== email ||
      existing.phone !== phone
    ) {
      throw new Error("Admin seed identity conflicts with an existing account");
    }
    return existing;
  }
  return User.create({
    email,
    password,
    phone,
    name: process.env.ADMIN_SEED_NAME || "RoadAssist Admin",
    role: "admin",
    services: ["RIDER"],
    onboarded: true,
  });
}

/**
 * Seed initial user accounts for 3 primary roles (admin, guest, provider)
 * from src/seeds/seed_data/user_seed.json.
 */
async function seedUsers() {
  const results = [];
  const seedFilePath = path.join(__dirname, "seed_data", "user_seed.json");

  if (fs.existsSync(seedFilePath)) {
    try {
      const rawData = fs.readFileSync(seedFilePath, "utf8");
      const usersData = JSON.parse(rawData);

      if (Array.isArray(usersData)) {
        for (const item of usersData) {
          const email = item.email?.trim().toLowerCase();
          const phone = item.phone?.trim();

          if (!email || !phone) continue;

          const existing = await User.findOne({
            where: { [Op.or]: [{ email }, { phone }] },
          });

          if (existing) {
            console.log(
              `[SEED]: Người dùng ${email} (${existing.role}) đã tồn tại trong DB, bỏ qua.`,
            );
            results.push(existing);
          } else {
            const created = await User.create({
              name: item.name || "RoadAssist User",
              email,
              password: item.password,
              phone,
              role: item.role || "guest",
              services: item.services || ["RIDER"],
              status: item.status || "ACTIVE",
              onboarded: item.onboarded !== undefined ? item.onboarded : true,
            });
            console.log(
              `[SEED]: Đã tạo tài khoản mẫu thành công: ${created.email} [Role: ${created.role}]`,
            );
            results.push(created);
          }
        }
      }
    } catch (error) {
      console.error("[SEED ERROR]: Không thể nạp dữ liệu từ user_seed.json:", error.message);
    }
  }

  // Also check if custom environment variable admin is specified
  const envAdmin = await seedSystemAdmin();
  if (envAdmin) {
    results.push(envAdmin);
  }

  return results;
}

module.exports = {
  seedUsers,
  seedSystemAdmin,
};

