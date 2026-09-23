import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, SETTING_KEYS } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import type { AnnouncementSettings, DiscordMessage } from "@/lib/announce";

/*
 * A draft sale reaching Discord — R-150, UC-26 E1.
 *
 * "At step 1, draft sales are one of the announcements — when a lot is awarded
 * (UC-16 step 7), System posts the player, team and price."
 *
 * Three things make that sentence testable and all three are asserted: the
 * *switch* (R-108's "switchable with the others"), the *three facts* in the
 * post, and the one case the room cares about more than any of them — a sale
 * undone in the seconds between the award and the post, which must not be
 * announced at all. `announceLotSold` defers its work to `after()`, so a lot
 * voided by the manager's next click really can beat the webhook to the wire.
 *
 * The harness is `discord.test.ts`'s, for the same reasons it gives: `@/db` is
 * pointed at this file's database because `deliver` reads the webhook through
 * the default handle, `after()` collects the deferred job so a test can await
 * exactly the work it started, and `fetch` is a stub so nothing here can reach
 * Discord. This file lives beside it rather than in it because what it is
 * really testing is `src/lib/draft.ts`'s side of the handshake — that an award
 * leaves a row a message can be built from.
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

vi.mock("next/server", () => ({
  after: (work: () => Promise<void>) => {
    state.jobs.push(work());
  },
}));

const { announceLotSold, setAnnouncementSettings, setIntegrationSetting } = await import(
  "@/lib/discord"
);
const { defaultAnnouncementSettings } = await import("@/lib/announce");
const { awardLot, openLot, placeBid, setCaptains, setDraftPool, setTeams, voidLot } =
  await import("@/lib/draft");
const { applyToEvent, createEvent, publishEvent } = await import("@/lib/events");

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
  await setIntegrationSetting(SETTING_KEYS.webhookUrl, "https://discord.test/api/webhooks/1/token");
  vi.stubEnv("DISCORD_WEBHOOK_URL", "");
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchStub.mockReset();
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

function posted(): DiscordMessage[] {
  return fetchStub.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as DiscordMessage);
}

/**
 * A published event with two captained teams, a pool, and one player bought by
 * "Alpha" for `price`. Returns the lot so a test can undo it.
 */
async function aSale(price: number) {
  counter += 1;
  const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Draft sale ${counter}` }, db));
  unwrap(await publishEvent(event.id, db));

  const members: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const userId = await makeUser(db, { displayName: `Sold ${counter}-${index}` });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
  }

  const written = unwrap(await setTeams(event.id, [{ name: "Alpha" }, { name: "Bravo" }], db));
  const [alpha, bravo] = written.teams;
  unwrap(
    await setCaptains(
      event.id,
      [
        { teamId: alpha.id, userId: members[0] },
        { teamId: bravo.id, userId: members[1] },
      ],
      db
    )
  );
  unwrap(await setDraftPool(event.id, {}, db));

  const lot = unwrap(await openLot(event.id, { userId: members[2] }, db));
  unwrap(await placeBid(lot.id, alpha.id, price, {}, db));
  unwrap(await awardLot(lot.id, alpha.id, {}, db));

  return { event, lotId: lot.id, player: `Sold ${counter}-2` };
}

/** Run the announcement and wait for the job it deferred. */
async function announced(lotId: string) {
  announceLotSold(lotId);
  await Promise.all(state.jobs);
}

describe("a draft sale (R-150 / UC-26 E1)", () => {
  it("posts the player, the team and the price", async () => {
    await switches({ draft_lot_sold: true });
    const sale = await aSale(420);

    await announced(sale.lotId);

    const [post] = posted();
    const embed = post.embeds?.[0];
    expect(embed?.title).toBe(`${sale.player} → Alpha`);
    expect(embed?.description).toContain("420");
    expect(embed?.fields?.[0]).toMatchObject({ value: sale.event.title });
  });

  it("is filed as a draft post, so the channel can tell it from a result", async () => {
    await switches({ draft_lot_sold: true });
    const sale = await aSale(15);

    await announced(sale.lotId);

    expect(posted()[0].embeds?.[0]?.footer?.text).toBe("Draft");
  });

  it("says a player went for nothing rather than printing a naked zero", async () => {
    // The minimum bid is zero by default, so this is a real outcome and not a
    // bug — but "Sold for 0" reads as a broken board.
    await switches({ draft_lot_sold: true });
    const sale = await aSale(0);

    await announced(sale.lotId);

    expect(posted()[0].embeds?.[0]?.description).toBe("Went for nothing.");
  });

  it("posts nothing while the draft-sales switch is off (R-108)", async () => {
    await switches({ draft_lot_sold: false, match_result: true });
    const sale = await aSale(100);

    await announced(sale.lotId);

    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("posts nothing for a sale the manager has already undone (UC-16 7a)", async () => {
    // The undo is the whole reason lots are rows rather than deletions, and a
    // channel announcing a price nobody paid is the one way that leaks out.
    await switches({ draft_lot_sold: true });
    const sale = await aSale(500);
    unwrap(await voidLot(sale.lotId, {}, db));

    await announced(sale.lotId);

    expect(fetchStub).not.toHaveBeenCalled();
  });
});
