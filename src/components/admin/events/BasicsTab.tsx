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
import {
  EVENT_TYPE_SUGGESTIONS,
  eventStatusLabel,
  eventStatusMeaning,
  localInput,
} from "@/components/events";
import type { EventStatus } from "@/db/schema";
import type { EventDetail } from "@/lib/events";
import { nextStatuses } from "@/lib/events-policy";
import { slugify } from "@/lib/profile-fields";
import { toInstant, zoneLabel } from "@/lib/time";
import { saveBasicsAction, setEventStatusAction } from "@/app/admin/events/actions";
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
 * **Status lives here, and only the legal moves are offered.** `nextStatuses`
 * is the single source of that; rendering all five and letting the server
 * refuse four of them would be a screen that lies about what it can do.
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
  const [signupOpensAt, setSignupOpensAt] = useState(localInput(event.signupOpensAt));
  const [signupClosesAt, setSignupClosesAt] = useState(localInput(event.signupClosesAt));
  const [startsAt, setStartsAt] = useState(localInput(event.startsAt));
  const [endsAt, setEndsAt] = useState(localInput(event.endsAt));

  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);

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

  const moveTo = async (status: EventStatus) => {
    setStatusBusy(true);
    setError(null);
    try {
      const result = await setEventStatusAction(event.id, status);
      if (!result.ok) setError(result.error);
      else router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setStatusBusy(false);
    }
  };

  const usingCustomType = !KNOWN_TYPES.includes(type as (typeof KNOWN_TYPES)[number]);

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {/* --- Identity ----------------------------------------------- */}
      <Panel as="section" className="space-y-5">
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

          <p className="mt-2 text-xs text-muted">
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
      <Panel as="section" className="space-y-5">
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
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Clear the box for an uncapped event. With a cap, applications past it join the
            waitlist and are promoted automatically when somebody withdraws (§14). You can
            still accept somebody over the cap — the screen will say so rather than refusing.
          </p>
        </div>
      </Panel>

      {/* --- Dates -------------------------------------------------- */}
      <Panel as="section" className="space-y-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <Eyebrow>When</Eyebrow>
          <span className="eyebrow text-muted/70">
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

      {/* --- Status ------------------------------------------------- */}
      <Panel as="section" className="space-y-4">
        <Eyebrow>Status</Eyebrow>

        <p className="text-sm">
          <span className="text-chalk">{eventStatusLabel(event.status)}</span>
          <span className="text-muted"> — {eventStatusMeaning(event.status)}</span>
        </p>

        <div>
          <Eyebrow className="mb-2 text-chalk/70">Where it can go from here</Eyebrow>
          <ChoiceRow>
            {nextStatuses(event.status).map((status) => (
              <ChoiceChip
                key={status}
                disabled={statusBusy}
                onClick={() => void moveTo(status)}
              >
                {eventStatusLabel(status)}
              </ChoiceChip>
            ))}
          </ChoiceRow>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Only the legal moves are shown. Nothing is a dead end — a cancelled event can go
            back to draft, and a completed one back to live, because the usual reason to
            leave a status is that somebody clicked the wrong button.
          </p>
        </div>

        {event.status === "draft" && (
          <p className="text-xs text-muted">
            Publishing has its own tab, with a readiness checklist — that is the one move
            worth reading before making.
          </p>
        )}
      </Panel>
    </div>
  );
}
