import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "../../../src/app/api/version/route.ts";

const VALID_SHA = "1234567890abcdef1234567890abcdef12345678";

async function withReleaseSha(value, work) {
  const previous = process.env.AL_LIO_RELEASE_SHA;
  const previousSecret = process.env.AL_LIO_VERSION_TEST_SECRET;
  try {
    if (value === undefined) delete process.env.AL_LIO_RELEASE_SHA;
    else process.env.AL_LIO_RELEASE_SHA = value;
    process.env.AL_LIO_VERSION_TEST_SECRET = "must-not-leak";
    await work();
  } finally {
    if (previous === undefined) delete process.env.AL_LIO_RELEASE_SHA;
    else process.env.AL_LIO_RELEASE_SHA = previous;
    if (previousSecret === undefined) delete process.env.AL_LIO_VERSION_TEST_SECRET;
    else process.env.AL_LIO_VERSION_TEST_SECRET = previousSecret;
  }
}

test("GET /api/version returns the exact valid immutable release SHA", async () => {
  await withReleaseSha(VALID_SHA, async () => {
    const response = GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { releaseSha: VALID_SHA });
  });
});

test("GET /api/version reports an unavailable identity when the release SHA is absent", async () => {
  await withReleaseSha(undefined, async () => {
    const response = GET();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { releaseSha: null });
  });
});

test("GET /api/version reports an unavailable identity when the release SHA is malformed", async () => {
  for (const malformed of ["unknown", "ABCDEF1234567890ABCDEF1234567890ABCDEF12", "1234"]) {
    await withReleaseSha(malformed, async () => {
      const response = GET();
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { releaseSha: null });
    });
  }
});

test("GET /api/version exposes no environment or host data", async () => {
  await withReleaseSha(VALID_SHA, async () => {
    const response = GET();
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["releaseSha"]);
    assert.doesNotMatch(JSON.stringify(body), /must-not-leak|hostname|database|secret/i);
  });
});
