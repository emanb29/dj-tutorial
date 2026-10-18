// The kept final project as files to post: WAV (lossless) and MP3 (320 kbit/s), both tagged with the
// set's title and track list, made by the server's ffmpeg. SoundCloud does not take the browser's
// WebM recording, so these are what to upload. Hidden, with the reason, when the server has no ffmpeg.
import { useEffect, useState } from "react";
import { EXPORT_STATUS_PATH, exportFileName, finalProjectExportPath, type ExportStatus } from "@shared/final-project-export.ts";
import type { FinalProject, LearnerId } from "@shared/learner.ts";

type Loaded = { readonly kind: "loading" } | { readonly kind: "loaded"; readonly status: ExportStatus };

async function fetchStatus(): Promise<ExportStatus> {
  try {
    const response = await fetch(EXPORT_STATUS_PATH, { credentials: "same-origin" });
    if (!response.ok) return { available: false, reason: `The server did not say whether it can convert the set (HTTP ${String(response.status)}). Restart the API and reload.` };
    return ((await response.json()) as { data: ExportStatus }).data;
  } catch (error) {
    return { available: false, reason: `The server is not reachable (${String(error)}). Start it and reload.` };
  }
}

export function FinalProjectDownloads({ learnerId, project }: { readonly learnerId: LearnerId; readonly project: Pick<FinalProject, "recordedAt"> }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    void fetchStatus().then((status) => {
      if (live) setLoaded({ kind: "loaded", status });
    });
    return () => {
      live = false;
    };
  }, []);

  if (loaded.kind === "loading") return null;
  const { status } = loaded;
  return (
    <div className="final-project-downloads" aria-label="Post your set">
      {status.available ? (
        <>
          <p className="set-hint">For SoundCloud: upload the WAV for best quality, or the MP3. Both carry the title and track list.</p>
          <div className="result-actions">
            <a className="btn btn-primary" href={finalProjectExportPath(learnerId, "wav")} download={exportFileName(project, "wav")}>
              Download as WAV
            </a>
            <a className="btn" href={finalProjectExportPath(learnerId, "mp3")} download={exportFileName(project, "mp3")}>
              Download as MP3
            </a>
          </div>
        </>
      ) : (
        <p className="set-hint" role="note">
          No WAV or MP3 download: {status.reason}
        </p>
      )}
    </div>
  );
}
