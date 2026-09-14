// Migrated mechanically from tests/security-boundaries.test.mjs for issue #274.
// Source-level assertions temporarily protect a Next.js, browser, or database boundary that the plain Node runner cannot execute; replace them when the corresponding integration harness exists.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readProductFeatureSources } from "../../support/feature-sources.mjs";

test("globals.css's --primary and --ring are the brand terracotta, not the default shadcn blue (issue #82)", async () => {
  const css = await readFile(new URL("../../../src/app/globals.css", import.meta.url), "utf8");

  // The old shadcn default (214 84% 38%) must be gone everywhere in this file.
  assert.doesNotMatch(css, /214\s+84%\s+38%/);

  // #E15D2D converts to hsl(16, 75%, 53%) - both --primary and --ring must
  // use it, and --primary-foreground stays white (every existing hardcoded
  // terracotta+white button in the app already assumes white text).
  assert.match(css, /--primary:\s*16\s+75%\s+53%;/);
  assert.match(css, /--ring:\s*16\s+75%\s+53%;/);
  assert.match(css, /--primary-foreground:\s*0\s+0%\s+100%;/);

  // Only primary/ring/primary-foreground changed - every other token is
  // untouched (guards against scope creep into --accent/--destructive/etc.,
  // which the issue explicitly says to leave alone unless documented).
  for (const untouched of [
    "--background: 42 30% 97%",
    "--destructive: 0 72% 47%",
    "--accent: 154 26% 88%",
    "--muted: 210 18% 92%",
    "--border: 214 15% 84%",
  ]) {
    assert.match(css, new RegExp(untouched.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `expected ${untouched} to be unchanged`);
  }
});

test("the surviving #81/daily-alerts hardcoded terracotta overrides read the fixed --primary token instead of a second, parallel hex value (issue #82, bottom navigation retired by issue #182, /more retired by issue #256)", async () => {
  const dailyAlerts = await readFile(new URL("../../../src/components/daily-alerts.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(dailyAlerts, /#E15D2D|#e15d2d|#c94f21/, "no hardcoded terracotta hex should remain once the token itself carries the brand color");
  assert.match(dailyAlerts, /text-primary"/);
  assert.match(dailyAlerts, /al-action-soft-selected/);
  assert.match(dailyAlerts, /al-action-soft/);
  assert.match(dailyAlerts, /accent-primary/);

  // Light terracotta-tint icon badges (bg-[#FBE7DD]) are a deliberate
  // separate constant, not a --primary alpha blend - left as-is on purpose,
  // not missed. See docs/architecture/decisions or the PR for the exact
  // rationale (Tailwind's bg-primary/N opacity modifier does not reproduce
  // #FBE7DD exactly).
  assert.match(dailyAlerts, /#FBE7DD|#fbe7dd/i, "the light-tint badge background is expected to remain hardcoded");
});

test("UI primitives keep the brand focus token while the default Button consumes the shared quiet action treatment (issues #82 and #166)", async () => {
  const [button, input, select, textarea, featureSources] = await Promise.all([
    readFile(new URL("../../../src/components/ui/button.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/ui/input.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/ui/select.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/ui/textarea.tsx", import.meta.url), "utf8"),
    readProductFeatureSources(),
  ]);

  assert.match(button, /variant === "default" && "al-action-soft"/);
  assert.match(input, /focus-visible:ring-ring/);
  assert.match(select, /focus-visible:ring-ring/);
  assert.match(textarea, /focus-visible:ring-ring/);
  assert.match(featureSources, /al-action-soft-selected/);
});
