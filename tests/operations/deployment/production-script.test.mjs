// Source-level assertions intentionally protect the production shell contract because executing it would mutate remote state.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const deployScriptUrl = new URL("../../../scripts/deploy-production.sh", import.meta.url);
const transitionPolicyUrl = new URL("../../../scripts/lib/production-transition-policy.sh", import.meta.url);
const composeGuardUrl = new URL("../../../scripts/lib/compose-env-guard.sh", import.meta.url);
const approvalsUrl = new URL("../../../scripts/config/production-compose-env-removals.allowlist", import.meta.url);
const releaseEnvUrl = new URL("../../../scripts/prepare-release-env.sh", import.meta.url);
const worktreeIntegrityUrl = new URL("../../../scripts/lib/release-worktree-integrity.sh", import.meta.url);
const guideUrl = new URL("../../../docs/operations/AUTONOMOUS_PRODUCTION_DEPLOY.md", import.meta.url);
const dockerfileUrl = new URL("../../../infra/Dockerfile", import.meta.url);
const bashPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";

function toBashPath(path) {
  return path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
}

function shellTextOutsideQuotes(line, maskDoubleQuotes) {
  let result = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (escaped) {
      result += quote ? " " : character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      result += quote ? " " : character;
      escaped = true;
      continue;
    }
    if (quote === "'") {
      result += " ";
      if (character === "'") quote = "";
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = "";
        result += " ";
      } else {
        result += maskDoubleQuotes ? " " : character;
      }
      continue;
    }
    if (character === "'") {
      quote = "'";
      result += " ";
      continue;
    }
    if (character === '"') {
      quote = '"';
      result += " ";
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(line[index - 1]))) break;
    result += character;
  }
  return result;
}

const shellCommandBoundary = String.raw`(?:^\s*|(?:&&|\|\||[;|!(])\s*|\b(?:if|elif|while|until|then|do)\s+)`;
const shellCommandWrappers = String.raw`(?:(?:command\s+)|(?:env(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s]+)+\s+))*`;
const curlInvocationPattern = new RegExp(`${shellCommandBoundary}${shellCommandWrappers}curl(?:\\s|$)`);
const curlSubstitutionPattern = new RegExp(String.raw`\$\(\s*${shellCommandWrappers}curl(?:\s|$)`);
const dockerWgetCommand = String.raw`${shellCommandWrappers}(?:timeout\s+\S+\s+)?docker\s+exec\b.*\bwget(?:\s|$)`;
const dockerWgetInvocationPattern = new RegExp(`${shellCommandBoundary}${dockerWgetCommand}`);
const dockerWgetSubstitutionPattern = new RegExp(String.raw`\$\(\s*${dockerWgetCommand}`);

function isCurlInvocation(line) {
  return curlInvocationPattern.test(shellTextOutsideQuotes(line, true))
    || curlSubstitutionPattern.test(shellTextOutsideQuotes(line, false));
}

function isDockerExecWgetInvocation(line) {
  return dockerWgetInvocationPattern.test(shellTextOutsideQuotes(line, true))
    || dockerWgetSubstitutionPattern.test(shellTextOutsideQuotes(line, false));
}

function classifyCurlLine(line) {
  if (!/\bcurl\b/.test(line)) return "absent";
  if (isCurlInvocation(line)) return "invocation";
  const command = line.trim();
  if (command.startsWith("#") || /^for\s+command_name\b.*\bcurl\b/.test(command)) return "excluded";
  if (!/\bcurl\b/.test(shellTextOutsideQuotes(line, true))) return "excluded";
  return "unclassified";
}

function classifyDockerExecWgetLine(line) {
  if (!/\bdocker\s+exec\b.*\bwget\b/.test(line)) return "absent";
  if (isDockerExecWgetInvocation(line)) return "invocation";
  const command = line.trim();
  if (command.startsWith("#")) return "excluded";
  if (!/\bdocker\s+exec\b.*\bwget\b/.test(shellTextOutsideQuotes(line, true))) return "excluded";
  return "unclassified";
}

function extractRoutineBackupBash(source) {
  const validatorStart = source.indexOf("validate_postgres_backup_output() {");
  const validatorEnd = source.indexOf("\n}\n\nwrite_release_record()", validatorStart);
  const flowStart = source.indexOf('  log "Creating and restore-testing the PostgreSQL backup"');
  const flowEndMarker = '    --no-acl < "$postgres_backup_file"';
  const flowEnd = source.indexOf(flowEndMarker, flowStart) + flowEndMarker.length;
  const releaseRecordLine = source
    .split(/\r?\n/)
    .find((line) => line.includes("printf 'db_backup_path=%s\\n'"));
  assert.ok(validatorStart >= 0 && validatorEnd > validatorStart);
  assert.ok(flowStart >= 0 && flowEnd >= flowStart + flowEndMarker.length);
  assert.ok(releaseRecordLine);
  return {
    validator: source.slice(validatorStart, validatorEnd + 2),
    flow: source.slice(flowStart, flowEnd),
    releaseRecordLine,
  };
}

async function createFileSymlinkWithRestrictedWindowsFallback(target, link, contents) {
  await writeFile(target, contents);
  await rm(link);
  try {
    await symlink(target, link, "file");
  } catch (error) {
    if (error?.code !== "EPERM" || process.platform !== "win32") throw error;
    await rm(target);
    await mkdir(target);
    await symlink(target, link, "junction");
  }
  assert.equal((await lstat(link)).isSymbolicLink(), true);
}

test("the production command delegates every current-to-candidate decision to one shared policy", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const policy = await readFile(transitionPolicyUrl, "utf8");

  assert.match(source, /source .*production-transition-policy\.sh/);
  assert.match(source, /validate_production_transition "\$repository_dir" "\$current_sha" "\$release_sha" origin\/main/);
  assert.match(policy, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(policy, /merge-base --is-ancestor "\$candidate_sha" "\$main_ref"/);
  assert.match(policy, /merge-base --is-ancestor "\$current_sha" "\$candidate_sha"/);
  assert.match(policy, /validate_compose_env_transition/);
  assert.match(policy, /infra\/Dockerfile/);
  assert.match(policy, /Existing migrations are immutable/);
  assert.match(policy, /drop\[\[:space:\]\]\+\(table\|schema\|column\|index\)/);
  assert.match(source, /worktree add --detach "\$release_dir" "\$release_sha"/);
  assert.match(source, /flock -n 9/);
});

test("the command protects state before applying pending migrations", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const backupIndex = source.indexOf("backup-production.sh");
  const restoreIndex = source.indexOf("verify-backup-production.sh");
  const rehearsalIndex = source.indexOf("Rehearsing all pending migrations");
  const productionMigrationIndex = source.indexOf("Applying rehearsed migrations to production");

  assert.ok(backupIndex > -1);
  assert.ok(restoreIndex > backupIndex);
  assert.ok(rehearsalIndex > restoreIndex);
  assert.ok(productionMigrationIndex > rehearsalIndex);
  assert.match(source, /al_lio_rehearsal_/);
  assert.match(source, /schema_migrations/);
  assert.match(source, /migration_file_count="\$\(find "\$release_dir\/infra\/postgres\/migrations"/);
  assert.match(source, /expected_migration_count="\$\(\(migration_file_count \+ 1\)\)"/);
});

test("routine backup provenance rejects hostile output and artifacts before downstream actions", async (t) => {
  const source = await readFile(deployScriptUrl, "utf8");
  const { validator, flow, releaseRecordLine } = extractRoutineBackupBash(source);
  const scenarios = [
    {
      name: "exact declared dump and exact sidecar pass",
      expectedStatus: 0,
    },
    {
      name: "one non-empty output line is rejected",
      output: ({ dump }) => `Backup creado y validado: ${toBashPath(dump)}\n`,
      error: /output must contain exactly the declared dump and checksum lines/,
    },
    {
      name: "wrong dump label is rejected",
      output: ({ dump, sidecar }) => `Backup ready: ${toBashPath(dump)}\nChecksum: ${toBashPath(sidecar)}\n`,
      error: /did not declare the exact dump path/,
    },
    {
      name: "wrong checksum label is rejected",
      output: ({ dump, sidecar }) => `Backup creado y validado: ${toBashPath(dump)}\nDigest: ${toBashPath(sidecar)}\n`,
      error: /did not declare the exact checksum path/,
    },
    {
      name: "an extra non-empty output line is rejected",
      output: ({ dump, sidecar }) => `Backup creado y validado: ${toBashPath(dump)}\nChecksum: ${toBashPath(sidecar)}\nunexpected\n`,
      error: /output must contain exactly the declared dump and checksum lines/,
    },
    {
      name: "a dump outside the canonical backup directory is rejected",
      prepare: async (fixture) => {
        const outsideDir = join(fixture.root, "outside");
        fixture.dump = join(outsideDir, "al_lio_20260907T120000Z.dump");
        fixture.sidecar = `${fixture.dump}.sha256`;
        await mkdir(outsideDir, { recursive: true });
        await writeFile(fixture.dump, fixture.declaredBytes);
        await writeFile(
          fixture.sidecar,
          `${fixture.declaredChecksum}  ${toBashPath(fixture.dump)}\n`,
          "utf8",
        );
      },
      error: /outside the canonical backup directory/,
    },
    {
      name: "a dump symlink is rejected",
      prepare: async (fixture) => {
        const target = join(fixture.backupDir, "dump-target");
        await createFileSymlinkWithRestrictedWindowsFallback(
          target,
          fixture.dump,
          fixture.declaredBytes,
        );
      },
      error: /backup must be a non-empty regular file, not a symlink/,
    },
    {
      name: "a checksum sidecar symlink is rejected",
      prepare: async (fixture) => {
        const target = join(fixture.backupDir, "checksum-target");
        await createFileSymlinkWithRestrictedWindowsFallback(
          target,
          fixture.sidecar,
          `${fixture.declaredChecksum}  ${toBashPath(fixture.dump)}\n`,
        );
      },
      error: /checksum must be a non-empty regular file, not a symlink/,
    },
    {
      name: "an empty dump is rejected",
      prepare: async ({ dump }) => writeFile(dump, Buffer.alloc(0)),
      error: /backup must be a non-empty regular file, not a symlink/,
    },
    {
      name: "an empty checksum sidecar is rejected",
      prepare: async ({ sidecar }) => writeFile(sidecar, "", "utf8"),
      error: /checksum must be a non-empty regular file, not a symlink/,
    },
    {
      name: "an invalid checksum is rejected",
      prepare: async (fixture) => writeFile(
        fixture.sidecar,
        `${"0".repeat(64)}  ${toBashPath(fixture.dump)}\n`,
        "utf8",
      ),
      error: /checksum sidecar is not bound to the exact declared dump/,
    },
    {
      name: "a checksum sidecar bound to another path is rejected",
      prepare: async (fixture) => {
        const otherDump = join(fixture.backupDir, "al_lio_20260907T110000Z.dump");
        await writeFile(otherDump, fixture.declaredBytes);
        await writeFile(
          fixture.sidecar,
          `${fixture.declaredChecksum}  ${toBashPath(otherDump)}\n`,
          "utf8",
        );
      },
      error: /checksum sidecar is not bound to the exact declared dump/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "al-lio-backup-provenance-"));
      const backupDir = join(root, "backups");
      const outputFile = join(root, "backup-output.txt");
      const trace = join(root, "downstream.log");
      const declaredBytes = Buffer.from("declared backup payload\n", "utf8");
      const declaredChecksum = createHash("sha256").update(declaredBytes).digest("hex");
      const fixture = {
        root,
        backupDir,
        dump: join(backupDir, "al_lio_20260907T120000Z.dump"),
        staleDump: join(backupDir, "al_lio_20260907T130000Z.dump"),
        declaredBytes,
        declaredChecksum,
      };
      fixture.sidecar = `${fixture.dump}.sha256`;
      await mkdir(backupDir, { recursive: true });
      await writeFile(fixture.dump, declaredBytes);
      await writeFile(fixture.staleDump, "newer unrelated stale payload\n", "utf8");
      await writeFile(
        fixture.sidecar,
        `${declaredChecksum}  ${toBashPath(fixture.dump)}\n`,
        "utf8",
      );
      await scenario.prepare?.(fixture);
      const output = scenario.output?.(fixture)
        ?? `Backup creado y validado: ${toBashPath(fixture.dump)}\nChecksum: ${toBashPath(fixture.sidecar)}\n`;
      await writeFile(outputFile, output, "utf8");
      await writeFile(trace, "", "utf8");

      try {
        const result = spawnSync(bashPath, ["-s"], {
          encoding: "utf8",
          input: `set -Eeuo pipefail
backup_dir="${toBashPath(backupDir)}"
release_dir=/fixture/release
release_short_sha=aaaaaaaaaaaa
POSTGRES_CONTAINER=al_lio_postgres
postgres_backup_file=""
postgres_backup_checksum=not-required
BACKUP_STDOUT_FILE="${toBashPath(outputFile)}"
TRACE="${toBashPath(trace)}"
log() { :; }
fail() { printf 'ERROR: %s\\n' "$*" >&2; exit 1; }
bash() {
  case "$1" in
    */backup-production.sh) cat "$BACKUP_STDOUT_FILE" ;;
    */verify-backup-production.sh) printf 'verify=%s\\n' "$2" >> "$TRACE" ;;
    *) return 1 ;;
  esac
}
docker() {
  printf 'docker=%s\\n' "$*" >> "$TRACE"
  if [[ "$*" == *" pg_restore "* ]]; then
    cat >/dev/null
    printf 'pg_restore=called\\n' >> "$TRACE"
  fi
}
${validator}
${flow}
printf 'validated_checksum=%s\\n' "$postgres_backup_checksum" >> "$TRACE"
printf 'later_mutation=called\\n' >> "$TRACE"
{
${releaseRecordLine}
} >> "$TRACE"
`,
        });
        const downstream = await readFile(trace, "utf8");
        if (scenario.expectedStatus === 0) {
          assert.equal(result.status, 0, result.stderr);
          assert.equal((downstream.match(/^verify=/gm) ?? []).length, 1);
          assert.equal((downstream.match(/^pg_restore=called$/gm) ?? []).length, 1);
          assert.match(downstream, new RegExp(`^validated_checksum=${declaredChecksum}$`, "m"));
          assert.match(downstream, /^later_mutation=called$/m);
          assert.match(downstream, new RegExp(`^db_backup_path=${toBashPath(fixture.dump)}$`, "m"));
        } else {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, scenario.error);
          assert.equal((downstream.match(/^verify=/gm) ?? []).length, 0);
          assert.equal((downstream.match(/^docker=/gm) ?? []).length, 0);
          assert.equal((downstream.match(/^pg_restore=called$/gm) ?? []).length, 0);
          assert.equal((downstream.match(/^validated_checksum=/gm) ?? []).length, 0);
          assert.equal((downstream.match(/^later_mutation=called$/gm) ?? []).length, 0);
          assert.equal((downstream.match(/^db_backup_path=/gm) ?? []).length, 0);
        }
        assert.doesNotMatch(downstream, new RegExp(toBashPath(fixture.staleDump).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.doesNotMatch(downstream, /newer unrelated stale payload/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a newer unrelated dump cannot replace the exact backup declared by this deployment", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const { validator, flow, releaseRecordLine } = extractRoutineBackupBash(source);

  const root = await mkdtemp(join(tmpdir(), "al-lio-routine-backup-"));
  const backupDir = join(root, "backups");
  const declaredDump = join(backupDir, "al_lio_20260907T120000Z.dump");
  const staleDump = join(backupDir, "al_lio_20260907T130000Z.dump");
  const trace = join(root, "backup-usage.log");
  const declaredBytes = Buffer.from("declared backup payload\n", "utf8");
  const declaredChecksum = createHash("sha256").update(declaredBytes).digest("hex");
  await mkdir(backupDir, { recursive: true });
  await writeFile(declaredDump, declaredBytes);
  await writeFile(staleDump, "newer unrelated stale payload\n", "utf8");
  await writeFile(
    `${declaredDump}.sha256`,
    `${declaredChecksum}  ${toBashPath(declaredDump)}\n`,
    "utf8",
  );
  const now = Date.now() / 1000;
  await utimes(declaredDump, now - 120, now - 120);
  await utimes(staleDump, now, now);
  await writeFile(trace, "", "utf8");

  try {
    const result = spawnSync(bashPath, ["-s"], {
      encoding: "utf8",
      input: `set -Eeuo pipefail
backup_dir="${toBashPath(backupDir)}"
release_dir=/fixture/release
release_short_sha=aaaaaaaaaaaa
POSTGRES_CONTAINER=al_lio_postgres
postgres_backup_file=""
postgres_backup_checksum=not-required
TRACE="${toBashPath(trace)}"
DECLARED_DUMP="${toBashPath(declaredDump)}"
log() { :; }
fail() { printf 'ERROR: %s\\n' "$*" >&2; exit 1; }
bash() {
  case "$1" in
    */backup-production.sh)
      printf 'Backup creado y validado: %s\\nChecksum: %s.sha256\\n' \
        "$DECLARED_DUMP" "$DECLARED_DUMP"
      ;;
    */verify-backup-production.sh)
      printf 'verify=%s\\n' "$2" >> "$TRACE"
      ;;
    *) return 1 ;;
  esac
}
docker() {
  if [[ "$*" == *" pg_restore "* ]]; then
    printf 'rehearsal-content=%s\\n' "$(cat)" >> "$TRACE"
  else
    printf 'docker=%s\\n' "$*" >> "$TRACE"
  fi
}
${validator}
${flow}
{
${releaseRecordLine}
} >> "$TRACE"
`,
    });
    assert.equal(result.status, 0, result.stderr);
    const usage = await readFile(trace, "utf8");
    assert.match(usage, new RegExp(`^verify=${toBashPath(declaredDump)}$`, "m"));
    assert.match(usage, /^rehearsal-content=declared backup payload$/m);
    assert.match(usage, new RegExp(`^db_backup_path=${toBashPath(declaredDump)}$`, "m"));
    assert.doesNotMatch(usage, new RegExp(toBashPath(staleDump).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(usage, /newer unrelated stale payload/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the command replaces only web and preserves automatic recovery", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const integrity = await readFile(worktreeIntegrityUrl, "utf8");

  assert.match(source, /up -d --no-deps al_lio_web/);
  assert.match(source, /rollback_web/);
  assert.match(source, /previous_release_dir/);
  assert.match(source, /Current release integrity check failed/);
  assert.match(integrity, /Release worktree HEAD does not match the candidate SHA/);
  assert.match(source, /read_env_value AL_LIO_RELEASE_SHA "\$previous_release_dir\/\.env"/);
  assert.match(source, /postgres_container_preserved="true"/);
  assert.match(source, /radar_container_preserved="true"/);
  assert.doesNotMatch(source, /docker compose[^\n]*down/);
  assert.doesNotMatch(source, /docker volume rm/);
  assert.doesNotMatch(source, /git reset --hard/);
});

test("the Radar backup remains private and readable by the deploy user", async () => {
  const source = await readFile(deployScriptUrl, "utf8");

  assert.match(source, /-e BACKUP_UID="\$\(id -u\)"/);
  assert.match(source, /-e BACKUP_GID="\$\(id -g\)"/);
  assert.match(source, /chown "\$BACKUP_UID:\$BACKUP_GID"/);
  assert.match(source, /chmod 600 "\/backup\/\$BACKUP_FILE"/);
});

test("Compose removals require exact current-release data and cannot persist in the candidate", async () => {
  const policy = await readFile(transitionPolicyUrl, "utf8");
  const guard = await readFile(composeGuardUrl, "utf8");
  const approvals = await readFile(approvalsUrl, "utf8");

  assert.match(policy, /git -C "\$repository" ls-tree "\$sha" -- "\$path"/);
  assert.match(policy, /100644 blob/);
  assert.match(policy, /validate_and_load_approval_blob/);
  assert.match(policy, /cat-file blob "\$object" > "\$raw_file"/);
  assert.match(policy, /PRODUCTION_TRANSITION_APPROVAL_MAX_BYTES=65536/);
  assert.match(policy, /od -An -v -t u1/);
  assert.match(policy, /forbidden NUL byte/);
  assert.match(policy, /not part of CRLF/);
  assert.match(policy, /tr -d '\\015'/);
  assert.match(guard, /service\|destination_key\|source_variable\|exact_default/);
  assert.match(guard, /validate_removal_approval_data/);
  assert.match(guard, /classify_approval_transition/);
  assert.match(guard, /Current release has staged removal approvals, so candidate must contain no active approval/);
  assert.match(guard, /git -C "\$repository" diff --summary/);
  assert.match(guard, /Compose file metadata or mode changed/);
  assert.match(guard, /removal_is_approved "\$current_approval_data"/);
  assert.match(guard, /"Candidate release"/);
  assert.doesNotMatch(approvals, /^al_lio_(web|radar)\|/m, "normal releases must contain no reusable approval");
  for (const legacyVariable of [
    "INFOJOBS_CLIENT_ID",
    "INFOJOBS_CLIENT_SECRET",
    "ADZUNA_APP_ID",
    "ADZUNA_APP_KEY",
    "JOOBLE_API_KEY",
    "AL_LIO_DEMO_ACCESS_ENABLED",
  ]) {
    assert.doesNotMatch(approvals, new RegExp(`^.*\\|${legacyVariable}\\|`, "m"));
  }
});

test("approval blob validation is bounded, private, trap-neutral and ordered before CRLF normalization", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const policy = await readFile(transitionPolicyUrl, "utf8");
  const loaderStart = policy.indexOf("validate_and_load_approval_blob() {");
  const loaderEnd = policy.indexOf("\n}\n\nvalidate_production_transition()", loaderStart);
  const loader = policy.slice(loaderStart, loaderEnd);

  assert.ok(loaderStart >= 0 && loaderEnd > loaderStart);
  assert.ok(loader.indexOf('cat-file -s "$object"') < loader.indexOf('mktemp "${TMPDIR:-/tmp}/al-lio-approval.XXXXXX"'));
  assert.ok(loader.indexOf('od -An -v -t u1 "$raw_file"') < loader.indexOf("tr -d '\\015'"));
  assert.match(loader, /chmod 600 "\$raw_file"/);
  assert.match(loader, /actual_size=.*wc -c/);
  assert.match(loader, /actual_size.*blob_size/);
  assert.match(policy, /if ! rm -f -- "\$raw_file"/);
  assert.match(policy, /private temporary validation file could not be removed/);
  assert.doesNotMatch(loader, /\btrap\b/);
  for (const command of ["mktemp", "od", "tr", "wc"]) {
    assert.match(source, new RegExp(`for command_name in [^\\n]*\\b${command}\\b`));
  }
});

test("release worktrees receive a private exact identity without changing the canonical checkout", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const prepare = await readFile(releaseEnvUrl, "utf8");
  const integrity = await readFile(worktreeIntegrityUrl, "utf8");
  const dockerfile = await readFile(dockerfileUrl, "utf8");

  assert.match(source, /umask 022\s+git -C "\$repository_dir" worktree add/);
  assert.match(source, /prepare-release-env\.sh/);
  assert.match(prepare, /install -m 600 "\$previous_env" "\$release_env"/);
  assert.match(prepare, /write_env_value AL_LIO_IMAGE_TAG "\$release_sha"/);
  assert.match(prepare, /write_env_value AL_LIO_RELEASE_SHA "\$release_sha"/);
  assert.match(prepare, /validate_managed_env_value AL_LIO_IMAGE_TAG "\$release_sha"/);
  assert.match(prepare, /validate_managed_env_value AL_LIO_RELEASE_SHA "\$release_sha"/);
  assert.match(integrity, /rev-parse HEAD/);
  assert.match(source, /source .*release-worktree-integrity\.sh/);
  assert.match(prepare, /source .*release-worktree-integrity\.sh/);
  assert.match(integrity, /status --porcelain --untracked-files=all/);
  assert.match(integrity, /status --porcelain --ignored --untracked-files=all/);
  assert.match(integrity, /"!! \.env"/);
  assert.doesNotMatch(`${source}\n${prepare}\n${integrity}`, /--untracked-files=no/);
  assert.match(dockerfile, /COPY --from=builder --chown=nextjs:nodejs \/app\/public \.\/public/);
});

test("deployment success requires internal and public release identity", async () => {
  const source = await readFile(deployScriptUrl, "utf8");

  assert.match(source, /timeout 20s docker exec "\$WEB_CONTAINER" wget -T 5 -qO- http:\/\/127\.0\.0\.1:3000\/api\/version/);
  assert.match(source, /curl -fsS --connect-timeout 5 --max-time 20 "\$base_url\/api\/version"/);
  assert.match(source, /public_version_result="\$release_sha"/);
});

test("every routine production HTTP probe has connection and overall bounds", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const sourceLines = source.split(/\r?\n/);
  const curlClassifications = sourceLines.map((line) => ({ line, kind: classifyCurlLine(line) }));
  const wgetClassifications = sourceLines.map((line) => ({ line, kind: classifyDockerExecWgetLine(line) }));
  const curlLines = curlClassifications.filter(({ kind }) => kind === "invocation").map(({ line }) => line);
  const wgetLines = wgetClassifications.filter(({ kind }) => kind === "invocation").map(({ line }) => line);
  const probeLines = [...curlLines, ...wgetLines];
  assert.deepEqual(curlClassifications.filter(({ kind }) => kind === "unclassified"), []);
  assert.deepEqual(wgetClassifications.filter(({ kind }) => kind === "unclassified"), []);
  assert.equal(curlLines.length, 7);
  assert.equal(wgetLines.length, 3);
  for (const line of curlLines) {
    assert.match(line, /\bcurl\b.*--connect-timeout 5\b.*--max-time 20\b/);
  }
  for (const line of wgetLines) {
    assert.match(line, /timeout 20s docker exec\b.*\bwget -T 5\b/);
  }
  for (const endpoint of ["health", "ready", "version", "job-radar"]) {
    assert.ok(probeLines.some((line) => line.includes(`/api/${endpoint}`)));
  }
  assert.match(source, /for command_name in [^\n]*\btimeout\b/);
  for (const invocation of [
    "curl -fsS https://example.test/api/future",
    "command curl -fsS https://example.test/api/future",
    "env FOO=bar curl -fsS https://example.test/api/future",
    'result="$(curl -fsS https://example.test/api/future)"',
    "if curl -fsS https://example.test/api/future; then :; fi",
    "foo && curl -fsS https://example.test/api/future",
    "! curl -fsS https://example.test/api/future",
  ]) {
    assert.equal(classifyCurlLine(invocation), "invocation", invocation);
  }
  for (const invocation of [
    "docker exec web wget -qO- http://127.0.0.1/api/future",
    "timeout 20s docker exec web wget -T 5 -qO- http://127.0.0.1/api/future",
    "command docker exec web wget -qO- http://127.0.0.1/api/future",
    "env FOO=bar docker exec web wget -qO- http://127.0.0.1/api/future",
  ]) {
    assert.equal(classifyDockerExecWgetLine(invocation), "invocation", invocation);
  }
  for (const exclusion of [
    "# curl -fsS https://example.test/api/future",
    "for command_name in git curl timeout; do",
    'documentation="curl https://example.test/api/future"',
    'printf \'curl https://example.test/api/future\\n\'',
    'echo "curl https://example.test/api/future"',
  ]) {
    assert.equal(classifyCurlLine(exclusion), "excluded", exclusion);
  }
  for (const exclusion of [
    "# docker exec web wget http://127.0.0.1/api/future",
    'documentation="docker exec web wget http://127.0.0.1/api/future"',
    'printf \'docker exec web wget /api/future\\n\'',
    'echo "docker exec web wget /api/future"',
  ]) {
    assert.equal(classifyDockerExecWgetLine(exclusion), "excluded", exclusion);
  }
  assert.equal(classifyCurlLine("sudo curl https://example.test/api/future"), "unclassified");
  assert.equal(classifyDockerExecWgetLine("sudo docker exec web wget /api/future"), "unclassified");

  const sameShaStart = source.indexOf('if [[ "$release_sha" == "$current_sha" ]]');
  const sameShaEnd = source.indexOf("\nfi", sameShaStart);
  const sameShaBlock = source.slice(sameShaStart, sameShaEnd);
  for (const endpoint of ["health", "ready", "version"]) {
    assert.match(
      sameShaBlock,
      new RegExp(`curl -fsS --connect-timeout 5 --max-time 20 "\\$base_url/api/${endpoint}"`),
    );
  }
});

test("the release identity is rechecked immediately before cutover", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const cutover = source.indexOf('"${compose[@]}" up -d --no-deps al_lio_web');

  assert.ok(cutover > -1);
  for (const check of [
    'read_env_value AL_LIO_IMAGE_TAG "$release_dir/.env"',
    'read_env_value AL_LIO_RELEASE_SHA "$release_dir/.env"',
    'validate_release_worktree_integrity "$release_dir" "$release_sha"',
  ]) {
    const index = source.lastIndexOf(check, cutover);
    assert.ok(index > -1 && index < cutover, `${check} must run before cutover`);
  }
});

test("candidate worktree integrity is checked before both build and cutover", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const build = source.indexOf('"${compose[@]}" build --pull al_lio_web');
  const cutover = source.indexOf('"${compose[@]}" up -d --no-deps al_lio_web');
  const beforeBuild = source.lastIndexOf(
    'validate_release_worktree_integrity "$release_dir" "$release_sha"',
    build,
  );
  const beforeCutover = source.lastIndexOf(
    'validate_release_worktree_integrity "$release_dir" "$release_sha"',
    cutover,
  );

  assert.ok(beforeBuild > -1 && beforeBuild < build);
  assert.ok(beforeCutover > build && beforeCutover < cutover);
});

test("success and failure records retain the complete audited release outcome", async () => {
  const source = await readFile(deployScriptUrl, "utf8");
  const policy = await readFile(transitionPolicyUrl, "utf8");
  const guard = await readFile(composeGuardUrl, "utf8");

  assert.match(source, /write_release_record "approved"/);
  assert.match(source, /write_release_record "failed"/);
  assert.match(source, /chmod 600 "\$temp_record"/);
  assert.match(source, /join_approval_audit_records/);
  assert.match(guard, /approval_audit_id/);
  assert.doesNotMatch(policy, /source=%s default=%s/);
  for (const field of [
    "timestamp_utc", "operator", "current_sha", "candidate_sha",
    "previous_release_path", "previous_image", "candidate_image", "policy_result",
    "historical_exception", "staged_approvals", "consumed_approvals", "revoked_approvals",
    "pending_migration_ids", "applied_migration_ids", "db_backup_path",
    "db_backup_checksum", "restore_verification", "rehearsal", "radar_backup",
    "radar_backup_status", "internal_health", "internal_ready", "internal_version",
    "public_health", "public_ready", "public_version", "automated_smoke",
    "functional_smoke", "rollback_release_path", "rollback_image", "rollback_result",
  ]) {
    assert.match(source, new RegExp(`printf '${field}=`), `missing release record field: ${field}`);
  }
});

test("the owner guide documents the complete low-touch workflow", async () => {
  const guide = await readFile(guideUrl, "utf8");

  assert.match(guide, /git rev-parse HEAD/);
  assert.match(guide, /Merge pull request/);
  assert.match(guide, /merge commit/);
  assert.match(guide, /ssh al-lio-vps/);
  assert.match(guide, /\.\/scripts\/deploy-production\.sh <SHA>/);
  assert.match(guide, /DEPLOY 9517e115314/);
  assert.match(guide, /health/i);
  assert.match(guide, /rollback/i);
});
