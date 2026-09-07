import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const runbookUrl = new URL("../../../docs/operations/DEPLOY_VPS.md", import.meta.url);
const approvalsUrl = new URL("../../../scripts/config/production-compose-env-removals.allowlist", import.meta.url);
const composeGuardUrl = new URL("../../../scripts/lib/compose-env-guard.sh", import.meta.url);
const transitionPolicyUrl = new URL("../../../scripts/lib/production-transition-policy.sh", import.meta.url);
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

test("runbook placeholders are shell-safe, guarded, and CR trimming uses an actual carriage return", async () => {
  const runbook = await readFile(runbookUrl, "utf8");
  assert.doesNotMatch(runbook, /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=<[^>\n]+>/m);
  for (const assignment of [
    'export AL_LIO_RELEASE_SHA="REPLACE_WITH_FULL_40_CHARACTER_REVIEWED_MAIN_SHA"',
    'export AL_LIO_EXCEPTION_REASON="REPLACE_WITH_REVIEWED_TICKET_OR_CHANGE_REFERENCE"',
    'export AL_LIO_REVIEWED_RUNTIME_CONTROL_PLANE_DIFF_SHA256="REPLACE_WITH_REVIEWED_64_CHARACTER_LOWERCASE_SHA256"',
    'export AL_LIO_RECOVERY_BACKUP="REPLACE_WITH_EXACT_VERIFIED_DUMP_FROM_RELEASE_RECORD"',
  ]) {
    assert.ok(runbook.includes(assignment), `missing safe placeholder: ${assignment}`);
  }
  assert.ok(runbook.includes('value="${value%$\'\\r\'}"'));
  assert.ok(!runbook.includes('value="${value%$\'\\\\r\'}"'));
  assert.match(runbook, /\$AL_LIO_REQUIRED_VALUE.*== REPLACE_WITH_\*/s);
});

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
