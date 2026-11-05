const { Op, UniqueConstraintError } = require("sequelize");
const db = require("../config/postgres.config");
const { User } = require("../models");
const {
  ConflictException,
  NotFoundException,
  ForbiddenException,
} = require("../common/exceptions/BaseException");
const Access = require("./provider_access.service");

// Explicit account fields; never return passwords, sessions, push tokens or IPs.
const fields = [
  "userId",
  "name",
  "email",
  "phone",
  "avatar",
  "role",
  "status",
  "onboarded",
  "approved",
  "emailVerifiedAt",
  "createdAt",
  "updatedAt",
];
const dto = (user) =>
  Object.fromEntries(fields.map((key) => [key, user.get(key)]));
class Accounts {
  static async online(app) {
    const sockets = await app?.get("chatIO")?.fetchSockets();
    return new Set(
      (sockets || []).flatMap((socket) =>
        [...socket.rooms]
          .filter((room) => room.startsWith("user:"))
          .map((room) => room.slice(5)),
      ),
    );
  }
  static async list(params, app) {
    const { page = 1, limit = 10, search, role, sort = "by_date" } = params;
    const online = await this.online(app);
    const where = {
      ...(role && { role }),
      ...(search && {
        [Op.or]: ["name", "email", "phone"].map((field) => ({
          [field]: { [Op.iLike]: `%${search.replace(/[\\%_]/g, "\\$&")}%` },
        })),
      }),
    };
    // Stable global sorting, applied before pagination.
    const order =
      sort === "by_status"
        ? [
            [
              db.literal(
                `CASE WHEN "User"."user_id" IN (${[...online].map((id) => db.escape(id)).join(",") || "NULL"}) THEN 0 ELSE 1 END`,
              ),
              "ASC",
            ],
            ["createdAt", "DESC"],
            ["userId", "ASC"],
          ]
        : [
            ["createdAt", "DESC"],
            ["userId", "ASC"],
          ];
    const { rows, count } = await User.findAndCountAll({
      attributes: fields,
      where,
      order,
      offset: (page - 1) * limit,
      limit,
    });
    return {
      items: rows.map((user) => ({
        ...dto(user),
        isOnline: online.has(user.userId),
      })),
      total: count,
      page,
      limit,
    };
  }
  static async detail(id, app) {
    const user = await User.findOne({
      where: { userId: id },
      attributes: fields,
    });
    if (!user) throw new NotFoundException("Không tìm thấy tài khoản");
    const online = await this.online(app);
    return { ...dto(user), isOnline: online.has(user.userId) };
  }
  static async update(actor, id, data, app) {
    try {
      await db.transaction(async (transaction) => {
        const user = await User.findOne({
          where: { userId: id },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!user) throw new NotFoundException("Không tìm thấy tài khoản");
        // Keep admin access intact; this screen does not change roles or disable admins.
        if (user.role === "admin" && ((data.status && data.status !== "ACTIVE") || data.approved === false))
          throw new ForbiddenException(
            "Không thể khóa tài khoản quản trị tại đây",
          );
        if (data.approved === true && !user.onboarded && user.role !== "admin")
          throw new ConflictException("Tài khoản chưa hoàn tất thiết lập");
        await user.update(
          {
            ...(data.name !== undefined && { name: data.name }),
            ...(data.phone !== undefined && { phone: data.phone }),
            ...(data.status !== undefined && { status: data.status }),
            ...(data.approved !== undefined && { approved: data.approved }),
          },
          { transaction },
        );
        await Access.synchronize(user, transaction);
      });
      return this.detail(id, app);
    } catch (error) {
      if (error instanceof UniqueConstraintError)
        throw new ConflictException("Số điện thoại đã được sử dụng");
      throw error;
    }
  }
}
module.exports = Accounts;
