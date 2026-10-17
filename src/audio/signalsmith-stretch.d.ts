// Types for signalsmith-stretch 1.3.2, which ships without them. Written from its README:
// https://www.npmjs.com/package/signalsmith-stretch/v/1.3.2
declare module "signalsmith-stretch" {
  export interface StretchSchedule {
    /** Context time this change applies at. */
    output?: number;
    active?: boolean;
    /** Position in the input buffers, seconds. */
    input?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    loopStart?: number;
    loopEnd?: number;
  }

  export interface StretchNode extends AudioWorkletNode {
    inputTime: number;
    schedule(change: StretchSchedule): Promise<unknown>;
    start(when?: number): Promise<unknown>;
    stop(when?: number): Promise<unknown>;
    /** One typed array per channel, all the same length. Resolves to the new buffer end, in seconds. */
    addBuffers(channels: readonly Float32Array[], transfer?: readonly Transferable[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<unknown>;
    latency(): Promise<number>;
    configure(options: { blockMs?: number | null; intervalMs?: number; splitComputation?: boolean; preset?: "default" | "cheaper" }): Promise<unknown>;
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<unknown>;
  }

  export default function SignalsmithStretch(
    context: BaseAudioContext,
    channelOptions?: AudioWorkletNodeOptions,
  ): Promise<StretchNode>;
}
