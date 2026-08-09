"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftView } from "./types";

const POLL_MS = 1000;

export function useDraft() {
  const [view, setView] = useState<DraftView | null>(null);
  const [offline, setOffline] = useState(false);
  const clockOffset = useRef(0);
  const alive = useRef(true);

  const apply = useCallback((next: DraftView) => {
    clockOffset.current = next.now - Date.now();
    setView(next);
    setOffline(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) throw new Error("bad status");
      apply((await res.json()) as DraftView);
    } catch {
      setOffline(true);
    }
  }, [apply]);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await refresh();
      if (alive.current) timer = setTimeout(loop, POLL_MS);
    };
    loop();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [refresh]);

  return { view, offline, refresh, apply, clockOffset };
}
