// rekordbox.xml parsing (xml.ts) off the main thread: one file per worker.
import type { ParseReply, ParseRequest } from "./parse-protocol.ts";
import { parseRekordboxFileHere } from "./parser.ts";

/** The parts of DedicatedWorkerGlobalScope used here (the app's lib is DOM, not WebWorker). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<ParseRequest>) => void) | null;
  postMessage(message: ParseReply): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<ParseRequest>) => {
  parseRekordboxFileHere(event.data.file).then(
    (result) => {
      scope.postMessage({ type: "parsed", result });
    },
    (error: unknown) => {
      scope.postMessage({ type: "failed", message: error instanceof Error ? error.message : String(error) });
    },
  );
};
