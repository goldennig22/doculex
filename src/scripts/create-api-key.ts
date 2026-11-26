// Creates an API key and prints it ONCE. Only its SHA-256 is stored: a lost key is revoked and replaced.
//   npm run keys:create -- --role reviewer --label "law-clinic-reviewer-1"
//   production: docker compose exec app node dist/scripts/create-api-key.js --role admin --label "hermann"
import { parseArgs } from 'node:util';
import { createApiKey } from '../services/api-keys.service';
import { sql } from '../db/client';
import type { Role } from '../interfaces/types';

const ROLES: Role[] = ['admin', 'reviewer', 'contributor'];
const isRole = (r: string | undefined): r is Role => ROLES.some((role) => role === r);

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { role: { type: 'string' }, label: { type: 'string' } } });
  const label = values.label?.trim();
  if (!isRole(values.role) || !label) {
    throw new Error(`Usage: --role ${ROLES.join('|')} --label "<who holds it>"`);
  }

  const key = await createApiKey(values.role, label);
  console.log(`Created ${values.role} key ${key.prefix}… for "${label}" (id ${key.id})`);
  console.log('\n  ' + key.plaintext + '\n');
  console.log('This is the only time the key is shown. Send it to its holder over a private channel.');
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
