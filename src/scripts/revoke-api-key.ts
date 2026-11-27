// Lists or revokes API keys. Revoked keys stay in the table (decisions point at them) and stop working at once.
//   npm run keys:revoke -- --list                      active keys: prefix, role, label, last used
//   npm run keys:revoke -- --prefix dlx_Q3vA           one key, by the prefix shown in the listing
//   npm run keys:revoke -- --label "relecteur-1"       every active key with exactly this label
//   production: docker compose exec app node dist/scripts/revoke-api-key.js --label "relecteur-1"
import { parseArgs } from 'node:util';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db, sql } from '../db/client';
import { apiKeys } from '../db/schema';
import { revokeApiKey } from '../services/api-keys.service';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { list: { type: 'boolean' }, prefix: { type: 'string' }, label: { type: 'string' } },
  });
  const active = isNull(apiKeys.revokedAt);
  const columns = { id: apiKeys.id, prefix: apiKeys.prefix, role: apiKeys.role, label: apiKeys.label, lastUsedAt: apiKeys.lastUsedAt };

  if (values.list) {
    const rows = await db.select(columns).from(apiKeys).where(active).orderBy(asc(apiKeys.role), asc(apiKeys.label));
    for (const k of rows) console.log(`${k.prefix}…  ${k.role.padEnd(11)}  ${k.label}  (last used: ${k.lastUsedAt?.toISOString() ?? 'never'})`);
    console.log(`${rows.length} active key(s)`);
    return;
  }

  const prefix = values.prefix?.trim();
  const label = values.label?.trim();
  if ((prefix ? 1 : 0) + (label ? 1 : 0) !== 1) {
    throw new Error('Usage: --list | --prefix dlx_XXXX | --label "<label>" (exactly one)');
  }
  const rows = await db.select(columns).from(apiKeys)
    .where(and(active, prefix ? eq(apiKeys.prefix, prefix) : eq(apiKeys.label, label!)));
  if (rows.length === 0) throw new Error('No active key matches');
  // A prefix is 4 random characters: two keys can share one. Never revoke a key the caller did not mean.
  if (prefix && rows.length > 1) {
    throw new Error(`${rows.length} active keys share ${prefix}: ${rows.map((k) => `"${k.label}" (${k.id})`).join(', ')}. Use --label.`);
  }
  for (const k of rows) {
    if (await revokeApiKey(k.id)) console.log(`Revoked ${k.role} key ${k.prefix}… "${k.label}"`);
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
