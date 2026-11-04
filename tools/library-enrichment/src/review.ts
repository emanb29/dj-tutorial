/**
 * The review page: one card per medium-band proposal not yet decided, with its evidence. It is a
 * static file; its buttons build decision lines (JSONL) to save and append to the decision log,
 * which every later run reads.
 */
import { latestDecisions, resolveField, type Decision } from "./apply.ts";
import { baseHas, type EnrichedField, type Proposal, type StoreItem } from "./store.ts";

export interface ReviewCard {
  readonly hash: string;
  readonly name: string;
  readonly field: EnrichedField;
  readonly proposal: Proposal;
}

export function reviewCards(items: readonly StoreItem[], decisions: readonly Decision[], fields: readonly EnrichedField[]): ReviewCard[] {
  const latest = latestDecisions(decisions);
  return items.flatMap((item) =>
    fields.flatMap((field) => {
      if (baseHas(item.base, field)) return [];
      const proposal = resolveField(item, field, latest);
      if (proposal?.band !== "medium") return [];
      const decided = latest.get(`${item.hash}\u0000${field}\u0000${proposal.value}`);
      return decided === "accept" ? [] : [{ hash: item.hash, name: item.base.name, field, proposal }];
    }),
  );
}

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export function reviewHtml(cards: readonly ReviewCard[], generatedAt: string): string {
  const cardHtml = cards
    .map((card, index) => {
      const line = (decision: Decision["decision"]) => escape(JSON.stringify({ hash: card.hash, field: card.field, value: card.proposal.value, decision }));
      return `<article class="card" id="c${String(index)}">
  <h2>${escape(card.name)}</h2>
  <p class="proposal"><span class="field">${escape(card.field)}</span> → <strong>${escape(card.proposal.value)}</strong> <span class="band">${escape(card.proposal.band)} · ${escape(card.proposal.step)} · ${escape(card.proposal.rule)}</span></p>
  <ul>${card.proposal.evidence.map((evidence) => `<li>${escape(evidence)}</li>`).join("")}</ul>
  <div class="actions">
    <button data-line="${line("accept")}">Accept</button>
    <button data-line="${line("reject")}">Reject</button>
    <button data-line="${line("unsure")}">Unsure</button>
  </div>
</article>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enrichment review</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #1a1a1a; --card: #fff; --line: #ddd; --muted: #666; --picked: #2a7; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151515; --fg: #eee; --card: #1f1f1f; --line: #333; --muted: #aaa; } }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.4 system-ui, sans-serif; }
  main { max-width: 960px; margin: 0 auto; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
  .card.decided { opacity: 0.55; }
  h2 { font-size: 15px; margin: 0 0 6px; overflow-wrap: anywhere; }
  .field, .band { color: var(--muted); font-size: 13px; }
  ul { margin: 6px 0; padding-left: 20px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  button { font: inherit; padding: 6px 14px; margin-right: 6px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
  button.picked { border-color: var(--picked); outline: 2px solid var(--picked); }
  #out { position: sticky; bottom: 0; background: var(--card); border-top: 1px solid var(--line); padding: 8px 0; }
  textarea { width: 100%; height: 96px; box-sizing: border-box; font: 12px monospace; }
</style>
</head>
<body>
<main>
<h1>Enrichment review</h1>
<p>${String(cards.length)} proposals to check, generated ${escape(generatedAt)}. Pick one answer per card, then save the lines below and append them to the decision log (decisions.jsonl in the data folder). Rejected values are never proposed again.</p>
${cardHtml}
<section id="out">
  <textarea id="lines" readonly placeholder="Your decisions appear here, one JSON line each."></textarea>
  <button id="save">Save decisions.jsonl</button>
</section>
</main>
<script>
  const picked = new Map();
  const lines = document.getElementById("lines");
  const render = () => { lines.value = [...picked.values()].map((line) => line.replace(/}$/, ',"at":"' + new Date().toISOString() + '"}')).join("\\n"); };
  document.querySelectorAll(".card button").forEach((button) => button.addEventListener("click", () => {
    const card = button.closest(".card");
    card.querySelectorAll("button").forEach((other) => other.classList.toggle("picked", other === button));
    card.classList.add("decided");
    picked.set(card.id, button.dataset.line);
    render();
  }));
  document.getElementById("save").addEventListener("click", () => {
    const blob = new Blob([lines.value + "\\n"], { type: "application/x-ndjson" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "decisions.jsonl";
    link.click();
  });
</script>
</body>
</html>
`;
}
