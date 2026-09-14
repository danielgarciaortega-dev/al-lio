// Migrated mechanically from tests/security-boundaries.test.mjs for issue #274.
// Source-level assertions temporarily protect a Next.js, browser, or database boundary that the plain Node runner cannot execute; replace them when the corresponding integration harness exists.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readFeatureSource } from "../../support/feature-sources.mjs";

import { isSafeHttpUrl, selectAptitudeVideos } from "../../../src/lib/fp/event-cta.ts";

import { fpItemToCourse } from "../../../src/features/courses/presentation/course-presentation.ts";

const fixtureFpCourseItem = {
  id: "f2",
  id_slug: "curso-fp-react",
  type: "curso_basico",
  title: "React desde cero",
  entity: "AL-LIO",
  source_url: "https://example.org/fp-react",
  notes: "Import provenance that must never become public copy",
  is_favorite: true,
};

test("learning saves do not invalidate or recreate the active video route", async () => {
  const [actionsSource, playerHookSource] = await Promise.all([
    readFile(new URL("../../../src/features/learning/server/player-actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../src/components/ruta/use-youtube-player.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(actionsSource, /revalidatePath\(`\/aprende\//);
  assert.doesNotMatch(
    playerHookSource,
    /\[youtubeRef\?\.type,\s*youtubeRef\?\.id,\s*initialTimeSeconds/,
  );
});

test("learning notes are saved atomically and mirrored to Bloc", async () => {
  const [actionsSource, repositorySource] = await Promise.all([
    readFile(new URL("../../../src/features/learning/server/player-actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../src/features/learning/server/repository.ts", import.meta.url), "utf8"),
  ]);

  assert.match(actionsSource, /addLearningNoteToBloc/);
  assert.match(repositorySource, /withTransaction/);
  assert.match(repositorySource, /INSERT INTO public\.fp_learning_notes/);
  assert.match(repositorySource, /INSERT INTO public\.bloc_notes/);
  assert.match(repositorySource, /ON CONFLICT \(user_id, source_type, source_id\)/);
});

test("Competency completion is authorized against the caller's session and cycle, never a client-supplied user (issue #96)", async () => {
  const actionsSource = await readFile(new URL("../../../src/features/learning/server/actions.ts", import.meta.url), "utf8");
  const fnSource = actionsSource.slice(actionsSource.indexOf("export async function markLearningCompetencyCompletedAction"));

  assert.match(fnSource, /const userId = await getCurrentUserId\(\);/);
  assert.match(fnSource, /getCycleSkillById\(profile\.cycle_code, parsed\.data\.skillId\)/, "must resolve the skill scoped to the current session's user/cycle");
  assert.match(fnSource, /markUserCompetencyCompleted\(userId, parsed\.data\.skillId\)/, "must write scoped to the authenticated user, not a caller-supplied id");

  const guestAppSource = await readFeatureSource("events", "courses");
  assert.match(guestAppSource, /return !!competency\.completed;/, "isCompetencyDone must read the explicit per-user competency record, not infer from resource status");
});

test("A competency with no linked learning item can still be marked complete (issue #96)", async () => {
  const guestAppSource = await readFeatureSource("events", "courses");
  const componentStart = guestAppSource.indexOf("function RequirementRow(");
  const componentEnd = guestAppSource.indexOf("export function HackathonDetailView", componentStart);
  assert.ok(componentStart > -1 && componentEnd > componentStart, "could not locate the RequirementRow component");
  const componentSource = guestAppSource.slice(componentStart, componentEnd);

  assert.match(componentSource, /actions\.markCompetencyCompleted\(competency\.id\)/, "marking done must write an explicit competency record, not loop over learningItems");
  assert.doesNotMatch(componentSource, /for \(const learningItem of competency\.learningItems\)/, "must not infer completion from marking every linked resource done");
  assert.doesNotMatch(componentSource, /competency\.learningItems\.length > 0 &&/, "the mark-done control must not be gated behind having at least one linked resource");
});

test("markCompetencyCompleted optimistically completes and rolls back on failure (issue #96)", async () => {
  // Normalise CRLF to LF so the block-boundary locator below is newline-agnostic
  // on a Windows checkout (core.autocrlf) as well as on CI (issue #307).
  const storeSource = (
    await readFile(new URL("../../../src/features/learning/client/use-learning-actions.ts", import.meta.url), "utf8")
  ).replace(/\r\n/g, "\n");
  const start = storeSource.indexOf("markCompetencyCompleted: (skillId) =>");
  const end = storeSource.indexOf("\n    },\n  };", start);
  assert.ok(start > -1 && end > start, "could not locate the markCompetencyCompleted action body");
  const actionSource = storeSource.slice(start, end);

  assert.match(actionSource, /setStore\(\(current\) => \(\{ \.\.\.current, fpContent: patchCompetencies\(current\.fpContent, true\) \}\)\);/, "must optimistically mark the competency completed before the request resolves");
  assert.match(actionSource, /void markLearningCompetencyCompletedAction\(\{ skillId \}\)\.then\(\(result\) => \{/);
  assert.match(actionSource, /if \(!result\.error\) return;/);
  assert.match(actionSource, /patchCompetencies\(current\.fpContent, false\)/, "must roll back to not-completed on failure");
  assert.match(actionSource, /toast\.error\("No se pudo guardar"\);/);
});

test("the Eventos redirect resolver never depends on fp_user_competency_state - Events aptitude checklist and resource-watching progress are separate systems by design (issue #96, issue #112)", async () => {
  // issue #112 removed the internal /ruta "path" screen for Eventos
  // (ruta-path.ts / ruta-path-view.tsx, which this guard used to read) and
  // replaced it with a redirect resolved by event-cta.ts + ruta/[slug]/page.tsx.
  // The isolation invariant is the same as before: neither must ever read
  // Events aptitude completion state.
  const [eventCtaSource, rutaPageSource] = await Promise.all([
    readFile(new URL("../../../src/lib/fp/event-cta.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../src/app/(dashboard)/ruta/[slug]/page.tsx", import.meta.url), "utf8"),
  ]);

  for (const source of [eventCtaSource, rutaPageSource]) {
    assert.doesNotMatch(source, /competencyCompleted/, "must not read or expose Events aptitude completion");
    assert.doesNotMatch(source, /fp_user_competency_state/, "must not reference the Events aptitude table");
    assert.doesNotMatch(source, /getUserCompetencyStatesForSkills/, "must not call the Events aptitude repository function");
  }
});

test("A competency never renders legacy free-text references as preparation resources (issue #96, issue #202)", async () => {
  const guestAppSource = await readFeatureSource("events", "courses");
  const componentStart = guestAppSource.indexOf("function RequirementRow(");
  const componentEnd = guestAppSource.indexOf("export function HackathonDetailView", componentStart);
  assert.ok(componentStart > -1 && componentEnd > componentStart, "could not locate the RequirementRow component");
  const componentSource = guestAppSource.slice(componentStart, componentEnd);

  assert.match(componentSource, /competency\.preparationResources \?\? \[\]/);
  assert.doesNotMatch(componentSource, /referenceTitles|learningItem\.source_url|target="_blank"/);
});

test("getActiveVideoResourcesForCompetency queries only active, cycle-matching, ensena resources with a video - and never touches the Roadmap-shared query (issue #112)", async () => {
  const source = await readFile(new URL("../../../src/features/learning/server/catalogue-repository.ts", import.meta.url), "utf8");
  const fnStart = source.indexOf("export async function getActiveVideoResourcesForCompetency");
  assert.ok(fnStart > -1, "could not locate getActiveVideoResourcesForCompetency");
  const fnSource = source.slice(fnStart, source.indexOf("\nexport async function getUserContentState", fnStart));

  assert.match(fnSource, /tipo_relacion = 'ensena'/);
  assert.match(fnSource, /fit\.cycle_code = \$2/);
  assert.match(fnSource, /item\.status = 'activo'/, "must require the resource to be active - a redirect must never target an inactive one");
  assert.match(fnSource, /item\.video_url IS NOT NULL/);

  // getLearningItemsForCompetencies (shared with data.ts/the aptitude modal
  // and, transitively, Roadmap's data loading) must be completely untouched.
  const sharedFnStart = source.indexOf("export async function getLearningItemsForCompetencies");
  const sharedFnSource = source.slice(sharedFnStart, source.indexOf("\nexport type ActiveCompetencyVideoCandidate", sharedFnStart));
  assert.ok(sharedFnSource.includes("ORDER BY link.skill_id`"), "boundary slice must end before the new dedicated function, not swallow it");
  assert.doesNotMatch(sharedFnSource, /status = 'activo'/, "the shared query's behavior must not change as a side effect of this issue");
});

test("ruta/[slug] is a pure redirect endpoint for every content type - it never renders a page any more (issue #112)", async () => {
  const source = await readFile(new URL("../../../src/app/(dashboard)/ruta/[slug]/page.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /buildRutaPathSteps|LearningPathView|LearningResourceView/, "no rendering path may survive - this route only redirects");
  assert.doesNotMatch(source, /return \(/, "must never return JSX");

  // Eventos branch: the requested competency must genuinely belong to the
  // event and an exact video may resolve only to AL-LIO's internal player.
  assert.match(source, /if \(FP_APTITUDE_GATED_TYPES\.has\(item\.type\)\) \{/);
  assert.match(
    source,
    /\(requiredByItem\.get\(item\.id\) \?\? \[\]\)\.find\(\(c\) => c\.id === paso\)/,
    "a paso for a competency outside this event must never resolve to a video",
  );
  assert.match(source, /getActiveVideoResourcesForCompetency\(/, "must use the dedicated active-resource query, not the Roadmap-shared one");
  assert.match(source, /getInternalLearningTargetsForVideoUrls\(exactVideoCandidates, profile\.cycle_code\)/);
  assert.match(source, /redirect\(`\/aprende\/\$\{encodeURIComponent\(internalSlugs\[0\]\)\}`\)/);
  assert.match(source, /redirect\("\/hackathons"\)/);

  // Non-Eventos content follows the same internal-only rule. A missing exact
  // match returns to Competencias instead of opening YouTube.
  assert.match(source, /getInternalLearningTargetsForVideoUrls\(\[item\.video_url\], profile\.cycle_code\)/);
  assert.match(source, /redirect\("\/roadmap"\)/);
  assert.doesNotMatch(source, /redirect\(item\.video_url\)|itemSourceUrl|resolveLegacyRutaTarget/);
});

test("legacy video URLs are matched only to active Spanish courses from the user's cycle", async () => {
  const source = await readFile(new URL("../../../src/features/learning/server/repository.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function getInternalLearningTargetsForVideoUrls");
  const end = source.indexOf("\nexport async function getLearningNotes", start);
  assert.ok(start > -1 && end > start, "could not locate the internal learning target query");
  const fnSource = source.slice(start, end);
  assert.match(fnSource, /competency\.cycle_code=\$1/);
  assert.match(fnSource, /competency\.is_active=true/);
  assert.match(fnSource, /resource\.is_active=true/);
  assert.match(fnSource, /resource\.language='es'/);
  assert.match(fnSource, /resource\.youtube_url=ANY\(\$2\)/);
});

test("/roadmap/[modulo] never depended on, and still does not depend on, the retired ruta-path/ruta-path-view modules (issue #112)", async () => {
  const [pageSource, viewSource] = await Promise.all([
    readFile(new URL("../../../src/app/(dashboard)/roadmap/[modulo]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../src/features/learning/client/competency-courses-view.tsx", import.meta.url), "utf8"),
  ]);
  for (const source of [pageSource, viewSource]) {
    assert.doesNotMatch(source, /ruta-path/, "must not depend on the removed Eventos ruta-path module");
    assert.doesNotMatch(source, /buildRutaPathSteps/, "must not depend on the removed Eventos step builder");
  }
});

test("event catalogue cards keep the official URL in the validated detail action and never restore the retired /ruta screen (issue #112, issue #164)", async () => {
  const source = await readFeatureSource("courses", "events");

  assert.doesNotMatch(source, /\/ruta\//, "no CTA anywhere in this file may construct a /ruta/ URL any more");
  const hackathonsStart = source.indexOf("function Hackathons(");
  const listSource = source.slice(hackathonsStart, source.indexOf("function HackathonsEmptyState", hackathonsStart));
  assert.doesNotMatch(listSource, /href=\{item\.url\}|href=\{featuredHackathon\.url\}/, "catalogue cards must keep one internal action; the official URL belongs in detail");

  const detailStart = source.indexOf("export function HackathonDetailView");
  const detailSource = source.slice(detailStart, source.indexOf("function LinksView", detailStart));
  assert.match(
    detailSource,
    /\{isSafeHttpUrl\(presentation\.sourceUrl\) && \(\s*<a href=\{presentation\.sourceUrl\} target="_blank" rel="noopener noreferrer" className="al-catalog-action al-catalog-action-solid">/,
    "the official event URL must remain guarded by the shared HTTP(S) validator",
  );
  assert.match(detailSource, /Abrir convocatoria oficial/);
  // The old video-gated internal/external dichotomy, and the first
  // iteration's ad-hoc "Entrar al hackatón" label, are both gone.
  assert.doesNotMatch(source, /featuredHasRuta/);
  assert.doesNotMatch(source, /hackathonHasRutaVideo/);
  assert.doesNotMatch(source, /Entrar al hackat[oó]n/);
});

test("each aptitude renders only canonical approved preparation resources and explicit gaps", async () => {
  const guestAppSource = await readFeatureSource("events", "courses");
  const componentStart = guestAppSource.indexOf("function RequirementRow(");
  const componentEnd = guestAppSource.indexOf("export function HackathonDetailView", componentStart);
  assert.ok(componentStart > -1 && componentEnd > componentStart, "could not locate the RequirementRow component");
  const componentSource = guestAppSource.slice(componentStart, componentEnd);

  assert.match(componentSource, /const resources = competency\.preparationResources \?\? \[\]/);
  assert.doesNotMatch(componentSource, /selectAptitudeVideos|competency\.learningItems/, "legacy free-text/video joins must not feed the preparation UI");
  assert.match(
    componentSource,
    /<Link href=\{resource\.deep_link\}/,
    "the aptitude CTA must use the exact approved deep link",
  );
  assert.doesNotMatch(componentSource, /href=\{resource\.canonical_url\}|target="_blank"/);
  assert.match(componentSource, /resource\.mapping_rationale/);
  assert.match(componentSource, /Verificado \{formatDateLabel\(resource\.source_verified_at\)\}/);
  assert.match(componentSource, /Aún no hay un recurso verificado para esta aptitud\./);
  assert.match(componentSource, /no mostraremos un enlace genérico\./);
});

test("preparation resources require canonical approval and join progress only for the authenticated user", async () => {
  const source = await readFile(new URL("../../../src/features/learning/server/catalogue-repository.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function getPreparationResourcesForCompetencies");
  const end = source.indexOf("\n// Return only resources", start);
  assert.ok(start > -1 && end > start, "could not locate canonical preparation-resource query");
  const querySource = source.slice(start, end);
  assert.match(querySource, /state\.user_id = \$1/);
  assert.match(querySource, /mapping\.cycle_code = \$3/);
  assert.match(querySource, /mapping\.publication_state = 'approved'/);
  assert.match(querySource, /resource\.publication_state = 'approved'/);
  assert.match(querySource, /resource\.availability_state = 'available'/);
  assert.match(querySource, /resource\.deep_link IS NOT NULL/);
  assert.doesNotMatch(querySource, /fp_content_items|video_url/, "legacy candidate links must not leak into the canonical query");
});

test("manual competency and resource completion stay distinct from observed player completion", async () => {
  const [catalogSource, learningSource, actionsSource, playerSource] = await Promise.all([
    readFile(new URL("../../../src/features/learning/server/catalogue-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../src/features/learning/server/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../src/features/learning/server/player-actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../src/features/learning/client/learning-player.tsx", import.meta.url), "utf8"),
  ]);
  const completionStart = catalogSource.indexOf("export async function markUserCompetencyCompleted");
  const completionSource = catalogSource.slice(completionStart);
  assert.match(completionSource, /VALUES \(\$1, \$2, 'self_declared', null\)/);
  assert.match(actionsSource, /completionMethod: "observed" \| "self_declared" \| null/);
  assert.match(playerSource, /"completed", "observed"/);
  assert.match(playerSource, /"completed", "self_declared"/);
  assert.match(learningSource, /then excluded\.completion_method/);
  assert.match(learningSource, /last_observed_at/);
  assert.doesNotMatch(learningSource, /status='completed'.*Abrir/s);
});

test("the learning player authorizes canonical skill mappings without reopening legacy candidates", async () => {
  const source = await readFile(new URL("../../../src/features/learning/server/repository.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function getLearningResourceForCycle");
  const end = source.indexOf("export async function getInternalLearningTargetsForVideoUrls", start);
  const querySource = source.slice(start, end);
  assert.match(querySource, /fp_skill_learning_resources/);
  assert.match(querySource, /mapping\.cycle_code=\$3/);
  assert.match(querySource, /mapping\.publication_state='approved'/);
  assert.match(querySource, /resource\.publication_state='approved'/);
  assert.match(querySource, /resource\.availability_state='available'/);
});

test("the learning Radar receiver is independently disabled and accepts no public user state", async () => {
  const [routeSource, contractSource] = await Promise.all([
    readFile(new URL("../../../src/app/api/radar/v1/learning/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../src/lib/radar/learning-contract.ts", import.meta.url), "utf8"),
  ]);
  assert.match(routeSource, /AL_LIO_RADAR_LEARNING_INGEST_ENABLED/);
  assert.match(routeSource, /verifyRadarWebhook\(request, rawBody/);
  assert.match(routeSource, /RadarLearningDeliveryConflictError/);
  assert.doesNotMatch(contractSource, /userId|user_id|watchProgress|completedAt/);
  assert.match(contractSource, /canonicalUrl must identify the exact externalId/);
});

test("the learning player embeds YouTube without offering an external YouTube exit", async () => {
  const source = await readFile(new URL("../../../src/features/learning/client/learning-player.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Abrir en YouTube|target="_blank"|href=\{resource\.youtube_url\}/);
  assert.match(source, /ref=\{playerContainerRef\}/, "the internal embedded player must remain available");
});

test("the notes/status Server Actions no longer revalidate the retired ruta screen, but keep every revalidation that still renders content (issue #112)", async () => {
  const source = await readFile(new URL("../../../src/features/learning/server/actions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /revalidatePath\(`\/ruta\/\$\{idSlug\}`\)/, "/ruta/[slug] never renders content any more, so revalidating it is meaningless");
  assert.match(source, /revalidatePath\("\/roadmap"\)/);
  assert.doesNotMatch(source, /revalidatePath\("\/dashboard"\)/, "background mutations must not refresh the whole dashboard layout");
  assert.match(source, /revalidatePath\("\/courses"\)/);
  assert.match(source, /revalidatePath\("\/hackathons"\)/);
});

test("FP course details expose only reviewed taught/demonstrated aptitudes, keeping them separate from event requirements", async () => {
  const repository = await readFile(new URL("../../../src/features/learning/server/catalogue-repository.ts", import.meta.url), "utf8");
  const queryStart = repository.indexOf("export async function getCourseAptitudesForItems");
  const queryEnd = repository.indexOf("export type CompetencyLearningItem", queryStart);
  const querySource = repository.slice(queryStart, queryEnd);
  assert.match(querySource, /link\.tipo_relacion IN \('ensena', 'demuestra'\)/);
  assert.doesNotMatch(querySource, /tipo_relacion = 'requiere'/, "course outcomes must not be mislabeled as entry requirements");

  const aptitude = {
    id: "PRO-001",
    titulo: "Programar con variables, decisiones y bucles",
    descripcion: "Resuelve problemas básicos con código.",
    horas_estimadas: 8,
    evidencia_minima: "Ejercicio funcional",
    relation: "ensena",
    completed: true,
  };
  const mapped = fpItemToCourse({ ...fixtureFpCourseItem, courseAptitudes: [aptitude] });
  assert.deepEqual(mapped.aptitudes, [aptitude], "the authoritative catalogue mapping must survive the FP-to-course presentation conversion");
});

test("the global store loads course aptitudes and shares live completion state with event requirements", async () => {
  const dataSource = await readFile(new URL("../../../src/lib/data.ts", import.meta.url), "utf8");
  assert.match(dataSource, /getCourseAptitudesForItems\(courseAptitudeItemIds\)/);
  assert.match(dataSource, /const visibleCompetencyIds = \[\.\.\.new Set\(\[\.\.\.requiredCompetencyIds, \.\.\.courseAptitudeIds\]\)\]/);
  assert.match(dataSource, /courseAptitudes: \(courseAptitudesByItem\.get\(item\.id\) \?\? \[\]\)\.map/);
  assert.match(dataSource, /completed: userCompetencyStates\.has\(aptitude\.id\)/);

  const storeSource = await readFile(new URL("../../../src/features/learning/client/use-learning-actions.ts", import.meta.url), "utf8");
  assert.match(storeSource, /courseAptitudes: item\.courseAptitudes\?\.map/);
  assert.match(storeSource, /aptitude\.id === skillId \? \{ \.\.\.aptitude, completed \} : aptitude/);
});

test("CourseDetailView combines only canonical learning outcomes and reviewed aptitudes, omitting the section when neither exists (issue #160, issue #200)", async () => {
  const source = await readFeatureSource("courses", "events");
  const fnStart = source.indexOf("export function CourseDetailView");
  const fnEnd = source.indexOf("function Hackathons(");
  const fnSource = source.slice(fnStart, fnEnd);
  assert.match(fnSource, /const aptitudes = item\.aptitudes \?\? \[\];/);
  // "Qué aprenderás" is derived only from canonical facts and reviewed
  // taught aptitudes, never invented copy.
  assert.match(fnSource, /\.\.\.presentation\.learningOutcomes/);
  assert.match(fnSource, /aptitudes\.filter\(\(a\) => a\.relation === "ensena"\)/);
  assert.match(fnSource, /Qué aprenderás/);
  // "Estructura del curso" lists the same aptitudes as ordered steps.
  assert.match(fnSource, /Estructura del curso/);
  assert.match(fnSource, /aptitudes\.map\(\(a, i\) =>/);
  assert.doesNotMatch(fnSource, /Los objetivos concretos se publicarán antes del inicio\./);
  assert.doesNotMatch(fnSource, /requiredCompetencies/, "course outcomes must use their own relation-aware contract");
});
