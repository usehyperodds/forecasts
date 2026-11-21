import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("..", import.meta.url));
const verify = join(repo, "scripts", "verify.mjs");
// Quiet, hook-free git with no signing, whatever the machine's own config says.
const git = (cwd, ...args) =>
  exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd });

const temps = [];
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

/** A repository holding the valid fixture records, cloned the way Windows does: core.autocrlf=true. */
async function crlfClone(attributes) {
  const dir = await mkdtemp(join(tmpdir(), "hyperodds-forecasts-git-"));
  temps.push(dir);
  const src = join(dir, "src");
  await cp(join(repo, "test", "fixtures", "valid", "records"), join(src, "records"), { recursive: true });
  if (attributes) await cp(join(repo, ".gitattributes"), join(src, ".gitattributes"));
  await git(dir, "init", "-q", src);
  await git(src, "add", ".");
  await git(src, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "records");
  await git(dir, "clone", "-q", "-c", "core.autocrlf=true", src, "clone");
  return join(dir, "clone");
}

test("a checkout that converts line endings keeps the records byte for byte", async () => {
  const { stdout } = await exec(process.execPath, [verify, "--root", await crlfClone(true)]);
  assert.match(stdout, /verified 2 days, 8 forecasts/);
});

test("without .gitattributes the same checkout breaks the records", async () => {
  await assert.rejects(exec(process.execPath, [verify, "--root", await crlfClone(false)]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /is not in the record's format/);
    return true;
  });
});
