import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_PRICES, UNKNOWN_MODEL_PRICE, costUsd, priceFor } from "./prices.ts";
import { SpendLedger, SpendLedgerError, monthKey } from "./spend-ledger.ts";

let dataDir: string;
const october = new Date("2026-10-17T12:00:00Z");
const november = new Date("2026-11-01T00:00:00Z");

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ltd-ledger-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("costUsd", () => {
  it("prices a warm Haiku line: 2.5k cache read + 600 input + 40 output", () => {
    const haiku = MODEL_PRICES["claude-haiku-5-5"];
    if (haiku === undefined) throw new Error("Haiku price missing");

    const cost = costUsd(
      { input_tokens: 600, output_tokens: 40, cache_read_input_tokens: 2500, cache_creation_input_tokens: 0 },
      haiku,
    );

    // 600 × $0.10/M + 2500 × $0.01/M + 40 × $0.50/M = $0.000105
    expect(cost).toBeCloseTo(0.000105, 9);
  });

  it("prices a Sonnet Curriculum: 4k cache write + 2k input + 2.5k output", () => {
    const sonnet = MODEL_PRICES["claude-sonnet-5-5"];
    if (sonnet === undefined) throw new Error("Sonnet price missing");

    const cost = costUsd({ input_tokens: 2000, output_tokens: 2500, cache_creation_input_tokens: 4000 }, sonnet);

    // 2000 × $2/M + 4000 × $2.50/M + 2500 × $10/M = $0.039
    expect(cost).toBeCloseTo(0.039, 9);
  });

  it("overstates rather than understates an unknown model", () => {
    expect(priceFor("claude-unknown-9")).toEqual({ price: UNKNOWN_MODEL_PRICE, known: false });
  });
});

describe("SpendLedger", () => {
  it("records spend per month, in total and per Learner, and keeps it across a restart", async () => {
    const ledger = await SpendLedger.open(dataDir, 5);

    const first = ledger.tryReserve("default", 0.1, october);
    const second = ledger.tryReserve("guest", 0.1, october);
    if (first === null || second === null) throw new Error("expected reservations under the cap");
    await ledger.settle(first, 0.03);
    await ledger.settle(second, 0.01);

    const reopened = await SpendLedger.open(dataDir, 5);
    expect(reopened.spentUsd(october)).toBeCloseTo(0.04, 9);
    expect(reopened.spentUsd(october, "default")).toBeCloseTo(0.03, 9);
    expect(reopened.spentUsd(october, "guest")).toBeCloseTo(0.01, 9);
    expect(reopened.spentUsd(november)).toBe(0);
  });

  it("refuses a call whose worst case would cross the cap, counting calls in flight", async () => {
    const ledger = await SpendLedger.open(dataDir, 1);

    const inFlight = ledger.tryReserve("default", 0.6, october);

    expect(inFlight).not.toBeNull();
    expect(ledger.tryReserve("default", 0.6, october)).toBeNull();
    expect(ledger.tryReserve("default", 0.4, october)).not.toBeNull();
  });

  it("stays at the cap for the rest of the month and resets on the 1st (UTC)", async () => {
    const ledger = await SpendLedger.open(dataDir, 0.05);
    const reservation = ledger.tryReserve("default", 0.05, october);
    if (reservation === null) throw new Error("expected a reservation");
    await ledger.settle(reservation, 0.05);

    expect(ledger.tryReserve("default", 0.000001, october)).toBeNull();
    expect(ledger.tryReserve("default", 0.000001, november)).not.toBeNull();
  });

  it("still counts the spend toward the cap when the ledger file cannot be written", async () => {
    const ledger = await SpendLedger.open(dataDir, 0.05);
    const reservation = ledger.tryReserve("default", 0.05, october);
    if (reservation === null) throw new Error("expected a reservation");
    // Replace the directory with a plain file, so every write fails.
    await rm(dataDir, { recursive: true, force: true });
    await writeFile(dataDir, "not a directory");

    await expect(ledger.settle(reservation, 0.05)).rejects.toThrow();

    expect(ledger.spentUsd(october)).toBeCloseTo(0.05, 9);
    expect(ledger.tryReserve("default", 0.000001, october)).toBeNull();
  });

  it("turns every model call off with a cap of 0", async () => {
    const ledger = await SpendLedger.open(dataDir, 0);
    expect(ledger.tryReserve("default", 0.000001, october)).toBeNull();
  });

  it("refuses to start on an unreadable ledger rather than forget this month's spend", async () => {
    await writeFile(join(dataDir, "coach-usage.json"), JSON.stringify({ schemaVersion: 1, months: { "2026-10": { totalUsd: -1 } } }));
    await expect(SpendLedger.open(dataDir, 5)).rejects.toBeInstanceOf(SpendLedgerError);
  });

  it("keys months in UTC", () => {
    expect(monthKey(new Date("2026-10-31T23:59:59-05:00"))).toBe("2026-11");
  });
});
