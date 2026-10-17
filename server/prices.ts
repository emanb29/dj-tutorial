// Claude API prices in US dollars per million tokens, for prompts up to 100k tokens.
// Source: the claude-api skill's model table (cached 2026-10-06) and its prompt-caching economics:
// a 5-minute cache write costs 1.25× input, a cache read 0.1× input. Thinking tokens bill as output.
// Re-check https://platform.claude.com/docs/en/about-claude/pricing before changing a model.

export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  // Server-side refusal fallbacks may answer with these models instead.
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
};

/** Used for a model missing from the table, so an unknown model can only overstate spend. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { inputPerMTok: 10, outputPerMTok: 50 };

export function priceFor(model: string): { readonly price: ModelPrice; readonly known: boolean } {
  const price = MODEL_PRICES[model];
  return price === undefined ? { price: UNKNOWN_MODEL_PRICE, known: false } : { price, known: true };
}

/** The usage fields of a Messages API response that affect cost. */
export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

export function costUsd(usage: TokenUsage, price: ModelPrice): number {
  const perToken = (perMTok: number) => perMTok / 1_000_000;
  return (
    usage.input_tokens * perToken(price.inputPerMTok) +
    (usage.cache_creation_input_tokens ?? 0) * perToken(price.inputPerMTok) * CACHE_WRITE_MULTIPLIER +
    (usage.cache_read_input_tokens ?? 0) * perToken(price.inputPerMTok) * CACHE_READ_MULTIPLIER +
    usage.output_tokens * perToken(price.outputPerMTok)
  );
}

/**
 * An upper bound on one call's cost before it is made: every input token as a cache write and
 * `maxOutputTokens` of output. Input tokens are estimated at one per 3 characters, which
 * overcounts English and JSON.
 */
export function worstCaseCostUsd(inputCharacters: number, maxOutputTokens: number, price: ModelPrice): number {
  const inputTokens = Math.ceil(inputCharacters / 3);
  return costUsd({ input_tokens: 0, cache_creation_input_tokens: inputTokens, output_tokens: maxOutputTokens }, price);
}
