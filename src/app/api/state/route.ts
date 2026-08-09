import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { loadState, toView } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const state = await loadState();
  return NextResponse.json(toView(state, session), {
    headers: { "Cache-Control": "no-store" },
  });
}
