// Migrated mechanically from tests/security-boundaries.test.mjs for issue #274.
// Source-level assertions temporarily protect a Next.js, browser, or database boundary that the plain Node runner cannot execute; replace them when the corresponding integration harness exists.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readFeatureSource } from "../../helpers/feature-sources.mjs";

import { SPANISH_PROVINCES } from "../../../src/lib/deeplinks/spanish-provinces.ts";

test("QuickJobSearchCard no longer hardcodes an example search - the fields start genuinely empty, with a plain descriptive placeholder, not a fabricated example value (issue #123, owner-reported follow-up)", async () => {
  const source = await readFeatureSource("work");
  const cardStart = source.indexOf("const QuickJobSearchCard = memo(");
  const cardEnd = source.indexOf("\n});", cardStart);
  const cardSource = source.slice(cardStart, cardEnd);

  assert.doesNotMatch(cardSource, /useState\("programador java"\)/, "the keyword field must not start pre-filled");
  assert.doesNotMatch(cardSource, /useState<"Granada" \| "Teletrabajo">\("Granada"\)/, "the old 2-option Granada/Teletrabajo dropdown state must be gone");
  assert.match(cardSource, /useState\(""\)/, "query starts empty");
  assert.doesNotMatch(cardSource, /programador java/i, "no invented example value anywhere, including as a placeholder - matches the plain descriptive placeholders used by every other search field in this file (e.g. 'Buscar empresa o categoria')");
  assert.match(cardSource, /placeholder="Puesto o palabra clave"/, "a plain descriptive placeholder, consistent with the rest of the app's search inputs");
});

test("The quick-search card wires a real province combobox with type-ahead filtering and a dedicated remote switch (issue #123)", async () => {
  const source = await readFeatureSource("work");

  assert.match(source, /import \{ SPANISH_PROVINCES \} from "@\/lib\/deeplinks\/spanish-provinces";/);
  assert.match(source, /function ProvinceCombobox\(/);
  assert.match(source, /SPANISH_PROVINCES\.filter\(\(province\) => normalizeForProvinceSearch\(province\)\.includes\(needle\)\)/, "type-ahead filtering, the gap the issue found in FieldListbox");

  const cardStart = source.indexOf("const QuickJobSearchCard = memo(");
  const cardEnd = source.indexOf("\n});", cardStart);
  const cardSource = source.slice(cardStart, cardEnd);
  assert.match(cardSource, /<ProvinceCombobox/);
  assert.match(cardSource, /role="switch"[\s\S]*?aria-checked=\{remote\}/, "a dedicated toggle, not a 3rd dropdown option");
  assert.match(cardSource, /disabled=\{remote\}/, "the province field disables while remote is active");
});

test("ProvinceCombobox shows its placeholder while disabled instead of a stale leftover province - verified live: toggling teletrabajo on while Granada was selected still displayed 'Granada' until this was fixed (issue #123)", async () => {
  const source = await readFeatureSource("work");
  const comboStart = source.indexOf("function ProvinceCombobox(");
  const comboEnd = source.indexOf("\nconst QuickJobSearchCard", comboStart);
  const comboSource = source.slice(comboStart, comboEnd);

  assert.match(comboSource, /\{disabled \? placeholder : value \|\| placeholder\}/, "disabled must win over a previously-selected value, not just gate the panel");
});

test("Searching persists the platform's last query/location, and loading pre-fills it from the same source on the next visit (issue #123)", async () => {
  const source = await readFeatureSource("work");

  assert.match(source, /import \{ getQuickSearchesAction, saveQuickSearchAction, type SavedQuickSearch \} from "@\/features\/work\/server\/actions";/);
  assert.match(source, /getQuickSearchesAction\(\)\.then\(/, "Work() loads saved searches once, not per-card");
  assert.match(source, /saveQuickSearchAction\(platform, keyword, location\)\.catch\(\(\) => \{\}\)/, "save is fire-and-forget - it must never block opening the search tab");

  const cardStart = source.indexOf("const QuickJobSearchCard = memo(");
  const cardEnd = source.indexOf("\n});", cardStart);
  const cardSource = source.slice(cardStart, cardEnd);
  assert.match(cardSource, /hydrated\.current = true;/, "the saved value hydrates the fields exactly once, it does not fight the user's later edits");
  assert.match(cardSource, /onSearch\(platform, query, effectiveLocation\)/);
});

test("The empty-keyword state cannot fire a search or a save - the Buscar action is genuinely disabled, not just visually dimmed (issue #123)", async () => {
  const source = await readFeatureSource("work");
  const cardStart = source.indexOf("const QuickJobSearchCard = memo(");
  const cardEnd = source.indexOf("\n});", cardStart);
  const cardSource = source.slice(cardStart, cardEnd);

  assert.match(cardSource, /const canSearch = query\.trim\(\)\.length > 0;/);
  assert.match(cardSource, /href=\{canSearch \? url : undefined\}/, "no href means no navigation, on top of the onClick guard");
  assert.match(cardSource, /if \(!canSearch\) \{ event\.preventDefault\(\); return; \}/);
});

test("Work's feature-owned actions are session-scoped, validated and never redirect from a background mutation (issue #123, #275)", async () => {
  const source = await readFile(new URL("../../../src/features/work/server/actions.ts", import.meta.url), "utf8");
  const repository = await readFile(new URL("../../../src/features/work/server/repository.ts", import.meta.url), "utf8");

  assert.match(source, /"use server";/);
  assert.match(source, /const session = await getValidatedSession\(\);/g);
  assert.doesNotMatch(source, /redirect\(/, "a background save/read must degrade to an error result, not throw a Next.js redirect");
  assert.match(source, /quickSearchSchema\.safeParse/, "the client cannot persist an arbitrary platform or oversized query");
  assert.match(repository, /'work'/, "the repository owns the fixed category instead of accepting it from the client");
  assert.match(source, /\.filter\(\(row\) => row\.category === "work"\)/, "reads must not leak rows from an unrelated future category sharing this table");
});

test("Owner-reported follow-up: the gap between the Trabajo header and the Portales/Empresas tabs is tightened with an inline style, not a competing class, because Tailwind's space-y-6 sibling selector outranks a plain .al-work-tabs class rule", async () => {
  const source = await readFile(new URL("../../../src/features/work/client/work-feature.tsx", import.meta.url), "utf8");
  const workStart = source.indexOf("function Work(");
  const workEnd = source.indexOf("\nconst workBrandCss", workStart);
  const workSource = source.slice(workStart, workEnd);

  assert.match(
    workSource,
    /<div className="al-work-tabs" style=\{\{ marginTop: 8 \}\}>/,
    "an inline style is required here - a .al-work-tabs CSS rule has lower specificity than the space-y-6-generated sibling selector currently setting this element's margin-top, so a plain class override would silently lose"
  );
});
