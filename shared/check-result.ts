/**
 * What a Check returns (docs/check-design.md §9). A void attempt is its own type, so it can never
 * be recorded as a fail.
 */
import type {
  Aids,
  CheckMode,
  CheckVariant,
  CtxTime,
  DeckId,
  InputDevice,
  IsoTime,
  LessonId,
} from "./attempt.ts";

export const STANDING_IDS = [
  "no-clip",
  "no-dead-air",
  "on-phrase",
  "level-match",
  "cued-first",
  "trim-still",
  "no-boost",
  "controls-reset",
  "sync-kept",
  "no-recue",
  "one-bass",
  "drift",
  "overcorrect",
  "key-clash",
  "technique-mix",
] as const;

export type StandingId = (typeof STANDING_IDS)[number];

/** `<lesson>.<criterion>` for a Lesson's own criteria, `standing.<id>` for standing ones. */
export type CriterionId = `${LessonId}.${string}` | `standing.${StandingId}`;

/** `fail` blocks the pass; `warn` is reported only; `report` is a metric for the Coach. */
export type Severity = "fail" | "warn" | "report";
export type Band = "pass" | "merit" | "distinction";
export type Unit =
  | "ms"
  | "beats"
  | "bars"
  | "dB"
  | "dBFS"
  | "LUFS"
  | "BPM"
  | "ratio"
  | "count"
  | "s"
  | "position";

export interface Threshold {
  /** `<` is strict: a value equal to the threshold is not met (e.g. dead air "≥ 1.0 s" fails). */
  readonly op: "<=" | "<" | ">=" | "==" | "in";
  readonly value: number | readonly [number, number];
  readonly unit: Unit;
}

export type CriterionStatus = "met" | "notMet" | "notApplicable";

export interface Evidence {
  readonly from: CtxTime;
  readonly to: CtxTime;
  readonly label: string;
}

export interface CriterionResult {
  readonly id: CriterionId;
  readonly severity: Severity;
  readonly status: CriterionStatus;
  /**
   * The measured value. `null` when notApplicable, or when there was nothing to measure (e.g. no
   * Ready press, deck B never played); then the status is notMet.
   */
  readonly measured: number | null;
  readonly unit: Unit;
  readonly threshold: Threshold | null;
  /** `≥ 0` means met: `(threshold − measured) / |threshold|`, sign-adjusted. `null` with `measured`. */
  readonly margin: number | null;
  readonly evidence: readonly Evidence[];
  readonly detail?: Readonly<Record<string, number>>;
}

export type VoidReason = "contextSuspended" | "tabHidden" | "gridUntrusted" | "abandoned";

export interface FinalMixBands {
  readonly beatSyncing: Band;
  readonly balance: Band;
  readonly phrasing: Band;
  /** Derived: lowest of the three. */
  readonly overall: Band;
}

export type CheckOutcome =
  | { readonly kind: "passed"; readonly bands?: FinalMixBands }
  | { readonly kind: "failed"; readonly failedCriteria: readonly CriterionId[] };

interface AttemptIdentity {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly learnerId: string;
  readonly lessonId: LessonId;
  readonly mode: CheckMode;
  readonly variant: CheckVariant;
  readonly startedAt: IsoTime;
  readonly endedAt: IsoTime;
  readonly inputDevice: InputDevice;
}

/** A graded (non-void) attempt. Only these are written to the Skill profile. */
export interface CheckResult extends AttemptIdentity {
  readonly endReason: "done" | "timeout";
  readonly outcome: CheckOutcome;
  /** Own criteria plus applicable standing criteria. */
  readonly criteria: readonly CriterionResult[];
  readonly tracks: readonly {
    readonly trackId: string;
    readonly trackSetId: string | null;
    readonly deck: DeckId;
  }[];
  readonly aids: Aids;
  /** Report-only values for the Coach, e.g. `medianTapOffsetMs`. */
  readonly metrics: Readonly<Record<string, number>>;
}

/** Not pass, not fail, not counted. Never written to the Skill profile. */
export interface VoidAttempt extends AttemptIdentity {
  readonly outcome: { readonly kind: "void"; readonly reason: VoidReason };
}
