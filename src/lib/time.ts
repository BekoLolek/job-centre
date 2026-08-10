/**
 * Schedule values are stored as absolute instants (ISO 8601 in UTC) so that a match at
 * 18:00 CEST reads as 17:00 BST or 12:00 EDT rather than "18:00" for everyone.
 *
 * The admin types into a `datetime-local` input, which is naive — the browser interprets
 * it in the admin's own zone, and we convert to an instant before it is stored. Readers
 * convert back into whatever zone their browser is in.
 */

/** Accepts an instant, or a legacy naive value, which is read as the viewer's local time. */
export function parseStamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** datetime-local value ("YYYY-MM-DDTHH:mm", the admin's own zone) to a stored instant. */
export function toInstant(localValue: string): string | null {
  const at = parseStamp(localValue);
  return at ? at.toISOString() : null;
}

/** Stored instant back to a value a datetime-local input will accept. */
export function toLocalInput(value: string | null | undefined): string {
  const at = parseStamp(value);
  if (!at) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function addMinutesTo(value: string, minutes: number): string | null {
  const at = parseStamp(value);
  return at ? new Date(at.getTime() + minutes * 60_000).toISOString() : null;
}

/** "16:00" in the viewer's zone. */
export function formatClock(value: string | null | undefined): string | null {
  const at = parseStamp(value);
  if (!at) return null;
  return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "Sat 15 Aug · 16:00" in the viewer's zone. */
export function formatWhen(value: string | null | undefined): string | null {
  const at = parseStamp(value);
  if (!at) return null;
  const day = at.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return `${day} · ${formatClock(value)}`;
}

/** e.g. "Europe/Budapest · CEST" — shown once so nobody has to guess whose clock it is. */
export function zoneLabel(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const short = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
    return short && short !== zone ? `${zone} · ${short}` : zone;
  } catch {
    return "your local time";
  }
}
