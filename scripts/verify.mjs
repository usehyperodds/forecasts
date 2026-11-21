#!/usr/bin/env node
// Checks the daily records under records/ against their manifests and the index, then each line's
// format and times and each batch's signature. Exits 1 at the first failure, and 2 when a named day
// is not a date.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliArgs, usageError } from "./lib/cli.mjs";
import { isDay } from "./lib/record.mjs";
import { loadRecords, RecordError, verifyRecords } from "./lib/verify.mjs";

const USAGE = `usage: node scripts/verify.mjs [--root <dir>] [YYYY-MM-DD ...]

Checks the daily records under records/, every day or the days named: hashes, line format, times and
signatures. Exits 1 at the first failure.

  --root <dir>   the directory holding records/ (default: this repository)
  -h, --help     print this help`;

const { values, positionals } = cliArgs(USAGE, { root: { type: "string" } }, { positionals: true });
const root = resolve(values.root ?? fileURLToPath(new URL("..", import.meta.url)));
for (const day of positionals) if (!isDay(day)) usageError(USAGE, `${JSON.stringify(day)} is not a day`);

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
