/**
 * Installs the harness rate-limit bypass header on EVERY fetch this process
 * makes.
 *
 * The header was previously added at individual call sites, which meant any
 * raw fetch() added later silently missed it and reintroduced the 429 storms
 * that made the harnesses un-runnable as a suite. Wrapping fetch once is the
 * structural version of that rule: a new call site cannot opt out by accident.
 *
 * Harness-side only. The server-side guard in rateLimiter.ts is what actually
 * decides whether a bypass is honoured, and it refuses in production
 * regardless of what any client sends.
 */

// Read directly from process.env, the same way every harness file already
// does (see the matching VERIFY_BYPASS_TOKEN const in verifyRoles.ts,
// verifyGates.ts, verifySignatures.ts, verifyPassback.ts), rather than
// pulling in config/env.ts here — that module's zod schema requires
// MONGODB_URI/JWT secrets/etc to be set, which this module has no business
// demanding just to decide whether to add one header.
const VERIFY_BYPASS_TOKEN = process.env.VERIFY_BYPASS_TOKEN;

let installed = false;

export function installVerifyBypass(): void {
  // Idempotent: several harnesses import each other's helpers (e.g. db.ts),
  // so this can run more than once per process. Only the first call may wrap.
  if (installed) return;
  installed = true;

  // No token, no change: leave globalThis.fetch completely untouched so a run
  // without VERIFY_BYPASS_TOKEN set behaves exactly as it did before this
  // module existed, just subject to the real rate limits.
  if (!VERIFY_BYPASS_TOKEN) return;

  const token = VERIFY_BYPASS_TOKEN;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // `new Headers(...)` accepts every shape a caller in these files uses —
    // a plain Record<string, string>, an array of [name, value] tuples, an
    // existing Headers instance, or undefined — and normalizes them into one
    // Headers object without dropping or reordering any entry. This is what
    // makes the merge safe for Authorization: Bearer …, X-Gate-Key, and
    // Content-Type alike: they all pass through Headers unchanged, and only
    // the bypass header is added on top.
    const headers = new Headers(init?.headers ?? {});

    // Never clobber an explicit header: if a call site already set its own
    // X-Verify-Bypass (or a future one does), that value wins.
    if (!headers.has('X-Verify-Bypass')) {
      headers.set('X-Verify-Bypass', token);
    }

    // Spreading init and overriding only `headers` leaves `body` (including
    // multipart FormData bodies used by the photo/signature uploads)
    // completely untouched — Headers is a separate field on RequestInit, so
    // this can never disturb the body or its multipart boundary.
    return originalFetch(input, { ...init, headers });
  }) as typeof fetch;
}
