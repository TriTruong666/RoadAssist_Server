const { Sequelize } = require("sequelize");
const config = require("./app.config");
const sequelize = new Sequelize(
  config.db.name,
  config.db.user,
  config.db.password,
  {
    host: config.db.host,
    port: config.db.port,
    dialect: "postgres",
    logging: false,
    define: { schema: process.env.DB_SCHEMA || "public" },
  }
);

module.exports = sequelize;
