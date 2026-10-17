// The Coach's two model calls and their guards (docs/coach-design.md §2–3). Every call has a
// deterministic answer computed first; that answer is returned whenever the call is skipped,
// late, fails or returns invalid output. A fallback is a success, logged at WARN.
import { setTimeout as delay } from "node:timers/promises";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  CurriculumOutputSchema,
  type CheckLineData,
  type CheckLineRequest,
  type CoachData,
  type CoachSuccess,
  type CurriculumData,
  type CurriculumRequest,
  type FallbackReason,
  type WarmData,
} from "@shared/coach-contract.ts";
import {
  curriculumFromOutput,
  curriculumOutputProblems,
  deterministicCurriculum,
  deterministicLine,
  lineProblems,
} from "@shared/coach-deterministic.ts";
import { describeIssues } from "@shared/learner.ts";
import type { Logger } from "../logger.ts";
import { costUsd, priceFor, worstCaseCostUsd, type TokenUsage } from "../prices.ts";
import { COACH_RATE_RULES, RateLimiter, type BucketRule } from "../rate-limiter.ts";
import type { SpendLedger } from "../spend-ledger.ts";
import {
  CURRICULUM_SYSTEM_PROMPT,
  LINE_SYSTEM_PROMPT,
  WARM_USER_MESSAGE,
  curriculumUserMessage,
  lineModelInput,
} from "./prompts.ts";

export const CURRICULUM_MODEL = "claude-sonnet-5-5";
export const LINE_MODEL = "claude-haiku-5-5";
export const CURRICULUM_MAX_TOKENS = 8000;
export const LINE_MAX_TOKENS = 120;
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * The Curriculum output schema as sent to the API, built from the catalogue enums. Built with zod
 * directly rather than the SDK's `betaZodOutputFormat`: SDK 0.135.0 moves `enum` into the
 * description, so the API would not enforce the catalogue ids.
 */
export function curriculumJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(CurriculumOutputSchema) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema"));
}

/** Per-job time limits (coach-design §3). Tests shorten them. */
export interface CoachTimings {
  /** The line fills at min(LLM, this); after it the deterministic line is returned. */
  readonly lineDeadlineMs: number;
  readonly lineAttemptTimeoutMs: number;
  readonly placementDeadlineMs: number;
  readonly placementAttemptTimeoutMs: number;
  /** One retry only when the first attempt failed this fast on 429, 5xx or a connection error. */
  readonly placementRetryIfFailedWithinMs: number;
  readonly placementRetryDelayMs: number;
  readonly backgroundDeadlineMs: number;
  readonly backgroundAttemptTimeoutMs: number;
  readonly backgroundMaxRetries: number;
  readonly warmTimeoutMs: number;
}

export const DEFAULT_COACH_TIMINGS: CoachTimings = {
  lineDeadlineMs: 1200,
  lineAttemptTimeoutMs: 1000,
  placementDeadlineMs: 20_000,
  placementAttemptTimeoutMs: 15_000,
  placementRetryIfFailedWithinMs: 5_000,
  placementRetryDelayMs: 1_000,
  backgroundDeadlineMs: 95_000,
  backgroundAttemptTimeoutMs: 30_000,
  backgroundMaxRetries: 2,
  warmTimeoutMs: 5_000,
};

export interface CoachServiceOptions {
  /** `null` = no-key mode: every job answers from the deterministic Coach. */
  readonly client: Anthropic | null;
  readonly ledger: SpendLedger;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly timings?: Partial<CoachTimings>;
  readonly logPayloads?: boolean;
}

type AnthropicFailure = InstanceType<typeof Anthropic.AnthropicError>;

class DeadlineExceeded extends Error {
  override readonly name = "DeadlineExceeded";
}

/** Runs `task` with an abort signal that fires after `ms`; throws `DeadlineExceeded` then. */
async function withDeadline<T>(ms: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineExceeded(`No answer within ${String(ms)} ms.`));
    }, ms);
  });
  try {
    return await Promise.race([task(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** What one model call produced, before it becomes a response. */
type CallOutcome<Data> =
  | { readonly kind: "llm"; readonly data: Data; readonly model: string; readonly usage: TokenUsage; readonly output: unknown }
  | {
      readonly kind: "rejected";
      readonly reason: FallbackReason;
      readonly problems: readonly string[];
      readonly model: string;
      readonly usage: TokenUsage;
      readonly output: unknown;
    };

interface JobSpec<Data extends CoachData> {
  readonly job: "curriculum" | "checkLine" | "warm";
  readonly learnerId: string;
  readonly requestId: string | null;
  readonly rateRule: BucketRule;
  readonly fallback: Data;
  readonly model: string;
  readonly worstCaseUsd: number;
  readonly deadlineMs: number;
  readonly payload: unknown;
  readonly call: (client: Anthropic, signal: AbortSignal) => Promise<CallOutcome<Data>>;
}

function fallbackReasonFor(error: DeadlineExceeded | AnthropicFailure): FallbackReason {
  if (error instanceof DeadlineExceeded || error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.RateLimitError) return "rateLimited";
  return "apiError";
}

/** An HTTP error answer is not billed; a lost connection or a timeout may have been. */
function mayHaveBeenBilled(error: DeadlineExceeded | AnthropicFailure): boolean {
  return !(error instanceof Anthropic.APIError && error.status !== undefined);
}

function textOf(content: readonly { type: string }[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block)
    .map((block) => block.text)
    .join("")
    .trim();
}

function isRetryableQuickFailure(error: unknown): boolean {
  return (
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError ||
    (error instanceof Anthropic.APIConnectionError && !(error instanceof Anthropic.APIConnectionTimeoutError))
  );
}

export class CoachService {
  private readonly client: Anthropic | null;
  private readonly ledger: SpendLedger;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly timings: CoachTimings;
  private readonly logPayloads: boolean;
  private readonly rateLimiter: RateLimiter;

  constructor(options: CoachServiceOptions) {
    this.client = options.client;
    this.ledger = options.ledger;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.timings = { ...DEFAULT_COACH_TIMINGS, ...options.timings };
    this.logPayloads = options.logPayloads ?? false;
    this.rateLimiter = new RateLimiter(() => this.now().getTime());
  }

  get hasKey(): boolean {
    return this.client !== null;
  }

  curriculum(learnerId: string, request: CurriculumRequest): Promise<CoachSuccess<CurriculumData>> {
    const userMessage = curriculumUserMessage(request);
    const placement = request.reason === "placement";
    const t = this.timings;
    const params = {
      model: CURRICULUM_MODEL,
      max_tokens: CURRICULUM_MAX_TOKENS,
      betas: [SERVER_SIDE_FALLBACK_BETA],
      fallbacks: "default" as const,
      thinking: { type: "adaptive" as const },
      output_config: { effort: "medium" as const, format: { type: "json_schema" as const, schema: curriculumJsonSchema() } },
      system: [{ type: "text" as const, text: CURRICULUM_SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }],
      messages: [{ role: "user" as const, content: userMessage }],
    };

    const attempt = (client: Anthropic, signal: AbortSignal) =>
      client.beta.messages.create(params, {
        signal,
        timeout: placement ? t.placementAttemptTimeoutMs : t.backgroundAttemptTimeoutMs,
        maxRetries: placement ? 0 : t.backgroundMaxRetries,
      });

    const callWithRetryPolicy = async (client: Anthropic, signal: AbortSignal) => {
      if (!placement) return attempt(client, signal);
      const startedAt = performance.now();
      try {
        return await attempt(client, signal);
      } catch (error) {
        const quick = performance.now() - startedAt < t.placementRetryIfFailedWithinMs;
        if (!quick || !isRetryableQuickFailure(error)) throw error;
        this.logger.warn("coach.retry", { job: "curriculum", requestId: request.requestId });
        await delay(t.placementRetryDelayMs, undefined, { signal });
        return attempt(client, signal);
      }
    };

    return this.run({
      job: "curriculum",
      learnerId,
      requestId: request.requestId,
      rateRule: COACH_RATE_RULES.curriculum,
      fallback: deterministicCurriculum(request.demonstrated),
      model: CURRICULUM_MODEL,
      worstCaseUsd: worstCaseCostUsd(
        CURRICULUM_SYSTEM_PROMPT.length + userMessage.length,
        CURRICULUM_MAX_TOKENS,
        priceFor(CURRICULUM_MODEL).price,
      ),
      deadlineMs: placement ? t.placementDeadlineMs : t.backgroundDeadlineMs,
      payload: userMessage,
      call: async (client, signal): Promise<CallOutcome<CurriculumData>> => {
        const response = await callWithRetryPolicy(client, signal);
        const base = { model: response.model, usage: response.usage };
        const text = textOf(response.content);
        if (response.stop_reason === "refusal") {
          return { kind: "rejected", reason: "refusal", problems: ["stop_reason: refusal"], output: text, ...base };
        }
        if (response.stop_reason !== "end_turn") {
          return { kind: "rejected", reason: "invalidOutput", problems: [`stop_reason: ${String(response.stop_reason)}`], output: text, ...base };
        }
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          return { kind: "rejected", reason: "invalidOutput", problems: ["output is not JSON"], output: text, ...base };
        }
        const parsed = CurriculumOutputSchema.safeParse(json);
        if (!parsed.success) {
          return { kind: "rejected", reason: "invalidOutput", problems: describeIssues(parsed.error), output: json, ...base };
        }
        const problems = curriculumOutputProblems(parsed.data, request.demonstrated);
        if (problems.length > 0) return { kind: "rejected", reason: "invalidOutput", problems, output: json, ...base };
        return { kind: "llm", data: curriculumFromOutput(parsed.data, request.demonstrated), output: json, ...base };
      },
    });
  }

  line(learnerId: string, request: CheckLineRequest): Promise<CoachSuccess<CheckLineData>> {
    const modelInput = lineModelInput(request);
    const userMessage = JSON.stringify(modelInput);
    const t = this.timings;
    return this.run({
      job: "checkLine",
      learnerId,
      requestId: request.requestId,
      rateRule: COACH_RATE_RULES.line,
      fallback: { job: "checkLine", line: deterministicLine(request) },
      model: LINE_MODEL,
      worstCaseUsd: worstCaseCostUsd(LINE_SYSTEM_PROMPT.length + userMessage.length, LINE_MAX_TOKENS, priceFor(LINE_MODEL).price),
      deadlineMs: t.lineDeadlineMs,
      payload: modelInput,
      call: async (client, signal): Promise<CallOutcome<CheckLineData>> => {
        const response = await client.messages.create(
          {
            model: LINE_MODEL,
            max_tokens: LINE_MAX_TOKENS,
            thinking: { type: "disabled" },
            output_config: { effort: "low" },
            system: [{ type: "text", text: LINE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: userMessage }],
          },
          { signal, timeout: t.lineAttemptTimeoutMs, maxRetries: 0 },
        );
        const base = { model: response.model, usage: response.usage };
        const line = textOf(response.content);
        if (response.stop_reason === "refusal") {
          return { kind: "rejected", reason: "refusal", problems: ["stop_reason: refusal"], output: line, ...base };
        }
        if (response.stop_reason !== "end_turn") {
          return { kind: "rejected", reason: "invalidOutput", problems: [`stop_reason: ${String(response.stop_reason)}`], output: line, ...base };
        }
        const problems = lineProblems(line, request, modelInput);
        if (problems.length > 0) return { kind: "rejected", reason: "invalidOutput", problems, output: line, ...base };
        return { kind: "llm", data: { job: "checkLine", line }, output: line, ...base };
      },
    });
  }

  /** Pre-warms the line cache at session start with a `max_tokens: 0` request. */
  warm(learnerId: string): Promise<CoachSuccess<WarmData>> {
    const t = this.timings;
    return this.run({
      job: "warm",
      learnerId,
      requestId: null,
      rateRule: COACH_RATE_RULES.warm,
      fallback: { job: "warm" },
      model: LINE_MODEL,
      worstCaseUsd: worstCaseCostUsd(LINE_SYSTEM_PROMPT.length + WARM_USER_MESSAGE.length, 0, priceFor(LINE_MODEL).price),
      deadlineMs: t.warmTimeoutMs,
      payload: null,
      call: async (client, signal): Promise<CallOutcome<WarmData>> => {
        const response = await client.messages.create(
          {
            model: LINE_MODEL,
            max_tokens: 0,
            thinking: { type: "disabled" },
            output_config: { effort: "low" },
            system: [{ type: "text", text: LINE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: WARM_USER_MESSAGE }],
          },
          { signal, timeout: t.warmTimeoutMs, maxRetries: 0 },
        );
        return { kind: "llm", data: { job: "warm" }, model: response.model, usage: response.usage, output: null };
      },
    });
  }

  private async run<Data extends CoachData>(spec: JobSpec<Data>): Promise<CoachSuccess<Data>> {
    const ids = { job: spec.job, learnerId: spec.learnerId, requestId: spec.requestId };
    const fallback = (fallbackReason: FallbackReason, fields: Record<string, unknown> = {}): CoachSuccess<Data> => {
      const entry = { ...ids, source: "fallback", fallbackReason, ...fields };
      if (fallbackReason === "noKey") this.logger.info("coach.call", entry);
      else this.logger.warn("coach.call", entry);
      return { success: true, source: "fallback", data: spec.fallback, fallbackReason };
    };

    if (this.client === null) return fallback("noKey");
    const client = this.client;
    // One bucket per job for the whole server, so creating Learners cannot buy extra calls.
    if (!this.rateLimiter.tryTake(spec.job, spec.rateRule)) return fallback("rateLimited");
    const reservation = this.ledger.tryReserve(spec.learnerId, spec.worstCaseUsd, this.now());
    if (reservation === null) {
      return fallback("budgetCap", { spentUsd: this.ledger.spentUsd(this.now()), capUsd: this.ledger.monthlyCapUsd });
    }

    const startedAt = performance.now();
    // Until the call's real cost is known, assume the worst: a bug after a billed answer must
    // not record the call as free. Exactly one settle runs, whatever happens below.
    let chargedUsd = spec.worstCaseUsd;
    try {
      let outcome: CallOutcome<Data>;
      try {
        outcome = await withDeadline(spec.deadlineMs, (signal) => spec.call(client, signal));
      } catch (error) {
        if (!(error instanceof DeadlineExceeded || error instanceof Anthropic.AnthropicError)) throw error;
        chargedUsd = mayHaveBeenBilled(error) ? spec.worstCaseUsd : 0;
        return fallback(fallbackReasonFor(error), {
          model: spec.model,
          latencyMs: Math.round(performance.now() - startedAt),
          error: error.name,
          status: error instanceof Anthropic.APIError ? error.status : undefined,
          costUsd: chargedUsd,
          costIsWorstCase: chargedUsd > 0,
        });
      }

      const latencyMs = Math.round(performance.now() - startedAt);
      const { price, known } = priceFor(outcome.model);
      if (!known) this.logger.warn("coach.unknownPrice", { model: outcome.model, note: "priced at the highest rate" });
      chargedUsd = costUsd(outcome.usage, price);
      const fields = {
        model: outcome.model,
        latencyMs,
        inputTokens: outcome.usage.input_tokens,
        outputTokens: outcome.usage.output_tokens,
        cacheReadTokens: outcome.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: outcome.usage.cache_creation_input_tokens ?? 0,
        costUsd: chargedUsd,
        ...(this.logPayloads ? { payload: spec.payload, output: outcome.output } : {}),
      };

      if (outcome.kind === "rejected") return fallback(outcome.reason, { ...fields, problems: outcome.problems });
      this.logger.info("coach.call", { ...ids, source: "llm", ...fields });
      return { success: true, source: "llm", data: outcome.data, model: outcome.model, latencyMs };
    } finally {
      await this.ledger.settle(reservation, chargedUsd);
    }
  }
}
