// Build step 4: applies the go/no-go criteria from the spec to the runs logged by run.ts.
//
//   npm run evaluate -- results/runs.jsonl

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import type { RunRecord } from "./run.js";
import { OWNER_FIXABLE } from "./tasks.js";

export interface PairResult {
  store: string;
  task: string;
  batch1: { pass: number; runs: number };
  batch2: { pass: number; runs: number };
  comparable: boolean; // both batches have runs; a pair with a missing batch can't be judged for stability
  unstable: boolean;
}

export interface Verdict {
  pairs: PairResult[];
  stability: { pass: boolean; unstablePairs: number; comparablePairs: number };
  usefulness: { pass: boolean; storesWithFixableFailure: number; stores: number };
  cost: { pass: boolean; runsOverCost: number; runsOverTime: number; maxCostUsd: number; maxSeconds: number };
  infraRuns: number; // excluded from every criterion
  go: boolean;
}

// Stability: at most 1 task-store pair may differ by more than 4 out of 10 between batches.
// Scaled for other batch sizes as "more than 40% of the batch".
const UNSTABLE_SHARE = 0.4;
const MAX_UNSTABLE_PAIRS = 1;
// Usefulness: at least half the stores have an owner-fixable failure.
const MIN_FIXABLE_SHARE = 0.5;

// Runs spoiled by infrastructure (API or network failures, catalog errors) say nothing about the store or the agent.
export const isInfra = (r: RunRecord) => r.label === "infra_error" || (r.toolErrors ?? 0) > 0;

export function evaluate(all: RunRecord[]): Verdict {
  const records = all.filter((r) => !isInfra(r));
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) {
    const key = `${r.store}\u0000${r.task}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const pairs: PairResult[] = [...groups.values()].map((rs) => {
    const count = (b: number) => {
      const inBatch = rs.filter((r) => r.batch === b);
      return { pass: inBatch.filter((r) => r.pass).length, runs: inBatch.length };
    };
    const b1 = count(1);
    const b2 = count(2);
    const comparable = b1.runs > 0 && b2.runs > 0;
    return {
      store: rs[0]!.store,
      task: rs[0]!.task,
      batch1: b1,
      batch2: b2,
      comparable,
      // Compare pass rates, so batches that lost runs to infrastructure stay comparable (4/10 of 10 runs = 40%).
      unstable: comparable && Math.abs(b1.pass / b1.runs - b2.pass / b2.runs) > UNSTABLE_SHARE,
    };
  });
  const unstablePairs = pairs.filter((p) => p.unstable).length;

  const stores = [...new Set(records.map((r) => r.store))];
  const fixable = new Set<string>(OWNER_FIXABLE);
  const storesWithFixableFailure = stores.filter((s) =>
    records.some((r) => r.store === s && !r.pass && r.label && fixable.has(r.label)),
  ).length;

  const runsOverCost = records.filter((r) => r.costUsd >= config.caps.maxCostUsd || r.end === "cap_cost").length;
  const runsOverTime = records.filter((r) => r.ms >= config.caps.maxMs || r.end === "cap_time").length;

  const comparablePairs = pairs.filter((p) => p.comparable).length;
  // Stability can only pass when there are two batches to compare.
  const stability = { pass: comparablePairs > 0 && unstablePairs <= MAX_UNSTABLE_PAIRS, unstablePairs, comparablePairs };
  const usefulness = {
    pass: stores.length > 0 && storesWithFixableFailure >= Math.ceil(MIN_FIXABLE_SHARE * stores.length),
    storesWithFixableFailure,
    stores: stores.length,
  };
  const cost = {
    pass: runsOverCost === 0 && runsOverTime === 0,
    runsOverCost,
    runsOverTime,
    maxCostUsd: Math.max(0, ...records.map((r) => r.costUsd)),
    maxSeconds: Math.max(0, ...records.map((r) => r.ms / 1000)),
  };
  return { pairs, stability, usefulness, cost, infraRuns: all.length - records.length, go: stability.pass && usefulness.pass && cost.pass };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2] ?? "results/runs.jsonl";
  const records = (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunRecord);
  const v = evaluate(records);
  for (const p of v.pairs) {
    console.log(
      `${p.store} ${p.task}: batch 1 ${p.batch1.pass}/${p.batch1.runs}, batch 2 ${p.batch2.pass}/${p.batch2.runs}${!p.comparable ? "  (needs two batches)" : p.unstable ? "  UNSTABLE" : ""}`,
    );
  }
  console.log(
    `\nStability:  ${v.stability.pass ? "pass" : "FAIL"} (${v.stability.unstablePairs} unstable of ${v.stability.comparablePairs} comparable pairs, max ${MAX_UNSTABLE_PAIRS})`,
  );
  console.log(`Usefulness: ${v.usefulness.pass ? "pass" : "FAIL"} (${v.usefulness.storesWithFixableFailure}/${v.usefulness.stores} stores with an owner-fixable failure)`);
  console.log(
    `Cost/time:  ${v.cost.pass ? "pass" : "FAIL"} (${v.cost.runsOverCost} runs over $${config.caps.maxCostUsd}, ${v.cost.runsOverTime} over ${config.caps.maxMs / 1000}s; ` +
      `max $${v.cost.maxCostUsd.toFixed(3)}, ${v.cost.maxSeconds.toFixed(0)}s)`,
  );
  console.log(`Excluded:   ${v.infraRuns} runs hit by infrastructure problems (API, network or catalog errors)`);
  console.log(`\n${v.go ? "GO" : "NO-GO"}`);
}
