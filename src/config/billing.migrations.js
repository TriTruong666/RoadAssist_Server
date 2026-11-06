// Remove the former one-bill-per-journey constraint before Sequelize alters the table.
// Existing bills without ticket_id remain legacy records; historical money is never reassigned.
module.exports = async db => {
  const q = db.getQueryInterface().queryGenerator;
  const table = q.quoteTable(db.models.Bill.getTableName());
  const schema = process.env.DB_SCHEMA || 'public';
  const [constraints] = await db.query(`SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=:schema AND t.relname='bills' AND c.contype='u' AND pg_get_constraintdef(c.oid)='UNIQUE (journey_id)'`, { replacements:{schema} });
  for (const row of constraints) await db.query(`ALTER TABLE ${table} DROP CONSTRAINT ${q.quoteIdentifier(row.conname)}`);
};
