// Migrated mechanically from tests/security-boundaries.test.mjs for issue #274.
// Source-level assertions temporarily protect a Next.js, browser, or database boundary that the plain Node runner cannot execute; replace them when the corresponding integration harness exists.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readFeatureSource } from "../../support/feature-sources.mjs";

import { toIsoTimestamp } from "../../../src/lib/bloc/timestamps.ts";

import { buildNoteExportHtml } from "../../../src/lib/bloc/note-export.ts";

test("Bloc's server boundary normalizes PostgreSQL timestamps before they reach the client, instead of passing raw Date values through (issue #128)", async () => {
  const source = await readFile(new URL("../../../src/features/bloc/server/actions.ts", import.meta.url), "utf8");
  assert.match(source, /toIsoTimestamp/, "notes-actions.ts should normalize created_at/updated_at/deleted_at at the server-to-client boundary");
  assert.doesNotMatch(source, /created_at: row\.created_at,\s*\n\s*updated_at: row\.updated_at,/, "the DTO must not pass raw pg row timestamps through unnormalized");
});

test("Bloc's PDF export replaces the retired hand-rolled byte-level serializer with a raster-preserving jsPDF/html2canvas path (issue #128)", async () => {
  const source = await readFeatureSource("bloc");
  assert.doesNotMatch(source, /buildSimplePdf|toUtf16Hex|BaseFont \/Helvetica/, "the raw PDF byte serializer must be fully removed, not left dead in the file");
  assert.match(source, /import\("jspdf"\)/);
  assert.match(source, /import\("html2canvas"\)/);
  assert.match(source, /buildNoteExportHtml/);
  assert.match(source, /doc\.addImage/, "browser-rendered note pages must be embedded so Unicode glyphs are not lost to jsPDF's built-in fonts");
  assert.doesNotMatch(source, /doc\.html\(/, "the jsPDF HTML text renderer falls back to built-in fonts and corrupts unsupported Unicode glyphs");
});

test("Bloc's PDF export keeps the html2canvas source at the canvas origin instead of rasterizing blank off-screen pages (issue #128)", async () => {
  const source = await readFeatureSource("bloc");
  const start = source.indexOf("async function exportActivePdf");
  const end = source.indexOf("function exportActiveWord");
  assert.ok(start !== -1 && end !== -1 && end > start);
  const fn = source.slice(start, end);
  assert.match(fn, /left:\s*0/, "the export surface must start at the html2canvas origin");
  assert.doesNotMatch(fn, /left:\s*-\d/, "a negative horizontal offset produces correctly-sized but blank PDF pages");
});

test("Bloc's PDF export scales and slices the browser canvas inside the printable A4 bounds (issue #128)", async () => {
  const source = await readFeatureSource("bloc");
  const start = source.indexOf("async function exportActivePdf");
  const end = source.indexOf("function exportActiveWord");
  assert.ok(start !== -1 && end !== -1 && end > start);
  const fn = source.slice(start, end);
  assert.match(fn, /pixelsPerPoint\s*=\s*canvas\.width\s*\/\s*contentWidth/);
  assert.match(fn, /printableHeight\s*=\s*doc\.internal\.pageSize\.getHeight\(\)\s*-\s*margin\s*\*\s*2/);
  assert.match(fn, /findCanvasPageBreak/, "pagination should look for a nearby blank row instead of slicing ordinary text blindly");
  assert.match(fn, /doc\.addImage\([\s\S]*?margin,\s*\n\s*margin,\s*\n\s*contentWidth/, "every page image must retain the configured top, left and right margins");
});

test("Bloc's PDF export only reports success after generation actually completes, and surfaces a distinct honest failure message otherwise (issue #128)", async () => {
  const source = await readFeatureSource("bloc");
  const start = source.indexOf("async function exportActivePdf");
  const end = source.indexOf("function exportActiveWord");
  assert.ok(start !== -1 && end !== -1 && end > start, "exportActivePdf should be an async function defined before exportActiveWord");
  const fn = source.slice(start, end);
  assert.match(fn, /await html2canvas\(/, "must await the browser render before declaring success");
  assert.match(fn, /showNotice\("PDF exportado"\)/);
  assert.match(fn, /catch/);
  assert.match(fn, /showNotice\([^)]*"error"\)/, "a failed export must show a distinctly-toned error notice, not silently claim success");
});

test("Exportar sits in the editor's top-right action group next to the overflow menu, and the old footer export selector is gone (issue #128)", async () => {
  const source = await readFeatureSource("bloc");
  assert.match(source, /al-bloc-title-row[\s\S]*?<ExportMenu[\s\S]*?<NoteOverflowMenu/, "Exportar and the overflow menu should be siblings in the title row, in that order");
  assert.doesNotMatch(source, /al-bloc-export-select/, "the redundant desktop footer export <Select> must be removed");
  assert.match(source, /Palabras: \{wordCount\}[\s\S]{0,80}Caracteres: \{charCount\}/, "the footer should stay focused on autosave/document metrics");
});

test("the Bloc sidebar's trash link stays height-bounded and pinned from the tablet breakpoint up, not only at the wide desktop breakpoint (issue #128)", async () => {
  const source = await readFeatureSource("bloc");
  assert.match(source, /md:grid-cols-\[minmax\(0,1fr\)_300px\]/, "the two-column split should start at the same breakpoint the component treats as desktop (md, not xl)");
  assert.match(source, /@media \(min-width: 768px\) \{\s*\n\s*\.al-bloc-desktop-grid \{ height: clamp/, "the sidebar height clamp - which makes the notes list scroll internally and keeps Ver papelera pinned - must apply starting at the tablet breakpoint");
  assert.match(source, /al-bloc-trash-link \{ flex-shrink: 0/);
});

test("Ver papelera stays reachable from Todas, Recientes and Favoritas alike - it is rendered once, outside the per-tab note list, not duplicated per tab (issue #128)", async () => {
  const source = await readFeatureSource("bloc");
  const renderSites = source.match(/className="al-bloc-trash-link/g) ?? [];
  assert.equal(renderSites.length, 1, "the trash link must render exactly once (not duplicated per tab, not gated behind a tab check)");
  assert.doesNotMatch(source, /listTab === "favoritas"[\s\S]{0,400}al-bloc-trash-link/, "the trash link must not be nested inside favorites-only conditional rendering");
});

test("Bloc exposes one Word-like formatting surface per viewport and removes the redundant insert/link/image controls (issue #151)", async () => {
  const source = await readFeatureSource("bloc");
  const toolbarStart = source.indexOf("function BlocEditorToolbar");
  const toolbarEnd = source.indexOf("function MobileNoteCard");
  const toolbar = source.slice(toolbarStart, toolbarEnd);

  assert.match(toolbar, /role="toolbar" aria-label="Formato del documento"/);
  assert.match(toolbar, /aria-label="Estilo de párrafo o título"/);
  assert.match(toolbar, /<optgroup label="Párrafo">[\s\S]*?<optgroup label="Títulos">/);
  assert.match(toolbar, /aria-label="Tipo de letra"/);
  assert.match(source, /Aptos[\s\S]*?Calibri[\s\S]*?Verdana[\s\S]*?Georgia[\s\S]*?Courier New/);
  assert.doesNotMatch(toolbar, /Insertar|Hipervínculo|Enlace|Imagen|onInsert|onLink|onImageClick/);
  assert.match(source, /mobileSheet === "format"/);
  assert.doesNotMatch(source, /mobileSheet === "(?:insert|export|more)"/);
  assert.match(source, /\.al-bloc-toolbar-row \{[^}]*flex-wrap: nowrap/);
  assert.doesNotMatch(source, /\.al-bloc-toolbar-mobile \.al-bloc-toolbar-row \{[^}]*overflow-x: auto/);
});

test("Bloc uses a numeric px font-size control and visibly pressed Word-style B/I/U buttons (issue #151)", async () => {
  const source = await readFeatureSource("bloc");
  const toolbar = source.slice(source.indexOf("function BlocEditorToolbar"), source.indexOf("function MobileNoteCard"));

  assert.match(toolbar, /type="number"[\s\S]*?min="8"[\s\S]*?max="96"[\s\S]*?Tamaño de letra en píxeles/);
  assert.match(toolbar, /formatState\.bold[\s\S]*?>B</);
  assert.match(toolbar, /formatState\.italic[\s\S]*?>I</);
  assert.match(toolbar, /formatState\.underline[\s\S]*?>U</);
  assert.match(toolbar, /aria-pressed=\{active\}/);
  assert.match(source, /font\.style\.fontSize = `\$\{clampEditorFontSize\(fontSize\)\}px`[\s\S]*?font\.removeAttribute\("size"\)/, "browser font-size markers must become inline px styles without replacing the selected DOM node");
});

test("Bloc formatting state is deterministic while browser selection events settle (issue #151 final review)", async () => {
  const source = await readFeatureSource("bloc");

  assert.match(source, /function editorFormatAfterCommand[\s\S]*?case "justifyLeft"[\s\S]*?alignment: "left"[\s\S]*?case "justifyCenter"[\s\S]*?alignment: "center"[\s\S]*?case "justifyRight"[\s\S]*?alignment: "right"[\s\S]*?case "justifyFull"[\s\S]*?alignment: "justify"/);
  assert.match(source, /editorFormatSyncBlockedUntilRef\.current = Date\.now\(\) \+ 150[\s\S]*?document\.execCommand\(command[\s\S]*?setEditorFormat\(\(current\) => editorFormatAfterCommand\(current, command\)\)/, "toolbar state must update from the requested command instead of a racing selectionchange event");
  assert.match(source, /const computedAlignment = window\.getComputedStyle\(blockElement \?\? anchor\)\.textAlign/, "selection refresh must read the active block's real alignment");
  assert.doesNotMatch(source, /font\.replaceWith\(/, "font-size normalization must not invalidate the live selection");
});

test("Bloc formatting works before the first character is typed and keeps that pending format until input (issue #151 follow-up)", async () => {
  const source = await readFeatureSource("bloc");

  assert.match(source, /range\.selectNodeContents\(editor\)[\s\S]*?range\.collapse\(false\)[\s\S]*?selection\.addRange\(range\)/, "an empty editor must receive a real caret before a formatting command runs");
  assert.match(source, /function recordEditorContent\(preserveEmptyFormatting = false\)[\s\S]*?isEmpty && \(preserveEmptyFormatting \|\| emptyEditorFormatPendingRef\.current\)[\s\S]*?emptyEditorFormatPendingRef\.current = true[\s\S]*?return/, "temporary formatting nodes must survive toolbar focus changes until the user types");
  assert.match(source, /function runEditorCommand[\s\S]*?preserveEmptyFormatting[\s\S]*?document\.execCommand\(command[\s\S]*?recordEditorContent\(preserveEmptyFormatting\)/, "inline styles, alignment and lists must preserve empty-editor formatting");
  assert.match(source, /function setParagraphBlock[\s\S]*?recordEditorContent\(preserveEmptyFormatting\)/, "paragraph/title choice must also work before typing");
  assert.match(source, /function setEditorFontSize[\s\S]*?recordEditorContent\(preserveEmptyFormatting\)/, "font size must also work before typing");
});

test("Bloc combines bullets and numbering and keeps text/highlight colors in the main toolbar (issue #151)", async () => {
  const source = await readFeatureSource("bloc");
  const toolbar = source.slice(source.indexOf("function BlocEditorToolbar"), source.indexOf("function MobileNoteCard"));

  assert.match(toolbar, /aria-label="Elegir entre viñetas o numeración"/);
  assert.match(toolbar, /value="unordered">• Viñetas/);
  assert.match(toolbar, /value="ordered">1\. Numeración/);
  assert.match(toolbar, /Color de texto[\s\S]*?Color de resaltado/);
  assert.doesNotMatch(toolbar, /showMore|onToggleMore|al-bloc-toolbar-more/);
});

test("Bloc keeps delete controls visible without hover and compacts the mobile notes/editor workflow (issue #151)", async () => {
  const source = await readFeatureSource("bloc");
  const blocFeature = await readFeatureSource("bloc");
  const mobileStart = source.indexOf("if (isMobile)");
  const desktopStart = source.indexOf('<div className="relative">', mobileStart);
  const mobile = source.slice(mobileStart, desktopStart);

  assert.match(source, /\.al-bloc-note-row-delete \{[^}]*opacity: 1/);
  assert.doesNotMatch(source, /\.group:hover \.al-bloc-note-row-delete/);
  assert.match(mobile, /<MobileNoteCard/);
  assert.match(source, /className="al-bloc-mobile-card-delete[^\"]*"/);
  assert.match(mobile, /al-bloc-mobile-create[\s\S]*?<Plus/);
  assert.ok(mobile.indexOf("<BlocEditorToolbar") < mobile.indexOf("ref={attachEditor}"), "mobile formatting controls must be above the writing surface");
  assert.match(mobile, /al-bloc-mobile-actions[\s\S]*?Formato[\s\S]*?<ExportMenu[\s\S]*?<NoteOverflowMenu/);
  assert.match(source, /aria-label="Formato esencial del documento"[\s\S]*?<MobileFontSizeSelect[\s\S]*?<MobileAlignmentSelect[\s\S]*?<BlocListSelect compact/);
  assert.match(source, /function MobileEditorFormatPanel[\s\S]*?Párrafo o título[\s\S]*?Tamaño de letra[\s\S]*?Alineación[\s\S]*?Listas[\s\S]*?Resaltado/);
  assert.match(mobile, /min-h-\[clamp\(220px,38dvh,420px\)\]/);
  assert.match(mobile, /al-bloc-mobile-status/);
  assert.match(blocFeature, /<FeaturePage[\s\S]*compactHeader/);
  assert.match(blocFeature, /title="Bloc de notas"/);
});

test("Bloc uses the app empty-state pattern and no longer advertises unsupported slash commands (issue #151 final pass)", async () => {
  const source = await readFeatureSource("bloc");

  assert.match(source, /Esta nota está vacía[\s\S]*?Empieza a escribir para guardar tus ideas\./);
  assert.doesNotMatch(source, /presiona '\/' para comandos|al-bloc-content-watermark/);
  assert.match(source, /wordCount === 0 && !editorFocused && <BlocEditorEmptyState \/>/);
});
