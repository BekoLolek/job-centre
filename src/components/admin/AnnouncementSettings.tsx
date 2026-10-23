"use client";

/**
 * The Discord announcements screen (§14, checklist.md F2) — switches, wording,
 * mentions and a preview (R-201, R-202, R-203, R-204 / UC-37).
 *
 * ## Shape
 *
 * One row per kind, collapsed. The row is what Task 59 shipped — the label, the
 * detail line and the on/off switch — plus two facts an admin now needs at a
 * glance: whether the wording is the site's own or theirs, and who it mentions.
 * Open a row and it grows the editor: the wording, the placeholders that kind
 * offers, the mention picker and the preview.
 *
 * Collapsed by default, and one at a time. Eight kinds, each with a textarea, a
 * placeholder list, a mention picker and a rendered payload, is four screens of
 * scroll before you reach the save button — and the switch, which is the thing
 * most visits to this screen come for, would be below all of it. `?kind=` opens
 * one directly, which is what the audit log's "the event_published announcement
 * was edited" should be able to link to.
 *
 * ## Two saves, and why they are not one
 *
 * The switches save together, for the reason Task 59 wrote down: the setting
 * *is* one row holding one object, and a write per switch is that many chances
 * for two tabs to disagree about the others. The wording is the opposite — one
 * row per kind, each with its own `version`, because UC-37 7a's "somebody else
 * changed this while you were editing it" is a question about *this* kind and
 * answering it for all eight at once would refuse seven innocent edits. So the
 * wording saves per kind, against the version its editor was opened at.
 *
 * ## The preview is the payload
 *
 * Every pixel of the preview comes from the `DiscordMessage` that the kind's
 * own builder in `@/lib/announce` returned — the same function, with the same
 * template argument, that `deliver` posts. Nothing here renders a placeholder,
 * clamps a string, or assembles a mention line: see {@link previewPayload},
 * which is six calls and no third thing. A preview built by a second code path
 * is a preview that lies, and the payload is printed verbatim underneath so the
 * claim can be checked by eye as well as by test.
 *
 * It sends nothing. The builders are pure — that is the whole reason
 * `./announce` is a separate module from `./discord` — so there is nothing on
 * this path that could.
 *
 * ## Example values
 *
 * There is no event being previewed, so every value in the preview is the
 * placeholder's declared `example` from `ANNOUNCEMENT_PLACEHOLDERS`, parsed
 * back into the shape the builder wants (UC-37 5a). That is deliberate rather
 * than convenient: the example an admin reads in the placeholder list is the
 * same string the preview is built from, so the two cannot drift. And it is why
 * the preview says so in as many words — a preview of invented data that does
 * not admit it is worse than no preview.
 */

import { useState, useTransition } from "react";
import {
  type AnnouncementKind,
  type AnnouncementMention,
  type AnnouncementSettings as Settings,
  type AnnouncementSpec,
  type AnnouncementTemplate,
  type ApplicationDecidedInput,
  CLOSING_SOON_FULLNESS,
  DISCORD_LIMITS,
  type DiscordEmbed,
  type DiscordMessage,
  type EventPublishedInput,
  type EventStartingSoonInput,
  type LotSoldInput,
  type MatchResultInput,
  type SignupsClosingSoonInput,
  type SignupsOpenInput,
  type StandingsInput,
  announcementTemplateProblem,
  applicationDecidedMessage,
  eventPublishedMessage,
  eventStartingSoonMessage,
  lotSoldMessage,
  matchResultMessage,
  mentionLine,
  placeholdersFor,
  signupsClosingSoonMessage,
  signupsOpenMessage,
  standingsMessage,
} from "@/lib/announce";
// Type only. `@/lib/discord` reaches for `next/server`, and nothing in it runs
// in a browser; the shape of a stored row is all this screen needs from it.
import type { StoredAnnouncementTemplate } from "@/lib/discord";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Disclosure,
  Eyebrow,
  Field,
  Panel,
  Section,
  Textarea,
  Toggle,
} from "@/components/ui";
import {
  saveAnnouncementSettingsAction,
  saveAnnouncementTemplateAction,
} from "@/app/admin/settings/actions";

/* ------------------------------------------------------------------ */
/* The kinds nothing posts yet                                        */
/* ------------------------------------------------------------------ */

/**
 * Kinds whose wording is stored, whose switch works, and which **nothing in
 * the site posts** (R-205, Task 68).
 *
 * All three scheduled kinds are wording, vocabulary and a switch, and no call
 * site: applications opening, closing soon and an event starting are *clock*
 * events, and the site has nothing that wakes up on a clock to post them yet.
 * That is recorded in `./announce`'s own module comment rather than being an
 * oversight, and this screen's job is to not quietly present them as live: an
 * admin who turns one on and waits for a message is an admin who will go
 * looking for a broken webhook.
 *
 * Declared here rather than on `AnnouncementSpec` because it is a fact about
 * the *site*, not about the setting — `ANNOUNCEMENTS` is the vocabulary, and a
 * `wired: false` field on it would be a second thing to forget when the
 * trigger is wired up. `announcement-wording.test.ts` holds the list against
 * the builders `src/lib/discord.ts` actually imports, so wiring one and
 * leaving this behind fails the suite, which is the point of it.
 */
export const NOT_POSTED_YET: readonly AnnouncementKind[] = [];

/**
 * Whether anything in the site posts this kind today.
 *
 * The set is an argument with the constant as its default, rather than only the
 * constant, because the screen's job is to *say* what it is told and the fact
 * belongs to the deployment. It also keeps the saying testable when the list
 * happens to be empty: the warning below is the whole reason this exists, and a
 * branch that can only be reached by editing a constant is a branch nobody can
 * prove still works.
 */
export function posted(
  kind: AnnouncementKind,
  notPosted: readonly AnnouncementKind[] = NOT_POSTED_YET
): boolean {
  return !notPosted.includes(kind);
}

/* ------------------------------------------------------------------ */
/* Example values for the preview (UC-37 5a)                          */
/* ------------------------------------------------------------------ */

/**
 * The slug the example event is linked by.
 *
 * A word nobody could mistake for a real event, because it lands in the
 * preview's URL where the only other honest option would be a real slug this
 * screen has not been given.
 */
export const EXAMPLE_SLUG = "example";

/** One placeholder's declared `example`, or the empty string if it has none. */
function declared(kind: AnnouncementKind, name: string): string {
  return placeholdersFor(kind).find((placeholder) => placeholder.name === name)?.example ?? "";
}

/**
 * A declared example that is a Discord stamp, back as the instant inside it.
 *
 * `{starts}` and `{closes}` are declared as `<t:1800000000:F>` because that is
 * what they *render* as — no message this site builds contains a date the
 * server formatted. The builder wants the `Date`, so the seconds come back out
 * of the declaration rather than being written down a second time beside it.
 */
function declaredInstant(kind: AnnouncementKind, name: string): Date | null {
  const found = /^<t:(\d+):/.exec(declared(kind, name));
  return found ? new Date(Number(found[1]) * 1000) : null;
}

/** A declared example that is a number, with its thousands separator taken off. */
function declaredNumber(kind: AnnouncementKind, name: string): number {
  const digits = declared(kind, name).replace(/[^0-9]/g, "");
  return digits ? Number(digits) : 0;
}

/** An event an admin could be previewing, built from `event_published`'s examples. */
export function exampleEventPublished(origin: string | null): EventPublishedInput {
  return {
    title: declared("event_published", "title"),
    slug: EXAMPLE_SLUG,
    capacity: declaredNumber("event_published", "places"),
    startsAt: declaredInstant("event_published", "starts"),
    signupClosesAt: declaredInstant("event_published", "closes"),
    /*
     * Neither `signupOpensAt` nor `publishedAt`, which is the commoner of this
     * kind's two cases: an event published into an open window, posting the
     * three fields it has always posted and the one sentence R-201 pinned.
     * Previewing the early-published case would need an opening instant that no
     * placeholder declares (Task 67 deliberately added no `{opens}`), so the
     * preview would be inventing a fact rather than showing a declared one.
     */
    origin,
  };
}

/** The same four facts at the other moment — `signups_open`'s own examples. */
export function exampleSignupsOpen(origin: string | null): SignupsOpenInput {
  return {
    title: declared("signups_open", "title"),
    slug: EXAMPLE_SLUG,
    capacity: declaredNumber("signups_open", "places"),
    startsAt: declaredInstant("signups_open", "starts"),
    signupClosesAt: declaredInstant("signups_open", "closes"),
    origin,
  };
}

/**
 * Applications close tomorrow.
 *
 * `closes` is a **string**, not a `Date` — this builder takes the Discord
 * markup already rendered, which is exactly the shape a declared example is in,
 * so the example goes straight through with nothing parsed out of it and
 * nothing put back.
 *
 * `{full}` is a boolean on the input and two declared sentences on the way out,
 * so the example is read back the one honest way: the preview is of a full
 * event precisely when the declaration says `{full}`'s example is the full one.
 * A `true` written here instead would be this screen deciding which sentence an
 * admin sees an example of.
 */
export function exampleSignupsClosingSoon(origin: string | null): SignupsClosingSoonInput {
  return {
    title: declared("signups_closing_soon", "title"),
    slug: EXAMPLE_SLUG,
    closes: declared("signups_closing_soon", "closes"),
    capacity: declaredNumber("signups_closing_soon", "places"),
    full: declared("signups_closing_soon", "full") === CLOSING_SOON_FULLNESS.full,
    origin,
  };
}

/** Two hours to go. `starts` is markup already, for the same reason as `closes`. */
export function exampleEventStartingSoon(origin: string | null): EventStartingSoonInput {
  return {
    title: declared("event_starting_soon", "title"),
    slug: EXAMPLE_SLUG,
    starts: declared("event_starting_soon", "starts"),
    origin,
  };
}

/**
 * An application decision.
 *
 * The queue number is passed **only** for `application_waitlisted`, because
 * `{position}` is the one kind's fact and the other two refuse it at save time.
 * Reading it from the placeholder table rather than from a constant is what
 * keeps that true without a second list to maintain.
 */
export function exampleApplicationDecided(
  kind: "application_accepted" | "application_waitlisted" | "application_declined",
  origin: string | null
): ApplicationDecidedInput {
  return {
    member: declared(kind, "member"),
    eventTitle: declared(kind, "event"),
    slug: EXAMPLE_SLUG,
    waitlistPosition:
      kind === "application_waitlisted" ? declaredNumber(kind, "position") : null,
    origin,
  };
}

/** A lot settling. The declared price carries a separator; the builder wants the number. */
export function exampleLotSold(origin: string | null): LotSoldInput {
  return {
    player: declared("draft_lot_sold", "player"),
    team: declared("draft_lot_sold", "team"),
    price: declaredNumber("draft_lot_sold", "price"),
    eventTitle: declared("draft_lot_sold", "event"),
    slug: EXAMPLE_SLUG,
    origin,
  };
}

/** A decided series. `{score}` is declared as a scoreline, so the games come out of it. */
export function exampleMatchResult(origin: string | null): MatchResultInput {
  const games = declared("match_result", "score")
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  return {
    label: declared("match_result", "match"),
    teamA: declared("match_result", "teamA"),
    teamB: declared("match_result", "teamB"),
    gamesWonA: games[0] ?? 0,
    gamesWonB: games[1] ?? 0,
    winner: declared("match_result", "winner"),
    eventTitle: declared("match_result", "event"),
    slug: EXAMPLE_SLUG,
    origin,
  };
}

/**
 * The rivals under the example leader.
 *
 * `{leader}` is declared, and these two are not — the other places are embed
 * *fields* rather than placeholder values, so there is nothing in
 * `ANNOUNCEMENT_PLACEHOLDERS` to read them from. A one-row table would preview
 * a shape this message never has, so two example rivals are written down here,
 * named as examples, and the preview says every value in it is one.
 */
const EXAMPLE_RIVALS: readonly { name: string; points: number }[] = [
  { name: "Ada", points: 24 },
  { name: "Mo", points: 21 },
];

/** A season whose table has just moved, with the declared leader at the top of it. */
export function exampleStandings(origin: string | null): StandingsInput {
  return {
    seasonName: declared("standings_changed", "season"),
    slug: EXAMPLE_SLUG,
    eventTitle: declared("standings_changed", "event"),
    top: {
      // `changed` is the sentence an admin is most likely to be editing: the
      // first standings of a season and a held lead are the same three fields
      // with a different verb, and `unknown` is a case about a late-recorded
      // result rather than about wording.
      lead: "changed",
      rows: [
        {
          userId: "example-leader",
          name: declared("standings_changed", "leader"),
          position: 1,
          points: 30,
          level: false,
          moved: 1,
        },
        ...EXAMPLE_RIVALS.map((rival, index) => ({
          userId: `example-rival-${index}`,
          name: rival.name,
          position: index + 2,
          points: rival.points,
          level: false,
          moved: 0,
        })),
      ],
    },
    origin,
  };
}

/**
 * **The payload. The real one.**
 *
 * Six builders, one per shape of input, called with the admin's template
 * exactly as `deliver`'s call sites call them. There is no seventh branch that
 * renders a sentence, fills a placeholder, clamps a length or joins a mention
 * line — all of that is `message()`'s, inside `./announce`, and it happens here
 * because this function calls the same code the webhook does.
 *
 * R-204 is "renders the real payload and sends nothing", and this is both
 * halves: the builders are pure, so the second half is not a promise anybody
 * has to keep, it is a property of the module being called.
 */
export function previewPayload(
  kind: AnnouncementKind,
  template: AnnouncementTemplate,
  origin: string | null
): DiscordMessage {
  switch (kind) {
    case "event_published":
      return eventPublishedMessage(exampleEventPublished(origin), template);
    case "signups_open":
      return signupsOpenMessage(exampleSignupsOpen(origin), template);
    case "signups_closing_soon":
      return signupsClosingSoonMessage(exampleSignupsClosingSoon(origin), template);
    case "event_starting_soon":
      return eventStartingSoonMessage(exampleEventStartingSoon(origin), template);
    case "application_accepted":
    case "application_waitlisted":
    case "application_declined":
      return applicationDecidedMessage(
        kind,
        exampleApplicationDecided(kind, origin),
        template
      );
    case "draft_lot_sold":
      return lotSoldMessage(exampleLotSold(origin), template);
    case "match_result":
      return matchResultMessage(exampleMatchResult(origin), template);
    case "standings_changed":
      return standingsMessage(exampleStandings(origin), template);
  }
}

/* ------------------------------------------------------------------ */
/* The screen                                                         */
/* ------------------------------------------------------------------ */

export type AnnouncementSettingsProps = {
  specs: readonly AnnouncementSpec[];
  saved: Settings;
  /** Whether a webhook is in force, from settings or the deployment. Never the value. */
  configured: boolean;
  /** Every kind's stored wording, edited or not — `getAnnouncementTemplates`'s answer. */
  templates: Record<AnnouncementKind, StoredAnnouncementTemplate>;
  /**
   * The site address in force, so a preview carries the link the post will.
   * Null is a real state — an install that has never set one posts no link —
   * and the preview shows that rather than inventing a host.
   */
  origin: string | null;
  /** `?kind=` — the row to open on arrival. */
  openKind?: AnnouncementKind | null;
  /**
   * Kinds nothing in the site posts yet. {@link NOT_POSTED_YET} by default.
   *
   * A prop, because it is a fact about the deployment rather than about the
   * setting, and because the warning it drives is the one piece of this screen
   * that must keep working while the list it usually reads is empty.
   */
  notPosted?: readonly AnnouncementKind[];
};

export default function AnnouncementSettings({
  specs,
  saved,
  configured,
  templates,
  origin,
  openKind = null,
  notPosted = NOT_POSTED_YET,
}: AnnouncementSettingsProps) {
  const [value, setValue] = useState<Settings>(saved);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AnnouncementKind | null>(openKind);

  const dirty = specs.some((spec) => value[spec.kind] !== saved[spec.kind]);

  const save = () => {
    setNote(null);
    setError(null);
    start(async () => {
      const result = await saveAnnouncementSettingsAction({ ...value });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Adopt what was *stored*, not what was sent — the same rule the draft
      // config tab follows. A normaliser that dropped something has to be
      // visible on screen rather than only in the database.
      setValue(result.data.settings);
      setNote("Saved.");
    });
  };

  return (
    <Section
      first
      icon="settings"
      title="Discord announcements"
      description="Which moments get posted into the channel, and what each one says. The switches save together, because the setting is one row; the wording saves one kind at a time, because each kind is its own row."
      aside={
        <Eyebrow as="span" className={configured ? "text-success" : "text-muted"}>
          {configured ? "Webhook configured" : "No webhook — nothing will post"}
        </Eyebrow>
      }
      className="space-y-5"
    >
      {!configured && (
        <Alert tone="union">
          No webhook is set, so every switch below is inert. Get one from{" "}
          <strong>Server Settings → Integrations → Webhooks → New Webhook</strong> in
          Discord, pick the channel, copy the URL, and paste it under{" "}
          <strong>Where announcements go</strong> below. Until then the whole feature is a
          no-op, exactly as blank Discord credentials are on the sign-in page.
        </Alert>
      )}

      <div className="divide-y divide-hair/60">
        {specs.map((spec) => (
          <Disclosure
            key={spec.kind}
            title={spec.label}
            summary={summarise(templates[spec.kind])}
            open={open === spec.kind}
            onOpenChange={(next) => setOpen(next ? spec.kind : null)}
            aside={
              <div className="flex items-center gap-3">
                {!posted(spec.kind, notPosted) && (
                  <Badge tone="union">Nothing posts this yet</Badge>
                )}
                <Toggle
                  className="shrink-0"
                  value={value[spec.kind]}
                  yesLabel="On"
                  noLabel="Off"
                  disabled={pending}
                  // `Toggle` clears to `null` when the lit side is tapped again,
                  // which is right for a profile question nobody has answered and
                  // wrong here: a switch is on or off. Null is read as off.
                  onChange={(next) =>
                    setValue((current) => ({ ...current, [spec.kind]: next === true }))
                  }
                />
              </div>
            }
          >
            <AnnouncementEditor
              spec={spec}
              stored={templates[spec.kind]}
              origin={origin}
              on={value[spec.kind]}
              configured={configured}
              posts={posted(spec.kind, notPosted)}
            />
          </Disclosure>
        ))}
      </div>

      {error && <Alert tone="flare">{error}</Alert>}

      <div className="flex flex-wrap items-center gap-3 border-t border-hair pt-4">
        <Button variant="union" size="sm" onClick={save} disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save switches"}
        </Button>
        {note && !dirty && <Eyebrow as="span" className="text-success">{note}</Eyebrow>}
        {dirty && <Eyebrow as="span">Unsaved</Eyebrow>}
      </div>
    </Section>
  );
}

/**
 * The line beside a collapsed row.
 *
 * The cost of a closed section is that you forget what is inside it, so the two
 * facts an admin came to check are on the outside: whose words it posts, and
 * who it pings. `mentionLine` rather than a sentence of this file's own, so the
 * row shows the exact string that goes into `content`.
 */
function summarise(stored: StoredAnnouncementTemplate): string {
  const words = stored.body === null ? "The site's own wording" : "Your wording";
  const line = mentionLine(stored.mention);
  return line ? `${words} · mentions ${line}` : words;
}

/* ------------------------------------------------------------------ */
/* One kind's editor                                                  */
/* ------------------------------------------------------------------ */

/**
 * What the wording box's contents *mean*.
 *
 * `null` is not the same as empty, and this is the one line that decides which
 * a draft is. A kind nobody has edited, with an empty box, is "leave the
 * compiled copy alone" — the ordinary state, and always allowed. A kind with a
 * stored body whose box has been emptied is an admin clearing the wording,
 * which UC-37 3b refuses: an announcement with no words is the switch being
 * off, and the switch is a separate control that already exists.
 *
 * Exported and pure because it is a decision rather than a layout, and the one
 * state in this editor that cannot be reached in a test environment with no
 * keyboard.
 */
export function draftBody(typed: string, saved: AnnouncementTemplate): string | null {
  return typed.trim() === "" && saved.body === null ? null : typed;
}

/**
 * Whether there is anything to save, whether it may be saved, and why not.
 *
 * One function because the three answers have to agree: a Save button that is
 * live while a refusal is on screen is a round trip to be told what the screen
 * already knew, and a refusal shown beside a button that was going to be
 * disabled anyway (because nothing has changed) is a screen shouting at an
 * admin who has not done anything yet.
 *
 * `problem` is `announcementTemplateProblem`'s, not this file's. It is the same
 * function `setAnnouncementTemplate` asks first, so the sentence on the screen
 * is the one the database would have answered with.
 */
export function editorStatus(
  kind: AnnouncementKind,
  draft: AnnouncementTemplate,
  saved: AnnouncementTemplate
): { dirty: boolean; problem: string | null; canSave: boolean } {
  const problem = announcementTemplateProblem(kind, draft);
  const dirty =
    draft.body !== saved.body ||
    draft.mention.everyone !== saved.mention.everyone ||
    draft.mention.roleIds.join(" ") !== saved.mention.roleIds.join(" ");
  return { dirty, problem, canSave: dirty && problem === null };
}

export type AnnouncementEditorProps = {
  spec: AnnouncementSpec;
  stored: StoredAnnouncementTemplate;
  origin: string | null;
  /** Whether this kind's switch is on, so the editor can say what saving achieves. */
  on: boolean;
  configured: boolean;
  /** Whether anything in the site posts this kind yet — `posted`'s answer. */
  posts: boolean;
};

/**
 * The wording, the mention picker and the preview for one kind.
 *
 * **Every refusal is `announcementTemplateProblem`'s**, asked on the draft as
 * it is typed and shown before the save button rather than after it. That is
 * the same function `setAnnouncementTemplate` asks first, so the sentence on
 * the screen is the sentence the database would have answered with — no second
 * copy of the rules to drift, and nothing discovered as a failed post in a
 * quiet channel (UC-37 3a, 3b, 3c). The server is still asked, because a server
 * action is a public endpoint and the screen is not a security boundary; when it
 * refuses, its words are shown too.
 */
export function AnnouncementEditor({
  spec,
  stored,
  origin,
  on,
  configured,
  posts,
}: AnnouncementEditorProps) {
  const [saved, setSaved] = useState<StoredAnnouncementTemplate>(stored);
  const [body, setBody] = useState<string>(stored.body ?? "");
  const [mention, setMention] = useState<AnnouncementMention>(stored.mention);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<StoredAnnouncementTemplate | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const draft: AnnouncementTemplate = { body: draftBody(body, saved), mention };
  const { dirty, problem, canSave } = editorStatus(spec.kind, draft, saved);

  const commit = (template: AnnouncementTemplate) => {
    setError(null);
    setMoved(null);
    setNote(null);
    start(async () => {
      const result = await saveAnnouncementTemplateAction({
        kind: spec.kind,
        body: template.body,
        everyone: template.mention.everyone,
        roleIds: [...template.mention.roleIds],
        expectedVersion: saved.version,
      });
      if (!result.ok) {
        setError(result.error);
        // UC-37 7a. The row that won, handed over by `setAnnouncementTemplate`
        // so the loser is shown the wording that is now in force rather than
        // being told to go and look.
        setMoved(result.current ?? null);
        return;
      }
      // What was *stored*, including the new version the next save is written
      // against — the same rule the switches above follow.
      setSaved(result.data);
      setBody(result.data.body ?? "");
      setMention(result.data.mention);
      setNote("Saved.");
    });
  };

  const offered = placeholdersFor(spec.kind);
  const payload = previewPayload(spec.kind, draft, origin);

  return (
    <div className="space-y-6">
      <p className="max-w-[62ch] text-13 leading-relaxed text-muted">{spec.detail}</p>

      {!posts && (
        <Alert tone="union">
          <span className="block font-medium">Nothing in the site posts this yet</span>
          <span className="mt-1 block">
            The wording, the mention and the switch below are all real and all saved — but
            no part of the site sends this announcement today, so turning it on changes
            nothing you would see in the channel. It needs the moment to fire from, which
            is a clock rather than a request, and that is still to be built.
          </span>
        </Alert>
      )}

      {posts && !on && (
        <Alert tone="union">
          This announcement is switched off, so nothing is posted whatever the wording
          says. Saving the wording here does not turn it on — the switch beside the row
          above does.
        </Alert>
      )}

      {/* ---------------- the wording ---------------- */}

      <div className="space-y-3">
        <Eyebrow as="h3">What it says</Eyebrow>
        <Textarea
          label="Wording"
          className="min-h-[7rem]"
          // The same measure the prose beside it reads at. A sentence edited
          // across a 1,100px line is a sentence nobody can proof-read, and this
          // box holds one sentence.
          wrapperClassName="max-w-[62ch]"
          hint={
            saved.body === null
              ? "Empty, so the site's own wording posts. Type here to use your own; the preview below updates as you type."
              : "Your wording. Clearing it is refused — an announcement with no words is the switch being off."
          }
          value={body}
          maxLength={DISCORD_LIMITS.description + 200}
          onChange={(event) => setBody(event.target.value)}
        />
        <p className="text-12 leading-relaxed text-muted">
          The wording replaces the message&rsquo;s sentence and nothing else. The title,
          the fields, the colour and the link are the announcement&rsquo;s structure, not
          its words, and they stay whatever you write. Discord accepts{" "}
          {DISCORD_LIMITS.description.toLocaleString("en-GB")} characters.
        </p>
      </div>

      {/* ---------------- the placeholders ---------------- */}

      <div className="space-y-3">
        <Eyebrow as="h3">Placeholders this announcement offers</Eyebrow>
        {offered.length === 0 ? (
          <p className="text-13 text-muted">
            This one offers no placeholders at all — it has no facts of its own to put in a
            sentence.
          </p>
        ) : (
          <dl className="space-y-3">
            {offered.map((placeholder) => (
              <div key={placeholder.name} className="text-13 leading-relaxed">
                <dt className="font-medium text-chalk">{`{${placeholder.name}}`}</dt>
                <dd className="text-muted">
                  {placeholder.describe}. Example, used in the preview below:{" "}
                  <span className="text-chalk">{placeholder.example}</span>
                  {placeholder.whenAbsent && (
                    <>
                      {" "}
                      When a real event has none, it posts{" "}
                      <span className="text-chalk">{placeholder.whenAbsent}</span> rather
                      than nothing.
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p className="text-12 leading-relaxed text-muted">
          Anything else in curly brackets is refused before it is saved, naming the ones
          above — a wording that reached for a fact this announcement does not have would
          post a hole nobody can unsend.
        </p>
      </div>

      {/* ---------------- the mention picker ---------------- */}

      <RoleMention kind={spec.kind} mention={mention} onChange={setMention} disabled={pending} />

      {/* ---------------- refusals ---------------- */}

      {problem && <Alert tone="flare">{problem}</Alert>}
      {error && <Alert tone="flare">{error}</Alert>}
      {moved && <WordingMoved current={moved} />}

      {/* ---------------- the preview ---------------- */}

      <PayloadPreview payload={payload} configured={configured} />

      {/* ---------------- saving ---------------- */}

      <div className="flex flex-wrap items-center gap-3 border-t border-hair pt-4">
        <Button
          variant="union"
          size="sm"
          onClick={() => commit(draft)}
          disabled={pending || !canSave}
        >
          {pending ? "Saving…" : "Save wording"}
        </Button>
        {saved.body !== null && (
          <Button
            size="sm"
            onClick={() => commit({ body: null, mention })}
            disabled={pending}
          >
            Use the site&rsquo;s own wording
          </Button>
        )}
        {note && !dirty && (
          <Eyebrow as="span" className="text-success">
            {note}
          </Eyebrow>
        )}
        {dirty && !problem && <Eyebrow as="span">Unsaved</Eyebrow>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Who it mentions (R-202, R-203 / UC-37 4, 4a, 4c)                   */
/* ------------------------------------------------------------------ */

/**
 * The mention picker: `@everyone`, and roles by id.
 *
 * **Why there is no dropdown of your server's roles.** That is R-203, it is a
 * *Could*, and it needs a bot token and a guild id this install does not have.
 * `@RoleName` is inert on Discord — a role ping is `<@&id>` — so the honest
 * control until then is a field that takes the id and refuses anything else by
 * name, with the screen saying why rather than looking broken (UC-37 4a).
 *
 * **The seam for Task 61.** Everything about a role mention is in this
 * component and nowhere else: the paste field, the validation, the chips and
 * the explanation. Filling R-203 means giving it the list — a `roles` prop and
 * a `Select` above the paste field — and changing nothing else on the screen.
 * The paste field stays whatever happens: an install with no token is still a
 * supported install, and that is the case this control exists for.
 *
 * `@everyone` is independent of all of it. It needs no id, so it works on every
 * install with or without a token, and it is the control most of this community
 * will actually use.
 */
/**
 * What pasting an id into the field does: the new mention, or why not.
 *
 * Exported and pure for the reason {@link draftBody} is — the click is the only
 * part of this that needs a browser, and the decision is the part worth
 * pinning. A component holding the decision inside its own click handler is a
 * decision that cannot be tested at all in an environment with no pointer, and
 * "it compiles" is not evidence that a role name is refused.
 *
 * The refusal is asked of `announcementTemplateProblem` rather than of a
 * regular expression copied out of `./announce`. The id has to satisfy exactly
 * what the save will demand of it, and the admin has to read exactly the
 * sentence the save would have answered with — one function, one set of words,
 * no second copy to fall behind.
 */
export function withRole(
  kind: AnnouncementKind,
  mention: AnnouncementMention,
  pasted: string
): { mention: AnnouncementMention; refused: string | null } {
  const id = pasted.trim();
  if (!id) return { mention, refused: null };

  const problem = announcementTemplateProblem(kind, {
    body: null,
    mention: { everyone: false, roleIds: [id] },
  });
  if (problem) return { mention, refused: problem };

  if (mention.roleIds.includes(id)) {
    return { mention, refused: "That role is already mentioned." };
  }

  return {
    mention: { ...mention, roleIds: [...mention.roleIds, id] },
    refused: null,
  };
}

export function RoleMention({
  kind,
  mention,
  onChange,
  disabled,
}: {
  kind: AnnouncementKind;
  mention: AnnouncementMention;
  onChange: (next: AnnouncementMention) => void;
  disabled?: boolean;
}) {
  const [pasted, setPasted] = useState("");
  const [refused, setRefused] = useState<string | null>(null);

  const add = () => {
    const next = withRole(kind, mention, pasted);
    setRefused(next.refused);
    if (next.refused !== null || next.mention === mention) return;
    onChange(next.mention);
    setPasted("");
  };

  const line = mentionLine(mention);

  return (
    <div className="space-y-3">
      <Eyebrow as="h3">Who it mentions</Eyebrow>

      <Checkbox
        checked={mention.everyone}
        onChange={(next) => onChange({ ...mention, everyone: next })}
        disabled={disabled}
        label={
          <span className="block">
            <span className="block text-14 text-chalk">Ping @everyone</span>
            <span className="mt-0.5 block text-13 leading-relaxed text-muted">
              Every member of the server, every time this announcement posts. Switching it
              on is written to the audit log as a line of its own.
            </span>
          </span>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Add a role by id"
          placeholder="000000000000000000"
          value={pasted}
          inputMode="numeric"
          maxLength={20}
          disabled={disabled}
          wrapperClassName="w-full sm:w-[16rem]"
          onChange={(event) => setPasted(event.target.value)}
        />
        <Button size="sm" onClick={add} disabled={disabled || pasted.trim() === ""}>
          Add role
        </Button>
      </div>

      <p className="max-w-[62ch] text-12 leading-relaxed text-muted">
        There is no list of your server&rsquo;s roles to pick from, and that is a missing
        capability rather than a missing screen: reading the list needs a bot token and a
        server id, which this install does not have. Until it does, paste the id — in
        Discord, turn on Developer Mode, then <strong>Server Settings → Roles</strong>,
        right-click the role and <strong>Copy Role ID</strong>. A role <em>name</em> does
        nothing on Discord, so a name pasted here is refused rather than quietly notifying
        nobody.
      </p>

      {mention.roleIds.length > 0 && (
        /*
         * A row each rather than chips with a cross on them. A role id is
         * eighteen digits, which is nearly the width of a 400px screen on its
         * own, and a remove control tucked inside a chip ends up about sixteen
         * pixels tall — a third of the touch floor the Constraints set, and the
         * same mistake `Checkbox` exists to have fixed once.
         */
        <ul className="divide-y divide-hair/60">
          {mention.roleIds.map((id) => (
            <li key={id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span className="text-13 text-chalk">{`<@&${id}>`}</span>
              <Button
                onClick={() =>
                  onChange({
                    ...mention,
                    roleIds: mention.roleIds.filter((other) => other !== id),
                  })
                }
                disabled={disabled}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {refused && <Alert tone="flare">{refused}</Alert>}

      <p className="text-12 leading-relaxed text-muted">
        {line
          ? `The message will begin with ${line}`
          : "Nobody is mentioned, so the message carries no mention line at all."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Somebody else saved first (UC-37 7a)                               */
/* ------------------------------------------------------------------ */

/**
 * The wording that won, shown to the admin whose save lost.
 *
 * UC-37 7a asks for two things and this is the second: being told is not enough,
 * because an admin told their words did not land and not shown what did has to
 * go and find out, and the commonest way of finding out is to reload and
 * overwrite the other person's edit.
 *
 * Their own draft is deliberately left in the box above. Nothing of theirs is
 * thrown away by losing a race; what they do about it is a decision, and this
 * is the fact they need to make it.
 */
export function WordingMoved({ current }: { current: StoredAnnouncementTemplate }) {
  const line = mentionLine(current.mention);
  return (
    <Panel tone="wash" padding="sm" className="space-y-2">
      <Eyebrow as="h3">The wording in force now</Eyebrow>
      <p className="whitespace-pre-wrap text-13 leading-relaxed text-chalk">
        {current.body === null ? "The site's own wording — theirs is not edited." : current.body}
      </p>
      <p className="text-12 leading-relaxed text-muted">
        {line ? `It mentions ${line}.` : "It mentions nobody."} Your words are still in the
        box above, untouched. Save again to replace what is here, or copy what you want out
        of it first.
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* The preview (R-204 / UC-37 5, 5a)                                  */
/* ------------------------------------------------------------------ */

/** A Discord embed colour as a CSS colour. No token can name a value from the payload. */
function swatch(colour: number): string {
  return `rgb(${(colour >> 16) & 0xff} ${(colour >> 8) & 0xff} ${colour & 0xff})`;
}

/**
 * What Discord will show, drawn from the payload and from nothing else.
 *
 * The title, the sentence, the fields, the footer and the mention line are read
 * straight off the `DiscordMessage` {@link previewPayload} returned. The exact
 * bytes follow underneath, because a rendering is a reading of a payload and
 * the payload is the thing R-204 promises — an admin who wants to know whether
 * a stray brace survived can read it rather than trust this layout.
 *
 * The coloured rule down the left is Discord's own chrome rather than this
 * site's decoration, which is why it is drawn from `embed.color` as an inline
 * value: it is data, and no palette token could carry it.
 */
export function PayloadPreview({
  payload,
  configured,
}: {
  payload: DiscordMessage;
  configured: boolean;
}) {
  const embed: DiscordEmbed = payload.embeds[0];

  return (
    <div className="space-y-3">
      <Eyebrow as="h3">Preview — example values, nothing sent</Eyebrow>

      <Panel tone="wash" padding="sm" className="space-y-3">
        {payload.content && (
          <p className="text-13 text-union">{payload.content}</p>
        )}

        <div
          className="border-l-2 pl-3"
          style={{ borderColor: swatch(embed.color) }}
        >
          <p className="text-14 font-medium text-chalk">{embed.title}</p>
          {embed.description && (
            <p className="mt-1 whitespace-pre-wrap text-13 leading-relaxed text-muted">
              {embed.description}
            </p>
          )}
          {embed.fields && embed.fields.length > 0 && (
            <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
              {embed.fields.map((field, index) => (
                <div key={`${field.name}-${index}`} className="text-12">
                  <dt className="text-dim">{field.name}</dt>
                  <dd className="text-chalk">{field.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {embed.footer && <p className="mt-2 text-11 text-dim">{embed.footer.text}</p>}
          <p className="mt-2 text-11 text-dim">
            {embed.url
              ? `Links to ${embed.url}`
              : "No link — this install has no site address set, so the post carries none."}
          </p>
        </div>
      </Panel>

      <p className="max-w-[62ch] text-12 leading-relaxed text-muted">
        The times read as <span className="text-chalk">&lt;t:…&gt;</span> here because that
        is what is actually sent: Discord renders it in each reader&rsquo;s own timezone, so
        no message this site builds ever contains a date somebody else&rsquo;s clock decided.
      </p>

      <p className="max-w-[62ch] text-12 leading-relaxed text-muted">
        Every value above is this announcement&rsquo;s declared example rather than a real
        event: there is no event being previewed, and a preview full of blanks looks like a
        bug. A real post puts the real event in the same places.{" "}
        {configured
          ? "Nothing is sent by looking at this — the message is built here and posted nowhere."
          : "Nothing is sent by looking at this, and nothing would be sent by saving either, because no webhook is configured."}
      </p>

      <Eyebrow as="h3">The exact payload</Eyebrow>
      <pre className="overflow-x-auto bg-sunken p-3 text-12 leading-relaxed text-chalk">
        {JSON.stringify(payload, null, 2)}
      </pre>
      <p className="max-w-[62ch] text-12 leading-relaxed text-muted">
        These are the bytes that would go to the webhook, built by the same function that
        builds them when the announcement actually posts — this screen has no renderer of
        its own. <span className="text-chalk">allowed_mentions</span> is the allow-list
        Discord is held to: a role id anywhere else in the message, including in
        somebody&rsquo;s display name, is inert.
      </p>
    </div>
  );
}
