import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateServerBoundaryInventory } from "../../../scripts/check-server-boundary-authorization.mjs";

// Source-level assertion rationale: these architecture tests protect repository-wide
// authorization invariants that span Next.js Route Handlers, Server Actions and SQL
// repositories. Executing every boundary would duplicate the existing integration/E2E
// suites and still would not prove exhaustive file coverage; the filesystem inventory
// is the mechanically complete boundary here, while runtime auth behaviour remains
// covered by the focused integration and browser tests.

test("every Route Handler and Server Action file is explicitly classified and satisfies its authorization evidence", () => {
  assert.deepEqual(validateServerBoundaryInventory(), []);
});

test("validated sessions fail closed when the database security stamp no longer matches", async () => {
  const source = await readFile(new URL("../../../src/lib/auth/session.ts", import.meta.url), "utf8");
  assert.match(source, /export async function getValidatedSession\(\)/);
  assert.match(source, /await requireValidSessionUser\(session\);/);
  assert.match(source, /const user = await getUserById\(session\.uid\);/);
  assert.match(source, /user\.security_stamp !== session\.sv/);
});

test("administrator authority is re-read from the database rather than trusted from a client or token role", async () => {
  const source = await readFile(new URL("../../../src/lib/auth/authorization.ts", import.meta.url), "utf8");
  assert.match(source, /async function getCurrentUser\(\)/);
  assert.match(source, /const session = await getValidatedSession\(\);/);
  assert.match(source, /return getUserById\(session\.uid\);/);
  assert.match(source, /const user = await getCurrentUser\(\);/);
  assert.match(source, /user\.role !== "admin"/);
  assert.doesNotMatch(source, /session\.role|searchParams.*role|formData.*role/);
});

test("Job Radar object mutations remain scoped to both resource id and the validated user id", async () => {
  const source = await readFile(new URL("../../../src/lib/job-radar/store.ts", import.meta.url), "utf8");
  assert.match(source, /WHERE id = \$3 AND user_id = \$4/);
  assert.match(source, /WHERE id = \$2 AND user_id = \$3/);
  assert.match(source, /WHERE id = \$1 AND user_id = \$2/);
  assert.match(source, /DELETE FROM public\.job_applications WHERE id = \$1 AND user_id = \$2/);
});

test("Radar machine ingestion remains authenticated by the signed webhook boundary", async () => {
  const source = await readFile(new URL("../../../src/lib/radar/webhook-auth.ts", import.meta.url), "utf8");
  assert.match(source, /AL_LIO_RADAR_WEBHOOK_SECRET/);
  assert.match(source, /timestamp outside allowed window/);
  assert.match(source, /createRadarSignature\(secret, timestamp, deliveryId, rawBody\)/);
  assert.match(source, /radarSignaturesMatch\(expected, signature\)/);
});
