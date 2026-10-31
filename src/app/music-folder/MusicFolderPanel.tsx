// The music folder setting: pick a folder once and its tracks fill the library, kept up to date.
// On /controller (the settings) in full, and in Freestyle's library as one line with Rescan.
// Opening the browser's folder picker, and allowing access again, need a click, tap or key: MIDI
// is not a user gesture, so with the FLX4 the ring's caption says so. The same goes for picking
// rekordbox.xml ("Use rekordbox.xml"), whose BPMs, grids, keys and cues fill in the folder's tracks.
import { useState, useSyncExternalStore } from "react";
import type { MusicFolder, MusicFolderSnapshot } from "@tracks";
import { useControllerConnected } from "../controller/KeyHint.tsx";
import "./music-folder.css";

/** Where rekordbox.xml comes from, for a Learner who has not made one. */
export const REKORDBOX_HOW = "rekordbox: File → Export Collection in xml format. Pick it, or save it in your music folder.";

export const GESTURE_NOTICE = "Picking a folder or file needs the mouse, keyboard or screen. Turn BROWSE to go past it.";

export interface MusicFolderPanelProps {
  readonly folder: MusicFolder;
  /** One line and the buttons, for a library; the full setting otherwise. */
  readonly compact?: boolean;
}

export function useMusicFolder(folder: MusicFolder): MusicFolderSnapshot {
  return useSyncExternalStore(folder.subscribe, folder.snapshot);
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** "120 tracks · BPM for 30 · 2 won't play · 1 unreadable": what the library holds, briefly. */
export function folderCounts(snapshot: MusicFolderSnapshot): string {
  const parts = [plural(snapshot.found, "track")];
  if (snapshot.found > 0) parts.push(`BPM for ${snapshot.analysed.toLocaleString()}`);
  if (snapshot.failed > 0) parts.push(`${snapshot.failed.toLocaleString()} with no BPM`);
  if (snapshot.skipped > 0) parts.push(`${snapshot.skipped.toLocaleString()} unreadable`);
  if (snapshot.truncated) parts.push("first 20,000 only");
  return parts.join(" · ");
}

/** The caption: what is going on, in one short line. */
export function folderCaption(snapshot: MusicFolderSnapshot): string {
  const name = snapshot.folder === null ? "" : `“${snapshot.folder}”`;
  if (snapshot.access === "none") return snapshot.canPick ? "Pick your music folder. New tracks show up by themselves." : "Import your music folder.";
  if (snapshot.access === "needs-permission") return `${name}: the browser needs one click to read it again.`;
  if (snapshot.scanning) return `Looking in ${name}… ${plural(snapshot.found, "track")} so far`;
  return `${name}: ${folderCounts(snapshot)}`;
}

/** rekordbox's line: how many of the folder's tracks it knows. Null without a collection. */
export function rekordboxLine(snapshot: MusicFolderSnapshot): string | null {
  const linked = snapshot.rekordbox;
  if (linked === null) return null;
  if (linked.reading) return `rekordbox: reading “${linked.name ?? "rekordbox.xml"}”…`;
  if (linked.needsPermission) return "rekordbox.xml: the browser needs one click to read it again.";
  if (linked.from === null) return null;
  const skipped = linked.skipped > 0 ? ` · ${plural(linked.skipped, "entry", "entries")} skipped` : "";
  return `rekordbox: matched ${linked.matched.toLocaleString()} of ${snapshot.found.toLocaleString()}${skipped}`;
}

/** How new tracks get in. */
function refreshLine(snapshot: MusicFolderSnapshot): string | null {
  if (snapshot.access === "imported") return "Imported once. This browser can't watch a folder: import again for new tracks.";
  if (snapshot.access !== "granted") return null;
  if (snapshot.refresh === "observer") return "New tracks show up by themselves.";
  if (snapshot.refresh === "polling") return "Checks for new tracks every 30 s.";
  return null;
}

export function MusicFolderPanel({ folder, compact = false }: MusicFolderPanelProps) {
  const snapshot = useMusicFolder(folder);
  const controllerConnected = useControllerConnected();
  const [ringOnPicker, setRingOnPicker] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = (action: () => Promise<{ ok: true } | { ok: false; error: { kind: string; message: string; fix: string } }>) => {
    setProblem(null);
    void action().then((outcome) => {
      if (!outcome.ok && outcome.error.kind !== "aborted") setProblem(`${outcome.error.message} ${outcome.error.fix}`);
    });
  };
  // Only the picker buttons need a gesture; the caption shows while the FLX4's ring is on one.
  const gestureProps = {
    onFocus: () => {
      setRingOnPicker(true);
    },
    onBlur: () => {
      setRingOnPicker(false);
    },
  };

  const pickButton = snapshot.canPick ? (
    <button type="button" className="btn" {...gestureProps} onClick={() => { run(() => folder.pick()); }}>
      {snapshot.access === "none" ? "Pick a folder" : "Change folder"}
    </button>
  ) : (
    <label className="btn music-folder-import">
      {snapshot.access === "imported" ? "Import again" : "Import a folder"}
      <input
        type="file"
        multiple
        ref={(input) => {
          // React has no prop for it; Chrome on Android picks a folder with it.
          input?.setAttribute("webkitdirectory", "");
        }}
        onChange={(event) => {
          if (event.target.files !== null) folder.importFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </label>
  );

  const folderProblem = snapshot.problem ?? snapshot.rekordbox?.problem ?? null;
  const shownProblem = problem ?? (folderProblem === null ? null : `${folderProblem.message} ${folderProblem.fix}`);
  const refresh = refreshLine(snapshot);
  const link = folder.rekordbox;
  const linked = snapshot.rekordbox;
  const rekordboxText = rekordboxLine(snapshot);

  return (
    <div className={compact ? "music-folder music-folder-compact" : "music-folder"} data-testid="music-folder" data-access={snapshot.access} data-scanning={snapshot.scanning}>
      <p className="music-folder-caption" role="status" aria-live="polite">
        {folderCaption(snapshot)}
      </p>
      {!compact && refresh !== null ? <p className="hw-hint">{refresh}</p> : null}
      <div className="music-folder-buttons">
        {snapshot.access === "needs-permission" ? (
          <button type="button" className="btn btn-primary" {...gestureProps} onClick={() => { run(() => folder.allowAccess()); }}>
            Allow access
          </button>
        ) : null}
        {compact && snapshot.canPick && snapshot.access !== "none" ? null : pickButton}
        {snapshot.access === "granted" ? (
          <button type="button" className="btn" disabled={snapshot.scanning} onClick={() => void folder.rescan()}>
            Rescan now
          </button>
        ) : null}
        {!compact && snapshot.access !== "none" ? (
          <button type="button" className="btn btn-quiet" onClick={() => void folder.forget()}>
            Forget folder
          </button>
        ) : null}
      </div>
      {rekordboxText === null ? null : (
        <p className="music-folder-caption music-folder-rekordbox" data-testid="rekordbox-status" aria-live="polite">
          {rekordboxText}
        </p>
      )}
      {!compact && link !== null && linked !== null ? (
        <div className="music-folder-buttons">
          {linked.canPickFile ? (
            <button type="button" className="btn" {...gestureProps} onClick={() => { run(() => link.pickFile()); }}>
              {linked.needsPermission ? "Allow rekordbox.xml" : "Use rekordbox.xml"}
            </button>
          ) : (
            <label className="btn music-folder-import" {...gestureProps}>
              Use rekordbox.xml
              <input
                type="file"
                accept=".xml,text/xml,application/xml"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) run(() => link.useFile(file));
                  event.target.value = "";
                }}
              />
            </label>
          )}
          {linked.from === "file" ? (
            <button type="button" className="btn btn-quiet" onClick={() => void link.forgetFile()}>
              Forget rekordbox.xml
            </button>
          ) : null}
        </div>
      ) : null}
      {!compact && linked !== null && linked.from === null && !linked.reading ? <p className="hw-hint">{REKORDBOX_HOW}</p> : null}
      {controllerConnected && ringOnPicker ? (
        <p className="hw-hint" data-testid="music-folder-gesture">
          {GESTURE_NOTICE}
        </p>
      ) : null}
      {!compact && !snapshot.canPick && snapshot.access === "none" ? (
        <p className="hw-hint">This browser can't watch a folder: import again for new tracks.</p>
      ) : null}
      {shownProblem === null ? null : (
        <p className="lesson-problem" role="alert">
          {shownProblem}
        </p>
      )}
    </div>
  );
}
