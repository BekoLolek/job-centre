import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/reminders/route";
import { postDueAnnouncements } from "@/lib/discord";
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

/*
 * The channel half of the same wake (R-205, R-206, R-207 / UC-38 2, 3, 4).
 *
 * Mocked rather than exercised: `discord.test.ts` is where `postDueAnnouncements`
 * is tested against a real database and a fake Discord. What this file is for is
 * the one thing only the route can get wrong — that neither half runs for a
 * request that was refused.
 */
vi.mock("@/lib/discord", () => ({
  postDueAnnouncements: vi.fn(async () => ({
    posted: [{ kind: "event_starting_soon", eventId: "e1" }],
  })),
}));

const run = vi.mocked(sendDueReminders);
const announce = vi.mocked(postDueAnnouncements);

const SECRET = "not-a-real-secret-just-a-test-value";

let hadSecret: string | undefined;

beforeEach(() => {
  hadSecret = process.env.CRON_SECRET;
  run.mockClear();
  announce.mockClear();
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
    // And nothing was posted to the channel either. This endpoint is public:
    // the refusal has to cover both halves of what a good day does, and before
    // Task 68 there was only one half to cover.
    expect(announce).not.toHaveBeenCalled();
  });

  it("treats a secret of only whitespace as no secret", async () => {
    // The shape an unset Vercel variable or an empty GitHub secret arrives in.
    // Without the `.trim()`, `Bearer "   "` would be a working credential that
    // anybody could guess.
    process.env.CRON_SECRET = "   ";

    const response = await GET(ping("Bearer    "));
    expect(response.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
    // And nothing was posted to the channel either. This endpoint is public:
    // the refusal has to cover both halves of what a good day does, and before
    // Task 68 there was only one half to cover.
    expect(announce).not.toHaveBeenCalled();
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
    // And nothing was posted to the channel either. This endpoint is public:
    // the refusal has to cover both halves of what a good day does, and before
    // Task 68 there was only one half to cover.
    expect(announce).not.toHaveBeenCalled();
  });

  it("refuses the wrong secret", async () => {
    const response = await GET(ping("Bearer something-else"));
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    // And nothing was posted to the channel either. This endpoint is public:
    // the refusal has to cover both halves of what a good day does, and before
    // Task 68 there was only one half to cover.
    expect(announce).not.toHaveBeenCalled();
  });

  it("refuses the right secret offered the wrong way", async () => {
    // Vercel and the workflow both send `Bearer <secret>`. A bare secret is
    // not that, and accepting it would widen the one check this route has.
    const response = await GET(ping(SECRET));
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    // And nothing was posted to the channel either. This endpoint is public:
    // the refusal has to cover both halves of what a good day does, and before
    // Task 68 there was only one half to cover.
    expect(announce).not.toHaveBeenCalled();
  });

  it("runs the reminders and the announcements, and reports what went out", async () => {
    const response = await GET(ping(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    // Both halves of the wake, each exactly once. The announcements are not an
    // afterthought here: before Task 68 nothing posted them at all, so "the
    // route still only sends DMs" is the regression this names.
    expect(announce).toHaveBeenCalledTimes(1);
    // The counts, not just `ok`: a run log that says `{"ok":true}` and nothing
    // else cannot tell a working schedule from one that found no events.
    await expect(response.json()).resolves.toEqual({
      ok: true,
      events: 2,
      delivered: 3,
      asking: 1,
      asked: 1,
      announcements: 1,
    });
  });

  it("reports a quiet run as nought announcements rather than leaving it out", async () => {
    // The ordinary case — most wakes have nothing due — and a body with the key
    // missing would be indistinguishable from a deployment where the posting
    // step was never wired in.
    announce.mockResolvedValueOnce({ posted: [] });

    const response = await GET(ping(`Bearer ${SECRET}`));
    await expect(response.json()).resolves.toMatchObject({ ok: true, announcements: 0 });
  });

  it("answers 500 when the announcements fail, without leaking the reason", async () => {
    // The other half of the failure path: a channel that went quiet because the
    // posting step threw must not be reported as a successful run.
    announce.mockRejectedValueOnce(new Error("the webhook is on fire"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(ping(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Reminders failed." });
    expect(errors).toHaveBeenCalled();

    errors.mockRestore();
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
