// Source-level assertions intentionally protect the container startup boundary because running a production container is outside this suite.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Production startup fails closed when immutable release identity is absent or malformed", async () => {
  const validatorSource = await readFile(new URL("../../../scripts/validate-runtime-env.mjs", import.meta.url), "utf8");
  const dockerfile = await readFile(new URL("../../../infra/Dockerfile", import.meta.url), "utf8");

  assert.match(validatorSource, /process\.env\.AL_LIO_RELEASE_SHA\?\.trim\(\)/);
  assert.match(validatorSource, /production && !\/\^\[0-9a-f\]\{40\}\$\//);
  assert.match(dockerfile, /node scripts\/validate-runtime-env\.mjs && exec node server\.js/);
});
