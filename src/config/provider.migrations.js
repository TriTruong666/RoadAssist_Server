// Run enum/index preparation before sync; data reconciliation runs after all new tables exist.
async function prepareProviderSchema(sequelize) {
  const Provider = sequelize.models.Provider;
  if (!Provider) return;
  const q = sequelize.getQueryInterface().queryGenerator;
  const table = q.quoteTable(Provider.getTableName());
  const [types] = await sequelize.query(`SELECT t.typname, n.nspname FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE a.attrelid=to_regclass(:table) AND a.attname='status'`, { replacements: { table } });
  if (!types.length) return;
  const type = `${q.quoteIdentifier(types[0].nspname)}.${q.quoteIdentifier(types[0].typname)}`;
  await sequelize.query(`ALTER TYPE ${type} ADD VALUE IF NOT EXISTS 'REVOKED'`);
  // Install the replacement before removing the old index: no unprotected write window.
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS providers_live_owner_kind ON ${table} (user_id, kind) WHERE status NOT IN ('DENIED', 'REVOKED')`);
  await sequelize.query(`DROP INDEX IF EXISTS ${q.quoteIdentifier(types[0].nspname)}.${q.quoteIdentifier('providers_user_id_kind')}`);
}
async function reconcileProviderData(sequelize) {
  const { Provider, ProviderDocument } = sequelize.models;
  if (!Provider) return;
  const rows = await Provider.findAll({ where: { status: ['DENIED', 'ACTIVE'] } });
  for (const candidate of rows) {
    await sequelize.transaction(async transaction => {
      await sequelize.models.User.findOne({ where: { userId: candidate.userId }, transaction, lock: transaction.LOCK.UPDATE });
      const profile = await Provider.findByPk(candidate.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (profile.status === 'DENIED' && profile.revokedAt) {
        await profile.update({ status: 'REVOKED', revocationReason: profile.revocationReason || 'LEGACY_REVOCATION' }, { transaction, auditAction: 'MIGRATED' });
      } else if (profile.status === 'ACTIVE' && profile.requiresApproval && profile.reviewedRevision !== profile.profileRevision) {
        await profile.update({ status: 'PENDING', accepting: false }, { transaction, auditAction: 'MIGRATED', auditReason: 'Cần bằng chứng và bản duyệt theo phiên bản hồ sơ' });
      }
    });
  }
}
module.exports = { prepareProviderSchema, reconcileProviderData };
