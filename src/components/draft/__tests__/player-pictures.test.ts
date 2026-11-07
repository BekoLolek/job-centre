import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PlayerChip from "../PlayerChip";
import { playerAvatar } from "../types";
import type { PlayerBook } from "../types";

/*
 * R-252: a roster reads like the people in it.
 *
 * `playerAvatar` is the third reader of the `PlayerBook`, beside `playerName`
 * and `playerHref`, and it has the same two honest answers for a person the
 * book cannot picture: `null` for an id it does not hold, and `null` for a
 * member whose Discord has no picture on file. Both go to `Avatar`, which
 * draws initials for either — so the contract pinned here is "a URL or null,
 * never a name and never undefined": `src="Ash"` draws a broken picture until
 * `onError` catches it, and `undefined` is `playerHref`'s "nothing" said a
 * second way, which a caller should not have to know.
 *
 * The ids below are deliberately unrelated to the names. A fixture whose ids
 * track its names (`"ash": { displayName: "Ash" }`) once let a helper that
 * returned the key instead of the field pass every test; `u-7f3a` cannot be
 * mistaken for anybody's name or picture.
 */

const PICTURE = "https://cdn.discordapp.com/avatars/114960173/a1b2c3.png";

const players: PlayerBook = {
  "u-7f3a": { displayName: "Ash", avatarUrl: PICTURE },
  "u-c21d": { displayName: "Nova", avatarUrl: null },
  "u-9e04": { displayName: "Juno" },
};

describe("playerAvatar", () => {
  it("returns the picture for a member the book holds", () => {
    expect(playerAvatar(players, "u-7f3a")).toBe(PICTURE);
  });

  it("returns null for an id the book does not hold", () => {
    expect(playerAvatar(players, "u-gone")).toBeNull();
  });

  it("returns null for a member whose picture is null", () => {
    expect(playerAvatar(players, "u-c21d")).toBeNull();
  });

  it("returns null, not undefined, for a member the book never pictured", () => {
    expect(playerAvatar(players, "u-9e04")).toBeNull();
  });

  it("returns null for no id at all", () => {
    expect(playerAvatar(players, null)).toBeNull();
    expect(playerAvatar(players, undefined)).toBeNull();
  });
});

describe("PlayerChip", () => {
  it("draws the picture it is handed", () => {
    const html = renderToStaticMarkup(
      createElement(PlayerChip, { name: "Ash Ketchum", avatarUrl: PICTURE })
    );
    expect(html).toContain(`<img src="${PICTURE}"`);
    expect(html).not.toContain(">AK<");
  });

  it("draws initials when it is handed no picture", () => {
    const html = renderToStaticMarkup(
      createElement(PlayerChip, { name: "Ash Ketchum", avatarUrl: null })
    );
    expect(html).not.toContain("<img");
    expect(html).toContain(">AK<");
  });
});
