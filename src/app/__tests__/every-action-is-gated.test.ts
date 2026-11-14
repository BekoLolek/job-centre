/**
 * Every entry point names a guard before it does anything else (R-261, R-265).
 *
 * ## Why this is a sweep
 *
 * There is no middleware, no admin layout and no shared entry point on this
 * site. Each server action, each admin page and each route handler gates
 * itself, with one guard call at the top. So **a missed call site is a silent
 * hole, not an error**: nothing fails, nothing logs, and the action is simply
 * public. "Hiding is not permission" - the screen that does not offer a button
 * is never what stops the POST behind it.
 *
 * Roughly a hundred of those first lines are about to change (decision 007).
 * Reading them once proves nothing about the hundred-and-first, so this file
 * reads them every run.
 *
 * ## What counts as an entry point
 *
 *  - **Every export of a `"use server"` module**, wherever it lives under
 *    `src`. Each one is a POST endpoint, whatever it is named and whether or
 *    not any screen calls it.
 *  - **Every function whose body opens with `"use server"`** - an inline
 *    action is the same endpoint, declared somewhere less obvious. A method on
 *    an object counts.
 *  - **Every admin page**: the default export of a `page`, `layout`,
 *    `template` or `default` file, `.tsx` or `.ts`, anywhere under
 *    `src/app/admin`, and its `generateMetadata` and `generateViewport`, which
 *    run for the same request and whose answer Next sends even in the body of
 *    a redirect.
 *  - **Every route handler**: the HTTP-method exports of a `route.ts`.
 *
 * ## What counts as gated
 *
 * A top-level statement of the function, `await guard(...)` or
 * `const x = await guard(...)`, where `guard` is one of
 * {@link REFUSING_GUARDS} **imported from `session-guards`**, and where
 * nothing ran ahead of it. "Ran" means a call, a `new`, a tagged template, a
 * `return` or a `throw` - in the body or in a parameter's default.
 * `await params` is none of those, and neither is a guard's own callback
 * argument.
 *
 * Deliberately strict, and strict in the direction of failing: a guard inside
 * an `if` or a `try`, a guard that is not awaited, a guard wrapped in
 * `Promise.all` beside a query, and an export written in a shape this file
 * cannot follow are all refused. The answer to any of those is to write the
 * boring first line, or to say why not in `gated-allowlist.ts`.
 *
 * ## `getCurrentUser` is not one of them
 *
 * It identifies a caller and refuses nobody: a stranger gets `null` back and
 * the function carries on. If it counted, any `requireAdmin` first line could
 * become `getCurrentUser` and this file would stay green - the exact hole it
 * exists to catch. So it is accepted at **two pinned sites and nowhere else**,
 * each with its reason in `IDENTIFY_ONLY_SITES`:
 *
 *  - `loadRoomAction` in `src/app/events/[slug]/draft/actions.ts`, which is
 *    public by design and hands the user, or `null`, to `loadRoom`;
 *  - `drawAction` in `src/app/events/[slug]/draw/actions.ts`, which returns a
 *    refusal on the next line when there is nobody.
 *
 * **On an admin entry point it is refused outright**, listed or not.
 *
 * ## Parsed, not matched
 *
 * `field-ordering.test.ts` reads JSX by hand and a comment inside a tag breaks
 * it. This file uses the TypeScript parser that is already a dev dependency,
 * so a comment, a line break or a renamed import is the parser's problem. The
 * first `describe` below then proves the reader sees what it claims to, on
 * source written for the purpose.
 *
 * ## What this does not prove
 *
 * That the guard is the *right* one of the six - `requireUser` on an action
 * that wanted `requireAdmin` passes here. Which guard belongs on which action
 * is what each action's own behaviour tests are for. The one exception is
 * `src/app/admin/events/actions.ts` and `src/app/admin/host/actions.ts`, whose
 * guards a test below lists action by action (Task 126).
 *
 * And it reads only what it can find. Where a form of entry point is not read
 * - a route group, a script that is not TypeScript, an admin `loading` or
 * `opengraph-image` or the like - a test below asserts that
 * the tree holds none, so the day one appears this file says so instead of
 * passing around it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  GATE_EXCEPTIONS,
  type GateException,
  IDENTIFY_ONLY_SITES,
  type IdentifiedOnly,
} from "./gated-allowlist";

/**
 * The guards that turn somebody away. A test below fails if a name here is
 * not exported from `session-guards.ts`.
 */
const REFUSING_GUARDS = [
  "requireUser",
  "requireAdmin",
  "requirePermission",
  "requireAnyPermission",
  "requireEventManager",
  "requireManagerOfChild",
];

/** Identifies and refuses nobody - see the docblock. Recognised so that it can be refused by name. */
const IDENTIFYING_GUARD = "getCurrentUser";

const GUARD_MODULE = /(^|\/)session-guards$/;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const ADMIN_AREA = "src/app/admin/";
// `.ts` as well as `.tsx`: a layout that only gates returns `children` and needs no JSX.
const ADMIN_FILE = /^src\/app\/admin\/(.+\/)?(page|layout|template|default)\.tsx?$/;
/*
 * The other files Next gives a meaning to by name. None of them is behind the
 * page's guard: a `loading` is a fallback that can be sent before the guard
 * resolves, an `opengraph-image` or `icon` is a URL of its own, and the rest
 * render in place of a page that refused. None exists under admin, and the
 * sweep does not read them - so one appearing is refused until it does.
 */
const ADMIN_FILE_NOT_READ =
  /^src\/app\/admin\/(.+\/)?(loading|not-found|forbidden|unauthorized|opengraph-image|twitter-image|icon|apple-icon)\.[a-z]+$/;
const ADMIN_ENTRY_POINTS = new Set(["default", "generateMetadata", "generateViewport"]);

/*
 * What the tree held when this was written. A sweep that finds nothing passes
 * for ever, so these are asserted before anything is concluded from the
 * absence of offences. Raise them as the site grows, and treat having to lower
 * one as a question about where the code went.
 */
const FLOORS = {
  actionModules: 21,
  actions: 117,
  inlineActions: 3,
  adminPageEntryPoints: 15,
  routeHandlers: 3,
};

/* ------------------------------------------------------------------ */
/* Reading one file                                                   */
/* ------------------------------------------------------------------ */

type FunctionNode = ts.FunctionLikeDeclaration;

type Site = {
  /** `src/app/admin/games/actions.ts#createGameAction` */
  site: string;
  kind: "action" | "inline action" | "admin page" | "route";
  /** The guard awaited as a statement of its own, if there is one. */
  guard: string | null;
  /** What runs ahead of that guard - or, with no guard, everything the body runs - in order. */
  before: string[];
  /** Exported in a shape this file cannot follow to a function body. */
  unreadable: boolean;
};

function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function isUseServer(statement: ts.Statement | undefined): boolean {
  return (
    statement !== undefined &&
    ts.isExpressionStatement(statement) &&
    ts.isStringLiteral(statement.expression) &&
    statement.expression.text === "use server"
  );
}

function isFunctionNode(node: ts.Node | undefined): node is FunctionNode {
  return node !== undefined && ts.isFunctionLike(node) && "body" in node;
}

/** Local name -> the guard it is, for what this file imports from `session-guards`. */
function importedGuards(sf: ts.SourceFile): Map<string, string> {
  const known = new Set([...REFUSING_GUARDS, IDENTIFYING_GUARD]);
  const found = new Map<string, string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!GUARD_MODULE.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || statement.importClause?.isTypeOnly) continue;
    for (const element of bindings.elements) {
      const original = (element.propertyName ?? element.name).text;
      if (!element.isTypeOnly && known.has(original)) found.set(element.name.text, original);
    }
  }
  return found;
}

/**
 * Everything `node` does that a guard has to come before, in the order it
 * runs - arguments before the call they are passed to. A call, a `new` and a
 * tagged template by name; a `return` and a `throw` as themselves, because
 * answering a stranger is doing something. Does not look inside a nested
 * function: defining a callback is not calling it, which is what lets
 * `requireManagerOfChild` take its resolver.
 */
function actsIn(node: ts.Node, sf: ts.SourceFile): string[] {
  const found: string[] = [];
  const name = (callee: ts.Node) => callee.getText(sf).replace(/\s+/g, "");
  const visit = (child: ts.Node): void => {
    if (ts.isFunctionLike(child)) return;
    ts.forEachChild(child, visit);
    if (ts.isCallExpression(child)) found.push(name(child.expression));
    else if (ts.isNewExpression(child)) found.push(`new ${name(child.expression)}`);
    else if (ts.isTaggedTemplateExpression(child)) found.push(name(child.tag));
    else if (ts.isReturnStatement(child)) found.push("return");
    else if (ts.isThrowStatement(child)) found.push("throw");
  };
  visit(node);
  return found;
}

/** `await guard(...)` or `const x = await guard(...)`, as a whole statement. */
function guardCall(
  statement: ts.Statement,
  guards: Map<string, string>
): { guard: string; call: ts.CallExpression } | null {
  let expression: ts.Expression | undefined;
  if (ts.isExpressionStatement(statement)) expression = statement.expression;
  else if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    expression = statement.declarationList.declarations[0].initializer;
  }
  if (!expression || !ts.isAwaitExpression(expression)) return null;
  const call = expression.expression;
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null;
  const guard = guards.get(call.expression.text);
  return guard ? { guard, call } : null;
}

function gateOf(
  fn: FunctionNode | null,
  guards: Map<string, string>,
  sf: ts.SourceFile
): Pick<Site, "guard" | "before" | "unreadable"> {
  if (!fn || !fn.body || !ts.isBlock(fn.body)) return { guard: null, before: [], unreadable: true };
  // A parameter's default runs before the first statement does.
  const before = fn.parameters.flatMap((parameter) => actsIn(parameter, sf));
  for (const statement of fn.body.statements) {
    const found = guardCall(statement, guards);
    if (found) {
      before.push(...found.call.arguments.flatMap((argument) => actsIn(argument, sf)));
      return { guard: found.guard, before, unreadable: false };
    }
    before.push(...actsIn(statement, sf));
  }
  return { guard: null, before, unreadable: false };
}

type Exported = { name: string; fn: FunctionNode | null };

/** Every value a module exports, with the function behind it where one can be found. */
function exportedValues(sf: ts.SourceFile): Exported[] {
  const local = new Map<string, FunctionNode>();
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) local.set(statement.name.text, statement);
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && isFunctionNode(declaration.initializer)) {
        local.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const resolve = (node: ts.Node | undefined): FunctionNode | null => {
    if (isFunctionNode(node)) return node;
    return node && ts.isIdentifier(node) ? (local.get(node.text) ?? null) : null;
  };
  const has = (statement: ts.Statement, kind: ts.SyntaxKind) =>
    ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((m) => m.kind === kind);

  return sf.statements.flatMap((statement): Exported[] => {
    if (ts.isExportAssignment(statement)) return [{ name: "default", fn: resolve(statement.expression) }];
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) return [];
      const clause = statement.exportClause;
      // `export * from "./x"`: a name cannot be given, so the statement stands in for one.
      if (!clause || !ts.isNamedExports(clause)) return [{ name: statement.getText(sf), fn: null }];
      return clause.elements
        .filter((element) => !element.isTypeOnly)
        .map((element) => ({
          name: element.name.text,
          fn: statement.moduleSpecifier ? null : resolve(element.propertyName ?? element.name),
        }));
    }
    if (!has(statement, ts.SyntaxKind.ExportKeyword)) return [];
    if (ts.isFunctionDeclaration(statement)) {
      const named = has(statement, ts.SyntaxKind.DefaultKeyword) ? undefined : statement.name?.text;
      return [{ name: named ?? "default", fn: statement }];
    }
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.flatMap((declaration): Exported[] => {
      if (ts.isIdentifier(declaration.name)) {
        return [{ name: declaration.name.text, fn: resolve(declaration.initializer) }];
      }
      // `export const { GET, POST } = handlers` - names, and no body to read.
      return declaration.name.elements.flatMap((element) =>
        ts.isBindingElement(element) && ts.isIdentifier(element.name) ? [{ name: element.name.text, fn: null }] : []
      );
    });
  });
}

/** Functions whose own body opens with `"use server"`, wherever and however they are declared. */
function inlineActions(sf: ts.SourceFile): { name: string; fn: FunctionNode }[] {
  const found: { name: string; fn: FunctionNode }[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionNode(node) && node.body && ts.isBlock(node.body) && isUseServer(node.body.statements[0])) {
      const declared = ts.isVariableDeclaration(node.parent) ? node.parent.name : node.name;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      found.push({ name: declared && ts.isIdentifier(declared) ? declared.text : `line ${line}`, fn: node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Every entry point in one file. `file` is the path from the repository root. */
function sitesIn(file: string, source: string): Site[] {
  const sf = parse(file, source);
  const guards = importedGuards(sf);
  const site = (kind: Site["kind"], name: string, fn: FunctionNode | null): Site => ({
    site: `${file}#${name}`,
    kind,
    ...gateOf(fn, guards, sf),
  });
  // A page is named for its component, so a failure reads as the thing somebody wrote.
  const pageName = ({ name, fn }: Exported) =>
    name === "default" && fn?.name && ts.isIdentifier(fn.name) ? fn.name.text : name;

  const sites: Site[] = [];
  if (isUseServer(sf.statements[0])) {
    sites.push(...exportedValues(sf).map(({ name, fn }) => site("action", name, fn)));
  }
  sites.push(...inlineActions(sf).map(({ name, fn }) => site("inline action", name, fn)));
  if (ADMIN_FILE.test(file)) {
    const entries = exportedValues(sf).filter(({ name }) => ADMIN_ENTRY_POINTS.has(name));
    sites.push(...entries.map((entry) => site("admin page", pageName(entry), entry.fn)));
  }
  if (/^src\/app\/(.+\/)?route\.tsx?$/.test(file)) {
    const handlers = exportedValues(sf).filter(({ name }) => HTTP_METHODS.has(name));
    sites.push(...handlers.map(({ name, fn }) => site("route", name, fn)));
  }
  return sites;
}

/**
 * Files in a form `sitesIn` does not read. Each is a way an entry point could
 * sit outside this sweep, so each is refused until the sweep is taught it.
 */
function unreadFiles(files: readonly string[]): string[] {
  return files.flatMap((file) => {
    if (/\.([cm]?jsx?|[cm]ts)$/.test(file)) {
      return [`${file} is a script this sweep does not parse - it reads .ts and .tsx only`];
    }
    if (ADMIN_FILE_NOT_READ.test(file)) {
      return [`${file} is an admin file Next serves outside the page's guard, and this sweep does not read it`];
    }
    const grouped = file.startsWith("src/app/") && file.split("/").some((part) => /^[(@]/.test(part));
    return grouped
      ? [`${file} sits in a route group or slot, so its URL is not its path and "under admin" cannot be read off it`]
      : [];
  });
}

/* ------------------------------------------------------------------ */
/* Judging                                                            */
/* ------------------------------------------------------------------ */

type Allowances = {
  exceptions: readonly GateException[];
  identifyOnly: readonly IdentifiedOnly[];
};

const NO_ALLOWANCES: Allowances = { exceptions: [], identifyOnly: [] };

function opensWith(before: readonly string[], opening: readonly string[]): boolean {
  return opening.every((act, i) => before[i] === act);
}

function isAdmin(found: Site): boolean {
  return found.kind === "admin page" || found.site.startsWith(ADMIN_AREA);
}

/** What is wrong with a site, or `null`. */
function problemWith(found: Site, allowed: Allowances): string | null {
  const exception = allowed.exceptions.find((entry) => entry.site === found.site);
  if (exception) {
    const opening = exception.opensWith ?? [];
    if (opensWith(found.before, opening)) return null;
    const actual = found.before.slice(0, opening.length + 1).join(", ") || "nothing";
    return `is excused only while it opens with ${opening.join(", ")} - it now opens with ${actual}`;
  }
  if (found.unreadable) {
    return "is exported in a form this sweep cannot follow to a function body, so it cannot be shown to be gated";
  }
  if (!found.guard) {
    return (
      `does not await a guard (${REFUSING_GUARDS.join(", ")}) imported from session-guards, ` +
      `as a statement of its own at the top of its body`
    );
  }
  if (found.guard === IDENTIFYING_GUARD) {
    if (isAdmin(found)) {
      return `is gated only by ${IDENTIFYING_GUARD}, which refuses nobody - an admin entry point never may be`;
    }
    if (!allowed.identifyOnly.some((entry) => entry.site === found.site)) {
      return (
        `is gated only by ${IDENTIFYING_GUARD}, which identifies a caller and refuses nobody. ` +
        `Use a guard that refuses, or list the site in IDENTIFY_ONLY_SITES with what refuses instead`
      );
    }
  }
  if (found.before.length === 0) return null;
  return `runs ${found.before.join(", ")} before ${found.guard} - the guard is first or it is not a guard`;
}

function offences(sites: readonly Site[], allowed: Allowances): string[] {
  return sites.flatMap((found) => {
    const problem = problemWith(found, allowed);
    return problem ? [`${found.site} (${found.kind}) ${problem}`] : [];
  });
}

/** Entries, in either list, that excuse nothing: the site is gone, or it no longer needs them. */
function staleAllowances(sites: readonly Site[], allowed: Allowances): string[] {
  const bySite = new Map(sites.map((found) => [found.site, found]));
  const gone = (site: string) => `${site} is not an entry point this sweep can find`;
  return [
    ...allowed.exceptions.flatMap((entry) => {
      const found = bySite.get(entry.site);
      if (!found) return [gone(entry.site)];
      return problemWith(found, NO_ALLOWANCES) === null ? [`${entry.site} passes without its exception`] : [];
    }),
    ...allowed.identifyOnly.flatMap((entry) => {
      const found = bySite.get(entry.site);
      if (!found) return [gone(entry.site)];
      return found.guard === IDENTIFYING_GUARD ? [] : [`${entry.site} is not gated by ${IDENTIFYING_GUARD} any more`];
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* The tree                                                           */
/* ------------------------------------------------------------------ */

const ROOT = path.resolve(__dirname, "../../..");

/** Every file, as a path from the repository root with forward slashes on every platform. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "__tests__" ? [] : walk(full);
    return [path.relative(ROOT, full).split(path.sep).join("/")];
  });
}

const FILES = walk(path.join(ROOT, "src"));
const SITES = FILES.filter((file) => /\.tsx?$/.test(file)).flatMap((file) =>
  sitesIn(file, readFileSync(path.join(ROOT, file), "utf8"))
);
const ALLOWED: Allowances = { exceptions: GATE_EXCEPTIONS, identifyOnly: IDENTIFY_ONLY_SITES };

function count(kind: Site["kind"]): number {
  return SITES.filter((found) => found.kind === kind).length;
}

/* ------------------------------------------------------------------ */
/* The reader sees what it claims to                                  */
/* ------------------------------------------------------------------ */

const ACTIONS = "src/app/things/actions.ts";
const ADMIN_ACTIONS = "src/app/admin/things/actions.ts";
const HEAD =
  `"use server";\n` +
  `import { getCurrentUser, requireAdmin, requireUser } from "@/lib/session-guards";\n` +
  `import { db } from "@/db";\n`;

/** The verdict on every entry point of a made-up file: `name: gated by x`, or `name: <problem>`. */
function verdicts(file: string, source: string, allowed: Allowances = NO_ALLOWANCES): string[] {
  return sitesIn(file, source).map((found) => {
    const name = found.site.slice(found.site.indexOf("#") + 1);
    return `${name}: ${problemWith(found, allowed) ?? `gated by ${found.guard}`}`;
  });
}

describe("reading one file for its gates", () => {
  it.each([
    [
      "a guard awaited on the first line",
      `export async function saveAction(id: string) {\n  await requireAdmin();\n  await db.delete(id);\n}`,
      "gated by requireAdmin",
    ],
    [
      "a guard whose result is kept",
      `export async function saveAction() {\n  const admin = await requireAdmin();\n  return admin.id;\n}`,
      "gated by requireAdmin",
    ],
    [
      "a guard behind comments in every awkward place",
      `export async function saveAction(/* id */) {\n  // requireUser() is not what gates this\n  /* nor is db.select() */ await /* here */ requireAdmin(/* nothing */);\n}`,
      "gated by requireAdmin",
    ],
    [
      "an action written as an arrow function",
      `export const saveAction = async () => {\n  await requireUser();\n};`,
      "gated by requireUser",
    ],
    [
      "an action exported by name after it is declared",
      `async function saveAction() {\n  await requireUser();\n}\nexport { saveAction };`,
      "gated by requireUser",
    ],
    [
      "a guard that is handed a callback",
      `export async function saveAction(id: string) {\n  await requireAdmin(() => db.find(id));\n}`,
      "gated by requireAdmin",
    ],
    [
      "awaiting the params promise ahead of the guard",
      `export async function saveAction(params: Promise<{ id: string }>) {\n  const { id } = await params;\n  await requireAdmin();\n  return id;\n}`,
      "gated by requireAdmin",
    ],
    [
      "a parameter whose default calls nothing",
      `export async function saveAction(options: { confirm?: boolean } = {}) {\n  await requireAdmin();\n  return options;\n}`,
      "gated by requireAdmin",
    ],
  ])("accepts %s", (_label, body, verdict) => {
    expect(verdicts(ACTIONS, HEAD + body)).toEqual([`saveAction: ${verdict}`]);
  });

  it.each([
    [
      "an action whose guard was deleted",
      `export async function saveAction(id: string) {\n  await db.delete(id);\n}`,
      /^saveAction: does not await a guard/,
    ],
    [
      "an action with nothing in it but a comment naming a guard",
      `export async function saveAction() {\n  // await requireAdmin();\n}`,
      /^saveAction: does not await a guard/,
    ],
    [
      "a guard called after a database read",
      `export async function saveAction(id: string) {\n  const row = await db.find(id);\n  await requireAdmin();\n  return row;\n}`,
      /^saveAction: runs db\.find before requireAdmin/,
    ],
    [
      "a query started, though not awaited, ahead of the guard",
      `export async function saveAction(id: string) {\n  const pending = db.find(id);\n  await requireAdmin();\n  return pending;\n}`,
      /^saveAction: runs db\.find before requireAdmin/,
    ],
    [
      "a read passed to the guard as an argument",
      `export async function saveAction(id: string) {\n  await requireAdmin(await db.find(id));\n}`,
      /^saveAction: runs db\.find before requireAdmin/,
    ],
    [
      "a read in a parameter's default",
      `export async function saveAction(rows = db.readAll()) {\n  await requireAdmin();\n  return rows;\n}`,
      /^saveAction: runs db\.readAll before requireAdmin/,
    ],
    [
      "an answer returned ahead of the guard, though nothing is called",
      `export async function saveAction(id: string) {\n  if (id === SECRET_ID) return SECRET;\n  await requireAdmin();\n}`,
      /^saveAction: runs return before requireAdmin/,
    ],
    [
      "an error thrown ahead of the guard",
      `export async function saveAction(id: string) {\n  if (!id) throw REFUSAL;\n  await requireAdmin();\n}`,
      /^saveAction: runs throw before requireAdmin/,
    ],
    [
      "a guard that is not awaited",
      `export async function saveAction() {\n  requireAdmin();\n  await db.delete();\n}`,
      /^saveAction: does not await a guard/,
    ],
    [
      "a guard inside a condition",
      `export async function saveAction(strict: boolean) {\n  if (strict) await requireAdmin();\n  await db.delete();\n}`,
      /^saveAction: does not await a guard/,
    ],
    [
      "a guard raced beside the read it is meant to precede",
      `export async function saveAction() {\n  await Promise.all([requireAdmin(), db.delete()]);\n}`,
      /^saveAction: does not await a guard/,
    ],
    [
      "a guard that only appears inside a callback",
      `export async function saveAction() {\n  const gate = async () => {\n    await requireAdmin();\n  };\n  await db.delete(gate);\n}`,
      /^saveAction: does not await a guard/,
    ],
    [
      "an action with no block to read",
      `export const saveAction = async () => db.delete();`,
      /^saveAction: is exported in a form this sweep cannot follow/,
    ],
    [
      "an action re-exported from another module",
      `export { saveAction } from "./elsewhere";`,
      /^saveAction: is exported in a form this sweep cannot follow/,
    ],
  ])("refuses %s", (_label, body, verdict) => {
    expect(verdicts(ACTIONS, HEAD + body)).toEqual([expect.stringMatching(verdict)]);
  });

  it("refuses a function that is only named like a guard", () => {
    const source =
      `"use server";\nasync function requireAdmin() {}\n` +
      `export async function saveAction() {\n  await requireAdmin();\n}`;
    expect(verdicts(ACTIONS, source)).toEqual([expect.stringMatching(/^saveAction: does not await a guard/)]);
  });

  it("takes requirePermission, with the power it asks about, for a guard that refuses", () => {
    const source =
      `"use server";\nimport { requirePermission } from "@/lib/session-guards";\n` +
      `export async function saveAction() {\n  const actor = await requirePermission("games.manage");\n  return actor.id;\n}`;
    expect(verdicts(ADMIN_ACTIONS, source)).toEqual(["saveAction: gated by requirePermission"]);
  });

  it("takes requireAnyPermission, with the powers it asks about, for a guard that refuses", () => {
    const source =
      `import { requireAnyPermission } from "@/lib/session-guards";\n` +
      `export default async function AdminThingsPage() {\n` +
      `  const actor = await requireAnyPermission(["events.create", "events.manage"]);\n  return actor.id;\n}`;
    expect(verdicts("src/app/admin/things/page.tsx", source)).toEqual([
      "AdminThingsPage: gated by requireAnyPermission",
    ]);
  });

  it("follows a guard imported under another name", () => {
    const source =
      `"use server";\nimport { requireAdmin as gate } from "../../lib/session-guards";\n` +
      `export async function saveAction() {\n  await gate();\n}`;
    expect(verdicts(ACTIONS, source)).toEqual(["saveAction: gated by requireAdmin"]);
  });

  it("sees every export of an action module, whatever it is called and wherever it lives", () => {
    const source = HEAD + `export async function save() {\n  await requireAdmin();\n}\nexport async function wipe() {}`;
    expect(verdicts("src/lib/anything.ts", source)).toEqual([
      "save: gated by requireAdmin",
      expect.stringMatching(/^wipe: does not await a guard/),
    ]);
  });

  it("does not take a type for an entry point", () => {
    const source = HEAD + `export type Fields = { id: string };\nexport type { Other } from "./other";`;
    expect(verdicts(ACTIONS, source)).toEqual([]);
  });

  it("sees an action declared inside a component, as a function, an arrow or a method", () => {
    const source =
      `import { requireUser } from "@/lib/session-guards";\n` +
      `export default function Panel() {\n` +
      `  async function gated() {\n    "use server";\n    await requireUser();\n  }\n` +
      `  const open = async () => {\n    "use server";\n    await wipe();\n  };\n` +
      `  const forms = {\n    async alsoOpen() {\n      "use server";\n      await wipe();\n    },\n  };\n` +
      `  return <form action={gated}><button formAction={open} /><button formAction={forms.alsoOpen} /></form>;\n}`;
    expect(verdicts("src/components/Panel.tsx", source)).toEqual([
      "gated: gated by requireUser",
      expect.stringMatching(/^open: does not await a guard/),
      expect.stringMatching(/^alsoOpen: does not await a guard/),
    ]);
  });

  it("sees an admin page's component, its metadata and its viewport, and nothing else it exports", () => {
    const source =
      `import { requireAdmin } from "@/lib/session-guards";\n` +
      `export const dynamic = "force-dynamic";\n` +
      `export async function generateMetadata() {\n  return { title: await titleOf() };\n}\n` +
      `export async function generateViewport() {\n  return { themeColor: await colourOf() };\n}\n` +
      `export default async function AdminThingsPage() {\n  await requireAdmin();\n  return <main />;\n}`;
    expect(verdicts("src/app/admin/things/[id]/page.tsx", source)).toEqual([
      expect.stringMatching(/^generateMetadata: does not await a guard/),
      expect.stringMatching(/^generateViewport: does not await a guard/),
      "AdminThingsPage: gated by requireAdmin",
    ]);
  });

  it.each(["layout.tsx", "template.tsx", "default.tsx", "things/layout.tsx", "layout.ts", "gate/layout.ts", "gate/page.ts"])(
    "holds an admin %s to the same rule as a page",
    (file) => {
      // No JSX, so the same source is a valid `.ts` as well as a `.tsx`.
      const source = `export default async function Shell({ children }) {\n  await menuFor();\n  return children;\n}`;
      expect(verdicts(ADMIN_AREA + file, source)).toEqual([expect.stringMatching(/^Shell: does not await a guard/)]);
    }
  );

  it("leaves a page outside the admin area alone", () => {
    const source = `export default async function EventsPage() {\n  return <main>{await listEvents()}</main>;\n}`;
    expect(verdicts("src/app/events/page.tsx", source)).toEqual([]);
  });

  it("sees a route's handlers, and not its configuration", () => {
    const source =
      `import { handlers } from "@/lib/auth";\n` +
      `export const runtime = "nodejs";\n` +
      `export const { POST } = handlers;\n` +
      `export async function GET() {\n  return Response.json(await everything());\n}`;
    expect(verdicts("src/app/api/things/route.ts", source)).toEqual([
      expect.stringMatching(/^POST: is exported in a form this sweep cannot follow/),
      expect.stringMatching(/^GET: does not await a guard/),
    ]);
  });

  it("names the files it would not be reading", () => {
    const files = [
      "src/app/admin/page.tsx",
      "src/app/(staff)/admin/page.tsx",
      "src/app/admin/@panel/page.tsx",
      "src/lib/legacy.js",
      "src/components/Old.jsx",
      "src/lib/worker.mjs",
      "src/lib/shared.mts",
      "src/app/admin/things/loading.tsx",
      "src/app/admin/not-found.tsx",
      "src/app/admin/things/opengraph-image.tsx",
      "src/app/admin/icon.png",
      "src/app/loading.tsx",
    ];
    expect(unreadFiles(files)).toEqual([
      expect.stringMatching(/^src\/app\/\(staff\)\/admin\/page\.tsx sits in a route group or slot/),
      expect.stringMatching(/^src\/app\/admin\/@panel\/page\.tsx sits in a route group or slot/),
      expect.stringMatching(/^src\/lib\/legacy\.js is a script this sweep does not parse/),
      expect.stringMatching(/^src\/components\/Old\.jsx is a script this sweep does not parse/),
      expect.stringMatching(/^src\/lib\/worker\.mjs is a script this sweep does not parse/),
      expect.stringMatching(/^src\/lib\/shared\.mts is a script this sweep does not parse/),
      expect.stringMatching(/^src\/app\/admin\/things\/loading\.tsx is an admin file Next serves outside the page's guard/),
      expect.stringMatching(/^src\/app\/admin\/not-found\.tsx is an admin file Next serves outside the page's guard/),
      expect.stringMatching(/^src\/app\/admin\/things\/opengraph-image\.tsx is an admin file Next serves outside/),
      expect.stringMatching(/^src\/app\/admin\/icon\.png is an admin file Next serves outside the page's guard/),
    ]);
  });
});

describe("a guard that only identifies", () => {
  const DISCARDED = HEAD + `export async function saveAction() {\n  await getCurrentUser();\n  await db.delete();\n}`;
  const KEPT = HEAD + `export async function saveAction() {\n  const user = await getCurrentUser();\n  return user;\n}`;
  const PINNED = (file: string): Allowances => ({
    exceptions: [],
    identifyOnly: [{ site: `${file}#saveAction`, reason: "for the test" }],
  });

  it("does not gate an admin action whose first line awaits it and throws the answer away", () => {
    expect(verdicts(ADMIN_ACTIONS, DISCARDED)).toEqual([
      expect.stringMatching(/^saveAction: is gated only by getCurrentUser, which refuses nobody - an admin entry point/),
    ]);
  });

  it("does not gate an admin page", () => {
    const source =
      `import { getCurrentUser } from "@/lib/session-guards";\n` +
      `export default async function AdminThingsPage() {\n  const u = await getCurrentUser();\n  return <main>{u?.id}</main>;\n}`;
    expect(verdicts("src/app/admin/things/page.tsx", source)).toEqual([
      expect.stringMatching(/^AdminThingsPage: is gated only by getCurrentUser, which refuses nobody - an admin entry point/),
    ]);
  });

  it("does not gate an action outside the admin area either, unless the site is listed", () => {
    expect(verdicts(ACTIONS, KEPT)).toEqual([
      expect.stringMatching(/^saveAction: is gated only by getCurrentUser.*IDENTIFY_ONLY_SITES/),
    ]);
  });

  it("is accepted at a listed site outside the admin area", () => {
    expect(verdicts(ACTIONS, KEPT, PINNED(ACTIONS))).toEqual(["saveAction: gated by getCurrentUser"]);
  });

  it("is refused on an admin entry point even when the site is listed", () => {
    expect(verdicts(ADMIN_ACTIONS, KEPT, PINNED(ADMIN_ACTIONS))).toEqual([
      expect.stringMatching(/^saveAction: is gated only by getCurrentUser, which refuses nobody - an admin entry point/),
    ]);
  });

  it("still has to come first at a listed site", () => {
    const source = HEAD + `export async function saveAction() {\n  await db.delete();\n  await getCurrentUser();\n}`;
    expect(verdicts(ACTIONS, source, PINNED(ACTIONS))).toEqual([
      "saveAction: runs db.delete before getCurrentUser - the guard is first or it is not a guard",
    ]);
  });

  it("calls out a listed site that has since taken a guard that refuses, or has gone", () => {
    const sites = sitesIn(ACTIONS, HEAD + `export async function saveAction() {\n  await requireUser();\n}`);
    const identifyOnly = [
      { site: `${ACTIONS}#saveAction`, reason: "for the test" },
      { site: `${ACTIONS}#goneAction`, reason: "for the test" },
    ];
    expect(staleAllowances(sites, { exceptions: [], identifyOnly })).toEqual([
      `${ACTIONS}#saveAction is not gated by getCurrentUser any more`,
      `${ACTIONS}#goneAction is not an entry point this sweep can find`,
    ]);
  });
});

describe("judging against the exceptions", () => {
  const SITE = `${ACTIONS}#saveAction`;
  const UNGATED = HEAD + `export async function saveAction() {\n  await db.delete();\n}`;
  const OWN_GATE = HEAD + `export async function saveAction() {\n  if (!enabled()) notFound();\n  await db.delete();\n}`;
  const excused = (opening?: string[]): Allowances => ({
    exceptions: [{ site: SITE, reason: "for the test", opensWith: opening }],
    identifyOnly: [],
  });

  it("names the action and the file in what it reports", () => {
    expect(offences(sitesIn(ACTIONS, UNGATED), NO_ALLOWANCES)).toEqual([
      expect.stringMatching(/^src\/app\/things\/actions\.ts#saveAction \(action\) does not await a guard/),
    ]);
  });

  it("lets an exception excuse a site with no guard", () => {
    expect(offences(sitesIn(ACTIONS, UNGATED), excused())).toEqual([]);
  });

  it("holds an excused site to the gate its exception says it opens with", () => {
    expect(offences(sitesIn(ACTIONS, OWN_GATE), excused(["enabled", "notFound"]))).toEqual([]);
  });

  it("refuses an excused site whose own gate has been removed", () => {
    const sites = sitesIn(ACTIONS, OWN_GATE.replace("  if (!enabled()) notFound();\n", ""));
    expect(offences(sites, excused(["enabled", "notFound"]))).toEqual([
      expect.stringMatching(/saveAction \(action\) is excused only while it opens with enabled, notFound - it now opens with db\.delete/),
    ]);
  });

  it("refuses an excused site that does something ahead of its own gate", () => {
    const sites = sitesIn(ACTIONS, OWN_GATE.replace("  if (", "  await db.read();\n  if ("));
    expect(offences(sites, excused(["enabled", "notFound"]))).toEqual([
      expect.stringMatching(/it now opens with db\.read, enabled, notFound/),
    ]);
  });

  it("calls out an exception for a site that is gated anyway, or is not there", () => {
    const sites = sitesIn(ACTIONS, HEAD + `export async function saveAction() {\n  await requireAdmin();\n}`);
    const exceptions = [
      { site: SITE, reason: "for the test" },
      { site: `${ACTIONS}#goneAction`, reason: "for the test" },
    ];
    expect(staleAllowances(sites, { exceptions, identifyOnly: [] })).toEqual([
      `${SITE} passes without its exception`,
      `${ACTIONS}#goneAction is not an entry point this sweep can find`,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* The sweep                                                          */
/* ------------------------------------------------------------------ */

describe("every entry point is gated", () => {
  it("is looking at the action modules, the admin pages and the routes", () => {
    const modules = new Set(SITES.filter((found) => found.kind === "action").map((found) => found.site.split("#")[0]));
    const seen = {
      actionModules: modules.size,
      actions: count("action"),
      inlineActions: count("inline action"),
      adminPageEntryPoints: count("admin page"),
      routeHandlers: count("route"),
    };
    expect(seen.actionModules, `"use server" modules`).toBeGreaterThanOrEqual(FLOORS.actionModules);
    expect(seen.actions, "exported server actions").toBeGreaterThanOrEqual(FLOORS.actions);
    expect(seen.inlineActions, "inline server actions").toBeGreaterThanOrEqual(FLOORS.inlineActions);
    expect(seen.adminPageEntryPoints, "admin pages and their metadata").toBeGreaterThanOrEqual(
      FLOORS.adminPageEntryPoints
    );
    expect(seen.routeHandlers, "route handlers").toBeGreaterThanOrEqual(FLOORS.routeHandlers);
  });

  it("is not walking past a kind of file it does not read", () => {
    expect(unreadFiles(FILES)).toEqual([]);
  });

  /*
   * And it reads them rightly: known sites of each kind, and each guard at
   * least once. `requirePermission` had no call site until Task 126 gave
   * `createEventAction` one, so its row is the first to show the sweep
   * recognising the sixth guard in the tree and not only in the fixture above.
   *
   * The `requireAdmin` row used to name `createGameAction`, which Task 127
   * moved onto `games.manage`. It now names a grant, and that is not an
   * arbitrary replacement: **R-264 says granting is never a power**, so every
   * action in `admin/users/actions.ts` is guaranteed to stay on the admin flag
   * for as long as that requirement stands. An anchor that a later task can
   * move is not an anchor.
   *
   * The admin-page row for `requireAdmin` used to name `AdminDashboardPage`,
   * which Task 130 moved: `/admin` admits a holder of any area power, so it is
   * behind `requireAnyPermission` - the seventh name this sweep knows, and the
   * row that shows it recognised in the tree. The `requireAdmin` anchor is now
   * `AdminUsersPage`, for the reason above - it is the screen that gives and
   * takes the admin flag, so R-264 keeps it on the flag. Every admin page is
   * listed whole in the test after next.
   */
  it.each([
    ["src/app/admin/users/actions.ts#grantAdminAction", "requireAdmin"],
    ["src/app/admin/events/actions.ts#createEventAction", "requirePermission"],
    ["src/app/admin/events/actions.ts#saveBasicsAction", "requireEventManager"],
    ["src/app/admin/events/format-actions.ts#recordGamesAction", "requireManagerOfChild"],
    ["src/app/me/profile/actions.ts#saveProfileSectionAction", "requireUser"],
    ["src/app/events/[slug]/draft/actions.ts#loadRoomAction", "getCurrentUser"],
    ["src/app/admin/users/page.tsx#AdminUsersPage", "requireAdmin"],
    ["src/app/admin/page.tsx#AdminDashboardPage", "requireAnyPermission"],
    ["src/app/admin/games/page.tsx#AdminGamesPage", "requirePermission"],
    ["src/app/admin/events/[id]/page.tsx#AdminEventPage", "requireEventManager"],
    ["src/app/admin/events/[id]/page.tsx#generateMetadata", "requireEventManager"],
  ])("finds %s behind %s, with nothing ahead of it", (site, guard) => {
    expect(SITES.find((found) => found.site === site)).toMatchObject({ guard, before: [], unreadable: false });
  });

  /*
   * Task 126 moved these two files onto powers, and only part of them: one
   * action in each direction, with everything else left behind the event's own
   * guard. Listed whole, so an action that drifts to another guard - or a new
   * one that arrives behind the wrong one - changes this list in the same diff.
   *
   * `postAnnouncementByHandAction` reads `requireUser` because that is its
   * first line; "manages this event, or holds announce.post" is the line after
   * it, and `admin/events/__tests__/powers.test.ts` is what holds it to that.
   * `createEventFromApplicationAction` reads the first of its two.
   */
  it("finds the events and host-application actions behind the guards Task 126 left them", () => {
    const moved = ["src/app/admin/events/actions.ts", "src/app/admin/host/actions.ts"];
    const guards = SITES.filter((found) => moved.includes(found.site.split("#")[0])).map(
      (found) => `${found.site.slice("src/app/admin/".length)}: ${found.guard}`
    );
    expect(guards).toEqual([
      "events/actions.ts#createEventAction: requirePermission",
      "events/actions.ts#saveBasicsAction: requireEventManager",
      "events/actions.ts#setEventStatusAction: requireEventManager",
      "events/actions.ts#publishEventAction: requireEventManager",
      "events/actions.ts#postAnnouncementByHandAction: requireUser",
      "events/actions.ts#previewEventDaysAction: requireEventManager",
      "events/actions.ts#saveEventDaysAction: requireEventManager",
      "events/actions.ts#saveEventQuestionsAction: requireEventManager",
      "events/actions.ts#saveEntryRulesAction: requireEventManager",
      "events/actions.ts#saveEventShapeAction: requireEventManager",
      "events/actions.ts#saveRoundScoringAction: requireEventManager",
      "events/actions.ts#clearRoundScoringAction: requireEventManager",
      "events/actions.ts#saveRoundAction: requireEventManager",
      "events/actions.ts#addEventToChampionshipAction: requireEventManager",
      "events/actions.ts#saveEventChampionshipAction: requireEventManager",
      "events/actions.ts#removeEventFromChampionshipAction: requireEventManager",
      "events/actions.ts#saveEventPlacementsAction: requireEventManager",
      "events/actions.ts#decideApplicationAction: requireManagerOfChild",
      "events/actions.ts#saveApplicationNoteAction: requireManagerOfChild",
      "events/actions.ts#setApplicantAvailabilityAction: requireManagerOfChild",
      "host/actions.ts#createEventFromApplicationAction: requirePermission",
      "host/actions.ts#approveHostApplicationAction: requirePermission",
      "host/actions.ts#declineHostApplicationAction: requirePermission",
    ]);
  });

  /*
   * Task 130 moved the admin pages off the admin flag, each onto the power it
   * is for. Listed whole, for the reason the list above is: a page that drifts
   * to another guard, or a new one that arrives, changes this list in the same
   * diff.
   *
   * **Three are more than one power's**, and read `requireAnyPermission`:
   * `/admin` admits a holder of any area power, `/admin/events` a holder of
   * either of two and `/admin/settings` likewise. They were first written as
   * `requireUser` with the refusal on the line after, which this sweep cannot
   * see - a page whose second line was forgotten would have admitted any
   * signed-in member and read as gated. One guard on the first line is what
   * makes all three visible here, and **no admin page reads `requireUser`**:
   * the last assertion says so, so the shape cannot come back unnoticed.
   *
   * Which powers each one names is still not this sweep's to know.
   * `admin/__tests__/holder-pages.test.ts` holds that: every page here, opened
   * by a holder of each power in turn, by an admin, by a member holding
   * nothing and by a visitor.
   */
  it("finds every admin page behind the guard Task 130 left it", () => {
    const guards = SITES.filter((found) => found.kind === "admin page")
      .map((found) => `${found.site.slice("src/app/admin/".length)}: ${found.guard}`)
      .sort();
    expect(guards).toEqual([
      "audit/page.tsx#AdminAuditPage: requirePermission",
      "availability/page.tsx#AdminAvailabilityPage: requirePermission",
      "championships/[id]/page.tsx#AdminChampionshipPage: requirePermission",
      "championships/[id]/page.tsx#generateMetadata: requirePermission",
      "championships/page.tsx#AdminChampionshipsPage: requirePermission",
      "events/[id]/page.tsx#AdminEventPage: requireEventManager",
      "events/[id]/page.tsx#generateMetadata: requireEventManager",
      "events/page.tsx#AdminEventsPage: requireAnyPermission",
      "games/page.tsx#AdminGamesPage: requirePermission",
      "hands/page.tsx#AdminHandsPage: requirePermission",
      "host/page.tsx#AdminHostPage: requirePermission",
      "page.tsx#AdminDashboardPage: requireAnyPermission",
      "settings/page.tsx#AdminSettingsPage: requireAnyPermission",
      "templates/page.tsx#AdminTemplatesPage: requirePermission",
      "users/page.tsx#AdminUsersPage: requireAdmin",
    ]);
    expect(guards.filter((entry) => entry.endsWith(": requireUser"))).toEqual([]);
  });

  it("recognises only guards that session-guards really exports", () => {
    const file = "src/lib/session-guards.ts";
    const exported = exportedValues(parse(file, readFileSync(path.join(ROOT, file), "utf8"))).map(({ name }) => name);
    expect(exported).toEqual(expect.arrayContaining([...REFUSING_GUARDS, IDENTIFYING_GUARD]));
  });

  it("finds no entry point that does anything before its guard", () => {
    const found = offences(SITES, ALLOWED);
    expect(
      found,
      found.length === 0
        ? ""
        : `An entry point is not gated. Nothing else on this site stands in front of it - there is no ` +
            `middleware and no admin layout - so as written it is open to anyone who can send a request. ` +
            `Put the guard on the first line; only if that is genuinely wrong, add the site to ` +
            `src/app/__tests__/gated-allowlist.ts with the reason.\n  ${found.join("\n  ")}`
    ).toEqual([]);
  });
});

describe("the allowlist", () => {
  /*
   * Pinned on purpose. Adding to either list means changing a number here in
   * the same diff, which is the moment a reviewer asks why.
   */
  it("is exactly as long as it was when somebody last justified it", () => {
    expect(GATE_EXCEPTIONS, "sites with no session guard").toHaveLength(8);
    expect(IDENTIFY_ONLY_SITES, "sites gated by getCurrentUser alone").toHaveLength(2);
  });

  it("names each site once, across both lists", () => {
    const names = [...GATE_EXCEPTIONS, ...IDENTIFY_ONLY_SITES].map((entry) => entry.site);
    expect(names).toEqual([...new Set(names)]);
  });

  it.each([...GATE_EXCEPTIONS, ...IDENTIFY_ONLY_SITES].map((entry) => [entry.site, entry.reason] as const))(
    "gives a reason for %s",
    (_site, reason) => {
      expect(reason.trim().split(/\s+/).length).toBeGreaterThanOrEqual(8);
    }
  );

  it("lists no admin entry point as gated by getCurrentUser alone", () => {
    expect(IDENTIFY_ONLY_SITES.filter((entry) => entry.site.startsWith(ADMIN_AREA))).toEqual([]);
  });

  it("excuses nothing that would pass without it, and nothing that has gone", () => {
    expect(staleAllowances(SITES, ALLOWED)).toEqual([]);
  });
});
