import { parseArgs } from "node:util";

/**
 * A script's arguments. --help or -h prints `usage` and exits 0; an unknown option, a missing value
 * or a stray argument prints what was wrong and the usage, and exits 2.
 */
export function cliArgs(usage, options, { positionals = false } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: positionals });
  } catch (error) {
    usageError(usage, error.message);
  }
  if (parsed.values.help) {
    console.log(usage);
    process.exit(0);
  }
  return parsed;
}

export function usageError(usage, message) {
  console.error(`${message}\n\n${usage}`);
  process.exit(2);
}
