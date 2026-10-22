import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVENT_STARTING_LEAD_MS,
  GITHUB_PING_INTERVAL_MS,
  GITHUB_PING_LATENESS_MS,
  SIGNUP_CLOSING_LEAD_MS,
  WORST_RUN_GAP_MS,
} from "@/lib/announce-schedule";

/**
 * The deploy is refused, not the job, when a schedule is wrong.
 *
 * Vercel Hobby only accepts cron jobs that run at most once a day; anything
 * more frequent fails the whole deployment with "Hobby accounts are limited to
 * daily cron jobs". That failure is invisible from the app — production simply
 * stops updating — which is how an hourly reminder schedule held every deploy
 * back for eighteen days. So it is pinned here, where it fails before a push.
 *
 * Since Task 63 there is a second scheduler, and the two are pinned *against*
 * each other: the Vercel entry must stay daily, because more would refuse the
 * deploy, and the GitHub workflow must stay frequent, because a two-hour
 * reminder (R-207) cannot come out of a daily run. Loosen either and the other
 * one's reason stops being true.
 */

type Cron = { path: string; schedule: string };

const ROUTE = "/api/cron/reminders";

const config = JSON.parse(
  readFileSync(join(process.cwd(), "vercel.json"), "utf8")
) as { crons?: Cron[] };

const WORKFLOW_PATH = join(process.cwd(), ".github", "workflows", "cron.yml");
const workflow = readFileSync(WORKFLOW_PATH, "utf8");

/**
 * The workflow with every comment line taken out.
 *
 * Every assertion about what the workflow *does* is made against this and not
 * against the file, and that is not tidiness. This file's comments name
 * `CRON_SECRET`, the route's path and the cadence in prose, so `toContain` over
 * the raw text would be satisfied by the explanation of a step that had been
 * deleted. A comment claiming the workflow pings something is exactly the
 * mutation that has escaped on this project before.
 */
const body = workflow
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/**
 * One step's `run:` script, dedented, straight out of the real file.
 *
 * Hand-rolled rather than through a YAML library, because there is no YAML
 * dependency and adding one to read two blocks would be the larger change. It
 * is deliberately strict: it finds the step by its `- name:` line, requires the
 * very next thing it meets to be this step's own `run: |`, and stops at the
 * first line that is not blank and not indented past the block. A rename, a
 * reorder or a deleted step makes it throw rather than silently return "".
 */
function runScript(stepName: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start === -1) throw new Error(`No step called ${stepName} in cron.yml`);

  const open = lines.findIndex((line, index) => index > start && /^\s*run: \|\s*$/.test(line));
  if (open === -1) throw new Error(`The ${stepName} step has no "run: |" block`);

  // The `run:` found must belong to this step, not to a later one — otherwise a
  // step whose script had been deleted would quietly borrow the next step's.
  const nextStep = lines.findIndex((line, index) => index > start && /^\s*- name: /.test(line));
  if (nextStep !== -1 && open > nextStep) {
    throw new Error(`The ${stepName} step has no "run: |" block of its own`);
  }

  const indent = (lines[open].match(/^\s*/) ?? [""])[0].length;
  const out: string[] = [];
  for (const line of lines.slice(open + 1)) {
    if (line.trim() === "") {
      out.push("");
      continue;
    }
    const depth = (line.match(/^\s*/) ?? [""])[0].length;
    if (depth <= indent) break;
    out.push(line.slice(indent + 2));
  }
  return out.join("\n");
}

/**
 * A POSIX shell that actually works on this machine.
 *
 * Not simply `"bash"`. On Windows a bare `bash` resolves to
 * `System32\bash.exe`, the WSL launcher, which answers
 * `execvpe(/bin/bash) failed` on a machine with no distro installed — so the
 * candidate has to be *tried* rather than looked up. On a CI runner the first
 * candidate wins immediately.
 */
const SHELL = (() => {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const candidates = [
    process.env.SHELL,
    "bash",
    "sh",
    `${programFiles}\\Git\\bin\\bash.exe`,
    `${programFiles}\\Git\\usr\\bin\\bash.exe`,
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-c", "echo shell-ok"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0 && (probe.stdout ?? "").includes("shell-ok")) {
      return candidate;
    }
  }
  return null;
})();

/**
 * Run a step's script, for real, with exactly this environment.
 *
 * `CRON_SECRET` and `CRON_URL` are deleted from the inherited environment
 * before the overrides go on: a developer who has the real secret exported in
 * their own shell must not be the reason the "no secret" case passes.
 */
function runStep(
  stepName: string,
  env: Record<string, string>
): { status: number | null; output: string } {
  if (SHELL === null) {
    throw new Error(
      "No POSIX shell was found to run the workflow's own guard against. Install Git Bash, or run the suite where `bash` exists."
    );
  }
  const inherited = { ...process.env };
  delete inherited.CRON_SECRET;
  delete inherited.CRON_URL;

  const result = spawnSync(SHELL, ["-c", runScript(stepName)], {
    encoding: "utf8",
    env: { ...inherited, ...env },
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/* ------------------------------------------------------------------ */
/* The Vercel backstop                                                */
/* ------------------------------------------------------------------ */

describe("vercel.json crons", () => {
  it("has the reminders job", () => {
    expect(config.crons?.map((cron) => cron.path)).toContain(ROUTE);
  });

  it.each(config.crons ?? [])("$path runs at most once a day ($schedule)", ({ schedule }) => {
    const fields = schedule.trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    const [minute, hour] = fields;
    // A single fixed minute and hour is once a day at most. Anything else —
    // `*`, a step, a list or a range — runs more often.
    expect(minute).toMatch(/^\d{1,2}$/);
    expect(hour).toMatch(/^\d{1,2}$/);
  });
});

/* ------------------------------------------------------------------ */
/* The GitHub workflow, which is the one that actually fires           */
/* ------------------------------------------------------------------ */

/** The `- cron: "…"` entries the workflow schedules itself on. */
function workflowCrons(): string[] {
  return [...body.matchAll(/^\s*- cron:\s*["']([^"']+)["']\s*$/gm)].map((match) => match[1]);
}

describe("the GitHub workflow", () => {
  it("schedules itself, and on exactly one cadence", () => {
    expect(workflowCrons()).toEqual(["*/15 * * * *"]);
  });

  it("pings the reminders route, with the secret in a header and not the URL", () => {
    expect(body).toContain(ROUTE);
    // The one thing that must never be true of this file: a credential in a
    // query string ends up in every access log between here and the app.
    expect(body).not.toMatch(/\?[^\s"']*(secret|token|authorization)/i);
    expect(body).toMatch(/Authorization: Bearer/);
  });

  it("refuses before it pings: the check is an earlier step", () => {
    const check = body.indexOf("- name: Check the configuration");
    const ping = body.indexOf("- name: Ping the reminders endpoint");
    expect(check).toBeGreaterThan(-1);
    expect(ping).toBeGreaterThan(check);
  });

  /**
   * The secret is read, never written.
   *
   * Asserted as "no `CRON_SECRET` is ever followed by a literal" rather than as
   * "the file does not contain a token", because nobody can write a pattern for
   * "a token" — and the mutation that matters is somebody pasting a working
   * value in to test it and leaving it there.
   */
  it("carries no secret of its own", () => {
    for (const line of body.split("\n")) {
      const assignment = /CRON_SECRET\s*[:=]\s*(.+)$/.exec(line);
      if (!assignment) continue;
      expect(assignment[1].trim()).toMatch(/^\$\{\{\s*secrets\.CRON_SECRET\s*\}\}$/);
    }
    // And the reference itself is there, so the loop above is not vacuous on a
    // file that stopped mentioning the secret at all.
    expect(body).toContain("${{ secrets.CRON_SECRET }}");
  });

  it("takes the URL from a variable, so no deployment address is baked in", () => {
    expect(body).toContain("${{ vars.CRON_URL }}");
    expect(body).not.toMatch(/https?:\/\/(?!localhost)/);
  });
});

/**
 * The workflow's own failure mode when it is not configured (R-206, R-207 —
 * "the workflow fails closed without the secret").
 *
 * The real script, run under a real shell, rather than a regex over the YAML
 * claiming it would exit. A guard asserted by `toContain("exit 1")` passes just
 * as well when the `if` around it has been inverted.
 */
describe("the workflow without its configuration", () => {
  const CONFIGURED = { CRON_SECRET: "a-test-value", CRON_URL: "https://example.test" };

  it("fails, naming the secret, when the secret is missing", () => {
    const { status, output } = runStep("Check the configuration", {
      CRON_URL: CONFIGURED.CRON_URL,
    });
    expect(status).not.toBe(0);
    expect(output).toContain("CRON_SECRET");
    // The specific message, not just a non-zero exit: the whole reason this
    // step exists is that "401 from the app" and "nobody set the secret" look
    // identical in a run log and have different fixes.
    expect(output).toContain("::error::Not configured yet — missing: CRON_SECRET (secret)");
  });

  it("fails, naming the URL, when the URL is missing", () => {
    const { status, output } = runStep("Check the configuration", {
      CRON_SECRET: CONFIGURED.CRON_SECRET,
    });
    expect(status).not.toBe(0);
    expect(output).toContain("::error::Not configured yet — missing: CRON_URL (variable)");
  });

  it("names both when neither is set", () => {
    const { status, output } = runStep("Check the configuration", {});
    expect(status).not.toBe(0);
    expect(output).toContain("CRON_SECRET (secret)");
    expect(output).toContain("CRON_URL (variable)");
  });

  it("says nothing and succeeds once both are set", () => {
    const { status, output } = runStep("Check the configuration", CONFIGURED);
    expect(status).toBe(0);
    expect(output).not.toContain("::error::");
  });

  it("does not treat an empty secret as a secret", () => {
    // The case a `-z`/`-n` mix-up produces, and the case GitHub actually hands
    // the job before anybody has set anything: the name is defined and blank.
    const { status, output } = runStep("Check the configuration", {
      CRON_SECRET: "",
      CRON_URL: CONFIGURED.CRON_URL,
    });
    expect(status).not.toBe(0);
    expect(output).toContain("CRON_SECRET (secret)");
  });
});

/**
 * The two schedules, read against the windows that depend on them.
 *
 * This is the cross-check the two halves of Task 63 need: the windows in
 * `announce-schedule.ts` are only wide enough *because* the workflow wakes
 * every quarter hour. Widen the cadence without widening the window and the
 * two-hour reminder starts missing events — silently, on the nights it matters.
 */
describe("the cadence and the windows agree", () => {
  /** The workflow's nominal interval, in ms, read out of its cron expression. */
  function intervalFromCron(expression: string): number {
    const [minute, hour, ...rest] = expression.trim().split(/\s+/);
    expect(rest).toHaveLength(3);
    expect(hour).toBe("*");
    const step = /^\*\/(\d{1,2})$/.exec(minute);
    if (!step) throw new Error(`Not a minute-step schedule: ${expression}`);
    return Number(step[1]) * 60 * 1000;
  }

  it("wakes as often as the module says it does", () => {
    expect(intervalFromCron(workflowCrons()[0])).toBe(GITHUB_PING_INTERVAL_MS);
  });

  it("wakes far more often than the Vercel backstop can", () => {
    const vercel = config.crons?.find((cron) => cron.path === ROUTE);
    expect(vercel?.schedule).toBeDefined();
    expect(intervalFromCron(workflowCrons()[0])).toBeLessThan(24 * 60 * 60 * 1000);
  });

  /**
   * The lateness allowance is the whole point of the arithmetic, so it is
   * asserted as a number rather than as "greater than zero": a run may be a
   * quarter of an hour late, so two runs that happened may be half an hour
   * apart, and a window narrower than that can fall between them.
   */
  it("leaves room for a run that is a quarter of an hour late", () => {
    expect(GITHUB_PING_LATENESS_MS).toBe(15 * 60 * 1000);
    expect(WORST_RUN_GAP_MS).toBe(GITHUB_PING_INTERVAL_MS + GITHUB_PING_LATENESS_MS);
    expect(WORST_RUN_GAP_MS).toBe(30 * 60 * 1000);
  });

  it("gives the narrower window four times the worst gap", () => {
    expect(EVENT_STARTING_LEAD_MS).toBeGreaterThanOrEqual(WORST_RUN_GAP_MS);
    expect(SIGNUP_CLOSING_LEAD_MS).toBeGreaterThanOrEqual(WORST_RUN_GAP_MS);
    expect(EVENT_STARTING_LEAD_MS / WORST_RUN_GAP_MS).toBe(4);
  });
});
