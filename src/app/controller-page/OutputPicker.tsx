// The sound output choice (src/audio/output.ts): split cue on one device, through the FLX4, two
// devices, or this computer's speakers with the FLX4's headphones; the last two with a headphone
// line-up test. Saved per browser the moment the Learner picks; a Lesson
// opened afterwards uses it. Nothing here plays through a device the Learner did not pick.

import { useCallback, useEffect, useState } from "react";
import { HEADPHONE_OFFSET_LIMIT_MS, isControllerAudio, startAlignmentClicks, supportsOutputSelection, type AlignmentClicks, type LinedUpPlan, type OutputChoice, type OutputDevice } from "@audio";
import { askToListOutputs, listOutputs, saveOutputChoice, useOutputChoice, type OutputList } from "../audio-output.ts";

type Listing = { kind: "loading" } | { kind: "ready"; list: OutputList } | { kind: "failed"; message: string };

/** The device's channel count, read from a silent context sent to it (nothing plays). */
async function channelsOf(deviceId: string): Promise<number> {
  const context = new AudioContext({ sinkId: deviceId } as AudioContextOptions);
  try {
    return context.destination.maxChannelCount;
  } finally {
    await context.close();
  }
}

export function OutputPicker() {
  const choice = useOutputChoice();
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const canSelect = supportsOutputSelection();

  const refresh = useCallback((list: () => Promise<OutputList>) => {
    list().then(
      (result) => {
        setListing({ kind: "ready", list: result });
      },
      (error: unknown) => {
        setListing({ kind: "failed", message: error instanceof Error && error.name === "NotAllowedError" ? "The microphone was not allowed, so the browser keeps the outputs' names hidden." : String(error) });
      },
    );
  }, []);

  useEffect(() => {
    refresh(listOutputs);
    if (!("mediaDevices" in navigator)) return;
    const onChange = () => {
      refresh(listOutputs);
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", onChange);
    };
  }, [refresh]);

  const devices = listing.kind === "ready" ? listing.list.devices : [];
  const controller = devices.find((device) => isControllerAudio(device.label)) ?? null;
  const computerDevices = devices.filter((device) => !isControllerAudio(device.label));
  const canPhones = controller !== null && computerDevices.length > 0 && canSelect;

  return (
    <div className="output-picker">
      {canSelect ? null : <p className="hw-hint">This browser cannot choose a sound output, so the sound plays on this computer. Chrome, Edge and Arc can.</p>}
      {listing.kind === "ready" && listing.list.needsPermission && canSelect ? (
        <p className="hw-hint">
          The browser shows your outputs’ names only after you allow the microphone. Nothing is recorded: the app stops it at once.{" "}
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              refresh(askToListOutputs);
            }}
          >
            Show my outputs
          </button>
        </p>
      ) : null}
      {listing.kind === "failed" ? <p className="hw-hint">{listing.message}</p> : null}

      <fieldset>
        <legend className="visually-hidden">Sound output</legend>
        <label className="output-option">
          <input
            type="radio"
            name="output"
            checked={choice.kind === "split-cue"}
            onChange={() => {
              saveOutputChoice({ kind: "split-cue" });
            }}
          />
          <span>
            <b>One device, split cue</b>
            <small>Left ear: cue · Right ear: master. Headphones in this computer.</small>
          </span>
        </label>

        <label className="output-option" data-disabled={controller === null || !canSelect}>
          <input
            type="radio"
            name="output"
            disabled={controller === null || !canSelect}
            checked={choice.kind === "controller"}
            onChange={() => {
              if (controller !== null) saveOutputChoice({ kind: "controller", deviceId: controller.deviceId, label: controller.label });
            }}
          />
          <span>
            <b>Through the FLX4</b>
            <small>{controller === null ? "Plug in the FLX4 to use its sound card." : "Master to its MASTER OUT (speakers) · cue to its headphone jack."}</small>
            {choice.kind === "controller" ? <ChannelCheck deviceId={choice.deviceId} /> : null}
          </span>
        </label>

        <label className="output-option" data-disabled={!canPhones}>
          <input
            type="radio"
            name="output"
            disabled={!canPhones}
            checked={choice.kind === "computer-and-controller-phones"}
            onChange={() => {
              const [master] = computerDevices;
              if (controller !== null && master !== undefined) {
                saveOutputChoice({ kind: "computer-and-controller-phones", masterDeviceId: master.deviceId, masterLabel: master.label, controllerDeviceId: controller.deviceId, controllerLabel: controller.label, headphoneOffsetMs: 0 });
              }
            }}
          />
          <span>
            <b>Speakers: this computer · Headphones: FLX4</b>
            <small>{controller === null ? "Plug in the FLX4 to use its headphone jack." : "Master to this computer's speakers · cue to the FLX4's headphone jack."}</small>
            {choice.kind === "computer-and-controller-phones" ? <ChannelCheck deviceId={choice.controllerDeviceId} /> : null}
          </span>
        </label>

        <label className="output-option" data-disabled={devices.length < 2 || !canSelect}>
          <input
            type="radio"
            name="output"
            disabled={devices.length < 2 || !canSelect}
            checked={choice.kind === "two-devices"}
            onChange={() => {
              const [master, headphones] = devices;
              if (master !== undefined && headphones !== undefined) {
                saveOutputChoice({ kind: "two-devices", masterDeviceId: master.deviceId, masterLabel: master.label, headphoneDeviceId: headphones.deviceId, headphoneLabel: headphones.label, headphoneOffsetMs: 0 });
              }
            }}
          />
          <span>
            <b>Two devices</b>
            <small>{devices.length < 2 ? "Needs two outputs, such as speakers and headphones." : "Master to one (speakers), cue to the other (headphones)."}</small>
          </span>
        </label>
      </fieldset>
      {choice.kind === "two-devices" ? <TwoDevices choice={choice} devices={devices} /> : null}
      {choice.kind === "computer-and-controller-phones" ? <ComputerAndPhones choice={choice} devices={computerDevices} /> : null}
      <p className="hw-hint">A Lesson opened after this uses it.</p>
    </div>
  );
}

function ChannelCheck({ deviceId }: { readonly deviceId: string }) {
  const [channels, setChannels] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    channelsOf(deviceId).then(
      (count) => {
        if (live) setChannels(count);
      },
      (error: unknown) => {
        console.warn("[output] could not read the FLX4's channels", error);
      },
    );
    return () => {
      live = false;
    };
  }, [deviceId]);
  if (channels === null) return null;
  return <small className={channels >= 4 ? "hw-ok" : "hw-warn"}>{channels >= 4 ? `${String(channels)} outputs found.` : `Only ${String(channels)} outputs: Lessons will use split cue here instead.`}</small>;
}

function DeviceSelect({ label, value, devices, onPick }: { readonly label: string; readonly value: string; readonly devices: readonly OutputDevice[]; readonly onPick: (device: OutputDevice) => void }) {
  return (
    <label className="output-device">
      {label}
      <select
        value={value}
        onChange={(event) => {
          const device = devices.find((candidate) => candidate.deviceId === event.target.value);
          if (device !== undefined) onPick(device);
        }}
      >
        {devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TwoDevices({ choice, devices }: { readonly choice: Extract<OutputChoice, { kind: "two-devices" }>; readonly devices: readonly OutputDevice[] }) {
  const pick = (next: Extract<OutputChoice, { kind: "two-devices" }>) => {
    if (next.masterDeviceId !== next.headphoneDeviceId) saveOutputChoice(next);
  };
  const plan: LinedUpPlan = { kind: "two-devices", sinkId: choice.masterDeviceId, masterLabel: choice.masterLabel, headphoneSinkId: choice.headphoneDeviceId, headphoneLabel: choice.headphoneLabel, headphoneOffsetMs: choice.headphoneOffsetMs };
  return (
    <div className="output-two">
      <DeviceSelect
        label="Master (speakers)"
        value={choice.masterDeviceId}
        devices={devices}
        onPick={(device) => {
          pick({ ...choice, masterDeviceId: device.deviceId, masterLabel: device.label });
        }}
      />
      <DeviceSelect
        label="Cue (headphones)"
        value={choice.headphoneDeviceId}
        devices={devices}
        onPick={(device) => {
          pick({ ...choice, headphoneDeviceId: device.deviceId, headphoneLabel: device.label });
        }}
      />
      <LineUp
        key={`${choice.masterDeviceId}|${choice.headphoneDeviceId}`}
        plan={plan}
        onOffset={(headphoneOffsetMs) => {
          saveOutputChoice({ ...choice, headphoneOffsetMs });
        }}
        hint="Line them up: play the clicks, wear one headphone, and slide until speakers and headphones click as one. Right if the headphones click late."
      />
    </div>
  );
}

/** Speakers on this computer, the cue in the FLX4's headphones: pick the speakers, line the two up. */
function ComputerAndPhones({ choice, devices }: { readonly choice: Extract<OutputChoice, { kind: "computer-and-controller-phones" }>; readonly devices: readonly OutputDevice[] }) {
  const plan: LinedUpPlan = {
    kind: "computer-and-controller-phones",
    sinkId: choice.masterDeviceId,
    masterLabel: choice.masterLabel,
    controllerSinkId: choice.controllerDeviceId,
    controllerLabel: choice.controllerLabel,
    headphoneOffsetMs: choice.headphoneOffsetMs,
  };
  return (
    <div className="output-two">
      <DeviceSelect
        label="Master (speakers)"
        value={choice.masterDeviceId}
        devices={devices}
        onPick={(device) => {
          saveOutputChoice({ ...choice, masterDeviceId: device.deviceId, masterLabel: device.label });
        }}
      />
      {/* The FLX4 carries silence on its MASTER OUT in this mode; if the unit itself mixes HEADPHONES MIX
          (unverified, docs/research/flx4-midi.md), its MASTER side would fade the cue out. */}
      <p className="hw-hint" data-testid="phones-mix-hint">
        Turn the FLX4’s HEADPHONES MIX to CUE: its MASTER side is silent in this mode.
      </p>
      <LineUp
        key={`${choice.masterDeviceId}|${choice.controllerDeviceId}`}
        plan={plan}
        onOffset={(headphoneOffsetMs) => {
          saveOutputChoice({ ...choice, headphoneOffsetMs });
        }}
        hint="Line them up: play the clicks, wear one side of the FLX4’s headphones, and slide until speakers and headphones click as one. Right if the headphones click late."
      />
    </div>
  );
}

/**
 * The headphone offset slider and the click test, for a plan with a second headphone device. Keyed by
 * the devices where it is used, so picking another device stops the old clicks (the unmount does).
 */
function LineUp({ plan, onOffset, hint }: { readonly plan: LinedUpPlan; readonly onOffset: (ms: number) => void; readonly hint: string }) {
  const [clicks, setClicks] = useState<AlignmentClicks | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(
    () => () => {
      void clicks?.stop();
    },
    [clicks],
  );
  return (
    <>
      <label className="output-device">
        Headphone offset: {plan.headphoneOffsetMs > 0 ? "+" : ""}
        {plan.headphoneOffsetMs} ms
        <input
          type="range"
          min={-HEADPHONE_OFFSET_LIMIT_MS}
          max={HEADPHONE_OFFSET_LIMIT_MS}
          step={5}
          value={plan.headphoneOffsetMs}
          onChange={(event) => {
            const headphoneOffsetMs = Number(event.target.value);
            clicks?.setOffset(headphoneOffsetMs);
            onOffset(headphoneOffsetMs);
          }}
        />
      </label>
      <p className="hw-hint">{hint}</p>
      <button
        type="button"
        className="btn"
        onClick={() => {
          if (clicks !== null) {
            void clicks.stop();
            setClicks(null);
            return;
          }
          setFailure(null);
          void startAlignmentClicks(plan).then(setClicks, (error: unknown) => {
            console.warn("[output] the click test could not start", error);
            setFailure(error instanceof Error ? error.message : String(error));
          });
        }}
      >
        {clicks === null ? "Play test clicks" : "Stop the clicks"}
      </button>
      {failure === null ? null : <p className="hw-warn">The clicks could not start: {failure}</p>}
    </>
  );
}
