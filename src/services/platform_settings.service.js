const db = require("../config/postgres.config");
const { PlatformSetting } = require("../models");
const config = require("../config/app.config");
const fail = require("./dispatch_policy.service").fail;
const BOUNDS = {
  operations: {
    disputeResponseHours: [1, 168],
    cashGraceHours: [0, 168],
    cashMaxUnpaidTickets: [1, 20],
    queueTtlMinutes: [1, 1440],
    arrivalTimeoutMinutes: [1, 1440],
    noProgressMinutes: [1, 240],
    minProgressMeters: [10, 1000],
    maxRematches: [1, 20],
    intakeReplyMinutes: [1, 60],
    intakeHoldMinutes: [5, 1440],
  },
  dispatch: {
    sosCallOutFee: [0, 10000000],
    sosPerKm: [0, 1000000],
    towBaseFee: [0, 10000000],
    towPerKm: [0, 1000000],
    waitingPerMinute: [0, 1000000],
  },
  sepay: { commissionRate: [0, 1], towCommissionRate: [0, 1] },
};
const defaults = Object.fromEntries(
  Object.entries(BOUNDS).map(([group, keys]) => [
    group,
    Object.fromEntries(
      Object.keys(keys).map((key) => [key, Number(config[group][key])]),
    ),
  ]),
);
class Settings {
  static validate(values) {
    if (!values || typeof values !== "object" || Array.isArray(values))
      fail("VALIDATION_ERROR", "Cấu hình không hợp lệ", 400);
    for (const [group, entries] of Object.entries(values)) {
      if (
        !BOUNDS[group] ||
        !entries ||
        typeof entries !== "object" ||
        Array.isArray(entries)
      )
        fail("VALIDATION_ERROR", "Nhóm cấu hình không hợp lệ", 400);
      for (const [key, value] of Object.entries(entries)) {
        const bounds = BOUNDS[group][key];
        if (
          !bounds ||
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < bounds[0] ||
          value > bounds[1] ||
          (!["commissionRate", "towCommissionRate"].includes(key) && !Number.isInteger(value))
        )
          fail("VALIDATION_ERROR", `Giá trị ${group}.${key} không hợp lệ`, 400);
      }
    }
  }
  static merge(value = {}) {
    this.validate(value);
    return Object.fromEntries(
      Object.keys(BOUNDS).map((group) => [
        group,
        { ...defaults[group], ...value[group] },
      ]),
    );
  }
  static apply(values) {
    this.validate(values);
    for (const group of Object.keys(BOUNDS))
      Object.assign(config[group], values[group]);
  }
  static async load() {
    const row = await PlatformSetting.findByPk("operational");
    const values = this.merge(row?.value);
    this.apply(values);
    return {
      revision: row?.revision || 0,
      values,
      bounds: BOUNDS,
      paymentMode: config.sepay.mode,
    };
  }
  static async update(actor, { revision, values }) {
    this.validate(values);
    const result = await db.transaction(async (transaction) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext(:key))", {
        replacements: {
          key: `roadassist:settings:${process.env.DB_SCHEMA || "public"}`,
        },
        transaction,
      });
      const row = await PlatformSetting.findByPk("operational", {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (revision !== (row?.revision || 0))
        fail(
          "SETTINGS_REVISION_CONFLICT",
          "Cấu hình đã thay đổi. Hãy tải lại trước khi lưu",
          409,
        );
      const merged = this.merge(row?.value);
      for (const group of Object.keys(BOUNDS))
        Object.assign(merged[group], values[group]);
      const data = {
        value: merged,
        revision: revision + 1,
        updatedBy: actor.userId,
      };
      const saved = row
        ? await row.update(data, { transaction })
        : await PlatformSetting.create(
            { key: "operational", ...data },
            { transaction },
          );
      transaction.afterCommit(() => this.apply(saved.value));
      return {
        revision: saved.revision,
        values: saved.value,
        bounds: BOUNDS,
        paymentMode: config.sepay.mode,
      };
    });
    return result;
  }
}
module.exports = Settings;
