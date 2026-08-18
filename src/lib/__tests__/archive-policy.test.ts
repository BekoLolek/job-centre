import { describe, expect, it } from "vitest";
import type { EventStatus } from "@/db/schema";
import { LOCKED, LOCKED_STATUSES, isLocked, lockRefusal } from "@/lib/archive-policy";
import { EVENT_STATUS_FLOW, canTransition } from "@/lib/events-policy";

/**
 * The standing rule as a function: nothing destructive, ever.
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
    // `EVENT_STATUS_FLOW` lets a cancelled event go back to draft and the admin
    // events list says so out loud. Locking it would turn "I clicked the wrong
    // button" into a dead end.
    expect(isLocked("cancelled")).toBe(false);
    expect(EVENT_STATUS_FLOW.cancelled).toContain("draft");
  });
});

describe("the refusal", () => {
  it("is null for anything that is not finished, so the write proceeds", () => {
    for (const status of EVERY_STATUS.filter((s) => s !== "complete")) {
      expect(lockRefusal({ status }, LOCKED.generate)).toBeNull();
    }
  });

  it("names the event, says what was refused, and says what to do", () => {
    const refusal = lockRefusal({ status: "complete", title: "March Cup" }, LOCKED.clearResult);
    expect(refusal).toContain("March Cup");
    expect(refusal).toContain("its results cannot be cleared");
    expect(refusal).toContain("Move it back to live");
  });

  it("still reads as a sentence without a title", () => {
    const refusal = lockRefusal({ status: "complete" }, LOCKED.generate);
    expect(refusal).toBe(
      "This event is finished, so its bracket cannot be regenerated. Move it back to live first if it really is not over."
    );
  });

  it("offers a way out that actually exists", () => {
    // The whole design rests on this: the refusal tells an admin to move the
    // event back to live, so `complete → live` had better be legal. If somebody
    // ever tightens the status flow, this is the test that objects.
    expect(canTransition("complete", "live")).toBe(true);
  });
});

describe("the catalogue of refusals", () => {
  it("covers results, the bracket, the draft and the event's scaffolding", () => {
    // This list *is* the answer to "what can a finished event no longer do".
    expect(Object.keys(LOCKED).sort()).toEqual(
      [
        "bid",
        "captains",
        "clearResult",
        "days",
        "draftConfig",
        "generate",
        "moveMatch",
        "overrideWinner",
        "pool",
        "questions",
        "recordResult",
        "reschedule",
        "runDraft",
        "stages",
        "teams",
        "voidLot",
      ].sort()
    );
  });

  it("phrases every one as the end of 'This event is finished, so …'", () => {
    for (const attempt of Object.values(LOCKED)) {
      expect(attempt).not.toMatch(/^[A-Z]/);
      expect(attempt).not.toMatch(/\.$/);
    }
  });
});
