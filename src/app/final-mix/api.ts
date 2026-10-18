// Keeping the final project's audio on the server (server/app.ts `…/final-project/audio`).
import type { FinishedRecording } from "@audio";
import type { LearnerId } from "@shared/learner.ts";

export type Kept = { readonly ok: true } | { readonly ok: false; readonly message: string };

export function finalProjectAudioPath(learnerId: LearnerId): string {
  return `/api/learners/${encodeURIComponent(learnerId)}/final-project/audio`;
}

export async function keepFinalProjectAudio(learnerId: LearnerId, recording: FinishedRecording): Promise<Kept> {
  let response: Response;
  try {
    response = await fetch(finalProjectAudioPath(learnerId), {
      method: "PUT",
      headers: { "Content-Type": recording.mimeType },
      body: recording.blob,
      credentials: "same-origin",
    });
  } catch (error) {
    return { ok: false, message: `The server is not reachable (${String(error)}). Download the mix instead, and keep it again later.` };
  }
  if (response.ok) return { ok: true };
  return {
    ok: false,
    message:
      response.status === 413
        ? "The recording is too big to keep on the server. Download it instead."
        : `Keeping the recording failed (HTTP ${String(response.status)}). Download the mix instead; the server log says why.`,
  };
}
