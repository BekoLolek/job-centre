import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database } from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import { type EventResult, createEvent, getEventById, updateEvent } from "@/lib/events";
import { SLUG_MAX, readWebAddress, webAddressRefusal } from "@/lib/events-policy";

/**
 * An event's web address (R-114 / UC-08 E2, E2a).
 *
 * E2 is one line — "manager changes the web address — System saves it" — and
 * E2a is the whole of why this file exists:
 *
 * > **E2a.** Address taken or not letters, numbers and hyphens — System
 * > rejects with the reason; the old address stays.
 *
 * `updateEvent` did neither. It ran whatever was typed through `slugify`, so
 * `Summer Cup!` was saved as `summer-cup` with nothing said; and it ran the
 * result through `freeSlug`, so an address another event already held was
 * saved as `summer-cup-2`. Both are the same defect — an address the manager
 * did not choose, stored as though they had — and the damage is that the link
 * they already pasted into Discord points somewhere else. The refusal is the
 * fix, and "the old address stays" is the half of it that needs a test of its
 * own: a refusal that had already written the row would be no refusal.
 *
 * Disambiguation is still right for the address **derived from a title** when
 * the event is created (UC-08 2), because there is nothing the admin typed for
 * a `-2` to contradict. That half is asserted at the bottom, so the fix cannot
 * be "stop disambiguating anywhere".
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

function expectOk<T>(result: EventResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got: ${result.error}`);
  return result.data;
}

function expectFail<T>(result: EventResult<T>): { error: string } {
  if (result.ok) throw new Error("Expected a refusal, got success");
  return result;
}

let counter = 0;

/** An event with a known address, so a test can try to change it. */
async function anEvent(title: string): Promise<{ id: string; slug: string }> {
  counter += 1;
  const event = expectOk(await createEvent({ title: `${title} ${counter}` }, db));
  return { id: event.id, slug: event.slug };
}

/** The address as the database has it now — never the write's return value. */
async function storedAddress(eventId: string): Promise<string> {
  const event = await getEventById(eventId, {}, db);
  if (!event) throw new Error("event vanished");
  return event.slug;
}

/* ------------------------------------------------------------------ */
/* The shape rule, on its own (UC-08 E2a, "not letters, numbers and   */
/* hyphens")                                                          */
/* ------------------------------------------------------------------ */

describe("webAddressRefusal", () => {
  it("accepts letters, numbers and hyphens", () => {
    for (const address of ["rivals", "spring-lan-2026", "s1", "a-b-c"]) {
      expect(webAddressRefusal(address)).toBeNull();
    }
  });

  it("names the address and the rule when it holds anything else", () => {
    // The sentence has to identify what was wrong with *this* address, not
    // state a policy — the manager is looking at a box they just typed in.
    for (const address of ["summer cup", "summer_cup", "cup!", "café", "a/b", "a.b"]) {
      const refusal = webAddressRefusal(address);
      expect(refusal).toContain(address);
      expect(refusal).toMatch(/letters, numbers and hyphens/i);
    }
  });

  it("refuses an empty address rather than inventing one", () => {
    expect(webAddressRefusal("")).toMatch(/give the event a web address/i);
  });

  it("refuses a hyphen at either end", () => {
    expect(webAddressRefusal("-cup")).toMatch(/cannot start or end with a hyphen/i);
    expect(webAddressRefusal("cup-")).toMatch(/cannot start or end with a hyphen/i);
  });

  it("refuses one past the length the box allows", () => {
    expect(webAddressRefusal("a".repeat(SLUG_MAX))).toBeNull();
    expect(webAddressRefusal("a".repeat(SLUG_MAX + 1))).toMatch(/at most 64 characters/i);
  });

  it("treats case as case and not as content", () => {
    // Lowercasing is not a repair: no character the manager typed is dropped
    // or replaced, so there is nothing for them to be told about.
    expect(readWebAddress("  Summer-Cup  ")).toBe("summer-cup");
    expect(webAddressRefusal(readWebAddress("Summer-Cup"))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* UC-08 E2 — "manager changes the web address - System saves it"     */
/* ------------------------------------------------------------------ */

describe("UC-08 E2: changing the web address", () => {
  it("saves it", async () => {
    const event = await anEvent("Address change");

    const updated = expectOk(await updateEvent(event.id, { slug: "tuesday-night" }, db));

    expect(updated.slug).toBe("tuesday-night");
    expect(await storedAddress(event.id)).toBe("tuesday-night");
  });

  it("saves a typed address in lower case, since the case is all that moved", async () => {
    const event = await anEvent("Address case");

    expect(expectOk(await updateEvent(event.id, { slug: " Friday-Night " }, db)).slug).toBe(
      "friday-night"
    );
  });

  it("lets an event keep the address it already has", async () => {
    // Re-saving Basics sends the address back unchanged. "Taken" must not mean
    // "taken by me", or every second save of an untouched form would fail.
    const event = await anEvent("Address unchanged");

    expect(expectOk(await updateEvent(event.id, { slug: event.slug }, db)).slug).toBe(event.slug);
  });
});

/* ------------------------------------------------------------------ */
/* UC-08 E2a — rejects with the reason; the old address stays         */
/* ------------------------------------------------------------------ */

describe("UC-08 E2a: an address that cannot be used", () => {
  it("refuses an address another event holds, naming it", async () => {
    const holder = await anEvent("Address holder");
    const wanter = await anEvent("Address wanter");

    const refusal = expectFail(await updateEvent(wanter.id, { slug: holder.slug }, db));

    expect(refusal.error).toContain(holder.slug);
    expect(refusal.error).toMatch(/already another event's address/i);
  });

  it("leaves the old address standing when the new one is taken", async () => {
    const holder = await anEvent("Keeps holder");
    const wanter = await anEvent("Keeps wanter");

    expectFail(await updateEvent(wanter.id, { slug: holder.slug }, db));

    expect(await storedAddress(wanter.id)).toBe(wanter.slug);
    // And the event that holds it is untouched, which `-2` suffixing would
    // also have managed — the point is that neither row moved.
    expect(await storedAddress(holder.id)).toBe(holder.slug);
  });

  it("refuses characters that are not letters, numbers or hyphens", async () => {
    const event = await anEvent("Address shape");

    const refusal = expectFail(await updateEvent(event.id, { slug: "Summer Cup!" }, db));

    expect(refusal.error).toMatch(/letters, numbers and hyphens/i);
    // The defect this replaces: `slugify` turned it into `summer-cup` and the
    // save succeeded. If it had, the stored address would be that.
    expect(await storedAddress(event.id)).toBe(event.slug);
    expect(await storedAddress(event.id)).not.toBe("summer-cup");
  });

  it("refuses an address with nothing usable in it at all", async () => {
    const event = await anEvent("Address empty");

    expect(expectFail(await updateEvent(event.id, { slug: "!!!" }, db)).error).toMatch(
      /letters, numbers and hyphens/i
    );
    expect(expectFail(await updateEvent(event.id, { slug: "   " }, db)).error).toMatch(
      /give the event a web address/i
    );
    expect(await storedAddress(event.id)).toBe(event.slug);
  });

  it("saves none of the rest of the patch either", async () => {
    // "Nothing saved" is UC-08 10c's rule for a refused setup and this is the
    // same door, so a bad address must not let a good title through beside it.
    const event = await anEvent("Address atomic");
    const was = (await getEventById(event.id, {}, db))?.title;

    expectFail(await updateEvent(event.id, { title: "Renamed", slug: "no good!" }, db));

    expect((await getEventById(event.id, {}, db))?.title).toBe(was);
  });
});

/* ------------------------------------------------------------------ */
/* The address nobody typed (UC-08 2)                                 */
/* ------------------------------------------------------------------ */

describe("the address derived from a title", () => {
  it("still disambiguates itself, because nobody chose it", async () => {
    counter += 1;
    const first = expectOk(await createEvent({ title: `Derived ${counter}` }, db));
    const second = expectOk(await createEvent({ title: `Derived ${counter}` }, db));

    expect(second.slug).not.toBe(first.slug);
    expect(second.slug).toBe(`${first.slug}-2`);
  });
});
