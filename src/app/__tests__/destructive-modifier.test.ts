import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  type Database,
  auditLog,
  championships,
  draftLots,
  eventSuggestions,
  eventTemplates,
  events,
  games,
  matchGames,
  matches,
  polls,
  profileFields,
  teams,
  users,
} from "@/db";
import {
  PUBLISHABLE,
  type TestDatabase,
  freshDatabase,
  makeHost,
  makeUser,
} from "@/db/__tests__/helpers";
import type { Power } from "@/lib/permissions-policy";

/*
 * The `destructive` modifier, through the actions (Task 129, R-267 / UC-57).
 *
 * The actions run for real against an in-memory Postgres, mocked as
 * `polls-suggestions-settings-powers.test.ts` mocks them: the session cookie,
 * the database handle, the page cache and `after()`. `session-guards`,
 * `permissions` and `audit` are the real ones.
 *
 * Two tables hold the file up. `ACCOUNT` names **every** action `audit.ts`
 * marks destructive and says, of each, whether an action file refuses it - so
 * an entry added to the set fails here until somebody has said which. `CASES`
 * has a real call for every entry `ACCOUNT` says is refused, and each is run as
 * the people UC-57 names.
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
  // `/admin/settings/actions.ts` is imported by the events actions; nothing here calls these.
  getGateConfig: async () => {
    throw new Error("not used here");
  },
  setGateConfig: async () => {
    throw new Error("not used here");
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));

const pollActions = await import("../polls/actions");
const suggestionActions = await import("../suggestions/actions");
const templateActions = await import("../admin/templates/actions");
const gameActions = await import("../admin/games/actions");
const eventActions = await import("../admin/events/actions");
const formatActions = await import("../admin/events/format-actions");
const draftActions = await import("../events/[slug]/draft/actions");
const { AUDIT_ACTIONS, actionTone, isDestructive } = await import("@/lib/audit");
const { DESTRUCTIVE_REFUSAL, grantPower } = await import("@/lib/permissions");
const { createPoll } = await import("@/lib/polls");
const { addSuggestion } = await import("@/lib/suggestions");
const { createTemplate } = await import("@/lib/admin-templates");
const { createField, createGame } = await import("@/lib/admin-games");
const { championshipOfEvent } = await import("@/lib/championships");
const { awardLot, openLot, placeBid, setCaptains, setDraftPool, setTeams } = await import(
  "@/lib/draft"
);
const { applyToEvent, createEvent, publishEvent } = await import("@/lib/events");
const { formatFor, generateMatches, matchIdsFor, setStages } = await import("@/lib/format");

let handle: TestDatabase;
let db: Database;
let admin: string;
/** Somebody with no power, who owns what the calls below aim at. */
let member: string;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
  admin = await makeUser(db, { displayName: "An admin holding nothing" });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
  member = await makeUser(db, { displayName: "A member with no powers" });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  state.userId = null;
  counter += 1;
});

/** A new member holding exactly these, signed in. */
async function signInHolding(...powers: Power[]): Promise<string> {
  const id = await makeUser(db, { displayName: `Holder of ${powers.join(" + ") || "nothing"}` });
  for (const power of powers) await grantPower({ userId: id, power, grantedByUserId: admin }, db);
  state.userId = id;
  return id;
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

type Result = { ok: boolean };
/** One destructive thing, set up and ready: the call, whether it happened, and something ordinary beside it. */
type Staged = {
  destroy: () => Promise<Result>;
  /** Has what `destroy` takes away gone? Read from the table, not from the answer. */
  gone: () => Promise<boolean>;
  /** Something in the same area that is not in the set. */
  ordinary: () => Promise<Result>;
};

async function isEmpty(rows: Promise<unknown[]>): Promise<boolean> {
  return (await rows).length === 0;
}

async function aGame() {
  counter += 1;
  return unwrap(await createGame({ name: `Destructive game ${counter}` }, db));
}

/** A published event counting towards a season, so there is something to stop counting. */
async function aCountingEvent(): Promise<string> {
  counter += 1;
  const [event] = await db
    .insert(events)
    .values({ slug: `destructive-${counter}`, title: `Night ${counter}`, status: "published" })
    .returning({ id: events.id });
  const [season] = await db
    .insert(championships)
    .values({ slug: `destructive-${counter}`, name: `Season ${counter}`, status: "published" })
    .returning({ id: championships.id });
  state.userId = admin;
  unwrap(await eventActions.addEventToChampionshipAction(event.id, season.id));
  state.userId = null;
  return event.id;
}

function stopCounting(eventId: string): Staged {
  return {
    destroy: () => eventActions.removeEventFromChampionshipAction(eventId),
    gone: async () => (await championshipOfEvent(eventId, db)) === null,
    ordinary: () => eventActions.saveEventChampionshipAction(eventId, { weight: 2 }),
  };
}

/**
 * A published event nobody hosts, with two captained teams and a lot open on
 * one of six players - `host-draft.test.ts`'s fixture, with the lot.
 */
async function anOpenLot(): Promise<{ eventId: string; lotId: string; alpha: string }> {
  counter += 1;
  const created = unwrap(await createEvent({ ...PUBLISHABLE, title: `Draft ${counter}` }, db));
  unwrap(await publishEvent(created.id, db));
  const members: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const userId = await makeUser(db);
    unwrap(await applyToEvent(created.id, userId, {}, db));
    members.push(userId);
  }
  const written = unwrap(await setTeams(created.id, [{ name: "Alpha" }, { name: "Bravo" }], db));
  const [alpha, bravo] = written.teams;
  unwrap(
    await setCaptains(
      created.id,
      [
        { teamId: alpha.id, userId: members[0] },
        { teamId: bravo.id, userId: members[1] },
      ],
      db
    )
  );
  unwrap(await setDraftPool(created.id, {}, db));
  const lot = unwrap(await openLot(created.id, { userId: members[2], kind: "main" }, db));
  return { eventId: created.id, lotId: lot.id, alpha: alpha.id };
}

async function lotStatus(lotId: string): Promise<string> {
  const [lot] = await db
    .select({ status: draftLots.status })
    .from(draftLots)
    .where(eq(draftLots.id, lotId));
  return lot.status;
}

/** An event nobody hosts with a generated bracket - `host-scope.test.ts`'s fixture. */
async function aBoard(): Promise<{ eventId: string; ids: Record<string, string> }> {
  counter += 1;
  const [event] = await db
    .insert(events)
    .values({ slug: `destructive-board-${counter}`, title: `Board ${counter}` })
    .returning({ id: events.id });
  for (let seed = 1; seed <= 8; seed += 1) {
    await db
      .insert(teams)
      .values({ eventId: event.id, name: `Team ${counter}-${seed}`, seed, sort: seed });
  }
  const [stage] = unwrap(await setStages(event.id, [{ kind: "double_elim", name: "Playoffs" }], db));
  unwrap(await generateMatches(stage.id, db));
  return { eventId: event.id, ids: await matchIdsFor(event.id, db) };
}

const ONE_GAME = { games: [{ index: 0, scoreA: 1, scoreB: 0, played: true }] };

/**
 * A team that is really in the first quarter-final. Read from the resolved
 * board and not from the stored row: the row's own team columns are empty
 * until a result fills them, and an override of `null` is "drop the override",
 * which succeeds and changes nothing.
 */
async function aTeamIn(eventId: string, slot: string): Promise<string> {
  const board = await formatFor(eventId, db);
  const match = board?.stages.flatMap((stage) => stage.matches).find((row) => row.slot === slot);
  if (!match?.teamAId) throw new Error(`No team resolved into ${slot}.`);
  return match.teamAId;
}

/* ------------------------------------------------------------------ */
/* Every entry in the set, by name                                    */
/* ------------------------------------------------------------------ */

/*
 * Owed, and deliberately not paid yet: neither key is one action. `format.stages`
 * is every bracket save, the first included; `format.generated` is written from
 * four places, among them a first generation that loses nothing and
 * `auditStageSync`, which can record that nothing was touched. Asking for
 * `destructive` on either would stop an `events.manage` holder building a
 * bracket at all. The keys have to be split before either can be an authority -
 * do not wire them by eye.
 */
/*
 * Owed for the same reason, two files away. `result.override` is overturning
 * a recorded result **and** settling a drawn series, which loses nothing and is
 * the only way a drawn knockout slot resolves. Refusing the key would leave an
 * `events.manage` holder unable to finish the night. `draft.discarded` is the
 * contrast: that one is refused, because the lot can still go to reserve.
 */
const OWED_OVERRIDE =
  "OWED. One key over overturning a result and settling a draw; it needs splitting first. An events.manage holder is not refused.";

/*
 * Owed for the same reason again. `game.ladder` is replacing a ladder members
 * have answered against **and** giving a new game its first one, which clears
 * nothing - and there is no other way to give a game a ladder. Task 137 was
 * right to mark it: the clear is real and the line records it. The modifier
 * cannot gate it until the key is split, because the same action also does
 * the harmless thing.
 */
const OWED_LADDER =
  "OWED. One key over clearing stored answers and setting a first ladder; it needs splitting first. A games.manage holder is not refused.";

const OWED_FORMAT =
  "OWED. One key over ordinary and destructive writes alike; it needs splitting first. An events.manage holder is not refused.";

/**
 * What becomes of each action `audit.ts` marks destructive.
 *
 * `refused` is the modifier at work: `CASES` below proves each one. Anything
 * else is a reason, and a reason is one of three kinds - nobody a power could
 * reach is acting, an admin is the only actor there is, or the refusal is
 * **owed** and the reason says what it is waiting for. "In the set" and
 * "refused" are two facts, and this table is what keeps them honest.
 */
const ACCOUNT: Record<string, "refused" | { notRefused: string }> = {
  "poll.deleted": "refused",
  "template.deleted": "refused",
  "field.deleted": "refused",
  "game.ladder": { notRefused: OWED_LADDER },
  "suggestion.deleted": "refused",
  "championship.event.removed": "refused",
  "announcement.failed": {
    notRefused: "The site writes it about itself in discord.ts. Nobody is acting, so nobody is refused.",
  },
  "user.admin.revoked": {
    notRefused: "requireAdmin is its only guard (R-264), and an admin is above the modifier.",
  },
  "user.sessions.ended": {
    notRefused: "requireAdmin is its only guard, and an admin is above the modifier.",
  },
  "draft.voided": "refused",
  "draft.discarded": "refused",
  "result.cleared": "refused",
  "result.override": { notRefused: OWED_OVERRIDE },
  "format.generated": { notRefused: OWED_FORMAT },
  "format.stages": { notRefused: OWED_FORMAT },
};

/** The power over each refused action's area, and how to stage one. */
const CASES: Record<string, { area: Power; stage: () => Promise<Staged> }> = {
  "poll.deleted": {
    area: "polls.manage",
    stage: async () => {
      const { id } = unwrap(
        await createPoll(
          member,
          {
            question: `Which evening, ${counter}?`,
            multiple: false,
            closesAt: new Date("2100-01-01T00:00:00.000Z"),
            options: [{ label: "Friday" }, { label: "Saturday" }],
          },
          db
        )
      );
      return {
        destroy: () => pollActions.deletePollAction(id),
        gone: () => isEmpty(db.select().from(polls).where(eq(polls.id, id))),
        ordinary: () => pollActions.closePollAction(id),
      };
    },
  },
  "template.deleted": {
    area: "templates.manage",
    stage: async () => {
      const { id } = unwrap(await createTemplate({ name: `Destructive template ${counter}` }, db));
      return {
        destroy: () => templateActions.deleteTemplateAction(id),
        gone: () => isEmpty(db.select().from(eventTemplates).where(eq(eventTemplates.id, id))),
        // Deactivating is the ordinary one: it switches back on and nothing is lost.
        ordinary: () => templateActions.setTemplateActiveAction(id, false),
      };
    },
  },
  "field.deleted": {
    area: "games.manage",
    stage: async () => {
      const game = await aGame();
      const { id } = unwrap(await createField(game.id, { label: "Asked", type: "text" }, db));
      return {
        destroy: () => gameActions.deleteFieldAction(id),
        gone: () => isEmpty(db.select().from(profileFields).where(eq(profileFields.id, id))),
        ordinary: () => gameActions.retireFieldAction(id),
      };
    },
  },
  "suggestion.deleted": {
    area: "suggestions.moderate",
    stage: async () => {
      const { id } = unwrap(
        await addSuggestion(member, { title: `Idea ${counter}`, detail: "Somebody ought to." }, db)
      );
      return {
        destroy: () => suggestionActions.deleteSuggestionAction(id),
        gone: () => isEmpty(db.select().from(eventSuggestions).where(eq(eventSuggestions.id, id))),
        ordinary: () => suggestionActions.setSuggestionStatusAction(id, "planned"),
      };
    },
  },
  "championship.event.removed": {
    area: "events.manage",
    stage: async () => stopCounting(await aCountingEvent()),
  },
  // Cancelling the open lot. Undoing a settled one writes the same key, and has its own tests below.
  "draft.voided": {
    area: "events.manage",
    stage: async () => {
      const { eventId, lotId } = await anOpenLot();
      return {
        destroy: () => draftActions.runDraftAction(eventId, { type: "cancel" }),
        gone: async () => (await lotStatus(lotId)) === "voided",
        ordinary: () => draftActions.runDraftAction(eventId, { type: "reserve" }),
      };
    },
  },
  "draft.discarded": {
    area: "events.manage",
    stage: async () => {
      const { eventId, lotId } = await anOpenLot();
      return {
        destroy: () => draftActions.runDraftAction(eventId, { type: "discard" }),
        gone: async () => (await lotStatus(lotId)) === "discarded",
        ordinary: () => draftActions.runDraftAction(eventId, { type: "clearBids" }),
      };
    },
  },
  "result.cleared": {
    area: "events.manage",
    stage: async () => {
      const { ids } = await aBoard();
      state.userId = admin;
      unwrap(await formatActions.recordGamesAction(ids.ubqf1, ONE_GAME));
      state.userId = null;
      return {
        destroy: () => formatActions.clearMatchAction(ids.ubqf1, 1),
        gone: async () => {
          const played = await db
            .select({ played: matchGames.played })
            .from(matchGames)
            .where(eq(matchGames.matchId, ids.ubqf1));
          return played.every((game) => !game.played);
        },
        ordinary: () => formatActions.recordGamesAction(ids.ubqf2, ONE_GAME),
      };
    },
  },
};

const REFUSED = Object.keys(CASES);

async function linesBy(actor: string, action: string) {
  return db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.actorUserId, actor), eq(auditLog.action, action)));
}

async function lineCount(): Promise<number> {
  return (await db.select({ id: auditLog.id }).from(auditLog)).length;
}

describe("every action audit.ts marks destructive", () => {
  it("is accounted for here by name, and nothing else is", () => {
    const marked = Object.keys(AUDIT_ACTIONS).filter(isDestructive);

    expect(Object.keys(ACCOUNT).sort()).toEqual(marked.sort());
  });

  it("has a real call below when it is said to be refused", () => {
    const refused = Object.keys(ACCOUNT).filter((action) => ACCOUNT[action] === "refused");

    expect([...REFUSED].sort()).toEqual(refused.sort());
  });
});

describe("a holder of the area's power, without destructive", () => {
  it.each(REFUSED)("is refused %s, told what is missing, and nothing is written", async (action) => {
    const staged = await CASES[action].stage();
    await signInHolding(CASES[action].area);
    const before = await lineCount();

    const result = await staged.destroy();

    // Both fields, matched rather than equalled: the draft console's answer carries the room as well.
    expect(result).toMatchObject({ ok: false, error: DESTRUCTIVE_REFUSAL });
    expect(await staged.gone()).toBe(false);
    expect(await lineCount()).toBe(before);
  });

  it.each(REFUSED)("still does the ordinary thing beside %s", async (action) => {
    const staged = await CASES[action].stage();
    await signInHolding(CASES[action].area);

    const result = await staged.ordinary();

    expect(result).toMatchObject({ ok: true });
  });
});

describe("the same holder, with destructive", () => {
  it.each(REFUSED)("does %s, and the line is still one the log marks destructive", async (action) => {
    const staged = await CASES[action].stage();
    const holder = await signInHolding(CASES[action].area, "destructive");

    const result = await staged.destroy();

    expect(result).toMatchObject({ ok: true });
    expect(await staged.gone()).toBe(true);
    expect(await linesBy(holder, action)).toEqual([{ action }]);
    expect(actionTone(action)).toBe("flare");
  });
});

describe("an admin, holding nothing", () => {
  it.each(REFUSED)("does %s", async (action) => {
    const staged = await CASES[action].stage();
    state.userId = admin;

    const result = await staged.destroy();

    expect(result).toMatchObject({ ok: true });
    expect(await staged.gone()).toBe(true);
  });
});

describe("a member holding destructive and nothing else", () => {
  it.each(REFUSED.filter((action) => action !== "suggestion.deleted"))(
    "is turned away from %s by the area's own guard, as before",
    async (action) => {
      const staged = await CASES[action].stage();
      await signInHolding("destructive");

      await expect(staged.destroy()).rejects.toThrow(/NEXT_REDIRECT/);

      expect(await staged.gone()).toBe(false);
    }
  );

  it("cannot remove somebody else's suggestion, and is told what any member is told", async () => {
    const staged = await CASES["suggestion.deleted"].stage();
    await signInHolding("destructive");

    const result = await staged.destroy();

    expect(result).toEqual({ ok: false, error: "That is not yours to remove." });
    expect(await staged.gone()).toBe(false);
  });
});

describe("a member with no power, on somebody else's suggestion", () => {
  it("is not told about a power they were never short of", async () => {
    const staged = await CASES["suggestion.deleted"].stage();
    await signInHolding();

    const result = await staged.destroy();

    expect(result).toEqual({ ok: false, error: "That is not yours to remove." });
  });
});

describe("a moderator without destructive, on their own suggestion", () => {
  it("takes it back, because no power allowed that", async () => {
    const moderator = await signInHolding("suggestions.moderate");
    const { id } = unwrap(
      await addSuggestion(moderator, { title: `My own ${counter}`, detail: "Mine to remove." }, db)
    );

    const result = await suggestionActions.deleteSuggestionAction(id);

    expect(result).toEqual({ ok: true, data: undefined });
    expect(await linesBy(moderator, "suggestion.withdrawn")).toHaveLength(1);
  });
});

describe("undoing a settled lot, the other writer of draft.voided", () => {
  async function aSettledLot() {
    const { eventId, lotId, alpha } = await anOpenLot();
    unwrap(await placeBid(lotId, alpha, 20, {}, db));
    unwrap(await awardLot(lotId, alpha, {}, db));
    return { eventId, lotId };
  }

  it("is refused to a holder of events.manage without destructive, and the lot stays awarded", async () => {
    const { eventId, lotId } = await aSettledLot();
    await signInHolding("events.manage");

    const result = await draftActions.runDraftAction(eventId, { type: "undo" });

    expect(result).toMatchObject({ ok: false, error: DESTRUCTIVE_REFUSAL });
    expect(await lotStatus(lotId)).toBe("awarded");
  });

  it("is done by the same holder with destructive", async () => {
    const { eventId, lotId } = await aSettledLot();
    const holder = await signInHolding("events.manage", "destructive");

    const result = await draftActions.runDraftAction(eventId, { type: "undo" });

    expect(result).toMatchObject({ ok: true });
    expect(await lotStatus(lotId)).toBe("voided");
    expect(await linesBy(holder, "draft.voided")).toHaveLength(1);
  });
});

describe("a host with no power at all, on their own event's draft and bracket", () => {
  it("cancels the open lot", async () => {
    const { eventId, lotId } = await anOpenLot();
    await makeHost(db, eventId, await signInHolding());

    const result = await draftActions.runDraftAction(eventId, { type: "cancel" });

    expect(result).toMatchObject({ ok: true });
    expect(await lotStatus(lotId)).toBe("voided");
  });

  it("discards a lot nobody bid on", async () => {
    const { eventId, lotId } = await anOpenLot();
    await makeHost(db, eventId, await signInHolding());

    const result = await draftActions.runDraftAction(eventId, { type: "discard" });

    expect(result).toMatchObject({ ok: true });
    expect(await lotStatus(lotId)).toBe("discarded");
  });

  it("undoes a settled lot", async () => {
    const { eventId, lotId, alpha } = await anOpenLot();
    unwrap(await placeBid(lotId, alpha, 20, {}, db));
    unwrap(await awardLot(lotId, alpha, {}, db));
    await makeHost(db, eventId, await signInHolding());

    const result = await draftActions.runDraftAction(eventId, { type: "undo" });

    expect(result).toMatchObject({ ok: true });
    expect(await lotStatus(lotId)).toBe("voided");
  });

  it("clears a match", async () => {
    const { eventId, ids } = await aBoard();
    await makeHost(db, eventId, await signInHolding());

    const result = await formatActions.clearMatchAction(ids.ubqf1, 1);

    expect(result).toMatchObject({ ok: true });
    expect(await linesBy(state.userId as string, "result.cleared")).toHaveLength(1);
  });

  it("calls a series for one side", async () => {
    const { eventId, ids } = await aBoard();
    const teamId = await aTeamIn(eventId, "ubqf1");
    await makeHost(db, eventId, await signInHolding());

    const result = await formatActions.setWinnerOverrideAction(ids.ubqf1, teamId);

    expect(result).toMatchObject({ ok: true });
    const [row] = await db.select().from(matches).where(eq(matches.id, ids.ubqf1));
    expect(row.winnerOverrideId).toBe(teamId);
  });
});

/*
 * The four entries that are owed, held open on purpose - these three, and
 * `game.ladder` in the describe above. `ACCOUNT` says so in
 * prose; these say so in behaviour, because a table cannot see a check added
 * to the action. Building a bracket and settling a drawn series are ordinary
 * things an `events.manage` holder does, and each of the three keys covers one
 * - so until they are split, the modifier must not be asked on any of them.
 * Split the keys, then change these and the table together.
 */
describe("a holder of games.manage without destructive, on the catalogue", () => {
  it("gives a new game its first ladder, though game.ladder is in the set", async () => {
    const game = await aGame();
    const holder = await signInHolding("games.manage");

    const result = await gameActions.setRankLadderAction(game.id, ["Bronze", "Gold"]);

    expect(result).toMatchObject({ ok: true });
    const [row] = await db
      .select({ ladder: games.rankLadder })
      .from(games)
      .where(eq(games.id, game.id));
    expect(row.ladder).toEqual(["Bronze", "Gold"]);
    expect(await linesBy(holder, "game.ladder")).toHaveLength(1);
  });
});

describe("a holder of events.manage without destructive, running the bracket", () => {
  it("calls a series for one side, though result.override is in the set", async () => {
    const { eventId, ids } = await aBoard();
    const teamId = await aTeamIn(eventId, "ubqf1");
    const holder = await signInHolding("events.manage");

    const result = await formatActions.setWinnerOverrideAction(ids.ubqf1, teamId);

    expect(result).toMatchObject({ ok: true });
    const [row] = await db.select().from(matches).where(eq(matches.id, ids.ubqf1));
    expect(row.winnerOverrideId).toBe(teamId);
    expect(await linesBy(holder, "result.override")).toHaveLength(1);
  });

  async function anEventWithTeams(): Promise<string> {
    counter += 1;
    const [event] = await db
      .insert(events)
      .values({ slug: `destructive-bracket-${counter}`, title: `Bracket ${counter}` })
      .returning({ id: events.id });
    for (let seed = 1; seed <= 4; seed += 1) {
      await db
        .insert(teams)
        .values({ eventId: event.id, name: `Side ${counter}-${seed}`, seed, sort: seed });
    }
    return event.id;
  }

  it("saves the stages, though format.stages is in the set", async () => {
    const eventId = await anEventWithTeams();
    const holder = await signInHolding("events.manage");

    const result = await formatActions.saveStagesAction(eventId, [
      { name: "Finals", kind: "single_elim", config: {} },
    ]);

    expect(result).toMatchObject({ ok: true });
    expect(await linesBy(holder, "format.stages")).toHaveLength(1);
  });

  it("generates the matches, though format.generated is in the set", async () => {
    const eventId = await anEventWithTeams();
    const [stage] = unwrap(await setStages(eventId, [{ kind: "single_elim", name: "Finals" }], db));
    const holder = await signInHolding("events.manage");

    const result = await formatActions.generateStageAction(stage.id);

    expect(result).toMatchObject({ ok: true });
    expect(await linesBy(holder, "format.generated")).toHaveLength(1);
  });
});

describe("a host, on a destructive action", () => {
  it("does it on their own event, holding no power at all", async () => {
    const eventId = await aCountingEvent();
    const host = await signInHolding();
    await makeHost(db, eventId, host);

    const result = await stopCounting(eventId).destroy();

    expect(result).toEqual({ ok: true, data: null });
    expect(await stopCounting(eventId).gone()).toBe(true);
  });

  it("does it on their own event when they also hold events.manage without destructive", async () => {
    const eventId = await aCountingEvent();
    const host = await signInHolding("events.manage");
    await makeHost(db, eventId, host);

    const result = await stopCounting(eventId).destroy();

    expect(result).toEqual({ ok: true, data: null });
  });

  it("is refused it on somebody else's event, which they reach through events.manage", async () => {
    const [mine, theirs] = [await aCountingEvent(), await aCountingEvent()];
    const host = await signInHolding("events.manage");
    await makeHost(db, mine, host);

    const result = await stopCounting(theirs).destroy();

    expect(result).toEqual({ ok: false, error: DESTRUCTIVE_REFUSAL });
    expect(await stopCounting(theirs).gone()).toBe(false);
  });
});
