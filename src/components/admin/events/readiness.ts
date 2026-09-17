// Straight from the module rather than the kit's barrel: that barrel re-exports
// client components, and this file has to stay importable from a plain test.
import { plural } from "@/components/ui/plural";
import type { EventDetail } from "@/lib/events";
import { missingToPublish, rankMeetsMinimum } from "@/lib/events-policy";

/**
 * Is this event ready to publish, and if not, what does each gap mean?
 *
 * A pure function of the event, kept out of the tab that renders it for two
 * reasons: what the screen claims is then exactly what the data says, and the
 * awkward combinations — a rank threshold on a game whose ladder no longer has
 * it, a signup window that closes before it opens — are cheap to test.
 *
 * ## Mostly advice, with the publish gate marked
 *
 * Publishing is refused without a name, at least one day with a start time and
 * a sign-up window (UC-09 2a) — `missingToPublish` decides that, on the server
 * and here alike, so those three are `stop`. So are the two states that would
 * make the event *impossible to apply to*. Everything else is `warn` (R-117): an
 * event with no questions is a perfectly good "just turn up" night, so the
 * checklist explains the consequence and lets the manager decide.
 */

export type ReadinessLevel =
  /** Ready. */
  | "ok"
  /** A gap worth knowing about, which does not stop publishing. */
  | "warn"
  /** Publishing is refused, or would produce an event nobody could apply to. */
  | "stop";

export type ReadinessCheck = {
  key: string;
  label: string;
  level: ReadinessLevel;
  detail: string;
};

export function readiness(event: EventDetail): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const missing = missingToPublish(event);

  /* --- the title ---------------------------------------------------- */
  checks.push(
    !missing.includes("name")
      ? {
          key: "title",
          label: "It has a title",
          level: "ok",
          detail: `“${event.title}” at /events/${event.slug}`,
        }
      : {
          key: "title",
          label: "It needs a title",
          level: "stop",
          detail: "Publishing is refused without one.",
        }
  );

  /* --- days --------------------------------------------------------- */
  checks.push(
    !missing.includes("day")
      ? {
          key: "days",
          label: plural(event.days.length, "day"),
          level: "ok",
          detail: "Applicants will be asked which of them they can make.",
        }
      : {
          key: "days",
          label: "It needs a day with a start time",
          level: "stop",
          detail: "Publishing is refused until at least one day has a start time. Add it under Setup → Days.",
        }
  );

  /* --- the form ----------------------------------------------------- */
  if (event.questions.length === 0) {
    checks.push({
      key: "questions",
      label: "No questions",
      level: "warn",
      detail: "Applying is one click, which is a perfectly good form for a casual night.",
    });
  } else {
    const linked = event.questions.filter(
      (question) => question.profileFieldId !== null
    ).length;
    checks.push({
      key: "questions",
      label: `${plural(event.questions.length, "question")} on the form`,
      level: "ok",
      detail:
        linked > 0
          ? `${linked} of them prefill from the member's profile, so a returning player barely types.`
          : "None of them prefill from a profile — worth linking the ones you already ask on /me/profile.",
    });
  }

  /* --- capacity ------------------------------------------------------ */
  if (event.capacity === null) {
    checks.push({
      key: "capacity",
      label: "No capacity",
      level: "warn",
      detail: "Uncapped: everybody who applies is accepted and there is never a waitlist.",
    });
  } else if (!Number.isInteger(event.capacity) || event.capacity < 1) {
    checks.push({
      key: "capacity",
      label: "Capacity is not a number of seats",
      level: "stop",
      detail: "It has to be at least one, or empty for unlimited.",
    });
  } else {
    checks.push({
      key: "capacity",
      label: plural(event.capacity, "seat"),
      level: "ok",
      detail:
        event.config.waitlist === false
          ? "The waitlist is off, so the event closes once they are gone."
          : "Applications past that join the waitlist.",
    });
  }

  /* --- the signup window --------------------------------------------- */
  const opens = event.signupOpensAt;
  const closes = event.signupClosesAt;
  const starts = event.startsAt;

  if (missing.includes("window")) {
    checks.push({
      key: "window",
      label: "It needs a sign-up window",
      level: "stop",
      detail: "Publishing is refused until sign-ups have an opening and a closing time. Set them under Setup → Basics.",
    });
  } else if (opens && closes && closes.getTime() < opens.getTime()) {
    checks.push({
      key: "window",
      label: "Signups close before they open",
      level: "stop",
      detail: "Nobody could ever apply. Fix it under Setup → Basics.",
    });
  } else if (opens && starts && starts.getTime() < opens.getTime()) {
    checks.push({
      key: "window",
      label: "Signups open after the event starts",
      level: "stop",
      detail: "Nobody could ever apply. Fix it under Setup → Basics.",
    });
  } else if (!starts) {
    checks.push({
      key: "window",
      label: "No start date",
      level: "warn",
      detail:
        "The event will not sort into what is coming up, and applications will never close on their own.",
    });
  } else {
    checks.push({
      key: "window",
      label: "The signup window makes sense",
      level: "ok",
      detail: "Applications close when the window does, or when the event starts.",
    });
  }

  /* --- entry rules (§8.3) --------------------------------------------- */
  const thresholds = [event.minRankToEnter, event.minRankToCaptain].filter(
    (rank): rank is string => Boolean(rank)
  );

  if (thresholds.length === 0) {
    checks.push({
      key: "rules",
      label: "No rank requirement",
      level: "ok",
      detail: "Anybody can enter, and anybody can captain.",
    });
  } else if (!event.game || event.rankLadder.length === 0) {
    checks.push({
      key: "rules",
      label: "Rank requirements with no ladder to read them against",
      level: "warn",
      detail:
        "They will not be enforced. Pick a game with a rank ladder, or clear them under Setup → Entry rules.",
    });
  } else {
    const stale = thresholds.filter(
      (rank) => rankMeetsMinimum(null, rank, event.rankLadder).reason === "minimum_unknown"
    );
    checks.push(
      stale.length === 0
        ? {
            key: "rules",
            label: "Rank requirements are valid",
            level: "ok",
            detail: [
              event.minRankToEnter && `${event.minRankToEnter} to enter`,
              event.minRankToCaptain && `${event.minRankToCaptain} to captain`,
            ]
              .filter(Boolean)
              .join(" · "),
          }
        : {
            key: "rules",
            label: "A rank requirement is not in the ladder any more",
            level: "warn",
            detail: `${stale.join(", ")} — not enforced, so everybody clears it. Pick a current rank under Setup → Entry rules.`,
          }
    );
  }

  /* --- a rank question needs a ladder too ------------------------------ */
  const rankQuestions = event.questions.filter((question) => question.type === "rank");
  if (rankQuestions.length > 0 && event.rankLadder.length === 0) {
    checks.push({
      key: "rank-questions",
      label: "A rank question with no ladder behind it",
      level: "warn",
      detail: "It will offer nothing to pick. Give the event a game that has ranks.",
    });
  }

  return checks;
}

/** The checks that stop the publish button working. */
export function blockers(checks: readonly ReadinessCheck[]): ReadinessCheck[] {
  return checks.filter((check) => check.level === "stop");
}

/** The checks worth reading before publishing, which do not stop it. */
export function gaps(checks: readonly ReadinessCheck[]): ReadinessCheck[] {
  return checks.filter((check) => check.level === "warn");
}
