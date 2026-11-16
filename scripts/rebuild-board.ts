// Rebuild data/board.json from a fresh protocol snapshot.
//
// The snapshot is the same shape the board was first built from:
//   { as_of, source, floor_usd, protocols: [...], watchlist: [...] }
// Protocol rows come from DefiLlama's public /protocols list
// (https://api.llama.fi/protocols) — no key needed.
//
//   node scripts/rebuild-board.ts --input snapshot.json
//
// Writes data/board.json (rows, live tab, categories, chains) and
// data.js for the dashboard. Deterministic: same snapshot, same bytes.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { liveSet, selectBoard } from "../lib/model.ts";
import type { SnapshotFile } from "../lib/model.ts";

const LIVE_COUNT = 24;

function flagValue(argv: string[], flag: string, fallback: string): string {
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1]!;
  return fallback;
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const input = resolve(flagValue(process.argv.slice(2), "--input", "snapshot.json"));
const snap = JSON.parse(readFileSync(input, "utf8")) as SnapshotFile;
if (!Array.isArray(snap.protocols) || !Array.isArray(snap.watchlist)) {
  throw new Error(`snapshot ${input} holds no protocols or watchlist`);
}

const rows = selectBoard(snap);
const live = liveSet(snap.protocols, LIVE_COUNT);
const categories = [...new Set(rows.map((row) => row.category ?? "Uncategorised"))].sort();
const chains = [...new Set(rows.flatMap((row) => row.chains))].sort();

const doc = {
  as_of: snap.as_of,
  source: snap.source,
  model: "radar-2",
  floor_usd: snap.floor_usd,
  rows,
  live,
  categories,
  chains,
};

writeFileSync(join(root, "data", "board.json"), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`board: ${rows.length} rows (watchlist ${snap.watchlist.length}), live ${live.length}, as_of ${snap.as_of}`);
console.log(`top: ${rows.slice(0, 3).map((r) => r.slug).join(", ")}`);
