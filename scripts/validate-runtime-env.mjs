/** Validates runtime configuration without printing secrets. */

import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;

// Match Next.js environment loading before validating. This is especially
// important in Git worktrees, where ignored .env files are not copied and a
// direct process.env-only check would not see a correctly prepared local file.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

const errors = [];
const production = process.env.NODE_ENV === "production";
const releaseSha = process.env.AL_LIO_RELEASE_SHA?.trim();

if (production && !/^[0-9a-f]{40}$/.test(releaseSha ?? "")) {
  errors.push("AL_LIO_RELEASE_SHA debe contener el SHA completo inyectado por el mecanismo de release");
}

const databaseUrl = parseUrl("DATABASE_URL", true);
const baseUrl = parseUrl("BASE_URL", production);
const googleRedirect = parseUrl("GOOGLE_REDIRECT_URI", production);

if (databaseUrl && production && decodeURIComponent(databaseUrl.username) !== "al_lio_app") {
  errors.push("DATABASE_URL debe usar al_lio_app en producción");
}
if (baseUrl && production && baseUrl.protocol !== "https:") {
  errors.push("BASE_URL debe usar HTTPS en producción");
}
if (googleRedirect && baseUrl && googleRedirect.origin !== baseUrl.origin) {
  errors.push("GOOGLE_REDIRECT_URI debe compartir origen con BASE_URL");
}
if (googleRedirect && !googleRedirect.pathname.endsWith("/api/google/calendar/callback")) {
  errors.push("GOOGLE_REDIRECT_URI debe terminar en /api/google/calendar/callback");
}

requiredSecret("SESSION_SECRET", production ? 32 : 16);
requiredSecret("AL_LIO_RADAR_WEBHOOK_SECRET", 32, production);

const googleValues = [
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY,
  process.env.GOOGLE_REDIRECT_URI,
];
const configuredGoogleValues = googleValues.filter((value) => Boolean(value?.trim())).length;
if (configuredGoogleValues !== 0 && configuredGoogleValues !== googleValues.length) {
  errors.push("Las variables de Google deben configurarse todas juntas");
}
if (production && configuredGoogleValues !== googleValues.length) {
  errors.push("La integración Google debe estar configurada en producción");
}
if (process.env.GOOGLE_TOKEN_ENCRYPTION_KEY && process.env.GOOGLE_TOKEN_ENCRYPTION_KEY.length < 32) {
  errors.push("GOOGLE_TOKEN_ENCRYPTION_KEY debe tener al menos 32 caracteres");
}

const googleIdentityRedirect = parseUrl("GOOGLE_IDENTITY_REDIRECT_URI", production);
if (googleIdentityRedirect && baseUrl && googleIdentityRedirect.origin !== baseUrl.origin) {
  errors.push("GOOGLE_IDENTITY_REDIRECT_URI debe compartir origen con BASE_URL");
}
if (googleIdentityRedirect && !googleIdentityRedirect.pathname.endsWith("/api/auth/google/callback")) {
  errors.push("GOOGLE_IDENTITY_REDIRECT_URI debe terminar en /api/auth/google/callback");
}

const resendValues = [process.env.RESEND_API_KEY, process.env.RESEND_FROM_EMAIL];
const configuredResendValues = resendValues.filter((value) => Boolean(value?.trim())).length;
if (configuredResendValues !== 0 && configuredResendValues !== resendValues.length) {
  errors.push("RESEND_API_KEY y RESEND_FROM_EMAIL deben configurarse juntas");
}
if (production && configuredResendValues !== resendValues.length) {
  errors.push("El envío de correo transaccional (Resend) debe estar configurado en producción");
}

const verifiedOpportunitiesFlag = process.env.AL_LIO_VERIFIED_OPPORTUNITIES_ONLY?.trim().toLowerCase();
if (verifiedOpportunitiesFlag && verifiedOpportunitiesFlag !== "true" && verifiedOpportunitiesFlag !== "false") {
  errors.push("AL_LIO_VERIFIED_OPPORTUNITIES_ONLY debe ser true o false");
}

const learningIngestFlag = process.env.AL_LIO_RADAR_LEARNING_INGEST_ENABLED?.trim().toLowerCase();
if (learningIngestFlag && learningIngestFlag !== "true" && learningIngestFlag !== "false") {
  errors.push("AL_LIO_RADAR_LEARNING_INGEST_ENABLED debe ser true o false");
}

commaSeparatedEnum(
  "AL_LIO_RADAR_V4_PROJECT_DESTINATIONS",
  new Set(["news", "course", "event", "job"]),
);

integer("PG_POOL_MAX", 1, 50);
integer("PG_IDLE_TIMEOUT_MS", 1_000, 300_000);
integer("PG_CONNECTION_TIMEOUT_MS", 500, 60_000);
integer("PG_STATEMENT_TIMEOUT_MS", 1_000, 120_000);

if (errors.length > 0) {
  console.error("Configuración de runtime inválida:");
  for (const error of errors) console.error(`  - ${error}`);
  console.error("Copia .env.example a .env.local y configura los valores antes de iniciar la aplicación.");
  process.exit(1);
}

console.log("OK: configuración de runtime validada.");

function parseUrl(name, required) {
  const value = process.env[name]?.trim();
  if (!value) {
    if (required) errors.push(`${name} es obligatoria`);
    return null;
  }
  if (value.includes("REPLACE_ME")) {
    errors.push(`${name} contiene un placeholder`);
    return null;
  }
  try {
    const url = new URL(value);
    if (name.includes("DATABASE") && !["postgres:", "postgresql:"].includes(url.protocol)) {
      errors.push(`${name} debe usar postgresql://`);
    }
    return url;
  } catch {
    errors.push(`${name} no es una URL válida`);
    return null;
  }
}

function requiredSecret(name, minimumLength, required = true) {
  const value = process.env[name];
  if (!value) {
    if (required) errors.push(`${name} debe tener al menos ${minimumLength} caracteres y no usar placeholders`);
    return;
  }
  if (value.includes("REPLACE_ME") || value.length < minimumLength) {
    errors.push(`${name} debe tener al menos ${minimumLength} caracteres y no usar placeholders`);
  }
}

function integer(name, minimum, maximum) {
  const raw = process.env[name];
  if (!raw) return;
  const normalized = raw.trim();
  const value = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    errors.push(`${name} debe estar entre ${minimum} y ${maximum}`);
  }
}

function commaSeparatedEnum(name, allowed) {
  const raw = process.env[name]?.trim();
  if (!raw) return;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const invalid = values.filter((value) => !allowed.has(value));
  if (new Set(values).size !== values.length || invalid.length > 0) {
    errors.push(`${name} solo admite valores únicos: ${[...allowed].join(", ")}`);
  }
}
