// Source-level assertion rationale: the JSON files are immutable versioned wire
// fixtures, so parsing their committed bytes is the real contract boundary. The
// production schemas and projection functions are imported and executed directly.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  RADAR_MAX_BATCH_ITEMS,
  RADAR_SUPPORTED_SCHEMA_VERSIONS,
  RADAR_V4_JOB_FIELDS,
  radarV4ValueHash,
  radarDeliverySchema,
} from "../../../src/lib/radar/contract.ts";
import {
  legacyLifecycleStatus,
  radarV4ProjectionDestinations,
  resolveRadarV4Fact,
} from "../../../src/lib/radar/v4-projection.ts";
import { radarLearningDeliverySchema } from "../../../src/lib/radar/learning-contract.ts";

const fixtures = join(process.cwd(), "tests", "contracts", "radar", "fixtures");

function fixture(name) {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

function verifiedJobDelivery() {
  const delivery = fixture("partial-v4.json");
  const item = delivery.items[0];
  item.classification = {
    ...item.classification,
    destination: "job",
    opportunityType: "vacancy",
    kind: "vacancy",
    skills: ["Java", "Spring"],
    matchReasons: ["rule:daw-java-spring", "keyword:java", "keyword:spring"],
  };
  const genericFacts = {
    title: "Desarrollador Java Spring junior",
    summaryShort: "Vacante junior para desarrollar aplicaciones Java con Spring.",
    organizer: "Empresa Ejemplo",
    provider: "Empresa Ejemplo",
    registrationDeadline: "2026-09-20T21:59:00.000Z",
    registrationUrl: "https://jobs.example/vacancies/123/apply",
    sourceLifecycleStatus: "registration_open",
  };
  for (const [field, value] of Object.entries(genericFacts)) {
    item.facts[field] = value;
    item.factStates[`facts.${field}`] = "verified";
    item.evidence = item.evidence.filter((entry) => entry.fieldPath !== `facts.${field}`);
    item.evidence.push({
      fieldPath: `facts.${field}`,
      origin: "authoritative_source",
      kind: "source_page",
      url: "https://jobs.example/vacancies/123",
      observedAt: "2026-08-29T08:00:00.000Z",
      valueHash: radarV4ValueHash(value),
      authorityRank: 100,
    });
  }
  const facts = {
    employer: "Empresa Ejemplo",
    sourceVacancyId: "vacancy-123",
    applicationUrl: genericFacts.registrationUrl,
    lifecycle: "open",
    applicationDeadline: genericFacts.registrationDeadline,
    country: "España",
    autonomousCommunity: "Andalucía",
    province: "Granada",
    municipality: "Granada",
    workplaceMode: "hybrid",
    contractType: null,
    workingTime: null,
    schedule: null,
    salaryMinMinor: null,
    salaryMaxMinor: null,
    salaryCurrency: null,
    salaryPeriod: null,
    minimumEducation: null,
    experienceRequirements: null,
    languages: [],
    otherEligibility: [],
    sourcePublishedAt: "2026-08-28T07:00:00.000Z",
    sourceUpdatedAt: null,
    firstSeenAt: "2026-08-29T08:00:00.000Z",
    lastSeenAt: "2026-08-29T08:00:00.000Z",
    verifiedAt: "2026-08-29T08:00:00.000Z",
  };
  const factStates = {};
  const evidence = [];
  for (const field of RADAR_V4_JOB_FIELDS) {
    const value = facts[field];
    const present = value !== null && (!Array.isArray(value) || value.length > 0);
    factStates[`job.${field}`] = present ? "verified" : "not_stated";
    if (present) evidence.push({
      fieldPath: `job.${field}`,
      origin: "authoritative_source",
      kind: "source_page",
      url: "https://jobs.example/vacancies/123",
      observedAt: facts.verifiedAt,
      valueHash: radarV4ValueHash(value),
      authorityRank: 100,
    });
  }
  item.job = { facts, factStates, evidence };
  return delivery;
}

test("the same protected receiver accepts strict v3 and complete or partial v4", () => {
  for (const name of ["strict-v3.json", "complete-v4.json", "partial-v4.json", "conflicting-v4.json"]) {
    const parsed = radarDeliverySchema.safeParse(fixture(name));
    assert.equal(parsed.success, true, name);
  }
  assert.deepEqual([...RADAR_SUPPORTED_SCHEMA_VERSIONS], [2, 3, 4]);
  const complete = radarDeliverySchema.parse(fixture("complete-v4.json"));
  assert.equal(complete.items[0].classification.language, "es");
  assert.deepEqual(complete.items[0].classification.matchReasons, ["rule:daw-dam-java", "keyword:java"]);
});

test("v4 rejects a missing publication-critical fact and its evidence atomically", () => {
  const delivery = fixture("partial-v4.json");
  delivery.items[0].facts.provider = null;
  delivery.items[0].factStates["facts.provider"] = "not_stated";
  delivery.items[0].evidence = delivery.items[0].evidence.filter((entry) => entry.fieldPath !== "facts.provider");
  assert.equal(radarDeliverySchema.safeParse(delivery).success, false);
});

test("v4 rejects present facts without value-matching field evidence", () => {
  const delivery = fixture("partial-v4.json");
  delivery.items[0].evidence.find((entry) => entry.fieldPath === "facts.title").valueHash = "0".repeat(64);
  assert.equal(radarDeliverySchema.safeParse(delivery).success, false);
});

test("v4 is strict and rejects transport fields that were not versioned", () => {
  const delivery = fixture("partial-v4.json");
  delivery.items[0].userState = "started";
  assert.equal(radarDeliverySchema.safeParse(delivery).success, false);
});

test("v4 accepts a strict verified job without private student state", () => {
  const delivery = verifiedJobDelivery();
  assert.equal(radarDeliverySchema.safeParse(delivery).success, true);
  assert.doesNotMatch(JSON.stringify(delivery.items[0].job), /userId|notes|cv|applicationStatus/i);
});

test("v4 rejects a job whose generic action URL diverges from its typed vacancy facts", () => {
  const delivery = verifiedJobDelivery();
  delivery.items[0].facts.registrationUrl = "https://jobs.example/vacancies/different/apply";
  const evidence = delivery.items[0].evidence.find((entry) => entry.fieldPath === "facts.registrationUrl");
  evidence.valueHash = radarV4ValueHash(delivery.items[0].facts.registrationUrl);
  assert.equal(radarDeliverySchema.safeParse(delivery).success, false);
});

test("an explicitly verified empty list is distinct from a fact that was not stated", () => {
  const delivery = fixture("partial-v4.json");
  delivery.items[0].factStates["facts.requirements"] = "verified";
  delivery.items[0].evidence.push({
    fieldPath: "facts.requirements",
    origin: "authoritative_source",
    kind: "official_document",
    url: "https://example.edu/cursos/java-parcial",
    observedAt: "2026-08-28T07:05:00.000Z",
    valueHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    authorityRank: 100,
  });
  assert.equal(radarDeliverySchema.safeParse(delivery).success, true);
});

test("derived public copy requires explicit provenance", () => {
  const delivery = fixture("partial-v4.json");
  delivery.items[0].derived.whyRelevant = "Encaja con DAW.";
  assert.equal(radarDeliverySchema.safeParse(delivery).success, false);
});

test("batch limits remain unchanged", () => {
  const delivery = fixture("partial-v4.json");
  delivery.items = Array.from({ length: RADAR_MAX_BATCH_ITEMS + 1 }, () => delivery.items[0]);
  assert.equal(radarDeliverySchema.safeParse(delivery).success, false);
});

const learningDelivery = () => ({
  schemaVersion: 1,
  deliveryId: "b63f5b3a-bd75-4cee-ae0b-b8fb6d30aa49",
  resources: [{
    resource: {
      provider: "youtube",
      externalId: "abcdefghijk",
      canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      channelId: "UC-official",
      channelName: "Official academy",
      title: "Curso de Java",
      description: "Fundamentos y orientación a objetos",
      language: "es",
      durationSeconds: 3600,
      availability: "available",
      verifiedAt: "2026-08-29T08:00:00.000Z",
      revision: 1,
    },
    mappings: [{
      cycleCode: "DAW",
      competencyKey: "java-fundamentals",
      role: "primary",
      coveragePercent: 90,
      selectionReasons: ["Exact Java and object-oriented programming coverage"],
    }],
  }],
});

test("learning handoff accepts exact verified resources and rejects generic or mismatched targets", () => {
  assert.equal(radarLearningDeliverySchema.safeParse(learningDelivery()).success, true);
  const generic = learningDelivery();
  generic.resources[0].resource.canonicalUrl = "https://www.youtube.com/results?search_query=java";
  assert.equal(radarLearningDeliverySchema.safeParse(generic).success, false);
});

test("learning handoff is strict and cannot carry student progress", () => {
  const delivery = learningDelivery();
  delivery.resources[0].resource.userId = "student-1";
  delivery.resources[0].resource.completed = true;
  assert.equal(radarLearningDeliverySchema.safeParse(delivery).success, false);
});

test("missing extraction never erases the last-known-good fact", () => {
  const result = resolveRadarV4Fact({
    currentValue: "Resumen verificado por la fuente oficial.",
    currentAuthorityRank: 100,
    incomingValue: null,
    incomingAuthorityRank: null,
    observationState: "source_unavailable",
  });
  assert.equal(result.value, "Resumen verificado por la fuente oficial.");
  assert.equal(result.applyIncoming, false);
  assert.equal(result.conflict, false);
});

test("a lower-authority conflict keeps last-known-good and is quarantinable", () => {
  const result = resolveRadarV4Fact({
    currentValue: "Resumen verificado por la fuente oficial.",
    currentAuthorityRank: 100,
    incomingValue: fixture("conflicting-v4.json").items[0].facts.summaryShort,
    incomingAuthorityRank: 50,
    observationState: "verified",
  });
  assert.equal(result.value, "Resumen verificado por la fuente oficial.");
  assert.equal(result.applyIncoming, false);
  assert.equal(result.conflict, true);
  assert.equal(result.resolution, "kept_last_known_good");
});

test("only explicit verified removal can clear a known fact", () => {
  const result = resolveRadarV4Fact({
    currentValue: "Certificado oficial",
    currentAuthorityRank: 80,
    incomingValue: null,
    incomingAuthorityRank: 100,
    observationState: "verified_removed",
  });
  assert.equal(result.value, null);
  assert.equal(result.applyIncoming, true);
  assert.equal(result.resolution, "accepted_higher_authority");
});

test("v4 projection is disabled by default and invalid flags fail closed", () => {
  assert.deepEqual([...radarV4ProjectionDestinations("")], []);
  assert.deepEqual([...radarV4ProjectionDestinations("news,course")], ["news", "course"]);
  assert.deepEqual([...radarV4ProjectionDestinations("job")], ["job"]);
  assert.throws(() => radarV4ProjectionDestinations("unknown"), /Unsupported/);
});

test("source lifecycle is not confused with user state or internal priority", () => {
  assert.equal(legacyLifecycleStatus("registration_open"), "abierto");
  assert.equal(legacyLifecycleStatus("registration_closed"), null);
  assert.equal(legacyLifecycleStatus("cancelled"), null);
});

test("compatibility projection reuses the legacy UUID and never mutates student state", () => {
  const repository = readFileSync(join(process.cwd(), "src", "lib", "db", "repositories", "radar-v4.ts"), "utf8");
  assert.match(repository, /WHERE radar_semantic_key = \$1 LIMIT 1/);
  assert.match(repository, /UPDATE public\.fp_content_items SET[\s\S]+WHERE id = \$20/);
  assert.doesNotMatch(repository, /(UPDATE|DELETE FROM|INSERT INTO) public\.fp_user_content_state/);
});

test("job discovery projects global facts and never creates private application state", () => {
  const repository = readFileSync(join(process.cwd(), "src", "lib", "db", "repositories", "radar-v4.ts"), "utf8");
  assert.match(repository, /upsertVerifiedJob/);
  assert.match(repository, /radar_verified_jobs/);
  assert.doesNotMatch(repository, /(UPDATE|DELETE FROM|INSERT INTO) public\.job_applications/);
});

test("verified job reads and direct actions are authenticated, cycle-scoped and user-owned", () => {
  const repository = readFileSync(join(process.cwd(), "src", "lib", "jobs", "repository.ts"), "utf8");
  const listRoute = readFileSync(join(process.cwd(), "src", "app", "api", "verified-jobs", "route.ts"), "utf8");
  const actionRoute = readFileSync(join(process.cwd(), "src", "app", "api", "verified-jobs", "[id]", "route.ts"), "utf8");
  assert.match(listRoute, /tryGetCurrentUserId/);
  assert.match(actionRoute, /tryGetCurrentUserId/);
  assert.match(repository, /application\.user_id = \$1/);
  assert.match(repository, /target\.target_value = \$3/);
  assert.match(repository, /ON CONFLICT \(user_id, canonical_entity_id\)/);
  assert.match(repository, /job\.lifecycle = 'open'/);
});

test("the Work UI preserves manual applications but does not expose legacy scrape-to-application sync", () => {
  const source = readFileSync(join(process.cwd(), "src", "features", "work", "client", "work-feature.tsx"), "utf8");
  assert.match(source, /\["candidaturas", "Candidaturas"\]/);
  assert.match(source, /Añadir candidatura manual/);
  assert.doesNotMatch(source, /Sincronizar radar|onClick=\{syncRadar\}/);
});

test("identity corrections resolve through auditable canonical aliases", () => {
  const repository = readFileSync(join(process.cwd(), "src", "lib", "db", "repositories", "radar-v4.ts"), "utf8");
  assert.match(repository, /radar_content_identity_aliases/);
  assert.match(repository, /canonical-entity-key-transition/);
  assert.match(repository, /canonical-occurrence-key-transition/);
  assert.match(repository, /uniqueCandidates\.size > 1/);
});

test("news language and deterministic match reasons are persisted with each canonical occurrence", () => {
  const repository = readFileSync(join(process.cwd(), "src", "lib", "db", "repositories", "radar-v4.ts"), "utf8");
  assert.match(repository, /title, language, match_reasons/);
  assert.match(repository, /item\.classification\.language/);
  assert.match(repository, /item\.classification\.matchReasons/);
});

test("a news revision reuses the same legacy radar_items row so read/saved state survives (issue #201)", () => {
  const repository = readFileSync(join(process.cwd(), "src", "lib", "db", "repositories", "radar-v4.ts"), "utf8");
  const projectNews = repository.slice(
    repository.indexOf("async function projectNews"),
    repository.indexOf("function legacyNewsValues"),
  );
  assert.ok(projectNews.length > 0, "could not locate projectNews");

  // The occurrence keeps the stable bridge to the compatibility identity, taken
  // under a row lock so concurrent revisions cannot fork it.
  assert.match(projectNews, /SELECT legacy_radar_item_id::text FROM public\.radar_content_occurrences WHERE id = \$1 FOR UPDATE/);

  // A brand new occurrence inserts one radar_items row; a revision (the id is
  // already linked) skips the insert entirely and only updates that same row.
  assert.match(projectNews, /if \(!radarItemId\) \{[\s\S]*INSERT INTO public\.radar_items[\s\S]*\}/);
  assert.match(projectNews, /UPDATE public\.radar_items SET[\s\S]*WHERE id = \$29/);
  assert.match(projectNews, /ON CONFLICT \(source_id, canonical_url\) DO UPDATE SET\s*\n\s*entity_key = excluded\.entity_key/);

  // The projector never deletes/recreates the article and never touches the
  // user's private read/saved state.
  assert.doesNotMatch(projectNews, /DELETE FROM public\.radar_items/);
  assert.doesNotMatch(projectNews, /(UPDATE|DELETE FROM|INSERT INTO) public\.radar_item_user_states/);
});

test("the verified-news contract documents the shared authorisation boundary and revision/user-state ownership (issue #201)", () => {
  const doc = readFileSync(join(process.cwd(), "docs", "integrations", "VERIFIED_NEWS_DETAILS.md"), "utf8");
  assert.match(doc, /listRadarItemsForCycle`, `getRadarItemDetailForUser`, `getNextRadarNewsItem`/);
  assert.match(doc, /The next item is selected from the exact same ordered list/);
  assert.match(doc, /compact `summaryShort` for cards/);
  assert.match(doc, /source-backed `summaryExpanded` and `keyFacts` for detail/);
  assert.match(doc, /derived `whyRelevant`, rendered in a separate section/);
  assert.match(doc, /Optional sections disappear when absent/);
  assert.match(doc, /reuses the legacy `radar_items\.id`, so a new material revision updates the same logical article without replacing the user's status row/);
});
