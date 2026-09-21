import { AiRouterError } from './errors.js';

const migrations = new Map();
export function registerDescriptorMigration(from, to, migrate) {
  const key = `${from}->${to}`;
  if (migrations.has(key) || typeof migrate !== 'function') throw new AiRouterError('Descriptor migration registration is invalid.', 'INVALID_DESCRIPTOR_MIGRATION');
  migrations.set(key, migrate);
}

export function inspectDescriptorVersion(descriptor, supported = '0.1') {
  if (descriptor?.schema_version === supported) return { status: 'current', version: supported, supported };
  const available = [...migrations.keys()].filter((key) => key.startsWith(`${descriptor?.schema_version}->`));
  return { status: available.length ? 'migration-available' : 'unsupported', version: descriptor?.schema_version ?? null, supported, available };
}

export async function migrateDescriptorExplicit(store, projectId, taskId, targetVersion) {
  const raw = await import('./json-store.js').then(({ readJson }) => readJson(store.path(projectId, taskId)));
  if (raw.schema_version === targetVersion) return { descriptor: raw, migrated: false, backup: null };
  const migrate = migrations.get(`${raw.schema_version}->${targetVersion}`);
  if (!migrate) throw new AiRouterError(`No migration from ${raw.schema_version} to ${targetVersion}.`, 'DESCRIPTOR_MIGRATION_UNAVAILABLE');
  const backup = await store.backup(projectId, taskId);
  const migrated = await migrate(structuredClone(raw));
  migrated.schema_version = targetVersion;
  return { descriptor: await store.save(migrated), migrated: true, backup };
}
