import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, SETTING_KEYS, announcementTemplates } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import type { AnnouncementSettings, DiscordMessage } from "@/lib/announce";

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
  setAnnouncementSettings,
  setAnnouncementTemplate,
  setIntegrationSetting,
  unedited,
} = await import("@/lib/discord");
const {
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
