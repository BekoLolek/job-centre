/**
 * "With 3 slots left, the most Rivals Red can bid is 897."
 *
 * §9's must-fill-your-roster rule is one checkbox and it silently changes every
 * number on the board. A captain who has not seen it stated in money finds out
 * what it does the first time a bid is refused, at the worst possible moment,
 * and concludes the board is broken. So the admin screen shows the consequence
 * while the setting is still being chosen, and the room shows it while there is
 * still time to bid differently.
 *
 * Nothing is recomputed here. `rosterState` and `maxBidFor` are
 * `src/lib/draft-policy.ts`'s, unchanged — this only calls them against a
 * config the admin has not saved yet and puts the answer into a sentence. That
 * matters more than it sounds: the figure on screen has to be the same figure
 * `canPlaceBid` will use, and the only way to be sure of that is for it to come
 * from the same function.
 */

import {
  type DraftConfig,
  type RosterState,
  maxBidFor,
  rosterState,
} from "@/lib/draft-policy";
import { formatMoney } from "./money";
import type { TeamLike } from "./types";

export type Ceiling = {
  roster: RosterState;
  /** The most this team may bid on the next lot, under `config`. */
  max: number;
  balance: number;
  /** One sentence saying what the rule costs them, ready to render. */
  sentence: string;
  /**
   * True when the must-fill rule has left them unable to meet the minimum bid
   * at all — they are still owed players and cannot legally buy one. An admin
   * wants to know that *before* the draft starts, not during it.
   */
  stuck: boolean;
};

/**
 * What one team may spend under one set of rules — including rules that are
 * still being typed.
 *
 * The roster is re-derived from `config` rather than read off the team, because
 * the team's own `roster` was computed against whatever was last *saved* and
 * this is asked while the admin is dragging the roster size around.
 */
export function ceilingFor(team: TeamLike, config: DraftConfig): Ceiling {
  const roster = rosterState(team, team.members, config);
  const max = maxBidFor(team, config, roster);

  return {
    roster,
    max,
    balance: team.balance,
    sentence: ceilingSentence(team.name, team.balance, max, roster, config),
    stuck: roster.slotsLeft > 0 && max < config.minBid,
  };
}

/** Every team, under one config. The Draft tab's live readout. */
export function ceilingsFor(
  teams: readonly TeamLike[],
  config: DraftConfig
): Array<Ceiling & { team: TeamLike }> {
  return teams.map((team) => ({ team, ...ceilingFor(team, config) }));
}

function slots(count: number): string {
  return `${count} ${count === 1 ? "slot" : "slots"}`;
}

/**
 * The sentence itself.
 *
 * Four cases, and they are genuinely different situations rather than one
 * situation with different numbers in it, which is why none of them is phrased
 * as a template of the others:
 *
 *  - a full roster is not a small ceiling, it is no ceiling at all;
 *  - with the rule off the ceiling *is* the balance, and saying so is how an
 *    admin sees that switching it off changed something;
 *  - the last slot has nothing left to keep back for, so the rule costs
 *    nothing there and pretending otherwise would be a lie;
 *  - and the interesting case names both figures, because "897" without "3
 *    stays back" is a number nobody can check.
 */
function ceilingSentence(
  name: string,
  balance: number,
  max: number,
  roster: RosterState,
  config: DraftConfig
): string {
  if (roster.slotsLeft <= 0) {
    return `${name} is full at ${roster.target} — nothing left to buy.`;
  }
  if (!config.mustFillRoster) {
    return `With ${slots(roster.slotsLeft)} left, ${name} can bid the whole ${formatMoney(
      balance
    )}.`;
  }
  if (roster.slotsLeft === 1) {
    return `One slot left, so ${name} can bid the whole ${formatMoney(
      balance
    )} on it.`;
  }
  return (
    `With ${slots(roster.slotsLeft)} left, the most ${name} can bid is ` +
    `${formatMoney(max)} — ${formatMoney(roster.reserved)} stays back to fill the ` +
    `other ${slots(roster.slotsLeft - 1)}.`
  );
}
