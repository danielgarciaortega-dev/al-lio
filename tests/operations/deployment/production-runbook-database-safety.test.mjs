// Source-level assertion rationale: executing the exceptional production runbook
// end to end would mutate production and recovery state. These tests extract and
// execute its real Bash blocks locally where safe, and inspect source only for
// immutable operator contracts that cannot be exercised without that boundary.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bashBlockContaining,
  bashPath,
  createRecoveryFixture,
  toBashPath,
} from "./support/production-runbook-fixture.mjs";

const runbookUrl = new URL("../../../docs/operations/DEPLOY_VPS.md", import.meta.url);
test("every operational curl and wget probe has an overall bound", async () => {
  const runbook = await readFile(runbookUrl, "utf8");
  const bash = [...runbook.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)]
    .map((match) => match[1])
    .join("\n");
  const curlLines = bash.split(/\r?\n/).filter((line) => /\bcurl\b/.test(line));
  assert.ok(curlLines.length >= 10, "expected all operational curl probes to be present");
  for (const line of curlLines) {
    assert.match(line, /curl\b.*--connect-timeout 5\b/);
    assert.match(line, /curl\b.*--max-time 20\b/);
  }
  const wgetLines = bash.split(/\r?\n/).filter((line) => /\bwget\b/.test(line));
  assert.ok(wgetLines.length >= 7, "expected all internal wget probes to be present");
  for (const line of wgetLines) {
    assert.match(line, /timeout 20s docker exec\b.*\bwget -T 5\b/);
  }
});

test("a catalogue-only PostgreSQL mutation creates and verifies its backup before import", async () => {
  const runbook = await readFile(runbookUrl, "utf8");
  const mutationDecision = bashBlockContaining(runbook, "AL_LIO_MIGRATION_STATUS");
  const backup = bashBlockContaining(runbook, "AL_LIO_BACKUP_OUTPUT");
  const importGate = bashBlockContaining(runbook, "Learning catalogue import completed exactly once.");
  const root = await mkdtemp(join(tmpdir(), "al-lio-catalogue-backup-"));
  const dump = join(root, "catalogue-recovery.dump");
  const trace = join(root, "trace.log");
  const dumpBytes = Buffer.from("catalogue recovery point\n", "utf8");
  const checksum = createHash("sha256").update(dumpBytes).digest("hex");
  await writeFile(dump, dumpBytes);
  await writeFile(`${dump}.sha256`, `${checksum}  ${toBashPath(dump)}\n`, "utf8");
  try {
    const result = spawnSync(bashPath, ["-s"], {
      encoding: "utf8",
      input: `set -Eeuo pipefail
AL_LIO_BACKUP_DIR="${toBashPath(root)}"
AL_LIO_REPOSITORY_DIR=/fixture/repository
AL_LIO_CURRENT_SHA="${"0".repeat(40)}"
AL_LIO_RELEASE_SHA="${"1".repeat(40)}"
TRACE="${toBashPath(trace)}"
git() { return 1; }
docker() {
  case "$*" in
    *"migrate.mjs --status"*) printf 'APLICADA 0001_baseline.sql\\n' ;;
    *"import-learning-competencies.mjs"*) printf 'import\\n' >> "$TRACE" ;;
  esac
}
bash() {
  case "$1" in
    scripts/postgres/backup-production.sh)
      printf 'backup\\n' >> "$TRACE"
      printf 'Backup creado y validado: %s\\n' "${toBashPath(dump)}"
      ;;
    scripts/postgres/verify-backup-production.sh)
      [[ "$2" == "${toBashPath(dump)}" ]]
      printf 'verified\\n' >> "$TRACE"
      ;;
    *) command bash "$@" ;;
  esac
}
write_attempt_recovery_record() { printf 'attempt-update\\n' >> "$TRACE"; }
${mutationDecision}
${backup}
printf 'recovery-point-ready\\n' >> "$TRACE"
${importGate}
printf 'migration=%s\\nlearning=%s\\ndb_mutation=%s\\nrestore=%s\\nimport=%s\\n' \
  "$AL_LIO_MIGRATION_REQUIRED" "$AL_LIO_LEARNING_IMPORT_REQUIRED" \
  "$AL_LIO_DB_MUTATION_REQUIRED" "$AL_LIO_RESTORE_VERIFICATION" \
  "$AL_LIO_LEARNING_IMPORT_RESULT"
`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^migration=0$/m);
    assert.match(result.stdout, /^learning=1$/m);
    assert.match(result.stdout, /^db_mutation=1$/m);
    assert.match(result.stdout, /^restore=passed$/m);
    assert.match(result.stdout, /^import=completed$/m);
    assert.deepEqual(
      (await readFile(trace, "utf8")).trim().split("\n"),
      ["backup", "verified", "recovery-point-ready", "import", "attempt-update"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a git diff status above one rejects before backup or import", async () => {
  const runbook = await readFile(runbookUrl, "utf8");
  const mutationDecision = bashBlockContaining(runbook, "AL_LIO_MIGRATION_STATUS");
  const backup = bashBlockContaining(runbook, "AL_LIO_BACKUP_OUTPUT");
  const importGate = bashBlockContaining(runbook, "Learning catalogue import completed exactly once.");
  const root = await mkdtemp(join(tmpdir(), "al-lio-catalogue-diff-error-"));
  const trace = join(root, "mutation.log");
  try {
    const result = spawnSync(bashPath, ["-s"], {
      encoding: "utf8",
      input: `set -Eeuo pipefail
TRACE="${toBashPath(trace)}"
AL_LIO_BACKUP_DIR="${toBashPath(root)}"
AL_LIO_REPOSITORY_DIR=/fixture/repository
AL_LIO_CURRENT_SHA="${"0".repeat(40)}"
AL_LIO_RELEASE_SHA="${"1".repeat(40)}"
git() { return 2; }
docker() {
  case "$*" in
    *"migrate.mjs --status"*) printf 'APLICADA 0001_baseline.sql\\n' ;;
    *"import-learning-competencies.mjs"*) printf 'import\\n' >> "$TRACE" ;;
  esac
}
bash() { printf 'backup-or-verify\\n' >> "$TRACE"; }
${mutationDecision}
${backup}
${importGate}
`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unable to determine whether the learning catalogue changed/);
    await assert.rejects(readFile(trace), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("database recovery stops and verifies both writers before damaged-state backup and restore", async () => {
  const recovery = bashBlockContaining(
    await readFile(runbookUrl, "utf8"),
    "AL_LIO_DAMAGED_BACKUP_OUTPUT",
  );
  const orderedMarkers = [
    "docker stop --time 30 al_lio_radar",
    "docker stop --time 30 al_lio_web",
    "docker inspect al_lio_radar --format '{{.State.Status}}'",
    "docker inspect al_lio_web --format '{{.State.Status}}'",
    "AL_LIO_DAMAGED_BACKUP_OUTPUT=",
    "sha256sum --check \"$AL_LIO_DAMAGED_STATE_BACKUP.sha256\"",
    "docker exec al_lio_postgres dropdb",
  ];
  let previous = -1;
  for (const marker of orderedMarkers) {
    const position = recovery.indexOf(marker);
    assert.ok(position > previous, `${marker} is out of recovery order`);
    previous = position;
  }
  const firstIdentityGate = recovery.indexOf(
    "AL_LIO_PRE_DESTRUCTIVE_CONTAINER_IDENTITY=validated",
  );
  const secondIdentityGate = recovery.lastIndexOf(
    "if ! validate_pre_destructive_container_identity; then",
  );
  assert.ok(firstIdentityGate < recovery.indexOf("docker stop --time 30 al_lio_radar"));
  assert.ok(secondIdentityGate > recovery.indexOf("damaged-state-preserved"));
  assert.ok(secondIdentityGate < recovery.indexOf("docker exec al_lio_postgres dropdb"));
});

test("wrong PostgreSQL ID rejects before backup verification, stop and database destruction", async () => {
  const recovery = bashBlockContaining(
    await readFile(runbookUrl, "utf8"),
    "AL_LIO_DAMAGED_BACKUP_OUTPUT",
  );
  const gateStart = recovery.indexOf('AL_LIO_PRE_VERIFY_POSTGRES_ID="$(');
  const gateMarker = "AL_LIO_PRE_VERIFY_POSTGRES_IDENTITY=validated";
  const gateEnd = recovery.indexOf(gateMarker, gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  const gate = recovery.slice(gateStart, gateEnd + gateMarker.length);
  const root = await mkdtemp(join(tmpdir(), "al-lio-pre-verify-id-"));
  const trace = join(root, "operations.log");
  await writeFile(trace, "", "utf8");
  try {
    const result = spawnSync(bashPath, ["-s"], {
      encoding: "utf8",
      input: `set -Eeuo pipefail
AL_LIO_POSTGRES_ID=postgres-fixture-id
AL_LIO_RELEASE_DIR=/release/candidate
AL_LIO_RECOVERY_BACKUP=/backup/exact.dump
TRACE="${toBashPath(trace)}"
docker() {
  if [[ "\${1:-}" == inspect ]]; then
    printf 'wrong-postgres\\n'
    return 0
  fi
  printf 'docker %s\\n' "$*" >> "$TRACE"
}
bash() { printf 'bash %s\\n' "$*" >> "$TRACE"; }
${gate}
bash "$AL_LIO_RELEASE_DIR/scripts/postgres/verify-backup-production.sh" \
  "$AL_LIO_RECOVERY_BACKUP"
docker stop --time 30 al_lio_radar
docker exec al_lio_postgres dropdb -U al_lio al_lio
`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CRITICAL: PostgreSQL container identity changed before backup verification/);
    const calls = await readFile(trace, "utf8");
    assert.equal(calls, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, postgresId, radarId] of [
  ["wrong PostgreSQL container ID", "wrong-postgres", "radar-fixture-id"],
  ["wrong Radar container ID", "postgres-fixture-id", "wrong-radar"],
]) {
  test(`${name} rejects recovery before stop or database destruction`, async () => {
    const recovery = bashBlockContaining(
      await readFile(runbookUrl, "utf8"),
      "AL_LIO_DAMAGED_BACKUP_OUTPUT",
    );
    const gateStart = recovery.indexOf("validate_pre_destructive_container_identity()");
    const gateMarker = "AL_LIO_PRE_DESTRUCTIVE_CONTAINER_IDENTITY=validated";
    const gateEnd = recovery.indexOf(gateMarker, gateStart);
    assert.ok(gateStart >= 0 && gateEnd > gateStart);
    const gate = recovery.slice(gateStart, gateEnd + gateMarker.length);
    const root = await mkdtemp(join(tmpdir(), "al-lio-pre-destructive-id-"));
    const trace = join(root, "destructive.log");
    await writeFile(trace, "", "utf8");
    try {
      const result = spawnSync(bashPath, ["-s"], {
        encoding: "utf8",
        input: `set -Eeuo pipefail
AL_LIO_POSTGRES_ID=postgres-fixture-id
AL_LIO_RADAR_ID=radar-fixture-id
AL_LIO_CURRENT_IMAGE=al-lio-web:current
AL_LIO_CANDIDATE_IMAGE=al-lio-web:candidate
TRACE="${toBashPath(trace)}"
POSTGRES_ID=${postgresId}
RADAR_ID=${radarId}
docker() {
  if [[ "\${1:-}" == inspect ]]; then
    case "\${2:-}:$*" in
      al_lio_postgres:*Id*) printf '%s\\n' "$POSTGRES_ID" ;;
      al_lio_radar:*Id*) printf '%s\\n' "$RADAR_ID" ;;
      al_lio_web:*Config.Image*) printf '%s\\n' "$AL_LIO_CANDIDATE_IMAGE" ;;
    esac
    return 0
  fi
  printf '%s\\n' "$*" >> "$TRACE"
}
${gate}
docker stop --time 30 al_lio_radar
docker stop --time 30 al_lio_web
docker exec al_lio_postgres dropdb -U al_lio al_lio
docker exec al_lio_postgres createdb -U al_lio al_lio
docker exec -i al_lio_postgres pg_restore -U al_lio -d al_lio
`,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /CRITICAL: recorded container identity does not match/);
      const destructiveCalls = await readFile(trace, "utf8");
      assert.doesNotMatch(destructiveCalls, /\b(?:stop|dropdb|createdb|pg_restore)\b/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [name, webImage, postgresId, radarId, radarState] of [
  ["wrong previous image", "al-lio-web:wrong", "postgres-fixture-id", "radar-fixture-id", "running"],
  ["wrong PostgreSQL container ID", "expected", "wrong-postgres", "radar-fixture-id", "running"],
  ["wrong Radar container ID", "expected", "postgres-fixture-id", "wrong-radar", "running"],
  ["non-running Radar", "expected", "postgres-fixture-id", "radar-fixture-id", "exited"],
]) {
  test(`database recovery rejects ${name} without recording restored`, async () => {
    const recoveryBlock = bashBlockContaining(
      await readFile(runbookUrl, "utf8"),
      "perform_database_recovery_runtime_validation()",
    );
    const runtimeStart = recoveryBlock.indexOf("perform_database_recovery_runtime_validation()");
    assert.ok(runtimeStart >= 0);
    const runtimeValidation = recoveryBlock.slice(runtimeStart);
    const fixture = await createRecoveryFixture();
    const events = join(fixture.root, "database-recovery-events.log");
    const actualWebImage = webImage === "expected"
      ? `al-lio-web:${fixture.currentSha}`
      : webImage;
    try {
      const result = spawnSync(bashPath, ["-s"], {
        encoding: "utf8",
        input: `set -Eeuo pipefail
AL_LIO_PREVIOUS_RELEASE_DIR="${toBashPath(fixture.previousRelease)}"
AL_LIO_CURRENT_SHA=${fixture.currentSha}
AL_LIO_CURRENT_IMAGE=al-lio-web:${fixture.currentSha}
AL_LIO_PREVIOUS_IDENTITY_REQUIREMENT=required
AL_LIO_BASE_URL=https://al-lio.example.invalid
AL_LIO_POSTGRES_ID=postgres-fixture-id
AL_LIO_RADAR_ID=radar-fixture-id
AL_LIO_RECOVERY_BACKUP="${fixture.backupPath}"
AL_LIO_RECOVERY_BACKUP_CHECKSUM=${fixture.checksum}
EVENTS="${toBashPath(events)}"
WEB_IMAGE="${actualWebImage}"
POSTGRES_ID="${postgresId}"
RADAR_ID="${radarId}"
RADAR_STATE="${radarState}"
validate_recovery_worktree() { return 0; }
wait_for_web_health() { return 0; }
read_env_value() { printf '%s' "$AL_LIO_CURRENT_SHA"; }
record_delayed_recovery_event() { printf '%s\\n' "$2" >> "$EVENTS"; }
timeout() {
  if [[ "$*" == *api/version* ]]; then
    printf '{"releaseSha":"%s"}' "$AL_LIO_CURRENT_SHA"
  fi
}
curl() {
  if [[ "$*" == *api/version* ]]; then
    printf '{"releaseSha":"%s"}' "$AL_LIO_CURRENT_SHA"
  fi
}
docker() {
  if [[ "\${1:-}" == inspect ]]; then
    case "\${2:-}:$*" in
      al_lio_web:*Config.Image*) printf '%s\\n' "$WEB_IMAGE" ;;
      al_lio_postgres:*Id*) printf '%s\\n' "$POSTGRES_ID" ;;
      al_lio_radar:*Id*) printf '%s\\n' "$RADAR_ID" ;;
      al_lio_radar:*State.Status*) printf '%s\\n' "$RADAR_STATE" ;;
    esac
  fi
}
${runtimeValidation}
`,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /CRITICAL: database recovery runtime identity validation failed/);
      const recordedEvents = await readFile(events, "utf8");
      assert.match(recordedEvents, /^failed$/m);
      assert.doesNotMatch(recordedEvents, /^restored$/m);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("optional learning import skips unchanged data and runs exactly once when changed", async () => {
  const runbook = await readFile(runbookUrl, "utf8");
  const migrationBlock = bashBlockContaining(runbook, "SKIP: learning catalogue data is unchanged.");
  const gateStart = migrationBlock.indexOf('if [[ "$AL_LIO_LEARNING_IMPORT_REQUIRED" -eq 0 ]]');
  const gateEnd = migrationBlock.indexOf("\nfi", gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart, "learning import gate is missing");
  const gate = migrationBlock.slice(gateStart, gateEnd + 3);
  const root = await mkdtemp(join(tmpdir(), "al-lio-learning-import-"));
  try {
    for (const [importRequired, expectedResult, expectedCalls] of [
      [0, "skipped", 0],
      [1, "completed", 1],
    ]) {
      const importLog = join(root, `import-${importRequired}.log`);
      const result = spawnSync(bashPath, ["-s"], {
        encoding: "utf8",
        input: `set -Eeuo pipefail
IMPORT_LOG="${toBashPath(importLog)}"
AL_LIO_LEARNING_IMPORT_REQUIRED=${importRequired}
AL_LIO_REPOSITORY_DIR=/fixture/repository
AL_LIO_CURRENT_SHA="${"0".repeat(40)}"
AL_LIO_RELEASE_SHA="${"1".repeat(40)}"
docker() { printf '%s\\n' "$*" >> "$IMPORT_LOG"; }
write_attempt_recovery_record() { :; }
${gate}
printf 'result=%s\\n' "$AL_LIO_LEARNING_IMPORT_RESULT"
`,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`result=${expectedResult}`));
      let calls = [];
      try {
        calls = (await readFile(importLog, "utf8")).trim().split("\n").filter(Boolean);
      } catch (error) {
        assert.equal(error.code, "ENOENT");
      }
      assert.equal(calls.length, expectedCalls);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
