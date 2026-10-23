import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENTS,
  ANNOUNCEMENT_PLACEHOLDERS,
  type AnnouncementKind,
  type AnnouncementTemplate,
  DISCORD_LIMITS,
  NO_MENTION,
  allowedMentionsFor,
  announcementSettingsFrom,
  announcementSettingsValue,
  announcementTemplateFrom,
  announcementTemplateProblem,
  applicationDecidedMessage,
  defaultAnnouncementSettings,
  CLOSING_SOON_FULLNESS,
  type EventPublishedInput,
  eventPublishedMessage,
  eventStartingSoonMessage,
  linkTo,
  lotSoldMessage,
  maskWebhook,
  matchResultMessage,
  mentionLine,
  normaliseAnnouncementSettings,
  placeholdersFor,
  publishingOpensSignups,
  resolveSiteOrigin,
  resolveWebhookUrl,
  signupsClosingSoonMessage,
  signupsOpenMessage,
  siteOrigin,
  stamp,
  standingsMessage,
} from "@/lib/announce";
import type { TopOfTable } from "@/lib/championship-policy";

/**
 * The announcements, as pure functions.
 *
 * **Nothing in this file makes a request**, and nothing in it can: the module
 * under test has no `fetch` in it. That split — sentences here, `fetch` in
 * `src/lib/discord.ts` — exists precisely so the interesting decisions (which
 * ending a waitlisted applicant gets, what a lot that went for nothing reads
 * like, whether a drawn series announces at all) are cheap to pin down.
 */

describe("the toggle settings", () => {
  it("defaults the news on and the consolation off", () => {
    const defaults = defaultAnnouncementSettings();
    expect(defaults.event_published).toBe(true);
    expect(defaults.application_accepted).toBe(true);
    expect(defaults.draft_lot_sold).toBe(true);
    expect(defaults.match_result).toBe(true);
    // A full event posts one of these per applicant. Off until asked for.
    expect(defaults.application_waitlisted).toBe(false);
    // Somebody's "no" is a consolation too, and off for the same reason.
    expect(defaults.application_declined).toBe(false);
    /*
     * And the newest kind is off as well (R-197, UC-36 3), which is not the
     * "consolation" rule but the one in the module comment: a kind that ships
     * with its switch on is a deploy that silently starts posting something
     * nobody asked for. On an install that runs brackets it would also be the
     * second message about the same night, beside `match_result`.
     */
    expect(defaults.standings_changed).toBe(false);
    /*
     * And the eighth (R-205, UC-38 2), off for that same rule rather than the
     * consolation one: it is a new kind arriving on installs that already have
     * a webhook, so on-by-default would be a deploy that starts posting
     * something nobody asked for. Nothing fires it yet either (Task 63 owns the
     * clock), and a switch that is on for an announcement nothing sends is a
     * settings screen telling an untruth.
     */
    expect(defaults.signups_open).toBe(false);
    /*
     * And the two the clock owns (R-206, R-207 / UC-38 3, 4), off for that same
     * rule. These two would be the loudest version of it: they fire off a
     * clock, on every event with a closing time or a dated day, the first time
     * the scheduler wakes after a deploy — so on-by-default would turn a
     * deployment into a flurry of announcements about events nobody asked to
     * have announced.
     */
    expect(defaults.signups_closing_soon).toBe(false);
    expect(defaults.event_starting_soon).toBe(false);
  });

  it("has a spec for every kind, and only for kinds", () => {
    // Ten: the seven that predate Task 59, `signups_open` (Task 62) and the two
    // the clock posts (Task 68). The count is asserted rather than derived so
    // that a kind added without a vocabulary, a builder and a golden fails here
    // first — every sweep in this file runs over `ANNOUNCEMENTS` itself.
    expect(ANNOUNCEMENTS).toHaveLength(10);
    expect(new Set(ANNOUNCEMENTS.map((spec) => spec.kind)).size).toBe(10);
    for (const spec of ANNOUNCEMENTS) {
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.detail.length).toBeGreaterThan(0);
    }
  });

  it("reads a stored object, filling the gaps from the defaults", () => {
    const settings = announcementSettingsFrom({ match_result: false });
    expect(settings.match_result).toBe(false);
    expect(settings.event_published).toBe(true);
  });

  it("treats anything that is not a boolean as not said", () => {
    const settings = announcementSettingsFrom({
      match_result: "false",
      event_published: 0,
      draft_lot_sold: null,
    });
    expect(settings.match_result).toBe(true);
    expect(settings.event_published).toBe(true);
    expect(settings.draft_lot_sold).toBe(true);
  });

  it("survives a setting written by an older, or a broken, version", () => {
    for (const stored of [undefined, null, "yes", 3, [], { unknown_kind: true }]) {
      expect(announcementSettingsFrom(stored)).toEqual(defaultAnnouncementSettings());
    }
  });

  it("round-trips through the value it stores", () => {
    const wanted = { ...defaultAnnouncementSettings(), application_waitlisted: true };
    expect(announcementSettingsFrom(announcementSettingsValue(wanted))).toEqual(wanted);
  });

  it("drops a kind that no longer exists rather than storing it", () => {
    const stored = announcementSettingsValue(
      normaliseAnnouncementSettings({ event_published: false, retired_kind: true })
    ) as Record<string, unknown>;
    expect(stored.retired_kind).toBeUndefined();
    expect(stored.event_published).toBe(false);
  });
});

describe("the webhook URL from the deployment alone", () => {
  it("is null when the variable is unset or blank — the whole off switch", () => {
    expect(resolveWebhookUrl(null, {})).toBeNull();
    expect(resolveWebhookUrl(null, { DISCORD_WEBHOOK_URL: "" })).toBeNull();
    expect(resolveWebhookUrl(null, { DISCORD_WEBHOOK_URL: "   " })).toBeNull();
  });

  it("is null for a typo rather than something fetch will throw on", () => {
    expect(resolveWebhookUrl(null, { DISCORD_WEBHOOK_URL: "not a url" })).toBeNull();
    expect(resolveWebhookUrl(null, { DISCORD_WEBHOOK_URL: "ftp://example.test/hook" })).toBeNull();
  });

  it("accepts the real thing, and a local listener to test against", () => {
    expect(resolveWebhookUrl(null, { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc" })).toBe(
      "https://discord.com/api/webhooks/1/abc"
    );
    expect(resolveWebhookUrl(null, { DISCORD_WEBHOOK_URL: "http://127.0.0.1:4599/hook" })).toBe(
      "http://127.0.0.1:4599/hook"
    );
  });
});

describe("the site origin", () => {
  it("falls back from the public URL to AUTH_URL", () => {
    expect(siteOrigin({ AUTH_URL: "http://localhost:3400" })).toBe("http://localhost:3400");
    expect(
      siteOrigin({ NEXT_PUBLIC_SITE_URL: "https://job-centre.test/x", AUTH_URL: "http://a.test" })
    ).toBe("https://job-centre.test");
  });

  it("is null when nothing says, and links then disappear rather than break", () => {
    expect(siteOrigin({})).toBeNull();
    expect(siteOrigin({ AUTH_URL: "nonsense" })).toBeNull();
    expect(linkTo("/events/x", null)).toBeNull();
    expect(linkTo("events/x", "https://a.test")).toBe("https://a.test/events/x");
  });
});

describe("settings over environment", () => {
  const env = {
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/111/env-token",
    NEXT_PUBLIC_SITE_URL: "https://old.vercel.app",
  };

  it("prefers what an admin set on the screen", () => {
    expect(resolveWebhookUrl("https://discord.com/api/webhooks/222/set-token", env)).toBe(
      "https://discord.com/api/webhooks/222/set-token"
    );
    expect(resolveSiteOrigin("https://jobcentre.vercel.app", env)).toBe(
      "https://jobcentre.vercel.app"
    );
  });

  it("falls back to the deployment when nothing is stored", () => {
    expect(resolveWebhookUrl(null, env)).toBe(env.DISCORD_WEBHOOK_URL);
    expect(resolveSiteOrigin(undefined, env)).toBe("https://old.vercel.app");
  });

  it("treats a cleared setting as no opinion, not as off", () => {
    // Clearing the override drops back to the environment. Reading a blank
    // string as "switch announcements off" would make Clear a trap.
    expect(resolveWebhookUrl("", env)).toBe(env.DISCORD_WEBHOOK_URL);
    expect(resolveSiteOrigin("   ", env)).toBe("https://old.vercel.app");
  });

  it("falls through a stored value that is not a URL rather than going silent", () => {
    expect(resolveWebhookUrl("not a url", env)).toBe(env.DISCORD_WEBHOOK_URL);
    expect(resolveSiteOrigin("jobcentre", env)).toBe("https://old.vercel.app");
  });

  it("is null when neither says anything", () => {
    expect(resolveWebhookUrl(null, {})).toBeNull();
    expect(resolveSiteOrigin(null, {})).toBeNull();
  });

  it("keeps only the origin, so a pasted link does not prefix every message", () => {
    expect(resolveSiteOrigin("https://jobcentre.vercel.app/admin/settings?tab=x", {})).toBe(
      "https://jobcentre.vercel.app"
    );
  });

  it("leaves the old single-argument form working", () => {
    expect(siteOrigin(env)).toBe("https://old.vercel.app");
  });
});

describe("masking a webhook", () => {
  it("keeps the id and hides the token", () => {
    const masked = maskWebhook("https://discord.com/api/webhooks/1399/AbCdEfGhIjKlMnOp");
    expect(masked).toContain("1399");
    expect(masked).not.toContain("EfGhIjKlMnOp");
  });

  it("shows enough of a real token to tell two apart, and no more", () => {
    // A Discord webhook token is about 68 characters. At that length four of
    // them identify which webhook this is without being worth anything.
    const long = (prefix: string) => `${prefix}${"x".repeat(64)}`;
    const one = maskWebhook(`https://discord.com/api/webhooks/1399/${long("AAAA")}`);
    const two = maskWebhook(`https://discord.com/api/webhooks/1399/${long("BBBB")}`);
    expect(one).not.toBe(two);
    expect(one).not.toContain(long("AAAA"));
    expect(two).not.toContain(long("BBBB"));
  });

  it("never returns the input unchanged", () => {
    const raw = "https://discord.com/api/webhooks/1399/AbCdEfGhIjKlMnOp";
    expect(maskWebhook(raw)).not.toBe(raw);
  });

  it("hides a short token completely, prefix and all", () => {
    // Four characters of a long token identify it. Four characters of a short
    // one are the whole thing, which is how a mask becomes a leak.
    for (const secret of ["abc", "zk4t", "shortish-token"]) {
      const masked = maskWebhook(`https://example.test/inbound/${secret}`);
      expect(masked).not.toContain(secret);
      expect(masked).toContain("•");
    }
  });

  it("never lets a token survive masking, at any length", () => {
    const lengths = [1, 4, 16, 17, 32, 68];
    for (const length of lengths) {
      const secret = "S".repeat(length);
      const masked = maskWebhook(`https://discord.com/api/webhooks/1399/${secret}`) ?? "";
      expect(masked).not.toContain(secret);
    }
  });

  it("gives back nothing for nothing, and does not throw on rubbish", () => {
    expect(maskWebhook(null)).toBeNull();
    expect(maskWebhook("not a url")).toBe("•••");
  });
});

describe("timestamps", () => {
  it("are Discord stamps, so every reader sees their own zone", () => {
    // The suite pins TZ to Europe/Budapest; the point of this assertion is that
    // the output does not depend on that.
    expect(stamp(new Date("2026-09-12T16:00:00Z"))).toBe("<t:1789228800:F>");
    expect(stamp(new Date("2026-09-12T16:00:00Z"), "R")).toBe("<t:1789228800:R>");
  });
});

describe("an event being published", () => {
  const base = {
    title: "March Rivals Cup",
    slug: "march-rivals-cup",
    origin: "https://job-centre.test",
  };

  it("names it, links to it, and says how many places there are", () => {
    const message = eventPublishedMessage({ ...base, capacity: 48 });
    const [embed] = message.embeds;
    expect(embed.title).toBe("March Rivals Cup");
    expect(embed.url).toBe("https://job-centre.test/events/march-rivals-cup");
    expect(embed.fields).toContainEqual({ name: "Places", value: "48", inline: true });
  });

  it("says so when it is uncapped, rather than showing a zero", () => {
    const [embed] = eventPublishedMessage({ ...base, capacity: null }).embeds;
    expect(embed.fields).toContainEqual({ name: "Places", value: "No limit", inline: true });
  });

  it("puts the times in as stamps and never as formatted dates", () => {
    const [embed] = eventPublishedMessage({
      ...base,
      startsAt: new Date("2026-09-12T16:00:00Z"),
      signupClosesAt: new Date("2026-09-10T16:00:00Z"),
    }).embeds;
    const values = (embed.fields ?? []).map((field) => field.value).join(" ");
    expect(values).toContain("<t:1789228800:F>");
    expect(values).toContain("<t:1789056000:R>");
    expect(values).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("drops the link entirely when nothing says where the site is", () => {
    const [embed] = eventPublishedMessage({ ...base, origin: null }).embeds;
    expect(embed.url).toBeUndefined();
  });

  it("falls back to a sentence when the event has no description", () => {
    const [embed] = eventPublishedMessage({ ...base, description: null }).embeds;
    expect(embed.description).toContain("Applications are open");
  });

  it("clamps a title Discord would reject the whole message for", () => {
    const [embed] = eventPublishedMessage({ ...base, title: "x".repeat(500) }).embeds;
    expect(embed.title.length).toBeLessThanOrEqual(240);
    expect(embed.title.endsWith("…")).toBe(true);
  });
});

describe("an application decision", () => {
  const base = { member: "Beko", eventTitle: "March Cup", slug: "march-cup", origin: null };

  it("says somebody is in", () => {
    const [embed] = applicationDecidedMessage("application_accepted", base).embeds;
    expect(embed.description).toBe("**Beko** is in.");
  });

  it("gives a waitlisted member their place in the queue", () => {
    const [embed] = applicationDecidedMessage("application_waitlisted", {
      ...base,
      waitlistPosition: 3,
    }).embeds;
    expect(embed.description).toContain("number 3 in the queue");
  });

  it("does not invent a position it was not given", () => {
    const [embed] = applicationDecidedMessage("application_waitlisted", {
      ...base,
      waitlistPosition: null,
    }).embeds;
    expect(embed.description).toBe("**Beko** is on the waitlist.");
  });

  it("says a declined member was not accepted, and nothing more", () => {
    const [embed] = applicationDecidedMessage("application_declined", base).embeds;
    expect(embed.description).toBe("**Beko** was not accepted this time.");
    expect(embed.footer?.text).toBe("Declined");
  });
});

describe("a lot selling", () => {
  const base = { player: "Beko", team: "Rivals Red", eventTitle: "March Cup", slug: "march-cup" };

  it("reads as the room says it", () => {
    const [embed] = lotSoldMessage({ ...base, price: 250 }).embeds;
    expect(embed.title).toBe("Beko → Rivals Red");
    expect(embed.description).toBe("Sold for **250**.");
  });

  it("says a nought price in words, because 0 reads as a missing number", () => {
    const [embed] = lotSoldMessage({ ...base, price: 0 }).embeds;
    expect(embed.description).toBe("Went for nothing.");
  });

  it("links into the draft room", () => {
    const [embed] = lotSoldMessage({ ...base, price: 5, origin: "https://a.test" }).embeds;
    expect(embed.url).toBe("https://a.test/events/march-cup/draft");
  });
});

describe("a result", () => {
  const base = {
    label: "Upper semi-final",
    teamA: "Rivals Red",
    teamB: "Rivals Blue",
    eventTitle: "March Cup",
    slug: "march-cup",
  };

  it("is the scoreline, with who took it", () => {
    const [embed] = matchResultMessage({
      ...base,
      gamesWonA: 2,
      gamesWonB: 1,
      winner: "Rivals Red",
    }).embeds;
    expect(embed.title).toBe("Rivals Red 2–1 Rivals Blue");
    expect(embed.description).toBe("**Rivals Red** take it.");
  });

  it("says a draw is still waiting on somebody", () => {
    const [embed] = matchResultMessage({
      ...base,
      gamesWonA: 1,
      gamesWonB: 1,
      winner: null,
    }).embeds;
    expect(embed.description).toContain("Drawn");
  });
});

describe("every message", () => {
  const all = [
    eventPublishedMessage({ title: "T", slug: "t" }),
    applicationDecidedMessage("application_accepted", {
      member: "@everyone",
      eventTitle: "T",
      slug: "t",
    }),
    lotSoldMessage({ player: "@here", team: "T", price: 1, eventTitle: "T", slug: "t" }),
    matchResultMessage({
      label: "F",
      teamA: "@everyone",
      teamB: "B",
      gamesWonA: 1,
      gamesWonB: 0,
      winner: "@everyone",
      eventTitle: "T",
      slug: "t",
    }),
  ];

  it("refuses to ping anybody, whatever somebody called themselves", () => {
    // A display name is under the member's control. A name of `@everyone` that
    // pings four hundred people is how a webhook integration gets switched off.
    for (const message of all) {
      expect(message.allowed_mentions).toEqual({ parse: [] });
    }
  });

  it("posts under the site's name, with exactly one embed", () => {
    for (const message of all) {
      expect(message.username).toBe("Job Centre Events");
      expect(message.embeds).toHaveLength(1);
      expect(typeof message.embeds[0].color).toBe("number");
    }
  });
});

/* ================================================================== */
/* Task 59 — the wording as data (R-201 / UC-37)                      */
/* ================================================================== */

/**
 * One call per kind, with the arguments fixed, so every test below can ask the
 * same seven questions of the same seven messages.
 *
 * The `TopOfTable` cast is the one piece of scaffolding: `topOfTheTable` is
 * `championship-policy`'s to build and this file is about wording, so the
 * shape is written out rather than computed.
 */
const STARTS = new Date("2026-05-01T18:00:00Z");
const CLOSES = new Date("2026-04-25T18:00:00Z");
const ORIGIN = "https://jc.test";

const TOP = {
  lead: "changed",
  rows: [
    { position: 1, name: "Beko Lolek", points: 25, level: false },
    { position: 2, name: "Other", points: 18, level: false },
  ],
} as unknown as TopOfTable;

function build(kind: AnnouncementKind, template: AnnouncementTemplate | null = null) {
  switch (kind) {
    case "event_published":
      return eventPublishedMessage(
        {
          title: "Friday REPO night",
          slug: "friday-repo",
          capacity: 12,
          startsAt: STARTS,
          signupClosesAt: CLOSES,
          origin: ORIGIN,
        },
        template
      );
    case "signups_open":
      // The same event and the same arguments as `event_published` above, so
      // every sweep below compares the two kinds on like for like.
      return signupsOpenMessage(
        {
          title: "Friday REPO night",
          slug: "friday-repo",
          capacity: 12,
          startsAt: STARTS,
          signupClosesAt: CLOSES,
          origin: ORIGIN,
        },
        template
      );
    case "signups_closing_soon":
      /*
       * The same event again, and `full: false` — so the sweeps below compare
       * like for like, and so the fullness sentence this fixture pins is the
       * *ordinary* one. The full case is a second golden
       * (`AS_IT_IS_FULL_AND_CLOSING`), for the reason `AS_IT_IS_PUBLISHED_EARLY`
       * is one: a kind that grows a case grows a golden.
       *
       * `closes` is markup rather than a `Date`, which is the builder's own
       * contract — `dueScheduledAnnouncements` has already stamped it.
       */
      return signupsClosingSoonMessage(
        {
          title: "Friday REPO night",
          slug: "friday-repo",
          closes: stamp(CLOSES, "R"),
          capacity: 12,
          full: false,
          origin: ORIGIN,
        },
        template
      );
    case "event_starting_soon":
      return eventStartingSoonMessage(
        {
          title: "Friday REPO night",
          slug: "friday-repo",
          starts: stamp(STARTS),
          origin: ORIGIN,
        },
        template
      );
    case "application_accepted":
    case "application_declined":
      return applicationDecidedMessage(
        kind,
        {
          member: "Beko Lolek",
          eventTitle: "Friday REPO night",
          slug: "friday-repo",
          origin: ORIGIN,
        },
        template
      );
    case "application_waitlisted":
      return applicationDecidedMessage(
        kind,
        {
          member: "Beko Lolek",
          eventTitle: "Friday REPO night",
          slug: "friday-repo",
          waitlistPosition: 3,
          origin: ORIGIN,
        },
        template
      );
    case "draft_lot_sold":
      return lotSoldMessage(
        {
          player: "Beko Lolek",
          team: "Rivals Red",
          price: 1200,
          eventTitle: "Friday REPO night",
          slug: "friday-repo",
          origin: ORIGIN,
        },
        template
      );
    case "match_result":
      return matchResultMessage(
        {
          label: "Upper semi-final",
          teamA: "Rivals Red",
          teamB: "Rivals Blue",
          gamesWonA: 2,
          gamesWonB: 1,
          winner: "Rivals Red",
          eventTitle: "Friday REPO night",
          slug: "friday-repo",
          origin: ORIGIN,
        },
        template
      );
    case "standings_changed":
      return standingsMessage(
        {
          seasonName: "Spring 2026",
          slug: "spring-2026",
          eventTitle: "Friday REPO night",
          top: TOP,
          origin: ORIGIN,
        },
        template
      );
  }
}

const ALL_KINDS = ANNOUNCEMENTS.map((spec) => spec.kind);

/**
 * What each kind posted **before Task 59 existed**, serialised.
 *
 * These are not expectations written by hand from reading the code: they were
 * captured by running the seven builders out of `git show f207112:` — the file
 * as it stood before an override could be stored at all — and the two sets
 * came out `diff`-clean. So this is the real previous wire format, down to the
 * key order, and it is the assertion R-201's "a kind nobody has edited must
 * post byte-for-byte what it posts today" actually makes.
 *
 * `JSON.stringify` rather than `toEqual` on purpose, three times over: it
 * catches a key whose *order* moved (the body Discord receives is a string,
 * and `content` inserted in the wrong place is a different string), it catches
 * a key that arrived holding `undefined`, and it is the only form in which
 * "byte for byte" means anything at all.
 *
 * ## What these strings promise — all ten kinds, not just the one below
 *
 * Not "these bytes forever". Each one is **the bytes its builder produced for
 * the inputs it was given**, which are the inputs in `build` above. The two
 * readings only come apart when a kind learns a fact it could not previously
 * be told — `event_published` learning that an event's signups open a week
 * later is the first case to arrive — and there the golden still is that
 * builder's own answer for its own inputs, so it stands untouched and the new
 * case is captured beside it (`AS_IT_IS_PUBLISHED_EARLY` below). A kind that
 * grows a case grows a golden; it does not get its old one rewritten.
 *
 * What no golden here may do is move because somebody reworded a message.
 * R-201's promise is about an unedited **wording**, and a reworded default is
 * a deployment quietly changing what the channel says — the exact thing these
 * strings exist to catch. So rewriting one is a decision taken on purpose and
 * written down here beside it, never a snapshot updated to make a suite green.
 */
const AS_IT_WAS: Record<AnnouncementKind, string> = {
  event_published:
    '{"username":"Job Centre Events","embeds":[{"title":"Friday REPO night","description":"Applications are open — three taps if your profile is filled in.","url":"https://jc.test/events/friday-repo","color":14922300,"fields":[{"name":"Starts","value":"<t:1777658400:F>","inline":true},{"name":"Applications close","value":"<t:1777140000:R>","inline":true},{"name":"Places","value":"12","inline":true}],"footer":{"text":"New event"}}],"allowed_mentions":{"parse":[]}}',
  application_accepted:
    '{"username":"Job Centre Events","embeds":[{"title":"Friday REPO night","description":"**Beko Lolek** is in.","url":"https://jc.test/events/friday-repo","color":4054148,"footer":{"text":"Accepted"}}],"allowed_mentions":{"parse":[]}}',
  application_waitlisted:
    '{"username":"Job Centre Events","embeds":[{"title":"Friday REPO night","description":"**Beko Lolek** is on the waitlist, number 3 in the queue.","url":"https://jc.test/events/friday-repo","color":15855076,"footer":{"text":"Waitlisted"}}],"allowed_mentions":{"parse":[]}}',
  application_declined:
    '{"username":"Job Centre Events","embeds":[{"title":"Friday REPO night","description":"**Beko Lolek** was not accepted this time.","url":"https://jc.test/events/friday-repo","color":16731420,"footer":{"text":"Declined"}}],"allowed_mentions":{"parse":[]}}',
  draft_lot_sold:
    '{"username":"Job Centre Events","embeds":[{"title":"Beko Lolek → Rivals Red","description":"Sold for **1,200**.","url":"https://jc.test/events/friday-repo/draft","color":14922300,"fields":[{"name":"Event","value":"Friday REPO night","inline":true}],"footer":{"text":"Draft"}}],"allowed_mentions":{"parse":[]}}',
  match_result:
    '{"username":"Job Centre Events","embeds":[{"title":"Rivals Red 2–1 Rivals Blue","description":"**Rivals Red** take it.","url":"https://jc.test/events/friday-repo?tab=results","color":4054148,"fields":[{"name":"Match","value":"Upper semi-final","inline":true},{"name":"Event","value":"Friday REPO night","inline":true}],"footer":{"text":"Result"}}],"allowed_mentions":{"parse":[]}}',
  standings_changed:
    '{"username":"Job Centre Events","embeds":[{"title":"Spring 2026","description":"**Beko Lolek** takes the lead after **Friday REPO night**.","url":"https://jc.test/championship/spring-2026","color":14922300,"fields":[{"name":"1st","value":"Beko Lolek — 25","inline":true},{"name":"2nd","value":"Other — 18","inline":true}],"footer":{"text":"Standings"}}],"allowed_mentions":{"parse":[]}}',
  /*
   * `signups_open` is the one entry here that is **not** a pre-Task-59
   * capture, because there was nothing to capture: the kind did not exist
   * before Task 62. It is still captured rather than written by hand — the
   * value below was taken from this file's own failure output on a first run
   * with a deliberately wrong golden, which is the same discipline and the
   * only way the key order means anything.
   *
   * What it holds this kind to is therefore the forward promise rather than
   * the backward one: an unedited `signups_open` posts *this*, with no
   * `content` key and `{"parse":[]}`, so the day somebody wires a trigger up
   * they are wiring up a payload that has been read.
   */
  signups_open:
    '{"username":"Job Centre Events","embeds":[{"title":"Friday REPO night","description":"Applications have opened — three taps if your profile is filled in.","url":"https://jc.test/events/friday-repo","color":4054148,"fields":[{"name":"Starts","value":"<t:1777658400:F>","inline":true},{"name":"Applications close","value":"<t:1777140000:R>","inline":true},{"name":"Places","value":"12","inline":true}],"footer":{"text":"Applications open"}}],"allowed_mentions":{"parse":[]}}',
  /*
   * The last two are the same kind of entry as `signups_open` above and not the
   * kind above that: there was nothing to capture from before, because neither
   * kind existed before Task 68. Each was taken from this file's own failure
   * output on a first run with a deliberately wrong golden — the same
   * discipline, and the only way the key order means anything.
   *
   * What they hold these kinds to is the forward promise: an unedited
   * `signups_closing_soon` posts *this*, with no `content` key and
   * `{"parse":[]}`, so the admin who switches it on is switching on a payload
   * somebody has read.
   */
  signups_closing_soon:
    '{"username":"Job Centre Events","embeds":[{"title":"Friday REPO night","description":"Applications close <t:1777140000:R>. There are still places.","url":"https://jc.test/events/friday-repo","color":16731420,"fields":[{"name":"Applications close","value":"<t:1777140000:R>","inline":true},{"name":"Places","value":"12","inline":true}],"footer":{"text":"Closing soon"}}],"allowed_mentions":{"parse":[]}}',
  event_starting_soon:
    '{"username":"Job Centre Events","embeds":[{"title":"Friday REPO night","description":"Starts <t:1777658400:F> — if you are in, this is your reminder.","url":"https://jc.test/events/friday-repo","color":4054148,"fields":[{"name":"Starts","value":"<t:1777658400:F>","inline":true}],"footer":{"text":"Starting soon"}}],"allowed_mentions":{"parse":[]}}',
};

/** The event in `build("event_published")`, published a week before it opens. */
const PUBLISHED_EARLY_AT = new Date("2026-03-25T12:00:00Z");
const OPENS_AT = new Date("2026-04-01T12:00:00Z");

/**
 * `event_published` for the event the golden above **cannot speak for**: one
 * published a week before its signups open (R-205 / UC-38 2).
 *
 * The golden above still stands, and this is why rather than a rewrite of it.
 * Its fixture names no `signupOpensAt`, which is not a fact left out of a test
 * but a definite event: `publishingOpensSignups` answers `true` for a null
 * window start, so what it captured is an event with nothing holding its
 * signups shut — open the instant it goes up, and the only event
 * `eventPublishedMessage` could be *told about* before `signupOpensAt` and
 * `publishedAt` existed on its input. R-201's "a kind nobody has edited posts
 * byte-for-byte what it posts today" is a promise about an unedited **wording**,
 * and it is kept to the byte for that event: the payload above is untouched,
 * and nothing an admin has or has not saved changes it.
 *
 * The event below is a different event, not a different wording — one no
 * previous payload existed for, because the builder had no field to learn about
 * it from. So it gets a golden of its own rather than a licence to edit the one
 * next door, and R-201 needs no re-reading. The pair is also the assertion that
 * matters: change either sentence and exactly one of these two fails, naming
 * which event the channel would have been lied to about.
 *
 * Captured the same way as `signups_open` above — from this file's own failure
 * output on a first run with a deliberately wrong golden — so the key order,
 * the absent `content` and the field order each mean what they say.
 */
const AS_IT_IS_PUBLISHED_EARLY =
  '{"username":"Job Centre Events","embeds":[{"title":"Friday REPO night","description":"Applications open <t:1775044800:R> — three taps if your profile is filled in.","url":"https://jc.test/events/friday-repo","color":14922300,"fields":[{"name":"Starts","value":"<t:1777658400:F>","inline":true},{"name":"Applications open","value":"<t:1775044800:F>","inline":true},{"name":"Applications close","value":"<t:1777140000:R>","inline":true},{"name":"Places","value":"12","inline":true}],"footer":{"text":"New event"}}],"allowed_mentions":{"parse":[]}}';

/**
 * `signups_closing_soon` for the event its golden **cannot speak for**: a full
 * one (UC-38 4c).
 *
 * A second golden rather than an edit of the first, for the reason
 * `AS_IT_IS_PUBLISHED_EARLY` is one — a kind that grows a case grows a golden.
 * And the case is not a decoration: UC-38 4c says a full event *still* gets
 * this announcement, because a waitlist place is worth having, and that the
 * message says it is full. Those are two claims, and only a payload can hold
 * the second one.
 *
 * Unlike the goldens above, this one was **written** rather than captured —
 * from the entry next door, changing the one sentence fullness changes — and
 * then confirmed by this file on its first run. That is only honest because the
 * two differ in exactly one field; anything less mechanical than that, and
 * capturing from the failure output is the discipline (see `signups_open`).
 */
const AS_IT_IS_FULL_AND_CLOSING =
  '{"username":"Job Centre Events","embeds":[{"title":"Friday REPO night","description":"Applications close <t:1777140000:R>. The event is full, so this is for the waitlist.","url":"https://jc.test/events/friday-repo","color":16731420,"fields":[{"name":"Applications close","value":"<t:1777140000:R>","inline":true},{"name":"Places","value":"12","inline":true}],"footer":{"text":"Closing soon"}}],"allowed_mentions":{"parse":[]}}';

function buildFullAndClosing(template: AnnouncementTemplate | null = null) {
  // `build("signups_closing_soon")`'s event, full. One field differs from that
  // fixture, so the pair is a clean statement about what fullness changes.
  return signupsClosingSoonMessage(
    {
      title: "Friday REPO night",
      slug: "friday-repo",
      closes: stamp(CLOSES, "R"),
      capacity: 12,
      full: true,
      origin: ORIGIN,
    },
    template
  );
}

function buildPublishedEarly(template: AnnouncementTemplate | null = null) {
  return eventPublishedMessage(
    {
      title: "Friday REPO night",
      slug: "friday-repo",
      capacity: 12,
      startsAt: STARTS,
      signupOpensAt: OPENS_AT,
      publishedAt: PUBLISHED_EARLY_AT,
      signupClosesAt: CLOSES,
      origin: ORIGIN,
    },
    template
  );
}

describe("a kind nobody has edited (UC-37 2a)", () => {
  it("posts byte for byte what it posted before an override could exist", () => {
    for (const kind of ALL_KINDS) {
      expect(JSON.stringify(build(kind))).toBe(AS_IT_WAS[kind]);
    }
  });

  it("posts the same whether the row is missing or present with no wording", () => {
    /*
     * The two states drizzle/0029 distinguishes, and the reason there is no
     * backfill. No row at all is `null`; a row an admin made to choose a
     * mention and then chose none is `{ body: null, mention: NO_MENTION }`.
     * Both are "unedited", so both must be the same bytes — otherwise opening
     * the screen and saving nothing would change what the channel says.
     */
    for (const kind of ALL_KINDS) {
      const asRow = build(kind, { body: null, mention: NO_MENTION });
      expect(JSON.stringify(asRow)).toBe(AS_IT_WAS[kind]);
    }
  });

  it("has no content key at all, rather than an empty one", () => {
    // `"content": ""` is a different payload from no `content`, and Discord
    // rejects a message that is empty in both `content` and `embeds`.
    for (const kind of ALL_KINDS) {
      expect(build(kind)).not.toHaveProperty("content");
      expect(Object.keys(build(kind))).toEqual(["username", "embeds", "allowed_mentions"]);
    }
  });

  it("posts its own payload for an event published before its signups open", () => {
    // The second golden rather than an edit of the first — see
    // `AS_IT_IS_PUBLISHED_EARLY` for which promise each of them carries.
    expect(JSON.stringify(buildPublishedEarly())).toBe(AS_IT_IS_PUBLISHED_EARLY);
    expect(JSON.stringify(buildPublishedEarly({ body: null, mention: NO_MENTION }))).toBe(
      AS_IT_IS_PUBLISHED_EARLY
    );
    expect(Object.keys(buildPublishedEarly())).toEqual(["username", "embeds", "allowed_mentions"]);
    // And the event the first golden is about is still byte for byte itself,
    // asserted here too so the pair fails together rather than a file apart.
    expect(JSON.stringify(build("event_published"))).toBe(AS_IT_WAS.event_published);
  });

  it("posts its own payload for an event that is full and closing (UC-38 4c)", () => {
    expect(JSON.stringify(buildFullAndClosing())).toBe(AS_IT_IS_FULL_AND_CLOSING);
    expect(JSON.stringify(buildFullAndClosing({ body: null, mention: NO_MENTION }))).toBe(
      AS_IT_IS_FULL_AND_CLOSING
    );
    // And the event with seats left is still byte for byte itself, so the pair
    // fails together and names which of the two the channel would be wrong to.
    expect(JSON.stringify(build("signups_closing_soon"))).toBe(AS_IT_WAS.signups_closing_soon);
  });
});

/* ================================================================== */
/* Task 68 — the two kinds the clock posts (R-206, R-207 / UC-38)     */
/* ================================================================== */

describe("applications closing tomorrow (R-206 / UC-38 3, 4c)", () => {
  /**
   * UC-38 4c, as the two claims it actually makes.
   *
   * Asserted on the **sentence** rather than on a flag, because "says it is
   * full" is a claim about words a reader sees. And not with a bare
   * `toContain("full")`: the word has to be in the *description*, which is the
   * only part of the embed an admin's wording can replace and the only part a
   * reader reads as a sentence. A match anywhere in the serialised payload
   * would be satisfied by a field label or a footer somebody added later —
   * which is the shape of the `toContain("PAGE_SHELL")` that a comment
   * satisfied on this project.
   */
  it("still posts for a full event, and says so in the description", () => {
    const full = buildFullAndClosing();
    expect(full.embeds[0].description).toContain("full");
    expect(full.embeds[0].description).toBe(
      `Applications close ${stamp(CLOSES, "R")}. ${CLOSING_SOON_FULLNESS.full}`
    );
  });

  it("says something other than nothing when the event is not full", () => {
    /*
     * The other half, and the one that stops `{full}` being a blank. An event
     * with seats left must not render the fullness as an empty string — a
     * placeholder that silently disappears is the mistake found in the channel,
     * and it is also how the assertion above goes vacuous.
     */
    const open = build("signups_closing_soon");
    expect(open.embeds[0].description).toContain(CLOSING_SOON_FULLNESS.open);
    expect(open.embeds[0].description).not.toContain("full");
    // The two sentences are different, and neither is empty.
    expect(CLOSING_SOON_FULLNESS.open.trim()).not.toBe("");
    expect(CLOSING_SOON_FULLNESS.full.trim()).not.toBe("");
    expect(CLOSING_SOON_FULLNESS.open).not.toBe(CLOSING_SOON_FULLNESS.full);
  });

  it("renders {full} as the right sentence in an admin's own wording", () => {
    // The placeholder, not the default sentence: an admin who rewords this
    // keeps the fact, which is the whole reason `{full}` exists rather than the
    // fullness being hard-wired into the compiled copy.
    const wording: AnnouncementTemplate = {
      body: "{title} shuts {closes}. {full} Seats: {places}.",
      mention: NO_MENTION,
    };
    expect(buildFullAndClosing(wording).embeds[0].description).toBe(
      `Friday REPO night shuts ${stamp(CLOSES, "R")}. ${CLOSING_SOON_FULLNESS.full} Seats: 12.`
    );
    expect(build("signups_closing_soon", wording).embeds[0].description).toBe(
      `Friday REPO night shuts ${stamp(CLOSES, "R")}. ${CLOSING_SOON_FULLNESS.open} Seats: 12.`
    );
  });

  it("says “No limit” for an uncapped event rather than a hole", () => {
    const uncapped = signupsClosingSoonMessage(
      {
        title: "Friday REPO night",
        slug: "friday-repo",
        closes: stamp(CLOSES, "R"),
        capacity: null,
        full: false,
        origin: ORIGIN,
      },
      { body: "{places}", mention: NO_MENTION }
    );
    expect(uncapped.embeds[0].description).toBe("No limit");
    // And the embed's own field agrees with the wording beside it.
    expect(uncapped.embeds[0].fields).toEqual([
      { name: "Applications close", value: stamp(CLOSES, "R"), inline: true },
      { name: "Places", value: "No limit", inline: true },
    ]);
  });
});

describe("an event starting soon (R-207 / UC-38 4)", () => {
  it("carries the start as Discord markup and nothing a server formatted", () => {
    const message = build("event_starting_soon");
    expect(message.embeds[0].description).toBe(
      `Starts ${stamp(STARTS)} — if you are in, this is your reminder.`
    );
    expect(message.embeds[0].fields).toEqual([
      { name: "Starts", value: stamp(STARTS), inline: true },
    ]);
  });

  it("offers only the two facts it has", () => {
    /*
     * The vocabulary, asserted as the whole list rather than as two
     * `toContain`s. A kind that gained `{places}` or `{closes}` by somebody
     * copying a table would satisfy the narrower assertion, and the reason this
     * kind does not offer them is in `ANNOUNCEMENT_PLACEHOLDERS`: both are
     * about a door that shut before this announcement fires.
     */
    expect(placeholdersFor("event_starting_soon").map((p) => p.name)).toEqual(["title", "starts"]);
    expect(placeholdersFor("signups_closing_soon").map((p) => p.name)).toEqual([
      "title",
      "closes",
      "places",
      "full",
    ]);
  });

  it("refuses a placeholder from the kind next door, naming what it does offer", () => {
    // The two new kinds have overlapping-looking vocabularies, which is exactly
    // when a wording written for one gets pasted into the other.
    const problem = announcementTemplateProblem("event_starting_soon", {
      body: "{title} closes {closes}.",
      mention: NO_MENTION,
    });
    expect(problem).toContain("{closes}");
    expect(problem).toContain("{starts}");
    expect(problem).toContain("{title}");
    // And the other direction: `{starts}` is not a fact this one has.
    expect(
      announcementTemplateProblem("signups_closing_soon", {
        body: "{title} starts {starts}.",
        mention: NO_MENTION,
      })
    ).toContain("{starts}");
  });
});

describe("the placeholder vocabulary", () => {
  it("covers every kind, and only kinds", () => {
    expect(Object.keys(ANNOUNCEMENT_PLACEHOLDERS).sort()).toEqual([...ALL_KINDS].sort());
  });

  it("offers a placeholder only to the kinds that have it", () => {
    /*
     * The rule Task 59 is about, as a table. `{position}` is a fact about a
     * waitlisting; `{winner}` and `{score}` are facts about a series; `{price}`
     * is a fact about a lot. A kind that offered one of these without having it
     * is a wording that renders a hole in a channel nobody can unsend.
     */
    const named = (kind: AnnouncementKind) =>
      placeholdersFor(kind).map((placeholder) => placeholder.name);

    expect(named("event_published")).toEqual(["title", "places", "starts", "closes"]);
    // The same four facts as the kind above, because it is the same event at
    // the other moment — and deliberately no `{opens}`, whose only honest
    // rendering is "now" and would be a formatted instant on the server.
    expect(named("signups_open")).toEqual(["title", "places", "starts", "closes"]);
    expect(named("signups_open")).not.toContain("opens");
    expect(named("application_accepted")).toEqual(["member", "event"]);
    expect(named("application_waitlisted")).toEqual(["member", "event", "position"]);
    expect(named("application_declined")).toEqual(["member", "event"]);
    expect(named("draft_lot_sold")).toEqual(["player", "team", "price", "event"]);
    expect(named("match_result")).toEqual([
      "teamA",
      "teamB",
      "score",
      "winner",
      "match",
      "event",
    ]);
    expect(named("standings_changed")).toEqual(["season", "event", "leader"]);

    // And the two that make the table mean something: the one kind with a
    // queue place, and the three without it.
    expect(named("application_waitlisted")).toContain("position");
    for (const kind of ["application_accepted", "application_declined", "draft_lot_sold"] as const) {
      expect(named(kind)).not.toContain("position");
    }
  });

  it("never lets an absent value render as nothing", () => {
    /*
     * The whole reason `whenAbsent` exists. Every optional placeholder declares
     * the words it posts when the value is missing, and an empty string is not
     * one of them — a wording that silently renders as nothing is the mistake
     * found in the channel, which is the same argument that makes an unoffered
     * placeholder a refusal.
     */
    for (const kind of ALL_KINDS) {
      for (const placeholder of placeholdersFor(kind)) {
        expect(placeholder.example.trim()).not.toBe("");
        if (placeholder.whenAbsent !== undefined) {
          expect(placeholder.whenAbsent.trim()).not.toBe("");
        }
      }
    }
  });
});

describe("an edited kind", () => {
  it("posts the admin's wording with every placeholder filled", () => {
    const message = build("application_waitlisted", {
      body: "{member} is queued for {event} at number {position}.",
      mention: NO_MENTION,
    });
    expect(message.embeds[0].description).toBe(
      "Beko Lolek is queued for Friday REPO night at number 3."
    );
  });

  it("leaves everything but the sentence alone", () => {
    // The title, the colour, the footer and the link are structure, not
    // wording: an edited announcement is still a Job Centre announcement.
    const before = build("draft_lot_sold").embeds[0];
    const after = build("draft_lot_sold", {
      body: "{player} to {team} for {price}.",
      mention: NO_MENTION,
    }).embeds[0];
    expect(after.description).toBe("Beko Lolek to Rivals Red for 1,200.");
    expect({ ...after, description: "" }).toEqual({ ...before, description: "" });
  });

  it("renders times as Discord stamps, so an edited wording keeps every reader's own zone", () => {
    // The repo invariant (README, "Times"): no message ever contains a
    // formatted date, and an admin cannot make one contain a formatted date.
    const description = build("event_published", {
      body: "Kicks off {starts}, closing {closes}. {places} places.",
      mention: NO_MENTION,
    }).embeds[0].description;
    expect(description).toBe(
      `Kicks off ${stamp(STARTS)}, closing ${stamp(CLOSES, "R")}. 12 places.`
    );
    expect(description).not.toMatch(/2026/);
  });

  it("posts the declared words when an optional value is missing, never a hole", () => {
    const drawn = matchResultMessage(
      {
        label: "",
        teamA: "Rivals Red",
        teamB: "Rivals Blue",
        gamesWonA: 1,
        gamesWonB: 1,
        winner: null,
        eventTitle: "Friday REPO night",
        slug: "friday-repo",
      },
      { body: "{winner} won {match}.", mention: NO_MENTION }
    );
    expect(drawn.embeds[0].description).toBe("nobody yet won this round.");
    // The thing that must not happen: the sentence collapsing to " won ."
    expect(drawn.embeds[0].description).not.toContain("  ");
  });

  it("leaves a placeholder its kind has since stopped offering visibly in place", () => {
    /*
     * Unreachable through a save, because the save refuses it — this is the row
     * written by a version of the screen whose vocabulary has since changed. A
     * visible `{captain}` gets noticed and fixed; replacing it with nothing is
     * the silent hole the refusal exists to prevent, so render must fail the
     * same way the save does rather than tidy it away.
     */
    const message = build("application_accepted", {
      body: "{member} is in, says {captain}.",
      mention: NO_MENTION,
    });
    expect(message.embeds[0].description).toBe("Beko Lolek is in, says {captain}.");
  });

  it("clamps a rendered wording Discord would drop the whole message for", () => {
    // A refusal at save means this should never fire; `clamp`'s own comment is
    // why it is here anyway — a message that vanishes is indistinguishable
    // from a webhook that is down, and that is the one failure to avoid.
    const message = build("application_accepted", {
      body: `${"x".repeat(DISCORD_LIMITS.description)} {member}`,
      mention: NO_MENTION,
    });
    expect(message.embeds[0].description?.length).toBe(DISCORD_LIMITS.description);
    expect(message.embeds[0].description?.endsWith("…")).toBe(true);
  });
});

describe("saving a wording", () => {
  const ok = (kind: AnnouncementKind, body: string | null) =>
    announcementTemplateProblem(kind, { body, mention: NO_MENTION });

  it("refuses a placeholder the kind does not offer, naming the ones it does (UC-37 3a)", () => {
    const problem = ok("draft_lot_sold", "Sold to {captain} for {price}.");
    expect(problem).toBe(
      "This announcement has no {captain}. It offers {player}, {team}, {price}, {event}."
    );
  });

  it("refuses a placeholder that belongs to a different kind", () => {
    // The case the per-kind table exists for: `{position}` is real, and real
    // on exactly one kind.
    expect(ok("application_waitlisted", "{member} is number {position}.")).toBeNull();
    expect(ok("application_accepted", "{member} is number {position}.")).toBe(
      "This announcement has no {position}. It offers {member}, {event}."
    );
  });

  it("refuses empty wording, because that is the switch (UC-37 3b)", () => {
    for (const empty of ["", " ", "\n", "\t  \n"]) {
      const problem = ok("application_accepted", empty);
      // `toBe` on the type first, so removing the guard reads as "expected
      // null to be a string" rather than as a TypeError inside the matcher.
      expect(typeof problem, `${JSON.stringify(empty)} was accepted`).toBe("string");
      expect(problem).toMatch(/switch/);
    }
  });

  it("allows a null body, which is not empty wording but “leave it alone”", () => {
    for (const kind of ALL_KINDS) expect(ok(kind, null)).toBeNull();
  });

  it("refuses a wording over Discord's limit, saying the limit (UC-37 3c)", () => {
    expect(ok("application_accepted", "x".repeat(DISCORD_LIMITS.description))).toBeNull();
    const problem = ok("application_accepted", "x".repeat(DISCORD_LIMITS.description + 1));
    expect(problem).toBe(
      `Discord accepts ${DISCORD_LIMITS.description} characters in an announcement; that is ${DISCORD_LIMITS.description + 1}.`
    );
  });

  it("refuses a role name pasted where an id goes", () => {
    // `@RoleName` is inert on Discord (R-203). An admin who pastes one must be
    // told, not left wondering why nobody was notified.
    for (const bad of ["@Regulars", "Regulars", "123", "12345678901234567890123", "123456789012345678x"]) {
      const problem = announcementTemplateProblem("application_accepted", {
        body: null,
        mention: { everyone: false, roleIds: [bad] },
      });
      expect(typeof problem, `“${bad}” was accepted as a role id`).toBe("string");
      expect(problem).toMatch(/not a role id/);
    }
  });

  it("accepts a real snowflake", () => {
    expect(
      announcementTemplateProblem("application_accepted", {
        body: null,
        mention: { everyone: true, roleIds: ["123456789012345678", "98765432109876543210"] },
      })
    ).toBeNull();
  });
});

describe("reading a stored row", () => {
  it("takes nothing on trust, the way the switches do not", () => {
    expect(announcementTemplateFrom(undefined)).toEqual({ body: null, mention: NO_MENTION });
    expect(announcementTemplateFrom("a string")).toEqual({ body: null, mention: NO_MENTION });
    expect(announcementTemplateFrom([])).toEqual({ body: null, mention: NO_MENTION });
    expect(announcementTemplateFrom({ body: 7, roleIds: "nope" })).toEqual({
      body: null,
      mention: NO_MENTION,
    });
  });

  it("only ever reads a real true as “everyone”", () => {
    /*
     * The one field where a loose read would be a ping of four hundred people.
     * `"true"`, `1` and `"yes"` are all the sort of thing a hand-run UPDATE or
     * an older screen writes, and none of them is an admin asking for it.
     */
    for (const value of ["true", 1, "yes", {}, [], null, undefined]) {
      expect(announcementTemplateFrom({ everyone: value }).mention.everyone).toBe(false);
    }
    expect(announcementTemplateFrom({ everyone: true }).mention.everyone).toBe(true);
  });

  it("drops a stored role id that is not a snowflake", () => {
    expect(
      announcementTemplateFrom({
        roleIds: ["123456789012345678", "@Regulars", 42, null, "9"],
      }).mention.roleIds
    ).toEqual(["123456789012345678"]);
  });

  it("treats a blank stored body as no wording rather than as empty wording", () => {
    expect(announcementTemplateFrom({ body: "   " }).body).toBeNull();
  });
});

/* ================================================================== */
/* Task 60 — a mention is only ever the admin's own words             */
/* ================================================================== */

/**
 * The security-critical half, asked of real payloads.
 *
 * Two real-looking role ids: one the admin picks, one a member puts in their
 * own display name. Keeping them distinct is the whole of the second
 * acceptance criterion — a naive `parse: ["roles"]` passes every test that
 * only ever uses one role.
 */
const PICKED = "123456789012345678";
const SMUGGLED = "987654321098765432";

describe("a display name cannot ping anybody (R-202, UC-37 4c)", () => {
  /** Every kind, built with a member-controlled string in every slot. */
  const hostile = (name: string, template: AnnouncementTemplate | null) => [
    eventPublishedMessage({ title: name, slug: "t", description: name }, template),
    applicationDecidedMessage(
      "application_accepted",
      { member: name, eventTitle: name, slug: "t" },
      template
    ),
    applicationDecidedMessage(
      "application_waitlisted",
      { member: name, eventTitle: name, slug: "t", waitlistPosition: 2 },
      template
    ),
    applicationDecidedMessage(
      "application_declined",
      { member: name, eventTitle: name, slug: "t" },
      template
    ),
    lotSoldMessage({ player: name, team: name, price: 1, eventTitle: name, slug: "t" }, template),
    matchResultMessage(
      {
        label: name,
        teamA: name,
        teamB: name,
        gamesWonA: 1,
        gamesWonB: 0,
        winner: name,
        eventTitle: name,
        slug: "t",
      },
      template
    ),
    standingsMessage(
      {
        seasonName: name,
        slug: "t",
        eventTitle: name,
        top: {
          lead: "changed",
          rows: [{ position: 1, name, points: 1, level: false }],
        } as unknown as TopOfTable,
      },
      template
    ),
  ];

  it("cannot make any announcement ping the server, on a real payload", () => {
    /*
     * The first and worst case. A member renames themselves `@everyone`, and
     * every kind is built with that string in every field it has — including
     * through an *edited* wording that interpolates it, and alongside a
     * template that mentions a role, which is the state in which a careless
     * implementation would have turned mention parsing on.
     */
    const templates: Array<AnnouncementTemplate | null> = [
      null,
      { body: null, mention: NO_MENTION },
      { body: "{member}", mention: NO_MENTION },
      { body: "{member}", mention: { everyone: false, roleIds: [PICKED] } },
    ];

    for (const template of templates) {
      for (const message of hostile("@everyone", template)) {
        // `everyone` is not in `parse`, so Discord will not honour it wherever
        // it appears — this is the assertion, not an absence of the string.
        expect(message.allowed_mentions.parse).toEqual([]);
        // And it never reached `content`, which is the other half.
        expect(message.content ?? "").not.toContain("@everyone");
      }
    }
  });

  it("cannot ping a role, even when the template mentions a different one", () => {
    /*
     * **The case a naive `parse: ["roles"]` fails.** The admin's template
     * mentions one role, so role mentions are plainly wanted in this message;
     * the member has `<@&SMUGGLED>` in their display name. With `parse`
     * carrying "roles", Discord would honour both. With an allow-list of exact
     * ids, the member's role is simply not on it.
     */
    const template: AnnouncementTemplate = {
      body: "A result for {member}",
      mention: { everyone: false, roleIds: [PICKED] },
    };

    for (const message of hostile(`<@&${SMUGGLED}>`, template)) {
      expect(message.allowed_mentions.roles).toEqual([PICKED]);
      expect(message.allowed_mentions.parse).toEqual([]);
      // Named nowhere it could be honoured, whatever the embed contains.
      expect(message.allowed_mentions.roles).not.toContain(SMUGGLED);
      expect(message.content).toBe(`<@&${PICKED}>`);
    }
  });

  it("puts every interpolated value in the embed and nothing else in content", () => {
    /*
     * Structural, not by eye (the acceptance criterion says so): `content` is
     * matched against a pattern that admits *only* mention tokens, so any
     * interpolation leaking into it fails whatever the string happens to be.
     */
    const ONLY_MENTIONS = /^(?:@everyone|<@&[0-9]{17,20}>)(?: (?:@everyone|<@&[0-9]{17,20}>))*$/;
    const template: AnnouncementTemplate = {
      body: "{member} — {event}",
      mention: { everyone: true, roleIds: [PICKED] },
    };

    for (const message of hostile("@everyone <@&" + SMUGGLED + "> @here", template)) {
      expect(message.content).toMatch(ONLY_MENTIONS);
      // The member's string is in the payload — it just is not in `content`.
      expect(JSON.stringify(message.embeds)).toContain(SMUGGLED);
      expect(message.content).not.toContain(SMUGGLED);
      expect(message.content).not.toContain("@here");
    }
  });
});

describe("the mention line", () => {
  it("is built from the stored choice and nothing else", () => {
    expect(mentionLine(NO_MENTION)).toBe("");
    expect(mentionLine({ everyone: true, roleIds: [] })).toBe("@everyone");
    expect(mentionLine({ everyone: false, roleIds: [PICKED, SMUGGLED] })).toBe(
      `<@&${PICKED}> <@&${SMUGGLED}>`
    );
    expect(mentionLine({ everyone: true, roleIds: [PICKED] })).toBe(`@everyone <@&${PICKED}>`);
  });

  it("drops a stored id that is not a snowflake rather than writing it out", () => {
    /*
     * The second of the two snowflake checks, and the one that matters: this is
     * the only thing between a stored value and the `content` field. A row
     * written by hand must not be able to put text there.
     */
    expect(
      mentionLine({ everyone: false, roleIds: ["@everyone", "' or 1=1", "123456789012345678"] })
    ).toBe("<@&123456789012345678>");
  });
});

describe("allowed_mentions", () => {
  it("is exactly the two ids a template mentioning two roles used, with no parse entry", () => {
    const mentions = allowedMentionsFor({ everyone: false, roleIds: [PICKED, SMUGGLED] });
    expect(mentions).toEqual({ parse: [], roles: [PICKED, SMUGGLED] });
    // An allow-list, never `parse: ["roles"]` — see the module comment.
    expect(mentions.parse).not.toContain("roles");
  });

  it("permits everyone only when the template itself contains it", () => {
    expect(allowedMentionsFor({ everyone: false, roleIds: [] }).parse).toEqual([]);
    expect(allowedMentionsFor({ everyone: false, roleIds: [PICKED] }).parse).toEqual([]);
    expect(allowedMentionsFor({ everyone: true, roleIds: [] }).parse).toEqual(["everyone"]);
  });

  it("omits roles entirely rather than sending an empty list", () => {
    expect(allowedMentionsFor(NO_MENTION)).toEqual({ parse: [] });
    expect(allowedMentionsFor()).toEqual({ parse: [] });
    expect("roles" in allowedMentionsFor(NO_MENTION)).toBe(false);
  });

  it("never names one mention type in both parse and an id list", () => {
    /*
     * Discord's reference calls `parse` "mutually exclusive with the other
     * fields" and then gives a valid example that combines them, so the
     * boundary is genuinely unstated — and `{ parse: ["users"], users: [...] }`
     * is documented as a validation error. The safe rule is never to test it:
     * `parse` carries at most "everyone" and the id list carries only roles.
     */
    for (const everyone of [true, false]) {
      for (const roleIds of [[], [PICKED], [PICKED, SMUGGLED]]) {
        const mentions = allowedMentionsFor({ everyone, roleIds });
        expect(mentions.parse.every((type) => type === "everyone")).toBe(true);
        expect(mentions).not.toHaveProperty("users");
        if (mentions.roles) expect(mentions.parse).not.toContain("roles");
      }
    }
  });

  it("drops a non-snowflake id so it is never sent as an allowed id either", () => {
    expect(allowedMentionsFor({ everyone: false, roleIds: ["nope", PICKED] })).toEqual({
      parse: [],
      roles: [PICKED],
    });
  });
});

/* ================================================================== */
/* Task 62 — signups opening is its own moment (R-205 / UC-38 2, 2a)  */
/* ================================================================== */

describe("whether publishing is itself the moment signups open (UC-38 2a)", () => {
  /*
   * The decision the eighth kind is arranged around. Every assertion names the
   * case and the answer, because `true` here means "post one announcement" and
   * `false` means "post one now and one later" — a boolean whose two values
   * are two different channels, so a test that only counted calls could not
   * tell them apart.
   */
  const PUBLISHED_AT = new Date("2026-04-01T12:00:00Z");

  it("is one moment when the window opened before the event went up", () => {
    const aWeekEarlier = new Date("2026-03-25T12:00:00Z");
    expect(publishingOpensSignups({ signupOpensAt: aWeekEarlier }, PUBLISHED_AT)).toBe(true);
  });

  it("is two moments when the window opens after the event goes up", () => {
    const aWeekLater = new Date("2026-04-08T12:00:00Z");
    expect(publishingOpensSignups({ signupOpensAt: aWeekLater }, PUBLISHED_AT)).toBe(false);
  });

  it("is one moment on the boundary, matching applicationsOpen's inclusive window", () => {
    /*
     * `applicationsOpen` shuts only on `now < opensAt`, so an event published
     * at exactly the instant its signups open *is* open. One second either
     * side of that is the whole difference between one post and two, which is
     * why the boundary is asserted rather than assumed.
     */
    expect(publishingOpensSignups({ signupOpensAt: PUBLISHED_AT }, PUBLISHED_AT)).toBe(true);
    expect(
      publishingOpensSignups({ signupOpensAt: new Date(PUBLISHED_AT.getTime() + 1) }, PUBLISHED_AT)
    ).toBe(false);
    expect(
      publishingOpensSignups({ signupOpensAt: new Date(PUBLISHED_AT.getTime() - 1) }, PUBLISHED_AT)
    ).toBe(true);
  });

  it("is one moment when there is no opening instant at all", () => {
    // Nothing holds signups shut, so there is no second moment to announce.
    // `missingToPublish` will not let this through the publish gate, but the
    // answer has to be right rather than absent.
    expect(publishingOpensSignups({ signupOpensAt: null }, PUBLISHED_AT)).toBe(true);
  });

  it("compares instants rather than Date identity", () => {
    // Two `Date` objects for the same moment are the same answer — the bug
    // `changedSetupFields` has a comment about.
    const same = new Date(PUBLISHED_AT.getTime());
    expect(same).not.toBe(PUBLISHED_AT);
    expect(publishingOpensSignups({ signupOpensAt: same }, PUBLISHED_AT)).toBe(true);
  });
});

describe("the published announcement of an event nobody can apply to yet (UC-38 2)", () => {
  /*
   * The other half of 2a, and the half that was missed when the eighth kind
   * was built: posting *one* announcement for an event published ahead of its
   * window is only right if that one announcement is true. "Applications are
   * open" is what `applicationsOpen` answers `too_early` to, so the channel
   * was being sent to a door that does not open for another week.
   *
   * Every case below names the window start and the publish instant together,
   * because neither one alone is a case — the pair is the fact.
   */
  const published = (over: Partial<EventPublishedInput> = {}) =>
    eventPublishedMessage({
      title: "Friday REPO night",
      slug: "friday-repo",
      capacity: 12,
      startsAt: STARTS,
      signupClosesAt: CLOSES,
      origin: ORIGIN,
      ...over,
    }).embeds[0];

  const fieldNames = (embed: { fields?: ReadonlyArray<{ name: string }> }) =>
    (embed.fields ?? []).map((field) => field.name);

  it("says when applications open, not that they are open", () => {
    const embed = published({ signupOpensAt: OPENS_AT, publishedAt: PUBLISHED_EARLY_AT });

    expect(embed.description).toBe(
      `Applications open ${stamp(OPENS_AT, "R")} — three taps if your profile is filled in.`
    );
    // The sentence this fix exists to delete from this event's announcement.
    expect(embed.description).not.toContain("Applications are open");
  });

  it("never shows a closing time without an opening one on an event not yet open", () => {
    const embed = published({ signupOpensAt: OPENS_AT, publishedAt: PUBLISHED_EARLY_AT });

    expect(embed.fields).toContainEqual({
      name: "Applications open",
      value: stamp(OPENS_AT),
      inline: true,
    });
    // The half-told fact this fixes: a countdown to the shutting of a door
    // that has not opened, with nothing saying when it will.
    expect(fieldNames(embed)).toContain("Applications close");
    // The two ends of the window read together, in the order they happen.
    expect(fieldNames(embed)).toEqual([
      "Starts",
      "Applications open",
      "Applications close",
      "Places",
    ]);
  });

  it("says applications are open, with no extra field, when publishing opens them", () => {
    const embed = published({
      signupOpensAt: new Date("2026-03-18T12:00:00Z"),
      publishedAt: PUBLISHED_EARLY_AT,
    });

    expect(embed.description).toBe(
      "Applications are open — three taps if your profile is filled in."
    );
    // A field saying when they opened is not news to a reader already told
    // they are open — and would be a fourth field on every announcement the
    // site has ever posted (R-201 / UC-37 2a).
    expect(fieldNames(embed)).not.toContain("Applications open");
  });

  it("treats the boundary instant as open, matching publishingOpensSignups", () => {
    // One function decides both the sentence and whether a second
    // announcement is due, so the inclusive boundary has to be the same one.
    const onTheInstant = published({
      signupOpensAt: PUBLISHED_EARLY_AT,
      publishedAt: PUBLISHED_EARLY_AT,
    });
    expect(onTheInstant.description).toBe(
      "Applications are open — three taps if your profile is filled in."
    );

    const aMillisecondLater = published({
      signupOpensAt: new Date(PUBLISHED_EARLY_AT.getTime() + 1),
      publishedAt: PUBLISHED_EARLY_AT,
    });
    expect(aMillisecondLater.description).toContain("Applications open <t:");
  });

  it("says applications are open when nothing holds them shut", () => {
    // A null window start is `publishingOpensSignups`'s other `true`: there is
    // no instant at which signups open, because nothing is keeping them shut.
    // This is also the event both goldens' predecessor captured.
    const embed = published({ signupOpensAt: null, publishedAt: PUBLISHED_EARLY_AT });
    expect(embed.description).toBe(
      "Applications are open — three taps if your profile is filled in."
    );
    expect(fieldNames(embed)).not.toContain("Applications open");
  });

  it("does not claim applications are open when it was given no publish instant", () => {
    /*
     * Unreachable from the site — `announceEventPublished` passes both — and
     * asserted anyway, because this is the case a future call site gets wrong
     * by passing the column it has and not the clock. Of the two sentences,
     * only one can send a reader to a form that refuses them, so a window
     * start with nothing to compare it against reads as the later moment.
     */
    const embed = published({ signupOpensAt: OPENS_AT });
    expect(embed.description).not.toContain("Applications are open");
    expect(fieldNames(embed)).toContain("Applications open");
  });

  it("leaves the event's own description alone, and still says when it opens", () => {
    // The sentence is a fallback; the field is structure. An admin who wrote a
    // description keeps it, and the fact still reaches the embed.
    const embed = published({
      description: "Thirty-two of you, one bracket, no mercy.",
      signupOpensAt: OPENS_AT,
      publishedAt: PUBLISHED_EARLY_AT,
    });

    expect(embed.description).toBe("Thirty-two of you, one bracket, no mercy.");
    expect(fieldNames(embed)).toContain("Applications open");
  });

  it("never formats the opening instant itself", () => {
    // The repo invariant (README, "Times"): the opening date reaches Discord as
    // a stamp in both the sentence and the field, and in neither as a date this
    // process chose a timezone for.
    const embed = published({ signupOpensAt: OPENS_AT, publishedAt: PUBLISHED_EARLY_AT });
    expect(JSON.stringify(embed)).not.toMatch(/2026|April|Apr/);
  });
});

describe("the signups-open announcement", () => {
  it("says applications have opened, not that an event exists", () => {
    /*
     * The two kinds carry the same three facts, so the sentence and the footer
     * are the whole difference a reader sees — asserted as the exact strings,
     * because "the description is not empty" would pass with the two kinds
     * posting identical messages, which is the mistake this kind exists to
     * avoid.
     */
    const opened = build("signups_open").embeds[0];
    const published = build("event_published").embeds[0];

    expect(opened.description).toBe(
      "Applications have opened — three taps if your profile is filled in."
    );
    expect(opened.footer).toEqual({ text: "Applications open" });
    expect(published.footer).toEqual({ text: "New event" });
    expect(opened.description).not.toBe(published.description);
    expect(opened.color).not.toBe(published.color);
    // And the facts a reader needs are still all there, not trimmed because
    // the published message said them once already.
    expect(opened.fields).toEqual(published.fields);
    expect(opened.url).toBe("https://jc.test/events/friday-repo");
  });

  it("renders times as Discord stamps in an edited wording too", () => {
    // The repo invariant (README, "Times"), and the reason there is no
    // `{opens}`: no message this module builds contains a formatted date.
    const description = build("signups_open", {
      body: "Doors open. Kicks off {starts}, closing {closes}. {places} places for {title}.",
      mention: NO_MENTION,
    }).embeds[0].description;

    expect(description).toBe(
      `Doors open. Kicks off ${stamp(STARTS)}, closing ${stamp(CLOSES, "R")}. 12 places for Friday REPO night.`
    );
    expect(description).not.toMatch(/2026/);
  });

  it("posts the declared words when a date is missing, never a hole", () => {
    const undated = signupsOpenMessage(
      { title: "Friday REPO night", slug: "friday-repo", capacity: null },
      { body: "Open now. Starts {starts}, closes {closes}. {places} places.", mention: NO_MENTION }
    );
    expect(undated.embeds[0].description).toBe(
      "Open now. Starts a time still to be confirmed, closes no closing date. No limit places."
    );
    // The thing that must not happen: the sentence collapsing to "Starts ,".
    expect(undated.embeds[0].description).not.toContain(" ,");
    expect(undated.embeds[0].description).not.toContain("  ");
  });

  it("refuses a placeholder it does not offer, naming the four it does", () => {
    expect(
      announcementTemplateProblem("signups_open", {
        body: "{member} may now apply.",
        mention: NO_MENTION,
      })
    ).toBe("This announcement has no {member}. It offers {title}, {places}, {starts}, {closes}.");
    // And the one whose only honest rendering would be the present instant.
    expect(
      announcementTemplateProblem("signups_open", {
        body: "Applications opened {opens}.",
        mention: NO_MENTION,
      })
    ).toBe("This announcement has no {opens}. It offers {title}, {places}, {starts}, {closes}.");
  });

  it("drops the fields it has no values for rather than posting empty ones", () => {
    const undated = signupsOpenMessage({ title: "Friday REPO night", slug: "friday-repo" });
    expect(undated.embeds[0].fields).toEqual([{ name: "Places", value: "No limit", inline: true }]);
  });

  it("drops the link when nothing says where the site is", () => {
    const message = signupsOpenMessage({ title: "Friday REPO night", slug: "friday-repo" });
    expect(message.embeds[0]).not.toHaveProperty("url");
  });
});
