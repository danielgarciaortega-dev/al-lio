// Source-level assertion rationale: package scripts, the pinned Knip configuration,
// and the reviewed debt baseline are repository policy files rather than runtime
// modules. Reading them directly verifies the exact CI and classification contract.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const baseline = JSON.parse(
  readFileSync(resolve(root, "docs/audits/unused-code-baseline.json"), "utf8"),
);
const knipConfig = readFileSync(resolve(root, "knip.jsonc"), "utf8");

test("unused-code audit is pinned and enforced by CI", () => {
  assert.equal(packageJson.devDependencies.knip, "6.34.0");
  assert.equal(packageJson.dependencies["server-only"], "0.0.1");
  assert.equal(packageJson.scripts["audit:unused"], "node scripts/check-unused-code.mjs");
  assert.equal(packageJson.scripts["audit:unused:raw"], "knip");
  assert.match(packageJson.scripts.ci, /^npm run test:taxonomy && npm run audit:unused && /);
});

test("Knip models framework and repository entry points without blanket ignores", () => {
  assert.match(knipConfig, /"src\/\*\*\/\*\.\{ts,tsx\}"/);
  assert.match(knipConfig, /"scripts\/\*\*\/\*\.mjs"/);
  assert.match(knipConfig, /"tests\/\*\*\/\*\.\{ts,mjs\}"/);
  assert.match(knipConfig, /"playwright": false/);
  assert.doesNotMatch(knipConfig, /"ignore(?:Files|Dependencies|Binaries|Unresolved)?"\s*:/);
});

test("baseline entries are exact, uniquely classified, and actionable", () => {
  assert.equal(baseline.schemaVersion, 1);
  assert.deepEqual(baseline.tool, { name: "knip", version: "6.34.0" });

  const findings = [];
  for (const group of baseline.groups) {
    for (const field of ["classification", "owner", "reason", "followUp"]) {
      assert.equal(typeof group[field], "string");
      assert.ok(group[field].trim().length > 0, `${field} must not be empty`);
    }
    assert.ok(group.findings.length > 0);
    for (const finding of group.findings) {
      assert.doesNotMatch(finding, /\*/);
      findings.push(finding);
    }
  }

  assert.equal(findings.length, 3);
  assert.equal(new Set(findings).size, findings.length);
});
