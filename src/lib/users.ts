import type { Session } from "./types";

export const CAPTAIN_IDS = ["c1", "c2", "c3", "c4"] as const;

export type CaptainAccount = {
  id: string;
  username: string;
  password: string;
  defaultName: string;
};

const CAPTAIN_DEFAULTS = [
  { username: "captain1", password: "draft1", name: "Team One" },
  { username: "captain2", password: "draft2", name: "Team Two" },
  { username: "captain3", password: "draft3", name: "Team Three" },
  { username: "captain4", password: "draft4", name: "Team Four" },
];

export function captainAccounts(): CaptainAccount[] {
  return CAPTAIN_IDS.map((id, i) => {
    const n = i + 1;
    const fallback = CAPTAIN_DEFAULTS[i];
    return {
      id,
      username: process.env[`CAPTAIN${n}_USERNAME`] || fallback.username,
      password: process.env[`CAPTAIN${n}_PASSWORD`] || fallback.password,
      defaultName: process.env[`CAPTAIN${n}_NAME`] || fallback.name,
    };
  });
}

export function adminAccount() {
  return {
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.ADMIN_PASSWORD || "admin",
  };
}

/** Constant-time-ish compare so a wrong password doesn't leak length by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authenticate(username: string, password: string): Session | null {
  const u = username.trim();
  const admin = adminAccount();
  if (safeEqual(u.toLowerCase(), admin.username.toLowerCase()) && safeEqual(password, admin.password)) {
    return { role: "admin", username: admin.username, captainId: null };
  }
  for (const cap of captainAccounts()) {
    if (safeEqual(u.toLowerCase(), cap.username.toLowerCase()) && safeEqual(password, cap.password)) {
      return { role: "captain", username: cap.username, captainId: cap.id };
    }
  }
  return null;
}
