// Source-level assertion rationale: production container replacement is an external race,
// and executing the real deployment boundary would mutate production. These tests protect
// both the fail-closed identity primitive and its placement before every
// identity-sensitive deployment boundary.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const deployUrl = new URL("../../../scripts/deploy-production.sh", import.meta.url);
const bashPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";

function extractShellFunction(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `unterminated ${name}`);
  return source.slice(start, end + 2);
}

function assertBarrierBefore(source, assertion, operation) {
  const assertionIndex = source.indexOf(assertion);
  assert.ok(assertionIndex >= 0, `missing barrier: ${assertion}`);
  const operationIndex = source.indexOf(operation, assertionIndex);
  assert.ok(operationIndex > assertionIndex, `missing operation after barrier: ${operation}`);
}

test("a replaced named container fails the identity primitive before downstream execution", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(deployUrl, "utf8");
  const identityFunction = extractShellFunction(source, "assert_preserved_container_identity");
  const root = await mkdtemp(join(tmpdir(), "al-lio-container-identity-"));
  const sentinel = join(root, "downstream-ran");

  try {
    const harness = `set -Eeuo pipefail\n${identityFunction}\nfail() { printf 'ERROR: %s\\n' "$*" >&2; exit 1; }\ndocker() {\n  if [[ "$1" == inspect && "$2" == al_lio_postgres ]]; then\n    printf '%s\\n' replacement-container-id\n    return 0\n  fi\n  return 99\n}\nassert_preserved_container_identity al_lio_postgres expected-container-id PostgreSQL rehearsal\nprintf ran > "${sentinel.replaceAll("\\", "/")}"\n`;
    const result = spawnSync(bashPath, ["-s"], { encoding: "utf8", input: harness });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PostgreSQL container identity changed before rehearsal/);
    await assert.rejects(access(sentinel), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routine deploy binds PostgreSQL and Radar operations to captured IDs with fresh barriers", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(deployUrl, "utf8");

  assert.match(source, /assert_preserved_container_identity\(\)/);
  assert.match(source, /AL_LIO_POSTGRES_CONTAINER="\$postgres_container_id"[\s\\\n]+AL_LIO_BACKUP_DIR/);
  assert.match(source, /AL_LIO_POSTGRES_CONTAINER="\$postgres_container_id"[\s\\\n]+bash "\$release_dir\/scripts\/postgres\/verify-backup-production\.sh"/);
  assert.match(source, /docker exec "\$postgres_container_id" createdb/);
  assert.match(source, /docker exec -i "\$postgres_container_id" pg_restore/);
  assert.match(source, /docker exec "\$postgres_container_id" psql -U al_lio -d "\$rehearsal_database"/);
  assert.match(source, /docker exec "\$postgres_container_id" psql -U al_lio -d al_lio/);
  assert.match(source, /docker stop --time 30 "\$radar_container_id"/);
  assert.match(source, /docker start "\$radar_container_id"/);

  assert.doesNotMatch(source, /docker exec(?: -i)? "\$POSTGRES_CONTAINER"/);
  assert.doesNotMatch(source, /docker stop --time 30 "\$RADAR_CONTAINER"/);
  assert.doesNotMatch(source, /docker start "\$RADAR_CONTAINER"/);

  const boundaries = [
    ['assert_postgres_identity "candidate migration baseline audit"', 'audit_output="$('],
    ['assert_postgres_identity "candidate migration status inspection"', 'migration_status_output="$('],
    ['assert_postgres_identity "production backup"', 'backup_output="$('],
    ['assert_postgres_identity "backup restore verification"', 'AL_LIO_POSTGRES_CONTAINER="$postgres_container_id"'],
    ['assert_postgres_identity "migration rehearsal database creation"', 'docker exec "$postgres_container_id" createdb'],
    ['assert_postgres_identity "migration rehearsal"', '"${compose[@]}" --profile ops run --rm -T -e DATABASE_MIGRATION_URL'],
    ['assert_postgres_identity "migration rehearsal ledger verification"', 'rehearsal_migration_count="$('],
    ['assert_radar_identity "Radar writer stop"', 'docker stop --time 30 "$radar_container_id"'],
    ['assert_postgres_identity "production migration baseline audit"', '"${compose[@]}" --profile ops run --rm -T al_lio_migrator node scripts/postgres/audit-baseline.mjs'],
    ['assert_postgres_identity "production migrations"', '"${compose[@]}" --profile ops run --rm -T al_lio_migrator </dev/null'],
    ['assert_postgres_identity "production migration ledger verification"', 'production_migration_count="$('],
    ['assert_postgres_identity "web cutover"', 'web_replacement_started=1'],
    ['assert_radar_identity "web cutover"', 'web_replacement_started=1'],
  ];

  for (const [barrier, operation] of boundaries) {
    assertBarrierBefore(source, barrier, operation);
  }
});

test("cleanup refuses to act on a replacement database or Radar container", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(deployUrl, "utf8");
  const drop = extractShellFunction(source, "drop_rehearsal_database");
  const restart = extractShellFunction(source, "restart_preserved_radar");

  assert.match(drop, /current_postgres_id.*\{\{\.Id\}\}/s);
  assert.match(drop, /"\$current_postgres_id" == "\$postgres_container_id"/);
  assert.match(drop, /docker exec "\$postgres_container_id" dropdb/);
  assert.match(restart, /current_radar_id.*\{\{\.Id\}\}/s);
  assert.match(restart, /"\$current_radar_id" == "\$radar_container_id"/);
  assert.match(restart, /docker start "\$radar_container_id"/);
});
