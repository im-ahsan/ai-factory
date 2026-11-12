// Gate-efficacy runner: seeds defects, evaluates the registered gate's predicate directly (pure, no
// ledger, no model), and reports catch rate and false positives. Fails closed on a throwing gate.
import { DEFAULT_POLICY, getGate, type Policy } from "../../src/gates/index.js";
// importing these registers the estimate and build gates
import "../../src/estimate/gates.js";
import "../../src/estimate/lint.js";
import { CASES, type GateCase } from "./cases.js";

export type CaseStatus = "caught" | "missed" | "ok" | "false-positive" | "pending" | "error" | "known-gap" | "gap-fixed";

export interface CaseResult { id: string; gateId: string; description: string; expect: GateCase["expect"]; status: CaseStatus; details?: string }

export interface GateSummary {
  gateId: string;
  caught: number; missed: number; ok: number; falsePositive: number; pending: number; error: number;
  /** open findings (knownGap cases the gate still gets wrong); they count in the rates, so a rate shows the gate as it is */
  knownGap: number;
  /** caught / (caught + missed); null when no must-fail case ran */
  catchRate: number | null;
  /** false-positive / (ok + false-positive); null when no must-pass case ran */
  falsePositiveRate: number | null;
}

export function runCase(c: GateCase, policy: Policy = DEFAULT_POLICY): CaseResult {
  const base = { id: c.id, gateId: c.gateId, description: c.description, expect: c.expect };
  const def = getGate(c.gateId);
  if (!def) return { ...base, status: "pending", details: "gate not registered yet" };
  try {
    const v = def.predicate(c.input, policy);
    const status: CaseStatus = c.expect === "must-fail" ? (v.passed ? "missed" : "caught") : (v.passed ? "ok" : "false-positive");
    // an open finding stays visible without failing the suite; once the gate gets it right, say so
    if (c.knownGap) return { ...base, status: status === "missed" || status === "false-positive" ? "known-gap" : "gap-fixed", details: `${c.knownGap}${v.details ? ` (${v.details})` : ""}` };
    return { ...base, status, details: v.details };
  } catch (e) {
    return { ...base, status: "error", details: e instanceof Error ? e.message : String(e) };
  }
}

export function runCases(cases: GateCase[] = CASES, policy: Policy = DEFAULT_POLICY): CaseResult[] {
  return cases.map((c) => runCase(c, policy));
}

export function summarise(results: CaseResult[]): GateSummary[] {
  const ids = [...new Set(results.map((r) => r.gateId))];
  return ids.map((gateId) => {
    const rs = results.filter((r) => r.gateId === gateId);
    const n = (s: CaseStatus) => rs.filter((r) => r.status === s).length;
    const caught = n("caught"), missed = n("missed"), ok = n("ok"), falsePositive = n("false-positive");
    const gap = (e: GateCase["expect"]) => rs.filter((r) => r.status === "known-gap" && r.expect === e).length;
    const allMissed = missed + gap("must-fail"), allFalse = falsePositive + gap("must-pass");
    return {
      gateId, caught, missed, ok, falsePositive, pending: n("pending"), error: n("error"), knownGap: n("known-gap"),
      catchRate: caught + allMissed ? caught / (caught + allMissed) : null,
      falsePositiveRate: ok + allFalse ? allFalse / (ok + allFalse) : null,
    };
  });
}

/** True when nothing that ran is wrong. Pending gates and open findings (known-gap) don't fail the run;
 *  a fixed gap does, so its knownGap tag is removed and the case guards the fix from then on. */
export const allGood = (results: CaseResult[]): boolean => !results.some((r) => r.status === "missed" || r.status === "false-positive" || r.status === "error" || r.status === "gap-fixed");

const pct = (n: number | null) => (n === null ? "-" : `${Math.round(n * 100)}%`);

export function formatGates(results: CaseResult[]): string {
  const sums = summarise(results);
  const lines = [
    `${"gate".padEnd(30)} ${"caught".padStart(6)} ${"missed".padStart(6)} ${"false+".padStart(6)} ${"pending".padStart(7)} ${"error".padStart(5)} ${"open".padStart(5)} ${"catch".padStart(6)}`,
    ...sums.map((s) => `${s.gateId.padEnd(30)} ${String(s.caught).padStart(6)} ${String(s.missed).padStart(6)} ${String(s.falsePositive).padStart(6)} ${String(s.pending).padStart(7)} ${String(s.error).padStart(5)} ${String(s.knownGap).padStart(5)} ${pct(s.catchRate).padStart(6)}`),
  ];
  const bad = results.filter((r) => r.status === "missed" || r.status === "false-positive" || r.status === "error" || r.status === "gap-fixed");
  if (bad.length) {
    lines.push("", "Problems:");
    for (const r of bad) lines.push(`  ${r.status.toUpperCase().padEnd(14)} ${r.id}: ${r.description}${r.details ? ` (${r.details.slice(0, 120)})` : ""}`);
  }
  const open = results.filter((r) => r.status === "known-gap");
  if (open.length) {
    lines.push("", `Open findings (${open.length}): the gate still gets these wrong; they don't fail the run.`);
    for (const r of open) lines.push(`  ${(r.expect === "must-fail" ? "MISSES" : "BLOCKS").padEnd(7)} ${r.id}: ${r.description}`);
  }
  const pending = sums.filter((s) => s.pending).length;
  if (pending) lines.push("", `${pending} gate(s) pending: their cases are written but the gate is not registered.`);
  return lines.join("\n");
}
