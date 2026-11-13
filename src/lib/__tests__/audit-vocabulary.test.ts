import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, actionLabel, actionTone } from "@/lib/audit";

/**
 * The log's headings, pinned (Task 132).
 *
 * A line on `/admin/audit` is two pieces of text: the heading `actionLabel`
 * gives its action, and the summary that was stored when it happened. The
 * summary is never rebuilt — `src/lib/__tests__/audit.test.ts` proves a stored
 * one survives a rename — but the heading is looked up on every read, so
 * editing one entry of `AUDIT_ACTIONS` rewords every line ever written under
 * it. Nothing failed when that happened. This file is what fails.
 *
 * The table is literal on purpose. A test that read the labels back out of
 * `AUDIT_ACTIONS` would agree with whatever the map says today, which is the
 * one thing a pin must not do. Changing a heading deliberately means changing
 * it here as well, in the same diff, where a reviewer sees both.
 */
const PINNED: Array<[action: string, heading: string]> = [
  ["event.created", "Event created"],
  ["event.status", "Status changed"],
  ["event.published", "Published"],
  ["event.reopened", "Reopened"],
  ["event.basics", "Setup changed"],
  ["event.entryRules", "Entry rules changed"],
  ["event.days", "Days changed"],
  ["event.questions", "Application form changed"],
  ["event.shape", "Event format changed"],
  ["event.roundScoring", "Scoring changed"],
  ["application.decided", "Application decided"],
  ["application.availability", "Applicant's days corrected"],
  ["waiver.granted", "Entry rule waived"],
  ["waiver.revoked", "Entry waiver withdrawn"],
  ["team.set", "Teams changed"],
  ["team.count", "Team count changed"],
  ["team.roster", "Roster changed by hand"],
  ["team.captains", "Captains changed"],
  ["draft.config", "Draft rules changed"],
  ["draft.privacy", "Draft privacy changed"],
  ["draft.pool", "Draft pool changed"],
  ["draft.awarded", "Lot awarded"],
  ["draft.voided", "Lot voided"],
  ["draft.discarded", "Lot discarded"],
  ["result.recorded", "Result recorded"],
  ["result.cleared", "Result cleared"],
  ["result.override", "Winner overturned"],
  ["result.round", "Round scored"],
  ["match.reflip", "Coin re-flipped"],
  ["schedule.applied", "Schedule rebuilt"],
  ["format.stages", "Bracket changed"],
  ["format.generated", "Bracket generated"],
  ["settings.announcements", "Announcements changed"],
  ["settings.guild_gate", "Sign-in gate changed"],
  ["suggestion.status", "Suggestion updated"],
  ["poll.created", "Poll posted"],
  ["poll.updated", "Poll changed"],
  ["poll.closed", "Poll closed"],
  ["poll.deleted", "Poll deleted"],
  ["host.applied", "Host application sent"],
  ["host.approved", "Host application approved"],
  ["host.declined", "Host application declined"],
  ["settings.integrations", "Integrations changed"],
  ["announcement.failed", "Announcement failed"],
  ["announcement.wording_changed", "Announcement wording changed"],
  ["announcement.pings_everyone", "Announcement set to ping everyone"],
  ["announcement.posted_by_hand", "Announcement posted by hand"],
  ["user.admin.granted", "Admin granted"],
  ["user.admin.revoked", "Admin revoked"],
  ["user.sessions.ended", "Sessions ended"],
  ["user.note", "Note added"],
  ["template.created", "Template created"],
  ["template.updated", "Template changed"],
  ["template.duplicated", "Template duplicated"],
  ["template.from_event", "Template made from an event"],
  ["template.activated", "Template activated"],
  ["template.deactivated", "Template deactivated"],
  ["template.moved", "Templates reordered"],
  ["template.deleted", "Template deleted"],
  ["championship.created", "Championship created"],
  ["championship.updated", "Championship changed"],
  ["championship.status", "Championship status changed"],
  ["championship.reopened", "Championship reopened"],
  ["championship.event.added", "Event counts towards a championship"],
  ["championship.event.changed", "Counting event changed"],
  ["championship.event.removed", "Event stopped counting"],
  ["championship.result", "Championship result recorded"],
  ["hero.added", "Hero added"],
  ["hero.renamed", "Hero renamed"],
  ["hero.roles", "Hero roles changed"],
  ["hero.retired", "Hero retired"],
  ["hero.restored", "Hero brought back"],
];

/** Written by existing code all along, and given a heading by Task 132. */
const NEWLY_NAMED: Array<[action: string, heading: string]> = [
  ["event.format", "Night format changed"],
  ["team.random", "Teams shuffled"],
  ["draft.bid_cleared", "Bid cleared"],
];

/** The profile questions, which wrote no line at all before Task 132. */
const QUESTIONS: Array<[action: string, heading: string]> = [
  ["field.added", "Question added"],
  ["field.updated", "Question changed"],
  ["field.retired", "Question retired"],
  ["field.deleted", "Question deleted"],
];

describe("the headings the log already had", () => {
  it.each(PINNED)("%s still reads “%s”", (action, heading) => {
    expect(actionLabel(action)).toBe(heading);
  });
});

describe("the pin covers the whole vocabulary", () => {
  it("has a row in this file for every action the log knows, and no row for one it does not", () => {
    /*
     * The other direction. The rows above catch a heading that is reworded,
     * but only for actions somebody remembered to list: an action added to
     * `AUDIT_ACTIONS` later, and reworded later still, would change every line
     * written under it with nothing failing. This is what makes adding one a
     * two-file change — the heading goes in a table here in the same diff, and
     * from then on it is pinned like the rest.
     */
    const pinned = [...PINNED, ...NEWLY_NAMED, ...QUESTIONS].map(([action]) => action);

    expect(Object.keys(AUDIT_ACTIONS).sort()).toEqual(pinned.sort());
  });
});

describe("three actions that were written but never named", () => {
  /*
   * `draft-actions.ts` and the draft room have been writing these all along.
   * `actionLabel` falls back to the raw string, so every such line was on the
   * page headed "team.random" — legible to whoever wrote the code and nobody
   * else.
   */
  it.each(NEWLY_NAMED)("%s reads “%s”", (action, heading) => {
    expect(AUDIT_ACTIONS).toHaveProperty([action]);
    expect(actionLabel(action)).toBe(heading);
  });

  it("does not give the night's format the heading the event's shape or the bracket has", () => {
    // Three rows a reader tells apart by heading alone: 6v6 or 3v3, teams or
    // not, and the stages.
    expect(actionLabel("event.format")).not.toBe(actionLabel("event.shape"));
    expect(actionLabel("event.format")).not.toBe(actionLabel("format.stages"));
  });
});

describe("the profile questions in the log's vocabulary", () => {
  it.each(QUESTIONS)("%s reads “%s”", (action, heading) => {
    expect(AUDIT_ACTIONS).toHaveProperty([action]);
    expect(actionLabel(action)).toBe(heading);
  });

  it("marks a deleted question as something taken away", () => {
    expect(actionTone("field.deleted")).toBe("flare");
  });

  it.each(["field.added", "field.updated", "field.retired"])(
    "does not mark %s that way — nothing is lost by it",
    (action) => {
      expect(actionTone(action)).toBe("muted");
    }
  );
});
