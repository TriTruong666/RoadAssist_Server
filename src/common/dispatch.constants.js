const STATUS = Object.freeze({
  PENDING: "1",
  MATCHED: "2",
  ARRIVED: "3",
  RESOLVED: "4",
  CANCELLED: "5",
  IN_PROGRESS: "6",
  READY: "7",
  DECLINED: "8",
  QUOTED: "9",
  IN_SHOP: "10",
  FINAL_QUOTED: "11",
  RESOLVED_UNFIXABLE: "12",
  ESTIMATED: "13",
  EST_APPROVED: "14",
  UNFIXABLE: "15",
});
const TERMINAL = Object.freeze(["4", "5", "8", "12", "15"]);
const PENDING = Object.freeze(["1", "13", "14"]);
const KIND = Object.freeze({ WALK_IN: "SHOP", SOS: "MOBILE_SHOP", TOW: "TOW" });
module.exports = { STATUS, TERMINAL, PENDING, KIND };
