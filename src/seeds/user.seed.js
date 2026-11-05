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
  return seedAdmin({
    email,
    password,
    phone,
    name: process.env.ADMIN_SEED_NAME,
  });
}

async function seedAdmin({ email, password, phone, name }) {
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
    if (!existing.emailVerifiedAt && (await existing.comparePassword(password)))
      await existing.update({ emailVerifiedAt: new Date() });
    return existing;
  }
  return User.create({
    email,
    password,
    phone,
    name: name || "RoadAssist Admin",
    role: "admin",
    services: ["RIDER"],
    emailVerifiedAt: new Date(),
    onboarded: true,
  });
}

/** Seed exactly one administrator: environment credentials override the JSON account. */
async function seedUsers() {
  const envAdmin = await seedSystemAdmin();
  if (envAdmin) return [envAdmin];
  const records = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "seed_data", "user_seed.json"),
      "utf8",
    ),
  );
  if (
    !Array.isArray(records) ||
    records.length !== 1 ||
    records[0].role !== "admin"
  )
    throw new Error("user_seed.json must contain exactly one admin account");
  const record = records[0];
  return [
    await seedAdmin({
      ...record,
      email: record.email?.trim().toLowerCase(),
      phone: record.phone?.trim(),
    }),
  ];
}

module.exports = { seedUsers, seedSystemAdmin };
