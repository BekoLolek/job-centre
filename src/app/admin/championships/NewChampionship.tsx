"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert, Button, Field, Section, Textarea } from "@/components/ui";
import { createChampionshipAction } from "./actions";

/**
 * The create box on `/admin/championships` — UC-31 1 and 2.
 *
 * A name and, if they are known yet, the months. Everything else is the
 * editor's job, which is why a new season is hidden: an admin naming next
 * year's season in October must not publish it by accident.
 *
 * On success it goes straight to the editor, because the next thing anybody
 * wants is the points table.
 */

export default function NewChampionship() {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [runsFrom, setRunsFrom] = useState("");
  const [runsTo, setRunsTo] = useState("");

  const create = () => {
    if (!name.trim()) return;
    setError(null);
    start(async () => {
      try {
        const result = await createChampionshipAction({
          name,
          description: description.trim() || null,
          runsFrom: runsFrom || null,
          runsTo: runsTo || null,
        });
        if (!result.ok) return setError(result.error);
        router.push(`/admin/championships/${result.data.id}`);
      } catch {
        setError("Could not reach the server.");
      }
    });
  };

  return (
    <Section
      first
      icon="spark"
      title="Start a season"
      description="Saved hidden, with the default points table. Only admins can see it until you publish it."
      className="rise"
    >
      {error && <Alert className="mb-4">{error}</Alert>}

      <div className="space-y-4">
        <Field
          label="Name"
          hint="“Winter 2026”, “Season 3”. The public address is made from it and never changes afterwards."
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
        <Textarea
          label="Description"
          hint="Optional. What the season is, and what counts towards it."
          value={description}
          rows={2}
          maxLength={2000}
          onChange={(event) => setDescription(event.target.value)}
        />
        <div className="flex flex-wrap items-end gap-4">
          <Field
            label="Runs from"
            type="month"
            value={runsFrom}
            wrapperClassName="min-w-[10rem]"
            onChange={(event) => setRunsFrom(event.target.value)}
          />
          <Field
            label="Runs to"
            type="month"
            value={runsTo}
            wrapperClassName="min-w-[10rem]"
            onChange={(event) => setRunsTo(event.target.value)}
          />
          <Button variant="union" disabled={busy || !name.trim()} onClick={create}>
            {busy ? "Creating…" : "Create it"}
          </Button>
        </div>
      </div>
    </Section>
  );
}
