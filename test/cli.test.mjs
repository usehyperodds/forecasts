import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const fixtures = fileURLToPath(new URL("fixtures/", import.meta.url));
const script = (name) => fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url));
const exec = promisify(execFile);
const run = (name, args) => exec(process.execPath, [script(name), ...args]);

async function refused(promise) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.code, 1, error.stderr);
    return error.stderr;
  }
  assert.fail("expected the script to fail");
}

/** A local HTTP server; `routes` maps a path to a body or to (req, body) => [status, body]. */
async function serve(routes) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://x");
    const route = routes[url.pathname];
    const [status, out] = route === undefined ? [404, "{}"] : typeof route === "function" ? route(url, body) : [200, route];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(out);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function recordsOf(name) {
  const dir = join(fixtures, name, "records");
  const files = {};
  for (const f of await readdir(dir)) files[f] = await readFile(join(dir, f));
  return files;
}

/** API routes for a fixture's records, optionally limited to some days. */
function recordRoutes(files, days) {
  const index = JSON.parse(files["index.json"]);
  const listed = days ? { days: index.days.filter((d) => days.includes(d.day)) } : index;
  const routes = { "/forecasts/records": `${JSON.stringify(listed, null, 2)}\n` };
  for (const d of listed.days) {
    routes[`/forecasts/records/${d.day}.jsonl`] = files[`${d.day}.jsonl`];
    routes[`/forecasts/records/${d.day}.json`] = files[`${d.day}.json`];
  }
  return routes;
}

const temps = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "hyperodds-forecasts-"));
  temps.push(dir);
  return dir;
}
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

test("fetch mirrors missing days, verified, and never rewrites one", async () => {
  const files = await recordsOf("valid");
  const routes = recordRoutes(files, ["2026-11-22"]);
  const api = await serve(routes);
  const root = await temp();
  try {
    let out = await run("fetch", ["--api", api.url, "--root", root]);
    assert.match(out.stdout, /^added 2026-11-22 {2}5 forecasts/);
    const first = await stat(join(root, "records", "2026-11-22.jsonl"));

    Object.assign(routes, recordRoutes(files));
    out = await run("fetch", ["--api", api.url, "--root", root]);
    assert.match(out.stdout, /^added 2026-11-23 {2}3 forecasts/);
    for (const f of Object.keys(files)) assert.deepEqual(await readFile(join(root, "records", f)), files[f], f);
    assert.equal((await stat(join(root, "records", "2026-11-22.jsonl"))).mtimeMs, first.mtimeMs);

    out = await run("fetch", ["--api", api.url, "--root", root]);
    assert.match(out.stdout, /^up to date, 2 days/);
    assert.match((await run("verify", ["--root", root])).stdout, /verified 2 days, 8 forecasts/);
  } finally {
    await api.close();
  }
});

test("fetch refuses a closed day that changed, and writes nothing", async () => {
  const files = await recordsOf("valid");
  const routes = recordRoutes(files);
  const api = await serve(routes);
  const root = await temp();
  try {
    await run("fetch", ["--api", api.url, "--root", root]);
    const before = await readFile(join(root, "records", "index.json"));
    const index = JSON.parse(routes["/forecasts/records"]);
    index.days[1].sha256 = "0".repeat(64);
    routes["/forecasts/records"] = JSON.stringify(index);
    const stderr = await refused(run("fetch", ["--api", api.url, "--root", root]));
    assert.match(stderr, /^FAIL the API now gives 2026-11-22 sha256 "0{64}", but this copy holds "[0-9a-f]{64}"; a closed record never changes; nothing was written/);
    assert.deepEqual(await readFile(join(root, "records", "index.json")), before);
  } finally {
    await api.close();
  }
});

test("fetch writes nothing when a fetched day fails verify", async () => {
  const api = await serve(recordRoutes(await recordsOf("tampered-line")));
  const root = await temp();
  try {
    const stderr = await refused(run("fetch", ["--api", api.url, "--root", root]));
    assert.match(stderr, /^FAIL 2026-11-22, lines 1, 2, 3: batch 1's signature recovers to .*; nothing was written/);
    await assert.rejects(readdir(join(root, "records")), { code: "ENOENT" });
  } finally {
    await api.close();
  }
});

test("fetch refuses a day that is not a date", async () => {
  const api = await serve({ "/forecasts/records": JSON.stringify({ days: [{ day: "../../etc" }] }) });
  const root = await temp();
  try {
    const stderr = await refused(run("fetch", ["--api", api.url, "--root", root]));
    assert.match(stderr, /lists "\.\.\/\.\.\/etc", which is not a day; nothing was written/);
  } finally {
    await api.close();
  }
});

describe("score", () => {
  let hl;
  let asked;
  let settlements;
  let root;

  before(async () => {
    settlements = JSON.parse(await readFile(join(fixtures, "scoring", "settlements.json"), "utf8"));
    asked = [];
    hl = await serve({
      "/info": (_url, body) => {
        const { type, outcome } = JSON.parse(body);
        assert.equal(type, "settledOutcome");
        asked.push(outcome);
        const fraction = settlements[outcome];
        if (fraction === undefined) return [200, "null"];
        const spec = { outcome, name: "Fixture", description: "", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken: "USDC" };
        return [200, JSON.stringify({ spec, settleFraction: fraction, details: "template" })];
      },
    });
    root = await temp();
    await cp(join(fixtures, "scoring", "records"), join(root, "records"), { recursive: true });
  });
  after(() => hl.close());

  test("score asks Hyperliquid once per settled outcome and rebuilds the known board", async () => {
    const want = await readFile(join(fixtures, "scoring", "board.json"), "utf8");
    const out = await run("score", ["--root", root, "--hl", `${hl.url}/info`]);
    assert.match(out.stdout, /asked Hyperliquid about 58 outcomes: 56 settled, 2 not yet/);
    assert.equal(asked.length, 58);
    assert.equal(await readFile(join(root, "board.json"), "utf8"), want);
    assert.equal(
      await readFile(join(root, "settlements.json"), "utf8"),
      await readFile(join(fixtures, "scoring", "settlements.json"), "utf8"),
    );

    asked.length = 0;
    await run("score", ["--root", root, "--hl", `${hl.url}/info`]);
    assert.deepEqual(asked, [1058, 1059]);

    asked.length = 0;
    await run("score", ["--root", root, "--hl", `${hl.url}/info`, "--offline"]);
    assert.deepEqual(asked, []);
    assert.equal(await readFile(join(root, "board.json"), "utf8"), want);
  });

  test("score --refetch fails when Hyperliquid disagrees with the cache", async () => {
    settlements[1000] = settlements[1000] === "1.0" ? "0.0" : "1.0";
    try {
      const stderr = await refused(run("score", ["--root", root, "--hl", `${hl.url}/info`, "--refetch"]));
      assert.match(stderr, /^FAIL settlements.json has outcome 1000 settled at [01]\.0; Hyperliquid answers [01]\.0/);
    } finally {
      settlements[1000] = settlements[1000] === "1.0" ? "0.0" : "1.0";
    }
  });

  test("score --compare checks every page of the API's board byte for byte", async () => {
    const known = JSON.parse(await readFile(join(fixtures, "scoring", "board.json"), "utf8"));
    let served = { ...known, asOf: "2026-11-24T00:07:12.345Z" };
    const pages = [];
    const api = await serve({
      "/forecasts/board": (url) => {
        const limit = Number(url.searchParams.get("limit"));
        const offset = Number(url.searchParams.get("offset"));
        pages.push([limit, offset]);
        return [200, JSON.stringify({ ...served, rows: served.rows.slice(offset, offset + limit) })];
      },
    });
    const args = ["--root", root, "--hl", `${hl.url}/info`, "--offline", "--compare"];
    try {
      const out = await run("score", [...args, api.url]);
      assert.match(out.stdout, /api asOf 2026-11-24T00:07:12\.345Z, rebuilt asOf 2026-11-24T00:05:00\.388Z \(not compared\)/);
      assert.match(out.stdout, /page offset=0: 6 rows, \d+ bytes, identical/);
      assert.deepEqual(pages, [[200, 0]]);

      served = { ...served, rows: served.rows.map((r, i) => (i === 1 ? { ...r, skillFair: r.skillFair + 0.000001 } : r)) };
      let stderr = await refused(run("score", [...args, `${api.url}/forecasts/board`]));
      assert.match(stderr, /rows\[1\]\.skillFair: api [-\d.]+, rebuilt [-\d.]+/);
      assert.match(stderr, /FAIL the rebuilt board differs/);

      served = Object.fromEntries(Object.entries({ ...known, asOf: "x" }).reverse());
      stderr = await refused(run("score", [...args, api.url]));
      assert.match(stderr, /same values, different bytes at character \d+/);
    } finally {
      await api.close();
    }
  });
});
