#!/usr/bin/env node
// Checks every daily record under records/: hashes against manifest and index, line format,
// batch completeness and every signature. Exits 1 on the first failure.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isDay } from "./lib/record.mjs";
import { loadRecords, RecordError, verifyRecords } from "./lib/verify.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { root: { type: "string" } },
});
const root = resolve(values.root ?? fileURLToPath(new URL("..", import.meta.url)));
for (const day of positionals)
  if (!isDay(day)) {
    console.error(`usage: verify.mjs [--root <dir>] [YYYY-MM-DD ...]; ${JSON.stringify(day)} is not a day`);
    process.exit(2);
  }

try {
  const store = await loadRecords(join(root, "records"));
  const days = verifyRecords(store, { only: positionals.length > 0 ? positionals : undefined });
  if (days.length === 0) {
    console.log("no records yet");
    process.exit(0);
  }
  for (const d of days)
    console.log(`${d.day}  ok  ${d.lines.length} forecasts, ${d.batches} batches, root ${d.manifest.root}`);
  const forecasts = days.reduce((n, d) => n + d.lines.length, 0);
  console.log(`verified ${days.length} ${days.length === 1 ? "day" : "days"}, ${forecasts} forecasts`);
} catch (error) {
  if (!(error instanceof RecordError)) throw error;
  console.error(`FAIL ${error.message}`);
  process.exit(1);
}
