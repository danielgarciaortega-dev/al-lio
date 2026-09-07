import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("../../../scripts/check-test-taxonomy.mjs", import.meta.url));

async function write(root, relativePath, contents) {
  const target = join(root, ...relativePath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

test("taxonomy reports every violation in one run", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-taxonomy-"));
  const mappedTests = Array.from(
    { length: 263 },
    (_, index) => `test("legacy ${index + 1}", () => {});`,
  );
  const inventory = {
    issue: 274,
    legacyTestCount: 263,
    tests: mappedTests.map((_, index) => ({
      legacyIndex: index + 1,
      currentName: `legacy ${index + 1}`,
      targetFile: "tests/unit/domain/mapped.test.mjs",
    })),
  };

  try {
    await write(root, "tests/unit/domain/mapped.test.mjs", `${mappedTests.join("\n")}\n`);
    await write(
      root,
      "tests/operations/deployment/oversized.test.mjs",
      `import { readFileSync } from "node:fs";\nreadFileSync("source.ts", "utf8");\n${"// oversized\n".repeat(1_199)}`,
    );
    await write(root, "tests/migration-inventory.json", `${JSON.stringify(inventory)}\n`);

    const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Taxonomy failed with 3 violations:/m);
    assert.match(result.stderr, /mapped\.test\.mjs: test count limit exceeded; current=263 tests; required=<= 60 tests/);
    assert.match(result.stderr, /oversized\.test\.mjs: line count limit exceeded; current=1202 lines; required=<= 1200 lines/);
    assert.match(result.stderr, /oversized\.test\.mjs: missing source-level assertion rationale/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("taxonomy aggregates mapped target read and title parsing failures with ordinary violations", async () => {
  const root = await mkdtemp(join(tmpdir(), "al-lio-taxonomy-structural-"));
  const mappedTests = Array.from(
    { length: 261 },
    (_, index) => `test("legacy ${index + 1}", () => {});`,
  );
  const inventoryTests = mappedTests.map((_, index) => ({
    legacyIndex: index + 1,
    currentName: `legacy ${index + 1}`,
    targetFile: "tests/unit/domain/mapped.test.mjs",
  }));
  inventoryTests.push(
    {
      legacyIndex: 262,
      currentName: "broken",
      targetFile: "tests/unit/domain/malformed.test.mjs",
    },
    {
      legacyIndex: 263,
      currentName: "missing",
      targetFile: "tests/unit/domain/missing.test.mjs",
    },
  );

  try {
    await write(root, "tests/unit/domain/mapped.test.mjs", `${mappedTests.join("\n")}\n`);
    await write(root, "tests/unit/domain/malformed.test.mjs", 'test("unterminated, () => {});\n');
    await write(root, "tests/migration-inventory.json", `${JSON.stringify({
      issue: 274,
      legacyTestCount: 263,
      tests: inventoryTests,
    })}\n`);

    const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Taxonomy failed with 3 violations:/m);
    assert.match(result.stderr, /mapped\.test\.mjs: test count limit exceeded; current=261 tests; required=<= 60 tests/);
    assert.match(result.stderr, /malformed\.test\.mjs: mapped test title parsing failed; current=Could not parse a test title/);
    assert.match(result.stderr, /missing\.test\.mjs: mapped target unreadable; current=ENOENT/);
    assert.doesNotMatch(result.stderr, /(?:^|\n)\s*at\s+/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
