"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import TemplateQuestionList from "./TemplateQuestionList";
import {
  Alert,
  Badge,
  Button,
  ChoiceChip,
  ChoiceRow,
  EmptyState,
  Eyebrow,
  Field,
  Panel,
  Select,
  StatusPill,
  Stepper,
  Tabs,
  Toggle,
  plural,
} from "@/components/ui";
import { EVENT_TYPE_SUGGESTIONS, eventTypeLabel } from "@/components/events/labels";
import type { EventConfig, EventQuestionSpec } from "@/db/schema";
import type { AdminTemplateView, AdminTemplatesView } from "@/lib/admin-templates";
// The pure half, deliberately: `@/lib/admin-templates` builds every Drizzle
// table at import time and a client bundle has no use for any of it.
import {
  MAX_TEMPLATE_TEAMS,
  MIN_TEMPLATE_TEAMS,
  TEMPLATE_OMITS,
  describeTemplate,
} from "@/lib/admin-templates-policy";
import {
  createTemplateAction,
  createTemplateFromEventAction,
  duplicateTemplateAction,
  setTemplateActiveAction,
  updateTemplateAction,
} from "@/app/admin/templates/actions";

/**
 * `/admin/templates`, client side.
 *
 * ## Where the data lives
 *
 * Nowhere here. Every mutation is a server action that revalidates the page and
 * this component refreshes afterwards, so what is on screen is the rows as
 * Postgres has them. The only local state is what is half-typed: a name, a
 * question being edited, which card is open.
 *
 * ## The preview is the same function the server uses
 *
 * `describeTemplate` is imported from the policy module rather than described
 * again here, so "8 teams · bid draft · 11 questions" cannot drift from what
 * `createEvent` would actually produce. It updates as the config is edited,
 * which is the whole reason that function is pure.
 */

export default function TemplatesManager({ view }: { view: AdminTemplatesView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const run = (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? "That did not work.");
      else router.refresh();
    });
  };

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    startTransition(async () => {
      const result = await createTemplateAction({ name });
      if (!result.ok) return setError(result.error);
      setNewName("");
      setOpenId(result.data.id);
      router.refresh();
    });
  };

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      <FromEventPanel
        sources={view.sources}
        busy={pending}
        onDone={(id) => {
          setOpenId(id);
          router.refresh();
        }}
        onError={setError}
      />

      {/* --- From nothing -------------------------------------------- */}
      <Panel as="section">
        <Eyebrow className="mb-3">Or start from nothing</Eyebrow>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Name"
            hint="“Rivals tournament”, “Jackbox night”. Rename it later if you like."
            value={newName}
            maxLength={80}
            wrapperClassName="flex-1 min-w-[16rem]"
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                create();
              }
            }}
          />
          <Button variant="gold" disabled={pending || !newName.trim()} onClick={create}>
            Add template
          </Button>
        </div>
      </Panel>

      {/* --- The templates ------------------------------------------- */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Eyebrow as="h2">Templates · {view.templates.length}</Eyebrow>
          <span className="eyebrow text-muted/70">
            Active ones appear in the create-event picker
          </span>
        </div>

        {view.templates.length === 0 ? (
          <Panel>
            <EmptyState>
              No templates yet. Make one from an event above, or start from nothing — either
              way it shows up in the picker on <span className="font-mono">/admin/events</span>{" "}
              straight away.
            </EmptyState>
          </Panel>
        ) : (
          view.templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              games={view.games}
              profileFields={view.profileFields}
              open={openId === template.id}
              busy={pending}
              onToggleOpen={() => setOpenId(openId === template.id ? null : template.id)}
              onSetActive={(active) => run(() => setTemplateActiveAction(template.id, active))}
              onDuplicate={() =>
                startTransition(async () => {
                  const result = await duplicateTemplateAction(template.id);
                  if (!result.ok) return setError(result.error);
                  setOpenId(result.data.id);
                  router.refresh();
                })
              }
              onSave={(patch) => run(() => updateTemplateAction(template.id, patch))}
            />
          ))
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* From an existing event                                             */
/* ------------------------------------------------------------------ */

/**
 * "Do that again next month."
 *
 * First on the page rather than last, because it is the direction that saves
 * the eleven questions. What it will *not* carry is spelled out rather than
 * discovered: `TEMPLATE_OMITS` is the same list the library's comment gives.
 */
function FromEventPanel({
  sources,
  busy,
  onDone,
  onError,
}: {
  sources: AdminTemplatesView["sources"];
  busy: boolean;
  onDone: (templateId: string) => void;
  onError: (message: string | null) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [eventId, setEventId] = useState("");
  const [name, setName] = useState("");
  const [includeQuestions, setIncludeQuestions] = useState(true);
  const [includeConfig, setIncludeConfig] = useState(true);

  const chosen = sources.find((source) => source.id === eventId) ?? null;

  const make = () => {
    if (!chosen) return;
    onError(null);
    startTransition(async () => {
      const result = await createTemplateFromEventAction(chosen.id, {
        name: name.trim() || undefined,
        includeQuestions,
        includeConfig,
      });
      if (!result.ok) return onError(result.error);
      setEventId("");
      setName("");
      onDone(result.data.id);
    });
  };

  return (
    <Panel as="section" className="rise">
      <Eyebrow className="mb-3">Make one from an event</Eyebrow>

      {sources.length === 0 ? (
        <EmptyState>
          There are no events yet. Once you have run one, this is where you turn it into a
          template.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label="Event"
              hint="Its type, game, format settings and whole question set come across."
              value={eventId}
              wrapperClassName="flex-1 min-w-[18rem]"
              onChange={(event) => setEventId(event.target.value)}
            >
              <option value="">Pick an event…</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.title} · {eventTypeLabel(source.type)} ·{" "}
                  {plural(source.questions, "question")}
                </option>
              ))}
            </Select>
            <Field
              label="Template name"
              hint="Defaults to the event's title."
              value={name}
              maxLength={80}
              placeholder={chosen?.title ?? ""}
              wrapperClassName="flex-1 min-w-[14rem]"
              onChange={(event) => setName(event.target.value)}
            />
            <Button
              variant="gold"
              disabled={busy || pending || !chosen}
              onClick={make}
            >
              Make template
            </Button>
          </div>

          <div className="mt-4 flex flex-wrap gap-6">
            <div>
              <Eyebrow className="mb-2">Copy the question set</Eyebrow>
              <Toggle
                value={includeQuestions}
                onChange={(next) => setIncludeQuestions(next !== false)}
              />
            </div>
            <div>
              <Eyebrow className="mb-2">Copy the format settings</Eyebrow>
              <Toggle
                value={includeConfig}
                onChange={(next) => setIncludeConfig(next !== false)}
              />
            </div>
          </div>

          <p className="mt-4 text-xs leading-relaxed text-muted">
            Not carried over: {TEMPLATE_OMITS.join(", ")}. Days and dates are always
            different next month, capacity and the rank thresholds are decisions about one
            event rather than about a format, and a bracket is generated from the teams that
            actually turn up rather than copied.
          </p>
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* One template                                                       */
/* ------------------------------------------------------------------ */

type TemplatePatch = {
  name?: string;
  type?: string;
  gameId?: string | null;
  config?: EventConfig;
  questions?: EventQuestionSpec[];
};

function TemplateCard({
  template,
  games,
  profileFields,
  open,
  busy,
  onToggleOpen,
  onSetActive,
  onDuplicate,
  onSave,
}: {
  template: AdminTemplateView;
  games: AdminTemplatesView["games"];
  profileFields: AdminTemplatesView["profileFields"];
  open: boolean;
  busy: boolean;
  onToggleOpen: () => void;
  onSetActive: (active: boolean) => void;
  onDuplicate: () => void;
  onSave: (patch: TemplatePatch) => void;
}) {
  const [tab, setTab] = useState<"basics" | "format" | "questions">("basics");

  const [name, setName] = useState(template.name);
  const [type, setType] = useState(template.type);
  const [gameId, setGameId] = useState(template.gameId ?? "");
  const [config, setConfig] = useState<EventConfig>(template.config);
  const [questions, setQuestions] = useState<EventQuestionSpec[]>(template.questions);

  const gameName = games.find((game) => game.id === gameId)?.name ?? null;

  // The live preview, from the same pure function the list header uses and the
  // server would use. Recomputed as the config is edited, which is the point.
  const preview = useMemo(
    () => describeTemplate({ type, config, questions, gameName }),
    [type, config, questions, gameName]
  );

  const dirty =
    name.trim() !== template.name ||
    type !== template.type ||
    (gameId || null) !== template.gameId ||
    JSON.stringify(config) !== JSON.stringify(template.config) ||
    JSON.stringify(questions) !== JSON.stringify(template.questions);

  const save = () =>
    onSave({
      name: name.trim(),
      type,
      gameId: gameId || null,
      config,
      questions,
    });

  const setKnob = (key: keyof EventConfig, value: EventConfig[keyof EventConfig]) =>
    setConfig((current) => {
      const next = { ...current };
      if (value === undefined || value === null) delete next[key];
      else next[key] = value;
      return next;
    });

  const usingCustomType = !EVENT_TYPE_SUGGESTIONS.includes(
    type as (typeof EVENT_TYPE_SUGGESTIONS)[number]
  );

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
              {template.name}
            </span>
            <span className="eyebrow mt-1 block">
              {describeTemplate({
                type: template.type,
                config: template.config,
                questions: template.questions,
                gameName: template.gameName,
              }).join(" · ")}
            </span>
          </span>
        </button>

        <StatusPill
          status={template.isActive ? "open" : "closed"}
          label={template.isActive ? "Active" : "Hidden"}
        />
        <Badge>{eventTypeLabel(template.type)}</Badge>
        <Badge tone={template.events > 0 ? "signal" : "default"}>
          {template.events === 0 ? "never used" : `used ${plural(template.events, "time")}`}
        </Badge>
        {template.liveEvents > 0 && (
          <Badge tone="gold">{plural(template.liveEvents, "event")} running</Badge>
        )}

        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button size="sm" disabled={busy} onClick={onDuplicate}>
            Duplicate
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
              { value: "basics", label: "Basics" },
              { value: "format", label: "Format" },
              { value: "questions", label: `Questions (${questions.length})` },
            ]}
            value={tab}
            onChange={setTab}
          />

          {tab === "basics" && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  label="Name"
                  value={name}
                  maxLength={80}
                  wrapperClassName="flex-1 min-w-[16rem]"
                  onChange={(event) => setName(event.target.value)}
                />
                <Select
                  label="Game"
                  hint="Decides which profile questions a prefill can point at."
                  value={gameId}
                  wrapperClassName="min-w-[14rem]"
                  onChange={(event) => setGameId(event.target.value)}
                >
                  <option value="">No game</option>
                  {games.map((game) => (
                    <option key={game.id} value={game.id}>
                      {game.name}
                      {game.isActive ? "" : " (hidden)"}
                    </option>
                  ))}
                </Select>
              </div>

              <div>
                <Eyebrow className="mb-2">Event type</Eyebrow>
                <ChoiceRow>
                  {EVENT_TYPE_SUGGESTIONS.map((option) => (
                    <ChoiceChip
                      key={option}
                      selected={type === option}
                      onClick={() => setType(option)}
                    >
                      {option}
                    </ChoiceChip>
                  ))}
                  <ChoiceChip
                    selected={usingCustomType}
                    onClick={() => setType(usingCustomType ? "custom" : "")}
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
                    onChange={(event) => setType(event.target.value)}
                  />
                )}
                <p className="mt-2 text-xs text-muted">
                  A type is a label, not a code branch (§8.1) — anything typed here is a
                  valid type the moment it is saved.
                </p>
              </div>

              <div className="border-t border-hair pt-4">
                <Eyebrow className="mb-2">Visibility</Eyebrow>
                <p className="mb-3 text-xs leading-relaxed text-muted">
                  {template.isActive
                    ? "Active: this template appears in the create-event picker."
                    : "Hidden: it is out of the picker. Every event ever made from it is untouched, and switching it back on restores it."}
                </p>
                <Button
                  size="sm"
                  variant={template.isActive ? "ember" : "gold"}
                  disabled={busy}
                  onClick={() => onSetActive(!template.isActive)}
                >
                  {template.isActive ? "Deactivate" : "Activate"}
                </Button>
              </div>
            </div>
          )}

          {tab === "format" && (
            <div className="space-y-5">
              <p className="text-xs leading-relaxed text-muted">
                What an event made from this template starts with. Every one of these is
                still editable on the event afterwards — a template is a starting point, not
                a rule.
              </p>

              <div className="flex flex-wrap gap-8">
                <div>
                  <Eyebrow className="mb-2">Teams</Eyebrow>
                  <Stepper
                    value={typeof config.teams === "number" ? config.teams : null}
                    min={MIN_TEMPLATE_TEAMS}
                    max={MAX_TEMPLATE_TEAMS}
                    aria-label="Teams"
                    onChange={(next) => setKnob("teams", next)}
                  />
                  <p className="mt-1 text-xs text-muted">Empty means no teams at all.</p>
                </div>

                <div>
                  <Eyebrow className="mb-2">Bid draft</Eyebrow>
                  <Toggle
                    value={config.draft ?? null}
                    onChange={(next) => setKnob("draft", next ?? undefined)}
                  />
                </div>

                <div>
                  <Eyebrow className="mb-2">Bracket</Eyebrow>
                  <Toggle
                    value={config.bracket ?? null}
                    onChange={(next) => setKnob("bracket", next ?? undefined)}
                  />
                </div>

                <div>
                  <Eyebrow className="mb-2">Waitlist</Eyebrow>
                  <Toggle
                    value={config.waitlist ?? null}
                    onChange={(next) => setKnob("waitlist", next ?? undefined)}
                  />
                  <p className="mt-1 text-xs text-muted">Unset means on, per §14.</p>
                </div>
              </div>

              {config.format !== undefined && (
                <p className="border border-hair bg-raised/40 p-3 text-xs leading-relaxed text-muted">
                  This template also carries the event&apos;s <strong>format settings</strong>{" "}
                  — the schedule and stage configuration from §10 — which came across whole
                  when it was made from an event. They are not editable here; edit them on an
                  event and make a new template from it.
                </p>
              )}
            </div>
          )}

          {tab === "questions" && (
            <TemplateQuestionList
              questions={questions}
              profileFields={profileFields}
              gameId={gameId || null}
              onChange={setQuestions}
            />
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-hair pt-4">
            <Eyebrow as="span">Would produce</Eyebrow>
            <span className="text-xs text-muted">{preview.join(" · ")}</span>
            <span className="ml-auto flex items-center gap-2">
              {dirty && <span className="text-xs text-gold">Unsaved changes</span>}
              <Button variant="gold" disabled={busy || !dirty} onClick={save}>
                Save template
              </Button>
            </span>
          </div>
        </div>
      )}
    </Panel>
  );
}
