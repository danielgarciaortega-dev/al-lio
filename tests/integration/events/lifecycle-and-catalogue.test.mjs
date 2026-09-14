// Migrated mechanically from tests/security-boundaries.test.mjs for issue #274.
// Source-level assertions temporarily protect a Next.js, browser, or database boundary that the plain Node runner cannot execute; replace them when the corresponding integration harness exists.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readFeatureSource } from "../../support/feature-sources.mjs";

import { selectFeaturedHackathon } from "../../../src/lib/fp/event-lifecycle.ts";
import { isSafeHttpUrl } from "../../../src/lib/fp/event-cta.ts";

import { getHackathonPresentation, resolveHackathonById } from "../../../src/features/events/presentation/event-presentation.ts";

const fixtureTechEvent = {
  id: "t1", id_slug: "reto-granada", categoria: "hackathon_reto", nombre: "Reto Granada",
  entidad: "Ayuntamiento", area_o_tipo: null, modalidad: "Presencial", localidad: "Granada",
  provincia: "Granada", fecha_inicio: "2026-09-01", fecha_fin: "2026-09-02", estado: "activo",
  certificacion_o_premio: null, practicas_empresa: null, horas_totales: null, horas_practicas: null,
  coste: null, requisitos_resumen: null, encaje_daw_1_5: null, prioridad: "alta", tags: null,
  fuente_url: "https://example.org/reto", ultima_revision: null, notas: null,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
};

const fixtureTechCourse = { ...fixtureTechEvent, id: "t2", id_slug: "curso-x", categoria: "curso", nombre: "Curso X" };

const fixtureFpEvent = {
  id: "f1", id_slug: "hackathon-fp", type: "hackathon", title: "Hackathon FP",
  entity: "AL-LIO", delivery_mode: "Online", location: "Granada", province: "Granada",
  start_date: "2026-10-01", end_date: "2026-10-02", status: "activo", cost: null,
  certification: null, practices: null, source_url: "https://example.org/fp-hackathon",
  tags: null, suggested_action: "Revisar bases del reto", notes: "Importado 2026-01-01 desde FEED.json, pendiente de revision",
  priority: "Alta", requiredCompetencies: [], is_favorite: true, user_status: null,
  user_completed_at: null, created_at: "2026-01-01T00:00:00.000Z",
};

const fixtureOwnHackathon = {
  id: "real-uuid-1", name: "Mi propio evento", status: "pendiente", priority: "media",
  is_favorite: false, created_at: "2026-01-01T00:00:00.000Z",
};

test("completeHackathon persists Realizado per origin, with rollback, and never copies a catalogue row into hackathons (issue #95)", async () => {
  const storeSource = await readFile(new URL("../../../src/features/events/client/use-event-actions.ts", import.meta.url), "utf8");
  const start = storeSource.indexOf("completeHackathon: async (item) =>");
  const end = storeSource.indexOf("\n  };", start);
  assert.ok(start > -1 && end > start, "could not locate the completeHackathon action body");
  const actionSource = storeSource.slice(start, end);

  // fp_content_items: routed through the same per-user table as course/video
  // completion, never inserted or copied into the hackathons table.
  const fpBranchEnd = actionSource.indexOf("const previous = store.hackathons.find");
  const fpBranch = actionSource.slice(0, fpBranchEnd);
  assert.match(fpBranch, /await markLearningResourceStatusAction\(\{ idSlug: item\.id_slug, status: "completed" \}\)/);
  assert.doesNotMatch(fpBranch, /createEventAction/, "must not copy the catalogue row into the user's hackathons table");
  assert.doesNotMatch(fpBranch, /addHackathon/, "must not go through the add-new-hackathon path either");
  assert.match(fpBranch, /const previous = store\.fpContent\.find/);
  assert.match(fpBranch, /user_status: previous\?\.user_status/);
  assert.match(fpBranch, /user_completed_at: previous\?\.user_completed_at/, "must roll back the optimistic completion to the exact prior state");
  assert.match(fpBranch, /throw error;/);

  // No tech_opportunities persistence branch exists - the UI does not offer
  // Realizado for that source, and this action must not invent one. (A
  // comment documenting why is fine; an actual sourceTable check is not.)
  assert.doesNotMatch(
    actionSource,
    /if \(item\.sourceTable === "tech_opportunities"\)/,
    "must not implement a tech_opportunities persistence branch",
  );

  // Plain, already user-owned hackathon row: awaited update scoped by id,
  // rolled back to the exact previous row on failure.
  const plainBranch = actionSource.slice(fpBranchEnd);
  assert.match(plainBranch, /store\.hackathons\.find\(\(event\) => event\.id === item\.id\)/);
  assert.match(plainBranch, /await completeEventAction\(\{ id: item\.id \}\)/);
  assert.match(plainBranch, /if \(!response\.ok\) throw new Error/);
  assert.match(plainBranch, /event\.id === item\.id \? previous : event/, "must roll back to the exact previous row, not just clear it");
  assert.match(plainBranch, /throw error;/);
});

test("completeHackathon preserves favourites and is scoped to the caller's own session/row, not a client-supplied user (issue #95)", async () => {
  const storeSource = await readFile(new URL("../../../src/features/events/client/use-event-actions.ts", import.meta.url), "utf8");
  const start = storeSource.indexOf("completeHackathon: async (item) =>");
  const end = storeSource.indexOf("\n  };", start);
  const actionSource = storeSource.slice(start, end);
  const fpBranchEnd = actionSource.indexOf("const previous = store.hackathons.find");
  const fpBranch = actionSource.slice(0, fpBranchEnd);
  const plainBranch = actionSource.slice(fpBranchEnd);

  // fp_content_items: only status/completed_at are ever set - is_favorite,
  // notes and reminder_at are untouched, so upsertFpUserContentState's
  // partial-update semantics leave them exactly as they were.
  assert.match(fpBranch, /user_status: "completed", user_completed_at: new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(fpBranch, /is_favorite/, "must not touch is_favorite when marking an event realizado");
  // markResourceStatusAction itself resolves the user from the server
  // session (proven by the issue #94 test above) - completeHackathon never
  // passes or receives a userId itself.
  assert.doesNotMatch(fpBranch, /userId|user_id/i);

  // Plain hackathon row: the update is scoped to this exact row's id, going
  // through updateDb (which resolves the writer from the session and is
  // allowlist-gated - see the issue #92 test above), not a raw/global write.
  assert.match(plainBranch, /completeEventAction\(\{ id: item\.id \}\)/);
});

test("Realizado is not offered for tech_opportunities and is guarded against double submission (issue #95)", async () => {
  const guestAppSource = await readFeatureSource("events");
  const detailStart = guestAppSource.indexOf("export function HackathonDetailView");
  const detailSource = guestAppSource.slice(detailStart, guestAppSource.indexOf("function LinksView", detailStart));
  assert.match(
    detailSource,
    /!archived && item\.sourceTable !== "tech_opportunities" && \(/,
    "Realizado must be hidden for tech_opportunities-sourced items, which have no safe per-user completion table",
  );
  assert.match(detailSource, /if \(pendingComplete\) return;/, "must ignore a second click while completion is already in flight");
  assert.match(detailSource, /disabled=\{pendingComplete\}/);
});

test("The featured event card reads the pure selection helper and follows the same filtered gating as Courses (issue #95, issue #164)", async () => {
  const guestAppSource = await readFeatureSource("events");
  const start = guestAppSource.indexOf("function Hackathons(");
  const source = guestAppSource.slice(start, guestAppSource.indexOf("function HackathonsEmptyState", start));
  assert.match(source, /showFeatured \? selectFeaturedHackathon\(total\) : null/);
  assert.match(source, /const showFeatured = viewTab === "total" && !search && activeFilterCount === 0;/, "featured content only shows on the untouched Total view, matching Courses");
  assert.match(source, /filtered\.filter\(\(item\) => item\.id !== featuredHackathon\.id\)/, "the featured item must not be repeated in the grid");
});

test("The hackathon_favorites migration is additive only - a new column and index, no destructive DDL, and only ever mentions fp_user_content_state in an explanatory comment, never in DDL (issue #131)", async () => {
  const source = await readFile(new URL("../../../infra/postgres/migrations/0007_hackathon_favorites.sql", import.meta.url), "utf8");
  assert.match(source, /alter table public\.hackathons\s*\n\s*add column if not exists is_favorite boolean not null default false/);
  assert.match(source, /create index if not exists hackathons_user_favorite_idx/);
  assert.doesNotMatch(source, /\bdrop\s+(table|schema)|truncate\s+table/i);
  const ddlLines = source.split(/\r?\n/).filter((line) => !line.trim().startsWith("--") && line.trim());
  assert.ok(!ddlLines.some((line) => line.includes("fp_user_content_state")), "fp_user_content_state must only appear in comments explaining it's untouched, never in an actual DDL statement");
});

test("toggleHackathonFavorite is an atomic, user-scoped UPDATE - never touches status/lifecycle columns, and returns null (not a thrown error) for a row the caller doesn't own (issue #131)", async () => {
  const source = await readFile(new URL("../../../src/features/events/server/repository.ts", import.meta.url), "utf8");
  const fnSource = source.slice(source.indexOf("export async function toggleHackathonFavorite"));
  assert.match(fnSource, /UPDATE public\.hackathons[\s\S]*SET is_favorite = NOT is_favorite[\s\S]*WHERE id = \$1 AND user_id = \$2/, "must be a single atomic flip, not a read-then-write, and must filter by user_id");
  assert.doesNotMatch(fnSource, /\bstatus\b/, "toggling the heart must never touch the status/lifecycle column");
  assert.match(fnSource, /rows\[0\]\?\.is_favorite \?\? null/);
});

test("toggleHackathonFavoriteAction is session-gated through the shared current-user boundary (issue #131, #275)", async () => {
  const source = await readFile(new URL("../../../src/features/events/server/actions.ts", import.meta.url), "utf8");
  assert.match(source, /"use server"/);
  assert.match(source, /const userId = await getCurrentUserId\(\);/);
  assert.match(source, /toggleHackathonFavorite\(userId, parsed\.data\)/, "must scope to the authenticated user, never a client-supplied user id");
});

test("The toggleHackathonFavorite store action applies an optimistic flip with rollback and an honest error toast on failure, mirroring toggleCompanyFavorite/toggleFpFavorite - not the unguarded fire-and-forget updateHackathon (issue #131)", async () => {
  const source = await readFile(new URL("../../../src/features/events/client/use-event-actions.ts", import.meta.url), "utf8");
  const start = source.indexOf("toggleHackathonFavorite: (id) =>");
  const end = source.indexOf("completeHackathon: async (item) =>", start);
  assert.ok(start !== -1 && end !== -1 && end > start, "toggleHackathonFavorite must be defined as its own dedicated action, before updateHackathon");
  const fn = source.slice(start, end);
  assert.match(fn, /setStore\(/, "must apply an optimistic update");
  assert.match(fn, /toggleHackathonFavoriteAction\(id\)\.then\(\(result\) => \{/);
  assert.match(fn, /if \(!result\.error\) return;/);
  assert.match(fn, /toast\.error\(/, "a failed save must surface an honest error toast");
  const rollbackAssignments = fn.match(/is_favorite: !nextValue/g) ?? [];
  assert.ok(rollbackAssignments.length >= 1, "the failure branch must flip is_favorite back, not leave the optimistic value stuck");
});

test("EventActions declares toggleHackathonFavorite inside the feature boundary (issue #131, #275)", async () => {
  const source = await readFile(new URL("../../../src/features/events/client/use-event-actions.ts", import.meta.url), "utf8");
  assert.match(source, /toggleHackathonFavorite: \(id: string\) => void;/);
});

test("The heart control appears in the card, the featured hero and the detail view, all driven by the same shared canToggleHackathonFavorite/toggleHackathonFavoriteFor helpers - so no surface can drift out of sync (issue #131, extended by #135)", async () => {
  const source = await readFeatureSource("events");

  assert.match(source, /import \{[^}]*canToggleHackathonFavorite[^}]*toggleHackathonFavoriteFor[^}]*\} from "@\/features\/events\/presentation";/, "the Events feature must import both shared favorite helpers, not keep local copies");

  const heartSites = source.match(/onClick=\{\(\) => toggleHackathonFavoriteFor\(/g) ?? [];
  assert.equal(heartSites.length, 3, "the card, the hero and the detail view must all call the same dispatcher - expected exactly 3 call sites (the requirements modal was retired, folded into the detail view)");

  assert.doesNotMatch(source, /import \{[^}]*\bBookmark\b/, "the retired Bookmark icon import must be gone, not left unused");
  assert.equal((source.match(/<CatalogFavoriteButton/g) ?? []).length, 2, "the card and featured hero use the shared favorite control");
  assert.match(source, /<Heart className=/, "the detail view keeps the same heart icon");
});

test("Saving copy is consistent everywhere - Guardar / Quitar de guardados - and the old ambiguous \"Guardar para despues\" wording from the retired requirements modal is gone (issue #131)", async () => {
  const [source, cardSource] = await Promise.all([
    readFeatureSource("events"),
    readFile(new URL("../../../src/components/catalog/catalog-card.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(source, /Guardar para despu[eé]s/, "the retired requirements modal's old inconsistent copy must not survive anywhere in the file");
  assert.match(cardSource, /active \? "Quitar de guardados" : "Guardar"/, "the shared card/featured heart keeps the canonical accessible labels");
  assert.match(source, /item\.is_favorite \? "Guardado en favoritos" : "Guardar en favoritos"/, "the detail action uses the same saved/unsaved meaning");
});

test("tech_opportunities-sourced events are excluded from saving with a documented reason, not silently broken or given a non-functional heart (issue #131, relocated to hackathon-presentation.ts by issue #135)", async () => {
  const source = await readFile(new URL("../../../src/features/events/presentation/event-presentation.ts", import.meta.url), "utf8");
  const fnStart = source.indexOf("export function canToggleHackathonFavorite");
  const fnSource = source.slice(fnStart, source.indexOf("export function toggleHackathonFavoriteFor"));
  assert.match(fnSource, /sourceTable === "tech_opportunities"\) return false/);
  const precedingComment = source.slice(Math.max(0, fnStart - 700), fnStart);
  assert.match(precedingComment, /deliberately excluded/i, "the exclusion must be explained, not just present with no rationale");

  const guestAppSource = await readFeatureSource("events");
  assert.doesNotMatch(guestAppSource, /function canToggleHackathonFavorite/, "the Events feature must not keep a second, potentially-drifting local copy");
});

test("Guardados is a real heart-driven filter tab, independent of and additional to Total/Inscripción abierta/Próx. inicio - not just the heart control on its own (issue #131)", async () => {
  const source = await readFeatureSource("events");
  const hackathonsFnStart = source.indexOf("function Hackathons(");
  const hackathonsFnEnd = source.indexOf("function HackathonsEmptyState");
  const fnSource = source.slice(hackathonsFnStart, hackathonsFnEnd);

  assert.match(fnSource, /useState<"total" \| "abiertos" \| "proximos" \| "guardados">/);
  assert.match(fnSource, /const guardados = useMemo\(\(\) => sorted\.filter\(\(h\) => h\.is_favorite\), \[sorted\]\);/);
  assert.match(fnSource, /viewTab === "guardados" \? guardados/);
  assert.match(fnSource, /\{ id: "guardados", label: "Guardados", count: guardados\.length \}/, "the tab must be a real filter tab with a live count, matching the issue's explicit ask");
});

test("Toggling the heart is wired through a distinct action from completion/status changes - completeHackathon and the Realizado button never touch is_favorite (issue #131)", async () => {
  const source = await readFile(new URL("../../../src/features/events/client/use-event-actions.ts", import.meta.url), "utf8");
  const completeFnStart = source.indexOf("completeHackathon: async (item)");
  const completeFnEnd = source.indexOf("\n  };", completeFnStart);
  assert.ok(completeFnStart !== -1 && completeFnEnd > completeFnStart);
  const completeFn = source.slice(completeFnStart, completeFnEnd);
  assert.doesNotMatch(completeFn, /is_favorite/, "completing/archiving an event must never read or write is_favorite - the two concepts stay independent");
});

test("Every hackathon card and the featured hero link unconditionally to the internal /hackathons/[id] detail route - not gated by requiredCompetencies like the old 'Ver detalles' button was (issue #135)", async () => {
  const [source, cardSource] = await Promise.all([
    readFeatureSource("events"),
    readFile(new URL("../../../src/components/catalog/catalog-card.tsx", import.meta.url), "utf8"),
  ]);
  const hackathonsFnStart = source.indexOf("function Hackathons(");
  const hackathonsFnEnd = source.indexOf("function HackathonsEmptyState");
  const fnSource = source.slice(hackathonsFnStart, hackathonsFnEnd);

  assert.match(fnSource, /detailHref=\{`\/hackathons\/\$\{encodeURIComponent\(item\.id\)\}`\}/, "the card must always pass its own internal detail URL");
  assert.match(fnSource, /detailHref=\{`\/hackathons\/\$\{encodeURIComponent\(featuredHackathon\.id\)\}`\}/, "the featured card must always pass the same internal detail URL");
  assert.match(cardSource, /<Link href=\{href\}/, "the shared component must render the passed URL as a real Link");
  const detailHrefStart = fnSource.indexOf('detailHref={`/hackathons/${encodeURIComponent(item.id)}`}');
  assert.doesNotMatch(fnSource.slice(Math.max(0, detailHrefStart - 180), detailHrefStart), /requiredCompetencies/, "the detail URL must not be gated by requirements");
});

test("The shared card and featured surfaces expose one expansion affordance each, without a second requirements action (owner-reported follow-up to #135, issue #164)", async () => {
  const [source, cardSource] = await Promise.all([
    readFeatureSource("events"),
    readFile(new URL("../../../src/components/catalog/catalog-card.tsx", import.meta.url), "utf8"),
  ]);
  const hackathonsFnStart = source.indexOf("function Hackathons(");
  const hackathonsFnEnd = source.indexOf("function HackathonsEmptyState");
  const fnSource = source.slice(hackathonsFnStart, hackathonsFnEnd);

  assert.doesNotMatch(fnSource, /Ver requisitos/, "the card's old separate requirements-modal button must be gone - requirements now live inline on the Ver detalles page");
  assert.doesNotMatch(fnSource, /Aptitudes mínimas/, "the hero's old separate requirements-modal button must be gone for the same reason");
  assert.doesNotMatch(fnSource, /setRequirementsItemId/, "no state should exist to open a requirements modal that no longer exists");

  assert.equal((cardSource.match(/<CatalogDetailLink href=\{detailHref\}/g) ?? []).length, 2, "CatalogCard and CatalogFeaturedCard each render exactly one shared detail action");
  assert.equal((cardSource.match(/Ver detalles\s*<\/Link>/g) ?? []).length, 1, "the shared action owns one canonical label");
});

test("HackathonDetailPage resolves the item via the already user/cycle-scoped global store and calls notFound() instead of querying by a client-supplied id (issue #135)", async () => {
  const source = await readFile(new URL("../../../src/app/(dashboard)/hackathons/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(source, /const store = \(await getGlobalStore\(\)\) as unknown as Store;/, "must reuse the session-authenticated, cache()-deduped global store - never a second, independently-authorized query");
  assert.match(source, /resolveHackathonById\(id, store\.hackathons, store\.techOpportunities, store\.fpContent\)/);
  assert.match(source, /if \(!item\) notFound\(\);/, "an id outside this user's authorized catalogue must 404, not render an empty/broken page");
});

test("HackathonDetailView shows an honest not-found state with a way back when the id doesn't resolve (issue #135)", async () => {
  const source = await readFeatureSource("events");
  const fnStart = source.indexOf("export function HackathonDetailView");
  const fnEnd = source.indexOf("function LinksView");
  const fnSource = source.slice(fnStart, fnEnd);

  assert.match(fnSource, /if \(!item\) \{/);
  assert.match(fnSource, /Ya no podemos mostrar este evento/);
  assert.match(fnSource, /<Link href="\/hackathons" className="al-hack-empty-btn">Volver a Eventos y retos<\/Link>/);
});

test("The requirements step-by-step modal was retired (owner-reported follow-up to #135) - HackathonRequirementsModal no longer exists, and requirements render inline via RequirementRow instead", async () => {
  const source = await readFeatureSource("events");
  assert.doesNotMatch(source, /function HackathonRequirementsModal/, "the modal must be removed entirely, not just left unreachable");
  assert.doesNotMatch(source, /requirementsItemId|requirementsOpen/, "no state should remain for opening a modal that no longer exists");
  assert.match(source, /function RequirementRow\(\{ competency, actions \}: \{ competency: RequiredCompetency; actions: EventsActions \}\)/);

  const viewFnStart = source.indexOf("export function HackathonDetailView");
  const viewFnEnd = source.indexOf("function LinksView");
  const viewFnSource = source.slice(viewFnStart, viewFnEnd);
  assert.match(viewFnSource, /\{requirements\.map\(\(competency\) => \(\s*<RequirementRow key=\{competency\.id\} competency=\{competency\} actions=\{actions\} \/>/, "every requirement must render inline on the page");
  assert.match(viewFnSource, /<CatalogPanel title="Recursos para prepararte">/, "the shared detail panel must hold the inline requirements");
});

test("The inline requirements section never constructs a /ruta/ URL - replaces the equivalent guard that used to cover the retired modal (issue #112, owner-reported follow-up to #135)", async () => {
  const source = await readFeatureSource("events");
  const fnStart = source.indexOf("function RequirementRow(");
  const fnEnd = source.indexOf("export function HackathonDetailView");
  const fnSource = source.slice(fnStart, fnEnd);
  assert.doesNotMatch(fnSource, /\/ruta\//, "RequirementRow must never construct a /ruta/ URL");
  assert.doesNotMatch(fnSource, /rutaHref|Ver en tu ruta/, "the old event-level ruta CTA concept must not resurface here");
});

test("HackathonDetailView never renders item.notes directly and uses the canonical presentation description (issue #135, issue #200)", async () => {
  const source = await readFeatureSource("events");
  const fnStart = source.indexOf("export function HackathonDetailView");
  const fnEnd = source.indexOf("function LinksView");
  const fnSource = source.slice(fnStart, fnEnd);
  assert.match(fnSource, /const presentation = getHackathonPresentation\(item\);/);
  assert.match(fnSource, /\{presentation\.description && <CatalogPanel title="Sobre el evento o reto">/);
  assert.doesNotMatch(fnSource, /\{item\.notes\}/, "notes must never be interpolated directly into the page");
});

test("Each inline requirement consumes the bounded canonical resource query and keeps an honest coverage gap (issues #135 and #202)", async () => {
  const source = await readFeatureSource("events");
  const fnStart = source.indexOf("function RequirementRow(");
  const fnEnd = source.indexOf("export function HackathonDetailView");
  const fnSource = source.slice(fnStart, fnEnd);

  assert.match(fnSource, /const resources = competency\.preparationResources \?\? \[\]/);
  assert.match(fnSource, /resources\.map\(\(resource\) =>/);
  assert.match(fnSource, /resources\.length === 0/);
  assert.match(fnSource, /La carencia queda registrada para buscar una opción fiable/);
  assert.doesNotMatch(fnSource, /learningItems|referenceTitles|video_url/, "the canonical UI must not fall back to legacy candidates");
});

test("The detail view's official source link is gated by isSafeHttpUrl, same as the card and hero (issue #135)", async () => {
  const source = await readFeatureSource("events");
  const fnStart = source.indexOf("export function HackathonDetailView");
  const fnEnd = source.indexOf("function LinksView");
  const fnSource = source.slice(fnStart, fnEnd);
  assert.match(fnSource, /\{isSafeHttpUrl\(presentation\.sourceUrl\) && \(/);
  assert.match(fnSource, /rel="noopener noreferrer"/);
});

test("The detail view heart control reuses the exact shared canToggleHackathonFavorite/toggleHackathonFavoriteFor helpers - card, hero and detail can never drift out of sync on saved state (issue #135)", async () => {
  const source = await readFeatureSource("events");
  const heartSites = source.match(/onClick=\{\(\) => toggleHackathonFavoriteFor\(/g) ?? [];
  assert.equal(heartSites.length, 3, "card, hero and the detail view must all call the same dispatcher - expected exactly 3 call sites");
  assert.match(source, /from "@\/features\/events\/presentation"/, "the Events feature must import the shared helpers rather than keep a second local copy that could drift");
});

test("An event past its actionable date shows an honest 'ya ha finalizado' notice on the detail view instead of presenting stale registration as still open (issue #135)", async () => {
  const source = await readFeatureSource("events");
  const fnStart = source.indexOf("export function HackathonDetailView");
  const fnEnd = source.indexOf("function LinksView");
  const fnSource = source.slice(fnStart, fnEnd);
  assert.match(fnSource, /const past = isHackathonPast\(item\);/);
  assert.match(fnSource, /\{past && <p[^>]*>Este evento ya ha finalizado\.<\/p>\}/);
});

test("Eventos y retos merges its stats and status tabs into the same one-row control as Cursos (Total / Inscripción abierta / Próx. inicio / Guardados); 'Realizado' moves to the Estado filter and no 'Archivados' label survives", async () => {
  const source = await readFeatureSource("events");
  const hackathonsFnStart = source.indexOf("function Hackathons(");
  const hackathonsFnEnd = source.indexOf("function HackathonsEmptyState");
  const fnSource = source.slice(hackathonsFnStart, hackathonsFnEnd);

  assert.match(fnSource, /useState<"total" \| "abiertos" \| "proximos" \| "guardados">/);
  assert.match(fnSource, /\{ id: "total", label: "Total", count: total\.length \}/);
  assert.match(fnSource, /\{ id: "abiertos", label: "Inscripción abierta", count: abiertos\.length \}/);
  assert.match(fnSource, /\{ id: "proximos", label: "Próx\. inicio", count: proximos\.length \}/);
  assert.match(fnSource, /\{ id: "guardados", label: "Guardados", count: guardados\.length \}/);
  assert.doesNotMatch(fnSource, /label: "Realizado"/, "Realizado is no longer a tab");
  assert.doesNotMatch(fnSource, /label: "Archivados"/);
  assert.match(fnSource, /\["realizado", "Realizado"\]/, "finished events must stay filterable via the Estado control");
  assert.match(fnSource, /const abiertos = useMemo\(\(\) => total\.filter/);
});
