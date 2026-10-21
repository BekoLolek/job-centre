import { renderToReadableStream } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, games, profileFields, profileValues } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  type EventResult,
  applyToEvent,
  createEvent,
  publishEvent,
  setApplicationStatus,
  withdrawApplication,
} from "@/lib/events";

/*
 * The member dashboard's two extension flows (R-123, R-124 / UC-13 E1, E2).
 *
 * > **E1.** At step 2, System also lists events taking applications that the
 * > member has not applied to.
 * >
 * > **E2.** At step 2, System shows how many of the member's profile details
 * > are answered, linking the profile.
 *
 * E1 existed and had a bug in the middle of it: the "has not applied to" set
 * excluded **declined** applications alongside withdrawn ones, so the one
 * event on the site a declined member cannot apply to was the one the
 * dashboard offered them an Apply button for — and `applyToEvent` turns it
 * down (R-122 / UC-12 E2). Withdrawn is the opposite case and must stay in the
 * list (R-121 / UC-12 E1), which is why both are asserted here: a fix that
 * excluded neither, or both, is as wrong as the original.
 *
 * E2 did not exist at all. `loadProfile` has counted completeness since UC-04
 * and nothing on this page said the number.
 *
 * Mocked as `src/app/events/[slug]/__tests__/day-panel.test.ts` mocks.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  const db = new Proxy({} as Database, {
    get(_target, property) {
      const real = state.db as unknown as Record<string | symbol, unknown>;
      const value = Reflect.get(real, property, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
  return { ...actual, db };
});

vi.mock("@/lib/auth", () => ({
  SIGN_IN_PATH: "/signin",
  auth: async () => (state.userId ? { user: { id: state.userId } } : null),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  };
});

const { default: MePage } = await import("../page");

let harness: TestDatabase;
let db: Database;

/** Wide against the real clock: the page reads `new Date()` itself. */
const WINDOW = {
  signupOpensAt: new Date("2000-01-01T00:00:00Z"),
  signupClosesAt: new Date("2100-01-01T00:00:00Z"),
  days: [{ startsAt: new Date("2100-01-02T18:00:00Z") }],
};

function expectOk<T>(result: EventResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got: ${result.error}`);
  return result.data;
}

let counter = 0;

async function openEvent(title: string): Promise<{ id: string; slug: string; title: string }> {
  counter += 1;
  const created = expectOk(
    await createEvent({ title: `${title} ${counter}`, capacity: 8, ...WINDOW }, db)
  );
  expectOk(await publishEvent(created.id, db));
  return { id: created.id, slug: created.slug, title: created.title };
}

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
  state.db = db;
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await db.delete(profileValues);
  await db.delete(profileFields);
  await db.delete(games);
});

/** The dashboard as that member reads it: no tags, no entities. */
async function text(): Promise<string> {
  const page = await MePage();
  const stream = await renderToReadableStream(page);
  await stream.allReady;

  return (await new Response(stream).text())
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* UC-13 E1 — what is taking applications that I have not applied to  */
/* ------------------------------------------------------------------ */

/**
 * Just the "Taking applications" section.
 *
 * The whole page names an event in up to three places — the next event, the
 * open applications list, and this section — so a `toContain` over all of it
 * would pass for an event the member has already applied to. Narrowed to the
 * section between its own heading and the one after it.
 *
 * **Throws** when the heading is not there, rather than returning "". Most of
 * what this helper is asked is `not.toContain`, and an empty string satisfies
 * every one of those — so a page that stopped rendering the section at all, or
 * renamed its heading, would turn the negative tests below green while taking
 * the feature away. An empty haystack is not evidence; it is the absence of
 * any.
 */
function openToJoin(rendered: string): string {
  const from = rendered.indexOf("Taking applications");
  if (from === -1) {
    throw new Error(
      "The dashboard rendered no 'Taking applications' section, so there is nothing for this assertion to be about."
    );
  }
  const to = rendered.indexOf("Elsewhere", from);
  return rendered.slice(from, to === -1 ? undefined : to);
}

describe("UC-13 E1: events taking applications", () => {
  it("lists one the member has not applied to", async () => {
    const event = await openEvent("Unapplied");
    state.userId = await makeUser(db);

    expect(openToJoin(await text())).toContain(event.title);
  });

  it("leaves out one they already hold a seat for", async () => {
    const event = await openEvent("Already in");
    const userId = await makeUser(db);
    expectOk(await applyToEvent(event.id, userId, {}, db));
    state.userId = userId;

    const rendered = await text();
    expect(openToJoin(rendered)).not.toContain(event.title);
    // It is on the page, under their open applications — so the assertion
    // above is about the section and not about the event having vanished.
    expect(rendered).toContain(event.title);
  });

  it("lists one they WITHDREW from, because applying again is allowed", async () => {
    // R-121 / UC-12 E1: "System lets them apply again; they go to the back of
    // the queue." So it belongs on the list of what they can join.
    const event = await openEvent("Withdrew from");
    const userId = await makeUser(db);
    expectOk(await applyToEvent(event.id, userId, {}, db));
    expectOk(await withdrawApplication(event.id, userId, db));
    state.userId = userId;

    expect(openToJoin(await text())).toContain(event.title);
  });

  it("leaves out one they were DECLINED for, because applying is refused", async () => {
    // The bug. R-122 beats R-121 and `applyToEvent` refuses them, so an Apply
    // button here was an invitation into a refusal.
    const event = await openEvent("Declined for");
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, {}, db));
    expectOk(await setApplicationStatus(application.id, "declined", {}, db));
    // An event they *can* join, created last so `bySoonest` puts it first
    // among these same-day events and the four-card slice cannot be what hides
    // it. The absence of the declined one is then a filter, not an empty list.
    const joinable = await openEvent("Still open to them");
    state.userId = userId;

    const section = openToJoin(await text());
    expect(section).toContain(joinable.title);
    expect(section).not.toContain(event.title);
  });

  it("leaves out one whose sign-ups are shut", async () => {
    counter += 1;
    const shut = expectOk(
      await createEvent(
        {
          title: `Shut ${counter}`,
          capacity: 8,
          signupOpensAt: new Date("2000-01-01T00:00:00Z"),
          signupClosesAt: new Date("2000-02-01T00:00:00Z"),
          days: [{ startsAt: new Date("2100-01-02T18:00:00Z") }],
        },
        db
      )
    );
    expectOk(await publishEvent(shut.id, db));
    // Created last, so `bySoonest` puts it first among these same-day events
    // and the four-card slice cannot be what hides it: the section is proven
    // to be listing an open event, and the shut one is still absent.
    const stillOpen = await openEvent("Open beside the shut one");
    state.userId = await makeUser(db);

    const section = openToJoin(await text());
    expect(section).toContain(stillOpen.title);
    expect(section).not.toContain(shut.title);
  });
});

/* ------------------------------------------------------------------ */
/* UC-13 E2 — how much of the profile is answered                     */
/* ------------------------------------------------------------------ */

describe("UC-13 E2: how many profile details are answered", () => {
  /** Three questions on one game, so the figure has a denominator to be wrong. */
  async function threeQuestions(): Promise<string[]> {
    const [game] = await db
      .insert(games)
      .values({ key: "rivals", name: "Marvel Rivals", rankLadder: ["Gold", "Platinum"] })
      .returning({ id: games.id });

    const rows = await db
      .insert(profileFields)
      .values([
        { gameId: game.id, key: "rank", label: "Rank", type: "rank", sort: 0, required: true },
        { gameId: game.id, key: "ign", label: "In-game name", type: "text", sort: 1 },
        { gameId: game.id, key: "role", label: "Role", type: "text", sort: 2 },
      ])
      .returning({ id: profileFields.id });
    return rows.map((row) => row.id);
  }

  it("says none of them when the member has answered nothing", async () => {
    await threeQuestions();
    state.userId = await makeUser(db);

    const rendered = await text();
    expect(rendered).toContain("Profile details");
    expect(rendered).toContain("0/3");
  });

  it("counts the ones that have an answer", async () => {
    const [rank, ign] = await threeQuestions();
    const userId = await makeUser(db);
    await db.insert(profileValues).values([
      { userId, fieldId: rank, value: "Gold" },
      { userId, fieldId: ign, value: "Beko" },
    ]);
    state.userId = userId;

    expect(await text()).toContain("2/3");
  });

  it("counts the optional ones too, so it answers 'how complete'", async () => {
    /*
     * Only the rank question is `required`, and it is the one left blank — so
     * the two answers here are both optional. An honest count says 2 of 3; a
     * count built from `Completeness`, which counts only required fields,
     * would say 0 of 1. Answering the required one instead would have made
     * this test pass against either, which is the trap: the fixture has to
     * make the filter it is testing matter.
     */
    const [, ign, role] = await threeQuestions();
    const userId = await makeUser(db);
    await db.insert(profileValues).values([
      { userId, fieldId: ign, value: "Beko" },
      { userId, fieldId: role, value: "Duelist" },
    ]);
    state.userId = userId;

    const rendered = await text();
    expect(rendered).toContain("2/3");
    expect(rendered).not.toContain("0/1");
  });

  it("does not count a blank stored answer as an answer", async () => {
    const [rank, ign] = await threeQuestions();
    const userId = await makeUser(db);
    await db.insert(profileValues).values([
      { userId, fieldId: rank, value: "Gold" },
      { userId, fieldId: ign, value: "" },
    ]);
    state.userId = userId;

    expect(await text()).toContain("1/3");
  });

  it("links the profile, because the figure is only useful next to the fix", async () => {
    await threeQuestions();
    state.userId = await makeUser(db);

    const page = await MePage();
    const stream = await renderToReadableStream(page);
    await stream.allReady;
    const markup = await new Response(stream).text();

    expect(markup).toMatch(/Profile details[\s\S]{0,200}href="\/me\/profile"/);
  });

  it("says nothing at all when the admin has defined no questions", async () => {
    // "0 of 0" is not a fact about the member, and the member cannot act on it.
    state.userId = await makeUser(db);

    const rendered = await text();
    // The header panel the tile would have sat in, so a page that failed to
    // render cannot pass this by saying nothing at all.
    expect(rendered).toContain("Live applications");
    expect(rendered).not.toContain("Profile details");
  });
});
