/**
 * One self-contained HTML page: each song with the agent's shortlist first, then every variant
 * found, with BPM and key. Filters (BPM range, DJ versions only, key fits the original, platform),
 * tick boxes, and buttons that copy the ticked links or download them as CSV or M3U.
 */
import type { SongPicks } from "./agent.ts";
import { harmonyWithOriginal, type SongFindings } from "./finder.ts";

export interface ReportInput {
  readonly playlistName: string;
  readonly generatedAt: string;
  readonly findings: readonly SongFindings[];
  readonly picks: ReadonlyMap<number, SongPicks> | null;
  readonly summary: string | null;
  readonly notes: readonly string[];
}

/** The rows the page draws, one per candidate. */
export function reportData(input: ReportInput) {
  return {
    playlist: input.playlistName,
    generatedAt: input.generatedAt,
    summary: input.summary,
    notes: input.notes,
    agent: input.picks !== null,
    songs: input.findings.map((found, index) => {
      const chosen = input.picks?.get(index);
      const reasons = new Map(chosen?.picks.map((pick, rank) => [pick.candidateId, { reason: pick.reason, rank }]) ?? []);
      return {
        title: found.song.title,
        artists: found.song.artists,
        spotifyUrl: `https://open.spotify.com/track/${found.song.spotifyId}`,
        bpm: found.original?.status === "ok" ? found.original.bpm : null,
        key: found.original?.status === "ok" ? (found.original.key?.camelot ?? null) : null,
        note: chosen?.note ?? null,
        problems: found.problems,
        variants: found.candidates.map((candidate) => {
          const analysis = candidate.analysis;
          const picked = reasons.get(candidate.id);
          return {
            id: candidate.id,
            platform: candidate.platform,
            title: candidate.title,
            by: candidate.uploader,
            url: candidate.url,
            kind: candidate.kind,
            dj: candidate.djFriendly,
            durationSec: candidate.durationSec,
            plays: candidate.plays,
            bpm: analysis?.status === "ok" ? analysis.bpm : null,
            key: analysis?.status === "ok" ? (analysis.key?.camelot ?? null) : null,
            keyName: analysis?.status === "ok" ? (analysis.key?.name ?? null) : null,
            keySure: analysis?.status === "ok" && analysis.key !== null && analysis.key.confidence >= 0.05,
            harmony: harmonyWithOriginal(found.original, analysis),
            measured: analysis === null ? "not measured" : analysis.status === "ok" ? (candidate.measuredFrom === null ? "" : "measured on another platform") : analysis.status === "unavailable" ? analysis.reason : "could not measure",
            pick: picked?.rank ?? null,
            reason: picked?.reason ?? null,
          };
        }),
      };
    }),
  };
}

/** JSON that is safe inside a <script> element. */
export const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");

export function renderReport(input: ReportInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Remix finder</title>
<style>
:root { --bg: #fafaf8; --fg: #1d1d1b; --muted: #6b6b66; --line: #e2e1dc; --card: #fff; --accent: #2f5fd0; --pick: #fff6d6; --good: #1c7c4a; --warn: #9a6700; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --fg: #ecebe6; --muted: #9b9a94; --line: #2f2e2b; --card: #1d1d1b; --accent: #7aa2ff; --pick: #3a3214; --good: #5fd39a; --warn: #e3b341; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header, main { max-width: 1100px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
.muted { color: var(--muted); }
.bar { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line); padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; }
.bar label { display: inline-flex; gap: 6px; align-items: center; white-space: nowrap; }
.bar input[type=number] { width: 4.5em; }
button { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
button:hover { border-color: var(--accent); }
section.song { background: var(--card); border: 1px solid var(--line); border-radius: 10px; margin: 16px 0; padding: 12px 14px; }
section.song h2 { font-size: 1.1rem; margin: 0; }
.songhead { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; align-items: baseline; }
.summary { white-space: pre-wrap; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin-top: 8px; }
th, td { text-align: left; padding: 6px 8px; border-top: 1px solid var(--line); vertical-align: top; }
th { font-size: .8rem; color: var(--muted); font-weight: 600; cursor: pointer; user-select: none; }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.pick td { background: var(--pick); }
.reason { font-size: .88rem; margin-top: 2px; }
.tag { font-size: .75rem; padding: 1px 6px; border-radius: 99px; border: 1px solid var(--line); white-space: nowrap; }
.same, .relative, .neighbour { color: var(--good); }
.unsure { color: var(--warn); }
a { color: var(--accent); }
details summary { cursor: pointer; color: var(--muted); margin-top: 8px; }
.toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--fg); color: var(--bg); padding: 8px 14px; border-radius: 8px; opacity: 0; transition: opacity .2s; pointer-events: none; }
.toast.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <h1 id="title"></h1>
  <div class="muted" id="meta"></div>
</header>
<div class="bar" role="toolbar" aria-label="Filters">
  <label>BPM <input type="number" id="min" placeholder="min"> – <input type="number" id="max" placeholder="max"></label>
  <label><input type="checkbox" id="dj" checked> DJ versions only</label>
  <label><input type="checkbox" id="harmonic"> Key fits the original</label>
  <label><input type="checkbox" id="picksOnly"> Shortlist only</label>
  <span id="platforms"></span>
  <span style="flex:1"></span>
  <span class="muted" id="count"></span>
  <button id="copy">Copy links</button>
  <button id="csv">CSV</button>
  <button id="m3u">M3U</button>
</div>
<main id="songs"></main>
<div class="toast" id="toast"></div>
<script id="data" type="application/json">${scriptJson(reportData(input))}</script>
<script>
const data = JSON.parse(document.getElementById("data").textContent);
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children.filter((c) => c != null)); return node; };
const ticked = new Set(data.songs.flatMap((s) => s.variants.filter((v) => v.pick !== null).map((v) => v.id)));
const platforms = [...new Set(data.songs.flatMap((s) => s.variants.map((v) => v.platform)))];
const shown = new Set(platforms);
const sortBy = new Map();

$("title").textContent = data.playlist;
$("meta").textContent = data.songs.length + " songs · " + new Date(data.generatedAt).toLocaleString() + (data.agent ? " · shortlist by the agent" : " · no shortlist (run without --no-agent for one)") + (data.notes.length ? " · " + data.notes.join(" · ") : "");
if (!data.agent) $("picksOnly").parentElement.hidden = true;
for (const platform of platforms) {
  const box = el("input", { type: "checkbox", checked: true });
  box.addEventListener("change", () => { box.checked ? shown.add(platform) : shown.delete(platform); draw(); });
  $("platforms").append(el("label", {}, box, platform));
}
for (const id of ["min", "max", "dj", "harmonic", "picksOnly"]) $(id).addEventListener("input", draw);

function visible(v) {
  const min = Number($("min").value), max = Number($("max").value);
  if (!shown.has(v.platform)) return false;
  if ($("dj").checked && !v.dj && v.pick === null) return false;
  if ($("picksOnly").checked && v.pick === null) return false;
  if ($("harmonic").checked && !(v.harmony === "same" || v.harmony === "neighbour" || v.harmony === "relative")) return false;
  if ($("min").value !== "" && !(v.bpm !== null && v.bpm >= min)) return false;
  if ($("max").value !== "" && !(v.bpm !== null && v.bpm <= max)) return false;
  return true;
}
const minutes = (s) => s == null ? "" : Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");
const keyCell = (v) => v.key === null ? el("span", { className: "muted", textContent: "–" }) : el("span", { className: v.keySure ? "" : "unsure", title: (v.keyName || "") + (v.keySure ? "" : " (a guess)") }, v.key + (v.keySure ? "" : "?"));

function row(song, v) {
  const box = el("input", { type: "checkbox", checked: ticked.has(v.id), ariaLabel: "Tick " + v.title });
  box.addEventListener("change", () => { box.checked ? ticked.add(v.id) : ticked.delete(v.id); count(); });
  const title = el("td", {}, el("a", { href: v.url, target: "_blank", rel: "noopener", textContent: v.title }), el("div", { className: "muted", textContent: v.by + (v.measured ? " · " + v.measured : "") }), v.reason ? el("div", { className: "reason", textContent: "★ " + v.reason }) : null);
  return el("tr", { className: v.pick !== null ? "pick" : "" },
    el("td", {}, box), title,
    el("td", {}, el("span", { className: "tag", textContent: v.kind })),
    el("td", { className: "num", textContent: v.bpm === null ? "–" : String(v.bpm) }),
    el("td", { className: "num" }, keyCell(v)),
    el("td", { className: v.harmony || "", textContent: v.harmony || "" }),
    el("td", { className: "num", textContent: minutes(v.durationSec) }),
    el("td", { className: "muted", textContent: v.platform }));
}

function table(song, songIndex, variants) {
  const heads = [["", null], ["Version", "title"], ["Kind", "kind"], ["BPM", "bpm"], ["Key", "key"], ["With original", "harmony"], ["Length", "durationSec"], ["Where", "platform"]];
  const sort = sortBy.get(songIndex);
  const rows = [...variants].sort((a, b) => {
    if (!sort) return (a.pick ?? 99) - (b.pick ?? 99);
    const x = a[sort.field], y = b[sort.field];
    return (x === null) - (y === null) || (x < y ? -1 : x > y ? 1 : 0) * sort.direction;
  });
  const head = el("tr", {}, ...heads.map(([label, field]) => {
    const th = el("th", { textContent: label + (sort && sort.field === field ? (sort.direction > 0 ? " ▲" : " ▼") : "") });
    if (field) th.addEventListener("click", () => { sortBy.set(songIndex, { field, direction: sort && sort.field === field ? -sort.direction : 1 }); draw(); });
    return th;
  }));
  return el("div", { className: "wrap" }, el("table", {}, el("thead", {}, head), el("tbody", {}, ...rows.map((v) => row(song, v)))));
}

function draw() {
  const main = $("songs");
  main.replaceChildren();
  if (data.summary) main.append(el("div", { className: "summary", textContent: data.summary }));
  data.songs.forEach((song, index) => {
    const variants = song.variants.filter(visible);
    const picks = variants.filter((v) => v.pick !== null);
    const rest = variants.filter((v) => v.pick === null);
    const head = el("div", { className: "songhead" },
      el("h2", {}, el("a", { href: song.spotifyUrl, target: "_blank", rel: "noopener", textContent: song.title }), el("span", { className: "muted", textContent: " · " + song.artists.join(", ") })),
      el("span", { className: "muted", textContent: "original: " + (song.bpm ?? "–") + " BPM · " + (song.key ?? "–") + " · " + song.variants.length + " versions found" }));
    const section = el("section", { className: "song" }, head);
    if (song.note) section.append(el("div", { className: "muted reason", textContent: song.note }));
    if (variants.length === 0) section.append(el("div", { className: "muted", textContent: "Nothing matches the filters." }));
    else if (!data.agent || picks.length === 0) section.append(table(song, index, variants));
    else {
      section.append(table(song, index, picks));
      if (rest.length) section.append(el("details", {}, el("summary", { textContent: rest.length + " more" }), table(song, index + 0.5, rest)));
    }
    if (song.problems.length) section.append(el("div", { className: "muted reason", textContent: "Problems: " + song.problems.join("; ") }));
    main.append(section);
  });
  count();
}

const chosen = () => data.songs.flatMap((song) => song.variants.filter((v) => ticked.has(v.id)).map((v) => ({ song, v })));
function count() { $("count").textContent = chosen().length + " ticked"; }
function toast(text) { const t = $("toast"); t.textContent = text; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 1600); }
function download(name, type, text) { const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); a.remove(); }
const csvCell = (value) => { const text = value == null ? "" : String(value); return /[",\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text; };
$("copy").addEventListener("click", async () => {
  const text = chosen().map(({ v }) => v.url).join("\\n");
  try { await navigator.clipboard.writeText(text); toast("Copied " + chosen().length + " links"); } catch { download("links.txt", "text/plain", text); }
});
$("csv").addEventListener("click", () => {
  const lines = [["song", "artists", "version", "by", "kind", "bpm", "key", "with_original", "length", "platform", "url", "reason"].join(",")]
    .concat(chosen().map(({ song, v }) => [song.title, song.artists.join(" & "), v.title, v.by, v.kind, v.bpm, v.key, v.harmony, minutes(v.durationSec), v.platform, v.url, v.reason].map(csvCell).join(",")));
  download("variants.csv", "text/csv", lines.join("\\n") + "\\n");
});
$("m3u").addEventListener("click", () => {
  const lines = ["#EXTM3U"].concat(chosen().flatMap(({ v }) => ["#EXTINF:" + Math.round(v.durationSec ?? -1) + "," + v.title + (v.bpm ? " [" + v.bpm + " BPM " + (v.key ?? "") + "]" : ""), v.url]));
  download("variants.m3u", "audio/x-mpegurl", lines.join("\\n") + "\\n");
});
draw();
</script>
</body>
</html>
`;
}
