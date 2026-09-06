// Migrated mechanically from tests/security-boundaries.test.mjs for issue #274.
// Source-level assertions intentionally protect scripts, configuration, migrations, or deployment contracts whose real execution would be unsafe or impractical in the Node suite.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Runtime env validation enforces RESEND_API_KEY/RESEND_FROM_EMAIL together and in production, and validates GOOGLE_IDENTITY_REDIRECT_URI the same way GOOGLE_REDIRECT_URI already was (issue #132)", async () => {
  const source = await readFile(new URL("../../../scripts/validate-runtime-env.mjs", import.meta.url), "utf8");

  assert.match(source, /const resendValues = \[process\.env\.RESEND_API_KEY, process\.env\.RESEND_FROM_EMAIL\];/);
  assert.match(source, /if \(production && configuredResendValues !== resendValues\.length\) \{/);
  assert.match(source, /googleIdentityRedirect\.pathname\.endsWith\("\/api\/auth\/google\/callback"\)/);
});

test("Development startup loads Next.js env files and validates auth secrets before starting the server", async () => {
  const validatorSource = await readFile(new URL("../../../scripts/validate-runtime-env.mjs", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));

  assert.match(validatorSource, /import nextEnv from "@next\/env";/);
  assert.match(validatorSource, /const \{ loadEnvConfig \} = nextEnv;/);
  assert.match(validatorSource, /loadEnvConfig\(process\.cwd\(\), process\.env\.NODE_ENV !== "production"\);/);
  assert.match(validatorSource, /const baseUrl = parseUrl\("BASE_URL", production\);/);
  assert.match(validatorSource, /requiredSecret\("AL_LIO_RADAR_WEBHOOK_SECRET", 32, production\);/);
  assert.match(packageJson.scripts["verify:startup"], /^npm run validate:runtime && /);
  assert.equal(packageJson.devDependencies["@next/env"], packageJson.dependencies.next);
});

test("The review event seed is explicit, idempotent and restricted to one named local account", async () => {
  const source = await readFile(new URL("../../../scripts/seed-local-review-event.mjs", import.meta.url), "utf8");

  assert.match(source, /AL_LIO_SEED_LOCAL_REVIEW_EVENT/);
  assert.match(source, /AL_LIO_LOCAL_REVIEW_USER_EMAIL/);
  assert.match(source, /\["localhost", "127\.0\.0\.1", "::1"\]\.includes\(hostname\)/);
  assert.match(source, /WHERE lower\(email\) = lower\(\$1\)/);
  assert.match(source, /AND role = 'user'/);
  assert.match(source, /ON CONFLICT \(user_id, id_slug\) DO UPDATE SET/);
  assert.match(source, /await client\.query\("BEGIN"\);/);
  assert.match(source, /await client\.query\("COMMIT"\);/);
  assert.doesNotMatch(source, /DELETE FROM public\.hackathons/);
});

test(".env.example documents every new production-authentication variable (issue #132)", async () => {
  const source = await readFile(new URL("../../../.env.example", import.meta.url), "utf8");
  for (const key of ["GOOGLE_IDENTITY_REDIRECT_URI", "RESEND_API_KEY", "RESEND_FROM_EMAIL"]) {
    assert.match(source, new RegExp(`^${key}=`, "m"), `${key} must be documented`);
  }
});
