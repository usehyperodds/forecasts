import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const run = (name, args) => exec(process.execPath, [fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url)), ...args]);

const OPTIONS = {
  fetch: ["--api <url>", "--root <dir>", "--recheck <days>|all", "-h, --help"],
  verify: ["--root <dir>", "-h, --help"],
  score: ["--root <dir>", "--hl <url>", "--offline", "--refetch", "--compare <url>", "-h, --help"],
};

for (const [name, options] of Object.entries(OPTIONS)) {
  test(`${name} --help and -h print its usage and every option, and exit 0`, async () => {
    for (const flag of ["--help", "-h"]) {
      const { stdout, stderr } = await run(name, [flag]);
      assert.match(stdout, new RegExp(`^usage: node scripts/${name}\\.mjs `));
      for (const option of options) assert.ok(stdout.includes(`  ${option}`), `${flag} lists ${option}`);
      assert.equal(stderr, "");
    }
  });

  test(`${name} with an unknown option prints its usage and exits 2, without a stack trace`, async () => {
    for (const args of [["--bogus"], ["--root"]]) {
      await assert.rejects(run(name, args), (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /^(Unknown option '--bogus'|Option '--root <value>' argument missing)/);
        assert.match(error.stderr, new RegExp(`\\n\\nusage: node scripts/${name}\\.mjs `));
        assert.doesNotMatch(error.stderr, /^\s+at /m);
        assert.equal(error.stdout, "");
        return true;
      });
    }
  });
}

test("score and fetch refuse a stray argument with their usage", async () => {
  for (const name of ["score", "fetch"])
    await assert.rejects(run(name, ["extra"]), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /^Unexpected argument 'extra'/);
      return true;
    });
});

test("verify refuses a day that is not a date with its usage", async () => {
  await assert.rejects(run("verify", ["2026-13-01"]), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /^"2026-13-01" is not a day\n\nusage: node scripts\/verify\.mjs /);
    return true;
  });
});
