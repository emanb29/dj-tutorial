// The sound output choice (src/audio/output.ts): split cue on one device, through the FLX4, or two
// devices with a headphone line-up test. Saved per browser the moment the Learner picks; a Lesson
// opened afterwards uses it. Nothing here plays through a device the Learner did not pick.

import { useCallback, useEffect, useState } from "react";
import { HEADPHONE_OFFSET_LIMIT_MS, isControllerAudio, startAlignmentClicks, supportsOutputSelection, type AlignmentClicks, type OutputChoice, type OutputDevice } from "@audio";
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

function TwoDevices({ choice, devices }: { readonly choice: Extract<OutputChoice, { kind: "two-devices" }>; readonly devices: readonly OutputDevice[] }) {
  const [clicks, setClicks] = useState<AlignmentClicks | null>(null);
  useEffect(
    () => () => {
      void clicks?.stop();
    },
    [clicks],
  );
  const pick = (role: "master" | "headphone", deviceId: string) => {
    const device = devices.find((candidate) => candidate.deviceId === deviceId);
    if (device === undefined) return;
    const next = role === "master" ? { ...choice, masterDeviceId: device.deviceId, masterLabel: device.label } : { ...choice, headphoneDeviceId: device.deviceId, headphoneLabel: device.label };
    if (next.masterDeviceId === next.headphoneDeviceId) return;
    void clicks?.stop();
    setClicks(null);
    saveOutputChoice(next);
  };
  const select = (role: "master" | "headphone", value: string, label: string) => (
    <label className="output-device">
      {label}
      <select
        value={value}
        onChange={(event) => {
          pick(role, event.target.value);
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
  return (
    <div className="output-two">
      {select("master", choice.masterDeviceId, "Master (speakers)")}
      {select("headphone", choice.headphoneDeviceId, "Cue (headphones)")}
      <label className="output-device">
        Headphone offset: {choice.headphoneOffsetMs > 0 ? "+" : ""}
        {choice.headphoneOffsetMs} ms
        <input
          type="range"
          min={-HEADPHONE_OFFSET_LIMIT_MS}
          max={HEADPHONE_OFFSET_LIMIT_MS}
          step={5}
          value={choice.headphoneOffsetMs}
          onChange={(event) => {
            const headphoneOffsetMs = Number(event.target.value);
            clicks?.setOffset(headphoneOffsetMs);
            saveOutputChoice({ ...choice, headphoneOffsetMs });
          }}
        />
      </label>
      <p className="hw-hint">Line them up: play the clicks, wear one headphone, and slide until speakers and headphones click as one. Right if the headphones click late.</p>
      <button
        type="button"
        className="btn"
        onClick={() => {
          if (clicks !== null) {
            void clicks.stop();
            setClicks(null);
            return;
          }
          void startAlignmentClicks({ kind: "two-devices", sinkId: choice.masterDeviceId, masterLabel: choice.masterLabel, headphoneSinkId: choice.headphoneDeviceId, headphoneLabel: choice.headphoneLabel, headphoneOffsetMs: choice.headphoneOffsetMs }).then(setClicks, (error: unknown) => {
            console.warn("[output] the click test could not start", error);
          });
        }}
      >
        {clicks === null ? "Play test clicks" : "Stop the clicks"}
      </button>
    </div>
  );
}
