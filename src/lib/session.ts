import crypto from "crypto";
import { cookies } from "next/headers";
import type { Session } from "./types";

const COOKIE = "td_session";
const MAX_AGE = 60 * 60 * 24 * 7; // a week — long enough to survive a draft night

function secret(): string {
  return process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me";
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function serializeSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function parseSession(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    const roles: Session["role"][] = ["admin", "captain", "observer"];
    if (!roles.includes(session.role)) return null;
    return session;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  return parseSession(jar.get(COOKIE)?.value);
}

export async function setSessionCookie(session: Session) {
  const jar = await cookies();
  jar.set(COOKIE, serializeSession(session), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.delete(COOKIE);
}
