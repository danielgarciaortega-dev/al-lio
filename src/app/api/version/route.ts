const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;

export const dynamic = "force-dynamic";

export function GET() {
  const releaseSha = process.env.AL_LIO_RELEASE_SHA?.trim() ?? "";
  if (!RELEASE_SHA_PATTERN.test(releaseSha)) {
    return Response.json(
      { releaseSha: null },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    { releaseSha },
    { headers: { "Cache-Control": "no-store" } },
  );
}
