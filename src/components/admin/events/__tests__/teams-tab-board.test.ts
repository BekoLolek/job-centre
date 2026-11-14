import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberLike, TeamLike } from "@/components/draft";
import { DEFAULT_DRAFT_CONFIG, rosterState } from "@/lib/draft-policy";
import type { ApplicantView } from "@/lib/events";
import { eventShapeFrom, rosterSizingFrom, teamFormatFrom } from "@/lib/events-policy";
import { applicant } from "./applicants-fixture";
import type { DraftTabData } from "../types";

/*
 * The Rosters board — a card dragged onto a team, or back to the unplaced
 * list (R-257, R-260 / UC-53; Task 121).
 *
 * What a drop *means* is `roster-board.test.ts`'s, over plain data. This file
 * is about the tab obeying it: that a drop reaches the two actions that
 * already existed, that the card is on its team before they answer, that a
 * refusal puts it back under the server's own sentence, and that the selects
 * are still there and still write.
 *
 * ## The harness, and the one thing it adds to `format-tab-generate.test.ts`'s
 *
 * No DOM, so nothing can be dragged. That file's two spies are here as they
 * are there — `@/components/ui` wrapped so a `Select`'s or a `Button`'s real
 * handler can be called, and `useState` remembering what its setter was told
 * so "act, then render again" walks the tab's own closures.
 *
 * A drag handle and a drop target are plain elements, though, not `ui`
 * components, so there is a third: **the JSX runtime is wrapped** to note
 * every plain element that carries a drag handler, with its key. A team's
 * `<li>` is keyed by the team's id and the unplaced list is the one target
 * with no key; a handle is found by its tooltip. The handlers called are the
 * tab's own.
 *
 * And `@/components/draft` is wrapped the same way as `ui`, for `PlayerCard`
 * alone: what each card on the board was *handed* is noted, by the player's
 * name, and then the real card is drawn. A card is read from that and not
 * from the markup, so a card with no handle — a captain's, one in flight,
 * every one once the draft has started — is as readable as any other. What
 * the card draws from those props is `player-card.test.ts`'s.
 * **What this does not do** is said at the bottom.
 */

const actions = vi.hoisted(() => ({
  placeOnRosterAction: vi.fn(),
  previewTeamCountAction: vi.fn(),
  previewTeamsAction: vi.fn(),
  randomiseTeamsAction: vi.fn(),
  removeFromRosterAction: vi.fn(),
  saveNightFormatAction: vi.fn(),
  saveTeamsAction: vi.fn(),
  setTeamCountAction: vi.fn(),
}));

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: () => {}, push: () => {} }));

type Props = Record<string, unknown>;
type Seen = { kind: "Button" | "Select"; props: Props };
type Plain = { type: string; props: Props; key: string | null };
const seen = vi.hoisted(() => [] as Seen[]);
const plain = vi.hoisted(() => [] as Plain[]);
const cards = vi.hoisted(() => [] as Props[]);
const hooks = vi.hoisted(() => ({ at: 0, held: new Map<number, unknown>() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState<T>(initial: T | (() => T)) {
    const at = hooks.at;
    hooks.at += 1;
    const [rendered] = actual.useState(initial);
    const read = () => (hooks.held.has(at) ? (hooks.held.get(at) as T) : rendered);
    const write = (next: T | ((was: T) => T)) => {
      hooks.held.set(at, typeof next === "function" ? (next as (was: T) => T)(read()) : next);
    };
    return [read(), write];
  }
  return { ...actual, useState };
});

type Runtime = Record<string, (...args: unknown[]) => unknown>;

/** Note a plain element that carries a drag handler, then build it as React would. */
function noting(real: (...args: unknown[]) => unknown) {
  return (type: unknown, props: Props, key: unknown, ...rest: unknown[]) => {
    if (typeof type === "string" && (props.onDrop || props.onDragStart)) {
      plain.push({ type, props, key: key === undefined ? null : String(key) });
    }
    return real(type, props, key, ...rest);
  };
}

vi.mock("react/jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<Runtime>();
  return { ...actual, jsx: noting(actual.jsx), jsxs: noting(actual.jsxs) };
});

vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = await importOriginal<Runtime>();
  return { ...actual, jsxDEV: noting(actual.jsxDEV) };
});

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  const react = await import("react");
  const watched = (kind: Seen["kind"], real: unknown) => (props: Props) => {
    seen.push({ kind, props });
    return react.createElement(real as never, props);
  };
  return {
    ...actual,
    Button: watched("Button", actual.Button),
    Select: watched("Select", actual.Select),
  };
});

vi.mock("@/components/draft", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/draft")>();
  const react = await import("react");
  return {
    ...actual,
    PlayerCard: (props: Props) => {
      cards.push(props);
      return react.createElement(actual.PlayerCard as never, props);
    },
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => router }));

vi.mock("@/app/admin/events/draft-actions", () => actions);

const { default: TeamsTab } = await import("../TeamsTab");

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const CONFIG = DEFAULT_DRAFT_CONFIG;

/** Three places a team, captain included, through the real reader. */
const SIZING = rosterSizingFrom(
  eventShapeFrom({
    eventShape: { teamEvent: true, draft: true, sizing: { mode: "perTeam", value: 3 } },
  }),
  0
);

const NAMES: Record<string, string> = {
  "cap-a": "Ada Captain",
  pat: "Placed Pat",
  quin: "Quin Fourth",
  "cap-b": "Bo Captain",
  free: "Free Agent",
  sam: "Sam Second",
  tia: "Tia Third",
};

function member(teamId: string, userId: string, over: Partial<MemberLike> = {}): MemberLike {
  return { teamId, userId, price: 0, isCaptain: false, ...over };
}

function team(id: string, name: string, members: MemberLike[]): TeamLike {
  return {
    id,
    name,
    seed: null,
    captainUserId: members.find((row) => row.isCaptain)?.userId ?? null,
    balanceStart: CONFIG.defaultBalance,
    balance: CONFIG.defaultBalance,
    roster: rosterState({ id }, members, CONFIG, SIZING),
    members,
  };
}

/**
 * Alpha is **full** — its captain, Pat and Quin make three of three — and
 * Bravo has its captain and two places. Free, Sam and Tia are accepted and on
 * no team, in that order.
 */
const ALPHA = [
  member("team-a", "cap-a", { isCaptain: true }),
  member("team-a", "pat"),
  member("team-a", "quin"),
];
const BRAVO = [member("team-b", "cap-b", { isCaptain: true })];

const APPLICANTS: ApplicantView[] = Object.entries(NAMES).map(([userId, name]) =>
  applicant({
    id: `application-${userId}`,
    userId,
    status: "accepted",
    displayName: name,
    member: { id: userId, displayName: name, avatarUrl: null, discordId: `d-${userId}` },
  })
);

function tabData(over: Partial<DraftTabData> = {}): DraftTabData {
  return {
    teams: [team("team-a", "Alpha", ALPHA), team("team-b", "Bravo", BRAVO)],
    config: CONFIG,
    sizing: SIZING,
    pool: { main: [], reserve: [] },
    unpooled: [],
    discarded: [],
    players: Object.fromEntries(
      Object.entries(NAMES).map(([userId, displayName]) => [userId, { displayName }])
    ),
    started: false,
    teamFormat: teamFormatFrom({ teamFormat: "6v6" }),
    fill: { route: "empty" },
    privateDraft: false,
    ...over,
  };
}

/** Where a card can be let go: a team, by its id, or the unplaced list. */
type Target = "team-a" | "team-b" | "unplaced";

type Board = { Alpha: string[]; Bravo: string[]; unplaced: string[] };

type Screen = {
  html: () => string;
  /** Who is where, in the order the cards read. */
  board: () => Board;
  /** Whether this player's card has a drag handle. */
  handle: (name: string) => boolean;
  /** Start dragging this player's card by its handle. */
  lift: (name: string) => void;
  /** Hold the dragged card over a target. True when the target takes it. */
  over: (target: Target) => boolean;
  /** Let go on a target, and let whatever can settle, settle. */
  drop: (target: Target) => Promise<void>;
  select: (label: string) => Props | null;
  /** The props of the one button with this label, or null when there is none. */
  button: (label: string) => Props | null;
  /** What this player's one card on the board was handed. */
  card: (name: string) => Props;
  choose: (label: string, value: string) => Promise<void>;
  press: (label: string) => Promise<void>;
};

const settle = () => new Promise((done) => setTimeout(done, 0));

const dragEvent = () => ({
  preventDefault: vi.fn(),
  dataTransfer: { setData: vi.fn(), effectAllowed: "none" },
});

function open(
  data: DraftTabData = tabData(),
  applicants: ApplicantView[] = APPLICANTS
): Screen {
  const html = () => {
    hooks.at = 0;
    seen.length = 0;
    plain.length = 0;
    cards.length = 0;
    return renderToStaticMarkup(
      createElement(TeamsTab, {
        eventId: "event-1",
        applicants,
        data,
        shape: eventShapeFrom({}),
      })
    );
  };

  const board = (): Board => {
    const markup = html();
    const heading = (name: string) =>
      markup.indexOf(`<span class="font-display text-16">${name}</span>`);
    const marks = [heading("Alpha"), heading("Bravo"), markup.indexOf("Accepted and not on a team")];
    // The three headings, in this order, or the slices below mean nothing.
    expect(marks[0]).toBeGreaterThan(-1);
    expect(marks[1]).toBeGreaterThan(marks[0]);
    expect(marks[2]).toBeGreaterThan(marks[1]);
    const within = (from: number, to: number) => {
      const slice = markup.slice(from, to);
      return Object.values(NAMES)
        .filter((name) => slice.includes(name))
        .sort((a, b) => slice.indexOf(a) - slice.indexOf(b));
    };
    return {
      Alpha: within(marks[0], marks[1]),
      Bravo: within(marks[1], marks[2]),
      unplaced: within(marks[2], markup.length),
    };
  };

  const handleOf = (name: string) => {
    html();
    return plain.find((entry) => entry.props.title === `Drag ${name}`) ?? null;
  };
  const targetOf = (target: Target) => {
    html();
    const found = plain.find(
      (entry) =>
        typeof entry.props.onDrop === "function" &&
        entry.key === (target === "unplaced" ? null : target)
    );
    if (!found) throw new Error(`No drop target for ${target} on the screen.`);
    return found;
  };
  const select = (label: string) => {
    html();
    return (
      seen.find((entry) => entry.kind === "Select" && entry.props["aria-label"] === label)
        ?.props ?? null
    );
  };

  return {
    html,
    board,
    handle: (name) => handleOf(name) !== null,
    lift: (name) => {
      const handle = handleOf(name);
      if (!handle) throw new Error(`${name}'s card has no drag handle.`);
      (handle.props.onDragStart as (event: unknown) => void)(dragEvent());
    },
    over: (target) => {
      const event = dragEvent();
      (targetOf(target).props.onDragOver as (event: unknown) => void)(event);
      return event.preventDefault.mock.calls.length > 0;
    },
    drop: async (target) => {
      (targetOf(target).props.onDrop as (event: unknown) => void)(dragEvent());
      await settle();
    },
    select,
    button: (label) => {
      html();
      const hits = seen.filter(
        (entry) => entry.kind === "Button" && entry.props.children === label
      );
      if (hits.length > 1) throw new Error(`${hits.length} “${label}” buttons on the screen.`);
      return hits[0]?.props ?? null;
    },
    card: (name) => {
      html();
      const hits = cards.filter((props) => props.name === name);
      if (hits.length !== 1) throw new Error(`${hits.length} cards for ${name} on the board.`);
      return hits[0];
    },
    choose: async (label, value) => {
      const props = select(label);
      if (!props) throw new Error(`No “${label}” select on the screen.`);
      (props.onChange as (input: { target: { value: string } }) => void)({ target: { value } });
      await settle();
    },
    press: async (label) => {
      html();
      const hits = seen.filter(
        (entry) => entry.kind === "Button" && entry.props.children === label
      );
      if (hits.length !== 1) throw new Error(`${hits.length} “${label}” buttons on the screen.`);
      (hits[0].props.onClick as () => void)();
      await settle();
    },
  };
}

/** An action held in the middle of its round trip until `land` is called. */
function held(action: ReturnType<typeof vi.fn>) {
  let land: (result: unknown) => void = () => {};
  action.mockReturnValueOnce(
    new Promise((resolve) => {
      land = resolve;
    })
  );
  return {
    land: async (result: unknown) => {
      land(result);
      await settle();
    },
  };
}

const rows = (...members: MemberLike[]) => ({ ok: true, data: { rosters: members, sync: null } });

/** The server's sentences, as `src/lib/draft.ts` writes them. Fixtures for its answers. */
const FULL =
  "Bravo's roster is full — 3 of 3. Take somebody off it first, or raise the places on a team in Setup → Format.";
const CAPTAIN = "They captain this team. Change the captain on the Captains tab instead.";

/** A sentence as the markup carries it. */
const escaped = (text: string) => text.replace(/'/g, "&#x27;");

const START: Board = {
  Alpha: ["Ada Captain", "Placed Pat", "Quin Fourth"],
  Bravo: ["Bo Captain"],
  unplaced: ["Free Agent", "Sam Second", "Tia Third"],
};

beforeEach(() => {
  hooks.held.clear();
  actions.placeOnRosterAction.mockReset();
  actions.removeFromRosterAction.mockReset();
  router.refresh.mockReset();
});

/* ------------------------------------------------------------------ */
/* The gesture, through the writes that were already there            */
/* ------------------------------------------------------------------ */

describe("a card let go on the board (UC-53 3, 5)", () => {
  it("opens with everybody where the server says they are", () => {
    // The control for every board below: the reader reads this fixture right.
    expect(open().board()).toEqual(START);
  });

  it("removes the player when it is let go on the unplaced list — through removeFromRosterAction", async () => {
    actions.removeFromRosterAction.mockResolvedValue(rows(ALPHA[0], ALPHA[2], ...BRAVO));
    const screen = open();

    screen.lift("Placed Pat");
    await screen.drop("unplaced");

    // The team sent is the one Pat is leaving, which the server checks.
    expect(actions.removeFromRosterAction).toHaveBeenCalledTimes(1);
    expect(actions.removeFromRosterAction).toHaveBeenCalledWith("team-a", "pat");
    expect(actions.placeOnRosterAction).not.toHaveBeenCalled();
    // Application order, which is where the unplaced list puts anybody.
    expect(screen.board()).toEqual({
      Alpha: ["Ada Captain", "Quin Fourth"],
      Bravo: ["Bo Captain"],
      unplaced: ["Placed Pat", "Free Agent", "Sam Second", "Tia Third"],
    });
  });

  it("adopts the rosters the server hands back, not its own guess at them", async () => {
    // The server's answer also carries somebody another admin placed meanwhile.
    actions.placeOnRosterAction.mockResolvedValue(
      rows(...ALPHA, ...BRAVO, member("team-b", "tia"), member("team-b", "sam"))
    );
    const screen = open();

    screen.lift("Sam Second");
    await screen.drop("team-b");

    expect(screen.board()).toEqual({
      ...START,
      Bravo: ["Bo Captain", "Tia Third", "Sam Second"],
      unplaced: ["Free Agent"],
    });
  });
});

/* ------------------------------------------------------------------ */
/* What a card carries (UC-53 2, 2a, 2b; R-258)                       */
/* ------------------------------------------------------------------ */

describe("what a card on the board is handed about its player", () => {
  const picture = (userId: string) => `https://cdn.discordapp.com/avatars/${userId}/a.png`;

  /** The usual applicants, with these ones changed. */
  const applicantsWith = (changes: Record<string, Partial<ApplicantView>>) =>
    APPLICANTS.map((row) => ({ ...row, ...changes[row.member.id] }));

  /** The usual tab, with these players pictured in the book the tab is handed. */
  const pictured = (userIds: string[], over: Partial<DraftTabData> = {}) =>
    tabData({
      players: Object.fromEntries(
        Object.entries(NAMES).map(([id, displayName]) => [
          id,
          { displayName, avatarUrl: userIds.includes(id) ? picture(id) : null },
        ])
      ),
      ...over,
    });

  const SAM = {
    name: "Sam Second",
    avatarUrl: picture("sam"),
    rank: "Diamond II",
    roles: ["Duelist", "Strategist"],
  };
  const ADA = {
    name: "Ada Captain",
    avatarUrl: picture("cap-a"),
    rank: "Platinum I",
    roles: ["Vanguard"],
  };
  const TOLD = applicantsWith({
    sam: { rank: SAM.rank, roles: SAM.roles },
    "cap-a": { rank: ADA.rank, roles: ADA.roles },
  });

  it("carries their picture, their rank and their roles — on their card and nobody else's", () => {
    const screen = open(pictured(["sam"]), TOLD);

    expect(screen.card("Sam Second")).toEqual(SAM);
    // The control: the card beside it is Tia's own — the fixture's rank, no
    // picture, and no roles question answered for her.
    expect(screen.card("Tia Third")).toEqual({
      name: "Tia Third",
      avatarUrl: null,
      rank: "Gold I",
      roles: null,
    });
  });

  it("carries a captain's, on the team they lead", () => {
    const screen = open(pictured(["cap-a"]), TOLD);

    expect(screen.board().Alpha).toContain("Ada Captain");
    expect(screen.handle("Ada Captain")).toBe(false);
    expect(screen.card("Ada Captain")).toEqual(ADA);
  });

  it("still carries them once the draft has started and no card can be moved", () => {
    const screen = open(pictured(["sam", "cap-a"], { started: true }), TOLD);

    expect(screen.handle("Sam Second")).toBe(false);
    expect(screen.card("Sam Second")).toEqual(SAM);
    expect(screen.card("Ada Captain")).toEqual(ADA);
  });

  it("still carries them while their move is in flight", async () => {
    held(actions.placeOnRosterAction);
    const screen = open(pictured(["sam"]), TOLD);

    screen.lift("Sam Second");
    await screen.drop("team-b");

    expect(screen.board().Bravo).toContain("Sam Second");
    expect(screen.handle("Sam Second")).toBe(false);
    expect(screen.card("Sam Second")).toEqual(SAM);
  });

  it("hands on an empty list of roles as one, not as no roles question (UC-53 2a, 2b)", () => {
    // `[]` is "asked, and chose none"; `null` is "the game does not ask".
    // The card says different things for the two, and the tab must not fold
    // one into the other on the way.
    const screen = open(tabData(), applicantsWith({ sam: { roles: [] } }));

    expect(screen.card("Sam Second").roles).toEqual([]);
    expect(screen.card("Tia Third").roles).toBeNull();
  });

  it("claims nothing about somebody on a roster whose application is not on this page", () => {
    // Quin is on Alpha and in the book, and has no application row here.
    const screen = open(
      tabData(),
      APPLICANTS.filter((row) => row.member.id !== "quin")
    );

    expect(screen.card("Quin Fourth")).toEqual({
      name: "Quin Fourth",
      avatarUrl: null,
      rank: null,
      roles: null,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Optimism, and what a refusal does to it (R-260)                    */
/* ------------------------------------------------------------------ */

describe("the move before the server has answered (UC-53 4)", () => {
  it("has the card on the team while the write is still in flight", async () => {
    const flight = held(actions.placeOnRosterAction);
    const screen = open();

    screen.lift("Sam Second");
    await screen.drop("team-b");

    // Asked, not answered — through the placing action that was already
    // here — and the card is already there.
    expect(actions.placeOnRosterAction).toHaveBeenCalledTimes(1);
    expect(actions.placeOnRosterAction).toHaveBeenCalledWith("team-b", "sam");
    expect(actions.removeFromRosterAction).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.board()).toEqual({
      ...START,
      Bravo: ["Bo Captain", "Sam Second"],
      unplaced: ["Free Agent", "Tia Third"],
    });

    await flight.land(rows(...ALPHA, ...BRAVO, member("team-b", "sam")));
    expect(screen.board().Bravo).toEqual(["Bo Captain", "Sam Second"]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("has the card off the team while a removal is still in flight", async () => {
    held(actions.removeFromRosterAction);
    const screen = open();

    screen.lift("Placed Pat");
    await screen.drop("unplaced");

    expect(screen.board().Alpha).toEqual(["Ada Captain", "Quin Fourth"]);
    expect(screen.board().unplaced).toContain("Placed Pat");
  });
});

describe("a move the server refuses (UC-53 4a, 4b, 4c)", () => {
  it("returns a card taken off a team to its place on that roster", async () => {
    const flight = held(actions.removeFromRosterAction);
    const screen = open();
    screen.lift("Placed Pat");
    await screen.drop("unplaced");
    expect(screen.board().Alpha).toEqual(["Ada Captain", "Quin Fourth"]);

    await flight.land({ ok: false, error: CAPTAIN });

    expect(screen.board()).toEqual(START);
  });

  it("says a full team in the server's sentence — this board thought Bravo had room", async () => {
    actions.placeOnRosterAction.mockResolvedValue({ ok: false, error: FULL });
    const screen = open();
    expect(screen.html()).not.toContain('role="alert"');

    screen.lift("Sam Second");
    await screen.drop("team-b");

    const after = screen.html();
    expect(after).toContain('role="alert"');
    expect(after).toContain(escaped(FULL));
    // Back exactly where it was: the middle of the list it left.
    expect(screen.board()).toEqual(START);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("says a captain in the server's sentence — this board did not know Pat was one", async () => {
    actions.placeOnRosterAction.mockResolvedValue({ ok: false, error: CAPTAIN });
    const screen = open(
      tabData({
        teams: [team("team-a", "Alpha", [ALPHA[1]]), team("team-b", "Bravo", BRAVO)],
      })
    );

    screen.lift("Placed Pat");
    await screen.drop("team-b");

    const after = screen.html();
    expect(after).toContain('role="alert"');
    expect(after).toContain(CAPTAIN);
    expect(screen.board().Alpha).toEqual(["Placed Pat"]);
    expect(screen.board().Bravo).toEqual(["Bo Captain"]);
  });

  it("keeps neither sentence itself — the wording is the server's, not a second copy", () => {
    const source = ["TeamsTab.tsx", "roster-board.ts"]
      .map((file) => readFileSync(path.resolve(__dirname, "..", file), "utf8"))
      .join("\n");

    // The control: the files were read, and they are the ones with the board in.
    expect(source).toContain("moveFor");
    expect(source).not.toMatch(/s roster is full —/i);
    expect(source).not.toMatch(/Take somebody off it first/i);
    expect(source).not.toMatch(/They captain this team/i);
  });

  it("returns the card and says nothing was saved when the server cannot be reached", async () => {
    actions.placeOnRosterAction.mockRejectedValue(new Error("fetch failed"));
    const screen = open();

    screen.lift("Sam Second");
    await screen.drop("team-b");

    expect(screen.html()).toContain("Could not reach the server. Nothing was saved.");
    expect(screen.board()).toEqual(START);
  });
});

/* ------------------------------------------------------------------ */
/* What the board does not ask the server                             */
/* ------------------------------------------------------------------ */

describe("a card let go where it started (UC-53 3b)", () => {
  /*
   * The control for both: the in-flight and removing tests above let go through
   * these same two targets and each makes exactly one call. So zero here is
   * the tab declining to write, not a drop that never reached a handler.
   */

  it("writes nothing when a rostered card is let go on its own team", async () => {
    const screen = open();

    screen.lift("Placed Pat");
    await screen.drop("team-a");

    expect(actions.placeOnRosterAction).toHaveBeenCalledTimes(0);
    expect(actions.removeFromRosterAction).toHaveBeenCalledTimes(0);
    expect(screen.board()).toEqual(START);
    expect(screen.html()).not.toContain('role="alert"');
  });

  it("writes nothing when an unplaced card is let go on the unplaced list", async () => {
    const screen = open();

    screen.lift("Sam Second");
    await screen.drop("unplaced");

    expect(actions.placeOnRosterAction).toHaveBeenCalledTimes(0);
    expect(actions.removeFromRosterAction).toHaveBeenCalledTimes(0);
    expect(screen.board()).toEqual(START);
  });
});

describe("what the board offers a dragged card", () => {
  it("takes it on a team with room, and on the unplaced list when it is on a team", () => {
    const screen = open();

    screen.lift("Placed Pat");

    expect(screen.over("team-b")).toBe(true);
    expect(screen.over("unplaced")).toBe(true);
  });

  it("does not take it on a full team, and a drop forced there writes nothing", async () => {
    const screen = open();
    screen.lift("Sam Second");

    expect(screen.over("team-a")).toBe(false);
    await screen.drop("team-a");

    expect(actions.placeOnRosterAction).not.toHaveBeenCalled();
    expect(screen.board()).toEqual(START);
  });

  it("does not take it where it started", () => {
    const screen = open();

    screen.lift("Placed Pat");

    expect(screen.over("team-a")).toBe(false);
  });

  it("takes nothing while no card is being dragged", () => {
    const screen = open();

    expect(screen.over("team-b")).toBe(false);
    expect(screen.over("unplaced")).toBe(false);
  });

  it("ends the drag on the drop itself — a second drop without a lift moves nobody", async () => {
    // The card is re-made in the list it lands in, and a `dragend` aimed at
    // the handle it left may never arrive.
    actions.placeOnRosterAction.mockResolvedValue({ ok: false, error: FULL });
    const screen = open();
    screen.lift("Sam Second");
    await screen.drop("team-b");

    expect(screen.over("team-b")).toBe(false);
    await screen.drop("team-b");

    expect(actions.placeOnRosterAction).toHaveBeenCalledTimes(1);
  });

  it("gives a handle to every card that may move, at the 44px floor, and none to a captain", () => {
    const screen = open();

    expect(screen.handle("Placed Pat")).toBe(true);
    expect(screen.handle("Sam Second")).toBe(true);
    expect(screen.handle("Ada Captain")).toBe(false);
    const handle = /<span[^>]*title="Drag Sam Second"[^>]*>/.exec(screen.html())?.[0];
    expect(handle).toContain('draggable="true"');
    expect(handle).toMatch(/class="[^"]*\bh-11 w-11\b/);
  });

  it("gives no handle at all once the draft has started", () => {
    const screen = open(tabData({ started: true }));

    expect(screen.handle("Placed Pat")).toBe(false);
    expect(screen.handle("Sam Second")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The selects — the keyboard's path and the phone's (UC-53 3a)       */
/* ------------------------------------------------------------------ */

describe("the selects, which the gesture is an addition to", () => {
  it("still offers “Place on…” and writes the placement when a team is chosen", async () => {
    actions.placeOnRosterAction.mockResolvedValue(
      rows(...ALPHA, ...BRAVO, member("team-b", "free"))
    );
    const screen = open();
    expect(screen.html()).toMatch(
      /<select[^>]*aria-label="Place Free Agent on a team"[^>]*>(?:(?!<\/select>).)*<option value="" selected="">Place on…<\/option>(?:(?!<\/select>).)*<option value="team-b">Bravo<\/option>/
    );

    await screen.choose("Place Free Agent on a team", "team-b");

    expect(actions.placeOnRosterAction).toHaveBeenCalledTimes(1);
    expect(actions.placeOnRosterAction).toHaveBeenCalledWith("team-b", "free");
    expect(screen.board().Bravo).toEqual(["Bo Captain", "Free Agent"]);
  });

  it("still offers “Move to…” and writes the move when a team is chosen", async () => {
    actions.placeOnRosterAction.mockResolvedValue(
      rows(ALPHA[0], member("team-b", "pat"), ALPHA[2], ...BRAVO)
    );
    const screen = open();
    expect(screen.html()).toMatch(
      /<select[^>]*aria-label="Move Placed Pat to another team"[^>]*>(?:(?!<\/select>).)*<option value="" selected="">Move to…<\/option>(?:(?!<\/select>).)*<option value="team-b">Bravo<\/option>/
    );

    await screen.choose("Move Placed Pat to another team", "team-b");

    expect(actions.placeOnRosterAction).toHaveBeenCalledTimes(1);
    expect(actions.placeOnRosterAction).toHaveBeenCalledWith("team-b", "pat");
    expect(screen.board()).toEqual({
      ...START,
      Alpha: ["Ada Captain", "Quin Fourth"],
      Bravo: ["Bo Captain", "Placed Pat"],
    });
  });

  it("still takes somebody off with the Off button", async () => {
    actions.removeFromRosterAction.mockResolvedValue(rows(ALPHA[0], ...BRAVO));
    // One player to take off, so one Off button.
    const screen = open(
      tabData({
        teams: [team("team-a", "Alpha", [ALPHA[0], ALPHA[1]]), team("team-b", "Bravo", BRAVO)],
      })
    );

    await screen.press("Off");

    expect(actions.removeFromRosterAction).toHaveBeenCalledTimes(1);
    expect(actions.removeFromRosterAction).toHaveBeenCalledWith("team-a", "pat");
    expect(screen.board().Alpha).toEqual(["Ada Captain"]);
  });

  it("writes nothing for the placeholder option of either select", async () => {
    const screen = open();

    await screen.choose("Place Free Agent on a team", "");
    await screen.choose("Move Placed Pat to another team", "");

    expect(actions.placeOnRosterAction).not.toHaveBeenCalled();
    expect(actions.removeFromRosterAction).not.toHaveBeenCalled();
    expect(screen.board()).toEqual(START);
  });
});

/* ------------------------------------------------------------------ */
/* One move a player at a time — and the first one wins               */
/* ------------------------------------------------------------------ */

describe("a second move of a player whose first is still in flight", () => {
  it("cannot land by any control — the first move wins", async () => {
    const flight = held(actions.placeOnRosterAction);
    const screen = open(
      // Alpha with room, so there is a second team the second move could aim at.
      tabData({
        teams: [team("team-a", "Alpha", [ALPHA[0]]), team("team-b", "Bravo", BRAVO)],
      })
    );
    screen.lift("Sam Second");
    await screen.drop("team-b");
    expect(actions.placeOnRosterAction).toHaveBeenCalledTimes(1);

    // The card has no handle to lift while it is in flight…
    expect(screen.handle("Sam Second")).toBe(false);
    // …its select is disabled, and is refused even when its handler is called
    // anyway, for the other team and for the same one…
    expect(screen.select("Move Sam Second to another team")?.disabled).toBe(true);
    await screen.choose("Move Sam Second to another team", "team-a");
    await screen.choose("Move Sam Second to another team", "team-b");
    // …and so is its Off button, disabled and refused when pressed anyway.
    expect(screen.button("Off")?.disabled).toBe(true);
    await screen.press("Off");

    expect(actions.placeOnRosterAction).toHaveBeenCalledTimes(1);
    expect(actions.placeOnRosterAction).toHaveBeenCalledWith("team-b", "sam");
    expect(actions.removeFromRosterAction).not.toHaveBeenCalled();

    // The first move lands, and it is the one the board keeps.
    await flight.land(rows(ALPHA[0], ...BRAVO, member("team-b", "sam")));
    expect(screen.board().Bravo).toEqual(["Bo Captain", "Sam Second"]);
    expect(screen.board().Alpha).toEqual(["Ada Captain"]);

    // And once it has, Sam can be moved again.
    expect(screen.handle("Sam Second")).toBe(true);
    expect(screen.select("Move Sam Second to another team")?.disabled).toBe(false);
    expect(screen.button("Off")?.disabled).toBe(false);
  });

  it("holds a card whose removal is in flight, in the unplaced list it is shown in", async () => {
    const flight = held(actions.removeFromRosterAction);
    const screen = open();
    screen.lift("Placed Pat");
    await screen.drop("unplaced");
    expect(screen.board().unplaced).toContain("Placed Pat");

    // No handle, a disabled select, and nothing sent when it is used anyway.
    expect(screen.handle("Placed Pat")).toBe(false);
    expect(screen.select("Place Placed Pat on a team")?.disabled).toBe(true);
    await screen.choose("Place Placed Pat on a team", "team-b");

    expect(actions.placeOnRosterAction).not.toHaveBeenCalled();
    expect(actions.removeFromRosterAction).toHaveBeenCalledTimes(1);

    // The removal lands, and Pat is off a team — the first move, again.
    await flight.land(rows(ALPHA[0], ALPHA[2], ...BRAVO));
    expect(screen.board().Bravo).toEqual(["Bo Captain"]);
    expect(screen.handle("Placed Pat")).toBe(true);
    expect(screen.select("Place Placed Pat on a team")?.disabled).toBe(false);
  });

  it("holds back that one player — somebody else's move goes out while it is in flight", async () => {
    const first = held(actions.placeOnRosterAction);
    const second = held(actions.placeOnRosterAction);
    const screen = open();
    screen.lift("Sam Second");
    await screen.drop("team-b");

    // Nobody else's controls are disabled by Sam's round trip.
    expect(screen.select("Place Tia Third on a team")?.disabled).toBe(false);
    expect(screen.handle("Tia Third")).toBe(true);
    screen.lift("Tia Third");
    await screen.drop("team-b");

    expect(actions.placeOnRosterAction).toHaveBeenCalledTimes(2);
    expect(actions.placeOnRosterAction).toHaveBeenLastCalledWith("team-b", "tia");
    expect(screen.board().Bravo).toEqual(["Bo Captain", "Sam Second", "Tia Third"]);

    // Sam's answer was read before Tia's write, so it does not carry Tia —
    // and Tia's card stays where it was let go until its own answer comes.
    await first.land(rows(...ALPHA, ...BRAVO, member("team-b", "sam")));
    expect(screen.board().Bravo).toEqual(["Bo Captain", "Sam Second", "Tia Third"]);
    expect(screen.board().unplaced).toEqual(["Free Agent"]);

    await second.land(
      rows(...ALPHA, ...BRAVO, member("team-b", "sam"), member("team-b", "tia"))
    );
    expect(screen.board().Bravo).toEqual(["Bo Captain", "Sam Second", "Tia Third"]);
  });

  it("does not offer a third card a team the cards in flight have filled", async () => {
    held(actions.placeOnRosterAction);
    held(actions.placeOnRosterAction);
    const screen = open();
    screen.lift("Sam Second");
    await screen.drop("team-b");
    screen.lift("Tia Third");
    await screen.drop("team-b");

    // Bravo is three of three on the board, though only its captain is saved.
    screen.lift("Free Agent");
    expect(screen.over("team-b")).toBe(false);
    await screen.drop("team-b");

    expect(actions.placeOnRosterAction).toHaveBeenCalledTimes(2);
  });
});

/*
 * ## What this file does not prove
 *
 *  - **That a browser drag reaches these handlers.** `onDragStart`, `onDragOver`
 *    and `onDrop` are called directly, with an object standing in for the
 *    event. That a real drag fires them — and that `preventDefault` on
 *    `dragover` is what makes the browser allow the drop — is the browser's
 *    business, and no browser ran this.
 *  - **That React re-renders between two events.** State is carried between
 *    renders by the wrapper above, not by a live root. The in-flight guard
 *    reads state, so it leans on React flushing a drop or a change before the
 *    next event is handled; that is React's behaviour for discrete events and
 *    is not exercised here.
 *  - **Where the focus goes** when a select moves its own card to another list.
 */
