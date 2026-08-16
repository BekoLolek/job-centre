/**
 * The Auth.js endpoints: `/api/auth/signin`, `/callback/discord`, `/session`,
 * `/csrf`, `/signout`, `/providers`.
 *
 * The catch-all sits alongside the legacy `login/` and `logout/` routes the
 * draft board posts to. Next.js matches a static segment before a dynamic one,
 * so `/api/auth/login` and `/api/auth/logout` keep reaching their own handlers
 * untouched; everything else falls through to Auth.js. The two names Auth.js
 * uses are `signin`/`signout`, so there is no overlap to begin with.
 *
 * `nodejs` runtime because the Drizzle adapter reaches Postgres (PGlite locally,
 * which is a WASM native module).
 */

import { handlers } from "@/lib/auth";

export const runtime = "nodejs";

export const { GET, POST } = handlers;
