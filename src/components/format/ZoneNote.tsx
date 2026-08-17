"use client";

import { useEffect, useState } from "react";
import { Eyebrow } from "@/components/ui";
import { zoneLabel } from "@/lib/time";

/**
 * "Times in Europe/Budapest · CEST".
 *
 * Said once per board, out loud, because a wall of times with no zone next to
 * them is the single easiest way to make somebody miss their match. The legacy
 * board did this and it is carried over unchanged in spirit.
 *
 * The zone is resolved in an effect rather than during render: the server's
 * answer would be the deployment's zone, and printing that even for one frame
 * is worse than printing nothing.
 */

export type ZoneNoteProps = {
  /** Words in front of the zone. */
  prefix?: string;
  className?: string;
};

export default function ZoneNote({ prefix = "Times in", className }: ZoneNoteProps) {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => setZone(zoneLabel()), []);

  if (!zone) return null;
  return (
    <Eyebrow as="span" className={className}>
      {prefix} {zone}
    </Eyebrow>
  );
}
