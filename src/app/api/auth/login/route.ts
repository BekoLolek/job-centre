import { NextResponse } from "next/server";
import { authenticate } from "@/lib/users";
import { setSessionCookie } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    username?: string;
    password?: string;
  };
  const session = authenticate(body.username ?? "", body.password ?? "");
  if (!session) {
    return NextResponse.json({ error: "Wrong username or password" }, { status: 401 });
  }
  await setSessionCookie(session);
  return NextResponse.json({ ok: true, role: session.role });
}
