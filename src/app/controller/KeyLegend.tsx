// The key legend: a compact strip under the controller listing the keyboard bindings, grouped by deck.
// Bindings for locked controls are dimmed, matching the controls themselves.

import type { DeckId } from "@audio";
import { useController } from "./context.tsx";
import { KEY_BINDINGS, type KeyBinding } from "./keymap.ts";

function deckOfBinding(binding: KeyBinding): DeckId | null {
  return "deck" in binding.action ? binding.action.deck : null;
}

function hotCueRange(bindings: readonly KeyBinding[]): string {
  const labels = bindings.filter((binding) => binding.action.kind === "hot-cue").map((binding) => binding.label);
  return labels.length === 0 ? "" : `${labels[0] ?? ""}–${labels.at(-1) ?? ""}`;
}

function Group({ title, bindings, note }: { readonly title: string; readonly bindings: readonly KeyBinding[]; readonly note?: string }) {
  const { unlocks } = useController();
  const single = bindings.filter((binding) => binding.action.kind !== "hot-cue");
  const hotCues = bindings.filter((binding) => binding.action.kind === "hot-cue");
  const hotCueControl = hotCues[0]?.control ?? null;
  const locked = (binding: { control: KeyBinding["control"] }) => binding.control !== null && !unlocks.has(binding.control);
  return (
    <div className="legend-group">
      <span className="legend-title">{title}</span>
      <ul>
        {single.map((binding) => (
          <li key={binding.code} className={locked(binding) ? "locked" : undefined}>
            <kbd>{binding.label}</kbd> {binding.description}
          </li>
        ))}
        {hotCues.length === 0 ? null : (
          <li className={locked({ control: hotCueControl }) ? "locked" : undefined}>
            <kbd>{hotCueRange(hotCues)}</kbd> Hot cues 1–4 <small>(Shift erases)</small>
          </li>
        )}
        {note === undefined ? null : <li className="legend-note">{note}</li>}
      </ul>
    </div>
  );
}

export function KeyLegend() {
  return (
    <aside className="key-legend" aria-label="Keyboard keys">
      <Group title="Deck A" bindings={KEY_BINDINGS.filter((binding) => deckOfBinding(binding) === "A")} />
      <Group
        title="Both"
        bindings={KEY_BINDINGS.filter((binding) => deckOfBinding(binding) === null)}
        note="Focused knob or fader: arrows nudge, Shift is fine, double-click resets."
      />
      <Group title="Deck B" bindings={KEY_BINDINGS.filter((binding) => deckOfBinding(binding) === "B")} />
    </aside>
  );
}
