import type { Session } from "./types";

export const CAPTAIN_IDS = ["c1", "c2", "c3", "c4"] as const;

export type CaptainAccount = {
  id: string;
  username: string;
  password: string;
  /** Always "Team <username>" — the login name is the captain's name. */
  name: string;
};

const CAPTAIN_DEFAULTS = [
  { username: "captain1", password: "draft1" },
  { username: "captain2", password: "draft2" },
  { username: "captain3", password: "draft3" },
  { username: "captain4", password: "draft4" },
];

export function teamName(username: string): string {
  return `Team ${username}`;
}

export function captainAccounts(): CaptainAccount[] {
  return CAPTAIN_IDS.map((id, i) => {
    const n = i + 1;
    const fallback = CAPTAIN_DEFAULTS[i];
    const username = process.env[`CAPTAIN${n}_USERNAME`] || fallback.username;
    return {
      id,
      username,
      password: process.env[`CAPTAIN${n}_PASSWORD`] || fallback.password,
      name: teamName(username),
    };
  });
}

export function adminAccount() {
  return {
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.ADMIN_PASSWORD || "admin",
  };
}

export function observerAccount() {
  return {
    username: process.env.OBSERVER_USERNAME || "observer",
    password: process.env.OBSERVER_PASSWORD || "watch",
  };
}

/** Constant-time-ish compare so a wrong password doesn't leak length by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function matches(input: string, username: string, password: string, given: string) {
  return safeEqual(input.toLowerCase(), username.toLowerCase()) && safeEqual(given, password);
}

export function authenticate(username: string, password: string): Session | null {
  const u = username.trim();

  const admin = adminAccount();
  if (matches(u, admin.username, admin.password, password)) {
    return { role: "admin", username: admin.username, captainId: null };
  }

  const observer = observerAccount();
  if (matches(u, observer.username, observer.password, password)) {
    return { role: "observer", username: observer.username, captainId: null };
  }

  for (const cap of captainAccounts()) {
    if (matches(u, cap.username, cap.password, password)) {
      return { role: "captain", username: cap.username, captainId: cap.id };
    }
  }

  return null;
}
