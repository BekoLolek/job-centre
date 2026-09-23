import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PollDraft } from "@/app/polls/actions";
import type { Poll, PollEditPreview } from "@/lib/polls";

/*
 * The poll screen's two questions (UC-23 4, 5b).
 *
 * What the server decides is pinned in `src/lib/__tests__/polls.test.ts`. What
 * is left is the screen's own rule — when to ask — and it is a rule worth
 * stating on its own, because the version before this one got it backwards.
 * The save ran unless the preview came back *successfully* with votes to lose,
 * so a preview that failed fell through to a save that never asked: the one
 * case the confirm exists for was the one case that skipped it.
 *
 * `useRouter` and the action module are the only things between these
 * components and pure functions, so they are the only things mocked. The
 * actions are mocked rather than imported because importing them would drag the
 * database and the session into a node test to render a dialog.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

vi.mock("@/app/polls/actions", () => ({
  closePollAction: vi.fn(),
  createPollAction: vi.fn(),
  deletePollAction: vi.fn(),
  previewPollEditAction: vi.fn(),
  updatePollAction: vi.fn(),
  votePollAction: vi.fn(),
}));

const { DeleteConfirm, EditConfirmDialog, afterPreview, savePoll } = await import(
  "../PollList"
);
const { createPollAction, previewPollEditAction, updatePollAction } = await import(
  "@/app/polls/actions"
);

function preview(over: Partial<PollEditPreview> = {}): PollEditPreview {
  return {
    closed: false,
    lostVotes: 0,
    droppedOptions: [],
    reworded: [],
    clearedVoters: 0,
    ...over,
  };
}

function poll(over: Partial<Poll> = {}): Poll {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    question: "Which night suits?",
    detail: null,
    multiple: false,
    closesAt: new Date("2999-01-01T00:00:00Z"),
    closed: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    by: { id: "admin", name: "Admin" },
    options: [],
    voterCount: 4,
    yours: [],
    ...over,
  };
}

describe("what happens once the preview comes back (UC-23 4)", () => {
  it("stops, and says why, when the preview never arrived", () => {
    // The whole point: no preview, no save. A failed preview is not permission.
    const outcome = afterPreview({ ok: false, error: "Not an admin." });

    expect(outcome.kind).toBe("stop");
    expect(outcome.kind === "stop" && outcome.error).toBe("Not an admin.");
  });

  it("stops on a poll that closed while the form was open", () => {
    // UC-23 3a. The library refuses this too; getting there would mean the
    // admin typed out an edit and was told no at the end of it.
    const outcome = afterPreview({ ok: true, data: preview({ closed: true }) });

    expect(outcome.kind).toBe("stop");
    expect(outcome.kind === "stop" && outcome.error).toMatch(/closed/i);
  });

  it("asks before throwing votes away", () => {
    const outcome = afterPreview({
      ok: true,
      data: preview({ lostVotes: 3, droppedOptions: ["Saturday"] }),
    });

    expect(outcome.kind).toBe("confirm");
    expect(outcome.kind === "confirm" && outcome.confirm.droppedOptions).toEqual([
      "Saturday",
    ]);
  });

  it("asks before a rewording speaks for votes already cast", () => {
    // Nothing is lost here, so a preview that only counted losses would have
    // saved this one silently.
    const outcome = afterPreview({
      ok: true,
      data: preview({ reworded: [{ from: "Thursday", to: "Thursday, 9pm", votes: 2 }] }),
    });

    expect(outcome.kind).toBe("confirm");
  });

  it("saves an edit that costs nobody anything, without a dialog", () => {
    // A confirm that always appears is a confirm nobody reads.
    expect(afterPreview({ ok: true, data: preview() }).kind).toBe("save");
  });
});

describe("what the save does about it (UC-23 4)", () => {
  /*
   * The five tests above pin the rule; these pin that the save consults it.
   * Nothing used to: the reviewer's mutation — `if (false && poll && !force)`,
   * which deletes the preview step from every save path and reinstates the
   * whole bug — left this file nine of nine green.
   */
  const draft: PollDraft = {
    question: "Which night suits?",
    multiple: false,
    closesAt: "2999-01-01T00:00:00.000Z",
    options: [{ label: "Thursday" }, { label: "Friday" }],
  };

  beforeEach(() => {
    vi.mocked(previewPollEditAction).mockReset();
    vi.mocked(updatePollAction).mockReset();
    vi.mocked(createPollAction).mockReset();
  });

  it("writes nothing at all when the preview came back a refusal", async () => {
    vi.mocked(previewPollEditAction).mockResolvedValue({ ok: false, error: "Not an admin." });
    // Armed to succeed, so that a save which wrongly goes ahead fails on the
    // assertion below rather than on the mock having nothing to return.
    vi.mocked(updatePollAction).mockResolvedValue({ ok: true, data: { lostVotes: 9 } });

    const outcome = await savePoll(poll(), draft, false);

    expect(updatePollAction).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "stop", error: "Not an admin." });
  });

  it("writes once the preview says the edit costs nobody anything", async () => {
    // Without this one, the test above would pass against a save that never
    // writes under any circumstances.
    vi.mocked(previewPollEditAction).mockResolvedValue({ ok: true, data: preview() });
    vi.mocked(updatePollAction).mockResolvedValue({ ok: true, data: { lostVotes: 0 } });

    expect(await savePoll(poll(), draft, false)).toEqual({ kind: "saved" });
    expect(updatePollAction).toHaveBeenCalledWith(poll().id, draft);
  });

  it("does not ask twice once the dialog has been answered", async () => {
    // `force` is the Save-it-anyway button. The preview has already been read.
    vi.mocked(updatePollAction).mockResolvedValue({ ok: true, data: { lostVotes: 3 } });

    expect(await savePoll(poll(), draft, true)).toEqual({ kind: "saved" });
    expect(previewPollEditAction).not.toHaveBeenCalled();
  });

  it("posts a new poll with no preview to ask for", async () => {
    // Nothing has been voted on yet, so there is nothing an edit could cost.
    vi.mocked(createPollAction).mockResolvedValue({ ok: true, data: { id: "new" } });

    expect(await savePoll(undefined, draft, false)).toEqual({ kind: "saved" });
    expect(previewPollEditAction).not.toHaveBeenCalled();
  });
});

describe("the dialog that edit puts up", () => {
  const render = (confirm: Parameters<typeof EditConfirmDialog>[0]["confirm"]) =>
    renderToStaticMarkup(
      createElement(EditConfirmDialog, { confirm, onConfirm: () => {}, onCancel: () => {} })
    );

  it("says each of the three things an edit can do, and only those that apply", () => {
    const markup = render({
      lostVotes: 3,
      droppedOptions: ["Saturday"],
      reworded: [{ from: "Thursday", to: "Thursday, 9pm", votes: 2 }],
      clearedVoters: 1,
    });

    expect(markup).toContain("3 votes");
    expect(markup).toContain("Saturday");
    expect(markup).toContain("Thursday, 9pm");
    expect(markup).toContain("2 votes");
    expect(markup).toContain("1 person");

    const rewordOnly = render({
      lostVotes: 0,
      droppedOptions: [],
      reworded: [{ from: "Thursday", to: "Thursday, 9pm", votes: 2 }],
      clearedVoters: 0,
    });
    // "Removing  throws away 0 votes" is what the single-paragraph version of
    // this dialog used to say when nothing was being removed.
    expect(rewordOnly).not.toContain("throws away");
    expect(rewordOnly).toContain("Thursday, 9pm");
  });

  it("is not on screen until there is something to ask", () => {
    expect(render(null)).toBe("");
  });
});

describe("asking before a poll is deleted (UC-23 5b)", () => {
  const render = (row: Poll | null) =>
    renderToStaticMarkup(
      createElement(DeleteConfirm, { poll: row, onConfirm: () => {}, onCancel: () => {} })
    );

  it("names the poll and the answers that go with it", () => {
    const markup = render(poll({ voterCount: 4 }));

    expect(markup).toContain("Which night suits?");
    expect(markup).toContain("4 answers");
    expect(markup).toContain("Delete it and the votes");
    expect(markup).toContain("Keep it");
  });

  it("says nothing until Delete is pressed", () => {
    // The card renders this on every pass; open by default is a delete that
    // never asks.
    expect(render(null)).toBe("");
  });
});
