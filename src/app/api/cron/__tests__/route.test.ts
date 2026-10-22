import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/reminders/route";
import { sendDueReminders } from "@/lib/notifications";

/**
 * The endpoint the schedulers ping, and the two refusals that make it safe to
 * leave lying around.
 *
 * This route is the one piece of this feature with a **public URL**. Anybody
 * may send it a GET, and what it does on a good day is direct-message every
 * seat holder in the place — so "who is allowed to wake it" is the whole
 * security model, and until now it was the one part of it with no test.
 *
 * Both refusals are asserted on **the body as well as the status**, because the
 * two have different fixes and a bare `ok === false` cannot tell them apart:
 * 503 means nobody configured a secret, 401 means somebody pinged with the
 * wrong one. A test that accepted either would pass on a route that had
 * collapsed them into a single answer.
 */

vi.mock("@/lib/notifications", () => ({
  sendDueReminders: vi.fn(async () => ({ events: 2, delivered: 3, asking: 1, asked: 1 })),
}));

const run = vi.mocked(sendDueReminders);

const SECRET = "not-a-real-secret-just-a-test-value";

let hadSecret: string | undefined;

beforeEach(() => {
  hadSecret = process.env.CRON_SECRET;
  run.mockClear();
});

afterEach(() => {
  if (hadSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = hadSecret;
});

/** A request with whatever `Authorization` header the test wants, or none. */
function ping(authorization?: string): Request {
  return new Request("https://example.test/api/cron/reminders", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe("the reminders endpoint with no secret configured", () => {
  it("is closed, and says that is why", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(ping(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "CRON_SECRET is not set, so this endpoint is closed.",
    });
  });

  it("does not default to open for a request with no credentials at all", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(ping());
    expect(response.status).toBe(503);
    // The thing that actually matters: nothing was sent to anybody.
    expect(run).not.toHaveBeenCalled();
  });

  it("treats a secret of only whitespace as no secret", async () => {
    // The shape an unset Vercel variable or an empty GitHub secret arrives in.
    // Without the `.trim()`, `Bearer "   "` would be a working credential that
    // anybody could guess.
    process.env.CRON_SECRET = "   ";

    const response = await GET(ping("Bearer    "));
    expect(response.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the reminders endpoint with a secret configured", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });

  it("refuses a request with no Authorization header", async () => {
    const response = await GET(ping());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses the wrong secret", async () => {
    const response = await GET(ping("Bearer something-else"));
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses the right secret offered the wrong way", async () => {
    // Vercel and the workflow both send `Bearer <secret>`. A bare secret is
    // not that, and accepting it would widen the one check this route has.
    const response = await GET(ping(SECRET));
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the reminders for the right secret, and reports what went out", async () => {
    const response = await GET(ping(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    // The counts, not just `ok`: a run log that says `{"ok":true}` and nothing
    // else cannot tell a working schedule from one that found no events.
    await expect(response.json()).resolves.toEqual({
      ok: true,
      events: 2,
      delivered: 3,
      asking: 1,
      asked: 1,
    });
  });

  it("answers 500, without leaking the reason, when a run fails", async () => {
    run.mockRejectedValueOnce(new Error("the database is on fire"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(ping(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Reminders failed." });
    // Logged for whoever is watching, and not handed to whoever asked.
    expect(errors).toHaveBeenCalled();

    errors.mockRestore();
  });
});
