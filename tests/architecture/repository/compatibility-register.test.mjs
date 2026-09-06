// Source-level assertion rationale: this is an architecture drift guard for
// issue #357. It compares docs/architecture/COMPATIBILITY_REGISTER.md against
// the real route/handler/flag source. There is no runtime boundary to execute
// here - the risk being protected is documentation and source falling out of
// sync - so reading both as text is the correct boundary (taxonomy option 5/6).

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";

const root = process.cwd();
const registerPath = "docs/architecture/COMPATIBILITY_REGISTER.md";
const register = readFileSync(join(root, registerPath), "utf8");

const SURFACE_CLASSES = new Set(["active", "compatibility", "dormant", "removal-candidate"]);
const FLAG_CLASSES = new Set(["active", "dormant", "removal-candidate"]);

function section(title) {
  const start = register.indexOf(`## ${title}`);
  assert.notEqual(start, -1, `register is missing the "## ${title}" section`);
  const rest = register.slice(start + title.length + 3);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

function backticked(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

function parseRows(sectionText) {
  return sectionText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("| "))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 3 && !/^-+$/.test(cells[0]) && cells[0] !== "ID" && cells[0] !== "Flag" && cells[0] !== "Class");
}

const surfaceRows = parseRows(section("Registered runtime compatibility surfaces"));
const flagRows = parseRows(section("Application configuration flags"));

const surfaces = surfaceRows.map(([id, path, klass]) => ({
  id: backticked(id)[0],
  path: backticked(path)[0],
  klass,
}));

const flags = flagRows.map(([name, consumers, klass]) => ({
  name: backticked(name)[0],
  consumers: backticked(consumers),
  klass,
}));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const srcFiles = walk(join(root, "src"));
const rel = (file) => relative(root, file).split(sep).join("/");

const markerRe = /\/\/\s*COMPAT-REGISTER:\s*([a-z0-9-]+)/;
const markedFiles = srcFiles
  .map((file) => ({ file: rel(file), id: (readFileSync(file, "utf8").match(markerRe) ?? [])[1] }))
  .filter((entry) => entry.id);

test("issue #357/#379: the register lists the four retained scoped runtime surfaces", () => {
  assert.equal(surfaces.length, 4, `expected 4 retained surfaces, parsed ${surfaces.length}`);
  const paths = new Set(surfaces.map((surface) => surface.path));
  for (const expected of [
    "src/app/api/news/sync/route.ts",
    "src/app/api/collect/route.ts",
    "src/app/(dashboard)/ruta/[slug]/page.tsx",
    "src/app/api/tech-opportunities/route.ts",
  ]) {
    assert.ok(paths.has(expected), `register does not list ${expected}`);
  }
});

test("issue #357: every registered surface has a unique id, a real path, and a known class", () => {
  const ids = new Set();
  const paths = new Set();
  for (const surface of surfaces) {
    assert.ok(surface.id, `a surface row has no backticked id: ${JSON.stringify(surface)}`);
    assert.equal(ids.has(surface.id), false, `duplicate surface id: ${surface.id}`);
    assert.equal(paths.has(surface.path), false, `duplicate surface path: ${surface.path}`);
    ids.add(surface.id);
    paths.add(surface.path);
    assert.ok(SURFACE_CLASSES.has(surface.klass), `unknown class "${surface.klass}" for ${surface.id}`);
    assert.ok(existsSync(join(root, surface.path)), `registered path does not exist: ${surface.path}`);
  }
});

test("issue #357: source markers and the register are a bijection", () => {
  const registerIds = new Set(surfaces.map((surface) => surface.id));
  const markerIds = new Set(markedFiles.map((entry) => entry.id));

  for (const id of markerIds) {
    assert.ok(registerIds.has(id), `source marker COMPAT-REGISTER: ${id} has no register entry`);
  }
  for (const id of registerIds) {
    assert.ok(markerIds.has(id), `register entry "${id}" has no COMPAT-REGISTER marker in src/`);
  }

  const pathById = new Map(surfaces.map((surface) => [surface.id, surface.path]));
  for (const entry of markedFiles) {
    assert.equal(
      entry.file,
      pathById.get(entry.id),
      `COMPAT-REGISTER: ${entry.id} is in ${entry.file} but the register points at ${pathById.get(entry.id)}`,
    );
  }
});

test("issue #357: no unregistered 410 Gone route can be added", () => {
  const goneRoutes = srcFiles
    .filter((file) => rel(file).startsWith("src/app/") && file.endsWith("route.ts"))
    .filter((file) => /\bstatus:\s*410\b/.test(readFileSync(file, "utf8")))
    .map(rel);

  assert.ok(goneRoutes.length >= 2, `expected the two known 410 routes, found ${goneRoutes.join(", ") || "none"}`);
  for (const routePath of goneRoutes) {
    const source = readFileSync(join(root, routePath), "utf8");
    assert.match(source, markerRe, `${routePath} returns 410 Gone but carries no COMPAT-REGISTER marker`);
  }
});

test("issue #357/#379: every registered flag is still read by a listed consumer", () => {
  assert.equal(flags.length, 5, `expected 5 application flags, parsed ${flags.length}`);
  for (const flag of flags) {
    assert.ok(FLAG_CLASSES.has(flag.klass), `unknown flag class "${flag.klass}" for ${flag.name}`);
    assert.ok(flag.consumers.length > 0, `flag ${flag.name} lists no consumer`);
    const readingConsumers = flag.consumers.filter((consumer) => {
      const abs = join(root, consumer);
      return existsSync(abs) && readFileSync(abs, "utf8").includes(`process.env.${flag.name}`);
    });
    assert.ok(
      readingConsumers.length > 0,
      `no listed consumer of ${flag.name} still reads process.env.${flag.name} (checked: ${flag.consumers.join(", ")})`,
    );
  }
});

test("issue #357: every application AL_LIO flag is registered", () => {
  const registeredFlags = new Set(flags.map((flag) => flag.name));
  const sourceFlags = new Set();

  for (const file of srcFiles) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/process\.env\.(AL_LIO_[A-Z0-9_]+)/g)) {
      sourceFlags.add(match[1]);
    }
  }

  assert.deepEqual(
    [...registeredFlags].sort(),
    [...sourceFlags].sort(),
    "application-owned AL_LIO flags in src/ and the compatibility register must match exactly",
  );
});

test("issue #357: the register separates application flags from Radar/deployment passthrough", () => {
  const passthrough = section("Radar and deployment passthrough");
  for (const appFlag of ["AL_LIO_RADAR_WEBHOOK_SECRET", "AL_LIO_VERIFIED_OPPORTUNITIES_ONLY"]) {
    assert.ok(flags.some((flag) => flag.name === appFlag), `${appFlag} must be in the application-flag table`);
  }
  for (const radarFlag of ["AL_LIO_RADAR_AUTONOMOUS_PUBLICATION_ENABLED", "AL_LIO_RADAR_JOB_RADAR_ENABLED", "AL_LIO_RADAR_YOUTUBE_API_KEY"]) {
    assert.match(passthrough, new RegExp(radarFlag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${radarFlag} must be listed as passthrough`);
    assert.equal(
      flags.some((flag) => flag.name === radarFlag),
      false,
      `${radarFlag} is Radar passthrough and must not be in the application-flag table`,
    );
  }
});

test("issue #357: authentication, ownership and fail-closed guards are unchanged", () => {
  const read = (path) => readFileSync(join(root, path), "utf8");

  const newsSync = read("src/app/api/news/sync/route.ts");
  assert.match(newsSync, /status:\s*410/);

  const collect = read("src/app/api/collect/route.ts");
  assert.match(collect, /status:\s*410/);
  assert.match(collect, /Cache-Control["']?\s*:\s*["']no-store/);

  const techOpp = read("src/app/api/tech-opportunities/route.ts");
  assert.match(techOpp, /tryGetCurrentUserId\(\)/);
  assert.match(techOpp, /status:\s*401/);
  assert.match(techOpp, /private, no-store/);

  const ruta = read("src/app/(dashboard)/ruta/[slug]/page.tsx");
  assert.match(ruta, /getValidatedSession\(\)/);
  assert.match(ruta, /redirect\("\/login"\)/);

  const middleware = read("src/middleware.ts");
  assert.match(middleware, /"\/ruta"/);
  assert.match(middleware, /"\/ruta\/:path\*"/);
});
