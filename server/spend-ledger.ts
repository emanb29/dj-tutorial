import { join } from "node:path";
import { z } from "zod";
import { describeIssues } from "@shared/learner.ts";
import { SerialQueue, readJsonIfPresent, writeJsonAtomic } from "./json-file.ts";

export const SPEND_LEDGER_SCHEMA_VERSION = 1;
export const SPEND_LEDGER_FILE = "coach-usage.json";

const MonthSchema = z.strictObject({
  totalUsd: z.number().nonnegative(),
  calls: z.int().nonnegative(),
  byLearner: z.record(z.string(), z.number().nonnegative()),
});
type Month = z.infer<typeof MonthSchema>;

const LedgerFileSchema = z.strictObject({
  schemaVersion: z.literal(SPEND_LEDGER_SCHEMA_VERSION),
  /** Keyed by UTC month, "YYYY-MM". */
  months: z.record(z.string().regex(/^\d{4}-\d{2}$/), MonthSchema),
});

export class SpendLedgerError extends Error {
  override readonly name = "SpendLedgerError";

  constructor(
    readonly path: string,
    readonly problems: readonly string[],
  ) {
    super(
      `The Coach spend ledger ${path} cannot be read, so the server will not start (without it the spend cap cannot be enforced).\n- ${problems.join("\n- ")}\nFix the file by hand, or move it aside to start this month's count from zero.`,
    );
  }
}

/** Money set aside for a call in flight. Settle it exactly once with what the call really cost. */
export interface Reservation {
  readonly learnerId: string;
  readonly month: string;
  readonly worstCaseUsd: number;
}

/** The calendar month a wall-clock time falls in, in UTC. The cap resets on the 1st (UTC). */
export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Coach spend per UTC month, in total and per Learner, with a hard cap. A call reserves its worst
 * case first, so concurrent calls together can never push the month past the cap.
 */
export class SpendLedger {
  private readonly writes = new SerialQueue();
  private readonly reservedByMonth = new Map<string, number>();

  private constructor(
    private readonly path: string,
    private readonly capUsd: number,
    private months: Readonly<Record<string, Month>>,
  ) {}

  static async open(dataDir: string, capUsd: number): Promise<SpendLedger> {
    const path = join(dataDir, SPEND_LEDGER_FILE);
    let raw: unknown;
    try {
      raw = await readJsonIfPresent(path);
    } catch (error) {
      throw new SpendLedgerError(path, [error instanceof Error ? error.message : String(error)]);
    }
    if (raw === undefined) return new SpendLedger(path, capUsd, {});
    const parsed = LedgerFileSchema.safeParse(raw);
    if (!parsed.success) throw new SpendLedgerError(path, describeIssues(parsed.error));
    return new SpendLedger(path, capUsd, parsed.data.months);
  }

  get monthlyCapUsd(): number {
    return this.capUsd;
  }

  spentUsd(now: Date, learnerId?: string): number {
    const month = this.months[monthKey(now)];
    if (month === undefined) return 0;
    return learnerId === undefined ? month.totalUsd : (month.byLearner[learnerId] ?? 0);
  }

  /** Reserves `worstCaseUsd`, or returns `null` when that would cross this month's cap. */
  tryReserve(learnerId: string, worstCaseUsd: number, now: Date): Reservation | null {
    const month = monthKey(now);
    const reserved = this.reservedByMonth.get(month) ?? 0;
    if (this.spentUsd(now) + reserved + worstCaseUsd > this.capUsd) return null;
    this.reservedByMonth.set(month, reserved + worstCaseUsd);
    return { learnerId, month, worstCaseUsd };
  }

  /**
   * Records `actualUsd` against the reservation's month, then releases the reservation, both in
   * memory first so the cap holds even if the write below fails. Resolves once on disk.
   */
  settle(reservation: Reservation, actualUsd: number): Promise<void> {
    const current = this.months[reservation.month] ?? { totalUsd: 0, calls: 0, byLearner: {} };
    this.months = {
      ...this.months,
      [reservation.month]: {
        totalUsd: current.totalUsd + actualUsd,
        calls: current.calls + 1,
        byLearner: {
          ...current.byLearner,
          [reservation.learnerId]: (current.byLearner[reservation.learnerId] ?? 0) + actualUsd,
        },
      },
    };
    const reserved = this.reservedByMonth.get(reservation.month) ?? 0;
    this.reservedByMonth.set(reservation.month, Math.max(0, reserved - reservation.worstCaseUsd));
    return this.writes.run(() =>
      writeJsonAtomic(this.path, { schemaVersion: SPEND_LEDGER_SCHEMA_VERSION, months: this.months }),
    );
  }
}
