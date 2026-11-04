// Moving around a page with the FLX4 (flx4-keys.ts has the table): a ring on one button at a time,
// BROWSE to move it and press, LOAD and SHIFT + BROWSE as the keys pages already listen for. The ring
// is the browser's own focus, so the keyboard and screen readers see the same thing.
//
// What a page marks:
// - data-nav-skip: a region the ring passes over (the on-screen controller: the FLX4 is that controller).
// - data-nav-start: an overlay where the ring starts when nothing has it (the questions, a result card).
// - data-nav-default: the button LOAD A presses when nothing has the ring (the next Lesson's Start).
// - data-nav-back: the button SHIFT + BROWSE presses when the page has no Esc of its own.
// - data-nav-typing: what to say instead of the default when the ring is on a text box.

/** Something the FLX4 cannot do here, said on screen with the nearest way it can. */
export interface NavigationNotice {
  readonly text: string;
}

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
const NOT_REACHABLE = '[data-nav-skip], [inert], [aria-hidden="true"]';
const TYPED_INPUTS: ReadonlySet<string> = new Set(["text", "search", "email", "number", "password", "tel", "url"]);

export const TYPING_NOTICE = "Typing needs the keyboard or the screen. Turn BROWSE to go past it.";
export const FILE_NOTICE = "Picking a file needs the mouse, keyboard or screen. SHIFT + BROWSE goes back.";
export const ADJUST_NOTICE = "Turn BROWSE to change it, press to finish.";

/**
 * Dispatched on window for a plain LOAD A / LOAD B, before it becomes a key. A page with a library
 * (Freestyle) loads the track with the ring onto `detail.deck` and calls preventDefault().
 */
export const FLX4_LOAD_EVENT = "flx4-load";

export interface Flx4LoadDetail {
  readonly deck: "A" | "B";
}

/**
 * Dispatched on window for SHIFT + BROWSE turn, with the detents as `detail.step`. A library whose
 * preview plays jumps it (src/app/library-browser) and calls preventDefault(); otherwise the ring moves.
 */
export const FLX4_PREVIEW_JUMP_EVENT = "flx4-preview-jump";

export interface Flx4PreviewJumpDetail {
  readonly step: number;
}

/** Key presses the FLX4 made, so the decks' keyboard and the wording ignore them. */
const pressedHere = new WeakSet<Event>();

/** Whether a key event came from the FLX4's LOAD or BROWSE, not the keyboard. */
export function pressedByController(event: Event): boolean {
  return pressedHere.has(event);
}

function keyOf(code: string): string {
  if (code === "Escape" || code === "Enter") return code;
  return code.replace(/^Key/, "").toLowerCase();
}

function visible(element: HTMLElement): boolean {
  if (element.getClientRects().length === 0) return false;
  return getComputedStyle(element).visibility !== "hidden";
}

function reachable(element: HTMLElement): boolean {
  if (element.closest(NOT_REACHABLE) !== null) return false;
  if ((element as HTMLButtonElement).disabled) return false;
  return visible(element);
}

/** The open modal the ring stays inside, or the whole page. */
function scope(doc: Document): ParentNode {
  const modals = [...doc.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"]')].filter(visible);
  return modals.at(-1) ?? doc;
}

/** Every control the ring can be on, in page order. */
export function focusables(doc: Document = document): HTMLElement[] {
  return [...scope(doc).querySelectorAll<HTMLElement>(FOCUSABLE)].filter(reachable);
}

function current(doc: Document, list: readonly HTMLElement[]): HTMLElement | null {
  const active = doc.activeElement;
  return active instanceof HTMLElement && list.includes(active) ? active : null;
}

/** Where the ring starts when nothing has it: the newest overlay's first control, else the page's. */
function start(doc: Document, list: readonly HTMLElement[]): HTMLElement | null {
  const overlays = [...doc.querySelectorAll<HTMLElement>("[data-nav-start]")].filter(visible);
  for (const overlay of overlays.reverse()) {
    const first = list.find((element) => overlay.contains(element));
    if (first !== undefined) return first;
  }
  return list[0] ?? null;
}

function ring(element: HTMLElement): void {
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function isTyped(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  return element instanceof HTMLInputElement && TYPED_INPUTS.has(element.type);
}

function adjustable(element: Element): element is HTMLSelectElement | HTMLInputElement {
  return element instanceof HTMLSelectElement || (element instanceof HTMLInputElement && element.type === "range");
}

/** A controlled input's value set the way React sees it (its own setter, then the event it listens for). */
function setValue(element: HTMLSelectElement | HTMLInputElement, value: string): void {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  if (element instanceof HTMLInputElement) element.dispatchEvent(new Event("change", { bubbles: true }));
}

function step(element: HTMLSelectElement | HTMLInputElement, by: number): void {
  if (element instanceof HTMLSelectElement) {
    const enabled = [...element.options].filter((option) => !option.disabled);
    const at = enabled.findIndex((option) => option.selected);
    const next = enabled[Math.min(enabled.length - 1, Math.max(0, at + by))];
    if (next !== undefined && !next.selected) setValue(element, next.value);
    return;
  }
  const size = element.step === "any" || element.step === "" ? 1 : Number(element.step);
  const min = element.min === "" ? 0 : Number(element.min);
  const max = element.max === "" ? 100 : Number(element.max);
  const value = Math.min(max, Math.max(min, Number(element.value) + by * size));
  if (String(value) !== element.value) setValue(element, String(value));
}

/** The FLX4 as a way around the page: BROWSE turn and press, and keys from LOAD and SHIFT + BROWSE. */
export class FocusNavigator {
  /** A list or slider whose value BROWSE turns, after a press on it; null while BROWSE moves the ring. */
  private adjusting: HTMLSelectElement | HTMLInputElement | null = null;

  constructor(private readonly doc: Document = document) {}

  /** BROWSE turn: the ring `by` controls on, round the end; or the value being changed. */
  move(by: number): NavigationNotice | null {
    const adjusting = this.stillAdjusting();
    if (adjusting !== null) {
      step(adjusting, by);
      return null;
    }
    const list = focusables(this.doc);
    if (list.length === 0) return null;
    const at = current(this.doc, list);
    const next = at === null ? (by > 0 ? start(this.doc, list) : list.at(-1)) : list[(((list.indexOf(at) + by) % list.length) + list.length) % list.length];
    if (next != null) ring(next);
    return null;
  }

  /** SHIFT + BROWSE turn: first offered to a playing preview (FLX4_PREVIEW_JUMP_EVENT); else a move. */
  jump(by: number): NavigationNotice | null {
    const event = new CustomEvent<Flx4PreviewJumpDetail>(FLX4_PREVIEW_JUMP_EVENT, { detail: { step: by }, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented ? null : this.move(by);
  }

  /** BROWSE press: presses the control with the ring. With no ring, puts it where it starts. */
  select(): NavigationNotice | null {
    if (this.stillAdjusting() !== null) {
      this.adjusting = null;
      return null;
    }
    const list = focusables(this.doc);
    const at = current(this.doc, list);
    if (at === null) {
      const first = start(this.doc, list);
      if (first !== null) ring(first);
      return null;
    }
    return this.press(at);
  }

  /**
   * A plain LOAD: first offered to the page as FLX4_LOAD_EVENT (Freestyle loads the track with the ring
   * onto `deck` and prevents its default); a page that leaves it gets the key (LOAD A = Enter, LOAD B = R).
   */
  load(deck: "A" | "B", code: string): NavigationNotice | null {
    const event = new CustomEvent<Flx4LoadDetail>(FLX4_LOAD_EVENT, { detail: { deck }, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented ? null : this.key(code);
  }

  /**
   * A key from the FLX4 (LOAD A = Enter, LOAD B = R, SHIFT + BROWSE = Esc, …), sent where the keyboard's
   * would go. A page that handles the key prevents its default; otherwise Enter presses the control with
   * the ring (or the page's default) and Esc presses the page's back button.
   */
  key(code: string): NavigationNotice | null {
    if (code === "Escape" && this.stillAdjusting() !== null) {
      this.adjusting = null;
      return null;
    }
    const active = this.doc.activeElement;
    const target = active instanceof HTMLElement && active !== this.doc.body ? active : this.doc.body;
    const init = { code, key: keyOf(code), bubbles: true, cancelable: true };
    const down = new KeyboardEvent("keydown", init);
    const up = new KeyboardEvent("keyup", init);
    pressedHere.add(down);
    pressedHere.add(up);
    target.dispatchEvent(down);
    target.dispatchEvent(up);
    if (down.defaultPrevented) return null;
    const list = focusables(this.doc);
    if (code === "Enter") {
      const at = current(this.doc, list);
      if (at !== null && isTyped(at)) {
        at.closest("form")?.requestSubmit();
        return null;
      }
      const chosen = at ?? list.find((element) => element.matches("[data-nav-default]")) ?? null;
      return chosen === null ? null : this.press(chosen);
    }
    if (code === "Escape") list.find((element) => element.matches("[data-nav-back]"))?.click();
    return null;
  }

  private press(element: HTMLElement): NavigationNotice | null {
    if (element instanceof HTMLInputElement && element.type === "file") return { text: FILE_NOTICE };
    if (isTyped(element)) return { text: element.closest<HTMLElement>("[data-nav-typing]")?.dataset["navTyping"] ?? TYPING_NOTICE };
    if (adjustable(element)) {
      this.adjusting = element;
      return { text: ADJUST_NOTICE };
    }
    element.click();
    return null;
  }

  private stillAdjusting(): HTMLSelectElement | HTMLInputElement | null {
    const adjusting = this.adjusting;
    if (adjusting !== null && (this.doc.activeElement !== adjusting || !adjusting.isConnected)) this.adjusting = null;
    return this.adjusting;
  }

  /** Whether BROWSE turns a value now (the ring shows it). */
  get changingValue(): boolean {
    return this.stillAdjusting() !== null;
  }
}
