// Source-level assertion rationale: issue #362 defines the authoritative
// semantic visual-token contract in src/app/globals.css :root. The risk is the
// contract drifting - a shared primitive bypassing it, a retired colour
// returning, or a text token dropping below WCAG AA. There is no runtime
// boundary to execute; reading globals.css and the shared primitives as text,
// and recalculating contrast from the canonical values, is the correct
// boundary (tests/README.md taxonomy options 5 and 6).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { contrastRatio, readRootTokens, resolveColor } from "./support/contrast.mjs";

const GLOBALS_CSS = new URL("../../../src/app/globals.css", import.meta.url);
const UI = (name) => new URL(`../../../src/components/ui/${name}`, import.meta.url);

test("globals.css declares the semantic visual-token contract and shared primitives consume it, not retired or framework-default colours (issue #362)", async () => {
  const [css, button, badge, input, select, textarea, card] = await Promise.all([
    readFile(GLOBALS_CSS, "utf8"),
    readFile(UI("button.tsx"), "utf8"),
    readFile(UI("badge.tsx"), "utf8"),
    readFile(UI("input.tsx"), "utf8"),
    readFile(UI("select.tsx"), "utf8"),
    readFile(UI("textarea.tsx"), "utf8"),
    readFile(UI("card.tsx"), "utf8"),
  ]);

  const root = css.slice(css.indexOf(":root {"), css.indexOf("\n  }"));

  // The contract exists as one authoritative block and names every semantic
  // role issue #362 lists. Values live here only; downstream files reference
  // the names, never a second copy of the value.
  assert.match(css, /Semantic visual-token contract \(issue #362\)/);
  for (const token of [
    "--al-surface-raised", "--al-surface-sunken",
    "--al-text-strong", "--al-text-body", "--al-text-muted",
    "--al-text-brand-strong", "--al-text-faint", "--al-text-brand",
    "--al-border", "--al-border-strong",
    "--al-success-surface", "--al-success-text",
    "--al-warning-surface", "--al-warning-text", "--al-warning-border",
    "--al-error-surface", "--al-error-text",
    "--al-info-surface", "--al-info-text",
    "--al-saved-surface", "--al-saved-text",
    "--al-completed-surface", "--al-completed-text", "--al-completed-border",
    "--al-state-neutral-surface",
    "--al-disabled-opacity",
  ]) {
    assert.ok(new RegExp(`${token}:\\s*\\S`).test(root), `contract is missing ${token}`);
  }

  // Lifecycle "completed" stays its own token even though it shares success's
  // green today - issue #362 forbids collapsing distinct states by colour.
  assert.notEqual(css.indexOf("--al-completed-surface"), -1);
  assert.notEqual(css.indexOf("--al-success-surface"), -1);
  assert.notEqual(css.indexOf("--al-completed-surface"), css.indexOf("--al-success-surface"));

  // Bright terracotta is reserved for non-text accents; the retired shadcn blue
  // must not reappear anywhere in the file.
  assert.match(root, /--al-text-brand:\s*#e15d2d;/i);
  assert.doesNotMatch(css, /214\s+84%\s+38%/);

  // Shared primitive CSS reads token names, not raw values.
  for (const [rule, tokenRef] of [
    [".al-page-header-title", "var(--al-text-strong)"],
    [".al-page-header-eyebrow", "var(--al-text-brand-strong)"],
    [".al-page-header-subtitle", "var(--al-text-muted)"],
    [".al-field-label", "var(--al-text-strong)"],
    [".al-listbox-trigger", "var(--al-border)"],
    [".al-catalog-status-pending", "var(--al-warning-surface)"],
    [".al-catalog-status-open", "var(--al-success-surface)"],
    [".al-catalog-status-dismissed", "var(--al-error-surface)"],
    [".al-catalog-status-review", "var(--al-saved-surface)"],
    [".al-catalog-status-complete", "var(--al-completed-surface)"],
  ]) {
    const start = css.indexOf(`${rule} {`);
    assert.notEqual(start, -1, `${rule} rule not found`);
    assert.ok(css.slice(start, start + 400).includes(tokenRef), `${rule} must consume ${tokenRef}`);
  }

  // The shared custom field keeps an explicit keyboard focus treatment that
  // reads the field focus token, and it is :focus-visible (not :focus).
  const focusStart = css.indexOf(".al-listbox-trigger:focus-visible {");
  assert.notEqual(focusStart, -1, ".al-listbox-trigger:focus-visible rule is missing");
  assert.match(css.slice(focusStart, focusStart + 200), /outline:[^;]*hsl\(var\(--ring\)\)/);
  assert.doesNotMatch(css, /\.al-listbox-trigger:focus\s*\{/, "must not fall back to a bare :focus treatment");

  // One disabled-opacity source: the token. Neither the Button primitive nor
  // the shared catalogue action re-encodes the number.
  assert.match(button, /disabled:opacity-\[var\(--al-disabled-opacity\)\]/, "Button must consume --al-disabled-opacity");
  assert.doesNotMatch(button, /opacity-50/, "Button must not re-encode the disabled opacity");
  const actionDisabled = css.indexOf(".al-catalog-action:disabled {");
  assert.ok(css.slice(actionDisabled, actionDisabled + 120).includes("var(--al-disabled-opacity)"));
  assert.equal((css.match(/--al-disabled-opacity:\s*[0-9.]+/g) ?? []).length, 1, "the literal disabled opacity is declared exactly once");

  // Shared .tsx primitives carry no raw hex and no framework-default palette;
  // they route through the Tailwind token utilities.
  for (const [name, source] of [["button", button], ["badge", badge], ["input", input], ["select", select], ["textarea", textarea], ["card", card]]) {
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `${name}.tsx must not hardcode a hex colour`);
  }
  assert.match(button, /bg-destructive text-destructive-foreground/, "destructive stays a distinct treatment");
  assert.match(badge, /text-muted-foreground/);
  assert.match(card, /bg-card text-card-foreground/);
});

test("every foreground the visual-token contract declares meets its WCAG threshold on the surfaces it is documented for (issue #362)", async () => {
  const tokens = await readRootTokens(GLOBALS_CSS);
  const rgb = (name) => resolveColor(tokens[name] ?? `var(${name})`, tokens);

  // Contract structure only - which role sits on which surface, and at what
  // bar. The colour values are read from globals.css, never repeated here.
  const NORMAL_TEXT = 4.5;
  const NON_TEXT = 3;

  const textPairs = [
    ["--al-text-strong", ["--al-surface-raised", "--background", "--al-state-neutral-surface"]],
    ["--al-text-body", ["--al-surface-raised"]],
    ["--al-text-muted", ["--al-surface-raised", "--background", "--al-state-neutral-surface"]],
    ["--al-text-brand-strong", ["--al-surface-raised", "--background", "--al-saved-surface"]],
    ["--al-success-text", ["--al-success-surface"]],
    ["--al-warning-text", ["--al-warning-surface"]],
    ["--al-error-text", ["--al-error-surface"]],
    ["--al-info-text", ["--al-info-surface"]],
    ["--al-saved-text", ["--al-saved-surface"]],
    ["--al-completed-text", ["--al-completed-surface"]],
  ];
  const nonTextPairs = [
    ["--al-text-faint", ["--al-surface-raised"]],
    ["--al-text-brand", ["--al-surface-raised"]],
    ["--al-accent-strong", ["--al-surface-raised"]],
    ["--ring", ["--al-surface-raised", "--background"]],
    ["--al-action-soft-focus", ["--al-surface-raised", "--background"]],
  ];

  for (const [token, surfaces] of textPairs) {
    for (const surface of surfaces) {
      const ratio = contrastRatio(rgb(token), rgb(surface));
      assert.ok(
        ratio >= NORMAL_TEXT,
        `${token} on ${surface} is ${ratio.toFixed(2)}:1, below WCAG AA ${NORMAL_TEXT}:1`,
      );
    }
  }
  for (const [token, surfaces] of nonTextPairs) {
    for (const surface of surfaces) {
      const ratio = contrastRatio(rgb(token), rgb(surface));
      assert.ok(
        ratio >= NON_TEXT,
        `${token} on ${surface} is ${ratio.toFixed(2)}:1, below the ${NON_TEXT}:1 non-text minimum`,
      );
    }
  }

  // Bright --al-text-brand is deliberately NOT strong enough for normal text -
  // that is why --al-text-brand-strong exists. Guards against a future edit
  // routing body text back to the decorative accent.
  assert.ok(
    contrastRatio(rgb("--al-text-brand"), rgb("--al-surface-raised")) < NORMAL_TEXT,
    "--al-text-brand unexpectedly reaches text AA; fold it into --al-text-brand-strong if so",
  );
});
