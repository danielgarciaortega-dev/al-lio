// Source-level assertion rationale: executing the exceptional production runbook
// end to end would mutate production and recovery state. These tests extract and
// execute its real Bash blocks locally where safe, and inspect source only for
// immutable operator contracts that cannot be exercised without that boundary.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  approvalPath,
  approvalsUrl,
  assertValidationTempRemoved,
  bashBlockContaining,
  bashPath,
  commitModeMutation,
  commitMutation,
  composeGuardPath,
  exactMigration,
  exactRoute,
  historicalChecklist,
  historicalVariables,
  migrationPath,
  reviewedDiffDigest,
  routePath,
  runHistoricalChecklist,
  transitionPolicyPath,
  withHistoricalFixture,
} from "./support/production-runbook-fixture.mjs";

const runbookUrl = new URL("../../../docs/operations/DEPLOY_VPS.md", import.meta.url);
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
