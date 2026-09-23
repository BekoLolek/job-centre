"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import LadderEditor from "./LadderEditor";
import QuestionList from "./QuestionList";
import {
  Alert,
  Badge,
  Button,
  Eyebrow,
  Field,
  Section,
  Select,
  StatusPill,
  Tabs,
  plural,
} from "@/components/ui";
import type { AdminFieldView, AdminGameView, AdminGamesView } from "@/lib/admin-games";
import {
  createGameAction,
  moveGameAction,
  renameGameAction,
  restoreFieldAction,
  retireFieldAction,
  setGameActiveAction,
} from "@/app/admin/games/actions";

/**
 * `/admin/games`, client side.
 *
 * The screen behind §13 Q4 — "as an admin I want to add a new game and say what
 * info I want from players" — so the measure of it is that adding REPO with two
 * questions takes a minute and no code.
 *
 * ## Where the data lives
 *
 * Nowhere here. Every mutation is a server action that revalidates the page,
 * and this component calls `router.refresh()` afterwards, so what is on screen
 * is always the rows as Postgres has them rather than a client-side copy
 * drifting from them. The only local state is what is half-typed: a new game's
 * name, a ladder being rearranged, a dialog that is open.
 *
 * ## Why nothing deletes a game
 *
 * Deactivating removes it from `/me/profile` and from applications while
 * keeping every answer, and checklist.md's standing rule is that nothing is
 * destructive. A game deleted in a tidying mood would take years of profile
 * data with it; a game switched off can be switched back on.
 *
 * ## Why nothing deletes an answered question either
 *
 * The same rule, one level down (UC-03 5a, R-09). `RetiredQuestions` below is
 * the switch: retiring stops a question being asked and keeps every answer to
 * it, restoring puts both back. Deleting survives only for a question nobody
 * has answered — the five-minute-old typo — and `deleteField` refuses the
 * rest.
 */

export default function GamesManager({ view }: { view: AdminGamesView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [openGameId, setOpenGameId] = useState<string | null>(
    view.games.find((game) => game.isActive)?.id ?? view.games[0]?.id ?? null
  );

  const refresh = () => startTransition(() => router.refresh());

  const run = (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? "That did not work.");
      else router.refresh();
    });
  };

  const addGame = () => {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    startTransition(async () => {
      const result = await createGameAction(name);
      if (!result.ok) return setError(result.error);
      setNewName("");
      setOpenGameId(result.data.id);
      router.refresh();
    });
  };

  return (
    <div>
      {error && <Alert className="mb-6">{error}</Alert>}

      {/* --- Add a game ------------------------------------------- */}
      <Section
        first
        icon="spark"
        title="Add a game"
        description="Starts active, with no rank ladder and no questions. Give it questions below and they appear on every member’s profile immediately — no deploy, no migration."
        className="rise"
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Name"
            hint="“REPO”, “Jackbox”, “Marvel Rivals”. The key is made from it."
            value={newName}
            maxLength={60}
            wrapperClassName="flex-1 min-w-[14rem]"
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addGame();
              }
            }}
          />
          <Button variant="union" disabled={pending || !newName.trim()} onClick={addGame}>
            Add game
          </Button>
        </div>
      </Section>

      {/* --- Global questions -------------------------------------- */}
      <Section
        icon="clipboard"
        title="Everyone"
        description="Asked of every member regardless of what they play — “happy to use voice chat” and the like. These are the rows with no game attached."
        aside={
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{plural(view.globalFields.length, "question")}</Badge>
            <Badge tone={view.globalAnswers > 0 ? "success" : "default"}>
              {plural(view.globalAnswers, "answer")}
            </Badge>
          </div>
        }
      >
        <QuestionList
          gameId={null}
          gameName="Everyone"
          rankLadder={[]}
          fields={view.globalFields}
          busy={pending}
          onChanged={refresh}
        />
        <RetiredQuestions
          asked={view.globalFields}
          retired={view.globalRetired}
          busy={pending}
          onChanged={refresh}
        />
      </Section>

      {/* --- The games --------------------------------------------- */}
      <Section
        icon="grid"
        title="Games"
        description="Order here is the order sections appear on a member’s profile. Deactivating hides one without losing a single answer."
        aside={<Badge>{plural(view.games.length, "game")}</Badge>}
      >
        {view.games.length === 0 ? (
          <p className="py-6 text-14 text-muted">
            No games yet. Add one above — that is all it takes for it to start appearing on
            profiles.
          </p>
        ) : (
          <div className="divide-y divide-hair/60">
            {view.games.map((game, index) => (
              <GameCard
                key={game.id}
                game={game}
                first={index === 0}
                last={index === view.games.length - 1}
                open={openGameId === game.id}
                busy={pending}
                onToggleOpen={() => setOpenGameId(openGameId === game.id ? null : game.id)}
                onMove={(direction) => run(() => moveGameAction(game.id, direction))}
                onRename={(name) => run(() => renameGameAction(game.id, name))}
                onSetActive={(active) => run(() => setGameActiveAction(game.id, active))}
                onChanged={refresh}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Retiring a question                                                */
/* ------------------------------------------------------------------ */

/**
 * Stop asking a question without losing what people said (UC-03 5a, R-09).
 *
 * The thing a question accumulates is answers, and they are the only part of
 * it that cannot be typed again. So there is no delete here for a question
 * anybody has used: retiring takes it off every member's profile and off the
 * completeness count, and leaves every stored answer where it is. Restoring
 * brings the question and all of its answers straight back, which is what
 * makes retiring a decision an admin can afford to get wrong.
 *
 * It sits under the list rather than as a button on each row because the list
 * is `QuestionList`'s, and one panel that names the question it is about reads
 * no worse than a third icon on every row.
 */
function RetiredQuestions({
  asked,
  retired,
  busy,
  onChanged,
}: {
  asked: AdminFieldView[];
  retired: AdminFieldView[];
  busy: boolean;
  onChanged: () => void;
}) {
  const [picked, setPicked] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = busy || working;

  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setWorking(true);
    setError(null);
    const result = await action();
    if (!result.ok) setError(result.error ?? "That did not work.");
    else {
      setPicked("");
      onChanged();
    }
    setWorking(false);
  };

  if (asked.length === 0 && retired.length === 0) return null;

  return (
    <div className="mt-5 border-t border-hair pt-4">
      <Eyebrow className="mb-2">Retiring</Eyebrow>
      {error && <Alert className="mb-3">{error}</Alert>}

      <p className="mb-3 text-12 leading-relaxed text-muted">
        A retired question stops being asked and stops counting towards a profile being
        complete. Nothing is deleted — every answer is kept, and restoring the question brings
        all of them back.
      </p>

      {asked.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[14rem] flex-1">
            <Select
              label="Stop asking"
              value={picked}
              onChange={(event) => setPicked(event.target.value)}
            >
              <option value="">Pick a question…</option>
              {asked.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.label} · {plural(field.answers, "answer")}
                </option>
              ))}
            </Select>
          </div>
          <Button
            size="sm"
            disabled={locked || !picked}
            onClick={() => void run(() => retireFieldAction(picked))}
          >
            Retire it
          </Button>
        </div>
      )}

      {retired.length > 0 && (
        <ul className="mt-4 divide-y divide-hair/60 rounded-lg border border-hair">
          {retired.map((field) => (
            <li key={field.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-14 text-muted">{field.label}</span>
              <Badge tone={field.answers > 0 ? "success" : "default"}>
                {plural(field.answers, "answer")} kept
              </Badge>
              <Button
                size="sm"
                disabled={locked}
                onClick={() => void run(() => restoreFieldAction(field.id))}
              >
                Ask it again
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One game                                                           */
/* ------------------------------------------------------------------ */

function GameCard({
  game,
  first,
  last,
  open,
  busy,
  onToggleOpen,
  onMove,
  onRename,
  onSetActive,
  onChanged,
}: {
  game: AdminGameView;
  first: boolean;
  last: boolean;
  open: boolean;
  busy: boolean;
  onToggleOpen: () => void;
  onMove: (direction: "up" | "down") => void;
  onRename: (name: string) => void;
  onSetActive: (active: boolean) => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"questions" | "ranks" | "settings">("questions");

  return (
    <article className="py-5">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onToggleOpen}
          className="flex min-w-0 items-center gap-3 text-left"
          aria-expanded={open}
        >
          <span className="font-mono text-12 text-muted">{open ? "▾" : "▸"}</span>
          <span className="min-w-0">
            <span className="block truncate font-display text-20 leading-none">
              {game.name}
            </span>
            <span className="eyebrow mt-1 block">{game.key}</span>
          </span>
        </button>

        <StatusPill
          status={game.isActive ? "live" : "closed"}
          label={game.isActive ? "Active" : "Hidden"}
        />
        <Badge>{plural(game.fields.length, "question")}</Badge>
        {game.rankLadder.length > 0 && <Badge>{plural(game.rankLadder.length, "rank")}</Badge>}
        <Badge tone={game.answers > 0 ? "success" : "default"}>
          {plural(game.answers, "answer")}
        </Badge>

        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            aria-label={`Move ${game.name} up`}
            disabled={busy || first}
            onClick={() => onMove("up")}
          >
            ↑
          </Button>
          <Button
            size="sm"
            aria-label={`Move ${game.name} down`}
            disabled={busy || last}
            onClick={() => onMove("down")}
          >
            ↓
          </Button>
          <Button size="sm" disabled={busy} onClick={onToggleOpen}>
            {open ? "Close" : "Edit"}
          </Button>
        </span>
      </div>

      {open && (
        <div className="mt-5 space-y-5">
          <Tabs
            items={[
              { value: "questions", label: "Questions", count: game.fields.length },
              { value: "ranks", label: "Rank ladder", count: game.rankLadder.length },
              { value: "settings", label: "Settings" },
            ]}
            value={tab}
            onChange={setTab}
          />

          {tab === "questions" && (
            <>
              <QuestionList
                gameId={game.id}
                gameName={game.name}
                rankLadder={game.rankLadder}
                fields={game.fields}
                busy={busy}
                onChanged={onChanged}
              />
              <RetiredQuestions
                asked={game.fields}
                retired={game.retired}
                busy={busy}
                onChanged={onChanged}
              />
            </>
          )}

          {tab === "ranks" && (
            <LadderEditor
              gameId={game.id}
              gameName={game.name}
              ladder={game.rankLadder}
              onChanged={onChanged}
            />
          )}

          {tab === "settings" && (
            <GameSettings
              game={game}
              busy={busy}
              onRename={onRename}
              onSetActive={onSetActive}
            />
          )}
        </div>
      )}
    </article>
  );
}

function GameSettings({
  game,
  busy,
  onRename,
  onSetActive,
}: {
  game: AdminGameView;
  busy: boolean;
  onRename: (name: string) => void;
  onSetActive: (active: boolean) => void;
}) {
  const [name, setName] = useState(game.name);
  const renamed = name.trim() !== game.name && name.trim().length > 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Name"
          hint={`The key stays "${game.key}" — other things point at it.`}
          value={name}
          maxLength={60}
          wrapperClassName="flex-1 min-w-[14rem]"
          onChange={(event) => setName(event.target.value)}
        />
        <Button size="sm" disabled={busy || !renamed} onClick={() => onRename(name.trim())}>
          Rename
        </Button>
      </div>

      <div className="border-t border-hair pt-4">
        <Eyebrow className="mb-2">Visibility</Eyebrow>
        <p className="mb-3 text-12 leading-relaxed text-muted">
          {game.isActive
            ? "Active: this section shows on every member's profile."
            : "Hidden: members do not see this section. Every answer is still stored and comes back the moment it is switched on."}
        </p>
        <Button
          size="sm"
          variant={game.isActive ? "flare" : "union"}
          disabled={busy}
          onClick={() => onSetActive(!game.isActive)}
        >
          {game.isActive ? "Deactivate" : "Activate"}
        </Button>
      </div>

      <div className="border-t border-hair pt-4">
        <Eyebrow className="mb-2">Deleting</Eyebrow>
        <p className="text-12 leading-relaxed text-muted">
          There is deliberately no delete. Deactivating does everything deleting would,
          without taking {plural(game.answers, "stored answer")} with it — and nothing on
          this site is allowed to erase history.
        </p>
      </div>
    </div>
  );
}
