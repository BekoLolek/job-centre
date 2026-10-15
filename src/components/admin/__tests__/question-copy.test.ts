import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AdminFieldView } from "@/lib/admin-games";

/*
 * What `/admin/games` tells an admin a control will do to stored answers
 * (UC-03 5a, R-09).
 *
 * Retiring a question keeps every answer (`retireField` writes `retired_at`
 * and touches `profile_values` not at all), and editing one keeps them too
 * (`updateField` writes the field row and nothing else). For a while the
 * screens said the opposite: "This change clears 3 stored answers", "This
 * destroys 3 stored answers", "Deleting it removes the question and every one
 * of their answers". Copy that is wrong in *that* direction is worse than no
 * copy at all, because the admin who believes it will not retire a question —
 * they will delete it, which is the one thing that really does take the
 * answers with it.
 *
 * So the scan below is the point of the file: no admin question screen may
 * claim an answer is cleared, destroyed or lost. It runs over what the reader
 * actually gets — the rendered markup, plus the copy that only appears after a
 * click a static render cannot make, which is exactly why that copy is
 * exported as a string rather than buried in JSX.
 *
 * Deliberately **not** scanned:
 *
 *  - `LadderEditor` — "those answers are cleared" is true there. Replacing a
 *    rank ladder really does clear the answers naming a rank that is gone
 *    (`setRankLadder`), and a test that forbade the sentence would be asking
 *    that screen to lie the other way.
 *  - `GamesManager`'s game copy — "without taking 12 stored answers with it"
 *    is a description of what deactivating *avoids*, one level up from a
 *    question, and it is also true.
 *  - `removeQuestionNotice`'s **own-question** half — "removing it takes their
 *    answers with it when you save" is true of an event question the event
 *    asks in its own right: `setEventQuestions` deletes the row and
 *    `clearOrphanedAnswers` really does drop the answers to it. Its **linked**
 *    half is scanned below, because that is the one that cannot claim a loss:
 *    the answer is a `profile_values` row and nothing on this path can reach
 *    one. The two are pinned apart in
 *    `src/components/admin/events/__tests__/linked-question-cost.test.ts`.
 *
 * The two modules the components cannot have here are mocked: the router
 * (there is no Next request) and the actions (`"use server"`, and nothing is
 * clicked in a static render).
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("@/app/admin/games/actions", () => ({
  createFieldAction: async () => ({ ok: true, data: { id: "" } }),
  deleteFieldAction: async () => ({ ok: true, data: { deletedAnswers: 0 } }),
  moveFieldAction: async () => ({ ok: true, data: null }),
  previewFieldEditAction: async () => ({ answers: 0, invalidated: 0 }),
  restoreFieldAction: async () => ({ ok: true, data: { restoredAnswers: 0 } }),
  retireFieldAction: async () => ({ ok: true, data: { keptAnswers: 0 } }),
  updateFieldAction: async () => ({ ok: true, data: { strandedAnswers: 0 } }),
}));

// The Form tab's own action module, for the same reason: importing it pulls
// next-auth in behind the database.
vi.mock("@/app/admin/events/actions", () => ({
  saveEventQuestionsAction: async () => ({
    ok: true,
    data: { questions: [], clearedAnswers: 0 },
  }),
}));

const { default: QuestionList, DELETE_REFUSED_WHEN_ANSWERED, DELETE_UNANSWERED, RETIRING_EXPLAINER } =
  await import("../QuestionList");
const { default: QuestionDialog, strandedAnswerNotice } = await import("../QuestionDialog");
const { removeQuestionNotice } = await import("../events/QuestionsTab");
const { THIS_GAME, rankUnavailable } = await import("@/lib/profile-fields");

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

function field(over: Partial<AdminFieldView> = {}): AdminFieldView {
  return {
    id: "field-1",
    gameId: "game-1",
    key: "preferred-roles",
    label: "Preferred roles",
    type: "multiselect",
    options: [
      { value: "tank", label: "Tank" },
      { value: "healer", label: "Healer" },
    ],
    required: false,
    sort: 0,
    retiredAt: null,
    createdAt: new Date("2026-03-01T18:00:00Z"),
    answers: 0,
    ...over,
  };
}

const ANSWERED = field({ id: "field-answered", label: "Preferred roles", answers: 40 });
const UNANSWERED = field({ id: "field-new", key: "notes", label: "Any notes", answers: 0 });
const RETIRED = field({
  id: "field-retired",
  key: "old-question",
  label: "Which DLC do you own",
  answers: 12,
  retiredAt: new Date("2026-06-01T10:00:00Z"),
});

function renderList(fields: AdminFieldView[], retired: AdminFieldView[] = []): string {
  return renderToStaticMarkup(
    createElement(QuestionList, {
      gameId: "game-1",
      gameName: "REPO",
      rankLadder: [],
      fields,
      retired,
      onChanged() {},
    })
  );
}

function renderDialog(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(QuestionDialog, {
      open: true,
      gameId: "game-1",
      rankLadder: [],
      onClose() {},
      onSaved() {},
      ...over,
    } as never)
  );
}

/** The `<li>` a question's label sits in, so "on the row" can be asserted. */
function rowFor(markup: string, label: string): string {
  const row = markup.split("<li").find((part) => part.includes(label));
  expect(row, `no row for ${label}`).toBeDefined();
  return row as string;
}

/* ------------------------------------------------------------------ */
/* The scan                                                           */
/* ------------------------------------------------------------------ */

/*
 * The gap between the two halves of each pattern is `[^.<]`, so a match has to
 * sit inside one sentence *and* inside one element. Both limits are there to
 * stop the scan inventing a claim nobody makes: a full stop ends the sentence,
 * and a `<` means the two halves are in different blocks of the page — a
 * heading that counts answers above a paragraph that says nothing is deleted
 * is two statements, not one sentence saying the answers are deleted.
 */
const DESTRUCTIVE: { name: string; pattern: RegExp }[] = [
  {
    name: "answers said to be cleared, removed, deleted or lost",
    pattern:
      /\banswers?\b[^.<]{0,60}\b(?:are|is|will be|would be|gets?)\s+(?:cleared|removed|deleted|lost|destroyed|wiped)/i,
  },
  {
    name: "a verb of destruction aimed at answers",
    pattern:
      /\b(?:clears?|clearing|destroys?|destroying|deletes|deleting|removes?|removing|wipes?|erases?)\b[^.<]{0,60}\banswers?\b/i,
  },
];

/** Every string the admin can be shown by one of the two question screens. */
function everyQuestionScreenString(): { where: string; text: string }[] {
  return [
    { where: "QuestionList, questions answered and retired", text: renderList([ANSWERED, UNANSWERED], [RETIRED]) },
    { where: "QuestionList, nothing asked any more", text: renderList([], [RETIRED]) },
    { where: "QuestionList, a brand new section", text: renderList([]) },
    { where: "QuestionDialog, adding", text: renderDialog() },
    { where: "QuestionDialog, editing", text: renderDialog({ field: ANSWERED }) },
    { where: "RETIRING_EXPLAINER", text: RETIRING_EXPLAINER },
    { where: "DELETE_UNANSWERED", text: DELETE_UNANSWERED },
    { where: "DELETE_REFUSED_WHEN_ANSWERED", text: DELETE_REFUSED_WHEN_ANSWERED },
    // Heading and body separately: they are two blocks on the page, and
    // running them together would invent a sentence neither of them says.
    { where: "strandedAnswerNotice(1) heading", text: strandedAnswerNotice(1).heading },
    { where: "strandedAnswerNotice(1) body", text: strandedAnswerNotice(1).body },
    { where: "strandedAnswerNotice(40) heading", text: strandedAnswerNotice(40).heading },
    { where: "strandedAnswerNotice(40) body", text: strandedAnswerNotice(40).body },
    { where: "rankUnavailable, a game with no ladder", text: rankUnavailable(THIS_GAME) },
    { where: "rankUnavailable, the Everyone section", text: rankUnavailable(null) },
    // The Form tab's remove dialog, linked half only — see the docblock above.
    { where: "removeQuestionNotice(1) linked heading", text: removeQuestionNotice({ linked: true, answers: 1 }).heading },
    { where: "removeQuestionNotice(1) linked body", text: removeQuestionNotice({ linked: true, answers: 1 }).body },
    { where: "removeQuestionNotice(40) linked heading", text: removeQuestionNotice({ linked: true, answers: 40 }).heading },
    { where: "removeQuestionNotice(40) linked body", text: removeQuestionNotice({ linked: true, answers: 40 }).body },
  ];
}

describe("why a rank question is unavailable (UC-03 3a, E1)", () => {
  it("tells the Everyone section the reason that is true of it", () => {
    // `createField(null, { type: "rank" })` is refused outright: a field with no
    // game has no ladder to read, so the question would render an empty picker
    // and `parseProfileValue` would refuse every answer to it.
    const text = rankUnavailable(null);

    expect(text).toMatch(/cannot be asked of every game/);
    expect(text).not.toMatch(/this game/i);
  });

  it("still tells a game with no ladder to add the ranks first", () => {
    // A different problem with a different answer: this one is one ladder away
    // from being able to ask.
    expect(rankUnavailable(THIS_GAME)).toMatch(/Add the ranks first/);
    // And `createField` refuses in the same words, naming the game it has.
    expect(rankUnavailable("REPO")).toContain("REPO has no rank ladder yet");
  });
});

describe("what the admin question screens say about stored answers", () => {
  it.each(everyQuestionScreenString())(
    "$where claims nothing is cleared, destroyed or lost",
    ({ text }) => {
      for (const { name, pattern } of DESTRUCTIVE) {
        expect(pattern.test(text), `${name}: ${pattern.exec(text)?.[0] ?? ""}`).toBe(false);
      }
    }
  );

  it("catches the wording it replaced, so the scan is not vacuously green", () => {
    // The three sentences that were on these screens before Task 47. If a
    // future edit puts one back, the loop above is what fails.
    for (const old of [
      "This change clears 3 stored answers",
      "This destroys 3 stored answers",
      "Deleting it removes the question and every one of their answers, and there is no undo.",
      "so those answers would be removed",
    ]) {
      expect(DESTRUCTIVE.some(({ pattern }) => pattern.test(old)), old).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* What the copy now says instead                                     */
/* ------------------------------------------------------------------ */

describe("the notice on an edit that strands answers", () => {
  it("says the answers are kept, because `updateField` keeps them", () => {
    const { heading, body } = strandedAnswerNotice(40);

    expect(heading).toContain("40 stored answers");
    expect(body).toContain("Nothing is deleted");
    expect(body).toMatch(/never throws an answer away/);
  });

  it("says the way back — the old definition makes them readable again", () => {
    // The round trip is the whole difference between an edit and an
    // amputation, and it is only true because nothing was thrown away.
    expect(strandedAnswerNotice(3).body).toMatch(/back the way it was/);
  });

  it("counts one answer as one", () => {
    expect(strandedAnswerNotice(1).heading).toContain("1 stored answer no longer fits");
    expect(strandedAnswerNotice(1).heading).not.toContain("answers");
  });
});

describe("retiring and restoring, from the question row (UC-03 5a)", () => {
  it("offers 'stop asking' on the row of a question people have answered", () => {
    const row = rowFor(renderList([ANSWERED]), "Preferred roles");

    expect(row).toContain("Stop asking");
    expect(row).toContain("aria-label=\"Stop asking Preferred roles\"");
  });

  it("does not offer a delete that `deleteField` would only refuse", () => {
    // 40 answers: `deleteField` fails it outright and points at retiring. A
    // button whose only outcome is a refusal is not a choice.
    const row = rowFor(renderList([ANSWERED]), "Preferred roles");

    expect(row).not.toContain("Delete");
  });

  it("still offers delete on a question nobody has answered", () => {
    const row = rowFor(renderList([UNANSWERED]), "Any notes");

    expect(row).toContain("aria-label=\"Delete Any notes\"");
  });

  it("lists a retired question with its answers and the way to ask it again", () => {
    const row = rowFor(renderList([ANSWERED], [RETIRED]), "Which DLC do you own");

    expect(row).toContain("12 answers kept");
    expect(row).toContain("Ask it again");
    expect(row).toContain("aria-label=\"Ask Which DLC do you own again\"");
  });

  it("explains retiring where the buttons are", () => {
    const markup = renderList([ANSWERED], [RETIRED]);

    expect(markup).toContain("Every answer already given is kept");
    expect(markup).toContain("brings all of them back");
  });

  it("does not pretend a section with only retired questions is empty", () => {
    // The old empty state said "No questions yet", which on this section is
    // false twice over: there are questions, and there are answers to them.
    const markup = renderList([], [RETIRED]);

    expect(markup).not.toContain("No questions yet");
    expect(markup).toContain("Which DLC do you own");
  });
});
