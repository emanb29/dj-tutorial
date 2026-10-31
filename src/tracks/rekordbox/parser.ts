// Reads a rekordbox.xml File: in a worker where there is one (a library of tens of thousands of
// tracks is a big file, and the page must not stall), streamed in either case, so the text is never
// held twice. Tests and Node read it here.
import type { ParseReply, ParseRequest } from "./parse-protocol.ts";
import { parseRekordboxXml, type RekordboxParse } from "./xml.ts";

/** The file's text in pieces as it is read. */
export async function* fileText(file: Blob): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const rest = decoder.decode();
    if (rest !== "") yield rest;
  } finally {
    // Stopping early (the collection ended, or the file is not rekordbox's) stops the reading too.
    await reader.cancel().catch(() => undefined);
  }
}

export function parseRekordboxFileHere(file: Blob): Promise<RekordboxParse> {
  return parseRekordboxXml(fileText(file));
}

const aborted = (): RekordboxParse => ({ ok: false, error: { kind: "malformed", message: "Reading the rekordbox file was stopped.", fix: "Pick it again." } });

export function parseRekordboxFileInWorker(file: Blob, signal?: AbortSignal): Promise<RekordboxParse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module", name: "rekordbox-xml" });
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener("abort", stop);
    };
    const stop = () => {
      finish();
      resolve(aborted());
    };
    signal?.addEventListener("abort", stop);
    worker.onmessage = (event: MessageEvent<ParseReply>) => {
      finish();
      const reply = event.data;
      if (reply.type === "parsed") resolve(reply.result);
      else reject(new Error(`Reading rekordbox.xml failed: ${reply.message}`));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(`The rekordbox.xml worker crashed: ${event.message}`));
    };
    const request: ParseRequest = { type: "parse", file };
    worker.postMessage(request);
  });
}

/** Parses in a worker when the page can start one, here otherwise. */
export function parseRekordboxFile(file: Blob, signal?: AbortSignal): Promise<RekordboxParse> {
  if (signal?.aborted === true) return Promise.resolve(aborted());
  if (typeof Worker !== "undefined") return parseRekordboxFileInWorker(file, signal);
  return parseRekordboxFileHere(file);
}
