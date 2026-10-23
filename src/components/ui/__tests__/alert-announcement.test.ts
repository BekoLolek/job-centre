import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Alert, { type AlertProps } from "../Alert";
import Field from "../Field";
import Stepper from "../Stepper";
import FieldControl from "../../profile/FieldControl";
import type { FieldControlView } from "@/lib/profile";

/**
 * Every refusal on the site reaches somebody who cannot see it, and no standing
 * notice interrupts them on arrival.
 *
 * ## What this file verifies, and what it cannot
 *
 * The suite runs in vitest's `node` environment — no DOM, no jsdom, no
 * testing-library — so **nothing here measures what a screen reader says.** It
 * cannot: there is no accessibility tree to read and no assistive technology in
 * the process. What it does measure is the attributes that make an announcement
 * possible and the attributes that keep one from happening, which is a claim
 * about markup and is settled by markup.
 *
 * The browser half — that submitting a duplicate template name at
 * `/admin/templates` produced an element with `role` null and `aria-live` null,
 * on the live page — is what found this defect. It is recorded in the task
 * notes. Re-measuring it is a browser's job, not this file's, and a test here
 * that looked like it proved audibility would be a worse lie than the silence.
 *
 * ## Why the sweep reads the call sites off disk
 *
 * One component stands between every refusal on the site and the people who
 * most need to be told, and it is rendered at 117 places in 50 files. A test
 * that renders `<Alert>` in isolation proves nothing about whether those 117
 * places pass the right prop — that is exactly how `roles={roles}` was deleted
 * from a page on this project while every component test stayed green. So the
 * classification of every call site is recorded below and checked against the
 * source, in source order, per file.
 *
 * Recorded as an inventory rather than as a pattern, for the reason in Task 31's
 * `Left over` note: a sweep keyed to the *fixed* form cannot report the
 * *unfixed* one. Counting the call sites that carry `standing` would count the
 * ones already decided and be blind to the one nobody has thought about. The
 * inventory makes every call site a thing somebody wrote down, so a new or moved
 * `<Alert>` fails until it is classified.
 */

const ROOT = path.resolve(__dirname, "../../../..");
const SRC = path.join(ROOT, "src");

/* --------------------------------------------------------------------- */
/* The component                                                         */
/* --------------------------------------------------------------------- */

function markup(over: Partial<AlertProps> = {}): string {
  return renderToStaticMarkup(createElement(Alert, { children: "Nope.", ...over }));
}

describe("the Alert component", () => {
  it("announces by default, because its purpose is reporting a failed save", () => {
    /*
     * Both attributes, spelled out. `role="alert"` already implies
     * `aria-live="assertive"`, but the implication is the thing that was
     * measured null in the browser and the pair is what assistive technology is
     * most reliably tested against — so both are asserted, and an edit that
     * drops either one fails here.
     */
    const rendered = markup();
    expect(rendered).toContain('role="alert"');
    expect(rendered).toContain('aria-live="assertive"');
  });

  it("is silent when it is standing content, so it cannot interrupt on arrival", () => {
    const rendered = markup({ standing: true });
    expect(rendered).not.toContain("role=");
    expect(rendered).not.toContain("aria-live");
  });

  it("takes an id, so an input can point aria-describedby at the refusal", () => {
    expect(markup({ id: "template-name-refusal" })).toContain('id="template-name-refusal"');
    // And does not invent one when none is asked for: a live region nobody
    // points at is better than a duplicate id that steals somebody else's.
    expect(markup()).not.toContain("id=");
  });

  it("announces on every tone, because the tone is colour and not urgency", () => {
    for (const tone of ["flare", "union", "success"] as const) {
      expect(markup({ tone }), tone).toContain('role="alert"');
      expect(markup({ tone, standing: true }), `${tone} standing`).not.toContain("role=");
    }
  });

  it("is the whole of it, exactly, for the default bar", () => {
    /*
     * Spelled out rather than counted. What this guards against is an extra
     * wrapper or a second live region appearing around the bar — and a nested
     * `<div aria-live>` is invisible to every assertion except the one that says
     * what the markup is.
     */
    expect(markup()).toBe(
      '<div role="alert" aria-live="assertive" ' +
        'class="border px-3 py-2 text-14 border-flare/40 bg-flare-tint-10 text-flare">' +
        "Nope.</div>"
    );
  });
});

/* --------------------------------------------------------------------- */
/* Reading the call sites off disk                                       */
/* --------------------------------------------------------------------- */

/**
 * A file's code with its comments taken out.
 *
 * Both halves of the sweep look for a JSX tag, and several files in this tree
 * discuss `<Alert` in prose — including the component's own docblock and this
 * one. A comment that can satisfy an assertion is how a `toContain("PAGE_SHELL")`
 * on this project came to pass over a comment, so the comments go first.
 */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/([^:"'`\\])\/\/[^\n]*$/gm, "$1");
}

/**
 * The attributes of every `<Tag …>` in a file, nested JSX excluded.
 *
 * `(?=[\s>/])` is load-bearing twice over. It keeps `<AlertTone` and
 * `<AlertProps` — the type references in the component's own file — from being
 * read as call sites, and it keeps a sweep matcher from swallowing an English
 * sentence, which has happened on this project and passed.
 *
 * The obvious `/<Alert\b([\s\S]*?)\/>/` stops at the first `/>` it finds, which
 * on these call sites is frequently a `<span … />` inside the children, so every
 * attribute of the markup passed *into* the bar comes back as an attribute *on*
 * it. This walks the element's own attribute list instead, keeping only what
 * sits at brace depth zero, and skipping quoted strings so a `>` inside one
 * cannot end it early.
 */
function attrsOf(source: string, tag: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(new RegExp(`<${tag}(?=[\\s>/])`, "g"))) {
    let depth = 0;
    let quote: string | null = null;
    let own = "";
    for (let i = match.index + match[0].length; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        own += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        own += ch;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
      own += ch;
    }
    out.push(own);
  }
  return out;
}

function tsxFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx")) out.push(full);
    }
  })(SRC);
  return out.sort();
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

type Bucket = "standing" | "announced";

/** Every `<Alert>` on disk, by file, in source order. */
function found(): Record<string, Bucket[]> {
  const out: Record<string, Bucket[]> = {};
  for (const file of tsxFiles()) {
    const attrs = attrsOf(code(file), "Alert");
    if (attrs.length === 0) continue;
    out[relative(file)] = attrs.map((a) => (/\bstanding\b/.test(a) ? "standing" : "announced"));
  }
  return out;
}

/**
 * The decision taken at every one of the 117 call sites, in source order.
 *
 * The question that decides each one: **can this content already be in the
 * markup when the page first renders?** If yes — its condition is satisfied by
 * server data or props alone, or there is no condition — it is `standing`, and
 * interrupting with it on arrival is the trap `role="alert"` on the component
 * would have walked into. If no — it exists only because of something the user
 * did in this session, whether that is state a handler set, a dialog they
 * opened, or an unsaved edit they made — it is announced, because nothing else
 * will tell them it appeared.
 *
 * Three groups are worth naming, because each of them is a judgement somebody
 * will want to re-litigate:
 *
 * - **A modal's body is announced.** `Modal` returns null when closed, so an
 *   Alert inside one is never on the page at arrival; it is there because the
 *   admin clicked Delete. And it is not read by the dialog opening either —
 *   `Modal` moves focus to the first *control*, not to the container, and
 *   carries no `aria-labelledby`, so the body text is not announced by the focus
 *   move. Without the role, the sentence saying how many stored answers a
 *   confirm is about is silent.
 * - **"Will be deleted when you save" is announced.** Those bars read a `draft`
 *   against what is stored, and on arrival the two are equal, so they cannot be
 *   there on load. They appear because the admin removed a day, a stage, a team
 *   or a question.
 * - **A live draft room's tie and completion lines are standing.** They are
 *   derived from the polled room payload, which can already say "tied" on the
 *   render that arrives, so assertive would interrupt everyone who opens the
 *   room mid-tie. `error` and `note` beside them are handler state and are
 *   announced. `BidBox`'s blocked-outright bar is standing for the same reason,
 *   and the file's own name for that branch — `STANDING_BLOCKS`, the server's
 *   standing answer to "may you bid at all" — already said so.
 */
const CLASSIFIED: Record<string, Bucket[]> = {
  "src/app/admin/audit/page.tsx": ["standing"],
  "src/app/admin/championships/NewChampionship.tsx": ["announced"],
  "src/app/dev-login/page.tsx": ["standing"],
  "src/app/events/[slug]/apply/page.tsx": ["standing", "standing", "standing"],
  "src/app/events/[slug]/draft/AdminConsole.tsx": ["standing"],
  "src/app/events/[slug]/draft/BidBox.tsx": ["standing"],
  "src/app/events/[slug]/draft/DraftRoom.tsx": [
    "announced",
    "announced",
    "standing",
    "standing",
    "standing",
  ],
  /*
   * The draw's only Alert, and it is the one UC-39 5a is about: the store
   * failed, so nothing was dealt and the button has come back. It exists purely
   * because the player clicked, a moment after they clicked, and nothing else
   * on the screen will tell them the click did not take — so it announces.
   *
   * The draw page's own four refusals — no seat, no game, an empty hero list, a
   * list too thin to deal from — are deliberately **not** Alerts. Each is the
   * whole screen rather than a bar above one, decided from server data before
   * anything renders, so each is a `Panel` with its own heading, the shape the
   * apply page uses for the same job. An Alert there would have been standing
   * content by this file's own rule, and a tinted bar is the wrong element for
   * a page whose entire answer is "not this one, and here is where to go".
   */
  "src/app/events/[slug]/draw/HandReveal.tsx": ["announced"],
  "src/app/events/[slug]/page.tsx": ["standing"],
  "src/app/me/events/page.tsx": ["standing"],
  "src/app/me/profile/page.tsx": ["standing"],
  "src/app/signin/page.tsx": ["standing", "standing"],
  "src/components/admin/AdminAllowlist.tsx": ["announced", "announced", "standing"],
  "src/components/admin/AnnouncementSettings.tsx": [
    "standing",
    "announced",
    "standing",
    "standing",
    "announced",
    "announced",
    "standing",
    "announced",
  ],
  "src/components/admin/ChampionshipEditor.tsx": ["announced", "announced", "standing"],
  "src/components/admin/GamesManager.tsx": ["announced"],
  /*
   * Both announced, and neither is a close call.
   *
   * The first is `error`, which is handler state: it is set by `run` when an
   * action comes back refused, so it cannot be in the markup on arrival. It
   * carries UC-40 3a and 3b — the duplicate name and the hero with no role —
   * which is the content that most has to reach somebody who cannot see it.
   *
   * The second is the rename confirm, which exists only because the admin
   * clicked Rename on a row. `renaming` starts null, so the same argument
   * holds, and it is the sentence that tells them a rename will plant a second
   * hero on the next seed. Announcing it is the point: it appears in place of
   * the write they just asked for.
   */
  "src/components/admin/HeroEditor.tsx": ["announced", "announced"],
  "src/components/admin/HostQueue.tsx": ["announced"],
  "src/components/admin/LadderEditor.tsx": ["announced", "announced"],
  "src/components/admin/QuestionDialog.tsx": ["announced", "announced"],
  "src/components/admin/QuestionList.tsx": ["announced"],
  "src/components/admin/ServerSettings.tsx": [
    "announced",
    "standing",
    "announced",
    "announced",
  ],
  "src/components/admin/TemplateQuestionList.tsx": ["announced"],
  "src/components/admin/TemplatesManager.tsx": ["announced"],
  "src/components/admin/UsersManager.tsx": ["announced", "announced", "announced"],
  "src/components/admin/events/ApplicantsTab.tsx": [
    "announced",
    "standing",
    "standing",
    "announced",
    "announced",
    "announced",
  ],
  "src/components/admin/events/BasicsTab.tsx": ["announced"],
  "src/components/admin/events/CaptainsTab.tsx": ["announced", "announced"],
  "src/components/admin/events/ChampionshipTab.tsx": ["announced", "announced", "standing"],
  "src/components/admin/events/DaysTab.tsx": ["announced", "announced", "announced"],
  "src/components/admin/events/DraftTab.tsx": [
    "announced",
    "standing",
    "announced",
    "announced",
    "standing",
    "standing",
  ],
  "src/components/admin/events/EntryRulesTab.tsx": [
    "standing",
    "standing",
    "announced",
    "standing",
  ],
  /*
   * Two, and Task 80's is the first in source order (UC-42 5a).
   *
   * The editor's own notice is **standing**: it is `tabNotice`, computed by the
   * server page from `?tab=` and therefore in the markup the moment the page
   * arrives — it explains a redirect that happened *before* this render, so
   * announcing it would interrupt an admin who followed a stale bookmark with
   * something they can already see. The second is `SaveAsTemplate`'s `error`,
   * which is handler state and starts null, so it exists only because somebody
   * pressed Make template.
   */
  "src/components/admin/events/EventEditor.tsx": ["standing", "announced"],
  "src/components/admin/events/EventQuestionDialog.tsx": ["announced", "announced"],
  "src/components/admin/events/EventsManager.tsx": ["announced"],
  "src/components/admin/events/FormatTab.tsx": ["announced", "announced", "announced"],
  "src/components/admin/events/PlacementEditor.tsx": ["announced"],
  /*
   * Five, three of them Task 83's (R-221 to R-223 / UC-43).
   *
   * In source order: the publish error; "Published."; the no-webhook notice;
   * the result of a press; and the already-posted confirmation.
   *
   * The third is `standing` and the only one of the three that is: it is
   * `announcements.webhook`, which is server data on the props, so it is in the
   * markup the moment the tab arrives and must not interrupt an admin who came
   * to read the readiness checklist. The other two are handler state —
   * `notice` and `confirming` both start null — so each exists only because
   * somebody pressed Post, and the confirm one is the sentence that appears
   * *in place of* the post they asked for, which is exactly the content that
   * has to reach somebody who cannot see it.
   */
  "src/components/admin/events/PublishTab.tsx": [
    "announced",
    "announced",
    "standing",
    "announced",
    "announced",
  ],
  "src/components/admin/events/QuestionsTab.tsx": [
    "announced",
    "announced",
    "announced",
    "announced",
  ],
  "src/components/admin/events/ResultsTab.tsx": ["announced", "announced", "announced"],
  "src/components/admin/events/ScheduleTab.tsx": ["announced", "standing", "standing"],
  /*
   * Two, both Task 79's (R-217, R-218 / UC-42).
   *
   * In source order: the save error, which is handler state and announced; and
   * UC-42 2a's "this event already has N teams", which is **standing** because
   * it is derived from props alone — the stored shape and the team count the
   * server read — so it is present at first render for any event already set
   * to solo with teams still on it. Announcing it would interrupt every admin
   * who opened the panel on such an event, which is the rule Task 78's own
   * props-derived alert had to follow for the same reason.
   */
  "src/components/admin/events/ShapeTab.tsx": ["announced", "standing"],
  /*
   * Twelve, five of them Task 78's (R-215, R-216 / UC-41).
   *
   * In source order: the list's save error; the format save error; the shuffle
   * error; "the draft has already awarded lots" (UC-41 3b); why the numbers
   * cannot make teams (UC-41 4b); the count error; "will be removed when you
   * save"; the roster error; "the draft has started"; the shuffle confirm's
   * discard warning; and the removal dialog's two branches.
   *
   * The two new `standing` ones are both derived from server props alone —
   * `data.started`, and `planTeams` over the accepted applicants and the
   * stored format — so both are already in the markup when the tab arrives,
   * and an admin opening an event that has not filled up yet must not be
   * interrupted by either. The shuffle confirm's warning is announced for the
   * reason every modal body here is: `Modal` returns null when closed, so it
   * is on the page only because the admin asked for random teams.
   */
  "src/components/admin/events/TeamsTab.tsx": [
    "announced",
    "announced",
    "announced",
    "standing",
    "standing",
    "announced",
    "announced",
    "announced",
    "standing",
    "announced",
    "announced",
    "announced",
  ],
  "src/components/apply/ApplyForm.tsx": ["announced", "announced"],
  "src/components/championship/Season.tsx": ["standing"],
  "src/components/draft/BidCeiling.tsx": ["standing"],
  "src/components/host/HostApplyForm.tsx": ["announced", "standing"],
  "src/components/me/MyEventCard.tsx": ["announced"],
  "src/components/me/NotificationList.tsx": ["announced", "standing", "standing"],
  "src/components/polls/PollList.tsx": ["announced", "announced"],
  "src/components/profile/AvailabilityPanel.tsx": ["announced", "announced"],
  "src/components/profile/ProfileSection.tsx": ["announced"],
  "src/components/suggestions/SuggestionBox.tsx": ["announced", "standing"],
};

describe("every Alert on the site is classified", () => {
  const onDisk = found();

  it("finds every call site, so a matcher that found nothing cannot pass", () => {
    /*
     * 50 files and 117 call sites at the time of writing. Floors rather than
     * equalities, so adding a screen is not a failure on its own — but a parser
     * that has stopped matching is, and that is the failure mode a silent sweep
     * hides. The `<Alert` in `Alert.tsx` itself is a `Record<AlertTone, …>`, not
     * a call site; the task entry's "51 files" counted it.
     */
    const files = Object.keys(onDisk);
    const sites = Object.values(onDisk).reduce((n, b) => n + b.length, 0);
    expect(files.length).toBeGreaterThanOrEqual(50);
    expect(sites).toBeGreaterThanOrEqual(117);
    expect(onDisk["src/components/ui/Alert.tsx"]).toBeUndefined();
  });

  it("has both buckets actually populated, so neither assertion is vacuous", () => {
    // 40 standing and 77 announced today. A bucket that emptied would make every
    // assertion about it pass over nothing, which is how a negative assertion
    // goes quiet on this project.
    const all = Object.values(onDisk).flat();
    expect(all.filter((b) => b === "standing").length).toBeGreaterThanOrEqual(40);
    expect(all.filter((b) => b === "announced").length).toBeGreaterThanOrEqual(77);
  });

  it("leaves no file rendering an Alert out of the inventory", () => {
    /*
     * The half that reports the *unfixed* form. A new screen with an `<Alert>`
     * nobody has thought about appears here as a file the inventory has never
     * heard of, and fails — rather than quietly taking the announcing default
     * and interrupting every visit.
     */
    const unrecorded = Object.keys(onDisk).filter((file) => !(file in CLASSIFIED));
    expect(
      unrecorded,
      "classify each Alert in these files — standing if it can be on the page at " +
        "first render, announced otherwise — and add the file to CLASSIFIED"
    ).toEqual([]);
  });

  it("keeps no file in the inventory that has stopped rendering one", () => {
    // The other direction: a stale entry is an exemption nobody is checking.
    const gone = Object.keys(CLASSIFIED).filter((file) => !(file in onDisk));
    expect(gone, "these are recorded but render no <Alert>; drop them").toEqual([]);
  });

  it("matches the recorded decision at every call site, in source order", () => {
    const offenders: string[] = [];
    for (const [file, want] of Object.entries(CLASSIFIED)) {
      const got = onDisk[file];
      if (!got) continue; // reported by the test above
      if (got.length !== want.length) {
        offenders.push(
          `${file}: ${got.length} <Alert> on disk, ${want.length} recorded — ` +
            `classify the new one and update CLASSIFIED`
        );
        continue;
      }
      got.forEach((bucket, index) => {
        if (bucket !== want[index]) {
          offenders.push(
            `${file}: Alert #${index + 1} is ${bucket} on disk, recorded as ${want[index]}`
          );
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

/* --------------------------------------------------------------------- */
/* The input a refusal is about                                          */
/* --------------------------------------------------------------------- */

/**
 * The three forms the criterion names, and the wiring each one has to carry.
 *
 * Deliberately three and not 117. `aria-invalid` belongs on the control whose
 * value is being refused, and most Alerts on this site are not about one value —
 * "this draft has started, so its rules are fixed" is about a screen.
 *
 * `refusalId` is the *expression* the refusal element carries as its id, matched
 * as text against the attribute that points at it. The whole mechanism is those
 * two strings being equal, and matching them as text is the only way a test can
 * see that they are: a typo in either is invisible on screen, and an
 * `aria-describedby` pointing at an id nothing has is silence that looks like
 * wiring.
 *
 * `refusals` and `controls` are **counts, asserted as equalities, and that is the
 * point.** An earlier draft of this file asked only for "at least one" wired
 * control per file, and the mutation that deleted `describedBy` from
 * `ApplyForm`'s *question* rows escaped it, because the *detail* rows beside
 * them still had theirs and one was enough. `ApplyForm` refuses two kinds of
 * row and both have to say so. An equality also fails when a control is added
 * without the wiring, which is the direction the sweep exists for.
 */
const DESCRIBED: {
  file: string;
  what: string;
  refusalTag: string;
  refusalId: string;
  refusals: number;
  controlTag: string;
  controls: number;
  invalidAttr: string;
  describeAttr: string;
}[] = [
  {
    file: "src/components/admin/TemplatesManager.tsx",
    what: "UC-28 4a — a template name that is empty or already used",
    refusalTag: "Alert",
    refusalId: "NAME_REFUSAL_ID",
    refusals: 1,
    controlTag: "Field",
    // One of this file's many `<Field>`s — the name box on "start from nothing".
    // The rest are the template editor's own settings and no refusal is about
    // them, so this is a count of the wired ones, not of the `<Field>`s.
    controls: 1,
    invalidAttr: "aria-invalid",
    describeAttr: "aria-describedby",
  },
  {
    file: "src/components/admin/AnnouncementSettings.tsx",
    what: "UC-37 3a/3b/3c — a wording with a placeholder that kind does not " +
      "offer, with no words, or over Discord's limit",
    refusalTag: "Alert",
    refusalId: "wordingRefusalId(spec.kind)",
    refusals: 1,
    controlTag: "Textarea",
    controls: 1,
    invalidAttr: "aria-invalid",
    describeAttr: "aria-describedby",
  },
  {
    file: "src/components/apply/ApplyForm.tsx",
    what: "UC-12 — the server's per-row refusals, keyed by field or question id",
    refusalTag: "p",
    refusalId: "answerRefusalId(",
    // Two: a profile detail row and an event question row. The server keys its
    // refusals by field id and by question id and the two maps are kept apart
    // all the way down, so they are two rows and two sentences.
    refusals: 2,
    controlTag: "FieldControl",
    controls: 2,
    // `FieldControl` is a switch over six control shapes, so it takes the two as
    // plain props and puts them on the two branches that render a form control.
    invalidAttr: "invalid",
    describeAttr: "describedBy",
  },
];

describe("the input a refusal is about says so", () => {
  for (const spec of DESCRIBED) {
    describe(spec.file, () => {
      const source = code(path.join(ROOT, spec.file));

      it(`gives every refusal an id (${spec.what})`, () => {
        const carriers = attrsOf(source, spec.refusalTag).filter((attrs) =>
          attrs.includes(`id={${spec.refusalId}`)
        );
        expect(
          carriers.length,
          `<${spec.refusalTag}> elements carrying id={${spec.refusalId}…}`
        ).toBe(spec.refusals);
      });

      it("marks every refused control invalid and points it at that id", () => {
        const controls = attrsOf(source, spec.controlTag);
        expect(controls.length, `no <${spec.controlTag}> in this file`).toBeGreaterThanOrEqual(
          spec.controls
        );

        const quoted = spec.refusalId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const marked = controls.filter((attrs) =>
          new RegExp(`(^|[\\s{])${spec.invalidAttr}=`).test(attrs)
        );
        const pointed = controls.filter((attrs) =>
          new RegExp(`${spec.describeAttr}=\\{[\\s\\S]*?${quoted}`).test(attrs)
        );

        expect(
          marked.length,
          `<${spec.controlTag}> elements taking ${spec.invalidAttr}`
        ).toBe(spec.controls);
        expect(
          pointed.length,
          `<${spec.controlTag}> elements whose ${spec.describeAttr} names ${spec.refusalId}`
        ).toBe(spec.controls);
      });
    });
  }
});

/**
 * The apply form's two props have to arrive somewhere, and this is where.
 *
 * `FieldControl` is one hop further than the other two forms: `ApplyForm` hands
 * it `invalid` and `describedBy`, and it is `FieldControl` that decides which of
 * its six branches those become attributes on. Asserting the call site alone
 * would be the `roles={roles}` failure in miniature — a prop passed correctly
 * into a component that drops it on the floor.
 *
 * So these render it. `select`, `multiselect`, `rank` and `bool` are rows of
 * buttons with no value of their own, so they take no `aria-invalid`; the two
 * that render a real form control do.
 */
function control(type: FieldControlView["type"], over: Record<string, unknown> = {}): string {
  const field: FieldControlView = {
    id: "f1",
    key: "ign",
    label: "In-game name",
    type,
    required: true,
    options: [],
    choices: [],
    value: null,
  };
  return renderToStaticMarkup(
    createElement(FieldControl, {
      field,
      value: null,
      onChange: () => {},
      invalid: true,
      describedBy: "apply-answer-refusal-f1",
      ...over,
    })
  );
}

describe("FieldControl lands the refusal on the control", () => {
  it("marks a text answer invalid and points it at the sentence", () => {
    const rendered = control("text");
    expect(rendered).toContain('aria-invalid="true"');
    expect(rendered).toContain('aria-describedby="apply-answer-refusal-f1"');
  });

  it("marks a number answer invalid and points it at the sentence", () => {
    const rendered = control("number");
    expect(rendered).toContain('aria-invalid="true"');
    expect(rendered).toContain('aria-describedby="apply-answer-refusal-f1"');
  });

  it("puts neither on a control that is not refused", () => {
    // The other half of the pair: an answer the server accepted must not sit
    // there claiming to be invalid for the rest of the session.
    const rendered = control("text", { invalid: false, describedBy: undefined });
    expect(rendered).not.toContain("aria-invalid");
    expect(rendered).not.toContain("aria-describedby");
  });
});

describe("the primitives carry the two attributes through", () => {
  it("Field puts them on the input", () => {
    const rendered = renderToStaticMarkup(
      createElement(Field, {
        value: "",
        onChange: () => {},
        "aria-invalid": true,
        "aria-describedby": "template-name-refusal",
      })
    );
    expect(rendered).toContain('aria-invalid="true"');
    expect(rendered).toContain('aria-describedby="template-name-refusal"');
  });

  it("Stepper puts them on the input and not on the wrapper", () => {
    const rendered = renderToStaticMarkup(
      createElement(Stepper, {
        value: 3,
        onChange: () => {},
        "aria-invalid": true,
        "aria-describedby": "apply-answer-refusal-f1",
      })
    );
    const input = /<input\b[^>]*>/.exec(rendered);
    expect(input, "Stepper no longer renders an input").not.toBeNull();
    expect(input![0]).toContain('aria-invalid="true"');
    expect(input![0]).toContain('aria-describedby="apply-answer-refusal-f1"');
  });
});
