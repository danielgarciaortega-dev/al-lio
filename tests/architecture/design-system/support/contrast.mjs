// WCAG 2.x relative-luminance and contrast helpers plus a small resolver for
// the CSS custom properties declared in `src/app/globals.css :root`. This file
// holds no colour values of its own - it reads them from the canonical
// stylesheet so the design-system tests measure the real contract.

import { readFile } from "node:fs/promises";

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r;
  let g;
  let b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m].map((v) => Math.round(v * 255));
}

function channel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Read every `--name: value;` declaration inside the first `:root { ... }` block.
export async function readRootTokens(cssUrl) {
  const css = await readFile(cssUrl, "utf8");
  const start = css.indexOf(":root {");
  const root = css.slice(start, css.indexOf("\n  }", start));
  const tokens = {};
  for (const match of root.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

// Resolve a token value (or a raw value) to an [r, g, b] triple, following
// `var(--x)` and `hsl(var(--x))` references and accepting hex, rgb[a] and a
// bare `H S% L%` HSL triple.
export function resolveColor(value, tokens, depth = 0) {
  if (depth > 12) throw new Error(`token reference cycle at "${value}"`);
  const v = value.trim();

  const varRef = v.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/);
  if (varRef) return resolveColor(tokens[varRef[1]], tokens, depth + 1);

  const hslVarRef = v.match(/^hsl\(\s*var\(\s*(--[a-z0-9-]+)\s*\)\s*\)$/);
  if (hslVarRef) return resolveColor(tokens[hslVarRef[1]], tokens, depth + 1);

  const hslTriple = v.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (hslTriple) return hslToRgb(Number(hslTriple[1]), Number(hslTriple[2]), Number(hslTriple[3]));

  const hex6 = v.match(/^#([0-9a-fA-F]{6})$/);
  if (hex6) return [0, 2, 4].map((i) => parseInt(hex6[1].slice(i, i + 2), 16));

  const hex3 = v.match(/^#([0-9a-fA-F]{3})$/);
  if (hex3) return [...hex3[1]].map((c) => parseInt(c + c, 16));

  const rgb = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];

  throw new Error(`cannot resolve colour: "${value}"`);
}
