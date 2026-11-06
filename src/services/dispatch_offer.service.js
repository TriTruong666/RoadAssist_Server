const { Op } = require("sequelize");
const db = require("../config/postgres.config");
const { DispatchTicket: Ticket, Provider } = require("../models");
const { PENDING } = require("../common/dispatch.constants");
const Policy = require("./dispatch_policy.service");
const changes = new (require("node:events").EventEmitter)();
changes.setMaxListeners(0);
const HOLD_MS = 5 * 60 * 1000;
const active = () => ({ status: { [Op.in]: PENDING }, providerId: null });
class Offers {
  static signal() { changes.emit("changed"); }
  static async reserve(ticket, transaction) {
    if (
      ticket.targetProviderId ||
      ticket.offeredProviderId ||
      ticket.offerPublicAt ||
      ticket.type === "WALK_IN"
    )
      return;
    await db.query("SELECT pg_advisory_xact_lock(657193, 9)", { transaction });
    const candidates =
      await require("./dispatch_notification.service").candidates(
        ticket,
        transaction,
      );
    for (const p of candidates) {
      const owned = await Provider.findAll({
        where: { userId: p.userId },
        attributes: ["id"],
        transaction,
      });
      if (
        await Ticket.count({
          where: {
            ...active(),
            offeredProviderId: { [Op.in]: owned.map((row) => row.id) },
            offerPublicAt: null,
            offerExpiresAt: { [Op.gt]: new Date() },
          },
          transaction,
        })
      )
        continue;
      const expires = new Date(Date.now() + HOLD_MS);
      await ticket.update(
        {
          offeredProviderId: p.id,
          offerExpiresAt: expires,
          queueExpiresAt:
            !ticket.queueExpiresAt || ticket.queueExpiresAt < expires
              ? expires
              : ticket.queueExpiresAt,
        },
        { transaction },
      );
      return;
    }
  }
  static async release(actor, id) {
    return require("./dispatch.service").fresh(
      actor,
      id,
      {},
      async (ticket, transaction) => {
        const p =
          ticket.offeredProviderId &&
          (await Provider.findOne({
            where: { id: ticket.offeredProviderId, userId: actor.userId },
            transaction,
          }));
        if (!p)
          Policy.fail(
            "DISPATCH_OFFER_NOT_FOUND",
            "Không có đề xuất dành cho bạn",
            404,
          );
        if (ticket.offerPublicAt) return { released: true };
        Policy.state(ticket, PENDING);
        await ticket.update({ offerPublicAt: new Date() }, { transaction });
        await require("./dispatch_notification.service").enqueue(
          ticket,
          actor.userId,
          "dispatch-public",
          transaction,
        );
        return { released: true };
      },
    );
  }
  static async sweep() {
    let cursor;
    for (;;) {
      const rows = await Ticket.findAll({
        where: {
          ...active(),
          targetProviderId: null,
          offerPublicAt: null,
          [Op.or]: [
            { offeredProviderId: null },
            { offerExpiresAt: { [Op.lte]: new Date() } },
          ],
          ...(cursor && { id: { [Op.gt]: cursor } }),
        },
        limit: 100,
        order: [["id", "ASC"]],
      });
      if (!rows.length) break;
      for (const row of rows)
        await require("./dispatch.service").fresh(
          { userId: row.userId, system: true },
          row.id,
          {},
          async (t, transaction) => {
            if (!PENDING.includes(t.status) || t.providerId || t.offerPublicAt)
              return;
            if (t.offeredProviderId && t.offerExpiresAt <= new Date()) {
              await t.update({ offerPublicAt: new Date() }, { transaction });
              await require("./dispatch_notification.service").enqueue(
                t,
                null,
                "dispatch-public",
                transaction,
              );
            } else if (!t.offeredProviderId) {
              await this.reserve(t, transaction);
              if (t.offeredProviderId)
                await require("./dispatch_notification.service").enqueue(
                  t,
                  null,
                  "dispatch-offer",
                  transaction,
                );
            }
          },
        );
      cursor = rows.at(-1).id;
    }
  }

  static async mine(actor) {
    const profiles = await Provider.findAll({
      where: { userId: actor.userId },
    });
    return Ticket.findAll({
      where: {
        ...active(),
        offeredProviderId: { [Op.in]: profiles.map((p) => p.id) },
        offerPublicAt: null,
        offerExpiresAt: { [Op.gt]: new Date() },
      },
      order: [["createdAt", "ASC"]],
    }).then((rows) =>
      rows.map((t) => require("./dispatch_notification.service").summary(t)),
    );
  }
  static async feed(actor) {
    const profiles = await Provider.findAll({
      where: {
        userId: actor.userId,
        accepting: true,
        status: "ACTIVE",
        suspended: false,
      },
    });
    const rows = [];
    for (const profile of profiles) {
      if (
        !(await require("./provider_availability.service").describe(profile))
          .available
      )
        continue;
      rows.push(
        ...(await require("./dispatch.service").feed(actor, {
          providerId: profile.id,
          limit: 100,
        })),
      );
    }
    return [...new Map(rows.map((row) => [row.id, row])).values()];
  }
  static async stream(req, res) {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    let closed = false,
      running = false,
      previous = "";
    const poll = async () => {
      if (closed || running) return;
      running = true;
      try {
        const user = await require("./jwt.service").verifyUserSession(
          req.cookies?.road_as_token,
        );
        if (!user) {
          res.end();
          return;
        }
        const data = JSON.stringify({
          items: await this.mine(req.user),
          feed: await this.feed(req.user),
        });
        if (!closed && data !== previous) {
          previous = data;
          res.write(`event: offers\ndata: ${data}\n\n`);
        } else if (!closed) res.write(": heartbeat\n\n");
      } catch {
        res.end();
      } finally {
        running = false;
      }
    };
    const changed = () => void poll();
    changes.on("changed", changed);
    const timer = setInterval(() => void poll(), 2000);
    req.on("close", () => {
      closed = true;
      clearInterval(timer);
      changes.off("changed", changed);
    });
    res.on("close", () => {
      closed = true;
      clearInterval(timer);
      changes.off("changed", changed);
    });
    void poll();
  }
}
module.exports = Offers;
