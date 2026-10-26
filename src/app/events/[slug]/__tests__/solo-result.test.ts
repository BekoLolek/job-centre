import { createHash } from "node:crypto";
import { renderToReadableStream } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, type EventConfig, matches, teams } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/**
 * The solo result on the public event page (R-234, R-235 / UC-46 4, 4a), and
 * the proof that a team event's page did not move while it was added.
 *
 * > **UC-46 4.** Visitor sees the same table on the event's page, and the
 * > winner in its result line.
 * > **4a.** Nothing is scored yet — the event page says the night has not been
 * > scored, rather than showing an empty table.
 *
 * ## Rendered as the route, for `draw-link.test.ts`'s reason
 *
 * Every assertion is against `EventPage({ params, searchParams })`'s own
 * markup over a real Postgres, because this project has twice had a page
 * change that every component test stayed green through. The only things
 * replaced are the session cookie, the page cache and `useRouter`.
 *
 * ## "A team event is unchanged" is a digest, not an inspection
 *
 * The podium panel and the Results tab of a bracket event are rendered and
 * hashed, and the hash is pinned to what the tree **before this task**
 * produced over the same fixture. A fixture whose expected markup is a
 * constant cannot drift with the change that is being checked against it.
 *
 * Two things make the hash deterministic, and both are asserted as premises
 * rather than assumed: the fixture records its results at a fixed instant
 * (`recordGames`' `now`), and `LocalTime` formats in the deployment's zone and
 * locale, so the zone is pinned to UTC for this file and the locale is
 * checked to be an English one. A premise that fails says so by name instead
 * of reporting the podium "changed".
 */

const state = vi.hoisted(() => {
  // Before any module formats a date. Node re-reads TZ at runtime.
  process.env.TZ = "UTC";
  return {
    db: undefined as unknown as Database,
    userId: null as string | null,
  };
});

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

const { default: EventPage } = await import("../page");
const { applyToEvent, createEvent, publishEvent } = await import("@/lib/events");
const { generateMatches, recordGames, setStages } = await import("@/lib/format");
const { saveRound } = await import("@/lib/round-scores");

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
  state.db = db;
});

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  state.userId = null;
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

let counter = 0;

const SOLO: EventConfig = {
  eventShape: { teamEvent: false, draft: false, sizing: { mode: "perTeam", value: 6 } },
};

/** Two rounds, the second named, one bonus — the smallest setup with every part R-234 lists. */
function roundScoring(rounds: number) {
  return {
    rounds: Array.from({ length: rounds }, (_, index) => ({
      name: index === rounds - 1 ? "Final" : null,
    })),
    lowWins: false,
    bonuses: [{ key: "Gold run", value: 5 }],
  };
}

type Night = {
  slug: string;
  title: string;
  /** Display name to user id. */
  ids: Record<string, string>;
};

/**
 * A published solo night scored in `rounds` rounds, with these players seated
 * and these rows written through `saveRound` — the real write, so what the page
 * reads is what a manager's save produced.
 */
async function soloNight(options: {
  rounds: number;
  /** Player name to their score per round; `null` is a blank. */
  scores: Record<string, Array<number | null>>;
  bonuses?: Record<string, Record<number, Record<string, number>>>;
  roundScored?: boolean;
}): Promise<Night> {
  counter += 1;
  const title = `Solo night ${counter}`;
  const created = await createEvent(
    {
      ...PUBLISHABLE,
      title,
      capacity: 64,
      config: options.roundScored === false ? SOLO : { ...SOLO, roundScoring: roundScoring(options.rounds) },
    },
    db
  );
  if (!created.ok) throw new Error(created.error);
  const published = await publishEvent(created.data.id, db);
  if (!published.ok) throw new Error(published.error);

  const ids: Record<string, string> = {};
  for (const name of Object.keys(options.scores)) {
    const userId = await makeUser(db, { displayName: name });
    ids[name] = userId;
    const applied = await applyToEvent(created.data.id, userId, {}, db);
    if (!applied.ok) throw new Error(applied.error);
  }

  for (let round = 1; round <= options.rounds; round += 1) {
    const entries = Object.entries(options.scores).map(([name, scores]) => ({
      userId: ids[name],
      score: scores[round - 1] ?? null,
      bonuses: options.bonuses?.[name]?.[round] ?? {},
    }));
    if (entries.every((entry) => entry.score === null)) continue;
    const saved = await saveRound(created.data.id, { roundIndex: round, entries, expected: [] }, db);
    if (!saved.ok) throw new Error(saved.error);
  }

  return { slug: created.data.slug, title, ids };
}

/** Every result recorded at the same instant, so nothing on the page is the clock. */
const FIXED_NOW = new Date("2100-01-02T19:00:00Z");

/**
 * A published four-team single elimination, fully played: seed 1 beats seed 4
 * and then seed 2. The team names, the slug and every instant are constants,
 * which is what lets its markup be pinned as a digest.
 */
let team: Promise<Night> | null = null;

function teamEvent(): Promise<Night> {
  team ??= buildTeamEvent();
  return team;
}

async function buildTeamEvent(): Promise<Night> {
  const title = "Hashed team event";
  const created = await createEvent({ ...PUBLISHABLE, title, capacity: 16 }, db);
  if (!created.ok) throw new Error(created.error);
  const published = await publishEvent(created.data.id, db);
  if (!published.ok) throw new Error(published.error);
  const eventId = created.data.id;

  for (let i = 1; i <= 4; i += 1) {
    await db
      .insert(teams)
      .values({ eventId, name: `Team ${i}`, seed: i, sort: i, balanceStart: 1000 });
  }
  const staged = await setStages(eventId, [{ kind: "single_elim" }], db);
  if (!staged.ok) throw new Error(staged.error);
  const generated = await generateMatches(staged.data[0].id, db);
  if (!generated.ok) throw new Error(generated.error);
  // §8.4's coin is a real toss at generation, and the Results tab prints who
  // it favoured on every game — so it is the one random thing on the tab, and
  // it is pinned here rather than hashed by luck.
  await db.update(matches).set({ firstSideChoice: "a" }).where(eq(matches.eventId, eventId));

  for (const slot of ["sf1", "sf2", "f"]) {
    const rows = await db.select().from(matches).where(eq(matches.eventId, eventId));
    const row = rows.find((match) => match.slot === slot);
    if (!row) throw new Error(`no match ${slot}`);
    const target = Math.floor(row.bestOf / 2) + 1;
    const recorded = await recordGames(
      row.id,
      Array.from({ length: target }, (_, index) => ({
        index,
        map: `Map ${index + 1}`,
        referee: "Zoe",
        scoreA: 3,
        scoreB: 1,
        played: true,
      })),
      { now: FIXED_NOW },
      db
    );
    if (!recorded.ok) throw new Error(recorded.error);
  }

  return { slug: created.data.slug, title, ids: {} };
}

/** The route's own markup, as the server sends it. */
async function render(slug: string, tab?: string): Promise<string> {
  const page = await EventPage({
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve(tab ? { tab } : {}),
  });
  const stream = await renderToReadableStream(page);
  await stream.allReady;
  return await new Response(stream).text();
}

/** The same, as words: no tags, no entities. */
function words(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/<!--.*?-->/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/** Does the tab strip offer this event's Results tab? The attribute, not the word. */
function offersResultsTab(markup: string, slug: string): boolean {
  return markup.includes(`href="/events/${slug}?tab=results"`);
}

/**
 * A slice of the page between two markers, each asserted to exist. A helper
 * that returned `""` for a missing marker would make every digest below a hash
 * of nothing, which is the vacuous pass this project has met before.
 */
function slice(markup: string, from: string, to: string, after = 0): string {
  const start = markup.indexOf(from, after);
  expect(start, `the page no longer has "${from}"`).toBeGreaterThan(-1);
  const end = markup.indexOf(to, start);
  expect(end, `"${from}" is no longer followed by "${to}"`).toBeGreaterThan(start);
  return markup.slice(start, end + to.length);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/* ------------------------------------------------------------------ */
/* UC-46 4 — the winner in the result line, the table on the tab        */
/* ------------------------------------------------------------------ */

describe("UC-46 4: a scored solo night on its public page", () => {
  it("names the winner in the result line, and offers the Results tab", async () => {
    const night = await soloNight({
      rounds: 2,
      scores: { "Ada Winner": [10, 10], "Bo Second": [8, 1] },
    });

    const markup = await render(night.slug);
    const rendered = words(markup);
    expect(rendered).toContain(night.title);
    expect(rendered).toContain("Won by Ada Winner.");
    expect(offersResultsTab(markup, night.slug)).toBe(true);
  });

  it("shows the table — every round, every bonus, every total — on the Results tab", async () => {
    const night = await soloNight({
      rounds: 2,
      scores: { "Ada Winner": [10, 10], "Bo Second": [8, 1] },
      bonuses: { "Bo Second": { 2: { "Gold run": 2 } } },
    });

    const rendered = words(await render(night.slug, "results"));
    // Both rounds by name — the given one and the "Round N" the other falls back to.
    expect(rendered).toContain("Round 1");
    expect(rendered).toContain("Final");
    // Each player's rounds beside their total, in reading order: place, name,
    // the rounds, the total. The parts R-234 says a total must come with.
    expect(rendered).toContain("1 Ada Winner 10 10 20");
    expect(rendered).toContain("2 Bo Second 8 1 Gold run ×2 19");
    // And what the bonus is worth, so the 19 can be checked by hand.
    expect(rendered).toContain("Gold run is worth 5");
  });

  it("lets a participant find their own rounds (R-235)", async () => {
    const night = await soloNight({
      rounds: 3,
      scores: { "Ada Winner": [10, 10, 10], "Bo Second": [8, null, 2] },
    });
    state.userId = night.ids["Bo Second"];

    const rendered = words(await render(night.slug, "results"));
    // A blank round is shown as a blank, never as a zero (R-228) — and the
    // table says what a blank counts as.
    expect(rendered).toContain("2 Bo Second 8 — 2");
    expect(rendered).toContain("blank round counts as");
  });

  it("names both winners of a shared first place on the one line", async () => {
    const night = await soloNight({
      rounds: 1,
      scores: { "Zed Tied": [10], "Amy Tied": [10], "Cy Third": [2] },
    });

    expect(words(await render(night.slug))).toContain("Amy Tied and Zed Tied share first place.");
  });

  it("says who leads, and how many rounds are in, while the night is part-scored", async () => {
    const night = await soloNight({
      rounds: 3,
      scores: { "Ada Winner": [10, null, null], "Bo Second": [8, null, null] },
    });

    const rendered = words(await render(night.slug));
    expect(rendered).toContain("Ada Winner leads after 1 of 3 rounds.");
    expect(rendered).not.toContain("Won by");
  });
});

/* ------------------------------------------------------------------ */
/* UC-46 4a — nothing scored                                           */
/* ------------------------------------------------------------------ */

describe("UC-46 4a: a round-scored night nobody has scored", () => {
  it("says the night has not been scored, and offers no empty Results tab", async () => {
    const night = await soloNight({ rounds: 3, scores: { "Ada Waiting": [null, null, null] } });

    const markup = await render(night.slug);
    const rendered = words(markup);
    expect(rendered).toContain(night.title);
    expect(rendered).toContain("This night has not been scored yet.");
    expect(rendered).not.toContain("Won by");
    expect(offersResultsTab(markup, night.slug)).toBe(false);
  });

  it("says nothing of the sort for a solo night that is not scored in rounds", async () => {
    // The direction that would stamp "not been scored" on every Jackbox night.
    const night = await soloNight({
      rounds: 0,
      scores: { "Ada Jackbox": [] },
      roundScored: false,
    });

    const markup = await render(night.slug);
    const rendered = words(markup);
    expect(rendered).toContain(night.title);
    expect(rendered).not.toContain("has not been scored");
    expect(rendered).not.toContain("Won by");
    expect(offersResultsTab(markup, night.slug)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* A team event is unchanged — pinned, not inspected                   */
/* ------------------------------------------------------------------ */

/**
 * What the tree before this task rendered for `teamEvent()`, hashed. Computed
 * once against HEAD `f497d04` and pinned; a change to the team path of
 * `podiumFor`, the podium panel or the match Results tab moves one of these.
 */
const PODIUM_BEFORE = "28d5e25a7cf0f288496d077e87698ed8f11da3eec30e832788c9c21a39af763a";
const RESULTS_TAB_BEFORE = "741d9b26ea9cbb6bf5763615b21aa23afd481d3ad906a967f625abbb03bb5ba9";

describe("a team event's page is exactly what it was", () => {
  it("renders in the zone and locale the digests were taken in", () => {
    // The premises. Failing here says "your machine formats dates differently",
    // which is a different sentence from "the podium changed".
    expect(new Date("2100-01-02T19:00:00Z").getTimezoneOffset()).toBe(0);
    expect(Intl.DateTimeFormat().resolvedOptions().locale.startsWith("en")).toBe(true);
  });

  it("keeps its podium panel byte for byte", async () => {
    const event = await teamEvent();
    const markup = await render(event.slug);

    const podium = slice(markup, "Final standings", "</section>");
    // The premise of the digest: this really is the podium, with the champion in it.
    expect(words(podium)).toContain("Champion");
    expect(words(podium)).toContain("Team 1");
    expect(sha256(podium)).toBe(PODIUM_BEFORE);
  });

  it("keeps its Results tab byte for byte", async () => {
    const event = await teamEvent();
    const markup = await render(event.slug, "results");

    // The tab's content is everything from the first section after the tab
    // strip to the page's last closing section.
    const tab = markup.indexOf(">Results<");
    expect(tab, "the tab strip no longer has a Results tab").toBeGreaterThan(-1);
    const start = markup.indexOf("<section", tab);
    const end = markup.lastIndexOf("</section>");
    expect(start, "no section follows the tab strip").toBeGreaterThan(tab);
    expect(end).toBeGreaterThan(start);
    const results = markup.slice(start, end + "</section>".length);
    expect(words(results)).toContain("3 matches");
    expect(words(results)).toContain("Team 1");
    expect(sha256(results)).toBe(RESULTS_TAB_BEFORE);
  });

  it("carries none of the solo night's sentences", async () => {
    const event = await teamEvent();
    const rendered = words(await render(event.slug));
    expect(rendered).toContain("Champion");
    expect(rendered).not.toContain("Won by");
    expect(rendered).not.toContain("has not been scored");
    expect(rendered).not.toContain("share first place");
  });
});
