import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { loadState, updateState } from "@/lib/state";
import {
  autoSchedule,
  blankGamesFor,
  normaliseTiming,
  seedTournament,
  toTournamentView,
} from "@/lib/tournament";
import type { DraftState, Match, Timing } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public — the results board needs no login. */
export async function GET() {
  const session = await getSession();
  const state = await loadState();
  return NextResponse.json(toTournamentView(state, session?.role === "admin"), {
    headers: { "Cache-Control": "no-store" },
  });
}

type Body = {
  type?: string;
  matchId?: unknown;
  games?: unknown[];
  scheduledAt?: unknown;
  durationMin?: unknown;
  winnerOverride?: unknown;
  seedOverride?: unknown;
  day1?: unknown;
  day2?: unknown;
  timing?: unknown;
};

function findMatch(state: DraftState, id: unknown): Match | undefined {
  return state.tournament.matches.find((m) => m.id === id);
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === "" || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as Body;
  const outcome: { error: string | null } = { error: null };

  const state = await updateState((draft) => {
    const fail = (message: string) => {
      outcome.error = message;
    };

    switch (body.type) {
      case "saveMatch": {
        const m = findMatch(draft, body.matchId);
        if (!m) return fail("Unknown match");

        // Only touch what the caller actually sent — an omitted field keeps its value,
        // an explicit null or "" clears it.
        if (body.scheduledAt !== undefined) {
          m.scheduledAt =
            typeof body.scheduledAt === "string" && body.scheduledAt ? body.scheduledAt : null;
        }
        if (body.durationMin !== undefined) m.durationMin = intOrNull(body.durationMin);
        if (body.winnerOverride !== undefined) {
          m.winnerOverride =
            typeof body.winnerOverride === "string" && body.winnerOverride
              ? body.winnerOverride
              : null;
        }

        if (Array.isArray(body.games)) {
          body.games.forEach((raw, i) => {
            const game = m.games[i];
            if (!game || typeof raw !== "object" || raw === null) return;
            const row = raw as Record<string, unknown>;
            if (typeof row.map === "string") game.map = row.map.trim().slice(0, 60);
            game.scoreA = intOrNull(row.scoreA) ?? 0;
            game.scoreB = intOrNull(row.scoreB) ?? 0;
            game.played = row.played === true;
          });
        }
        return;
      }

      case "clearMatch": {
        const m = findMatch(draft, body.matchId);
        if (!m) return fail("Unknown match");
        m.games = blankGamesFor(m.bestOf);
        m.winnerOverride = null;
        m.durationMin = null;
        return;
      }

      case "seedOverride": {
        const ids = Array.isArray(body.seedOverride)
          ? body.seedOverride.map((v) => String(v))
          : [];
        const valid =
          ids.length === 4 &&
          new Set(ids).size === 4 &&
          ids.every((id) => draft.captains.some((c) => c.id === id));
        draft.tournament.seedOverride = valid ? ids : null;
        return;
      }

      case "timing": {
        draft.tournament.timing = normaliseTiming(body.timing as Partial<Timing>);
        return;
      }

      case "schedule": {
        const day1 = typeof body.day1 === "string" ? body.day1 : "";
        const day2 = typeof body.day2 === "string" ? body.day2 : "";
        if (body.timing) draft.tournament.timing = normaliseTiming(body.timing as Partial<Timing>);
        if (!day1 && !day2) return fail("Pick a start time for at least one day");
        autoSchedule(draft, day1, day2, draft.tournament.timing);
        return;
      }

      case "resetTournament": {
        draft.tournament = seedTournament();
        return;
      }

      default:
        return fail(`Unknown action: ${body.type}`);
    }
  });

  if (outcome.error) {
    return NextResponse.json({ error: outcome.error }, { status: 400 });
  }
  return NextResponse.json(toTournamentView(state, true));
}
