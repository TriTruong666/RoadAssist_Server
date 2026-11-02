// Existing transport scenarios perform the newly-required two-party handover.
// Dedicated custody tests exercise missing/stale evidence and authentication failures.
const { randomUUID } = require("node:crypto");
module.exports = async (ticketId, phase) => {
  const {
    DispatchTicket: Ticket,
    Provider,
    S3Asset,
    Handover,
  } = require("../src/models");
  const t = await Ticket.findByPk(ticketId);
  if (
    !t ||
    t.type !== "TOW" ||
    !t.handoverRequired ||
    t.status !== (phase === "PICKUP" ? "3" : "6")
  )
    return;
  const Service = require("../src/services/handover.service");
  const p = await Provider.findByPk(t.providerId);
  const recipient = await Service.recipient(t, phase);
  if (
    await Handover.findOne({
      where: {
        ticketId,
        phase,
        status: "CONFIRMED",
        providerId: t.providerId,
        recipientId: recipient,
        ...(phase === "DELIVERY" && { destinationShopId: t.dropoffShopId }),
      },
    })
  )
    return;
  // Preserve the original GPS-negative scenarios: no evidence may bypass location checks.
  try {
    require("../src/services/dispatch_policy.service").trustedLocation(p, {
      latitude: phase === "PICKUP" ? t.pickupLatitude : t.dropoffLatitude,
      longitude: phase === "PICKUP" ? t.pickupLongitude : t.dropoffLongitude,
    });
  } catch {
    return;
  }
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const key = randomUUID();
    const a = await S3Asset.create({
      userId: p.userId,
      s3Key: `roadassist/${key}.jpg`,
      s3Url: `https://s3.test/roadassist/${key}.jpg`,
      s3Bucket: "picare-s3",
      s3Region: "ap-southeast-1",
      originalName: "condition.jpg",
      mimeType: "image/jpeg",
      fileSize: 100,
    });
    ids.push(a.id);
  }
  const row = await Service.propose({ userId: p.userId }, ticketId, {
    phase,
    assetIds: ids,
    condition: "Ảnh tình trạng xe trong kịch bản tích hợp",
    damages: [],
  });
  await Service.respond({ userId: recipient }, ticketId, {
    handoverId: row.id,
  });
};
