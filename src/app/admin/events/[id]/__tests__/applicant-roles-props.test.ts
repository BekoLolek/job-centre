import { type ReactElement, type ReactNode, isValidElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, games, profileFields, profileValues, users } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import type EventEditor from "@/components/admin/events/EventEditor";

/*
 * The preferred roles on the event editor's props (R-258 / Task 119).
 *
 * `src/lib/__tests__/applicant-roles.test.ts` says what `getApplicationsForEvent`
 * answers. This says the answer survives the page, as far as the editor: a
 * page that mapped its rows down on the way — as it does for the hands sheet
 * and the players book — would drop the roles without any test of the read
 * noticing.
 *
 * **The last hop is not tested here, or anywhere.** The editor hands the same
 * array on to the Teams tab (`<TeamsTab applicants={applicants} />` in
 * `EventEditor.tsx`), and what holds that line is the compiler: `applicants`
 * is a required prop of `TeamsTab`, so deleting it fails the typecheck. That
 * is the difference from the gap Task 118 left — there the field was
 * optional, the compiler never looked, and deleting the line left every test
 * passing. If `applicants` ever becomes optional on the tab, this hop needs a
 * test of its own.
 *
 * Nothing is rendered. The page is called as the function it is and the
 * element it returns is searched for the editor, so what is asserted is the
 * props the page built and not markup the Teams tab has yet to draw.
 *
 * Mocked as `metadata.test.ts` beside this does it: who is signed in, and
 * `@/db`'s handle.
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

const { default: AdminEventPage } = await import("../page");
const { default: Editor } = await import("@/components/admin/events/EventEditor");
const { applyToEvent, createEvent, publishEvent } = await import("@/lib/events");

type EditorProps = Parameters<typeof EventEditor>[0];

/** The first element of this type in a tree nobody has rendered. */
function find(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    return node.reduce<ReactElement | null>((hit, child) => hit ?? find(child, type), null);
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return find((node.props as { children?: ReactNode }).children, type);
}

let handle: TestDatabase;

beforeAll(async () => {
  handle = await freshDatabase();
  state.db = handle.db;

  const admin = await makeUser(handle.db, { displayName: "An admin" });
  await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
  state.userId = admin;
});

afterAll(async () => {
  await handle.close();
});

describe("the event editor's applicants", () => {
  it("carry each accepted player's preferred roles to the editor", async () => {
    const db = handle.db;
    const [game] = await db
      .insert(games)
      .values({ key: "rivals", name: "Marvel Rivals" })
      .returning({ id: games.id });
    const [mains] = await db
      .insert(profileFields)
      .values({
        gameId: game.id,
        key: "mains",
        label: "Mains",
        type: "multiselect",
        options: [
          { value: "tank", label: "Vanguard" },
          { value: "heal", label: "Strategist" },
        ],
        holdsRoles: true,
      })
      .returning({ id: profileFields.id });
    const created = await createEvent({ ...PUBLISHABLE, title: "Roles night", gameId: game.id }, db);
    if (!created.ok) throw new Error(created.error);
    const published = await publishEvent(created.data.id, db);
    if (!published.ok) throw new Error(published.error);
    const player = await makeUser(db, { displayName: "A player" });
    await db
      .insert(profileValues)
      .values({ userId: player, fieldId: mains.id, value: ["heal", "tank"] as never });
    const applied = await applyToEvent(
      created.data.id,
      player,
      { now: new Date("2026-04-01T18:00:00Z") },
      db
    );
    if (!applied.ok || applied.data.status !== "accepted") {
      throw new Error("The fixture event did not accept.");
    }

    const page = await AdminEventPage({
      params: Promise.resolve({ id: created.data.id }),
      searchParams: Promise.resolve({}),
    });

    const editor = find(page, Editor);
    const applicants = (editor?.props as EditorProps | undefined)?.applicants;
    expect(applicants?.map((row) => [row.userId, row.roles])).toEqual([
      [player, ["Vanguard", "Strategist"]],
    ]);
  });
});
