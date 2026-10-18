// Web MIDI access and DDJ-FLX4 detection: the one place the app talks to navigator.requestMIDIAccess.
// The controller is found by port name (docs/research/flx4-midi.md: the -N Gold Edition is the same
// hardware), and followed as it is plugged in and out. Asking for access shows Chrome's permission
// prompt, so it happens only on the Learner's click; once granted, later visits connect by themselves.

/** A port name the app treats as a DDJ-FLX4 (including the DDJ-FLX4-N). */
export function isControllerPort(name: string | null | undefined): boolean {
  return name != null && /DDJ-FLX4/i.test(name);
}

export type MidiStatus =
  /** No Web MIDI in this browser (Safari, Firefox without the add-on) or not a secure context. */
  | { readonly kind: "unsupported" }
  | { readonly kind: "not-asked" }
  | { readonly kind: "asking" }
  | { readonly kind: "denied"; readonly message: string }
  /** Access granted, but no DDJ-FLX4 among the ports. */
  | { readonly kind: "no-controller"; readonly ports: readonly string[] }
  | { readonly kind: "connected"; readonly inputName: string; readonly outputName: string | null; readonly ports: readonly string[] };

export interface MidiMessage {
  readonly data: Uint8Array;
  /** performance.now() milliseconds when the message arrived (MIDIMessageEvent.timeStamp). */
  readonly timeStamp: number;
}

/** The parts of the Web MIDI API used here, so tests can pass a fake. */
export interface MidiAccessLike extends EventTarget {
  readonly inputs: ReadonlyMap<string, MidiInputLike>;
  readonly outputs: ReadonlyMap<string, MidiOutputLike>;
}
export interface MidiInputLike extends EventTarget {
  readonly id: string;
  readonly name: string | null;
}
export interface MidiOutputLike {
  readonly id: string;
  readonly name: string | null;
  send(data: number[]): void;
}

export interface MidiConnectionOptions {
  /** navigator.requestMIDIAccess, or null where there is none. */
  readonly requestAccess: (() => Promise<MidiAccessLike>) | null;
  /** The "midi" permission's state, or null when the browser cannot say. */
  readonly permission: () => Promise<PermissionState | null>;
}

type Listener = () => void;

export class MidiConnection {
  private current: MidiStatus;
  private access: MidiAccessLike | null = null;
  private input: MidiInputLike | null = null;
  private output: MidiOutputLike | null = null;
  private readonly statusListeners = new Set<Listener>();
  private readonly messageListeners = new Set<(message: MidiMessage) => void>();
  private readonly onMidiMessage = (event: Event) => {
    const { data, timeStamp } = event as MIDIMessageEvent;
    if (data === null) return;
    for (const listener of this.messageListeners) listener({ data, timeStamp });
  };
  private readonly onStateChange = () => {
    this.attachPorts();
  };

  constructor(private readonly options: MidiConnectionOptions) {
    this.current = options.requestAccess === null ? { kind: "unsupported" } : { kind: "not-asked" };
  }

  status = (): MidiStatus => this.current;

  subscribe = (listener: Listener): (() => void) => {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  };

  /** Every MIDI message from the controller, as it arrives. */
  onMessage(listener: (message: MidiMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /** Sends to the controller; false when there is none to send to. */
  send(messages: readonly (readonly number[])[]): boolean {
    const output = this.output;
    if (output === null) return false;
    try {
      for (const message of messages) output.send([...message]);
      return true;
    } catch (error) {
      // A port can vanish between the statechange and this send; the next statechange tidies up.
      console.warn("[midi] sending to the controller failed", error);
      return false;
    }
  }

  get connected(): boolean {
    return this.current.kind === "connected";
  }

  /** Asks for MIDI access (Chrome's prompt). Call it from a click. */
  async connect(): Promise<void> {
    const request = this.options.requestAccess;
    if (request === null || this.access !== null) return;
    this.set({ kind: "asking" });
    try {
      this.access = await request();
    } catch (error) {
      const message = error instanceof Error && error.name === "NotAllowedError" ? "MIDI access was blocked. Allow it from the address bar's site settings, then try again." : `MIDI access failed: ${String(error)}`;
      this.set({ kind: "denied", message });
      return;
    }
    this.access.addEventListener("statechange", this.onStateChange);
    this.attachPorts();
  }

  /** Connects without a prompt when access was granted before; otherwise stays as it is. */
  async connectIfAllowed(): Promise<void> {
    if (this.options.requestAccess === null || this.access !== null) return;
    if ((await this.options.permission()) === "granted") await this.connect();
  }

  private attachPorts(): void {
    const access = this.access;
    if (access === null) return;
    const ports = [...access.inputs.values()].map((port) => port.name ?? port.id);
    const input = [...access.inputs.values()].find((port) => isControllerPort(port.name)) ?? null;
    const output = [...access.outputs.values()].find((port) => isControllerPort(port.name)) ?? null;
    if (input !== this.input) {
      this.input?.removeEventListener("midimessage", this.onMidiMessage);
      input?.addEventListener("midimessage", this.onMidiMessage);
      this.input = input;
    }
    this.output = output;
    this.set(input === null ? { kind: "no-controller", ports } : { kind: "connected", inputName: input.name ?? input.id, outputName: output?.name ?? null, ports });
  }

  private set(status: MidiStatus): void {
    this.current = status;
    for (const listener of this.statusListeners) listener();
  }
}

let shared: MidiConnection | null = null;

/** The app's one MIDI connection. */
export function midiConnection(): MidiConnection {
  shared ??= new MidiConnection(browserOptions());
  return shared;
}

function browserOptions(): MidiConnectionOptions {
  const supported = typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function" && window.isSecureContext;
  return {
    requestAccess: supported ? () => navigator.requestMIDIAccess() : null,
    permission: async () => {
      try {
        return (await navigator.permissions.query({ name: "midi" })).state;
      } catch {
        // Some browsers cannot query "midi"; then only the button connects.
        return null;
      }
    },
  };
}
