// Runs the step 3 prototype: each task repeated in batches against one store, one JSON line per run.
//
//   npm run probe -- --store www.beardbrand.com --brand Beardbrand --tasks find,compare --batches 2 --runs 10
//   npm run probe -- --store www.beardbrand.com --brand Beardbrand --dry     (print the generated tasks; no model calls)

import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Catalog } from "./catalog.js";
import { runCheckout } from "./checkout.js";
import { config } from "./config.js";
import { runCompare, runFind } from "./discovery.js";
import { fetchStoreProducts } from "./store.js";
import { makeCheckoutTask, makeCompareTask, makeFindTask, type Task, type TaskKind } from "./tasks.js";

export interface RunRecord {
  store: string;
  task: TaskKind;
  batch: number;
  run: number;
  pass: boolean;
  label?: string;
  detail: string;
  end: string;
  steps: number;
  tokens: { input: number; cacheWrite: number; cacheRead: number; output: number };
  costUsd: number;
  ms: number;
  model: string;
  modelsServed: string[];
  at: string;
}

const { values } = parseArgs({
  options: {
    store: { type: "string" },
    brand: { type: "string" },
    tasks: { type: "string", default: "find,compare" },
    batches: { type: "string", default: "2" },
    runs: { type: "string", default: "10" },
    country: { type: "string", default: "US" },
    currency: { type: "string", default: "USD" },
    out: { type: "string", default: "results" },
    dry: { type: "boolean", default: false },
  },
});

const domain = values.store;
if (!domain) throw new Error("--store <domain> is required, e.g. --store www.beardbrand.com");
const brand = values.brand ?? domain.replace(/^www\./, "").split(".")[0]!;
const kinds = values.tasks.split(",").map((t) => t.trim()) as TaskKind[];
const context = { address_country: values.country, currency: values.currency };

const products = await fetchStoreProducts(domain);
const tasks: Task[] = kinds.map((k) =>
  k === "find" ? makeFindTask(brand, products)
  : k === "compare" ? makeCompareTask(brand, products)
  : makeCheckoutTask(brand, domain, products),
);

if (values.dry) {
  console.log(JSON.stringify({ store: domain, brand, context, model: config.model, caps: config.caps, tasks }, null, 2));
  process.exit(0);
}

await mkdir(`${values.out}/transcripts`, { recursive: true });
const logFile = `${values.out}/runs.jsonl`;
const catalog = await Catalog.connect();
try {
  for (let batch = 1; batch <= Number(values.batches); batch++) {
    for (let run = 1; run <= Number(values.runs); run++) {
      for (const task of tasks) {
        const { loop, grade } =
          task.kind === "find" ? await runFind(task, domain, catalog, context)
          : task.kind === "compare" ? await runCompare(task, domain, catalog, context)
          : await runCheckout(task, domain);
        const record: RunRecord = {
          store: domain,
          task: task.kind,
          batch,
          run,
          pass: grade.pass,
          label: grade.label,
          detail: grade.detail,
          end: loop.end,
          steps: loop.steps,
          tokens: loop.tokens,
          costUsd: Number(loop.costUsd.toFixed(4)),
          ms: loop.ms,
          model: config.model,
          modelsServed: loop.modelsServed,
          at: new Date().toISOString(),
        };
        await appendFile(logFile, JSON.stringify(record) + "\n");
        await writeFile(
          `${values.out}/transcripts/${domain}-${task.kind}-b${batch}-r${run}.json`,
          JSON.stringify({ task, record, transcript: loop.transcript }, null, 2),
        );
        console.log(
          `${domain} ${task.kind} b${batch} r${run}: ${grade.pass ? "PASS" : `FAIL (${grade.label})`} ` +
            `${loop.steps} steps $${record.costUsd} ${(loop.ms / 1000).toFixed(1)}s cache ${cacheShare(loop.tokens)}% - ${grade.detail}`,
        );
      }
    }
  }
} finally {
  await catalog.close();
}

// Share of input tokens served from cache; near 0 after the first turn means caching isn't working.
function cacheShare(t: RunRecord["tokens"]): number {
  const total = t.input + t.cacheWrite + t.cacheRead;
  return total ? Math.round((100 * t.cacheRead) / total) : 0;
}
