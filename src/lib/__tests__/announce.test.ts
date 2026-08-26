import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENTS,
  announcementSettingsFrom,
  announcementSettingsValue,
  applicationDecidedMessage,
  defaultAnnouncementSettings,
  eventPublishedMessage,
  linkTo,
  lotSoldMessage,
  maskWebhook,
  matchResultMessage,
  normaliseAnnouncementSettings,
  resolveSiteOrigin,
  resolveWebhookUrl,
  siteOrigin,
  stamp,
  webhookUrl,
} from "@/lib/announce";

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
  });

  it("has a spec for every kind, and only for kinds", () => {
    expect(ANNOUNCEMENTS).toHaveLength(5);
    expect(new Set(ANNOUNCEMENTS.map((spec) => spec.kind)).size).toBe(5);
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

describe("the webhook URL", () => {
  it("is null when the variable is unset or blank — the whole off switch", () => {
    expect(webhookUrl({})).toBeNull();
    expect(webhookUrl({ DISCORD_WEBHOOK_URL: "" })).toBeNull();
    expect(webhookUrl({ DISCORD_WEBHOOK_URL: "   " })).toBeNull();
  });

  it("is null for a typo rather than something fetch will throw on", () => {
    expect(webhookUrl({ DISCORD_WEBHOOK_URL: "not a url" })).toBeNull();
    expect(webhookUrl({ DISCORD_WEBHOOK_URL: "ftp://example.test/hook" })).toBeNull();
  });

  it("accepts the real thing, and a local listener to test against", () => {
    expect(webhookUrl({ DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc" })).toBe(
      "https://discord.com/api/webhooks/1/abc"
    );
    expect(webhookUrl({ DISCORD_WEBHOOK_URL: "http://127.0.0.1:4599/hook" })).toBe(
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
