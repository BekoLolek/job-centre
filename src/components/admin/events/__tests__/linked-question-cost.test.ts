import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EventQuestionView } from "@/lib/events";
import { applicant, applicantsEvent } from "./applicants-fixture";
import type { LinkableField } from "../types";

/*
 * What the Form tab says an edit will cost, for a question whose answer is not
 * stored here at all (R-11, Task 10).
 *
 * `ApplicantView.answers` is composed on read: `linkedAnswers` fills a linked
 * question's slot from `profile_values`, because that is where the answer
 * lives. Counting that map therefore counts profile answers, and for a while
 * this tab did — so the delete dialog said "3 applicants answered this —
 * removing it takes their answers with it" about a question nothing is stored
 * under, `clearOrphanedAnswers` then deleted nothing, and the save toast came
 * back saying 0 answers were cleared. Copy that is wrong in *that* direction
 * is the dangerous one: an admin who believes it leaves the form wrong rather
 * than fix it, which is the same failure `question-copy.test.ts` guards one
 * screen over.
 *
 * So the two numbers are pinned apart here: what is stored (the cost) and what
 * the member holds on their profile (not a cost, and said so). The fixture
 * hands the tab exactly what the server would — one own question with a stored
 * answer and one linked question with a composed one — so the mistake is
 * reproduced rather than imagined.
 *
 * The router and the action module are mocked for the reason
 * `question-copy.test.ts` mocks them: a static render clicks nothing, and
 * importing the action would drag the database and the session in.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/app/admin/events/actions", () => ({
  saveEventQuestionsAction: async () => ({
    ok: true,
    data: { questions: [], clearedAnswers: 0 },
  }),
}));

const { default: QuestionsTab, removeQuestionNotice } = await import("../QuestionsTab");

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const ROLE_OPTIONS = [
  { value: "vanguard", label: "Vanguard" },
  { value: "strategist", label: "Strategist" },
];

function question(over: Partial<EventQuestionView> = {}): EventQuestionView {
  return {
    id: "question-own",
    eventId: "event-1",
    key: "anything-else",
    label: "Anything else",
    type: "text",
    options: [],
    required: false,
    sort: 0,
    profileFieldId: null,
    createdAt: new Date("2026-04-01T17:00:00.000Z"),
    choices: [],
    ...over,
  };
}

const OWN = question();
const LINKED = question({
  id: "question-linked",
  key: "preferred-role",
  label: "Preferred role",
  type: "select",
  options: ROLE_OPTIONS,
  choices: ROLE_OPTIONS,
  profileFieldId: "field-role",
});

const LINKABLE: LinkableField[] = [
  {
    id: "field-role",
    key: "role",
    label: "Preferred role",
    type: "select",
    options: ROLE_OPTIONS,
    required: false,
    scope: "Marvel Rivals",
  },
];

/** The tab as the server would hand it over: one answer of each kind stored. */
function renderTab(): string {
  return renderToStaticMarkup(
    createElement(QuestionsTab, {
      event: applicantsEvent([], { questions: [OWN, LINKED] }),
      applicants: [
        applicant({
          // What `decorate` produces: the own answer out of the column, the
          // linked one composed out of the member's profile.
          answers: { [OWN.id]: "Bringing a spare keyboard", [LINKED.id]: "strategist" },
        }),
      ],
      linkableFields: LINKABLE,
      maxQuestions: 10,
    })
  );
}

/** The `<li>` one question's label sits in, so "on the row" can be asserted. */
function rowFor(markup: string, label: string): string {
  const row = markup.split("<li").find((part) => part.includes(label));
  expect(row, `no row for ${label}`).toBeDefined();
  return row as string;
}

/* ------------------------------------------------------------------ */

describe("what the Form tab counts as an answer", () => {
  it("counts the stored answer to a question the event asks in its own right", () => {
    // The number that is real: `clearOrphanedAnswers` would delete this one.
    expect(rowFor(renderTab(), "Anything else")).toContain("1 answer");
  });

  it("counts no answers against a linked question", () => {
    /*
     * Nothing is stored under a linked question's id — `validateAnswers` is
     * given `ownQuestions` and refuses a payload naming one, and `decorate`
     * drops a legacy copy on read. A badge counting the composed answer would
     * be counting a `profile_values` row as something this event could lose.
     */
    const row = rowFor(renderTab(), "Preferred role");

    expect(row).not.toContain("answer");
    expect(row).not.toContain("at risk");
    // Still marked as what it is, so the row is not silent about the link.
    expect(row).toContain("Prefilled");
  });

  it("promises nothing will be cleared when the whole list is saved", () => {
    // The list on screen drops nothing and retypes nothing, so there is no
    // loss sentence anywhere on the tab — the one the composed count produced
    // was about the linked question alone.
    const markup = renderTab();

    expect(markup).not.toContain("will be deleted when you save");
    expect(markup).not.toContain("answers at risk");
  });
});

describe("what removing a question says it costs", () => {
  it("tells the truth about a question the event asks in its own right", () => {
    const { heading, body } = removeQuestionNotice({ linked: false, answers: 3 });

    expect(heading).toBe("3 applicants answered this");
    expect(body).toMatch(/takes their answers with it when you save/);
    expect(body).toMatch(/Nothing is written until then/);
  });

  it("says a linked answer lives on the profile and stays there", () => {
    /*
     * The sentence this file exists for. Removing a linked question deletes an
     * `event_questions` row; `clearOrphanedAnswers` rewrites
     * `applications.answers` and cannot reach `profile_values` at all. So the
     * member keeps the answer, every other event asking for the same detail
     * still reads it, and the only thing that changes is that this event stops
     * asking.
     */
    const { heading, body } = removeQuestionNotice({ linked: true, answers: 3 });

    expect(heading).toBe("3 applicants answered this on their profile");
    expect(body).toMatch(/belongs to their profile and stays there/);
    expect(body).toMatch(/takes nothing with it/);
    expect(body).toMatch(/only stops this event asking/);
    // And it must not borrow the other notice's claim.
    expect(body).not.toMatch(/takes their answers with it/);
  });

  it("counts one applicant as one, either way", () => {
    expect(removeQuestionNotice({ linked: false, answers: 1 }).heading).toBe(
      "1 applicant answered this"
    );
    expect(removeQuestionNotice({ linked: true, answers: 1 }).heading).toBe(
      "1 applicant answered this on their profile"
    );
  });
});
