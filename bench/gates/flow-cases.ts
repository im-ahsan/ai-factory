// Seeded-defect cases for the remaining checks (QA guide, gap 6): grounding, plan, review, diff size and
// the design checks. Same rules as safety-cases.ts: clean inputs must pass, bad ones must be caught.
import type { GateCase } from "./cases.js";

const mk = (gateId: string, prefix: string) =>
  (id: string, expect: GateCase["expect"], description: string, input: unknown): GateCase => ({ id: `${prefix}/${id}`, gateId, expect, description, input });

// ---------- ground.anchors-resolve ----------

const gr = mk("ground.anchors-resolve", "ground");
const cb = { claims: [{ id: "C1", text: "orders are listed newest first", spans: ["S1"], anchors: [{ path: "src/orders.ts", lineStart: 4, lineEnd: 6, quote: "x" }] }], notFound: [] };
const GROUND: GateCase[] = [
  gr("clean", "must-pass", "every quoted line matches the file", { cb, resolved: [{ claim: "C1", ok: true }, { claim: "C2", ok: true }] }),
  gr("new-behaviour", "must-pass", "nothing exists yet: no claims, the span is listed as not found", { cb: { claims: [], notFound: [{ span: "S1", searched: ["no-show"] }] }, resolved: [] }),
  gr("bad-quote", "must-fail", "a quote that doesn't match the file", { cb, resolved: [{ claim: "C1", ok: true }, { claim: "C2", ok: false, reason: "quote not found at lines 4-6" }] }),
  gr("all-bad", "must-fail", "every anchor is invented", { cb, resolved: [{ claim: "C1", ok: false }] }),
];

// ---------- plan.checks ----------

const pl = mk("plan.checks", "plan");
type T = { id: string; reqs?: string[]; fileScope?: string[]; conventions?: string[]; dependsOn?: string[] };
const task = (t: T) => ({ title: t.id, reqs: ["REQ-1"], fileScope: [`src/${t.id.toLowerCase()}/**`], exemplars: [], conventions: [], dependsOn: [], plannedLoc: 40, approach: "", ...t });
const spec = { requirements: [{ id: "REQ-1" }, { id: "REQ-2" }] };
const plan = (tasks: T[], extra: Record<string, unknown> = {}) => ({
  plan: {
    tasks: tasks.map(task), chosen: "OPT-1", adr: "Add a column; simplest option.", protectedPathsDeclared: [],
    options: [{ id: "OPT-1", summary: "a", simplest: true, tradeoffs: "" }, { id: "OPT-2", summary: "b", simplest: false, tradeoffs: "" }], ...extra,
  },
  spec,
});
const two: T[] = [{ id: "T1", reqs: ["REQ-1"] }, { id: "T2", reqs: ["REQ-2"], dependsOn: ["T1"] }];
const PLAN: GateCase[] = [
  pl("clean", "must-pass", "two tasks cover both requirements, no shared files, known dependency", plan(two)),
  pl("uncovered", "must-fail", "a requirement no task covers", plan([{ id: "T1", reqs: ["REQ-1"] }])),
  pl("one-option", "must-fail", "only one option considered", plan(two, { options: [{ id: "OPT-1", summary: "a", simplest: true, tradeoffs: "" }] })),
  pl("chosen-missing", "must-fail", "the chosen option isn't one of the options", plan(two, { chosen: "OPT-9" })),
  pl("no-adr", "must-fail", "blank decision record", plan(two, { adr: "   " })),
  pl("too-many-rules", "must-fail", "a task with 16 rules", plan([{ id: "T1", reqs: ["REQ-1", "REQ-2"], conventions: Array.from({ length: 16 }, (_, i) => `CONV-${i + 1}`) }])),
  pl("no-scope", "must-fail", "a task with no file scope", plan([{ id: "T1", reqs: ["REQ-1", "REQ-2"], fileScope: [] }])),
  pl("same-file", "must-fail", "two tasks list the same file", plan([{ id: "T1", reqs: ["REQ-1"], fileScope: ["src/orders.ts"] }, { id: "T2", reqs: ["REQ-2"], fileScope: ["src/orders.ts"] }])),
  pl("glob-covers-file", "must-fail", "one task's folder contains the other's file", plan([{ id: "T1", reqs: ["REQ-1"], fileScope: ["src/**"] }, { id: "T2", reqs: ["REQ-2"], fileScope: ["src/orders/list.ts"] }])),
  pl("globs-intersect", "must-fail", "two globs that both match src/orders/list.ts", plan([{ id: "T1", reqs: ["REQ-1"], fileScope: ["src/orders/*.ts"] }, { id: "T2", reqs: ["REQ-2"], fileScope: ["src/orders/list.*"] }])),
  pl("unknown-dep", "must-fail", "depends on a task that doesn't exist", plan([{ id: "T1", reqs: ["REQ-1"] }, { id: "T2", reqs: ["REQ-2"], dependsOn: ["T9"] }])),
  pl("dep-cycle", "must-fail", "two tasks wait for each other", plan([{ id: "T1", reqs: ["REQ-1"], dependsOn: ["T2"] }, { id: "T2", reqs: ["REQ-2"], dependsOn: ["T1"] }])),
  pl("self-dep", "must-fail", "a task depends on itself", plan([{ id: "T1", reqs: ["REQ-1"] }, { id: "T2", reqs: ["REQ-2"], dependsOn: ["T2"] }])),
  pl("invented-req", "must-fail", "a task delivers a requirement the spec doesn't have", plan([...two, { id: "T3", reqs: ["REQ-9"] }])),
];

// ---------- review.no-blocking ----------

const rv = mk("review.no-blocking", "review");
type F = { category: string; severity: string; confidence: number };
const review = (fs: F[]) => ({
  review: { findings: fs.map((f, i) => ({ id: `RF-${i + 1}`, file: "src/a.ts", line: 3, text: "x", ...f })) },
  families: { implementer: "anthropic", reviewer: "openai" },
});
const REVIEW: GateCase[] = [
  rv("clean", "must-pass", "no findings", review([])),
  rv("advice-only", "must-pass", "a low reuse note and a medium convention note", review([{ category: "reuse", severity: "low", confidence: 0.9 }, { category: "convention-intent", severity: "medium", confidence: 0.9 }])),
  rv("unsure", "must-pass", "a high correctness finding the reviewer is unsure of (below 0.7)", review([{ category: "correctness", severity: "high", confidence: 0.69 }])),
  rv("security-low", "must-pass", "a low security note", review([{ category: "security", severity: "low", confidence: 0.9 }])),
  rv("critical-bug", "must-fail", "critical correctness finding", review([{ category: "correctness", severity: "critical", confidence: 0.9 }])),
  rv("at-threshold", "must-fail", "high spec mismatch at exactly 0.7 confidence", review([{ category: "spec-mismatch", severity: "high", confidence: 0.7 }])),
  rv("error-handling", "must-fail", "high error-handling finding", review([{ category: "error-handling", severity: "high", confidence: 0.8 }])),
  rv("security-medium", "must-fail", "medium security finding blocks", review([{ category: "security", severity: "medium", confidence: 0.8 }])),
  rv("one-of-many", "must-fail", "one blocking finding among advice", review([{ category: "reuse", severity: "low", confidence: 0.9 }, { category: "security", severity: "high", confidence: 0.95 }])),
];

// ---------- integrate.diff-size ----------

const ds = mk("integrate.diff-size", "diff-size");
const lines = (n: number, path = "src/a.ts") => ({ diff: { from: "a", to: "b", lockedNow: {}, files: [{ status: "M", path, added: Array.from({ length: n }, (_, i) => `l${i}`), removed: [] }] } });
const DIFFSIZE: GateCase[] = [
  ds("at-limit", "must-pass", "exactly 1500 changed lines", lines(1500)),
  ds("over-limit", "must-fail", "1501 changed lines", lines(1501)),
  ds("lockfile", "must-pass", "a 300-line change plus the package-lock.json churn from adding one dependency", {
    diff: { ...lines(300).diff, files: [...lines(300).diff.files, ...lines(2400, "package-lock.json").diff.files] },
  }),
];

// ---------- design.size-cap ----------

const sz = mk("design.size-cap", "design-size");
const size = (level: string, approved: string) => ({ actual: { level, name: level, work: "", mode: "git", uiFiles: 2, reasons: [`${level}: src/pages/x.tsx`] }, approved: { level: approved } });
const SIZE: GateCase[] = [
  sz("smaller", "must-pass", "built a tweak where a new screen was approved", size("tweak", "new-screen")),
  sz("same", "must-pass", "built what was approved", size("new-screen", "new-screen")),
  sz("bigger", "must-fail", "built a new screen where a tweak was approved", size("new-screen", "tweak")),
  sz("design-system", "must-fail", "changed the design system where a new screen was approved", size("design-system", "new-screen")),
  sz("ui-from-none", "must-fail", "changed UI where no UI was approved", size("tweak", "none")),
];

// ---------- design.fidelity-lint ----------

const fl = mk("design.fidelity-lint", "design-lint");
const lint = (...st: string[]) => ({ lint: st.map((s, i) => ({ check: `check-${i + 1}`, status: s, detail: "d" })) });
const LINT: GateCase[] = [
  fl("pass", "must-pass", "all lint checks pass", lint("PASS", "PASS")),
  fl("warn", "must-pass", "a warning is advice", lint("PASS", "WARN")),
  fl("fail", "must-fail", "a raw colour instead of a token", lint("PASS", "FAIL")),
  fl("unchecked", "must-fail", "a check that couldn't run", lint("UNCHECKED")),
];

// ---------- design.tokens / design.structure / design.a11y ----------

const fidelity = (level: string, status: string, blocking = true, extra: Record<string, unknown> = {}) => ({
  fidelity: {
    kind: "design-fidelity", pages: [], overall: "fail", ran: [], notes: [],
    levels: [{ level, check: level, status, detail: "d", blocking }],
    findings: status === "FAIL" ? [{ level, message: `${level} differs`, pages: ["home"] }] : [], ...extra,
  },
});
const FIDELITY: GateCase[] = ["tokens", "structure", "a11y"].flatMap((level) => {
  const f = mk(`design.${level}`, `design-${level}`);
  return [
    f("pass", "must-pass", `${level} matches the approved design`, fidelity(level, "PASS")),
    f("warn", "must-pass", `${level} differs only as advice`, fidelity(level, "WARN")),
    f("not-held", "must-pass", `${level} not held to the design (the app keeps its own look)`, fidelity(level, "UNCHECKED", false)),
    f("fail", "must-fail", `${level} differs from the approved design`, fidelity(level, "FAIL")),
    f("couldnt-check", "must-fail", `${level} could not be checked`, fidelity(level, "UNCHECKED")),
    f("missing", "must-fail", `${level} never ran`, { fidelity: { ...fidelity(level, "PASS").fidelity, levels: [], skipped: "app didn't start" } }),
  ];
});

// ---------- build.b1-design-scope / build.b6-design-screens (a build from an approved design) ----------

const b1 = mk("build.b1-design-scope", "design-scope");
const approvedSpec = { requirements: [{ id: "REQ-1" }, { id: "REQ-2" }] };
const DSCOPE: GateCase[] = [
  b1("clean", "must-pass", "every task delivers approved requirements", { plan: { tasks: [{ id: "T1", reqs: ["REQ-1"] }, { id: "T2", reqs: ["REQ-2"] }] }, approvedSpec }),
  b1("no-reqs", "must-fail", "a task that delivers nothing approved", { plan: { tasks: [{ id: "T1", reqs: ["REQ-1"] }, { id: "T2", reqs: [] }] }, approvedSpec }),
  b1("unknown-req", "must-fail", "a task that delivers an unapproved requirement", { plan: { tasks: [{ id: "T1", reqs: ["REQ-1", "REQ-7"] }] }, approvedSpec }),
];

const b6 = mk("build.b6-design-screens", "design-screens");
const screen = { id: "SCR-1", route: "/orders", file: "src/pages/Orders.tsx", reqs: ["REQ-1"] };
const DSCREENS: GateCase[] = [
  b6("clean", "must-pass", "the screen's task can touch its file", { plan: { tasks: [{ id: "T1", reqs: ["REQ-1"], fileScope: ["src/pages/**"] }] }, design: { screens: [screen] } }),
  b6("skipped", "must-pass", "no design to follow", { plan: { tasks: [{ id: "T1", reqs: ["REQ-1"], fileScope: ["src/**"] }] }, design: { skipped: true, screens: [] } }),
  b6("unplanned", "must-fail", "no task delivers the screen's requirements", { plan: { tasks: [{ id: "T1", reqs: ["REQ-2"], fileScope: ["src/pages/**"] }] }, design: { screens: [screen] } }),
  b6("wrong-scope", "must-fail", "the screen's task can't touch the screen's file", { plan: { tasks: [{ id: "T1", reqs: ["REQ-1"], fileScope: ["src/api/**"] }] }, design: { screens: [screen] } }),
];

// ---------- open findings (see safety-cases.ts) ----------

const OPEN: Record<string, string> = {
  // F-10 plan check: dependency cycles, self-dependencies, intersecting globs and invented requirements pass
  "plan/dep-cycle": "F-10", "plan/self-dep": "F-10", "plan/globs-intersect": "F-10", "plan/invented-req": "F-10",
  // F-11 diff size counts generated lock files
  "diff-size/lockfile": "F-11",
};

export const FLOW_CASES: GateCase[] = [...GROUND, ...PLAN, ...REVIEW, ...DIFFSIZE, ...SIZE, ...LINT, ...FIDELITY, ...DSCOPE, ...DSCREENS]
  .map((c) => (OPEN[c.id] ? { ...c, knownGap: OPEN[c.id] } : c));
