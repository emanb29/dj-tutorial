// Messages between parser.ts and parse.worker.ts. A File is structured-cloneable; the parsed
// library comes back as plain data.
import type { RekordboxParse } from "./xml.ts";

export interface ParseRequest {
  readonly type: "parse";
  readonly file: Blob;
}

export type ParseReply = { readonly type: "parsed"; readonly result: RekordboxParse } | { readonly type: "failed"; readonly message: string };
