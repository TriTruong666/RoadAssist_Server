const { Op } = require('sequelize');
const User = require('../models/user.model');
// Explicit credentials only. Re-running startup never overwrites or promotes an existing account.
async function seedSystemAdmin() {
  const email = process.env.ADMIN_SEED_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_SEED_PASSWORD;
  const phone = process.env.ADMIN_SEED_PHONE;
  if (!email && !password && !phone) return;
  if (!email || !password || !phone || password.length < 8 || Buffer.byteLength(password) > 72 || !/^\+?\d{9,15}$/.test(phone)) {
    throw new Error('Admin seed requires a valid ADMIN_SEED_EMAIL, ADMIN_SEED_PHONE and an 8–72 byte ADMIN_SEED_PASSWORD');
  }
  const existing = await User.findOne({ where: { [Op.or]: [{ email }, { phone }] } });
  if (existing) {
    if (existing.role !== 'admin' || existing.email !== email || existing.phone !== phone) throw new Error('Admin seed identity conflicts with an existing account');
    return existing;
  }
  return User.create({ email, password, phone, name: process.env.ADMIN_SEED_NAME || 'RoadAssist Admin', role: 'admin', services: ['RIDER'], onboarded: true });
}
module.exports = { seedSystemAdmin };
