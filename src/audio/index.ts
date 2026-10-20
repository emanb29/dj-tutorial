// The audio engine: owns the only AudioContext, the decks and the mixer (ADR 0001).
// Nothing audio-rate goes through React state: the UI sends commands and reads events and playheads.
// Attempts are recorded in the canonical shape of shared/attempt.ts, which the Checks read.

export { createAudioEngine, AudioEngine, TRACK_HISTORY_LIMIT } from "./engine.ts";
export type {
  AudioEngineOptions,
  ChannelSnapshot,
  CommandEvent,
  CuePointEvent,
  EngineDeckSnapshot,
  EngineEvents,
  EngineMixerSnapshot,
  PlayheadReading,
} from "./engine.ts";

export { CONTINUOUS_CONTROLS, CONTROL_RANGES, JOG_BEND_LIMIT } from "./commands.ts";
export type { ChannelControl, CommandInput, Control, EngineCommand, EqControl } from "./commands.ts";

export { AttemptRecorder, DEFAULT_RECORDER_CAPACITY, NEAR_CAPACITY_FRACTION } from "./recorder.ts";
export type {
  AttemptDetails,
  RecordedAttempt,
  RecordedControlEvent,
  RecorderCapacity,
  RecorderEvents,
  RecorderNearCapacity,
  RecorderOptions,
  RecorderStartOptions,
  RecorderUsage,
} from "./recorder.ts";

export { containerOf, fileExtensionOf, MasterRecording, pickRecordingFormat, RECORDING_FORMATS } from "./master-recording.ts";
export type { FinishedRecording } from "./master-recording.ts";

export { MasterOnlyMonitor, SplitCueMonitor } from "./monitor.ts";
export { controllerMasterAndPhonesSink, controllerPhonesSink, ControllerCueMonitor, deviceHeadphoneSink, routeToControllerOutputs, routeToControllerPhones, TwoDeviceMonitor } from "./device-monitors.ts";
export type { SecondDeviceSink } from "./device-monitors.ts";
export {
  CONTEXT_HOP_SEC,
  controllerPhonesFallback,
  DEFAULT_OUTPUT,
  HEADPHONE_OFFSET_LIMIT_MS,
  isControllerAudio,
  lineUpDelays,
  outputDevicesFrom,
  outputLine,
  parseOutputChoice,
  planOutput,
  supportsOutputSelection,
} from "./output.ts";
export type { ControllerSecondPlan, LinedUpPlan, OutputChoice, OutputDevice, OutputPlan } from "./output.ts";
export { createOutputRouting, startAlignmentClicks } from "./output-routing.ts";
export type { AlignmentClicks, OutputRouting } from "./output-routing.ts";
export { BEAT_FX_BEATS, ECHO_FEEDBACK } from "./beat-fx.ts";
export type { BeatFxChannel, BeatFxSnapshot } from "./beat-fx.ts";
export { HOT_CUE_SLOTS, MAX_LOOP_SEC, MIN_LOOP_SEC } from "./deck.ts";
export type { MonitorBuses, MonitorOutput } from "./monitor.ts";

export type { BusMeterFrame, MeterBus } from "./meter.ts";
export type { DeckSnapshot, MasterTempoAvailability, TrackInfo, TrackRecord } from "./deck.ts";
export type { EqBand, MixerState } from "./mixer.ts";
export { LOW_MID_CROSSOVER_HZ, MID_HIGH_CROSSOVER_HZ } from "./mixer.ts";

export { BEATS_PER_BAR, barBeatAt, beatAt, beatGridProblems, beatLengthSec, positionOfBeat } from "./beat-grid.ts";
export { PLAYHEAD_SEGMENT_LIMIT, PlayheadTracker } from "./playhead.ts";
export { phaseAlignedPosition, syncTempo } from "./sync.ts";
export { TEMPO_RANGES, tempoFaderForRate, tempoRate } from "./tempo.ts";
export type { TempoRangePercent } from "./tempo.ts";
export { boundedCorrectionMs, correctedInputTime, MAX_INPUT_CORRECTION_MS, measureTimingOffset, TIMING_CHECK_MIN_KEPT, TIMING_CHECK_TAPS } from "./input-latency.ts";
export type { TimingMeasurement } from "./input-latency.ts";
export { audioContextClock, heardContextTime, renderTimeClock } from "./output-clock.ts";
export type { OutputClock, OutputTimestamp } from "./output-clock.ts";

export {
  FILTER_DEAD_ZONE,
  channelFaderGain,
  crossfaderGain,
  decibelsToGain,
  eqKnobToDecibels,
  filterKnobSettings,
  gainToDecibels,
  headphoneLevelToDecibels,
  masterKnobToDecibels,
  toTimelineDecibels,
  trimKnobToDecibels,
} from "./curves.ts";
export type { CentredKnob, FaderPosition, FilterSettings } from "./curves.ts";

export { LoudnessMeter, METER_FRAMES_PER_SECOND } from "./loudness.ts";
export type { LoudnessFrame } from "./loudness.ts";

export { describeError } from "./result.ts";
export type { AudioEngineError, Result } from "./result.ts";
export { DECK_IDS, INPUT_DEVICES, otherDeck } from "./types.ts";
export type { CtxTime, DeckId, InputDevice } from "./types.ts";

// The attempt contract the recorder produces, re-exported for the app's convenience.
export type { Attempt, BeatGrid, ControlEvent, ControlId, MeterFrame, PlayheadSegment } from "@shared/attempt.ts";
