import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, auditLog, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  AUDIT_ACTIONS,
  actionLabel,
  actionTone,
  countAudit,
  listAudit,
  recordAudit,
} from "@/lib/audit";
import { createEvent } from "@/lib/events";

/**
 * The audit log against real Postgres.
 *
 * The two properties worth proving are both about *not* losing things: a line
 * that fails to write must not take the action down with it, and a line that is
 * written must keep saying the same thing however the world moves afterwards.
 */

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await db.delete(auditLog);
});

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

describe("the vocabulary", () => {
  it("labels every action it knows", () => {
    for (const [action, label] of Object.entries(AUDIT_ACTIONS)) {
      expect(actionLabel(action)).toBe(label);
    }
  });

  it("renders an action it does not know rather than hiding the row", () => {
    // A log that drops lines it cannot label is worse than one with an ugly
    // line in it — the missing row is exactly the one somebody is looking for.
    expect(actionLabel("something.new")).toBe("something.new");
  });

  it("marks the ones that took something away", () => {
    expect(actionTone("draft.voided")).toBe("ember");
    expect(actionTone("result.cleared")).toBe("ember");
    expect(actionTone("announcement.failed")).toBe("ember");
    expect(actionTone("draft.awarded")).toBe("gold");
    expect(actionTone("event.status")).toBe("muted");
  });
});

describe("recording", () => {
  it("writes the actor, the sentence and the detail", async () => {
    const actorId = await makeUser(db, { displayName: "Beko" });
    const row = await recordAudit(
      {
        action: "draft.awarded",
        actor: { id: actorId, displayName: "Beko" },
        summary: "Nyx → Rivals Red for 250.",
        subject: "lot-1",
        detail: { price: 250 },
      },
      db
    );

    expect(row).not.toBeNull();
    expect(row?.actorUserId).toBe(actorId);
    expect(row?.actorName).toBe("Beko");
    expect(row?.summary).toBe("Nyx → Rivals Red for 250.");
    expect(row?.detail).toEqual({ price: 250 });
  });

  it("never throws, and never rejects, whatever the database says", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The caller is always an action that has *already* succeeded. Turning "the
    // log is full" into "your application failed" would be strictly worse than
    // a missing line.
    const broken = {
      insert: () => {
        throw new Error("relation \"audit_log\" does not exist");
      },
    } as unknown as Database;

    await expect(
      recordAudit({ action: "event.status", summary: "x" }, broken)
    ).resolves.toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("accepts a line with no actor, for something the system did to itself", async () => {
    const row = await recordAudit(
      { action: "announcement.failed", summary: "The webhook answered 404." },
      db
    );
    expect(row?.actorUserId).toBeNull();
    const [view] = await listAudit({}, db);
    expect(view.actor.name).toBe("The system");
  });

  it("clamps a summary rather than failing the write", async () => {
    const row = await recordAudit({ action: "event.status", summary: "x".repeat(900) }, db);
    expect(row?.summary).toHaveLength(500);
  });
});

describe("reading", () => {
  it("comes back newest first", async () => {
    const base = Date.UTC(2026, 2, 1, 18, 0, 0);
    for (const [index, word] of ["first", "second", "third"].entries()) {
      await recordAudit(
        { action: "event.status", summary: word, now: new Date(base + index * 60_000) },
        db
      );
    }
    expect((await listAudit({}, db)).map((row) => row.summary)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  it("filters to one event", async () => {
    const a = unwrap(await createEvent({ title: "Audit A" }, db));
    const b = unwrap(await createEvent({ title: "Audit B" }, db));
    await recordAudit({ action: "event.status", summary: "in A", eventId: a.id }, db);
    await recordAudit({ action: "event.status", summary: "in B", eventId: b.id }, db);
    await recordAudit({ action: "settings.announcements", summary: "no event" }, db);

    expect((await listAudit({ eventId: a.id }, db)).map((row) => row.summary)).toEqual(["in A"]);
    expect(await countAudit(a.id, db)).toBe(1);
    expect(await countAudit(null, db)).toBe(3);
  });

  it("joins the event so a line can link to it", async () => {
    const event = unwrap(await createEvent({ title: "Linked" }, db));
    await recordAudit({ action: "event.published", summary: "x", eventId: event.id }, db);
    const [row] = await listAudit({}, db);
    expect(row.event).toEqual({ id: event.id, title: "Linked", slug: event.slug });
  });

  it("keeps the name it stored, even after a rename", async () => {
    const actorId = await makeUser(db, { displayName: "Old Name" });
    await recordAudit(
      { action: "event.status", summary: "did a thing", actor: { id: actorId, displayName: "Old Name" } },
      db
    );

    await db.update(users).set({ displayName: "New Name" }).where(eq(users.id, actorId));

    // The snapshot wins. A line that changed meaning when somebody was renamed
    // would not be a record of anything.
    const [row] = await listAudit({}, db);
    expect(row.actor.name).toBe("Old Name");
    expect(row.actor.id).toBe(actorId);
  });

  it("pages with a cursor rather than an offset", async () => {
    const base = Date.UTC(2026, 2, 1, 18, 0, 0);
    for (let index = 0; index < 5; index += 1) {
      await recordAudit(
        { action: "event.status", summary: `line ${index}`, now: new Date(base + index * 1000) },
        db
      );
    }
    const first = await listAudit({ limit: 2 }, db);
    expect(first.map((row) => row.summary)).toEqual(["line 4", "line 3"]);

    const next = await listAudit({ limit: 2, before: first[1].at }, db);
    expect(next.map((row) => row.summary)).toEqual(["line 2", "line 1"]);
  });

  it("clamps a silly limit", async () => {
    await recordAudit({ action: "event.status", summary: "one" }, db);
    expect(await listAudit({ limit: -5 }, db)).toHaveLength(1);
    expect(await listAudit({ limit: 100_000 }, db)).toHaveLength(1);
  });
});
