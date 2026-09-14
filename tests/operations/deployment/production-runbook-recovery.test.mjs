// Source-level assertion rationale: executing the exceptional production runbook
// end to end would mutate production and recovery state. These tests extract and
// execute its real Bash blocks locally where safe, and inspect source only for
// immutable operator contracts that cannot be exercised without that boundary.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bashBlockContaining,
  bashPath,
  createRecoveryFixture,
  historicalSourceSha,
  runRecoveryInitialization,
  toBashPath,
  write,
} from "./support/production-runbook-fixture.mjs";

const runbookUrl = new URL("../../../docs/operations/DEPLOY_VPS.md", import.meta.url);
test("delayed recovery reconstructs exact release and backup provenance from one private record", async () => {
  const runbook = await readFile(runbookUrl, "utf8");
  const initialization = bashBlockContaining(runbook, "AL_LIO_SELECTED_RELEASE_RECORD");
  const fixture = await createRecoveryFixture();
  try {
    const result = await runRecoveryInitialization(initialization, fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^backup=${fixture.backupPath}$`, "m"));
    assert.match(result.stdout, new RegExp(`^checksum=${fixture.checksum}$`, "m"));
    assert.match(result.stdout, /^current=[0-9a-f]{40}$/m);
    assert.match(result.stdout, /^candidate=[0-9a-f]{40}$/m);
    assert.match(result.stdout, /^outcome=learning-import-completed$/m);
    assert.match(result.stdout, /^import=completed$/m);

    const releaseRecord = bashBlockContaining(runbook, "rollback_release_path");
    for (const exactField of [
      "printf 'base_url=%s\\n' \"$AL_LIO_BASE_URL\"",
      "printf 'postgres_container_id=%s\\n' \"$AL_LIO_POSTGRES_ID\"",
      "printf 'radar_container_id=%s\\n' \"$AL_LIO_RADAR_ID\"",
      "printf 'db_backup_path=%s\\n' \"$AL_LIO_POSTGRES_BACKUP\"",
      "printf 'db_backup_checksum=%s\\n' \"$AL_LIO_POSTGRES_BACKUP_CHECKSUM\"",
    ]) {
      assert.ok(releaseRecord.includes(exactField), `release record omits ${exactField}`);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a held production deploy lock rejects delayed recovery before operational actions", async () => {
  const initialization = bashBlockContaining(
    await readFile(runbookUrl, "utf8"),
    "AL_LIO_SELECTED_RELEASE_RECORD",
  );
  const fixture = await createRecoveryFixture();
  const lockPath = toBashPath(join(fixture.backupDir, "deploy-production.lock"));
  const trace = join(fixture.root, "locked-recovery-actions.log");
  const hasFlock = spawnSync(bashPath, ["-lc", "command -v flock >/dev/null"]).status === 0;
  const holder = hasFlock
    ? spawn(
      bashPath,
      ["-c", `exec 9>"${lockPath}"; flock -n 9 || exit 1; printf 'locked\\n'; read -r _`],
      { stdio: ["pipe", "pipe", "pipe"] },
    )
    : null;
  try {
    if (holder) {
      await new Promise((resolve, reject) => {
        holder.once("error", reject);
        holder.once("exit", (code) => reject(new Error(`lock holder exited early: ${code}`)));
        holder.stdout.once("data", (chunk) => {
          if (chunk.toString().includes("locked")) resolve();
          else reject(new Error(`unexpected lock-holder output: ${chunk}`));
        });
      });
    }
    await writeFile(trace, "", "utf8");
    const tracePath = toBashPath(trace);
    const result = await runRecoveryInitialization(
      initialization,
      fixture,
      fixture.requiredRecord,
      {
        flockResult: hasFlock ? "0" : "1",
        preamble: `TRACE="${tracePath}"
docker() { printf 'docker %s\\n' "$*" >> "$TRACE"; }
bash() { printf 'bash %s\\n' "$*" >> "$TRACE"; }`,
        postamble: `docker inspect al_lio_postgres --format '{{.Id}}'
bash scripts/postgres/verify-backup-production.sh backup.dump
docker stop al_lio_web
docker exec al_lio_postgres dropdb -U al_lio al_lio`,
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CRITICAL: another production deploy or recovery session holds the shared lock/);
    assert.equal(await readFile(trace, "utf8"), "");
  } finally {
    if (holder && holder.exitCode === null) {
      holder.stdin.end("release\n");
      await new Promise((resolve) => holder.once("close", resolve));
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const [name, currentSha, releaseIdentity, expectedStatus, expectedError] of [
  [
    "exact historical previous without AL_LIO_RELEASE_SHA",
    historicalSourceSha,
    null,
    0,
    null,
  ],
  ["exact historical previous with empty identity", historicalSourceSha, "", 0, null],
  [
    "non-historical previous without AL_LIO_RELEASE_SHA",
    "a".repeat(40),
    null,
    1,
    /previous release \.env has no mandatory AL_LIO_RELEASE_SHA/,
  ],
  [
    "non-historical previous with empty identity",
    "a".repeat(40),
    "",
    1,
    /previous release \.env has an empty mandatory AL_LIO_RELEASE_SHA/,
  ],
  ["non-historical previous with exact identity", "a".repeat(40), "exact", 0, null],
  [
    "non-historical previous with mismatched identity",
    "a".repeat(40),
    "b".repeat(40),
    1,
    /previous release identity does not match its SHA/,
  ],
]) {
  test(`previous release identity policy handles ${name}`, async () => {
    const initialization = bashBlockContaining(
      await readFile(runbookUrl, "utf8"),
      "AL_LIO_SELECTED_RELEASE_RECORD",
    );
    const policyStart = initialization.indexOf("AL_LIO_HISTORICAL_LEGACY_RELEASE_SHA=");
    const policyEnd = initialization.indexOf(
      "\nvalidate_recovery_worktree previous",
      policyStart,
    );
    assert.ok(policyStart >= 0 && policyEnd > policyStart);
    const policy = initialization.slice(policyStart, policyEnd);
    const root = await mkdtemp(join(tmpdir(), "al-lio-previous-identity-"));
    const envFile = join(root, ".env");
    const identityLine = releaseIdentity === null
      ? ""
      : `AL_LIO_RELEASE_SHA=${releaseIdentity === "exact" ? currentSha : releaseIdentity}\n`;
    await writeFile(
      envFile,
      `AL_LIO_IMAGE_TAG=${currentSha}\n${identityLine}`,
      "utf8",
    );
    try {
      const result = spawnSync(bashPath, ["-s"], {
        encoding: "utf8",
        input: `set -Eeuo pipefail
AL_LIO_CURRENT_SHA=${currentSha}
PREVIOUS_RELEASE="${toBashPath(root)}"
validate_release_worktree_integrity() { return 0; }
read_env_value() {
  local key="$1" env_file="$2" line
  line="$(grep -E "^\${key}=" "$env_file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  printf '%s' "\${line#*=}"
}
stat() {
  case "$2" in
    %a) printf '600\\n' ;;
    %u) printf '197609\\n' ;;
    *) command stat "$@" ;;
  esac
}
id() { if [[ "\${1:-}" == -u ]]; then printf '197609\\n'; else command id "$@"; fi; }
${policy}
validate_recovery_worktree previous "$PREVIOUS_RELEASE" "$AL_LIO_CURRENT_SHA" \
  "$AL_LIO_PREVIOUS_IDENTITY_REQUIREMENT"
`,
      });
      assert.equal(result.status, expectedStatus, result.stderr);
      if (expectedError) assert.match(result.stderr, expectedError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("non-historical previous release cannot omit AL_LIO_RELEASE_SHA during initialization", async () => {
  const initialization = bashBlockContaining(
    await readFile(runbookUrl, "utf8"),
    "AL_LIO_SELECTED_RELEASE_RECORD",
  );
  const fixture = await createRecoveryFixture();
  try {
    await writeFile(
      join(fixture.previousRelease, ".env"),
      `AL_LIO_IMAGE_TAG=${fixture.currentSha}\n`,
      "utf8",
    );
    const result = await runRecoveryInitialization(initialization, fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /previous release \.env has no mandatory AL_LIO_RELEASE_SHA/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const [name, mutate, expectedError, options = {}] of [
  [
    "an arbitrary temporary release path",
    async (fixture) => fixture.requiredRecord.replace(
      `previous_release_path=${toBashPath(fixture.previousRelease)}`,
      `previous_release_path=/tmp/attacker/al-lio-${fixture.currentSha.slice(0, 12)}`,
    ),
    /outside the exact SHA-derived release root/,
  ],
  [
    "a similarly prefixed but different release root",
    async (fixture) => fixture.requiredRecord.replace(
      `candidate_release_path=${toBashPath(fixture.candidateRelease)}`,
      `candidate_release_path=${fixture.releasesRootPath}-other/al-lio-${fixture.candidateSha.slice(0, 12)}`,
    ),
    /outside the exact SHA-derived release root/,
  ],
  [
    "a dirty previous worktree",
    async (fixture) => {
      await writeFile(join(fixture.previousRelease, "marker.txt"), "dirty previous\n", "utf8");
      return fixture.requiredRecord;
    },
    /previous worktree integrity failed: Release worktree contains unexpected tracked or untracked files/,
  ],
  [
    "a dirty candidate worktree",
    async (fixture) => {
      await writeFile(join(fixture.candidateRelease, "marker.txt"), "dirty candidate\n", "utf8");
      return fixture.requiredRecord;
    },
    /candidate worktree integrity failed: Release worktree contains unexpected tracked or untracked files/,
  ],
  [
    "an unexpected untracked file",
    async (fixture) => {
      await writeFile(join(fixture.previousRelease, "unexpected.txt"), "unexpected\n", "utf8");
      return fixture.requiredRecord;
    },
    /previous worktree integrity failed: Release worktree contains unexpected tracked or untracked files/,
  ],
  [
    "an unexpected ignored file",
    async (fixture) => {
      await writeFile(join(fixture.candidateRelease, ".git", "info", "exclude"), ".cache/\n", "utf8");
      await write(fixture.candidateRelease, ".cache/unexpected", "unexpected\n");
      return fixture.requiredRecord;
    },
    /candidate worktree integrity failed: Release worktree contains an unexpected ignored file/,
  ],
  [
    "a previous .env symlink",
    async (fixture) => {
      const envPath = join(fixture.previousRelease, ".env");
      const target = join(fixture.root, "hostile-env-directory");
      await mkdir(target);
      await writeFile(
        join(target, "values"),
        `AL_LIO_IMAGE_TAG=${fixture.currentSha}\n`,
        "utf8",
      );
      await unlink(envPath);
      await symlink(target, envPath, "junction");
      return fixture.requiredRecord;
    },
    /previous worktree integrity failed:/,
  ],
  [
    "a candidate image tag mismatch",
    async (fixture) => {
      await writeFile(
        join(fixture.candidateRelease, ".env"),
        `AL_LIO_IMAGE_TAG=${"f".repeat(40)}\nAL_LIO_RELEASE_SHA=${fixture.candidateSha}\n`,
        "utf8",
      );
      return fixture.requiredRecord;
    },
    /candidate release image tag does not match its SHA/,
  ],
  [
    "a candidate missing AL_LIO_RELEASE_SHA",
    async (fixture) => {
      await writeFile(
        join(fixture.candidateRelease, ".env"),
        `AL_LIO_IMAGE_TAG=${fixture.candidateSha}\n`,
        "utf8",
      );
      return fixture.requiredRecord;
    },
    /candidate release \.env has no mandatory AL_LIO_RELEASE_SHA/,
  ],
  [
    "a candidate with empty AL_LIO_RELEASE_SHA",
    async (fixture) => {
      await writeFile(
        join(fixture.candidateRelease, ".env"),
        `AL_LIO_IMAGE_TAG=${fixture.candidateSha}\nAL_LIO_RELEASE_SHA=\n`,
        "utf8",
      );
      return fixture.requiredRecord;
    },
    /candidate release \.env has an empty mandatory AL_LIO_RELEASE_SHA/,
  ],
  [
    "a candidate AL_LIO_RELEASE_SHA mismatch",
    async (fixture) => {
      await writeFile(
        join(fixture.candidateRelease, ".env"),
        `AL_LIO_IMAGE_TAG=${fixture.candidateSha}\nAL_LIO_RELEASE_SHA=${"f".repeat(40)}\n`,
        "utf8",
      );
      return fixture.requiredRecord;
    },
    /candidate release identity does not match its SHA/,
  ],
  [
    "a previous AL_LIO_RELEASE_SHA mismatch",
    async (fixture) => {
      await writeFile(
        join(fixture.previousRelease, ".env"),
        `AL_LIO_IMAGE_TAG=${fixture.currentSha}\nAL_LIO_RELEASE_SHA=${"f".repeat(40)}\n`,
        "utf8",
      );
      return fixture.requiredRecord;
    },
    /previous release identity does not match its SHA/,
  ],
  [
    "a release .env with mode other than 600",
    async (fixture) => fixture.requiredRecord,
    /previous release \.env must be mode 600 and owned by the operator/,
    { envMode: "644" },
  ],
]) {
  test(`delayed recovery rejects ${name}`, async () => {
    const initialization = bashBlockContaining(
      await readFile(runbookUrl, "utf8"),
      "AL_LIO_SELECTED_RELEASE_RECORD",
    );
    const fixture = await createRecoveryFixture();
    try {
      const recordContents = await mutate(fixture);
      const rejected = await runRecoveryInitialization(
        initialization,
        fixture,
        recordContents,
        options,
      );
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, expectedError);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("delayed recovery rejects malformed and duplicate release-record keys", async () => {
  const initialization = bashBlockContaining(
    await readFile(runbookUrl, "utf8"),
    "AL_LIO_SELECTED_RELEASE_RECORD",
  );
  const fixture = await createRecoveryFixture();
  try {
    const malformed = await runRecoveryInitialization(
      initialization,
      fixture,
      `${fixture.requiredRecord}not-an-assignment\n`,
    );
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /malformed release-record line/);

    const duplicate = await runRecoveryInitialization(
      initialization,
      fixture,
      `${fixture.requiredRecord}current_sha=${"0".repeat(40)}\n`,
    );
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /duplicate release-record key: current_sha/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const [name, hostileBytes] of [
  ["NUL", Buffer.from([0])],
  ["control byte", Buffer.from([1])],
  ["DEL", Buffer.from([127])],
  ["lone CR", Buffer.from([13])],
]) {
  test(`release-record raw-byte validation rejects ${name} before parsing`, async () => {
    const initialization = bashBlockContaining(
      await readFile(runbookUrl, "utf8"),
      "AL_LIO_SELECTED_RELEASE_RECORD",
    );
    const fixture = await createRecoveryFixture();
    try {
      const hostileRecord = Buffer.concat([
        Buffer.from(fixture.requiredRecord, "ascii"),
        hostileBytes,
      ]);
      const rejected = await runRecoveryInitialization(initialization, fixture, hostileRecord);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /invalid raw bytes or an unpaired CR/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("unknown release-record data is rejected without evaluation", async () => {
  const initialization = bashBlockContaining(
    await readFile(runbookUrl, "utf8"),
    "AL_LIO_SELECTED_RELEASE_RECORD",
  );
  const fixture = await createRecoveryFixture();
  const sentinel = join(fixture.root, "must-not-exist");
  try {
    const hostileRecord = `${fixture.requiredRecord}dangerous_key=$(touch ${toBashPath(sentinel)})\n`;
    const rejected = await runRecoveryInitialization(initialization, fixture, hostileRecord);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /unknown release-record key: dangerous_key/);
    await assert.rejects(readFile(sentinel), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("application rollback failure is visible, recorded and non-zero", async () => {
  const rollback = bashBlockContaining(
    await readFile(runbookUrl, "utf8"),
    "perform_application_rollback()",
  );
  const fixture = await createRecoveryFixture();
  try {
    const previousRelease = toBashPath(fixture.previousRelease);
    const evidence = toBashPath(join(fixture.root, "rollback-events.log"));
    const result = spawnSync(bashPath, ["-s"], {
      encoding: "utf8",
      input: `set -Eeuo pipefail
AL_LIO_PREVIOUS_RELEASE_DIR="${previousRelease}"
AL_LIO_CURRENT_IMAGE="al-lio-web:current"
AL_LIO_CANDIDATE_IMAGE="al-lio-web:candidate"
AL_LIO_CURRENT_SHA="${"0".repeat(40)}"
AL_LIO_PREVIOUS_IDENTITY_REQUIREMENT=required
AL_LIO_BASE_URL="https://al-lio.example.invalid"
AL_LIO_POSTGRES_ID=postgres-fixture-id
AL_LIO_RADAR_ID=radar-fixture-id
AL_LIO_RECOVERY_INCIDENT_LOG="${evidence}"
docker() { return 1; }
validate_recovery_worktree() { return 0; }
wait_for_web_health() { return 1; }
read_env_value() { return 1; }
record_delayed_recovery_event() { printf '%s %s %s\\n' "$1" "$2" "$3" >> "$AL_LIO_RECOVERY_INCIDENT_LOG"; }
${rollback}
`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CRITICAL: application rollback failed/);
    assert.match(await readFile(join(fixture.root, "rollback-events.log"), "utf8"), /application-rollback failed runtime-validation/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const [name, webImage, postgresId, radarId, expectedError] of [
  [
    "a stale later web image",
    "al-lio-web:later-release",
    "postgres-fixture-id",
    "radar-fixture-id",
    /active web image does not match the selected recovery record/,
  ],
  [
    "a wrong PostgreSQL container ID",
    "al-lio-web:candidate",
    "wrong-postgres",
    "radar-fixture-id",
    /PostgreSQL container identity does not match the selected recovery record/,
  ],
  [
    "a wrong Radar container ID",
    "al-lio-web:candidate",
    "postgres-fixture-id",
    "wrong-radar",
    /Radar container identity does not match the selected recovery record/,
  ],
]) {
  test(`application rollback rejects ${name} before compose mutation`, async () => {
    const rollbackBlock = bashBlockContaining(
      await readFile(runbookUrl, "utf8"),
      "perform_application_rollback()",
    );
    const functionStart = rollbackBlock.indexOf("perform_application_rollback()");
    const functionEnd = rollbackBlock.indexOf("\nif ! perform_application_rollback", functionStart);
    assert.ok(functionStart >= 0 && functionEnd > functionStart);
    const rollbackFunction = rollbackBlock.slice(functionStart, functionEnd);
    const root = await mkdtemp(join(tmpdir(), "al-lio-stale-rollback-"));
    const trace = join(root, "compose.log");
    await writeFile(trace, "", "utf8");
    try {
      const result = spawnSync(bashPath, ["-s"], {
        encoding: "utf8",
        input: `set -Eeuo pipefail
AL_LIO_PREVIOUS_RELEASE_DIR="${toBashPath(root)}"
AL_LIO_CURRENT_SHA=${"0".repeat(40)}
AL_LIO_CURRENT_IMAGE=al-lio-web:current
AL_LIO_CANDIDATE_IMAGE=al-lio-web:candidate
AL_LIO_POSTGRES_ID=postgres-fixture-id
AL_LIO_RADAR_ID=radar-fixture-id
AL_LIO_PREVIOUS_IDENTITY_REQUIREMENT=required
TRACE="${toBashPath(trace)}"
WEB_IMAGE="${webImage}"
POSTGRES_ID="${postgresId}"
RADAR_ID="${radarId}"
validate_recovery_worktree() { return 0; }
docker() {
  if [[ "\${1:-}" == inspect ]]; then
    case "\${2:-}:$*" in
      al_lio_web:*Config.Image*) printf '%s\\n' "$WEB_IMAGE" ;;
      al_lio_postgres:*Id*) printf '%s\\n' "$POSTGRES_ID" ;;
      al_lio_radar:*Id*) printf '%s\\n' "$RADAR_ID" ;;
    esac
    return 0
  fi
  printf '%s\\n' "$*" >> "$TRACE"
}
wait_for_web_health() { return 0; }
read_env_value() { printf '%s' "$AL_LIO_CURRENT_SHA"; }
${rollbackFunction}
perform_application_rollback
`,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expectedError);
      assert.equal(await readFile(trace, "utf8"), "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("automatic post-cutover cleanup cannot hide a failed web rollback", async () => {
  const cleanup = bashBlockContaining(
    await readFile(runbookUrl, "utf8"),
    "cleanup_manual_release()",
  );
  const root = await mkdtemp(join(tmpdir(), "al-lio-runbook-cleanup-"));
  const previousRelease = join(root, "al-lio-previous");
  await mkdir(previousRelease);
  try {
    const result = spawnSync(bashPath, ["-s"], {
      encoding: "utf8",
      input: `set -Eeuo pipefail
AL_LIO_BACKUP_DIR="${toBashPath(root)}"
AL_LIO_RELEASE_SHA="${"a".repeat(40)}"
${cleanup}
docker() { return 1; }
wait_for_web_health() { return 1; }
AL_LIO_PREVIOUS_RELEASE_DIR="${toBashPath(previousRelease)}"
AL_LIO_CUTOVER_STARTED=1
AL_LIO_POSTGRES_BACKUP=/srv/danicode/backups/al-lio/exact-pre-import.dump
AL_LIO_POSTGRES_BACKUP_CHECKSUM="${"b".repeat(64)}"
AL_LIO_LEARNING_IMPORT_RESULT=completed
false
`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CRITICAL: automatic web rollback command failed/);
    assert.match(result.stderr, /CRITICAL: automatic runtime recovery is incomplete/);
    const evidence = await readFile(join(root, "runtime-recovery-aaaaaaaaaaaa.log"), "utf8");
    assert.match(evidence, /result=failed detail=automatic-web-rollback-command/);
    assert.match(evidence, /^db_backup_path=\/srv\/danicode\/backups\/al-lio\/exact-pre-import\.dump$/m);
    assert.match(evidence, new RegExp(`^db_backup_checksum=${"b".repeat(64)}$`, "m"));
    assert.match(evidence, /^learning_import_result=completed$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an import-completed failed cutover remains reconstructible after the SSH session is lost", async () => {
  const runbook = await readFile(runbookUrl, "utf8");
  const cleanup = bashBlockContaining(runbook, "cleanup_manual_release()");
  const attemptRecord = bashBlockContaining(runbook, "write_attempt_recovery_record()");
  const initialization = bashBlockContaining(runbook, "AL_LIO_SELECTED_RELEASE_RECORD");
  const fixture = await createRecoveryFixture();
  const startedAt = "20260907T000000Z";
  const attemptPath = join(
    fixture.backupDir,
    `release-${startedAt}-${fixture.candidateSha.slice(0, 12)}-attempt.txt`,
  );
  try {
    const failedAttempt = spawnSync(bashPath, ["-s"], {
      encoding: "utf8",
      input: `set -Eeuo pipefail
stat() {
  if [[ "$1" == -c && "$2" == %a ]]; then printf '600\\n'; else command stat "$@"; fi
}
AL_LIO_BACKUP_DIR="${fixture.backupDirPath}"
AL_LIO_RELEASE_STARTED_AT=${startedAt}
AL_LIO_CURRENT_SHA=${fixture.currentSha}
AL_LIO_RELEASE_SHA=${fixture.candidateSha}
AL_LIO_PREVIOUS_RELEASE_DIR="${toBashPath(fixture.previousRelease)}"
AL_LIO_RELEASE_DIR="${toBashPath(fixture.candidateRelease)}"
AL_LIO_BASE_URL=https://al-lio.example.invalid
AL_LIO_CURRENT_IMAGE=al-lio-web:${fixture.currentSha}
AL_LIO_POSTGRES_ID=postgres-fixture-id
AL_LIO_RADAR_ID=radar-fixture-id
AL_LIO_POSTGRES_BACKUP="${fixture.backupPath}"
AL_LIO_POSTGRES_BACKUP_CHECKSUM=${fixture.checksum}
AL_LIO_LEARNING_IMPORT_RESULT=not-started
${cleanup}
${attemptRecord}
AL_LIO_LEARNING_IMPORT_RESULT=completed
AL_LIO_ATTEMPT_OUTCOME=learning-import-completed
write_attempt_recovery_record
AL_LIO_CUTOVER_STARTED=1
docker() { return 1; }
wait_for_web_health() { return 1; }
false
`,
    });
    assert.notEqual(failedAttempt.status, 0);
    assert.match(failedAttempt.stderr, /CRITICAL: automatic web rollback command failed/);
    const persisted = await readFile(attemptPath, "utf8");
    assert.match(persisted, /^outcome=learning-import-completed$/m);
    assert.match(persisted, /^learning_import_result=completed$/m);
    assert.match(persisted, new RegExp(`^db_backup_checksum=${fixture.checksum}$`, "m"));

    const recoveredFixture = {
      ...fixture,
      record: attemptPath,
      recordPath: toBashPath(attemptPath),
    };
    const reconstructed = await runRecoveryInitialization(
      initialization,
      recoveredFixture,
      null,
    );
    assert.equal(reconstructed.status, 0, reconstructed.stderr);
    assert.match(reconstructed.stdout, /^outcome=learning-import-completed$/m);
    assert.match(reconstructed.stdout, /^import=completed$/m);
    assert.match(reconstructed.stdout, new RegExp(`^backup=${fixture.backupPath}$`, "m"));
    assert.match(reconstructed.stdout, new RegExp(`^checksum=${fixture.checksum}$`, "m"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
