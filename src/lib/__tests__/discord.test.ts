import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Database,
  SETTING_KEYS,
  announcementClaims,
  announcementTemplates,
  applications,
  eventDays,
  events,
} from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import type {
  AnnouncementKind,
  AnnouncementSettings,
  DiscordMessage,
} from "@/lib/announce";
import { EVENT_STARTING_LEAD_MS } from "@/lib/announce-schedule";

/*
 * Posting, against a real in-memory Postgres and a fake Discord.
 *
 * Three things are replaced, plus a spy. `@/db`'s `db` is pointed at this
 * file's database, because `deliver` reads the webhook and writes its failure
 * row through the default handle. `after()` collects the deferred work instead
 * of needing a request, so a test awaits exactly the job it started rather
 * than sleeping. And `fetch` is a stub: nothing in this file can reach Discord.
 * The spy is on the decision message builder, which calls the real one unless
 * a test makes it throw.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  jobs: [] as Array<Promise<void>>,
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

vi.mock("@/lib/announce", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/announce")>();
  return { ...actual, applicationDecidedMessage: vi.fn(actual.applicationDecidedMessage) };
});

vi.mock("next/server", () => ({
  after: (work: () => Promise<void>) => {
    state.jobs.push(work());
  },
}));

const {
  announceApplicationDecision,
  announceEventPublished,
  getAnnouncementSettings,
  getAnnouncementTemplate,
  getAnnouncementTemplates,
  postDueAnnouncements,
  setAnnouncementSettings,
  setAnnouncementTemplate,
  setIntegrationSetting,
  unedited,
} = await import("@/lib/discord");
type PostedAnnouncement = Awaited<ReturnType<typeof postDueAnnouncements>>["posted"][number];
const {
  CLOSING_SOON_FULLNESS,
  NO_MENTION,
  applicationDecidedMessage,
  defaultAnnouncementSettings,
  publishingOpensSignups,
  signupsOpenMessage,
  stamp,
} = await import("@/lib/announce");
const { listAudit, recordAudit } = await import("@/lib/audit");
const { loadDashboard } = await import("@/lib/admin-dashboard");
const { applyToEvent, createEvent, publishEvent, setApplicationStatus, setEventDays } =
  await import("@/lib/events");

let handle: TestDatabase;
let db: Database;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
});

afterAll(async () => {
  await handle.close();
});

const fetchStub = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

beforeEach(async () => {
  // Configured on the settings screen only — the environment says nothing.
  await setIntegrationSetting(SETTING_KEYS.webhookUrl, "https://discord.test/api/webhooks/1/token");
  vi.stubEnv("DISCORD_WEBHOOK_URL", "");
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchStub.mockReset();
  // Back to the real builder, in case a test made it throw and it never did.
  vi.mocked(applicationDecidedMessage).mockReset();
  vi.useRealTimers();
  state.jobs = [];
});

let counter = 0;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** Switch exactly these on, everything else off. */
async function switches(on: Partial<AnnouncementSettings>) {
  const off = Object.fromEntries(
    Object.keys(defaultAnnouncementSettings()).map((kind) => [kind, false])
  ) as AnnouncementSettings;
  await setAnnouncementSettings({ ...off, ...on });
}

/** An application decided as `status`, on its own published event. */
async function decided(status: "waitlisted" | "declined") {
  counter += 1;
  const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Announce ${counter}` }, db));
  unwrap(await publishEvent(event.id, db));
  const member = await makeUser(db, { displayName: `Member ${counter}` });
  const application = unwrap(await applyToEvent(event.id, member, {}, db));
  unwrap(await setApplicationStatus(application.id, status, {}, db));
  return { eventId: event.id, applicationId: application.id };
}

/** Run the announcement and wait for the job it deferred. */
async function announced(applicationId: string) {
  announceApplicationDecision(applicationId);
  await Promise.all(state.jobs);
}

function posted(): DiscordMessage[] {
  return fetchStub.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as DiscordMessage);
}

/*
 * R-107 / UC-26 4: "System posts to the channel with a link to the event." The
 * one fact a reader needs before deciding whether to apply is when it is on,
 * and an event's dates are its days' (R-24) — `events` has no `starts_at` at
 * all since drizzle/0026, and the announcer that read it while it was there
 * posted an embed with no "Starts" field at all. `announce.test.ts` covers the
 * message *builder* with a date handed to it; this covers the announcer that
 * has to find the date.
 */
describe("an event published", () => {
  it("puts the start its days say in the embed (R-107, UC-26 4)", async () => {
    await switches({ event_published: true });
    counter += 1;
    const event = unwrap(
      await createEvent({ ...PUBLISHABLE, title: `Published ${counter}` }, db)
    );
    unwrap(await publishEvent(event.id, db));

    announceEventPublished(event.id);
    await Promise.all(state.jobs);

    const [message] = posted();
    expect(message.embeds[0].fields).toContainEqual({
      name: "Starts",
      value: stamp(PUBLISHABLE.days[0].startsAt),
      inline: true,
    });
  });

  it("follows the days when a manager moves them", async () => {
    await switches({ event_published: true });
    counter += 1;
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Moved ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));
    const moved = new Date("2100-02-09T17:30:00.000Z");
    unwrap(await setEventDays(event.id, [{ startsAt: moved }], db));

    announceEventPublished(event.id);
    await Promise.all(state.jobs);

    expect(posted()[0].embeds[0].fields).toContainEqual({
      name: "Starts",
      value: stamp(moved),
      inline: true,
    });
  });

  /*
   * R-205 / UC-38 2a — "only the published announcement posts. The two are one
   * moment, not two."
   *
   * `PUBLISHABLE`'s window opened in 2000, so every event in this file is the
   * 2a case: already taking applications the instant it goes up. The assertion
   * is the **list of footers**, not a call count, because a count of one is
   * also what a channel sees when the wrong one of the two fires, and a count
   * of zero is what it sees when neither does — and "neither fired" is how this
   * criterion passes vacuously.
   */
  it("posts one announcement, the published one, when signups were already open (UC-38 2a)", async () => {
    await switches({ event_published: true, signups_open: true });
    counter += 1;
    const event = unwrap(
      await createEvent({ ...PUBLISHABLE, title: `Already open ${counter}` }, db)
    );
    unwrap(await publishEvent(event.id, db));

    announceEventPublished(event.id);
    await Promise.all(state.jobs);

    expect(posted().map((message) => message.embeds[0].footer?.text)).toEqual(["New event"]);
    // And not because the eighth kind is switched off or missing: it is on,
    // and it is a real builder that would have posted a distinguishable
    // message had anything called it.
    expect((await getAnnouncementSettings()).signups_open).toBe(true);
    expect(signupsOpenMessage({ title: "x", slug: "x" }).embeds[0].footer).toEqual({
      text: "Applications open",
    });
    // The rule that decided it, asked of the row that was actually published.
    expect(publishingOpensSignups({ signupOpensAt: PUBLISHABLE.signupOpensAt }, new Date())).toBe(
      true
    );
    // And the sentence matches the event: these signups really are open.
    expect(posted()[0].embeds[0].description).toBe(
      "Applications are open — three taps if your profile is filled in."
    );
  });

  /*
   * R-205 / UC-38 2 the other way round — the case `PUBLISHABLE` never makes.
   *
   * `announce.test.ts` covers the two sentences the builder has; this covers
   * the only thing that can still be wrong once it does, which is the call
   * site: `signup_opens_at` is a stored column and the publish instant is a
   * clock read, and a message built without either one is the false sentence
   * again. Asserted on the payload that reached `fetch`, so threading the
   * column through cannot be dropped without a failure here.
   */
  it("says when applications open for an event published ahead of its window (UC-38 2)", async () => {
    await switches({ event_published: true, signups_open: true });
    counter += 1;
    const opensAt = new Date("2099-06-01T12:00:00.000Z");
    const event = unwrap(
      await createEvent(
        { ...PUBLISHABLE, signupOpensAt: opensAt, title: `Published early ${counter}` },
        db
      )
    );
    unwrap(await publishEvent(event.id, db));

    announceEventPublished(event.id);
    await Promise.all(state.jobs);

    const [embed] = posted()[0].embeds;
    expect(embed.description).toBe(
      `Applications open ${stamp(opensAt, "R")} — three taps if your profile is filled in.`
    );
    // The sentence that would send a channel to a form answering `too_early`.
    expect(embed.description).not.toContain("Applications are open");
    expect(embed.fields).toContainEqual({
      name: "Applications open",
      value: stamp(opensAt),
      inline: true,
    });
    // Still one announcement, and still the published one: the second moment
    // is the scheduler's (UC-38 2, Task 63), not this call site's.
    expect(posted().map((message) => message.embeds[0].footer?.text)).toEqual(["New event"]);
  });
});

/*
 * Task 59's gift, asserted on the real database: the store is keyed over
 * `ANNOUNCEMENTS`, so the eighth kind is editable with **no migration** and no
 * change to this module. If `announcement_templates.kind` had been an enum
 * rather than text, the save below would fail on a value the type does not
 * have — which is exactly what the column comment says it was made text to
 * avoid.
 */
describe("the eighth kind needs no migration (R-205)", () => {
  // `noOverrides` is declared further down and hoisted; it is the same reset
  // the wording tests use, so neither test here depends on the other's order.
  beforeEach(noOverrides);

  it("is in the template store with no row, like every other kind", async () => {
    const templates = await getAnnouncementTemplates(db);
    expect(templates.signups_open).toEqual(unedited());
  });

  it("stores and reads back a wording written against a text column", async () => {
    const saved = await setAnnouncementTemplate(
      "signups_open",
      { body: "Applications for {title} are open — {places} places.", mention: NO_MENTION },
      { expectedVersion: 0 },
      db
    );
    expect(saved).toEqual({
      ok: true,
      data: expect.objectContaining({
        body: "Applications for {title} are open — {places} places.",
        version: 1,
      }),
    });
    expect((await getAnnouncementTemplate("signups_open", db)).body).toBe(
      "Applications for {title} are open — {places} places."
    );

    // And the refusal reaches the new kind too, by its own vocabulary.
    expect(
      await setAnnouncementTemplate(
        "signups_open",
        { body: "{member} may apply.", mention: NO_MENTION },
        { expectedVersion: 1 },
        db
      )
    ).toEqual({
      ok: false,
      error: "This announcement has no {member}. It offers {title}, {places}, {starts}, {closes}.",
    });
  });
});

describe("an application decision", () => {
  it("posts a waitlisting when only the waitlisted switch is on", async () => {
    await switches({ application_accepted: false, application_waitlisted: true });
    const { applicationId } = await decided("waitlisted");

    await announced(applicationId);

    expect(posted().map((message) => message.embeds[0].footer?.text)).toEqual(["Waitlisted"]);
  });

  it("posts a decline when the declined switch is on", async () => {
    await switches({ application_declined: true });
    const { applicationId } = await decided("declined");

    await announced(applicationId);

    expect(posted().map((message) => message.embeds[0].footer?.text)).toEqual(["Declined"]);
  });

  it("posts nothing while an application is still awaiting review (R-27, UC-12 7b)", async () => {
    // An approval event's application is not a decision: nobody has decided.
    await switches({
      application_accepted: true,
      application_waitlisted: true,
      application_declined: true,
    });
    counter += 1;
    const event = unwrap(
      await createEvent(
        { ...PUBLISHABLE, title: `Approval ${counter}`, config: { entryMode: "approval" } },
        db
      )
    );
    unwrap(await publishEvent(event.id, db));
    const member = await makeUser(db, { displayName: `Waiting ${counter}` });
    const application = unwrap(await applyToEvent(event.id, member, {}, db));

    await announced(application.id);

    expect(fetchStub).not.toHaveBeenCalled();
    // Not even composed: there is no kind of announcement this row is.
    expect(applicationDecidedMessage).not.toHaveBeenCalled();
  });

  it("posts nothing for a decline while its switch is off", async () => {
    await switches({ application_accepted: true, application_waitlisted: true });
    const { applicationId } = await decided("declined");

    await announced(applicationId);

    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("a post Discord refuses", () => {
  it("is logged under the event it was about", async () => {
    await switches({ application_accepted: true, application_waitlisted: true });
    fetchStub.mockResolvedValue(new Response(null, { status: 500 }));
    const { eventId, applicationId } = await decided("waitlisted");

    await announced(applicationId);

    const rows = await listAudit({ eventId });
    expect(rows.filter((row) => row.action === "announcement.failed")).toHaveLength(1);
  });
});

describe("a message that cannot be built", () => {
  it("is logged under the event the decision was about", async () => {
    await switches({ application_waitlisted: true });
    vi.mocked(applicationDecidedMessage).mockImplementationOnce(() => {
      throw new Error("no sentence for that");
    });
    const { eventId, applicationId } = await decided("waitlisted");

    await announced(applicationId);

    const rows = await listAudit({ eventId });
    expect(rows.filter((row) => row.action === "announcement.failed")).toHaveLength(1);
  });
});

describe("no channel configured", () => {
  it("posts nothing and logs nothing", async () => {
    await setIntegrationSetting(SETTING_KEYS.webhookUrl, null);
    await switches({ application_waitlisted: true });
    const { eventId, applicationId } = await decided("waitlisted");

    await announced(applicationId);

    expect(fetchStub).not.toHaveBeenCalled();
    expect((await listAudit({ eventId })).filter((row) => row.action === "announcement.failed")).toEqual([]);
  });
});

/* ================================================================== */
/* Tasks 59 and 60 — the stored wording, against a real database      */
/* ================================================================== */

const PICKED = "123456789012345678";
const SMUGGLED = "987654321098765432";

/** Clear every stored override, so each test below starts from "unedited". */
async function noOverrides() {
  await db.delete(announcementTemplates);
}

describe("storing a wording", () => {
  beforeEach(noOverrides);

  it("starts every kind unedited, with no row and no mention", async () => {
    // The state drizzle/0029 leaves every existing deployment in, read back
    // through the function the announcers actually use.
    const all = await getAnnouncementTemplates(db);
    const kinds = Object.keys(defaultAnnouncementSettings());
    // Every kind, so a kind added later arrives covered rather than unasserted.
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(all[kind as keyof typeof all], kind).toEqual(unedited());
    }
    expect(await getAnnouncementTemplate("application_accepted", db)).toEqual({
      body: null,
      mention: NO_MENTION,
      version: 0,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it("stores the admin's wording and hands back version 1", async () => {
    const actor = { id: await makeUser(db, { displayName: "Admin Ada" }), displayName: "Admin Ada" };
    const saved = await setAnnouncementTemplate(
      "application_accepted",
      { body: "{member} is in for {event}.", mention: NO_MENTION },
      { expectedVersion: 0, actor },
      db
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data.version).toBe(1);
    expect(saved.data.body).toBe("{member} is in for {event}.");
    expect(saved.data.updatedBy).toBe(actor.id);

    // And read back the same, through the reader the announcers use.
    expect((await getAnnouncementTemplate("application_accepted", db)).body).toBe(
      "{member} is in for {event}."
    );
  });

  it("stores nothing at all when the wording is refused (UC-37 3a, 3b, 3c)", async () => {
    /*
     * The acceptance criterion is "and nothing is stored", which is the half a
     * test asserting only the error message would miss entirely.
     */
    const refusals: Array<[string | null, { everyone: boolean; roleIds: string[] }]> = [
      ["Sold to {captain}.", { everyone: false, roleIds: [] }],
      ["", { everyone: false, roleIds: [] }],
      ["x".repeat(5000), { everyone: false, roleIds: [] }],
      [null, { everyone: false, roleIds: ["@Regulars"] }],
    ];

    for (const [body, mention] of refusals) {
      const result = await setAnnouncementTemplate(
        "draft_lot_sold",
        { body, mention },
        { expectedVersion: 0 },
        db
      );
      expect(result.ok).toBe(false);
      // Nothing written, and so still the compiled copy.
      expect(await getAnnouncementTemplate("draft_lot_sold", db)).toEqual(unedited());
      expect(await db.select().from(announcementTemplates)).toEqual([]);
    }
  });

  it("names the placeholders the kind does offer when it refuses one (UC-37 3a)", async () => {
    const result = await setAnnouncementTemplate(
      "draft_lot_sold",
      { body: "Sold to {captain}.", mention: NO_MENTION },
      { expectedVersion: 0 },
      db
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("{player}, {team}, {price}, {event}");
  });

  it("lets an admin choose a mention without touching the wording", async () => {
    /*
     * The null-body state, which is why `body` is nullable in drizzle/0029.
     * Choosing a mention must not freeze one variant of the compiled copy into
     * a row — so the row exists, the mention is stored, and the body stays null.
     */
    const saved = await setAnnouncementTemplate(
      "application_waitlisted",
      { body: null, mention: { everyone: false, roleIds: [PICKED] } },
      { expectedVersion: 0 },
      db
    );
    expect(saved.ok).toBe(true);
    const stored = await getAnnouncementTemplate("application_waitlisted", db);
    expect(stored.body).toBeNull();
    expect(stored.mention).toEqual({ everyone: false, roleIds: [PICKED] });
  });

  it("keeps a role id whole, rather than rounding it to a number", async () => {
    // The `json` helper's reason for existing: a snowflake through a
    // double-parse comes back as 123456789012345680.
    await setAnnouncementTemplate(
      "application_accepted",
      { body: null, mention: { everyone: false, roleIds: [PICKED, SMUGGLED] } },
      { expectedVersion: 0 },
      db
    );
    expect((await getAnnouncementTemplate("application_accepted", db)).mention.roleIds).toEqual([
      PICKED,
      SMUGGLED,
    ]);
  });

  it("tells the loser of two saves at once, and shows them the current wording (UC-37 7a)", async () => {
    /*
     * Two admins open the same announcement at version 1 and both save. The
     * update is conditional on that version in the statement itself, so the
     * second one matches no rows — there is no read-then-write gap for both to
     * pass through.
     */
    await setAnnouncementTemplate(
      "application_accepted",
      { body: "First draft.", mention: NO_MENTION },
      { expectedVersion: 0 },
      db
    );

    const first = await setAnnouncementTemplate(
      "application_accepted",
      { body: "Ada's words.", mention: NO_MENTION },
      { expectedVersion: 1 },
      db
    );
    const second = await setAnnouncementTemplate(
      "application_accepted",
      { body: "Bo's words.", mention: NO_MENTION },
      { expectedVersion: 1 },
      db
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/changed this announcement while you were editing/);
    // Shown the current one, which is the winner's — not their own.
    expect(second.current?.body).toBe("Ada's words.");
    expect(second.current?.version).toBe(2);
    // And the loser's words are nowhere.
    expect((await getAnnouncementTemplate("application_accepted", db)).body).toBe("Ada's words.");
  });

  it("tells the loser when both admins were creating the first row", async () => {
    // The same race one version earlier, where the statement is an INSERT
    // rather than an UPDATE and the primary key is what decides.
    const first = await setAnnouncementTemplate(
      "match_result",
      { body: "Ada's words.", mention: NO_MENTION },
      { expectedVersion: 0 },
      db
    );
    const second = await setAnnouncementTemplate(
      "match_result",
      { body: "Bo's words.", mention: NO_MENTION },
      { expectedVersion: 0 },
      db
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.current?.body).toBe("Ada's words.");
  });

  it("records who edited it, and a line of its own for pinging everyone (UC-37 4c)", async () => {
    const actor = { id: await makeUser(db, { displayName: "Admin Ada" }), displayName: "Admin Ada" };

    await setAnnouncementTemplate(
      "event_published",
      { body: "{title} is live.", mention: NO_MENTION },
      { expectedVersion: 0, actor },
      db
    );
    /*
     * Filtered to this kind: the log is one table and the tests above it in
     * this file have been editing other kinds into it, which is realistic and
     * is exactly how an audit log is read — by subject.
     */
    const forKind = async (action?: string) =>
      (await listAudit({})).filter(
        (row) =>
          row.subject === "event_published" &&
          (action ? row.action === action : row.action.startsWith("announcement."))
      );

    let lines = await forKind();
    expect(lines.map((row) => row.action)).toEqual(["announcement.wording_changed"]);

    // Now it is set to ping the whole server, which gets its own row — a
    // question somebody asks of the log by scanning it.
    await setAnnouncementTemplate(
      "event_published",
      { body: "{title} is live.", mention: { everyone: true, roleIds: [] } },
      { expectedVersion: 1, actor },
      db
    );
    lines = await forKind("announcement.pings_everyone");
    expect(lines).toHaveLength(1);
    expect(lines[0].summary).toContain("pings the whole server");
    expect(lines[0].actor.name).toBe("Admin Ada");

    // Editing the wording again while it is already pinging does not re-raise
    // it: the row is for the transition, not for every save afterwards.
    await setAnnouncementTemplate(
      "event_published",
      { body: "{title} is live now.", mention: { everyone: true, roleIds: [] } },
      { expectedVersion: 2, actor },
      db
    );
    expect(await forKind("announcement.pings_everyone")).toHaveLength(1);
  });
});

describe("the wording an announcement actually posts", () => {
  beforeEach(noOverrides);

  it("is the compiled copy while nobody has edited the kind", async () => {
    await switches({ application_waitlisted: true });
    const { applicationId } = await decided("waitlisted");
    await announced(applicationId);

    const [message] = posted();
    expect(message.embeds[0].description).toMatch(/is on the waitlist/);
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message).not.toHaveProperty("content");
  });

  it("is the admin's, with the mention line in content and the ids allow-listed", async () => {
    await switches({ application_waitlisted: true });
    await setAnnouncementTemplate(
      "application_waitlisted",
      {
        body: "{member} is queued for {event} — number {position}.",
        mention: { everyone: false, roleIds: [PICKED, SMUGGLED] },
      },
      { expectedVersion: 0 },
      db
    );
    const { applicationId } = await decided("waitlisted");
    await announced(applicationId);

    const [message] = posted();
    expect(message.embeds[0].description).toMatch(/is queued for .* — number 1\.$/);
    expect(message.content).toBe(`<@&${PICKED}> <@&${SMUGGLED}>`);
    expect(message.allowed_mentions).toEqual({ parse: [], roles: [PICKED, SMUGGLED] });
  });

  it("does not let a display name of @everyone ping the server, on the real payload", async () => {
    /*
     * The acceptance criterion, end to end: a real member row whose display
     * name is `@everyone`, a real application, the real announcer, and the
     * actual JSON that would have gone to Discord — with an edited wording
     * that interpolates the name and a template that mentions a role, which is
     * the state a careless implementation turns parsing on in.
     */
    await switches({ application_waitlisted: true });
    await setAnnouncementTemplate(
      "application_waitlisted",
      { body: "{member} joins the queue.", mention: { everyone: false, roleIds: [PICKED] } },
      { expectedVersion: 0 },
      db
    );

    counter += 1;
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Hostile ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));
    const member = await makeUser(db, { displayName: "@everyone" });
    const application = unwrap(await applyToEvent(event.id, member, {}, db));
    unwrap(await setApplicationStatus(application.id, "waitlisted", {}, db));

    await announced(application.id);

    const [message] = posted();
    // The name is in the message — in the embed, where it is only ever text.
    expect(message.embeds[0].description).toContain("@everyone");
    // And Discord is told not to honour it.
    expect(message.allowed_mentions.parse).toEqual([]);
    expect(message.content).toBe(`<@&${PICKED}>`);
  });

  it("does not let a display name containing a role ping it, even beside a different role", async () => {
    // The case `parse: ["roles"]` would fail, on a real payload.
    await switches({ application_waitlisted: true });
    await setAnnouncementTemplate(
      "application_waitlisted",
      { body: "{member} joins the queue.", mention: { everyone: false, roleIds: [PICKED] } },
      { expectedVersion: 0 },
      db
    );

    counter += 1;
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Smuggle ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));
    const member = await makeUser(db, { displayName: `<@&${SMUGGLED}>` });
    const application = unwrap(await applyToEvent(event.id, member, {}, db));
    unwrap(await setApplicationStatus(application.id, "waitlisted", {}, db));

    await announced(application.id);

    const [message] = posted();
    expect(message.embeds[0].description).toContain(SMUGGLED);
    expect(message.allowed_mentions.roles).toEqual([PICKED]);
    expect(message.allowed_mentions.roles).not.toContain(SMUGGLED);
    expect(message.content).not.toContain(SMUGGLED);
  });

  it("posts the compiled copy when the wording cannot be read at all", async () => {
    /*
     * A database that cannot answer must not change what the channel says, and
     * in particular must not mention anybody. Same rule as
     * `getAnnouncementSettings`, and the one direction a failed read is allowed
     * to fall.
     */
    const broken = {
      select: () => {
        throw new Error("the database is down");
      },
    } as unknown as Database;
    expect(await getAnnouncementTemplate("application_accepted", broken)).toEqual(unedited());
    const all = await getAnnouncementTemplates(broken);
    expect(all.application_accepted).toEqual(unedited());
    expect(all.event_published.mention).toEqual(NO_MENTION);
  });

  it("drops a role id written straight into the row that is not a snowflake", async () => {
    /*
     * Past the save, which is where a hand-run UPDATE or an older screen lands.
     * The read goes through `announcementTemplateFrom`, so the junk is gone
     * before anything can try to mention it — and `mentionLine` would drop it
     * again on the way out, which is the second of the two checks.
     */
    await db.insert(announcementTemplates).values({
      kind: "application_declined",
      mentionRoleIds: ["@everyone", "9", PICKED],
      mentionEveryone: false,
    });
    const stored = await getAnnouncementTemplate("application_declined", db);
    expect(stored.mention.roleIds).toEqual([PICKED]);
  });

  it("ignores a stored row naming a kind that no longer exists", async () => {
    // Which is what lets a new kind ship without a migration, and an old one
    // disappear without one either.
    await db.insert(announcementTemplates).values({ kind: "retired_kind", body: "Hello." });
    const all = await getAnnouncementTemplates(db);
    expect(all).not.toHaveProperty("retired_kind");
    expect(Object.keys(all).sort()).toEqual(Object.keys(defaultAnnouncementSettings()).sort());
  });
});

describe("a post still in flight when the webhook is replaced", () => {
  it("is stamped from before the save, so the admin home does not list it", async () => {
    await switches({ application_waitlisted: true });
    const { eventId, applicationId } = await decided("waitlisted");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2033-01-01T00:00:00Z"));
    fetchStub.mockImplementation(async () => {
      // The admin saves a new webhook while Discord is still thinking about
      // the old one, and the refusal only lands after that.
      vi.setSystemTime(new Date("2033-01-01T00:01:00Z"));
      await recordAudit({
        action: "settings.integrations",
        summary: "Integrations changed — webhook set.",
        detail: { webhookChanged: true },
      });
      vi.setSystemTime(new Date("2033-01-01T00:02:00Z"));
      return new Response(null, { status: 500 });
    });

    await announced(applicationId);

    const view = await loadDashboard({}, db);
    expect(view.items.filter((item) => item.kind === "announcements" && item.event?.id === eventId)).toEqual([]);
  });
});

/* ================================================================== */
/* Task 68 — the three the clock posts (R-205, R-206, R-207 / UC-38)  */
/* ================================================================== */

/**
 * One event at a chosen distance from a chosen instant.
 *
 * Inserted directly rather than built through `createEvent`, for the reason
 * `announce-schedule.test.ts` does the same: every test below is about a window
 * measured against `NOW`, and `PUBLISHABLE`'s window — open since 2000,
 * shutting in 2100 — is deliberately nowhere near any of them.
 */
async function scheduled(setup: {
  signupOpensAt?: Date | null;
  signupClosesAt?: Date | null;
  capacity?: number | null;
  status?: "draft" | "published" | "live" | "cancelled";
  dayStarts?: readonly Date[];
  accepted?: number;
}): Promise<{ id: string; title: string }> {
  counter += 1;
  const title = `Clock ${counter}`;
  const [event] = await db
    .insert(events)
    .values({
      slug: `cron-${counter}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      status: setup.status ?? "published",
      capacity: setup.capacity ?? null,
      signupOpensAt: setup.signupOpensAt ?? null,
      signupClosesAt: setup.signupClosesAt ?? null,
    })
    .returning({ id: events.id });

  for (const [dayIndex, startsAt] of (setup.dayStarts ?? []).entries()) {
    await db.insert(eventDays).values({ eventId: event.id, dayIndex, startsAt });
  }
  for (let seat = 0; seat < (setup.accepted ?? 0); seat += 1) {
    const userId = await makeUser(db);
    await db.insert(applications).values({ eventId: event.id, userId, status: "accepted" });
  }
  return { id: event.id, title };
}

/**
 * The one payload that went out **for this event**, by the title in its embed.
 *
 * Not `posted()[0]`, and the difference is not pedantry: this file shares one
 * database, so a run can legitimately post for an event some earlier test left
 * behind, and `posted()[0]` is then a different event's message. That is not
 * hypothetical — it is what the first draft of these tests did, and the full
 * suite caught it while the same test passed in isolation.
 */
function sentFor(title: string): DiscordMessage {
  const matches = posted().filter((message) => message.embeds[0].title === title);
  expect(matches, `exactly one post for ${title}`).toHaveLength(1);
  return matches[0];
}

/** One run of the scheduler's posting step, at `now`. */
async function wake(now: Date): Promise<PostedAnnouncement[]> {
  const { posted: went } = await postDueAnnouncements(now, db);
  return went;
}

/**
 * This event's share of a run, as the kinds that went out for it.
 *
 * **Never a count of the whole run.** The file shares one database, so a count
 * would be a statement about every event any other test left lying around — and
 * "one post went out" is also what a channel sees when the *wrong* one of two
 * announcements fires.
 */
function forEvent(went: PostedAnnouncement[], eventId: string): AnnouncementKind[] {
  return went.filter((one) => one.eventId === eventId).map((one) => one.kind);
}

/** This event's claim rows, which are the whole of why it posts once. */
async function claimsFor(eventId: string) {
  return db
    .select({ kind: announcementClaims.kind, eventId: announcementClaims.eventId })
    .from(announcementClaims)
    .where(eq(announcementClaims.eventId, eventId));
}

const NOW = new Date("2026-11-02T12:00:00.000Z");
const MIN = 60 * 1000;
const HR = 60 * MIN;

describe("the scheduled announcements, posted", () => {
  /**
   * **UC-38 5a, and the trap this test is written around.**
   *
   * "Posts once per event, proven by running the scheduler twice in one window"
   * is a criterion a test can satisfy without testing anything: run it twice,
   * count one post, pass — and it passes identically when the *first* run
   * posted nothing and the second did. Task 63 hit exactly that.
   *
   * So the two runs are asserted **separately**, and by kind rather than by
   * count: the first run posted this kind for this event, and the second posted
   * nothing at all for it. Both halves must hold, and neither is satisfiable by
   * silence. The second run is a quarter of an hour later, which is what the
   * schedule actually does.
   */
  it.each([
    ["signups_closing_soon", { signupClosesAt: new Date(NOW.getTime() + 20 * HR), capacity: 12 }],
    ["event_starting_soon", { dayStarts: [new Date(NOW.getTime() + 90 * MIN)] }],
    ["signups_open", { signupOpensAt: new Date(NOW.getTime() + 10 * MIN) }],
  ] as const)("posts %s once per event, and the next run posts nothing", async (kind, setup) => {
    await switches({ [kind]: true } as Partial<AnnouncementSettings>);
    const { id, title } = await scheduled(setup);

    const first = await wake(NOW);
    // Posted, and *this* kind — not "something happened".
    expect(forEvent(first, id)).toEqual([kind]);
    // And one payload actually reached Discord for this event.
    expect(sentFor(title).embeds[0].title).toBe(title);
    const callsAfterFirst = fetchStub.mock.calls.length;

    const second = await wake(new Date(NOW.getTime() + 15 * MIN));
    // And nothing the second time, as its own statement.
    expect(forEvent(second, id)).toEqual([]);
    expect(fetchStub.mock.calls.length).toBe(callsAfterFirst);
    // Still exactly one post for this event, not two.
    expect(sentFor(title).embeds[0].title).toBe(title);

    // The claim is why, and it is one row rather than two.
    expect(await claimsFor(id)).toEqual([{ kind, eventId: id }]);
  });

  /**
   * UC-38 5a across a whole window of wakes, at every slip.
   *
   * `announce-schedule.test.ts` proves every wake inside the window *sees* the
   * event, which is why a claim is needed at all. This is the other half of
   * that sentence: of all those wakes, exactly one posts.
   *
   * **A slip of exactly 15 minutes reproduces the same grid of wake times**, so
   * "every run a quarter of an hour late" fires at identical instants to "on
   * time" and on its own proves nothing — hence 0/5/10/15 (Task 63's note).
   */
  it.each([0, 5 * MIN, 10 * MIN, 15 * MIN])(
    "posts exactly once across a window of wakes slipped by %ims",
    async (slip) => {
      await switches({ event_starting_soon: true });
      const startsAt = new Date("2026-11-06T20:00:00.000Z");
      const { id, title } = await scheduled({ dayStarts: [startsAt] });

      const fired: Array<{ at: Date; kinds: AnnouncementKind[] }> = [];
      for (let at = startsAt.getTime() - 4 * HR; at <= startsAt.getTime() + HR; at += 15 * MIN) {
        const mine = forEvent(await wake(new Date(at + slip)), id);
        if (mine.length > 0) fired.push({ at: new Date(at + slip), kinds: mine });
      }

      // Exactly one wake posted, and it posted the right kind — not "at most
      // one", which silence also satisfies.
      expect(fired.map((one) => one.kinds)).toEqual([["event_starting_soon"]]);
      // And it fired inside the two hours before the start, not merely once.
      const lead = startsAt.getTime() - fired[0].at.getTime();
      expect(lead).toBeGreaterThan(0);
      expect(lead).toBeLessThanOrEqual(EVENT_STARTING_LEAD_MS);
      // One payload for this event across all those wakes, named rather than
      // counted over the whole run.
      expect(sentFor(title).embeds[0].footer).toEqual({ text: "Starting soon" });
    }
  );

  it("posts the signups-open announcement when the window opens (UC-38 2)", async () => {
    await switches({ signups_open: true, event_published: true });
    const { id, title } = await scheduled({
      signupOpensAt: new Date(NOW.getTime() + 10 * MIN),
      signupClosesAt: new Date(NOW.getTime() + 10 * HR),
      capacity: 12,
      dayStarts: [new Date(NOW.getTime() + 20 * HR)],
    });

    expect(forEvent(await wake(NOW), id)).toEqual(["signups_open"]);
    // The payload, not just the fact of a post: the footer is what tells it
    // apart from the published announcement it must not duplicate.
    const message = sentFor(title);
    expect(message.embeds[0].footer).toEqual({ text: "Applications open" });
    expect(message.embeds[0].description).toBe(
      "Applications have opened — three taps if your profile is filled in."
    );
  });

  /**
   * UC-38 2a from the scheduler's side — the half that could not be tested
   * before this task existed.
   *
   * The event is already taking applications, so publishing it *was* the moment
   * its signups opened. `announceEventPublished` posts one announcement (the
   * test much further up), and the scheduler must never add a second: not on
   * the next wake, and not on any wake after it. Swept forward a month, because
   * what makes this true is the window being forward-only, and a single `now`
   * is exactly the assertion that would survive somebody widening it backwards.
   */
  it("never posts signups-open for an event already open when published (UC-38 2a)", async () => {
    await switches({ signups_open: true });
    const { id } = await scheduled({
      signupOpensAt: new Date(NOW.getTime() - MIN),
      signupClosesAt: new Date(NOW.getTime() + 40 * 24 * HR),
    });

    for (const after of [MIN, 30 * MIN, HR, 24 * HR, 30 * 24 * HR]) {
      expect(forEvent(await wake(new Date(NOW.getTime() + after)), id), `${after}ms later`).toEqual(
        []
      );
    }
    expect(await claimsFor(id)).toEqual([]);
    // Not because the kind is off or unregistered: it is on, and the very same
    // run posts it for an event whose window is still ahead.
    expect((await getAnnouncementSettings(db)).signups_open).toBe(true);
    const ahead = await scheduled({ signupOpensAt: new Date(NOW.getTime() + 10 * MIN) });
    expect(forEvent(await wake(NOW), ahead.id)).toEqual(["signups_open"]);
  });

  /**
   * UC-38 4c, as the two claims it actually makes: a full event **still** gets
   * this announcement, and the message **says** it is full.
   *
   * Asserted on the description of *this event's* payload. Fullness is the only
   * thing that differs between this test and the one below, so between them
   * neither sentence can be the one the builder produces regardless.
   */
  it("posts the closing reminder for a full event, and says it is full (UC-38 4c)", async () => {
    await switches({ signups_closing_soon: true });
    const { id, title } = await scheduled({
      signupClosesAt: new Date(NOW.getTime() + 20 * HR),
      capacity: 2,
      accepted: 2,
    });

    expect(forEvent(await wake(NOW), id)).toEqual(["signups_closing_soon"]);
    expect(sentFor(title).embeds[0].description).toContain("full");
    expect(sentFor(title).embeds[0].description).toContain(CLOSING_SOON_FULLNESS.full);
    // And the seat cap reached the embed. Dropping it is silent — the message
    // would read "No limit" on every event, which is perfectly fluent and
    // wrong, so the number is asserted rather than the message's shape.
    expect(sentFor(title).embeds[0].fields).toContainEqual({
      name: "Places",
      value: "2",
      inline: true,
    });
  });

  it("says there are still places when the event is not full", async () => {
    // The other half, so the assertion above cannot be passing on a message
    // that says "full" whatever the seats are doing.
    await switches({ signups_closing_soon: true });
    const { id, title } = await scheduled({
      signupClosesAt: new Date(NOW.getTime() + 20 * HR),
      capacity: 10,
      accepted: 1,
    });

    expect(forEvent(await wake(NOW), id)).toEqual(["signups_closing_soon"]);
    expect(sentFor(title).embeds[0].description).toContain(CLOSING_SOON_FULLNESS.open);
    expect(sentFor(title).embeds[0].description).not.toContain("full");
    // A different cap from the test above, so between the two neither number
    // can be one the builder produces regardless of the event.
    expect(sentFor(title).embeds[0].fields).toContainEqual({
      name: "Places",
      value: "10",
      inline: true,
    });
  });

  it("posts nothing for an event with no closing time, and none for one with no dated day", async () => {
    await switches({ signups_closing_soon: true, event_starting_soon: true });
    const noClose = await scheduled({ dayStarts: [] });
    const noDay = await scheduled({ signupClosesAt: null });

    const went = await wake(NOW);
    expect(forEvent(went, noClose.id)).toEqual([]);
    expect(forEvent(went, noDay.id)).toEqual([]);
    expect(await claimsFor(noClose.id)).toEqual([]);
    expect(await claimsFor(noDay.id)).toEqual([]);
  });

  it("posts no starting-soon reminder for a cancelled event (UC-38 4b)", async () => {
    await switches({ event_starting_soon: true });
    const startsAt = new Date(NOW.getTime() + 90 * MIN);
    const cancelled = await scheduled({ status: "cancelled", dayStarts: [startsAt] });
    const live = await scheduled({ status: "live", dayStarts: [startsAt] });

    const went = await wake(NOW);
    expect(forEvent(went, cancelled.id)).toEqual([]);
    // And the identical event that was not cancelled did get one, so the
    // silence above is the cancellation rather than the clock.
    expect(forEvent(went, live.id)).toEqual(["event_starting_soon"]);
  });

  /** UC-38 5b — the window was slept through. */
  it("does not post a missed moment late", async () => {
    await switches({ signups_closing_soon: true, event_starting_soon: true });
    const closed = await scheduled({ signupClosesAt: new Date(NOW.getTime() - MIN) });
    const begun = await scheduled({ dayStarts: [new Date(NOW.getTime() - MIN)] });

    const went = await wake(NOW);
    expect(forEvent(went, closed.id)).toEqual([]);
    expect(forEvent(went, begun.id)).toEqual([]);
    // ...and both would have fired, had anything been awake a minute earlier,
    // so the silence above is the lower bound of the window and not the fixture.
    const earlier = await wake(new Date(NOW.getTime() - 2 * MIN));
    expect(forEvent(earlier, closed.id)).toEqual(["signups_closing_soon"]);
    expect(forEvent(earlier, begun.id)).toEqual(["event_starting_soon"]);
  });

  /**
   * The repo invariant, asserted structurally rather than by eye: every instant
   * in every one of these payloads is Discord's own markup.
   *
   * Not `toContain("<t:")`, which a payload carrying one stamp *and* one
   * formatted date would satisfy. The assertion is that **no** substring
   * anywhere in the serialised body looks like a date the server formatted,
   * over all three kinds in one run — plus the positive half, so the four
   * refusals cannot be passing on a message with no time in it at all.
   */
  it("formats no instant on the server, over all three kinds at once", async () => {
    await switches({
      signups_open: true,
      signups_closing_soon: true,
      event_starting_soon: true,
    });
    const opening = await scheduled({
      signupOpensAt: new Date(NOW.getTime() + 10 * MIN),
      // A window *and* a dated day, so this payload has instants in it to get
      // wrong. Without them the embed carries no time at all, and the positive
      // assertion below would be the only thing standing between this test and
      // passing on three messages that mention no instant whatsoever.
      signupClosesAt: new Date(NOW.getTime() + 30 * HR),
      dayStarts: [new Date(NOW.getTime() + 40 * HR)],
      capacity: 8,
    });
    const closing = await scheduled({
      signupClosesAt: new Date(NOW.getTime() + 20 * HR),
      capacity: 4,
    });
    const starting = await scheduled({ dayStarts: [new Date(NOW.getTime() + 90 * MIN)] });

    const went = await wake(NOW);
    expect(forEvent(went, opening.id)).toEqual(["signups_open"]);
    expect(forEvent(went, closing.id)).toEqual(["signups_closing_soon"]);
    expect(forEvent(went, starting.id)).toEqual(["event_starting_soon"]);

    for (const { title } of [opening, closing, starting]) {
      const body = JSON.stringify(sentFor(title));
      // The four shapes a formatted date arrives in on this site.
      expect(body, title).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(body, title).not.toMatch(/\b20\d{2}\b/);
      expect(body, title).not.toMatch(
        /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/
      );
      expect(body, title).not.toMatch(/\b\d{1,2}:\d{2}\b/);
      // And it does carry Discord markup, so the four refusals above are not
      // passing on a message with no instant in it to begin with.
      expect(body, title).toMatch(/<t:\d+:[FR]>/);
    }
  });

  it("claims nothing while the kind is switched off", async () => {
    /*
     * The failure this guards is an **unreleasable claim**. If a run claimed an
     * event whose kind is off, the admin who switched it on inside the same
     * window would get silence for ever, because a claim is never released. So:
     * off posts nothing *and* claims nothing, and turning it on then posts.
     */
    await switches({});
    const { id } = await scheduled({ signupClosesAt: new Date(NOW.getTime() + 20 * HR) });

    expect(forEvent(await wake(NOW), id)).toEqual([]);
    expect(await claimsFor(id)).toEqual([]);

    await switches({ signups_closing_soon: true });
    expect(forEvent(await wake(NOW), id)).toEqual(["signups_closing_soon"]);
  });

  it("claims nothing while there is no webhook", async () => {
    // The same argument one layer out: an install nobody has configured yet
    // must not burn its claims before anybody could have received them.
    await switches({ signups_closing_soon: true });
    await setIntegrationSetting(SETTING_KEYS.webhookUrl, null);
    const { id } = await scheduled({ signupClosesAt: new Date(NOW.getTime() + 20 * HR) });

    expect(forEvent(await wake(NOW), id)).toEqual([]);
    expect(await claimsFor(id)).toEqual([]);

    await setIntegrationSetting(
      SETTING_KEYS.webhookUrl,
      "https://discord.test/api/webhooks/1/token"
    );
    expect(forEvent(await wake(NOW), id)).toEqual(["signups_closing_soon"]);
  });

  it("records a failure against the event when Discord refuses (R-208 / UC-38 5c)", async () => {
    await switches({ event_starting_soon: true });
    const { id } = await scheduled({ dayStarts: [new Date(NOW.getTime() + 90 * MIN)] });
    fetchStub.mockResolvedValue(new Response(null, { status: 500 }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await wake(NOW);

    const rows = await listAudit({ eventId: id }, db);
    const failure = rows.find((row) => row.action === "announcement.failed");
    // The kind and the status in the row, not just "something failed": the
    // admin home shows this line, and "an announcement failed" is not a
    // sentence anybody can act on.
    expect(failure?.detail).toMatchObject({ kind: "event_starting_soon", status: 500 });

    // And the claim stays taken — a post that failed after its claim is not
    // retried, which is the bargain `postDueAnnouncements` states and the one
    // `claimForDiscord` already made.
    fetchStub.mockResolvedValue(new Response(null, { status: 204 }));
    expect(forEvent(await wake(new Date(NOW.getTime() + 15 * MIN)), id)).toEqual([]);
    errors.mockRestore();
  });
});
