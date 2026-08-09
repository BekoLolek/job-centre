import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import type { DraftState } from "./types";

/**
 * Storage auto-selects its backend:
 *   - Upstash Redis (REST) when KV_REST_API_* / UPSTASH_REDIS_REST_* env vars exist
 *   - a local JSON file otherwise, so `npm run dev` works with zero setup
 * Same shape either way; nothing above this module knows the difference.
 */

const STATE_KEY = "tournament-draft:state";
const LOCK_KEY = "tournament-draft:lock";
const LOCAL_FILE = path.join(process.cwd(), "data", "draft.json");

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export function backendName(): "redis" | "file" {
  return redisConfig() ? "redis" : "file";
}

async function redis(command: (string | number)[]): Promise<unknown> {
  const cfg = redisConfig();
  if (!cfg) throw new Error("Redis not configured");
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { result?: unknown; error?: string };
  if (json.error) throw new Error(`Redis error: ${json.error}`);
  return json.result ?? null;
}

async function readRaw(): Promise<DraftState | null> {
  if (redisConfig()) {
    const raw = (await redis(["GET", STATE_KEY])) as string | null;
    return raw ? (JSON.parse(raw) as DraftState) : null;
  }
  try {
    return JSON.parse(await fs.readFile(LOCAL_FILE, "utf8")) as DraftState;
  } catch {
    return null;
  }
}

async function writeRaw(state: DraftState): Promise<void> {
  if (redisConfig()) {
    await redis(["SET", STATE_KEY, JSON.stringify(state)]);
    return;
  }
  await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
  await fs.writeFile(LOCAL_FILE, JSON.stringify(state, null, 2), "utf8");
}

/** In-process queue — enough for the file backend, which is single-instance by definition. */
let localChain: Promise<unknown> = Promise.resolve();

async function withRedisLock<T>(fn: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const deadline = Date.now() + 5000;
  for (;;) {
    const ok = await redis(["SET", LOCK_KEY, token, "NX", "PX", 5000]);
    if (ok) break;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the draft lock");
    await new Promise((r) => setTimeout(r, 40));
  }
  try {
    return await fn();
  } finally {
    // Only release if we still own it.
    await redis([
      "EVAL",
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      LOCK_KEY,
      token,
    ]).catch(() => undefined);
  }
}

export async function readState(): Promise<DraftState | null> {
  return readRaw();
}

/** Read-modify-write under a lock. The mutator may return void to keep the state it was handed. */
export async function mutateState(
  fn: (state: DraftState) => DraftState | void | Promise<DraftState | void>,
  seed: () => DraftState
): Promise<DraftState> {
  const run = async (): Promise<DraftState> => {
    const current = (await readRaw()) ?? seed();
    const next = (await fn(current)) ?? current;
    next.updatedAt = Date.now();
    await writeRaw(next);
    return next;
  };

  if (redisConfig()) return withRedisLock(run);

  const queued = localChain.then(run, run);
  localChain = queued.catch(() => undefined);
  return queued;
}
