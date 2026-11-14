/**
 * The admin area's sections, and which of them a member's powers reach (R-265 /
 * UC-56 2).
 *
 * No `"use client"` and no database, on purpose. The bar (`AdminNavLinks`) and
 * the account menu (`NavMenu`) are client components, and the server
 * components that feed them (`AdminNav`, `SessionNav`) have to ask the same
 * question - a function exported from a client module reaches a server
 * component as a reference it cannot call. `announcement-posting.ts` beside
 * this file is split from its component for the same reason.
 *
 * ## This is presentation, and presentation is not protection
 *
 * Nothing here stops anybody. Each page under `/admin` awaits its own guard on
 * its first line and each action awaits its own; this list only decides which
 * links are drawn, so that a holder is not offered a screen that will turn
 * them away. `src/app/admin/__tests__/holder-pages.test.ts` asks the pages,
 * with its own hand-written table, so a mistake here cannot be agreed with
 * there.
 */

import { type Holder, POWERS, type Power, holds } from "@/lib/permissions-policy";

export type AdminSection = {
  href: string;
  label: string;
  /** `/admin` is a prefix of every other href, so it alone is lit by an exact match. */
  exact?: true;
  /**
   * Who the link is drawn for, beside an admin, who is drawn all of them:
   *  - a list: a holder of any one of these powers;
   *  - `"any power"`: a holder of any area power - see {@link AREA_POWERS};
   *  - `"admin"`: nobody else. The page is on the admin flag (R-264).
   */
  reach: readonly Power[] | "any power" | "admin";
};

/**
 * Exported so the list itself can be tested: which pages the admin area admits
 * to having is a fact about the product (UC-07 1), and it has nothing to do
 * with rendering.
 */
export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { href: "/admin", label: "Tonight", exact: true, reach: "any power" },
  // Where an event is made as well as where one is found, so either power.
  { href: "/admin/events", label: "Events", reach: ["events.create", "events.manage"] },
  { href: "/admin/championships", label: "Seasons", reach: ["championships.manage"] },
  { href: "/admin/availability", label: "Availability", reach: ["members.read"] },
  { href: "/admin/host", label: "Hosts", reach: ["hosts.approve"] },
  { href: "/admin/templates", label: "Templates", reach: ["templates.manage"] },
  { href: "/admin/games", label: "Games", reach: ["games.manage"] },
  // The screen that gives and takes the admin flag. No power reaches it.
  { href: "/admin/users", label: "Members", reach: "admin" },
  // R-247 / UC-48 1. Beside Members and Audit, as it always was.
  { href: "/admin/hands", label: "Hands", reach: ["members.read"] },
  { href: "/admin/audit", label: "Audit", reach: ["audit.read"] },
  { href: "/admin/settings", label: "Settings", reach: ["settings.announcements", "settings.integrations"] },
];

/**
 * The powers that are a way into the admin area: every one but `destructive`.
 *
 * `destructive` is the modifier - "required in addition to the area's power"
 * (docs/plan.md, section T) - and reaches nothing by itself. A member holding
 * it and nothing else has no screen to be let into, so it is not among the
 * powers `/admin` asks about, and holding it draws no link. It must not be
 * read anywhere as a grant of access.
 *
 * This is the list `/admin` hands `requireAnyPermission`.
 */
export const AREA_POWERS: readonly Power[] = POWERS.filter((power) => power !== "destructive");

/**
 * Does this member hold anything that lets them into the admin area at all?
 *
 * An admin does; so does anybody with one area power on their list, whichever
 * it is (UC-56 1). A member with none does not (UC-56 2a), and nor does one
 * holding only the modifier.
 */
export function reachesAdminArea(holder: Holder): boolean {
  return holder.isAdmin || AREA_POWERS.some((power) => holder.powers.has(power));
}

/** The sections this member is shown, in the order the bar draws them. */
export function sectionsFor(holder: Holder): AdminSection[] {
  return ADMIN_SECTIONS.filter(({ reach }) => {
    if (holder.isAdmin) return true;
    if (reach === "admin") return false;
    if (reach === "any power") return reachesAdminArea(holder);
    return reach.some((power) => holds(holder, power));
  });
}
