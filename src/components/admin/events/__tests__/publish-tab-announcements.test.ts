import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, SETTING_KEYS, announcementClaims, events } from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import type { AnnouncementSettings } from "@/lib/announce";
import {
  MANUAL_ANNOUNCEMENT_NAMES,
  MANUAL_REFUSALS,
  alreadyPostedWarning,
  switchedOffNote,
} from "@/lib/announce-manual";

/*
 * Nothing here calls a server action — the panel is rendered, not driven — but
 * importing the tab imports its `"use server"` module, which reaches
 * `@/lib/auth` and `next/server`. Replaced exactly as `save-as-template.test.ts`
 * replaces them, and for the same reason.
 */
vi.mock("@/lib/auth", () => ({
  SIGN_IN_PATH: "/signin",
  auth: async () => null,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

const { default: PublishTab } = await import("../PublishTab");
const { createEvent, getEventById } = await import("@/lib/events");
const { manualAnnouncementPanel, setAnnouncementSettings, setIntegrationSetting } = await import(
  "@/lib/discord"
);
const { addCountingEvent, createChampionship } = await import("@/lib/championships");
const { defaultAnnouncementSettings } = await import("@/lib/announce");
const { whenText } = await import("@/components/events");

/**
 * The Publish tab's announcement panel (R-221 to R-223 / UC-43 2, 2a, 2b, 3a).
 *
 * ## Rendered from a real panel read, not from a hand-written prop
 *
 * Every test below builds a real event, asks `manualAnnouncementPanel` what the
 * server would say about it, and renders the tab with that. A literal fixture
 * would let the panel and the screen drift apart — the shape would stay
 * plausible while the server stopped producing it — and the whole point of this
 * file is that what the admin sees is what the database says.
 *
 * ## What it cannot do
 *
 * The suite runs in vitest's `node` environment: no DOM, no jsdom, no
 * testing-library, **nothing to click**. So no test here presses a button, and
 * none pretends to. The confirm flow is a pure function (`manualPostStep`) and
 * is tested directly in `src/lib/__tests__/announce-manual.test.ts`; what is
 * pinned here is the state that *arrives* — which rows exist, which say they
 * are off, which say why they cannot be posted, and that the confirmation
 * sentence is nowhere on the page until somebody asks for it.
 *
 * ## And the half a component test cannot reach at all
 *
 * The last two tests read the page and the editor off disk. Without them,
 * deleting `announcements={announcements}` from either leaves every test in
 * this file green — they render the component directly — while the real screen
 * crashes or shows an empty panel. That is not a hypothetical: it is how
 * `roles={roles}` was deleted on this project with the suite still passing.
 */

const ROOT = path.resolve(__dirname, "../../../../..");
const PAGE = path.join(ROOT, "src/app/admin/events/[id]/page.tsx");
const EDITOR = path.join(ROOT, "src/components/admin/events/EventEditor.tsx");

let handle: TestDatabase;
let db: Database;
let counter = 0;

const NOW = new Date("2026-06-01T12:00:00Z");
const DAY = 86_400_000;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await setIntegrationSetting(SETTING_KEYS.webhookUrl, "https://discord.test/api/webhooks/1/t", db);
  await switches();
});

/** Switch exactly these on, everything else off. */
async function switches(on: Partial<AnnouncementSettings> = {}) {
  const off = Object.fromEntries(
    Object.keys(defaultAnnouncementSettings()).map((kind) => [kind, false])
  ) as AnnouncementSettings;
  await setAnnouncementSettings({ ...off, ...on }, db);
}

/** A publishable event, and whatever the panel says about it. */
async function tab(
  setup: {
    days?: readonly { startsAt: Date }[];
    signupClosesAt?: Date | null;
    status?: "draft" | "published";
    inSeason?: boolean;
  } = {}
) {
  counter += 1;
  const made = await createEvent(
    {
      title: `Announce panel ${counter}`,
      signupOpensAt: new Date(NOW.getTime() - DAY),
      signupClosesAt: setup.signupClosesAt === undefined ? new Date(NOW.getTime() + DAY) : setup.signupClosesAt,
      days: [...(setup.days ?? [{ startsAt: new Date(NOW.getTime() + 2 * DAY) }])],
    },
    db
  );
  if (!made.ok) throw new Error(made.error);
  const eventId = made.data.id;

  if (setup.status === "published") {
    await db.update(events).set({ status: "published" }).where(eq(events.id, eventId));
  }
  if (setup.inSeason) {
    const season = await createChampionship({ name: `Panel cup ${counter}` }, db);
    if (!season.ok) throw new Error(season.error);
    const added = await addCountingEvent(season.data.id, eventId, db);
    if (!added.ok) throw new Error(added.error);
  }

  const event = await getEventById(eventId, { now: NOW }, db);
  if (!event) throw new Error("the event vanished");
  const announcements = await manualAnnouncementPanel(eventId, db);

  return {
    eventId,
    announcements,
    markup: renderToStaticMarkup(
      createElement(PublishTab, { event, applicants: [], queue: 0, announcements })
    ),
  };
}

/* --------------------------------------------------------------------- */
/* UC-43 2 — the five, listed                                            */
/* --------------------------------------------------------------------- */

describe("the panel lists what can be posted (UC-43 2)", () => {
  it("offers the four kinds of an event in no championship, by name", async () => {
    const { markup } = await tab();

    for (const name of ["New event", "Applications open", "Closing soon", "Starting soon"]) {
      expect(markup, name).toContain(`>${name}</h3>`);
    }
    // And a button for each: four rows, four presses.
    expect(markup.match(/Post now/g)).toHaveLength(4);
  });

  it("does not offer standings at all for an event in no championship (UC-43 2b)", async () => {
    const { markup, announcements } = await tab();

    // Absent, not offered-and-refused: no heading, and nothing on the page
    // explaining why it is not there.
    expect(markup).not.toContain(">Standings</h3>");
    expect(markup).not.toContain(MANUAL_REFUSALS.noChampionship);
    // And the four that are offered really are on screen, so "absent" is not
    // the whole panel being absent.
    expect(markup).toContain(">Starting soon</h3>");
    expect(announcements.rows).toHaveLength(4);
  });

  it("offers standings once the event counts towards a season (UC-43 2b)", async () => {
    const { markup } = await tab({ inSeason: true });

    expect(markup).toContain(">Standings</h3>");
    expect(markup.match(/Post now/g)).toHaveLength(5);
  });

  it("says what each post would contain", async () => {
    const { markup, announcements } = await tab();
    for (const row of announcements.rows) {
      expect(markup, row.kind).toContain(row.detail);
    }
  });
});

/* --------------------------------------------------------------------- */
/* R-223 / UC-43 2a — a switched-off kind                                */
/* --------------------------------------------------------------------- */

describe("a kind whose switch is off (R-223 / UC-43 2a)", () => {
  it("is still offered, and the screen says it is off", async () => {
    // Everything off but the published one, so the two states are both on
    // screen and one cannot be mistaken for the other.
    await switches({ event_published: true });
    const { markup } = await tab();

    // The whole sentence, which says both halves: it is off, and this posts it
    // anyway. A `toContain` on "switched off" would be satisfied by a screen
    // that only said the first half.
    expect(markup).toContain(
      "“Closing soon” is switched off, so nothing posts it on its own. " +
        "This button posts it anyway."
    );
    expect(markup).toContain(switchedOffNote("signups_closing_soon"));
    // Still offered: the row has its button.
    expect(markup).toContain(">Closing soon</h3>");
    expect(markup.match(/Post now/g)).toHaveLength(4);
  });

  it("says nothing of the sort about a kind that is switched on", async () => {
    await switches({ event_published: true });
    const { markup } = await tab();

    // The other half, and the reason the test above is not satisfied by a
    // screen that prints the note on every row.
    expect(markup).not.toContain(switchedOffNote("event_published"));
    expect(markup.match(/is switched off/g)).toHaveLength(3);
  });
});

/* --------------------------------------------------------------------- */
/* UC-43 4a — a message that cannot be built honestly                    */
/* --------------------------------------------------------------------- */

describe("a kind whose message cannot be built (UC-43 4a)", () => {
  it("says what is missing and offers no button for that kind", async () => {
    // No days at all, so the event has no dated day to announce (R-24).
    const { markup } = await tab({ days: [] });

    expect(markup).toContain(
      "This event has no dated day, so there is no start time to announce. " +
        "Give it a day on the Days tab first."
    );
    /*
     * Three buttons, not four: the refused row offers none. Counted, because
     * "the sentence is on screen" is equally true of a screen that shows the
     * reason *and* an enabled button beside it.
     */
    expect(markup.match(/Post now/g)).toHaveLength(3);
    // And the row is still listed, so the admin can see what they are missing.
    expect(markup).toContain(">Starting soon</h3>");
  });

  it("refuses closing-soon for an event with no closing time, and still offers the rest", async () => {
    const { markup } = await tab({ signupClosesAt: null });

    expect(markup).toContain(
      "This event has no closing time, so there is nothing to count down to. " +
        "Set one on the Setup tab first."
    );
    expect(markup).not.toContain(MANUAL_REFUSALS.noDatedDay);
    expect(markup.match(/Post now/g)).toHaveLength(3);
  });
});

/* --------------------------------------------------------------------- */
/* R-222 / UC-43 3a — already posted                                     */
/* --------------------------------------------------------------------- */

describe("a kind that has already gone out (R-222 / UC-43 3a)", () => {
  it("says when it went, and the button offers to post it again", async () => {
    const { eventId } = await tab();
    const went = new Date("2026-05-20T19:30:00.000Z");
    await db
      .insert(announcementClaims)
      .values({ kind: "event_published", eventId, claimedAt: went });

    const event = await getEventById(eventId, { now: NOW }, db);
    const announcements = await manualAnnouncementPanel(eventId, db);
    const markup = renderToStaticMarkup(
      createElement(PublishTab, { event: event!, applicants: [], queue: 0, announcements })
    );

    // When, in the reader's own zone — the same formatter every other instant
    // on this tab uses.
    expect(markup).toContain(`Last posted ${whenText(went)}.`);
    // Not refused: the press is still offered, and it says what it will do.
    expect(markup).toContain("Post again");
    expect(markup.match(/Post now/g)).toHaveLength(3);
  });

  it("keeps the confirmation off the page until somebody asks for it", async () => {
    /*
     * The confirm sentence is handler state, so it must not be in the markup
     * that arrives — an admin opening the Publish tab of an event whose
     * announcement went out last week is not being asked anything.
     *
     * This is the honest half of a flow a node render cannot click through:
     * what the press decides is `manualPostStep`, asserted directly in
     * `announce-manual.test.ts`, and what the markup does with each answer is
     * one branch, written here as the branch that is *not* taken on arrival.
     */
    const { eventId } = await tab();
    const went = new Date("2026-05-21T19:30:00.000Z");
    await db
      .insert(announcementClaims)
      .values({ kind: "signups_open", eventId, claimedAt: went });

    const event = await getEventById(eventId, { now: NOW }, db);
    const announcements = await manualAnnouncementPanel(eventId, db);
    const markup = renderToStaticMarkup(
      createElement(PublishTab, { event: event!, applicants: [], queue: 0, announcements })
    );

    expect(markup).not.toContain("Post it again");
    expect(markup).not.toContain(
      alreadyPostedWarning("signups_open", whenText(went) ?? "")
    );
    // But the fact it went out is standing content, and is there.
    expect(markup).toContain(`Last posted ${whenText(went)}.`);
  });
});

/* --------------------------------------------------------------------- */
/* UC-43 3b — nowhere to post                                            */
/* --------------------------------------------------------------------- */

describe("no webhook configured (UC-43 3b)", () => {
  it("says so, as standing content, and disables every button", async () => {
    await setIntegrationSetting(SETTING_KEYS.webhookUrl, null, db);
    const { markup, announcements } = await tab();

    expect(announcements.webhook).toBe(false);
    expect(markup).toContain(
      "No Discord webhook is configured, so nothing would be posted. " +
        "Set one on the Settings screen first."
    );
    /*
     * Standing, so it does not interrupt an admin who came to read the
     * checklist — it is on the page the moment the tab arrives.
     * `alert-announcement.test.ts` holds the classification; this asserts the
     * markup it produces.
     */
    expect(markup).toContain('<div class="border px-3 py-2 text-14 border-union/40');
    expect(markup).not.toContain('role="alert" aria-live="assertive" class="border px-3 py-2 text-14 border-union/40');
    // Four rows, four disabled buttons: the panel explains rather than
    // vanishing.
    expect(markup.match(/Post now/g)).toHaveLength(4);

    /*
     * Counted as a *difference* against the same tab with a webhook, not as a
     * floor. This tab disables other things for reasons of its own — the
     * Publish button, while the readiness checklist has problems in it — so
     * "at least four disabled" is satisfied without a single announcement
     * button being disabled at all.
     */
    await setIntegrationSetting(SETTING_KEYS.webhookUrl, "https://discord.test/api/webhooks/1/t", db);
    const configured = await tab();
    const count = (source: string) => source.match(/disabled=""/g)?.length ?? 0;
    expect(count(markup) - count(configured.markup)).toBe(4);
  });

  it("does not say it when a webhook is configured", async () => {
    const { markup } = await tab();
    expect(markup).not.toContain(MANUAL_REFUSALS.noWebhook);
  });
});

/* --------------------------------------------------------------------- */
/* A draft event                                                         */
/* --------------------------------------------------------------------- */

describe("an event that is still a draft", () => {
  it("says anything posted links to a page members cannot open", async () => {
    const { markup } = await tab();
    expect(markup).toContain(
      "This event is still a draft, so anything posted about it links to a page members " +
        "cannot open yet."
    );
  });

  it("says nothing of the sort once it is published", async () => {
    const { markup } = await tab({ status: "published" });
    expect(markup).not.toContain("still a draft");
  });
});

/* --------------------------------------------------------------------- */
/* The props actually arrive                                             */
/* --------------------------------------------------------------------- */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

describe("the panel reaches the screen", () => {
  it("is read by the server page and handed to the editor", () => {
    const source = stripComments(fs.readFileSync(PAGE, "utf8"));

    // Read on the server, for this event.
    expect(source).toContain("manualAnnouncementPanel(event.id)");
    // And passed down. Deleting this line leaves every test above green.
    expect(source).toContain("announcements={announcements}");
  });

  it("is handed on by the editor to the Publish tab", () => {
    const source = stripComments(fs.readFileSync(EDITOR, "utf8"));

    // One more hop, and the one a component test cannot see: the editor is
    // where `roles={roles}`-shaped deletions live.
    expect(source).toContain("announcements={announcements}");
    const publish = /<PublishTab[\s\S]*?\/>/.exec(source);
    expect(publish, "the editor no longer renders the Publish tab").not.toBeNull();
    expect(publish![0]).toContain("announcements={announcements}");
  });

  it("names every kind on the screen with the word the channel will show", async () => {
    // The map is held against the real footers in `announce-manual.test.ts`;
    // this is the other end of it — the names really are what is rendered.
    const { markup } = await tab({ inSeason: true });
    for (const name of Object.values(MANUAL_ANNOUNCEMENT_NAMES)) {
      expect(markup, name).toContain(`>${name}</h3>`);
    }
  });
});
