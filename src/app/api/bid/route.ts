import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { phaseOf, toView, updateState } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || session.role !== "captain" || !session.captainId) {
    return NextResponse.json({ error: "Captains only" }, { status: 403 });
  }
  const captainId = session.captainId;

  const body = (await request.json().catch(() => ({}))) as { amount?: unknown };
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount < 0) {
    return NextResponse.json({ error: "Bid must be a whole number" }, { status: 400 });
  }

  const outcome: { error: string | null } = { error: null };
  const state = await updateState((draft) => {
    const captain = draft.captains.find((c) => c.id === captainId);
    if (!captain) {
      outcome.error = "Unknown captain";
      return;
    }
    if (phaseOf(draft) !== "bidding" || !draft.currentPlayer) {
      outcome.error = "Bidding is not open";
      return;
    }
    if (captainId in draft.bids) {
      outcome.error = "You already placed a bid on this player";
      return;
    }
    if (amount > captain.balance) {
      outcome.error = `Bid is over your balance (${captain.balance})`;
      return;
    }
    draft.bids[captainId] = amount;
  });

  if (outcome.error) return NextResponse.json({ error: outcome.error }, { status: 400 });
  return NextResponse.json(toView(state, session));
}
