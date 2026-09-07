import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const runbookUrl = new URL("../../../docs/operations/DEPLOY_VPS.md", import.meta.url);
const approvalsUrl = new URL("../../../scripts/config/production-compose-env-removals.allowlist", import.meta.url);
const composeGuardUrl = new URL("../../../scripts/lib/compose-env-guard.sh", import.meta.url);
const transitionPolicyUrl = new URL("../../../scripts/lib/production-transition-policy.sh", import.meta.url);
const worktreeIntegrityUrl = new URL("../../../scripts/lib/release-worktree-integrity.sh", import.meta.url);
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

test("runbook placeholders are shell-safe, guarded, and CR trimming uses an actual carriage return", async () => {
  const runbook = await readFile(runbookUrl, "utf8");
  assert.doesNotMatch(runbook, /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=<[^>\n]+>/m);
  for (const assignment of [
    'export AL_LIO_RELEASE_SHA="REPLACE_WITH_FULL_40_CHARACTER_REVIEWED_MAIN_SHA"',
    'export AL_LIO_EXCEPTION_REASON="REPLACE_WITH_REVIEWED_TICKET_OR_CHANGE_REFERENCE"',
    'export AL_LIO_REVIEWED_RUNTIME_CONTROL_PLANE_DIFF_SHA256="REPLACE_WITH_REVIEWED_64_CHARACTER_LOWERCASE_SHA256"',
    'export AL_LIO_SELECTED_RELEASE_RECORD="REPLACE_WITH_EXACT_PRIVATE_RELEASE_RECORD_PATH"',
  ]) {
    assert.ok(runbook.includes(assignment), `missing safe placeholder: ${assignment}`);
  }
  assert.ok(runbook.includes('value="${value%$\'\\r\'}"'));
  assert.ok(!runbook.includes('value="${value%$\'\\\\r\'}"'));
  assert.match(runbook, /\$AL_LIO_REQUIRED_VALUE.*== REPLACE_WITH_\*/s);
});

for (const [name, reason, expectedStatus] of [
  ["ASCII single-line", "CHG-442-reviewed-recovery", 0],
  ["newline", "CHG-442\nsecond-line", 1],
  ["carriage return", "CHG-442\rsecond-line", 1],
  ["non-ASCII", "CHG-442-revisión", 1],
]) {
  test(`historical exception reason validation handles ${name}`, async () => {
    const setup = bashBlockContaining(
      await readFile(runbookUrl, "utf8"),
      "AL_LIO_REQUIRED_VALUE_NAME",
    );
    const validationStart = setup.indexOf(
      "for AL_LIO_REQUIRED_VALUE_NAME in AL_LIO_RELEASE_SHA AL_LIO_EXCEPTION_REASON",
    );
    const validationEnd = setup.indexOf('[[ "$(id -u)" -ne 0 ]]', validationStart);
    assert.ok(validationStart >= 0 && validationEnd > validationStart);
    const validation = setup.slice(validationStart, validationEnd);
    const result = spawnSync(bashPath, ["-s"], {
      encoding: "utf8",
      env: {
        ...process.env,
        AL_LIO_RELEASE_SHA: "a".repeat(40),
        AL_LIO_EXCEPTION_REASON: reason,
      },
      input: `set -Eeuo pipefail\n${validation}\n`,
    });
    assert.equal(result.status, expectedStatus, result.stderr);
    if (expectedStatus !== 0) {
      assert.match(
        result.stderr,
        /AL_LIO_EXCEPTION_REASON must be 1-256 printable ASCII bytes on one line/,
      );
    }
  });
}

test("the exact reviewed candidate passes and a later /api/version content mutation is rejected", async () => {
  const checklist = historicalChecklist(await readFile(runbookUrl, "utf8"));
  const comments = historicalVariables.map((key) => `# retired historical key: ${key}`).join("\n") + "\n";
  await withHistoricalFixture(comments, async (fixture) => {
    const reviewedDigest = await reviewedDiffDigest(fixture.root, fixture.currentSha, fixture.candidateSha);
    const accepted = runHistoricalChecklist(checklist, fixture, fixture.candidateSha, reviewedDigest);
    assert.equal(accepted.status, 0, accepted.stderr);
    await assertValidationTempRemoved(fixture);

    const mutatedSha = await commitMutation(
      fixture,
      routePath,
      `${exactRoute}\n// behavior changed after independent review\n`,
      "mutate version route",
    );
    const rejected = runHistoricalChecklist(checklist, fixture, mutatedSha, reviewedDigest);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /runtime\/control-plane diff changed; stop for manual review/);
  });
});

test("the reviewed digest cannot be reused for a different app-only candidate commit", async () => {
  const checklist = historicalChecklist(await readFile(runbookUrl, "utf8"));
  await withHistoricalFixture("# no active approvals\n", async (fixture) => {
    const reviewedDigest = await reviewedDiffDigest(fixture.root, fixture.currentSha, fixture.candidateSha);
    const accepted = runHistoricalChecklist(checklist, fixture, fixture.candidateSha, reviewedDigest);
    assert.equal(accepted.status, 0, accepted.stderr);

    const appOnlySha = await commitMutation(
      fixture,
      "src/app/page.tsx",
      "export default function Page() { return <main>changed after review</main>; }\n",
      "ordinary application change",
    );
    const rejected = runHistoricalChecklist(checklist, fixture, appOnlySha, reviewedDigest);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /runtime\/control-plane diff changed; stop for manual review/);
  });
});

test("the exact reviewed migration passes and a benign post-review 0017 mutation is rejected by digest", async () => {
  const checklist = historicalChecklist(await readFile(runbookUrl, "utf8"));
  await withHistoricalFixture("# no active approvals\n", async (fixture) => {
    const reviewedDigest = await reviewedDiffDigest(fixture.root, fixture.currentSha, fixture.candidateSha);
    const accepted = runHistoricalChecklist(checklist, fixture, fixture.candidateSha, reviewedDigest);
    assert.equal(accepted.status, 0, accepted.stderr);

    const mutatedSha = await commitMutation(
      fixture,
      migrationPath,
      `${exactMigration}\ncomment on table public.job_radar_sync_state is 'changed after review';\n`,
      "mutate migration",
    );
    const rejected = runHistoricalChecklist(checklist, fixture, mutatedSha, reviewedDigest);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /runtime\/control-plane diff changed; stop for manual review/);
  });
});

test("comments may name retired variables, while every active historical approval is rejected", async () => {
  const checklist = historicalChecklist(await readFile(runbookUrl, "utf8"));
  const comments = historicalVariables.map((key) => `# documentation only: ${key}`).join("\n") + "\n";
  await withHistoricalFixture(comments, async (fixture) => {
    const commentsDigest = await reviewedDiffDigest(fixture.root, fixture.currentSha, fixture.candidateSha);
    const commentsAccepted = runHistoricalChecklist(
      checklist,
      fixture,
      fixture.candidateSha,
      commentsDigest,
    );
    assert.equal(commentsAccepted.status, 0, commentsAccepted.stderr);
    await assertValidationTempRemoved(fixture);

    for (const historicalVariable of historicalVariables) {
      const exactDefault = historicalVariable === "AL_LIO_DEMO_ACCESS_ENABLED" ? "false" : "";
      const activeApproval = `al_lio_web|${historicalVariable}|${historicalVariable}|${exactDefault}\n`;
      const activeSha = await commitMutation(
        fixture,
        approvalPath,
        activeApproval,
        `persist ${historicalVariable} approval`,
      );
      const activeDigest = await reviewedDiffDigest(fixture.root, fixture.currentSha, activeSha);
      const rejected = runHistoricalChecklist(checklist, fixture, activeSha, activeDigest);
      assert.notEqual(rejected.status, 0, `${historicalVariable} unexpectedly passed`);
      assert.match(
        rejected.stderr,
        /does not match exactly one mapping|must contain zero active Compose removal approvals/,
      );
      await assertValidationTempRemoved(fixture);
    }
  });
});

test("a valid unrelated candidate approval is rejected for the historical transition", async () => {
  const checklist = historicalChecklist(await readFile(runbookUrl, "utf8"));
  const unrelatedApproval = "al_lio_web|STABLE_FLAG|STABLE_FLAG|false\n";
  await withHistoricalFixture(unrelatedApproval, async (fixture) => {
    const reviewedDigest = await reviewedDiffDigest(fixture.root, fixture.currentSha, fixture.candidateSha);
    const rejected = runHistoricalChecklist(checklist, fixture, fixture.candidateSha, reviewedDigest);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /must contain zero active Compose removal approvals/);
    await assertValidationTempRemoved(fixture);
  });
});

for (const [name, invalidApproval] of [
  ["NUL", Buffer.from("# comment\n\0", "binary")],
  ["DEL", Buffer.from([35, 32, 111, 107, 10, 127, 10])],
  ["control byte", Buffer.from([35, 32, 111, 107, 10, 1, 10])],
  ["non-ASCII byte", Buffer.from([35, 32, 111, 107, 10, 128, 10])],
  ["lone CR", Buffer.from([35, 32, 111, 107, 13, 88, 10])],
]) {
  test(`candidate allowlist raw-byte validation rejects ${name}`, async () => {
    const checklist = historicalChecklist(await readFile(runbookUrl, "utf8"));
    await withHistoricalFixture(invalidApproval, async (fixture) => {
      const reviewedDigest = await reviewedDiffDigest(fixture.root, fixture.currentSha, fixture.candidateSha);
      const rejected = runHistoricalChecklist(checklist, fixture, fixture.candidateSha, reviewedDigest);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /Candidate Compose removal approval file/);
      await assertValidationTempRemoved(fixture);
    });
  });
}

test("candidate allowlist canonical parser rejects a malformed four-field record", async () => {
  const checklist = historicalChecklist(await readFile(runbookUrl, "utf8"));
  const malformedApproval = "al_lio_web|invalid-key|STABLE_FLAG|false\n";
  await withHistoricalFixture(malformedApproval, async (fixture) => {
    const reviewedDigest = await reviewedDiffDigest(fixture.root, fixture.currentSha, fixture.candidateSha);
    const rejected = runHistoricalChecklist(checklist, fixture, fixture.candidateSha, reviewedDigest);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /invalid destination identifier/);
  });
});

for (const [path, mode, label] of [
  [migrationPath, "120000", "migration 0017"],
  [migrationPath, "100755", "migration 0017"],
  [migrationPath, "160000", "migration 0017"],
  [routePath, "120000", "/api/version route"],
  [routePath, "100755", "/api/version route"],
  [composeGuardPath, "120000", "Compose environment guard"],
  [transitionPolicyPath, "120000", "production transition policy"],
  [composeGuardPath, "100755", "Compose environment guard"],
]) {
  test(`historical regular-blob gate rejects ${path} with mode ${mode}`, async () => {
    const checklist = historicalChecklist(await readFile(runbookUrl, "utf8"));
    await withHistoricalFixture("# no active approvals\n", async (fixture) => {
      const hostileSha = await commitModeMutation(
        fixture,
        path,
        mode,
        `change ${path} to mode ${mode}`,
      );
      const reviewedDigest = await reviewedDiffDigest(fixture.root, fixture.currentSha, hostileSha);
      const rejected = runHistoricalChecklist(checklist, fixture, hostileSha, reviewedDigest);
      assert.notEqual(rejected.status, 0);
      assert.match(
        rejected.stderr,
        new RegExp(
          `${label} must be one exact 100644 blob; found mode=${mode} type=${mode === "160000" ? "commit" : "blob"}`,
          "i",
        ),
      );
      await assertValidationTempRemoved(fixture);
    });
  });
}

test("historical release record keeps staged, consumed and revoked approvals at none", async () => {
  const runbook = await readFile(runbookUrl, "utf8");
  assert.ok(
    runbook.includes(
      "printf 'staged_approvals=none\\nconsumed_approvals=none\\nrevoked_approvals=none\\n'",
    ),
  );
});

test("the permanent production allowlist contains no active historical approvals", async () => {
  const approvals = await readFile(approvalsUrl, "utf8");
  const activeRecords = approvals.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
  for (const record of activeRecords) {
    for (const historicalVariable of historicalVariables) {
      assert.ok(!record.split("|").includes(historicalVariable));
    }
  }
});

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
