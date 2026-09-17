import { describe, expect, it } from "vitest";
import type { EventStatus } from "@/db/schema";
import { LOCKED_STATUSES, isLocked, lockRefusal } from "@/lib/archive-policy";
import { EVENT_STATUS_FLOW, canTransition } from "@/lib/events-policy";

/**
 * The standing rule as a function: a finished event is a record.
 *
 * The refusals themselves are exercised against real Postgres in
 * `archive-lock.test.ts`; this file pins the decision and, more importantly,
 * the *way out* — a lock with no exit is a trap, and the only thing standing
 * between the two is that `complete → live` stays a legal transition.
 */

const EVERY_STATUS: EventStatus[] = ["draft", "published", "live", "complete", "cancelled"];

describe("which statuses lock", () => {
  it("locks a finished event and nothing else", () => {
    expect(EVERY_STATUS.filter(isLocked)).toEqual(["complete"]);
    expect(LOCKED_STATUSES).toEqual(["complete"]);
  });

  it("leaves a cancelled event editable, because it never ran", () => {
    // `cancelled` is not locked; it is terminal, so nothing moves it through
    // the status flow (docs/diagrams/event-state.md, UC-09 5a).
    expect(isLocked("cancelled")).toBe(false);
    expect(EVENT_STATUS_FLOW.cancelled).toEqual([]);
  });
});

describe("the refusal", () => {
  it("is null for anything that is not finished, so the write proceeds", () => {
    for (const status of EVERY_STATUS.filter((s) => s !== "complete")) {
      expect(lockRefusal({ status })).toBeNull();
    }
  });

  it("is one sentence for every write on a finished event (UC-09 6b)", () => {
    expect(lockRefusal({ status: "complete" })).toBe(
      "This event is finished - reopen it to change it"
    );
  });

  it("offers a way out that actually exists", () => {
    // The whole design rests on this: the refusal tells a manager to reopen the
    // event, so `complete → live` had better be legal. If somebody ever tightens
    // the status flow, this is the test that objects.
    expect(canTransition("complete", "live")).toBe(true);
  });
});
