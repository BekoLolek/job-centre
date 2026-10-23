import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANNOUNCEMENTS,
  type AnnouncementKind,
  type AnnouncementSettings as Settings,
  type AnnouncementTemplate,
  DISCORD_LIMITS,
  type DiscordMessage,
  announcementTemplateProblem,
  applicationDecidedMessage,
  defaultAnnouncementSettings,
  eventPublishedMessage,
  eventStartingSoonMessage,
  lotSoldMessage,
  matchResultMessage,
  placeholdersFor,
  signupsClosingSoonMessage,
  signupsOpenMessage,
  standingsMessage,
} from "@/lib/announce";
import type { StoredAnnouncementTemplate } from "@/lib/discord";

/*
 * The announcements screen: the wording, the mention picker and the preview
 * (R-204 / UC-37 1-6, 5a, 7a).
 *
 * ## What this file can and cannot do
 *
 * The suite runs in vitest's `node` environment with no jsdom and no
 * testing-library, so there is nothing here to click and nothing here that
 * pretends to. Every test below renders the component to static markup and
 * asserts on the markup, or calls an exported function and asserts on its
 * answer. Where a state is only reachable in a browser by typing — an admin
 * emptying a wording box — the test hands the editor that state as its *stored*
 * value and says so out loud rather than implying a keystroke happened.
 *
 * ## The one criterion this file exists for
 *
 * "The preview is produced by the same function that builds the posted
 * payload." A test that checked the preview contained some expected text would
 * pass just as happily against a hand-rolled second renderer, so the assertion
 * here is **byte equality with the real builder's output**: the test imports
 * `eventPublishedMessage` and the other five from `@/lib/announce`, calls them
 * with the preview's own example input, and demands that exact JSON on the
 * screen. `describes a second renderer` below then builds the copy somebody
 * would plausibly write and demands it is *not* there, so the assertion is shown
 * to discriminate rather than merely to pass.
 */

vi.mock("@/app/admin/settings/actions", () => ({
  saveAnnouncementSettingsAction: vi.fn(async () => ({
    ok: true as const,
    data: { settings: defaultAnnouncementSettings() },
  })),
  saveAnnouncementTemplateAction: vi.fn(async () => ({
    ok: false as const,
    error: "not used in a static render",
  })),
}));

const {
  default: AnnouncementSettings,
  EXAMPLE_SLUG,
  NOT_POSTED_YET,
  WordingMoved,
  draftBody,
  editorStatus,
  exampleApplicationDecided,
  exampleEventPublished,
  exampleEventStartingSoon,
  exampleLotSold,
  exampleMatchResult,
  exampleSignupsClosingSoon,
  exampleSignupsOpen,
  exampleStandings,
  withRole,
} = await import("../AnnouncementSettings");

const { saveAnnouncementTemplateAction } = await import("@/app/admin/settings/actions");

const ROOT = path.resolve(__dirname, "../../../..");
const COMPONENT = path.join(ROOT, "src/components/admin/AnnouncementSettings.tsx");

const ORIGIN = "https://jobcentre.example.test";

/** A kind nobody has touched: the compiled copy, no mention, version 0. */
function unedited(): StoredAnnouncementTemplate {
  return { body: null, mention: { everyone: false, roleIds: [] }, version: 0, updatedAt: null, updatedBy: null };
}

function storedFor(over: Partial<Record<AnnouncementKind, Partial<StoredAnnouncementTemplate>>> = {}) {
  const out = {} as Record<AnnouncementKind, StoredAnnouncementTemplate>;
  for (const spec of ANNOUNCEMENTS) out[spec.kind] = { ...unedited(), ...over[spec.kind] };
  return out;
}

function render(
  options: {
    openKind?: AnnouncementKind | null;
    templates?: Record<AnnouncementKind, StoredAnnouncementTemplate>;
    saved?: Settings;
    configured?: boolean;
    origin?: string | null;
    notPosted?: readonly AnnouncementKind[];
  } = {}
): string {
  return renderToStaticMarkup(
    createElement(AnnouncementSettings, {
      specs: ANNOUNCEMENTS,
      saved: options.saved ?? defaultAnnouncementSettings(),
      configured: options.configured ?? true,
      templates: options.templates ?? storedFor(),
      origin: options.origin === undefined ? ORIGIN : options.origin,
      openKind: options.openKind ?? null,
      notPosted: options.notPosted ?? NOT_POSTED_YET,
    })
  );
}

/**
 * The markup with React's text escaping undone.
 *
 * The payload is printed in a `<pre>`, so every `"` in the JSON arrives as
 * `&quot;`. Decoding once here keeps the assertions readable as JSON instead of
 * as a second encoding nobody can check by eye. `&amp;` is decoded last, so a
 * literal `&quot;` in the source cannot be decoded twice.
 */
function decode(markup: string): string {
  return markup
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Just the printed payload, decoded — the contents of the one `<pre>` on screen.
 *
 * Narrower than `decode(markup)` on purpose, for the assertions about what the
 * payload does *not* contain: the wording box above it holds the admin's text
 * exactly as typed, so "the double space is nowhere" is only a claim about the
 * payload, and asserting it over the whole page would be asserting it of the
 * textarea too.
 */
function payloadJson(markup: string): string {
  const found = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(markup);
  expect(found, "no payload is printed on this screen").not.toBeNull();
  return decode(found![1]);
}

it("has a decoder that undoes exactly what React's text escaping does", () => {
  // Against a fixture, so the decoder is tested rather than assumed. Without
  // this, a decoder that silently did nothing would make every JSON assertion
  // below fail for the wrong reason — or, worse, pass against markup it never
  // actually read.
  const sample = `{"a": "<b> & 'c'"}`;
  const markup = renderToStaticMarkup(createElement("pre", null, sample));
  expect(markup).not.toContain(sample);
  expect(decode(markup)).toContain(sample);
});

/* ------------------------------------------------------------------ */
/* The preview is the payload (R-204, the acceptance criterion)        */
/* ------------------------------------------------------------------ */

/**
 * Which builder in `@/lib/announce` posts each kind.
 *
 * Written out here from `./announce` rather than imported from the component,
 * because it is the independent half of the claim: the component says these
 * eight kinds are previewed by these six functions, and this table is a second
 * person saying the same thing from the other side. A component that quietly
 * started building its own payloads would still satisfy its own dispatch table;
 * it cannot satisfy this one.
 */
const BUILT_BY: Record<AnnouncementKind, (template: AnnouncementTemplate) => DiscordMessage> = {
  event_published: (t) => eventPublishedMessage(exampleEventPublished(ORIGIN), t),
  signups_open: (t) => signupsOpenMessage(exampleSignupsOpen(ORIGIN), t),
  signups_closing_soon: (t) =>
    signupsClosingSoonMessage(exampleSignupsClosingSoon(ORIGIN), t),
  event_starting_soon: (t) => eventStartingSoonMessage(exampleEventStartingSoon(ORIGIN), t),
  application_accepted: (t) =>
    applicationDecidedMessage(
      "application_accepted",
      exampleApplicationDecided("application_accepted", ORIGIN),
      t
    ),
  application_waitlisted: (t) =>
    applicationDecidedMessage(
      "application_waitlisted",
      exampleApplicationDecided("application_waitlisted", ORIGIN),
      t
    ),
  application_declined: (t) =>
    applicationDecidedMessage(
      "application_declined",
      exampleApplicationDecided("application_declined", ORIGIN),
      t
    ),
  draft_lot_sold: (t) => lotSoldMessage(exampleLotSold(ORIGIN), t),
  match_result: (t) => matchResultMessage(exampleMatchResult(ORIGIN), t),
  standings_changed: (t) => standingsMessage(exampleStandings(ORIGIN), t),
};

/** A wording that exercises the renderer rather than only the happy path. */
function wordingFor(kind: AnnouncementKind): string {
  const first = placeholdersFor(kind)[0]?.name;
  expect(first, `${kind} declares no placeholders, so this wording proves nothing`).toBeTruthy();
  // Double spaces and a blank line, because `clamp` collapses runs of
  // whitespace on the way into the embed. A copy of this preview that forgot
  // to would keep them, which is what `a second renderer` below turns into an
  // assertion.
  return `Heads  up —  {${first}}\n\nand  that is  that.`;
}

const MENTION = { everyone: true, roleIds: ["123456789012345678"] } as const;

describe("the preview", () => {
  it.each(ANNOUNCEMENTS.map((spec) => spec.kind))(
    "prints %s's payload exactly as the function that posts it built it",
    (kind) => {
      const template: AnnouncementTemplate = {
        body: wordingFor(kind),
        mention: { everyone: MENTION.everyone, roleIds: [...MENTION.roleIds] },
      };
      const expected = BUILT_BY[kind](template);

      const markup = render({
        openKind: kind,
        templates: storedFor({
          [kind]: { body: template.body, mention: template.mention, version: 3 },
        }),
      });

      expect(decode(markup)).toContain(JSON.stringify(expected, null, 2));
    }
  );

  it("sweeps every kind there is, so a table that lost a row cannot pass quietly", () => {
    expect(Object.keys(BUILT_BY).sort()).toEqual(ANNOUNCEMENTS.map((spec) => spec.kind).sort());
    // Ten, as `docs/requirements.md` R-201 says ("all seven kinds that exist
    // today, and the three Tasks 62/63 add, for ten in all"). Stated as a
    // number so an eleventh arriving is a decision somebody makes here too,
    // rather than a row this screen silently fails to preview.
    expect(ANNOUNCEMENTS).toHaveLength(10);
  });

  it("would not survive a second renderer written beside it", () => {
    /*
     * The assertion above is byte equality, and this is the test that shows it
     * discriminates. Below is the preview somebody would write by hand: the
     * same template, the same values, the same mention — and four differences
     * that are all `message()`'s doing and none of them obvious.
     *
     *  1. `clamp` collapses whitespace. The hand-rolled copy keeps the two
     *     spaces in "Heads  up".
     *  2. `content` is inserted *between* `username` and `embeds`, which is
     *     load-bearing because the payload is serialised with `JSON.stringify`
     *     (see `message`'s docblock and R-201's byte-for-byte promise).
     *  3. `allowed_mentions` is an allow-list of exact ids, never
     *     `parse: ["roles"]`.
     *  4. `username` is the module's constant, not the site's name as typed.
     */
    const kind: AnnouncementKind = "event_published";
    const body = wordingFor(kind);
    const template: AnnouncementTemplate = {
      body,
      mention: { everyone: MENTION.everyone, roleIds: [...MENTION.roleIds] },
    };

    const real = BUILT_BY[kind](template);
    const embed = real.embeds[0];
    const handRolled = {
      username: "Job Centre Events",
      embeds: [
        {
          ...embed,
          // No clamp: the placeholders filled in, the whitespace left as typed.
          description: body
            .replace("{title}", exampleEventPublished(ORIGIN).title)
            .replace(/\{(\w+)\}/g, ""),
        },
      ],
      content: "@everyone <@&123456789012345678>",
      allowed_mentions: { parse: ["everyone", "roles"] },
    };

    const raw = render({
      openKind: kind,
      templates: storedFor({ [kind]: { body, mention: template.mention, version: 1 } }),
    });
    const printed = payloadJson(raw);

    expect(printed).toContain(JSON.stringify(real, null, 2));
    expect(printed).not.toContain(JSON.stringify(handRolled, null, 2));
    // And the one difference small enough to state on its own: the collapsed
    // whitespace. "Heads  up" with two spaces is on the hand-rolled payload and
    // on no payload this module builds. The wording box above still holds it
    // exactly as typed, which is why this reads the payload and not the page.
    expect(printed).not.toContain("Heads  up");
    expect(printed).toContain("Heads up —");
    expect(decode(raw)).toContain("Heads  up —  {title}");

    // The key order, said out loud, because `JSON.stringify` is what makes it
    // matter and a diff of two long JSON blobs does not read it to you.
    expect(Object.keys(real)).toEqual(["username", "content", "embeds", "allowed_mentions"]);
  });

  it("carries no mention line at all when nobody is mentioned", () => {
    const kind: AnnouncementKind = "draft_lot_sold";
    const expected = BUILT_BY[kind]({ body: null, mention: { everyone: false, roleIds: [] } });

    const markup = decode(render({ openKind: kind }));

    expect(Object.keys(expected)).toEqual(["username", "embeds", "allowed_mentions"]);
    expect(expected.allowed_mentions).toEqual({ parse: [] });
    expect(markup).toContain(JSON.stringify(expected, null, 2));
    expect(markup).toContain(
      "Nobody is mentioned, so the message carries no mention line at all."
    );
  });

  it("previews the site's own wording for a kind nobody has edited", () => {
    // UC-37 2a. An unedited kind previews the compiled copy, which is what
    // posts — and the sentence is `eventPublishedMessage`'s, not this screen's.
    const expected = BUILT_BY.event_published({
      body: null,
      mention: { everyone: false, roleIds: [] },
    });

    const markup = decode(render({ openKind: "event_published" }));

    expect(markup).toContain(JSON.stringify(expected, null, 2));
    expect(markup).toContain("Applications are open — three taps if your profile is filled in.");
  });

  it("links to the address in force, and says so when there is none", () => {
    const withOrigin = decode(render({ openKind: "match_result", origin: ORIGIN }));
    expect(withOrigin).toContain(`Links to ${ORIGIN}/events/${EXAMPLE_SLUG}?tab=results`);

    const without = decode(render({ openKind: "match_result", origin: null }));
    expect(without).toContain(
      "No link — this install has no site address set, so the post carries none."
    );
  });
});

/* ------------------------------------------------------------------ */
/* Example values (UC-37 5a)                                          */
/* ------------------------------------------------------------------ */

describe("a placeholder with no value", () => {
  /*
   * Every kind, every placeholder it offers: a wording that is nothing but
   * `{name}` must preview as that placeholder's **declared** example, because
   * there is no event being previewed and a preview full of blanks looks like a
   * bug. Driven off `ANNOUNCEMENT_PLACEHOLDERS`, so a declaration whose example
   * the preview cannot actually produce fails here rather than being discovered
   * on the screen.
   */
  const every = ANNOUNCEMENTS.flatMap((spec) =>
    placeholdersFor(spec.kind).map((placeholder) => ({ kind: spec.kind, placeholder }))
  );

  it("is a sweep with something in it", () => {
    // 25 placeholders across the eight kinds today. A floor rather than an
    // equality, so Task 68's two kinds are not a failure here.
    expect(every.length).toBeGreaterThanOrEqual(25);
  });

  it.each(every.map((entry) => [entry.kind, entry.placeholder.name, entry.placeholder.example]))(
    "%s's {%s} previews as its declared example",
    (kind, name, example) => {
      const body = `{${name}}`;
      const template: AnnouncementTemplate = {
        body,
        mention: { everyone: false, roleIds: [] },
      };
      const built = BUILT_BY[kind as AnnouncementKind](template);

      expect(built.embeds[0].description).toBe(example);

      const markup = decode(
        render({
          openKind: kind as AnnouncementKind,
          templates: storedFor({ [kind]: { body, version: 1 } }),
        })
      );
      expect(markup).toContain(JSON.stringify(built, null, 2));
    }
  );

  it("belongs to the one kind that has it, and to neither of the other two", () => {
    /*
     * `{position}` is a fact about a waitlisting and about nothing else, which
     * is the whole reason `ANNOUNCEMENT_PLACEHOLDERS` is a table per kind
     * rather than one shared list. An example input that handed a queue number
     * to all three decisions would be invisible in every payload above — an
     * acceptance's sentence never mentions one — right up until a stored row
     * reached for `{position}` on the wrong kind, where it would render a
     * number the event does not have instead of standing out as the mistake it
     * is.
     */
    expect(exampleApplicationDecided("application_waitlisted", null).waitlistPosition).toBe(3);
    expect(exampleApplicationDecided("application_accepted", null).waitlistPosition).toBeNull();
    expect(exampleApplicationDecided("application_declined", null).waitlistPosition).toBeNull();

    // And the number is the declared example, not one of this file's choosing.
    expect(
      placeholdersFor("application_waitlisted").find((p) => p.name === "position")?.example
    ).toBe("3");
  });

  it("is marked as an example on the screen rather than left to be assumed", () => {
    const markup = decode(render({ openKind: "application_waitlisted" }));

    expect(markup).toContain("Preview — example values, nothing sent");
    // And why a time in the preview is markup rather than a date: it is the
    // repo invariant, and without the line it reads as an unfilled placeholder.
    expect(markup).toContain(
      "Discord renders it in each reader’s own timezone, so no message this site builds ever contains a date somebody else’s clock decided."
    );
    expect(markup).toContain(
      "Every value above is this announcement’s declared example rather than a real event"
    );
    // And beside the placeholder, where the admin reads what `{position}` is
    // for — the same string the preview is built from.
    expect(markup).toContain("Their place in the queue, 1 being the front");
    expect(markup).toContain("Example, used in the preview below:");
    expect(markup).toContain("a place not yet numbered");
  });
});

/* ------------------------------------------------------------------ */
/* The preview sends nothing (R-204's other half)                     */
/* ------------------------------------------------------------------ */

describe("looking at a preview", () => {
  let sender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sender = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", sender);
    vi.mocked(saveAnnouncementTemplateAction).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has a sender stub that records a call, so an empty log means something", () => {
    /*
     * The control for the test below. "No calls" passes against a stub that
     * was never installed and against a spy that cannot record, so the
     * instrument is proved first: this is the global `fetch` that
     * `deliver` — the only thing in this codebase that posts to Discord — would
     * reach for.
     */
    expect(globalThis.fetch).toBe(sender);
    void (globalThis.fetch as unknown as (url: string) => unknown)(
      "https://discord.test/api/webhooks/1/t"
    );
    expect(sender.mock.calls).toEqual([["https://discord.test/api/webhooks/1/t"]]);
  });

  it("sends nothing — asserted as the absence of any call, for every kind", () => {
    for (const spec of ANNOUNCEMENTS) {
      render({
        openKind: spec.kind,
        templates: storedFor({
          [spec.kind]: {
            body: wordingFor(spec.kind),
            mention: { everyone: true, roleIds: ["123456789012345678"] },
            version: 2,
          },
        }),
      });
    }

    // The assertions are the two empty logs, not a rendered string.
    expect(sender.mock.calls).toEqual([]);
    expect(vi.mocked(saveAnnouncementTemplateAction).mock.calls).toEqual([]);
  });

  it("cannot reach the sender, because the module that sends is never imported", () => {
    /*
     * The structural half, and the one that holds when somebody adds a
     * `useEffect`. `@/lib/discord` is the only module that posts; the screen
     * takes a *type* from it and nothing else, so `import type` is erased at
     * build time and there is no `deliver`, no `announce` and no webhook in the
     * browser bundle at all. A value import would not fail the test above —
     * rendering does not call it — which is exactly why this one is here.
     */
    const source = fs.readFileSync(COMPONENT, "utf8");
    const imports = [...source.matchAll(/^import(?: type)?[^\n]*?from "@\/lib\/discord";$/gm)];
    expect(imports.map((match) => match[0])).toEqual([
      'import type { StoredAnnouncementTemplate } from "@/lib/discord";',
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Every refusal is shown (UC-37 3a, 3b, 3c and the mention's two)     */
/* ------------------------------------------------------------------ */

const TOO_LONG = "x".repeat(DISCORD_LIMITS.description + 1);

/**
 * The five refusals, as the state the editor is in when each one bites.
 *
 * Three of these are states a *stored* row can be in — `announcementTemplateFrom`
 * neither checks placeholders nor measures length, and `./announce` says in as
 * many words that a vocabulary can change between a save and a post. The other
 * two are states an admin reaches by typing: emptying a box that had words in
 * it, and pasting a role name. There is no typing in this environment, so those
 * two are handed to the editor as its stored value. That is a real render of the
 * real state, and it is **not** a test of the keystroke — nothing below claims
 * a click happened.
 */
const REFUSED: { what: string; kind: AnnouncementKind; stored: Partial<StoredAnnouncementTemplate>; says: string }[] = [
  {
    what: "a placeholder the kind does not offer (UC-37 3a)",
    kind: "event_published",
    stored: { body: "{captain} is in charge", version: 4 },
    says: "This announcement has no {captain}. It offers {title}, {places}, {starts}, {closes}.",
  },
  {
    what: "a placeholder that belongs to a different kind (UC-37 3a)",
    kind: "application_accepted",
    stored: { body: "{member} is number {position}", version: 1 },
    says: "This announcement has no {position}. It offers {member}, {event}.",
  },
  {
    what: "a wording emptied to nothing (UC-37 3b)",
    kind: "draft_lot_sold",
    stored: { body: "", version: 2 },
    says: "An announcement with no words is the switch being off — use the switch instead.",
  },
  {
    what: "a wording longer than Discord accepts (UC-37 3c)",
    kind: "match_result",
    stored: { body: TOO_LONG, version: 1 },
    says: `Discord accepts 4096 characters in an announcement; that is ${DISCORD_LIMITS.description + 1}.`,
  },
  {
    what: "a role name pasted where an id goes",
    kind: "standings_changed",
    stored: { mention: { everyone: false, roleIds: ["Pingers"] }, version: 1 },
    says: "“Pingers” is not a role id. A role ping needs the id Discord gives the role, not its name.",
  },
];

describe("a refusal", () => {
  it.each(REFUSED)("is on the screen for $what", ({ kind, stored, says }) => {
    const markup = decode(render({ openKind: kind, templates: storedFor({ [kind]: stored }) }));

    expect(markup).toContain(says);
  });

  it.each(REFUSED)("is `announcementTemplateProblem`'s own sentence for $what", ({ kind, stored, says }) => {
    /*
     * The other half of the same claim, and the reason the sentences above are
     * written out in full rather than asserted as `problem !== null`: the
     * screen must show what the *save* would have answered with, so these are
     * compared against the module that refuses rather than only against the
     * markup. A screen with a kinder sentence of its own would pass the test
     * above and fail this one.
     */
    const row = { ...unedited(), ...stored };
    expect(
      announcementTemplateProblem(kind, { body: row.body, mention: row.mention })
    ).toBe(says);
  });

  it.each(REFUSED)("stops the save as well as describing it, for $what", ({ kind, stored }) => {
    /*
     * The decision rather than the pixel. A Save button's `disabled` attribute
     * in a static render says nothing here, because nothing has been typed and
     * an unchanged editor is disabled anyway — so what is asserted is the
     * predicate the button is wired to, with the edit applied on top of a row
     * that does not have it. `editorStatus` is the only thing that decides,
     * and the component's button takes `!canSave` and nothing else.
     */
    const row = { ...unedited(), ...stored };
    const status = editorStatus(
      kind,
      { body: row.body, mention: row.mention },
      { body: null, mention: { everyone: false, roleIds: [] } }
    );

    expect(status.dirty).toBe(true);
    expect(status.problem).not.toBeNull();
    expect(status.canSave).toBe(false);
  });

  it("lets a wording that is fine through, so the guard is not simply off", () => {
    // The control. Without it, `canSave: false` above would pass against a
    // button that is disabled forever.
    const status = editorStatus(
      "event_published",
      { body: "{title} is on {starts}.", mention: { everyone: true, roleIds: [] } },
      { body: null, mention: { everyone: false, roleIds: [] } }
    );

    expect(status).toEqual({ dirty: true, problem: null, canSave: true });
  });

  it("has nothing to save on arrival, whatever the wording is", () => {
    // An editor nobody has touched: no refusal shouted at somebody who has not
    // done anything, and no save to make.
    const saved = { body: "{title} is on.", mention: { everyone: false, roleIds: ["123456789012345678"] } };

    expect(editorStatus("event_published", saved, saved)).toEqual({
      dirty: false,
      problem: null,
      canSave: false,
    });
  });
});

describe("an empty wording box", () => {
  /*
   * `draftBody` is the one line that tells "nobody has edited this" from "an
   * admin cleared it", and the second is only reachable in a browser by
   * typing. Tested as the pure function it is rather than through a render
   * that would have to pretend a keystroke happened.
   */
  const NOT_EDITED: AnnouncementTemplate = { body: null, mention: { everyone: false, roleIds: [] } };
  const EDITED: AnnouncementTemplate = { body: "Something", mention: { everyone: false, roleIds: [] } };

  it("means the site's own wording on a kind nobody has edited", () => {
    expect(draftBody("", NOT_EDITED)).toBeNull();
    expect(draftBody("   \n ", NOT_EDITED)).toBeNull();
    expect(announcementTemplateProblem("event_published", { ...NOT_EDITED, body: null })).toBeNull();
  });

  it("means a cleared wording on a kind that had some, which is refused", () => {
    expect(draftBody("", EDITED)).toBe("");
    expect(
      announcementTemplateProblem("event_published", { ...EDITED, body: draftBody("", EDITED) })
    ).toBe("An announcement with no words is the switch being off — use the switch instead.");
  });

  it("is never confused with a box that has words in it", () => {
    expect(draftBody("Hello", NOT_EDITED)).toBe("Hello");
    expect(draftBody("Hello", EDITED)).toBe("Hello");
  });
});

describe("somebody else saving first (UC-37 7a)", () => {
  it("shows the wording that is in force now, not only that one moved", () => {
    const current: StoredAnnouncementTemplate = {
      body: "The table moved after {event}. {leader} leads.",
      mention: { everyone: true, roleIds: ["123456789012345678"] },
      version: 7,
      updatedAt: new Date("2026-05-01T10:00:00Z"),
      updatedBy: "other-admin",
    };

    const markup = decode(renderToStaticMarkup(createElement(WordingMoved, { current })));

    expect(markup).toContain("The wording in force now");
    expect(markup).toContain("The table moved after {event}. {leader} leads.");
    expect(markup).toContain("It mentions @everyone <@&123456789012345678>.");
    expect(markup).toContain("Your words are still in the box above, untouched.");
  });

  it("says so plainly when the wording that won is the site's own", () => {
    const current: StoredAnnouncementTemplate = { ...unedited(), version: 2 };

    const markup = decode(renderToStaticMarkup(createElement(WordingMoved, { current })));

    expect(markup).toContain("The site's own wording — theirs is not edited.");
    expect(markup).toContain("It mentions nobody.");
  });
});

/* ------------------------------------------------------------------ */
/* The kind that posts nothing yet                                    */
/* ------------------------------------------------------------------ */

/** Which builder in `@/lib/announce` each kind's message comes out of. */
const BUILDER_NAME: Record<AnnouncementKind, string> = {
  event_published: "eventPublishedMessage",
  signups_open: "signupsOpenMessage",
  signups_closing_soon: "signupsClosingSoonMessage",
  event_starting_soon: "eventStartingSoonMessage",
  application_accepted: "applicationDecidedMessage",
  application_waitlisted: "applicationDecidedMessage",
  application_declined: "applicationDecidedMessage",
  draft_lot_sold: "lotSoldMessage",
  match_result: "matchResultMessage",
  standings_changed: "standingsMessage",
};

describe("a kind nothing posts yet", () => {
  /*
   * The honest answer to "is this announcement live" when the site has the
   * wording, the switch and no trigger. `NOT_POSTED_YET` is empty as this
   * lands — the scheduler arrived alongside it — so the warning is driven
   * through the prop that carries the fact, which is what keeps the mechanism
   * proved rather than only declared. The assertion that the constant is
   * *right* is its own test below, against the module that posts.
   */
  const UNWIRED: AnnouncementKind = "signups_open";

  it("is exactly the set `src/lib/discord.ts` has no builder for", () => {
    /*
     * `NOT_POSTED_YET` is a claim about the site, so it is held against the
     * site rather than against itself. `src/lib/discord.ts` is the only module
     * that posts; a kind whose builder it never imports has no call site, so
     * `deliver` is never reached for it and nothing goes into the channel.
     *
     * A kind losing its trigger, or a new kind arriving with none, fails here
     * and says to name it in the list — which is the point of the list, and
     * the reason it is not a comment.
     */
    const discord = fs.readFileSync(path.join(ROOT, "src/lib/discord.ts"), "utf8");
    const unwired = ANNOUNCEMENTS.map((spec) => spec.kind).filter(
      (kind) => !discord.includes(BUILDER_NAME[kind])
    );

    expect([...NOT_POSTED_YET]).toEqual(unwired);
  });

  it("names a real builder for every kind, so an empty answer above means something", () => {
    // The control. Without it, a `BUILDER_NAME` full of typos would report
    // every kind unwired, and a `BUILDER_NAME` of empty strings would report
    // none — and the test above would pass against whichever the list said.
    const announce = fs.readFileSync(path.join(ROOT, "src/lib/announce.ts"), "utf8");

    for (const spec of ANNOUNCEMENTS) {
      expect(announce, `${spec.kind} names a builder that is not exported`).toContain(
        `export function ${BUILDER_NAME[spec.kind]}(`
      );
    }
    expect(new Set(Object.values(BUILDER_NAME)).size).toBeGreaterThanOrEqual(8);
  });

  it("is not presented as live, on the row or in the panel", () => {
    const markup = decode(
      render({
        openKind: UNWIRED,
        notPosted: [UNWIRED],
        saved: { ...defaultAnnouncementSettings(), [UNWIRED]: true },
      })
    );

    expect(markup).toContain("Nothing posts this yet");
    expect(markup).toContain("Nothing in the site posts this yet");
    expect(markup).toContain(
      "no part of the site sends this announcement today, so turning it on changes nothing you would see in the channel"
    );
  });

  it("says nothing of the sort about a kind that does post", () => {
    // The other half, and the reason the one above is not satisfied by a
    // warning printed on every row.
    const markup = decode(render({ openKind: "event_published", notPosted: [UNWIRED] }));

    expect(markup).not.toContain("Nothing in the site posts this yet");
    expect(markup.match(/Nothing posts this yet/g) ?? []).toHaveLength(1);
  });

  it("is still editable, because the wording and the switch are real", () => {
    // The honest version of "not live" is not a disabled screen: the row is
    // stored, the switch is stored, and both will be read the moment a trigger
    // exists. What must not happen is the screen implying a message is going
    // out — which the test above holds.
    const markup = decode(
      render({
        openKind: UNWIRED,
        notPosted: [UNWIRED],
        templates: storedFor({ [UNWIRED]: { body: "Doors open on {title}.", version: 1 } }),
      })
    );

    // The box carries the stored wording, the placeholders are offered, and
    // the preview is built — none of it switched off because nothing posts it.
    expect(markup).toContain("Doors open on {title}.</textarea>");
    expect(markup).toContain("Posts when applications actually open");
    expect(
      editorStatus(
        UNWIRED,
        { body: "Doors open on {title}.", mention: { everyone: false, roleIds: [] } },
        { body: null, mention: { everyone: false, roleIds: [] } }
      ).canSave
    ).toBe(true);
  });

  it("carries a different warning on a kind that is off but does post", () => {
    // Told apart from the one above: "switched off" and "nothing posts this"
    // are different facts, and a screen that said the same thing for both
    // would be hiding the second.
    const markup = decode(
      render({
        openKind: "standings_changed",
        saved: { ...defaultAnnouncementSettings(), standings_changed: false },
      })
    );

    expect(markup).toContain("This announcement is switched off, so nothing is posted");
    expect(markup).not.toContain("Nothing in the site posts this yet");
  });
});

/* ------------------------------------------------------------------ */
/* The screen itself (UC-37 1, 2, 3, 4, 4a)                           */
/* ------------------------------------------------------------------ */

describe("the screen", () => {
  it("lists every kind there is, with its wording and its switch (UC-37 2)", () => {
    const markup = decode(
      render({
        templates: storedFor({
          match_result: {
            body: "{winner} take it",
            mention: { everyone: true, roleIds: [] },
            version: 1,
          },
        }),
      })
    );

    for (const spec of ANNOUNCEMENTS) expect(markup).toContain(spec.label);
    // The two facts a closed row has to carry, because the cost of a fold is
    // forgetting what is inside it.
    expect(markup).toContain("Your wording · mentions @everyone");
    expect(markup).toContain("The site's own wording");
  });

  it("opens one kind at a time, and the one `?kind=` named", () => {
    const markup = render({ openKind: "draft_lot_sold" });

    // The editor's own heading, once: the open row's.
    expect(markup.match(/Placeholders this announcement offers/g)).toHaveLength(1);
    expect(markup).toContain("The player who went under the hammer");
    // And nothing of another kind's vocabulary.
    expect(markup).not.toContain("Their place in the queue");
  });

  it("names every placeholder a kind offers, with what it is for (UC-37 3)", () => {
    const markup = decode(render({ openKind: "event_published" }));

    for (const placeholder of placeholdersFor("event_published")) {
      expect(markup).toContain(`{${placeholder.name}}`);
      expect(markup).toContain(placeholder.describe);
      expect(markup).toContain(placeholder.example);
    }
    // And the two whose absence posts declared words rather than a hole.
    expect(markup).toContain("a time still to be confirmed");
    expect(markup).toContain("no closing date");
  });

  it("says why there is no list of roles to pick from (UC-37 4a, R-203)", () => {
    const markup = decode(render({ openKind: "application_accepted" }));

    expect(markup).toContain("There is no list of your server’s roles to pick from");
    expect(markup).toContain(
      "reading the list needs a bot token and a server id, which this install does not have"
    );
    expect(markup).toContain("Copy Role ID");
    expect(markup).toContain("A role <em>name</em> does nothing on Discord");
  });

  it("offers @everyone with no id at all (UC-37 4, 4c)", () => {
    const markup = decode(render({ openKind: "application_accepted" }));

    expect(markup).toContain("Ping @everyone");
    expect(markup).toContain(
      "Switching it on is written to the audit log as a line of its own."
    );
  });

  it("shows the role ids that are already mentioned, and the line they make", () => {
    const markup = decode(
      render({
        openKind: "draft_lot_sold",
        templates: storedFor({
          draft_lot_sold: {
            mention: { everyone: false, roleIds: ["123456789012345678"] },
            version: 1,
          },
        }),
      })
    );

    // As the ping Discord actually reads, not as a bare number: `@RoleName` is
    // inert, and seeing `<@&…>` beside the mention line is the admin's only way
    // to tell that what they pasted became a ping rather than text.
    expect(markup).toContain("<@&123456789012345678></span>");
    expect(markup).toContain(">Remove</button>");
    expect(markup).toContain("The message will begin with <@&123456789012345678>");
  });

  it("still says a missing webhook makes the whole screen inert", () => {
    const markup = decode(render({ configured: false, openKind: "event_published" }));

    expect(markup).toContain("No webhook — nothing will post");
    expect(markup).toContain("No webhook is set, so every switch below is inert.");
    expect(markup).toContain(
      "nothing would be sent by saving either, because no webhook is configured."
    );
  });
});

/* ------------------------------------------------------------------ */
/* Pasting a role id (R-203 / UC-37 4a)                               */
/* ------------------------------------------------------------------ */

describe("pasting a role id", () => {
  /*
   * `withRole` is the whole of what the Add button does, extracted so that the
   * decision can be asserted where the click cannot. Nothing below claims a
   * button was pressed: these are calls to a pure function with the arguments
   * the button would hand it.
   */
  const NOBODY = { everyone: false, roleIds: [] as string[] };
  const ID = "123456789012345678";

  it("takes a snowflake", () => {
    expect(withRole("event_published", NOBODY, ID)).toEqual({
      mention: { everyone: false, roleIds: [ID] },
      refused: null,
    });
  });

  it("keeps whatever else was already chosen", () => {
    const already = { everyone: true, roleIds: ["987654321098765432"] };

    expect(withRole("event_published", already, ID).mention).toEqual({
      everyone: true,
      roleIds: ["987654321098765432", ID],
    });
  });

  it("refuses a role name in the module's own words, and changes nothing", () => {
    const result = withRole("event_published", NOBODY, "Pingers");

    expect(result.refused).toBe(
      "“Pingers” is not a role id. A role ping needs the id Discord gives the role, not its name."
    );
    expect(result.mention).toBe(NOBODY);
  });

  it("refuses something that is only nearly a snowflake", () => {
    // 16 digits, one short. The lower bound is what stops "1" being an id.
    const result = withRole("event_published", NOBODY, "1234567890123456");

    expect(result.refused).toBe(
      "“1234567890123456” is not a role id. A role ping needs the id Discord gives the role, not its name."
    );
    expect(result.mention.roleIds).toEqual([]);
  });

  it("refuses the same role twice rather than mentioning it twice", () => {
    const result = withRole("event_published", { everyone: false, roleIds: [ID] }, ` ${ID} `);

    expect(result.refused).toBe("That role is already mentioned.");
    expect(result.mention.roleIds).toEqual([ID]);
  });

  it("does nothing at all on an empty field", () => {
    expect(withRole("event_published", NOBODY, "   ")).toEqual({
      mention: NOBODY,
      refused: null,
    });
  });

  it("is the whole of what the Add button does", () => {
    /*
     * A **source** check, and said so rather than dressed up as a behaviour
     * one: there is no pointer in this environment, so the one thing the tests
     * above cannot reach is the click that calls `withRole`. The same shape as
     * `checkbox-hit-area.test.ts`'s assertion about `const box` — it does not
     * run the handler, it reads it, and what it demands is that the handler has
     * no judgement of its own: `withRole`'s answer, shown and handed up.
     *
     * Without this, a handler that quietly appended whatever was in the field
     * would leave all six tests above green while putting a role *name* into a
     * mention line.
     */
    const source = fs.readFileSync(COMPONENT, "utf8");
    const handler = /\n {2}const add = \(\) => \{\n([\s\S]*?)\n {2}\};\n/.exec(source);

    expect(handler, "RoleMention no longer builds its handler as `const add`").not.toBeNull();
    expect(handler![1]).toContain("withRole(kind, mention, pasted)");
    // No rules of its own: no snowflake pattern, no second call to the refusal
    // function, no `roleIds` assembled here.
    expect(handler![1]).not.toMatch(/ROLE_ID|\[0-9\]\{17|announcementTemplateProblem|roleIds/);
  });
});

describe("the webhook", () => {
  it("is still said to make the whole screen inert when it is missing", () => {
    const markup = decode(render({ configured: false, openKind: "event_published" }));

    expect(markup).toContain("No webhook — nothing will post");
    expect(markup).toContain("No webhook is set, so every switch below is inert.");
    expect(markup).toContain(
      "nothing would be sent by saving either, because no webhook is configured."
    );
  });
});
