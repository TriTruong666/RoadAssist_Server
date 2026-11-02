module.exports = {
  assertConfigured() {
    const c = require("../config/app.config").operations;
    for (const [key, value] of Object.entries(c)) {
      const bounds = {
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
      }[key];
      if (!Number.isInteger(value) || value < bounds[0] || value > bounds[1])
        throw new Error(`Invalid operations setting ${key}`);
    }
  },
};
