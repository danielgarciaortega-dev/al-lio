import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflowUrl = new URL("../../../.github/workflows/deploy-production.yml", import.meta.url);
const releaseSha = "0123456789abcdef0123456789abcdef01234567";
const repository = "danielgarciaortega-dev/al-lio";

function extractJob(source, name, nextName) {
  const start = source.indexOf(`  ${name}:\n`);
  assert.ok(start >= 0, `missing ${name} job`);
  const end = nextName ? source.indexOf(`\n  ${nextName}:\n`, start) : source.length;
  assert.ok(end > start, `missing end of ${name} job`);
  return source.slice(start, end);
}

function extractAttestationScript(source) {
  const marker = "node - \"$attestation_file\" \"$RELEASE_SHA\" \"$REPOSITORY\" <<'NODE'\n";
  const start = source.indexOf(marker);
  assert.ok(start >= 0, "missing inline CI attestation script");
  const bodyStart = start + marker.length;
  const end = source.indexOf("\n          NODE", bodyStart);
  assert.ok(end > bodyStart, "missing CI attestation heredoc terminator");
  return source.slice(bodyStart, end);
}

function exactRun(overrides = {}) {
  return {
    id: 12345,
    head_sha: releaseSha,
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    head_repository: { full_name: repository },
    path: ".github/workflows/ci.yml",
    ...overrides,
  };
}

async function runAttestation(source, workflowRuns, { totalCount = workflowRuns.length } = {}) {
  const script = extractAttestationScript(source);
  const root = await mkdtemp(join(tmpdir(), "al-lio-manual-ci-attestation-"));
  const responsePath = join(root, "runs.json");
  try {
    await writeFile(
      responsePath,
      JSON.stringify({ total_count: totalCount, workflow_runs: workflowRuns }),
      "utf8",
    );
    return spawnSync(process.execPath, ["-", responsePath, releaseSha, repository], {
      encoding: "utf8",
      input: script,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("manual production authorization runs before Production secrets with minimum permissions", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const preflight = extractJob(workflow, "authorize-manual", "deploy");
  const deploy = extractJob(workflow, "deploy");

  assert.match(workflow, /permissions: \{\}\n\nconcurrency:/);
  assert.match(preflight, /github\.event_name == 'workflow_dispatch'/);
  assert.match(preflight, /permissions:\s+actions: read/);
  assert.match(preflight, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(preflight, /\/actions\/workflows\/ci\.yml\/runs/);
  assert.match(preflight, /-f branch=main/);
  assert.match(preflight, /-f event=push/);
  assert.match(preflight, /-f status=completed/);
  assert.match(preflight, /-f head_sha="\$RELEASE_SHA"/);
  assert.doesNotMatch(preflight, /environment:/);
  assert.doesNotMatch(preflight, /secrets\.PRODUCTION_/);

  assert.match(deploy, /needs: authorize-manual/);
  assert.match(deploy, /always\(\)/);
  assert.match(deploy, /needs\.authorize-manual\.result == 'success'/);
  assert.match(deploy, /needs\.authorize-manual\.outputs\.release_sha == inputs\.release_sha/);
  assert.match(
    deploy,
    /RELEASE_SHA: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| needs\.authorize-manual\.outputs\.release_sha \}\}/,
  );
  assert.match(deploy, /environment:\s+name: Production/);
  assert.match(deploy, /secrets\.PRODUCTION_SSH_PRIVATE_KEY/);
});

test("automatic workflow_run authorization remains exact-success main push only", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const deploy = extractJob(workflow, "deploy");

  assert.match(workflow, /workflow_run:\s+workflows: \[CI\]\s+types: \[completed\]\s+branches: \[main\]/);
  assert.match(deploy, /github\.event_name == 'workflow_run'/);
  assert.match(deploy, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(deploy, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(deploy, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(deploy, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
});

test("manual exact-SHA successful canonical-main CI attestation passes", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const result = await runAttestation(workflow, [exactRun()]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Authorized manual deployment from CI run 12345/);
});

test("manual CI attestation rejects failed, cancelled, and skipped conclusions", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  for (const conclusion of ["failure", "cancelled", "skipped"]) {
    const result = await runAttestation(workflow, [exactRun({ conclusion })]);
    assert.equal(result.status, 1, `${conclusion}: ${result.stdout}\n${result.stderr}`);
  }
});

test("manual CI attestation rejects non-matching SHA, repository, event, branch, or workflow", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const cases = [
    exactRun({ head_sha: "f".repeat(40) }),
    exactRun({ head_repository: { full_name: "someone/fork" } }),
    exactRun({ event: "workflow_dispatch" }),
    exactRun({ head_branch: "feature/not-main" }),
    exactRun({ path: ".github/workflows/other.yml" }),
  ];

  for (const run of cases) {
    const result = await runAttestation(workflow, [run]);
    assert.equal(result.status, 1, `${JSON.stringify(run)}\n${result.stdout}\n${result.stderr}`);
  }
});

test("manual CI attestation fails closed on missing, ambiguous, or incomplete evidence", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  const missing = await runAttestation(workflow, []);
  assert.equal(missing.status, 1, missing.stderr || missing.stdout);

  const ambiguous = await runAttestation(workflow, [exactRun({ id: 1 }), exactRun({ id: 2 })]);
  assert.equal(ambiguous.status, 1, ambiguous.stderr || ambiguous.stdout);

  const incomplete = await runAttestation(workflow, [exactRun()], { totalCount: 101 });
  assert.equal(incomplete.status, 1, incomplete.stderr || incomplete.stdout);
});
