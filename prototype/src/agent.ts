// Manual tool-use loop shared by all tasks. It is manual (not the SDK tool runner) because every turn must
// check the step 4 caps: steps, wall-clock time and cost.

import Anthropic from "@anthropic-ai/sdk";
import { config, costUsd, FALLBACK_MODELS, type TokenUsage } from "./config.js";

type Tool = Anthropic.Beta.Messages.BetaTool;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export const SUBMIT_TOOL = "submit_answer";
const MAX_NUDGES = 1;

export interface LoopResult {
  end: "submitted" | "no_answer" | "cap_steps" | "cap_time" | "cap_cost" | "refusal";
  answer?: unknown; // input of the submit_answer call
  steps: number;
  nudges: number; // reminders to call submit_answer after the model answered in plain text
  toolErrors: number; // failed tool calls, e.g. catalog timeouts; runs with these may reflect infrastructure, not the store
  tokens: TokenUsage;
  costUsd: number;
  ms: number;
  modelsServed: string[]; // differs from config.model when a fallback served a turn
  transcript: MessageParam[];
}

export interface LoopOptions {
  system: string;
  prompt: string;
  tools: Tool[]; // must include a tool named SUBMIT_TOOL
  // Runs one tool call and returns its text result; throw to report a tool error to the model.
  execute: (name: string, input: unknown) => Promise<string>;
}

let client: Anthropic | undefined; // created on first use so dry runs work without credentials

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  client ??= new Anthropic();
  const started = Date.now();
  const messages: MessageParam[] = [{ role: "user", content: opts.prompt }];
  const r: LoopResult = {
    end: "no_answer",
    steps: 0,
    nudges: 0,
    toolErrors: 0,
    tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    costUsd: 0,
    ms: 0,
    modelsServed: [],
    transcript: messages,
  };

  while (true) {
    if (r.steps >= config.caps.maxSteps) return finish(r, "cap_steps", started);
    if (Date.now() - started >= config.caps.maxMs) return finish(r, "cap_time", started);
    if (r.costUsd >= config.caps.maxCostUsd) return finish(r, "cap_cost", started);

    const response = await client.beta.messages.create(
      {
        model: config.model,
        max_tokens: 16000,
        // Caching: an explicit breakpoint after the fixed tools + system prompt (identical across runs of a task),
        // plus automatic caching, which moves a breakpoint to the end of the growing conversation each turn.
        system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
        tools: opts.tools,
        messages,
        cache_control: { type: "ephemeral" },
        // A classifier decline is retried server-side on Anthropic's recommended model, where the model supports it.
        ...(FALLBACK_MODELS.has(config.model)
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      },
      { timeout: Math.max(1_000, config.caps.maxMs - (Date.now() - started)) },
    );
    r.steps++;
    const u = response.usage;
    const turn: TokenUsage = {
      input: u.input_tokens,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens,
    };
    for (const k of Object.keys(turn) as (keyof TokenUsage)[]) r.tokens[k] += turn[k];
    r.costUsd += costUsd(response.model, turn);
    if (!r.modelsServed.includes(response.model)) r.modelsServed.push(response.model);

    if (response.stop_reason === "refusal") return finish(r, "refusal", started);
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue;

    const calls = response.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason === "max_tokens") return finish(r, "no_answer", started);
    if (calls.length === 0) {
      // Some models answer in plain text instead of calling submit_answer. That is a format slip, not a store
      // problem, so remind once before counting the run as unanswered.
      if (r.nudges >= MAX_NUDGES) return finish(r, "no_answer", started);
      r.nudges++;
      messages.push({ role: "user", content: `Please record your answer by calling ${SUBMIT_TOOL}.` });
      continue;
    }

    const submit = calls.find((c) => c.name === SUBMIT_TOOL);
    if (submit) {
      r.answer = submit.input;
      return finish(r, "submitted", started);
    }

    const results: ToolResult[] = [];
    for (const call of calls) {
      try {
        results.push({ type: "tool_result", tool_use_id: call.id, content: await opts.execute(call.name, call.input) });
      } catch (err) {
        r.toolErrors++;
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: String(err) });
      }
    }
    messages.push({ role: "user", content: results }); // all results for a turn go back in one message
  }
}

function finish(r: LoopResult, end: LoopResult["end"], started: number): LoopResult {
  r.end = end;
  r.ms = Date.now() - started;
  return r;
}
