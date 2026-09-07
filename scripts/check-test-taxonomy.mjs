import { isDeepStrictEqual } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const testsRoot = path.join(root, "tests");
const allowedLayers = new Set(["architecture", "contracts", "integration", "operations", "unit"]);
const maxTestsPerFile = 60;
const maxLinesPerFile = 1_200;
const violations = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
}

function testTitles(source) {
  return [...source.matchAll(/^test\(/gm)].map((match) => {
    const quoteIndex = source.indexOf('"', match.index);
    let escaped = false;
    for (let index = quoteIndex + 1; index < source.length; index += 1) {
      const character = source[index];
      if (!escaped && character === '"') {
        const literal = source.slice(quoteIndex, index + 1).replace(/\\\r?\n/g, "");
        return Function(`"use strict"; return ${literal};`)();
      }
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
    }
    throw new Error("Could not parse a test title");
  });
}

function addViolation(file, type, current, requirement) {
  violations.push(`- ${file}: ${type}; current=${current}; required=${requirement}`);
}

const allFiles = await walk(testsRoot);
const testFiles = allFiles.filter((file) => file.endsWith(".test.mjs"));
if (testFiles.length === 0) {
  addViolation("tests/", "test discovery", "0 focused files", "at least 1 focused .test.mjs file");
}

for (const file of testFiles) {
  const relative = path.relative(testsRoot, file).replaceAll("\\", "/");
  const [layer, domain] = relative.split("/");
  if (!allowedLayers.has(layer)) {
    addViolation(relative, "invalid test layer", layer || "<missing>", [...allowedLayers].join("|"));
  }
  if (!domain || domain.endsWith(".test.mjs")) {
    addViolation(relative, "missing owner domain", domain || "<missing>", "tests/<layer>/<domain>/<name>.test.mjs");
  }

  const source = await readFile(file, "utf8");
  const testCount = (source.match(/^test\(/gm) ?? []).length;
  const lineCount = source.split(/\r?\n/).length;
  if (testCount > maxTestsPerFile) {
    addViolation(relative, "test count limit exceeded", `${testCount} tests`, `<= ${maxTestsPerFile} tests`);
  }
  if (lineCount > maxLinesPerFile) {
    addViolation(relative, "line count limit exceeded", `${lineCount} lines`, `<= ${maxLinesPerFile} lines`);
  }

  if (
    /\breadFile(?:Sync)?\(/.test(source)
    && !/Source-level assertion rationale:|Source-level assertions (?:temporarily|intentionally)/.test(source)
  ) {
    addViolation(
      relative,
      "missing source-level assertion rationale",
      "readFile/readFileSync without an accepted rationale",
      "explain why the real boundary is not executed",
    );
  }
}

const removedCatchAll = path.join(testsRoot, "security-boundaries.test.mjs");
try {
  await stat(removedCatchAll);
  addViolation(
    "security-boundaries.test.mjs",
    "retired catch-all restored",
    "file exists",
    "file absent",
  );
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const inventoryPath = path.join(testsRoot, "migration-inventory.json");
const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
if (inventory.issue !== 274) {
  addViolation("migration-inventory.json", "issue contract mismatch", inventory.issue, "274");
}
if (inventory.legacyTestCount !== 263) {
  addViolation("migration-inventory.json", "legacy test count mismatch", inventory.legacyTestCount, "263");
}
if (inventory.tests.length !== 263) {
  addViolation("migration-inventory.json", "inventory entry count mismatch", inventory.tests.length, "263");
}
const expectedIndexes = Array.from({ length: 263 }, (_, index) => index + 1);
if (!isDeepStrictEqual(inventory.tests.map((entry) => entry.legacyIndex), expectedIndexes)) {
  addViolation(
    "migration-inventory.json",
    "legacy index sequence mismatch",
    JSON.stringify(inventory.tests.map((entry) => entry.legacyIndex)),
    JSON.stringify(expectedIndexes),
  );
}

const inventoryByTarget = Map.groupBy(inventory.tests, (entry) => entry.targetFile);
for (const [target, entries] of inventoryByTarget) {
  const absoluteTarget = path.join(root, ...target.split("/"));
  let source;
  try {
    source = await readFile(absoluteTarget, "utf8");
  } catch (error) {
    addViolation(
      target,
      "mapped target unreadable",
      error?.code ?? error?.message ?? String(error),
      "readable UTF-8 mapped test target",
    );
    continue;
  }
  const actualCount = (source.match(/^test\(/gm) ?? []).length;
  if (actualCount !== entries.length) {
    addViolation(target, "mapped legacy test count mismatch", `${actualCount} tests`, `${entries.length} tests`);
  }
  let actualTitles;
  try {
    actualTitles = testTitles(source);
  } catch (error) {
    addViolation(
      target,
      "mapped test title parsing failed",
      error?.message ?? String(error),
      "all mapped top-level test titles parseable",
    );
    continue;
  }
  const expectedTitles = entries.map((entry) => entry.currentName);
  if (!isDeepStrictEqual(actualTitles, expectedTitles)) {
    addViolation(
      target,
      "mapped legacy test names or order changed",
      JSON.stringify(actualTitles),
      JSON.stringify(expectedTitles),
    );
  }
}

if (violations.length > 0) {
  console.error(`Taxonomy failed with ${violations.length} violation${violations.length === 1 ? "" : "s"}:`);
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Test taxonomy OK: ${testFiles.length} focused files, ${inventory.tests.length} mapped legacy tests.`);
}
