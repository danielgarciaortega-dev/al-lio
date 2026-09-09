import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const approvalsUrl = new URL("../../../../scripts/config/production-compose-env-removals.allowlist", import.meta.url);
const composeGuardUrl = new URL("../../../../scripts/lib/compose-env-guard.sh", import.meta.url);
const transitionPolicyUrl = new URL("../../../../scripts/lib/production-transition-policy.sh", import.meta.url);
const worktreeIntegrityUrl = new URL("../../../../scripts/lib/release-worktree-integrity.sh", import.meta.url);
const bashPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
const historicalSourceSha = "dc6607ec88810d90e43d415e6781bc90e1c6612f";
const approvalPath = "scripts/config/production-compose-env-removals.allowlist";
const routePath = "src/app/api/version/route.ts";
const migrationPath = "infra/postgres/migrations/0017_job_radar_sync_state.sql";
const composeGuardPath = "scripts/lib/compose-env-guard.sh";
const transitionPolicyPath = "scripts/lib/production-transition-policy.sh";

const historicalVariables = [
  "INFOJOBS_CLIENT_ID",
  "INFOJOBS_CLIENT_SECRET",
  "ADZUNA_APP_ID",
  "ADZUNA_APP_KEY",
  "JOOBLE_API_KEY",
  "AL_LIO_DEMO_ACCESS_ENABLED",
];

const reviewedDiffPaths = [
  ".dockerignore",
  ":(glob)**/.gitattributes",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-production.yml",
  "infra/Dockerfile",
  "data/learning-competencies.json",
  "scripts/import-learning-competencies.mjs",
  "scripts/deploy-production.sh",
  "scripts/github-actions-deploy-entrypoint.sh",
  transitionPolicyPath,
  composeGuardPath,
  "scripts/lib/release-worktree-integrity.sh",
  "scripts/prepare-release-env.sh",
  "scripts/validate-production-transition.sh",
  "scripts/validate-production-deploy-readiness.mjs",
  approvalPath,
  "scripts/postgres",
  routePath,
  migrationPath,
  "infra/postgres/schema.sql",
  "infra/postgres/baseline.sha256",
];

const currentCompose = `services:
  al_lio_web:
    environment:
      STABLE_FLAG: \${STABLE_FLAG:-false}
      INFOJOBS_CLIENT_ID: \${INFOJOBS_CLIENT_ID:-}
      INFOJOBS_CLIENT_SECRET: \${INFOJOBS_CLIENT_SECRET:-}
      ADZUNA_APP_ID: \${ADZUNA_APP_ID:-}
      ADZUNA_APP_KEY: \${ADZUNA_APP_KEY:-}
      JOOBLE_API_KEY: \${JOOBLE_API_KEY:-}
      AL_LIO_DEMO_ACCESS_ENABLED: \${AL_LIO_DEMO_ACCESS_ENABLED:-false}
`;

const candidateCompose = `services:
  al_lio_web:
    environment:
      STABLE_FLAG: \${STABLE_FLAG:-false}
      AL_LIO_RELEASE_SHA: \${AL_LIO_RELEASE_SHA:?AL_LIO_RELEASE_SHA is injected by the release mechanism}
`;

const exactRoute = `const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const dynamic = "force-dynamic";
export function GET() {
  const releaseSha = process.env.AL_LIO_RELEASE_SHA?.trim() ?? "";
  return Response.json({ releaseSha: RELEASE_SHA_PATTERN.test(releaseSha) ? releaseSha : null });
}
`;

const exactMigration = `create table if not exists public.job_radar_sync_state (
  user_id uuid primary key,
  running_since timestamptz,
  last_attempt_at timestamptz not null default now()
);
`;

function section(document, start, end) {
  const startIndex = document.indexOf(start);
  const endIndex = document.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex);
  return document.slice(startIndex, endIndex);
}

function historicalChecklist(runbook) {
  const historical = section(
    runbook,
    "### 3.1 Fail-closed checklist for the historical production release",
    "## 4. Create the immutable candidate",
  );
  const match = historical.match(/```bash\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(match, "historical Bash checklist is missing");
  return match[1];
}

function bashBlockContaining(document, marker) {
  const blocks = [...document.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)];
  const match = blocks.find((entry) => entry[1].includes(marker));
  assert.ok(match, `Bash block containing ${marker} is missing`);
  return match[1];
}

function toBashPath(path) {
  return path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
}

async function git(directory, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd: directory });
  return stdout.trim();
}

async function write(root, path, contents) {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, typeof contents === "string" ? "utf8" : undefined);
}

async function commitAll(root, message) {
  await git(root, "add", "--all");
  await git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

async function createHistoricalFixture(candidateApprovals) {
  const root = await mkdtemp(join(tmpdir(), "al-lio-historical-runbook-"));
  const validationTemp = join(root, "validation-temp");
  await mkdir(validationTemp);
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "tests@al-lio.invalid");
  await git(root, "config", "user.name", "AL-LIO tests");
  await git(root, "config", "core.autocrlf", "false");
  await write(root, "infra/docker-compose.prod.yml", currentCompose);
  await write(root, approvalPath, "# no active approvals\n");
  await write(
    root,
    composeGuardPath,
    await readFile(composeGuardUrl, "utf8"),
  );
  await write(
    root,
    transitionPolicyPath,
    await readFile(transitionPolicyUrl, "utf8"),
  );
  const currentSha = await commitAll(root, "historical source");

  await write(root, "infra/docker-compose.prod.yml", candidateCompose);
  await write(root, routePath, exactRoute);
  await write(root, migrationPath, exactMigration);
  await write(root, approvalPath, candidateApprovals);
  const candidateSha = await commitAll(root, "reviewed candidate");
  return { root, validationTemp, currentSha, candidateSha };
}

async function reviewedDiffDigest(root, currentSha, candidateSha) {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--raw", "--no-abbrev", currentSha, candidateSha, "--", ...reviewedDiffPaths],
    { cwd: root, encoding: "buffer" },
  );
  return createHash("sha256")
    .update(`source_sha=${currentSha}\ncandidate_sha=${candidateSha}\n`)
    .update(stdout)
    .digest("hex");
}

function runHistoricalChecklist(checklist, fixture, candidateSha, reviewedDigest) {
  const sourceAssignments = checklist.match(new RegExp(historicalSourceSha, "g")) ?? [];
  assert.equal(sourceAssignments.length, 1);
  const digestPlaceholder =
    'export AL_LIO_REVIEWED_RUNTIME_CONTROL_PLANE_DIFF_SHA256="REPLACE_WITH_REVIEWED_64_CHARACTER_LOWERCASE_SHA256"';
  assert.ok(checklist.includes(digestPlaceholder));
  const executableChecklist = checklist
    .replace(historicalSourceSha, fixture.currentSha)
    .replace(
      digestPlaceholder,
      `export AL_LIO_REVIEWED_RUNTIME_CONTROL_PLANE_DIFF_SHA256="${reviewedDigest}"`,
    );
  return spawnSync(bashPath, ["-s"], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      AL_LIO_CURRENT_SHA: fixture.currentSha,
      AL_LIO_RELEASE_SHA: candidateSha,
      AL_LIO_REPOSITORY_DIR: fixture.root.replaceAll("\\", "/"),
      TMPDIR: fixture.validationTemp.replaceAll("\\", "/"),
    },
    input: `set -Eeuo pipefail\n${executableChecklist}\n`,
  });
}

async function commitMutation(fixture, path, contents, message) {
  await git(fixture.root, "checkout", "--quiet", "--detach", fixture.candidateSha);
  await write(fixture.root, path, contents);
  return commitAll(fixture.root, message);
}

async function commitModeMutation(fixture, path, mode, message) {
  await git(fixture.root, "checkout", "--quiet", "--detach", fixture.candidateSha);
  const object = mode === "160000"
    ? fixture.candidateSha
    : await git(fixture.root, "rev-parse", `${fixture.candidateSha}:${path}`);
  await git(fixture.root, "update-index", "--add", "--cacheinfo", `${mode},${object},${path}`);
  await git(fixture.root, "commit", "--quiet", "-m", message);
  return git(fixture.root, "rev-parse", "HEAD");
}

async function assertValidationTempRemoved(fixture) {
  assert.deepEqual(await readdir(fixture.validationTemp), []);
}

async function withHistoricalFixture(candidateApprovals, work) {
  const fixture = await createHistoricalFixture(candidateApprovals);
  try {
    await work(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function createRecoveryFixture() {
  const root = await mkdtemp(join(tmpdir(), "al-lio-runbook-recovery-"));
  const worktreeIntegrity = await readFile(worktreeIntegrityUrl, "utf8");
  const releasesRoot = join(root, "releases");
  const previousStaging = join(root, "previous-staging");
  const candidateStaging = join(root, "candidate-staging");
  for (const [release, marker] of [
    [previousStaging, "previous"],
    [candidateStaging, "candidate"],
  ]) {
    await mkdir(release, { recursive: true });
    await git(release, "init", "--quiet");
    await git(release, "config", "user.email", "tests@al-lio.invalid");
    await git(release, "config", "user.name", "AL-LIO tests");
    await write(release, ".gitignore", ".env\n");
    await write(release, "marker.txt", `${marker}\n`);
    await write(
      release,
      "scripts/lib/release-worktree-integrity.sh",
      worktreeIntegrity,
    );
    await commitAll(release, marker);
  }
  const currentSha = await git(previousStaging, "rev-parse", "HEAD");
  const candidateSha = await git(candidateStaging, "rev-parse", "HEAD");
  const previousRelease = join(releasesRoot, `al-lio-${currentSha.slice(0, 12)}`);
  const candidateRelease = join(releasesRoot, `al-lio-${candidateSha.slice(0, 12)}`);
  await mkdir(releasesRoot, { recursive: true });
  await rename(previousStaging, previousRelease);
  await rename(candidateStaging, candidateRelease);
  await writeFile(
    join(previousRelease, ".env"),
    `AL_LIO_IMAGE_TAG=${currentSha}\nAL_LIO_RELEASE_SHA=${currentSha}\n`,
    "utf8",
  );
  await writeFile(
    join(candidateRelease, ".env"),
    `AL_LIO_IMAGE_TAG=${candidateSha}\nAL_LIO_RELEASE_SHA=${candidateSha}\n`,
    "utf8",
  );
  const backupDir = join(root, "backups", "al-lio");
  const backup = join(backupDir, "al_lio_exact.dump");
  const backupBytes = Buffer.from("exact recovery backup\n", "utf8");
  await write(root, "backups/al-lio/al_lio_exact.dump", backupBytes);
  const checksum = createHash("sha256").update(backupBytes).digest("hex");
  await write(
    root,
    "backups/al-lio/al_lio_exact.dump.sha256",
    `${checksum}  ${toBashPath(backup)}\n`,
  );
  const record = join(backupDir, "attempt-record.txt");
  const requiredRecord = [
    "outcome=learning-import-completed",
    `current_sha=${currentSha}`,
    `candidate_sha=${candidateSha}`,
    `previous_release_path=${toBashPath(previousRelease)}`,
    `candidate_release_path=${toBashPath(candidateRelease)}`,
    "base_url=https://al-lio.example.invalid",
    `previous_image=al-lio-web:${currentSha}`,
    `candidate_image=al-lio-web:${candidateSha}`,
    "postgres_container_id=postgres-fixture-id",
    "radar_container_id=radar-fixture-id",
    `db_backup_path=${toBashPath(backup)}`,
    `db_backup_checksum=${checksum}`,
    "learning_import_result=completed",
  ].join("\n") + "\n";
  await writeFile(record, requiredRecord, "utf8");
  return {
    root,
    record,
    recordPath: toBashPath(record),
    releasesRoot,
    releasesRootPath: toBashPath(releasesRoot),
    backupDir,
    backupDirPath: toBashPath(backupDir),
    previousRelease,
    candidateRelease,
    currentSha,
    candidateSha,
    backupPath: toBashPath(backup),
    checksum,
    requiredRecord,
  };
}

async function runRecoveryInitialization(
  block,
  fixture,
  recordContents = fixture.requiredRecord,
  {
    envMode = "600",
    envOwner = "197609",
    flockResult = "0",
    preamble = "",
    postamble = "",
  } = {},
) {
  if (recordContents !== null) {
    await writeFile(fixture.record, recordContents, "utf8");
  }
  const assignment =
    'export AL_LIO_SELECTED_RELEASE_RECORD="REPLACE_WITH_EXACT_PRIVATE_RELEASE_RECORD_PATH"';
  const configured = block.replace(
    assignment,
    `export AL_LIO_SELECTED_RELEASE_RECORD="${fixture.recordPath}"`,
  )
    .replace(
      "AL_LIO_RELEASES_DIR=/srv/danicode/releases",
      `AL_LIO_RELEASES_DIR="${fixture.releasesRootPath}"`,
    )
    .replace(
      "AL_LIO_BACKUP_DIR=/srv/danicode/backups/al-lio",
      `AL_LIO_BACKUP_DIR="${fixture.backupDirPath}"`,
    );
  return spawnSync(bashPath, ["-s"], {
    encoding: "utf8",
    input: `
if ! command -v flock >/dev/null; then
  flock() { return ${flockResult}; }
fi
${preamble}
stat() {
  local target="\${!#}"
  case "$2:$target" in
    %a:*/.env) printf '${envMode}\\n' ;;
    %u:*/.env) printf '${envOwner}\\n' ;;
    %a:*) printf '600\\n' ;;
    %u:*) printf '197609\\n' ;;
    *) command stat "$@" ;;
  esac
}
id() {
  if [[ "\${1:-}" == -u ]]; then printf '197609\\n'; else command id "$@"; fi
}
${configured}
${postamble}
printf 'backup=%s\\nchecksum=%s\\ncurrent=%s\\ncandidate=%s\\noutcome=%s\\nimport=%s\\n' \\
  "$AL_LIO_RECOVERY_BACKUP" "$AL_LIO_RECOVERY_BACKUP_CHECKSUM" \\
  "$AL_LIO_CURRENT_SHA" "$AL_LIO_RELEASE_SHA" \\
  "$AL_LIO_RECOVERY_ATTEMPT_OUTCOME" "$AL_LIO_RECOVERY_LEARNING_IMPORT_RESULT"
`,
  });
}


export {
  approvalPath,
  approvalsUrl,
  assertValidationTempRemoved,
  bashBlockContaining,
  bashPath,
  commitModeMutation,
  commitMutation,
  composeGuardPath,
  createRecoveryFixture,
  exactMigration,
  exactRoute,
  historicalChecklist,
  historicalSourceSha,
  historicalVariables,
  migrationPath,
  reviewedDiffDigest,
  routePath,
  runHistoricalChecklist,
  runRecoveryInitialization,
  toBashPath,
  transitionPolicyPath,
  withHistoricalFixture,
  write,
};
