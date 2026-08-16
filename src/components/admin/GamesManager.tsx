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
  Panel,
  StatusPill,
  Tabs,
  plural,
} from "@/components/ui";
import type { AdminGameView, AdminGamesView } from "@/lib/admin-games";
import {
  createGameAction,
  moveGameAction,
  renameGameAction,
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
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      {/* --- Add a game ------------------------------------------- */}
      <Panel as="section" className="rise">
        <Eyebrow className="mb-3">Add a game</Eyebrow>
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
          <Button variant="gold" disabled={pending || !newName.trim()} onClick={addGame}>
            Add game
          </Button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          A new game starts active, with no rank ladder and no questions. Give it questions
          below and they appear on every member&apos;s profile immediately — no deploy, no
          migration.
        </p>
      </Panel>

      {/* --- Global questions -------------------------------------- */}
      <Panel as="section" padding="none">
        <div className="flex flex-wrap items-center gap-3 border-b border-hair px-5 py-4">
          <h2 className="font-display text-xl leading-none tracking-wide">Everyone</h2>
          <Badge>{plural(view.globalFields.length, "question")}</Badge>
          <Badge tone={view.globalAnswers > 0 ? "signal" : "default"}>
            {plural(view.globalAnswers, "answer")}
          </Badge>
          <Eyebrow as="span" className="ml-auto">
            No game
          </Eyebrow>
        </div>
        <div className="space-y-3 p-5">
          <p className="text-xs leading-relaxed text-muted">
            Asked of every member regardless of what they play — “happy to use voice chat”
            and the like. These are the rows with no game attached.
          </p>
          <QuestionList
            gameId={null}
            gameName="Everyone"
            rankLadder={[]}
            fields={view.globalFields}
            busy={pending}
            onChanged={refresh}
          />
        </div>
      </Panel>

      {/* --- The games --------------------------------------------- */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Eyebrow as="h2">Games · {view.games.length}</Eyebrow>
          <span className="eyebrow text-muted/70">
            Order here is the order sections appear on a member&apos;s profile
          </span>
        </div>

        {view.games.length === 0 ? (
          <Panel>
            <p className="text-sm text-muted">
              No games yet. Add one above — that is all it takes for it to start appearing
              on profiles.
            </p>
          </Panel>
        ) : (
          view.games.map((game, index) => (
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
          ))
        )}
      </section>
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
    <Panel as="article" padding="none">
      <div className="flex flex-wrap items-center gap-3 border-b border-hair px-5 py-4">
        <button
          type="button"
          onClick={onToggleOpen}
          className="flex min-w-0 items-center gap-3 text-left"
          aria-expanded={open}
        >
          <span className="font-mono text-xs text-muted">{open ? "▾" : "▸"}</span>
          <span className="min-w-0">
            <span className="block truncate font-display text-xl leading-none tracking-wide">
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
        <Badge tone={game.answers > 0 ? "signal" : "default"}>
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
        <div className="space-y-5 p-5">
          <Tabs
            items={[
              { value: "questions", label: `Questions (${game.fields.length})` },
              { value: "ranks", label: `Rank ladder (${game.rankLadder.length})` },
              { value: "settings", label: "Settings" },
            ]}
            value={tab}
            onChange={setTab}
          />

          {tab === "questions" && (
            <QuestionList
              gameId={game.id}
              gameName={game.name}
              rankLadder={game.rankLadder}
              fields={game.fields}
              busy={busy}
              onChanged={onChanged}
            />
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
    </Panel>
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
        <p className="mb-3 text-xs leading-relaxed text-muted">
          {game.isActive
            ? "Active: this section shows on every member's profile."
            : "Hidden: members do not see this section. Every answer is still stored and comes back the moment it is switched on."}
        </p>
        <Button
          size="sm"
          variant={game.isActive ? "ember" : "gold"}
          disabled={busy}
          onClick={() => onSetActive(!game.isActive)}
        >
          {game.isActive ? "Deactivate" : "Activate"}
        </Button>
      </div>

      <div className="border-t border-hair pt-4">
        <Eyebrow className="mb-2">Deleting</Eyebrow>
        <p className="text-xs leading-relaxed text-muted">
          There is deliberately no delete. Deactivating does everything deleting would,
          without taking {plural(game.answers, "stored answer")} with it — and nothing on
          this site is allowed to erase history.
        </p>
      </div>
    </div>
  );
}
