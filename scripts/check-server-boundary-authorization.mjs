import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const inventoryPath = join(root, "config/security/server-boundaries.json");
const allowedKinds = new Set(["route-handler", "server-action", "server-read"]);
const allowedClassifications = new Set([
  "public",
  "authenticated",
  "user-owned",
  "admin-only",
  "internal-signed",
  "provider-callback",
]);
const sessionGuards = [
  "getValidatedSession(",
  "getCurrentUserId(",
  "tryGetCurrentUserId(",
  "getAuthenticatedStudentContext(",
  "requireAdminUser(",
];
const forbiddenClientOwnerPatterns = [
  /formData\.get\(["']userId["']\)/,
  /searchParams\.get\(["']userId["']\)/,
  /parsed(?:Body)?\.data\.userId\b/,
  /\bbody\.userId\b/,
];

function posixPath(path) {
  return path.split(sep).join("/");
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function sourcePath(absolute) {
  return posixPath(relative(root, absolute));
}

function discoverRouteHandlers() {
  return walk(join(root, "src/app"))
    .filter((file) => file.endsWith(`${sep}route.ts`))
    .map(sourcePath)
    .sort();
}

function discoverServerActionFiles() {
  const sourceExtensions = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
  return walk(join(root, "src"))
    .filter((file) => sourceExtensions.test(file) && !file.endsWith(`${sep}route.ts`))
    .filter((file) => /["']use server["'];?/.test(readFileSync(file, "utf8")))
    .map(sourcePath)
    .sort();
}

function setDifference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function fail(errors, message) {
  errors.push(message);
}

export function validateServerBoundaryInventory() {
  const errors = [];
  if (!existsSync(inventoryPath)) return ["Missing config/security/server-boundaries.json"];

  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  if (inventory.version !== 1) fail(errors, "Server-boundary inventory version must be 1");
  if (!Array.isArray(inventory.boundaries)) return [...errors, "Server-boundary inventory must contain a boundaries array"];

  const seen = new Set();
  for (const boundary of inventory.boundaries) {
    if (!boundary || typeof boundary.path !== "string") {
      fail(errors, "Every boundary must have a path");
      continue;
    }
    if (seen.has(boundary.path)) fail(errors, `Duplicate boundary: ${boundary.path}`);
    seen.add(boundary.path);
    if (!allowedKinds.has(boundary.kind)) fail(errors, `Invalid boundary kind for ${boundary.path}: ${boundary.kind}`);
    if (!allowedClassifications.has(boundary.classification)) {
      fail(errors, `Invalid classification for ${boundary.path}: ${boundary.classification}`);
    }

    const absolute = join(root, boundary.path);
    if (!existsSync(absolute)) {
      fail(errors, `Inventory path does not exist: ${boundary.path}`);
      continue;
    }
    const source = readFileSync(absolute, "utf8");
    for (const evidence of boundary.requiredEvidence ?? []) {
      if (!source.includes(evidence)) fail(errors, `${boundary.path} is missing required evidence: ${evidence}`);
    }

    if (["authenticated", "user-owned", "admin-only"].includes(boundary.classification)) {
      if (/\bgetSession\s*\(/.test(source)) {
        fail(errors, `${boundary.path} uses signature-only getSession() at an authorization boundary`);
      }
      if (!sessionGuards.some((guard) => source.includes(guard))) {
        fail(errors, `${boundary.path} has no approved database-backed session/authorization guard`);
      }
    }

    if (boundary.classification === "admin-only" && !source.includes("requireAdminUser(")) {
      fail(errors, `${boundary.path} must revalidate administrator authority server-side`);
    }
    if (boundary.classification === "internal-signed" && !source.includes("verifyRadarWebhook(")) {
      fail(errors, `${boundary.path} must verify the signed Radar boundary`);
    }
    if (boundary.classification === "user-owned") {
      if (boundary.ownershipSource !== "session.uid") {
        fail(errors, `${boundary.path} must declare session.uid as its ownership source`);
      }
      for (const pattern of forbiddenClientOwnerPatterns) {
        if (pattern.test(source)) fail(errors, `${boundary.path} appears to accept client-controlled userId ownership`);
      }
    }
  }

  const discoveredRoutes = discoverRouteHandlers();
  const inventoriedRoutes = inventory.boundaries
    .filter((boundary) => boundary.kind === "route-handler")
    .map((boundary) => boundary.path)
    .sort();
  const missingRoutes = setDifference(discoveredRoutes, inventoriedRoutes);
  const staleRoutes = setDifference(inventoriedRoutes, discoveredRoutes);
  for (const path of missingRoutes) fail(errors, `Unclassified Route Handler: ${path}`);
  for (const path of staleRoutes) fail(errors, `Stale Route Handler inventory entry: ${path}`);

  const discoveredActions = discoverServerActionFiles();
  const inventoriedActions = inventory.boundaries
    .filter((boundary) => boundary.kind === "server-action")
    .map((boundary) => boundary.path)
    .sort();
  const missingActions = setDifference(discoveredActions, inventoriedActions);
  const staleActions = setDifference(inventoriedActions, discoveredActions);
  for (const path of missingActions) fail(errors, `Unclassified Server Action file: ${path}`);
  for (const path of staleActions) fail(errors, `Stale Server Action inventory entry: ${path}`);

  return errors;
}

export function runServerBoundaryAuthorizationCheck() {
  const errors = validateServerBoundaryInventory();
  if (errors.length) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }

  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const routeCount = inventory.boundaries.filter((boundary) => boundary.kind === "route-handler").length;
  const actionCount = inventory.boundaries.filter((boundary) => boundary.kind === "server-action").length;
  const readCount = inventory.boundaries.filter((boundary) => boundary.kind === "server-read").length;
  console.log(`OK: server-boundary authorization inventory verified (${routeCount} routes, ${actionCount} action files, ${readCount} explicit private reads).`);
}

const invokedPath = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1]}`)) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  runServerBoundaryAuthorizationCheck();
}
