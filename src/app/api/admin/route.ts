import crypto from "crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  SPIN_DURATION_MS,
  loadState,
  phaseOf,
  poolFor,
  recordResult,
  seedState,
  setPool,
  toView,
  undoLast,
  updateState,
} from "@/lib/state";
import type { DraftState, WheelId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  type?: string;
  players?: unknown;
  captains?: unknown;
  captainId?: unknown;
  player?: unknown;
  wheel?: unknown;
  returnPlayers?: unknown;
};

function cleanNames(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const name = String(raw ?? "").trim().replace(/\s+/g, " ");
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function asWheel(value: unknown, fallback: WheelId): WheelId {
  return value === "main" || value === "reserve" ? value : fallback;
}

function randomIndex(length: number): number {
  return crypto.randomInt(0, length);
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as Body;
  const outcome: { error: string | null } = { error: null };

  const state = await updateState((draft: DraftState) => {
    const fail = (message: string) => {
      outcome.error = message;
    };

    switch (body.type) {
      case "setup": {
        if (Array.isArray(body.players)) {
          const players = cleanNames(body.players);
          const drafted = new Set(
            draft.captains.flatMap((c) => c.roster.map((p) => p.toLowerCase()))
          );
          const reserved = new Set(draft.reservePool.map((p) => p.toLowerCase()));
          draft.mainPool = players.filter(
            (p) => !drafted.has(p.toLowerCase()) && !reserved.has(p.toLowerCase())
          );
        }
        if (Array.isArray(body.captains)) {
          for (const raw of body.captains as Array<Record<string, unknown>>) {
            const captain = draft.captains.find((c) => c.id === raw?.id);
            if (!captain) continue;
            // Team names are derived from the captain's login name, not editable here.
            const balance = Number(raw.balance);
            if (Number.isInteger(balance) && balance >= 0) captain.balance = balance;
          }
        }
        return;
      }

      case "addPlayers": {
        const existing = new Set(
          [...draft.mainPool, ...draft.reservePool, ...draft.captains.flatMap((c) => c.roster)].map(
            (p) => p.toLowerCase()
          )
        );
        const added = cleanNames(body.players).filter((p) => !existing.has(p.toLowerCase()));
        draft.mainPool = [...draft.mainPool, ...added];
        return;
      }

      case "removePlayer": {
        const wheel = asWheel(body.wheel, "main");
        const player = String(body.player ?? "");
        setPool(
          draft,
          wheel,
          poolFor(draft, wheel).filter((p) => p !== player)
        );
        if (draft.currentPlayer === player) {
          draft.currentPlayer = null;
          draft.spin = null;
          draft.bids = {};
        }
        return;
      }

      case "setWheel": {
        if (draft.currentPlayer) return fail("Resolve the current player first");
        draft.activeWheel = asWheel(body.wheel, draft.activeWheel);
        draft.spin = null;
        return;
      }

      case "spin": {
        if (draft.currentPlayer) return fail("Resolve the current player first");
        const pool = poolFor(draft, draft.activeWheel);
        if (pool.length === 0) return fail("That wheel is empty");
        const snapshot = [...pool];
        const targetIndex = randomIndex(snapshot.length);
        draft.spin = {
          wheel: draft.activeWheel,
          pool: snapshot,
          targetIndex,
          startedAt: Date.now(),
          durationMs: SPIN_DURATION_MS,
          turns: 6,
        };
        draft.currentPlayer = snapshot[targetIndex];
        draft.bids = {};
        draft.lastResult = null;
        return;
      }

      case "cancel": {
        if (!draft.currentPlayer) return fail("Nothing to cancel");
        draft.currentPlayer = null;
        draft.spin = null;
        draft.bids = {};
        return;
      }

      case "clearBids": {
        draft.bids = {};
        return;
      }

      case "clearBid": {
        const id = String(body.captainId ?? "");
        delete draft.bids[id];
        return;
      }

      case "award": {
        const player = draft.currentPlayer;
        if (!player) return fail("No player on the block");
        if (phaseOf(draft) === "spinning") return fail("The wheel is still spinning");
        const id = String(body.captainId ?? "");
        const captain = draft.captains.find((c) => c.id === id);
        if (!captain) return fail("Unknown captain");
        const amount = draft.bids[id];
        if (amount === undefined) return fail(`${captain.name} has not bid`);
        if (amount > captain.balance) return fail(`${captain.name} cannot cover that bid`);

        const wheel = draft.spin?.wheel ?? draft.activeWheel;
        captain.balance -= amount;
        captain.roster.push(player);
        setPool(
          draft,
          wheel,
          poolFor(draft, wheel).filter((p) => p !== player)
        );
        recordResult(draft, {
          player,
          action: "award",
          fromWheel: wheel,
          winnerId: captain.id,
          winnerName: captain.name,
          amount,
          at: Date.now(),
        });
        return;
      }

      case "discard": {
        const player = draft.currentPlayer;
        if (!player) return fail("No player on the block");
        if (phaseOf(draft) === "spinning") return fail("The wheel is still spinning");
        const wheel = draft.spin?.wheel ?? draft.activeWheel;
        setPool(
          draft,
          wheel,
          poolFor(draft, wheel).filter((p) => p !== player)
        );
        recordResult(draft, {
          player,
          action: "discard",
          fromWheel: wheel,
          winnerId: null,
          winnerName: null,
          amount: null,
          at: Date.now(),
        });
        return;
      }

      case "toReserve": {
        const player = draft.currentPlayer;
        if (!player) return fail("No player on the block");
        if (phaseOf(draft) === "spinning") return fail("The wheel is still spinning");
        const wheel = draft.spin?.wheel ?? draft.activeWheel;
        if (wheel === "reserve") return fail("That player is already in the reserve wheel");
        draft.mainPool = draft.mainPool.filter((p) => p !== player);
        if (!draft.reservePool.includes(player)) draft.reservePool.push(player);
        recordResult(draft, {
          player,
          action: "reserve",
          fromWheel: "main",
          winnerId: null,
          winnerName: null,
          amount: null,
          at: Date.now(),
        });
        return;
      }

      case "undo": {
        const message = undoLast(draft);
        if (message) return fail(message);
        return;
      }

      case "reset": {
        const returned = body.returnPlayers
          ? [...draft.captains.flatMap((c) => c.roster), ...draft.reservePool, ...draft.mainPool]
          : draft.mainPool;
        const fresh = seedState();
        fresh.mainPool = cleanNames(returned);
        return fresh;
      }

      default:
        return fail(`Unknown action: ${body.type}`);
    }
  });

  if (outcome.error) {
    const current = await loadState();
    return NextResponse.json(
      { error: outcome.error, state: toView(current, session) },
      { status: 400 }
    );
  }
  return NextResponse.json(toView(state, session));
}
