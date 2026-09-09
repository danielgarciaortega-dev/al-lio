// Source-level assertion rationale: route composition and authorization placement
// are architecture boundaries across Next.js server modules that the plain Node
// runner cannot import safely. The executable boundary checker is also invoked
// directly for dependency and module-size enforcement.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("dashboard routes compose feature public APIs without GuestApp routing shells", () => {
  assert.equal(existsSync(join(root, "src/components/guest-app.tsx")), false);
  assert.equal(existsSync(join(root, "src/components/stored-guest-app.tsx")), false);
  assert.equal(existsSync(join(root, "src/components/guest-store.tsx")), false);

  const routes = {
    work: "WorkFeature",
    courses: "CoursesFeature",
    hackathons: "EventsFeature",
    calendar: "CalendarFeature",
    sources: "SourcesFeature",
    settings: "SettingsFeature",
    bloc: "BlocFeature",
  };
  for (const [route, component] of Object.entries(routes)) {
    const source = readFileSync(join(root, `src/app/(dashboard)/${route}/page.tsx`), "utf8");
    assert.match(source, new RegExp(`from "@/features/[^"/]+"`));
    assert.match(source, new RegExp(`<${component} \\/>`));
    assert.doesNotMatch(source, /view=/);
  }
});

test("feature dependency and module-size rules pass", () => {
  const output = execFileSync(process.execPath, ["scripts/check-feature-boundaries.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(output, /Feature boundaries are valid/);
});

test("settings keeps route-level administrator authorisation", () => {
  const source = readFileSync(join(root, "src/app/(dashboard)/settings/page.tsx"), "utf8");
  assert.match(source, /await requireAdminUser\(\)/);
  assert.ok(source.indexOf("await requireAdminUser()") < source.indexOf("<SettingsFeature"));
});
