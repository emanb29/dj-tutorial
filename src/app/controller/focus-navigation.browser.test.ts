import { afterEach, describe, expect, it } from "vitest";
import { ADJUST_NOTICE, FILE_NOTICE, FLX4_LOAD_EVENT, FocusNavigator, focusables, pressedByController, TYPING_NOTICE, type Flx4LoadDetail } from "./focus-navigation.ts";

function page(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

const focusedText = () => (document.activeElement as HTMLElement | null)?.textContent ?? "";

afterEach(() => {
  document.body.replaceChildren();
});

describe("BROWSE turn", () => {
  it("moves the ring through the page's buttons in order, round the end, and back", () => {
    page(`<button>One</button><a href="/x">Two</a><button disabled>Off</button><button>Three</button>`);
    const navigator = new FocusNavigator();
    navigator.move(1);
    expect(focusedText()).toBe("One");
    navigator.move(1);
    expect(focusedText()).toBe("Two");
    navigator.move(1);
    expect(focusedText()).toBe("Three");
    navigator.move(1);
    expect(focusedText()).toBe("One");
    navigator.move(-1);
    expect(focusedText()).toBe("Three");
  });

  it("passes over the on-screen controller, hidden things and what is behind a modal", () => {
    page(`<button>Page</button><div data-nav-skip><button>PLAY</button></div><button hidden>Gone</button><div aria-hidden="true"><button>Behind</button></div>`);
    expect(focusables().map((element) => element.textContent)).toEqual(["Page"]);
    page(`<div aria-modal="true" role="dialog"><button>In the dialog</button></div>`);
    expect(focusables().map((element) => element.textContent)).toEqual(["In the dialog"]);
  });

  it("starts in the newest overlay when nothing has the ring", () => {
    page(`<button>Back</button><section data-nav-start><button>Answer 1</button><button>Answer 2</button></section>`);
    new FocusNavigator().move(1);
    expect(focusedText()).toBe("Answer 1");
  });
});

describe("BROWSE press", () => {
  it("presses the button with the ring; with none, only puts the ring on the first", () => {
    const root = page(`<button>One</button>`);
    const clicks: string[] = [];
    root.querySelector("button")?.addEventListener("click", () => clicks.push("One"));
    const navigator = new FocusNavigator();
    expect(navigator.select()).toBeNull();
    expect(clicks).toEqual([]);
    expect(focusedText()).toBe("One");
    navigator.select();
    expect(clicks).toEqual(["One"]);
  });

  it("says a text box or a file needs other hands, and does not press it", () => {
    page(`<input type="text" aria-label="Name"><label data-nav-typing="Optional: LOAD A goes on."><input type="search"></label><input type="file">`);
    const navigator = new FocusNavigator();
    navigator.move(1);
    expect(navigator.select()).toEqual({ text: TYPING_NOTICE });
    navigator.move(1);
    expect(navigator.select()).toEqual({ text: "Optional: LOAD A goes on." });
    navigator.move(1);
    expect(navigator.select()).toEqual({ text: FILE_NOTICE });
  });

  it("on a list or a slider, BROWSE turns its value until the next press", () => {
    const root = page(`<select><option value="a">A</option><option value="b">B</option><option value="c">C</option></select><input type="range" min="0" max="10" step="5" value="0"><button>After</button>`);
    const select = root.querySelector("select");
    const range = root.querySelector<HTMLInputElement>("input[type=range]");
    const changes: string[] = [];
    select?.addEventListener("change", () => changes.push(select.value));
    const navigator = new FocusNavigator();
    navigator.move(1);
    expect(navigator.select()).toEqual({ text: ADJUST_NOTICE });
    expect(navigator.changingValue).toBe(true);
    navigator.move(1);
    navigator.move(5);
    expect(changes).toEqual(["b", "c"]);
    navigator.select();
    expect(navigator.changingValue).toBe(false);
    navigator.move(1);
    expect(document.activeElement).toBe(range);
    navigator.select();
    navigator.move(1);
    expect(range?.value).toBe("5");
    navigator.key("Escape");
    navigator.move(1);
    expect(focusedText()).toBe("After");
  });
});

describe("keys from LOAD and SHIFT + BROWSE", () => {
  it("go where the keyboard's would, marked as the controller's", () => {
    page(`<button>Focused</button>`);
    const seen: { code: string; target: string; controller: boolean }[] = [];
    const listener = (event: KeyboardEvent) => {
      seen.push({ code: event.code, target: (event.target as HTMLElement).tagName, controller: pressedByController(event) });
      event.preventDefault();
    };
    window.addEventListener("keydown", listener);
    const navigator = new FocusNavigator();
    navigator.key("KeyR");
    navigator.move(1);
    navigator.key("Enter");
    window.removeEventListener("keydown", listener);
    expect(seen).toEqual([
      { code: "KeyR", target: "BODY", controller: true },
      { code: "Enter", target: "BUTTON", controller: true },
    ]);
  });

  it("a plain LOAD goes to a page with a library first; a page that leaves it gets the key", () => {
    const loads: string[] = [];
    const keys: string[] = [];
    const onKey = (event: KeyboardEvent) => {
      keys.push(event.code);
      event.preventDefault();
    };
    const onLoad = (event: Event) => {
      loads.push((event as CustomEvent<Flx4LoadDetail>).detail.deck);
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    const navigator = new FocusNavigator();
    navigator.load("B", "KeyR");
    window.addEventListener(FLX4_LOAD_EVENT, onLoad);
    navigator.load("A", "Enter");
    window.removeEventListener(FLX4_LOAD_EVENT, onLoad);
    window.removeEventListener("keydown", onKey);
    expect(keys).toEqual(["KeyR"]);
    expect(loads).toEqual(["A"]);
  });

  it("an Enter no page handles presses the control with the ring, or the page's default", () => {
    const root = page(`<button>Other</button><button data-nav-default>Start Lesson 2</button>`);
    const clicks: string[] = [];
    for (const button of root.querySelectorAll("button")) button.addEventListener("click", () => clicks.push(button.textContent));
    const navigator = new FocusNavigator();
    navigator.key("Enter");
    expect(clicks).toEqual(["Start Lesson 2"]);
    navigator.move(1);
    navigator.key("Enter");
    expect(clicks).toEqual(["Start Lesson 2", "Other"]);
  });

  it("Enter in a text box submits its form", () => {
    const root = page(`<form><input type="text"><button type="submit">Go</button></form>`);
    let submitted = 0;
    root.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submitted += 1;
    });
    root.querySelector("input")?.focus();
    new FocusNavigator().key("Enter");
    expect(submitted).toBe(1);
  });

  it("an Esc no page handles presses the page's back button; a handled one does not", () => {
    const root = page(`<button data-nav-back>← Lessons</button>`);
    let backs = 0;
    root.querySelector("button")?.addEventListener("click", () => (backs += 1));
    const navigator = new FocusNavigator();
    navigator.key("Escape");
    expect(backs).toBe(1);
    const handled = (event: KeyboardEvent) => {
      event.preventDefault();
    };
    window.addEventListener("keydown", handled);
    navigator.key("Escape");
    window.removeEventListener("keydown", handled);
    expect(backs).toBe(1);
  });
});
