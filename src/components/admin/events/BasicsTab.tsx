"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Alert,
  ChoiceChip,
  ChoiceRow,
  Eyebrow,
  Field,
  Panel,
  Select,
  Stepper,
  Textarea,
} from "@/components/ui";
import { EVENT_TYPE_SUGGESTIONS, localInput } from "@/components/events";
import type { EventDetail } from "@/lib/events";
import type { EntryMode } from "@/db/schema";
import { entryMode, waitlistEnabled } from "@/lib/events-policy";
import { slugify } from "@/lib/profile-fields";
import { toInstant, zoneLabel } from "@/lib/time";
import { saveBasicsAction } from "@/app/admin/events/actions";
import SaveRow, { type SaveState } from "./SaveRow";
import type { GameOption } from "./types";

/**
 * Basics — what the event is, when it runs, and who it is for.
 *
 * Two things here are less obvious than they look:
 *
 * **The slug follows the title until it is touched.** An admin should never
 * have to think about a URL segment, but they must be able to fix one, and a
 * slug that silently keeps rewriting itself after being edited is worse than
 * one that never suggested anything. So: suggest until touched, then stop. The
 * server disambiguates a clash (`freeSlug`) and the result is read back, so
 * "saved as rivals-2" is visible rather than discovered later.
 *
 * **Status does not live here.** It has one control, `EventStatusControls`, on
 * the events list and the Publish step (UC-09).
 */

const KNOWN_TYPES: readonly string[] = EVENT_TYPE_SUGGESTIONS;

export default function BasicsTab({
  event,
  games,
}: {
  event: EventDetail;
  games: GameOption[];
}) {
  const router = useRouter();

  const [title, setTitle] = useState(event.title);
  const [slug, setSlug] = useState(event.slug);
  // Keep suggesting only while the slug is still the one the title produced.
  // Once it has been hand-edited — or disambiguated to `rivals-2` — retitling
  // must not quietly move the URL somebody has already been given.
  const [slugTouched, setSlugTouched] = useState(event.slug !== slugify(event.title));
  const [type, setType] = useState(event.type);
  const [description, setDescription] = useState(event.description ?? "");
  const [bannerUrl, setBannerUrl] = useState(event.bannerUrl ?? "");
  const [gameId, setGameId] = useState(event.gameId ?? "");
  const [capacity, setCapacity] = useState<number | null>(event.capacity);
  const [mode, setMode] = useState<EntryMode>(entryMode(event.config));
  const [waitlist, setWaitlist] = useState(waitlistEnabled(event.config));
  const [signupOpensAt, setSignupOpensAt] = useState(localInput(event.signupOpensAt));
  const [signupClosesAt, setSignupClosesAt] = useState(localInput(event.signupClosesAt));
  const [startsAt, setStartsAt] = useState(localInput(event.startsAt));
  const [endsAt, setEndsAt] = useState(localInput(event.endsAt));

  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const touch = () => {
    setState("dirty");
    setError(null);
    setNote(null);
  };

  const changeTitle = (next: string) => {
    setTitle(next);
    if (!slugTouched) setSlug(slugify(next));
    touch();
  };

  const save = async () => {
    setState("saving");
    setError(null);
    try {
      const result = await saveBasicsAction(event.id, {
        title,
        slug,
        type,
        description: description.trim() || null,
        bannerUrl: bannerUrl.trim() || null,
        gameId: gameId || null,
        capacity,
        entryMode: mode,
        waitlist,
        signupOpensAt: toInstant(signupOpensAt),
        signupClosesAt: toInstant(signupClosesAt),
        startsAt: toInstant(startsAt),
        endsAt: toInstant(endsAt),
      });

      if (!result.ok) {
        setError(result.error);
        setState("error");
        return;
      }

      // The server may have disambiguated it. Say so rather than leaving the
      // box showing something that is not what got stored.
      setNote(result.data.slug === slug ? null : `Saved as /events/${result.data.slug}`);
      setSlug(result.data.slug);
      setState("saved");
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      setState("error");
    }
  };

  const usingCustomType = !KNOWN_TYPES.includes(type as (typeof KNOWN_TYPES)[number]);

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {/* --- Identity ----------------------------------------------- */}
      <Panel as="section" padding="none" className="space-y-5 border-t border-hair pt-12 first:border-t-0 first:pt-0">
        <Eyebrow>What it is</Eyebrow>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Title"
            hint="What members read on the hub."
            value={title}
            maxLength={120}
            onChange={(input) => changeTitle(input.target.value)}
          />

          <Field
            label="Slug"
            hint={`The public URL: /events/${slug || "…"}. Must be unique.`}
            value={slug}
            maxLength={64}
            onChange={(input) => {
              setSlugTouched(true);
              setSlug(input.target.value);
              touch();
            }}
            onBlur={() => setSlug((current) => slugify(current))}
          />
        </div>

        <div>
          <Eyebrow className="mb-2 text-chalk/70">Type</Eyebrow>
          <ChoiceRow>
            {KNOWN_TYPES.map((option) => (
              <ChoiceChip
                key={option}
                selected={type === option}
                onClick={() => {
                  setType(option);
                  touch();
                }}
              >
                {option}
              </ChoiceChip>
            ))}
            <ChoiceChip
              selected={usingCustomType}
              onClick={() => {
                setType(usingCustomType ? "custom" : "");
                touch();
              }}
            >
              Something else
            </ChoiceChip>
          </ChoiceRow>

          {usingCustomType && (
            <Field
              className="mt-3 max-w-xs"
              aria-label="Custom event type"
              placeholder="among-us-night"
              value={type}
              maxLength={40}
              onChange={(input) => {
                setType(input.target.value);
                touch();
              }}
            />
          )}

          <p className="mt-2 text-12 text-muted">
            A type is a label, not a code branch (§8.1) — anything you type here is a valid
            type the moment you save it.
          </p>
        </div>

        <Textarea
          label="Description"
          hint="What the event page says. Plain text."
          className="h-32"
          value={description}
          maxLength={4000}
          onChange={(input) => {
            setDescription(input.target.value);
            touch();
          }}
        />

        <Field
          label="Banner URL"
          hint="Optional. A wide image; it becomes the strip along the top of the card."
          value={bannerUrl}
          maxLength={500}
          placeholder="https://…"
          onChange={(input) => {
            setBannerUrl(input.target.value);
            touch();
          }}
        />
      </Panel>

      {/* --- Game and capacity -------------------------------------- */}
      <Panel as="section" padding="none" className="space-y-5 border-t border-hair pt-12 first:border-t-0 first:pt-0">
        <Eyebrow>Who it is for</Eyebrow>

        <Select
          label="Game"
          hint="Decides which rank ladder the entry rules read, and which profile answers can prefill the form."
          value={gameId}
          wrapperClassName="max-w-sm"
          onChange={(input) => {
            setGameId(input.target.value);
            touch();
          }}
        >
          <option value="">No game (movie night, social…)</option>
          {games.map((game) => (
            <option key={game.id} value={game.id}>
              {game.name}
              {game.isActive ? "" : " (hidden)"}
              {game.rankLadder.length > 0 ? ` · ${game.rankLadder.length} ranks` : ""}
            </option>
          ))}
        </Select>

        <div>
          <Eyebrow className="mb-2 text-chalk/70">Capacity</Eyebrow>
          <Stepper
            value={capacity}
            min={1}
            max={999}
            aria-label="Capacity"
            suffix={capacity === null ? "no limit" : "seats"}
            onChange={(next) => {
              setCapacity(next);
              touch();
            }}
          />
          <p className="mt-2 text-12 leading-relaxed text-muted">
            Clear the box for an uncapped event. You can still accept somebody over the cap
            — the screen will say so rather than refusing.
          </p>
        </div>

        {/* --- How people get in (UC-08 6, 6a, E6) -------------------- */}
        <div>
          <Eyebrow className="mb-2 text-chalk/70">How people get in</Eyebrow>
          <ChoiceRow>
            <ChoiceChip
              selected={mode === "first_come"}
              onClick={() => {
                setMode("first_come");
                touch();
              }}
            >
              First come
            </ChoiceChip>
            <ChoiceChip
              selected={mode === "approval"}
              onClick={() => {
                setMode("approval");
                touch();
              }}
            >
              By approval
            </ChoiceChip>
          </ChoiceRow>
          <p className="mt-2 text-12 leading-relaxed text-muted">
            {mode === "approval"
              ? "Every application lands awaiting your review under Applicants, holding no seat and no place in the queue, until you accept, queue or decline it."
              : "Applications take a seat the moment they arrive, and the cap decides what happens once the seats are gone."}
          </p>
        </div>

        {/* The waitlist is a first-come rule: in an approval event nothing is
            queued by the cap, so the switch would be a control with no effect. */}
        {mode === "first_come" && (
          <div>
            <Eyebrow className="mb-2 text-chalk/70">Waitlist</Eyebrow>
            <ChoiceRow>
              <ChoiceChip
                selected={waitlist}
                onClick={() => {
                  setWaitlist(true);
                  touch();
                }}
              >
                Queue them
              </ChoiceChip>
              <ChoiceChip
                selected={!waitlist}
                onClick={() => {
                  setWaitlist(false);
                  touch();
                }}
              >
                Close when full
              </ChoiceChip>
            </ChoiceRow>
            <p className="mt-2 text-12 leading-relaxed text-muted">
              {waitlist
                ? "Applications past the cap join the waitlist and are promoted automatically when somebody withdraws (§14)."
                : "Sign-ups close the moment the seats are gone, and a late applicant is told the event is full rather than queueing for nothing."}
            </p>
          </div>
        )}
      </Panel>

      {/* --- Dates -------------------------------------------------- */}
      <Panel as="section" padding="none" className="space-y-5 border-t border-hair pt-12 first:border-t-0 first:pt-0">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>When</Eyebrow>
          <span className="eyebrow text-dim">
            You are entering times in {zoneLabel()}
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Signups open"
            hint="Leave empty to take applications as soon as it is published."
            type="datetime-local"
            value={signupOpensAt}
            onChange={(input) => {
              setSignupOpensAt(input.target.value);
              touch();
            }}
          />
          <Field
            label="Signups close"
            hint="Leave empty to keep taking them until the event starts."
            type="datetime-local"
            value={signupClosesAt}
            onChange={(input) => {
              setSignupClosesAt(input.target.value);
              touch();
            }}
          />
          <Field
            label="Event starts"
            hint="Applications close when this passes, whatever the window says."
            type="datetime-local"
            value={startsAt}
            onChange={(input) => {
              setStartsAt(input.target.value);
              touch();
            }}
          />
          <Field
            label="Event ends"
            hint="Optional. Used for the date range and the archive."
            type="datetime-local"
            value={endsAt}
            onChange={(input) => {
              setEndsAt(input.target.value);
              touch();
            }}
          />
        </div>

        <SaveRow
          state={state}
          note={note}
          onSave={() => void save()}
          disabled={!title.trim() || !slug.trim()}
          label="Save basics"
        />
      </Panel>
    </div>
  );
}
