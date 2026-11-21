import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function refused(promise, code = 1) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.code, code, error.stderr);
    for (const line of error.stderr.split("\n")) assert.doesNotMatch(line, /^::/, "an error line Actions would read as a command");
    return error.stderr;
  }
  assert.fail("expected the script to fail");
}

/** A local HTTP server; `routes` maps a path to a body or to (url, body) => [status, body]. */
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

/** index.json as fetch writes it for these days: the manifests, newest first, with the API's URLs. */
function indexFor(files, api) {
  const days = JSON.parse(files["index.json"]).days.map((d) => ({ ...d, url: `${api}/forecasts/records/${d.day}.jsonl` }));
  return `${JSON.stringify({ days }, null, 2)}\n`;
}

const temps = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "hyperodds-forecasts-"));
  temps.push(dir);
  return dir;
}
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

async function withApi(routes, fn) {
  const api = await serve(routes);
  try {
    return await fn(api);
  } finally {
    await api.close();
  }
}

test("fetch mirrors missing days once they verify, and never rewrites one", async () => {
  const files = await recordsOf("valid");
  const routes = recordRoutes(files, ["2026-10-22"]);
  await withApi(routes, async (api) => {
    const root = await temp();
    let out = await run("fetch", ["--api", api.url, "--root", root]);
    assert.match(out.stdout, /^added 2026-10-22 {2}5 forecasts/);
    const first = await stat(join(root, "records", "2026-10-22.jsonl"));

    Object.assign(routes, recordRoutes(files));
    out = await run("fetch", ["--api", api.url, "--root", root]);
    assert.match(out.stdout, /^added 2026-10-23 {2}3 forecasts/);
    for (const f of Object.keys(files).filter((f) => f !== "index.json"))
      assert.deepEqual(await readFile(join(root, "records", f)), files[f], f);
    assert.equal(await readFile(join(root, "records", "index.json"), "utf8"), indexFor(files, api.url));
    assert.equal((await stat(join(root, "records", "2026-10-22.jsonl"))).mtimeMs, first.mtimeMs);

    out = await run("fetch", ["--api", api.url, "--root", root]);
    assert.match(out.stdout, /^up to date, 2 days/);
    assert.match((await run("verify", ["--root", root])).stdout, /verified 2 days, 8 forecasts/);
  });
});

test("fetch writes index.json from the verified manifests, whatever form the API sends", async () => {
  const files = await recordsOf("valid");
  const routes = recordRoutes(files);
  const index = JSON.parse(routes["/forecasts/records"]);
  routes["/forecasts/records"] = JSON.stringify({ days: index.days.map((d) => ({ ...d, url: "https://elsewhere.example/x" })) });
  await withApi(routes, async (api) => {
    const root = await temp();
    await run("fetch", ["--api", api.url, "--root", root]);
    assert.equal(await readFile(join(root, "records", "index.json"), "utf8"), indexFor(files, api.url));
  });
});

test("fetch refuses a closed day that changed, and writes nothing", async () => {
  const files = await recordsOf("valid");
  const routes = recordRoutes(files);
  await withApi(routes, async (api) => {
    const root = await temp();
    await run("fetch", ["--api", api.url, "--root", root]);
    const before = await readFile(join(root, "records", "index.json"));
    const index = JSON.parse(routes["/forecasts/records"]);
    index.days[1].sha256 = "0".repeat(64);
    routes["/forecasts/records"] = JSON.stringify(index);
    const stderr = await refused(run("fetch", ["--api", api.url, "--root", root]));
    assert.match(stderr, /^FAIL the API now gives 2026-10-22 sha256 "0{64}", but this copy holds "[0-9a-f]{64}"; a closed record never changes; nothing was written/);
    assert.deepEqual(await readFile(join(root, "records", "index.json")), before);
  });
});

test("fetch refuses a new day older than the newest day held", async () => {
  const files = await recordsOf("valid");
  const routes = recordRoutes(files, ["2026-10-23"]);
  await withApi(routes, async (api) => {
    const root = await temp();
    await run("fetch", ["--api", api.url, "--root", root]);
    Object.assign(routes, recordRoutes(files));
    const stderr = await refused(run("fetch", ["--api", api.url, "--root", root]));
    assert.match(stderr, /^FAIL the API lists 2026-10-22, which this copy lacks though it holds the later 2026-10-23; a day is never added after a later one; nothing was written/);
    assert.deepEqual(await readdir(join(root, "records")), ["2026-10-23.json", "2026-10-23.jsonl", "index.json"]);
  });
});

test("fetch --recheck <days>|all stops when a held day's bytes change", async () => {
  const files = await recordsOf("valid");
  const routes = recordRoutes(files);
  await withApi(routes, async (api) => {
    const root = await temp();
    await run("fetch", ["--api", api.url, "--root", root]);
    assert.match((await run("fetch", ["--api", api.url, "--root", root, "--recheck", "all"])).stdout, /rechecked 2 held days against the API: unchanged/);
    routes["/forecasts/records/2026-10-22.jsonl"] = (await recordsOf("tampered-line"))["2026-10-22.jsonl"];
    assert.match((await run("fetch", ["--api", api.url, "--root", root])).stdout, /^up to date/);
    assert.match((await run("fetch", ["--api", api.url, "--root", root, "--recheck", "1"])).stdout, /rechecked 1 held day against the API: unchanged/);
    let stderr = await refused(run("fetch", ["--api", api.url, "--root", root, "--recheck", "2"]));
    assert.match(stderr, /^FAIL the API now serves records\/2026-10-22\.jsonl/);
    stderr = await refused(run("fetch", ["--api", api.url, "--root", root, "--recheck", "all"]));
    assert.match(stderr, /^FAIL the API now serves records\/2026-10-22\.jsonl with sha256 [0-9a-f]{64}, but this copy holds sha256 [0-9a-f]{64}; a closed record never changes/);
  });
});

test("fetch completes a day that a stopped run left half written", async () => {
  const files = await recordsOf("valid");
  await withApi(recordRoutes(files), async (api) => {
    const root = await temp();
    await mkdir(join(root, "records"));
    await writeFile(join(root, "records", "2026-10-22.jsonl"), files["2026-10-22.jsonl"]);
    await writeFile(join(root, "records", ".2026-10-22.json.4242.tmp"), "{");
    const out = await run("fetch", ["--api", api.url, "--root", root]);
    assert.match(out.stdout, /added 2026-10-22[\s\S]*added 2026-10-23/);
    assert.deepEqual((await readdir(join(root, "records"))).sort(), [
      "2026-10-22.json",
      "2026-10-22.jsonl",
      "2026-10-23.json",
      "2026-10-23.jsonl",
      "index.json",
    ]);
    assert.match((await run("verify", ["--root", root])).stdout, /verified 2 days/);

    const other = await temp();
    await mkdir(join(other, "records"));
    await writeFile(join(other, "records", "2026-10-22.jsonl"), (await recordsOf("tampered-line"))["2026-10-22.jsonl"]);
    const stderr = await refused(run("fetch", ["--api", api.url, "--root", other]));
    assert.match(stderr, /^FAIL the API now serves records\/2026-10-22\.jsonl with sha256/);
  });
});

test("fetch writes nothing when a fetched day fails verify", async () => {
  await withApi(recordRoutes(await recordsOf("tampered-line")), async (api) => {
    const root = await temp();
    const stderr = await refused(run("fetch", ["--api", api.url, "--root", root]));
    assert.match(stderr, /^FAIL 2026-10-22, lines 1, 2, 3: batch 1's signature recovers to .*; nothing was written/);
    await assert.rejects(readdir(join(root, "records")), { code: "ENOENT" });
  });
});

test("fetch --recheck takes a number of days or all", async () => {
  await assert.rejects(run("fetch", ["--root", await temp(), "--recheck", "0"]), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /usage: fetch\.mjs .*--recheck <days>\|all/);
    return true;
  });
});

test("fetch refuses a day that is not a date", async () => {
  await withApi({ "/forecasts/records": JSON.stringify({ days: [{ day: "../../etc" }] }) }, async (api) => {
    const stderr = await refused(run("fetch", ["--api", api.url, "--root", await temp()]));
    assert.match(stderr, /lists "\.\.\/\.\.\/etc", which is not a day; nothing was written/);
  });
});

test("fetch bounds what it reads", async () => {
  const routes = recordRoutes(await recordsOf("valid"));
  routes["/forecasts/records/2026-10-22.json"] = " ".repeat(70 * 1024);
  await withApi(routes, async (api) => {
    const stderr = await refused(run("fetch", ["--api", api.url, "--root", await temp()]));
    assert.match(stderr, /2026-10-22\.json sent (more than 65536|71680) bytes/);
  });
});

test("text the server sends shows only JSON-quoted in errors", async () => {
  await withApi({ "/forecasts/records": () => [404, "\n::warning::not ours\n"] }, async (api) => {
    const stderr = await refused(run("fetch", ["--api", api.url, "--root", await temp()]));
    assert.match(stderr, /answered 404: "\\n::warning::not ours\\n"/);
  });
  const files = await recordsOf("valid");
  const routes = recordRoutes(files);
  routes["/forecasts/records/2026-10-22.jsonl"] = Buffer.from("::error::not ours\n");
  await withApi(routes, async (api) => {
    const stderr = await refused(run("fetch", ["--api", api.url, "--root", await temp()]));
    assert.match(stderr, /^FAIL 2026-10-22, line 1: is not JSON \(".*::error::not ours.*"\)/);
  });
});

describe("score", () => {
  let hl;
  let asked;
  let settlements;
  const raw = new Map();
  let root;

  before(async () => {
    settlements = JSON.parse(await readFile(join(fixtures, "scoring", "settlements.json"), "utf8"));
    asked = [];
    hl = await serve({
      "/info": (_url, body) => {
        const { type, outcome } = JSON.parse(body);
        assert.equal(type, "settledOutcome");
        asked.push(outcome);
        if (raw.has(outcome)) return [200, JSON.stringify(raw.get(outcome))];
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

  const score = (...args) => run("score", ["--root", root, "--hl", `${hl.url}/info`, ...args]);

  test("score asks about each outcome, then again about those in the newest records", async () => {
    const want = await readFile(join(fixtures, "scoring", "board.json"), "utf8");
    let out = await score();
    assert.match(out.stdout, /asked Hyperliquid about 58 outcomes: 56 newly settled, 0 confirmed, 2 not yet/);
    assert.equal(asked.length, 58);
    assert.equal(await readFile(join(root, "board.json"), "utf8"), want);
    assert.equal(
      await readFile(join(root, "settlements.json"), "utf8"),
      await readFile(join(fixtures, "scoring", "settlements.json"), "utf8"),
    );

    // Both records are among the newest three, so every outcome is asked again.
    asked.length = 0;
    out = await score();
    assert.match(out.stdout, /asked Hyperliquid about 58 outcomes: 0 newly settled, 56 confirmed, 2 not yet/);

    asked.length = 0;
    await score("--offline");
    assert.deepEqual(asked, []);
    assert.equal(await readFile(join(root, "board.json"), "utf8"), want);
  });

  test("score stops when Hyperliquid changes an answer it gave", async () => {
    const was = settlements[1000];
    settlements[1000] = was === "1.0" ? "0.0" : "1.0";
    try {
      let stderr = await refused(score());
      assert.match(stderr, /^FAIL settlements.json has outcome 1000 settled at "[01]\.0"; Hyperliquid now answers "[01]\.0"/);
      stderr = await refused(score("--refetch"));
      assert.match(stderr, /outcome 1000 settled at/);
    } finally {
      settlements[1000] = was;
    }
  });

  test("score refuses an answer for another outcome", async () => {
    try {
      raw.set(1058, { spec: { outcome: 9 }, settleFraction: "1.0" });
      assert.match(await refused(score()), /^FAIL settledOutcome 1058 answered for outcome 9/);
      raw.set(1058, { settleFraction: "1.0" });
      assert.match(await refused(score()), /^FAIL settledOutcome 1058 answered for outcome undefined/);
    } finally {
      raw.delete(1058);
    }
  });

  test("score leaves an answer outside 0, 1 or a decimal between them unsettled", async () => {
    try {
      for (const odd of [" 1.0", "1.", "1.5", "0.5e0"]) {
        raw.set(1058, { spec: { outcome: 1058 }, settleFraction: odd });
        const out = await score();
        assert.ok(out.stderr.includes(`outcome 1058: settleFraction ${JSON.stringify(odd)} is not 0, 1`), out.stderr);
        assert.equal(JSON.parse(await readFile(join(root, "settlements.json"), "utf8"))[1058], undefined);
      }
    } finally {
      raw.delete(1058);
    }
  });

  test("score --compare checks every page byte for byte; exit 3 when only the settlements differ", async () => {
    await score("--offline");
    const known = JSON.parse(await readFile(join(fixtures, "scoring", "board.json"), "utf8"));
    let served = known;
    const pages = [];
    const routes = {
      "/forecasts/board": (url) => {
        const limit = Number(url.searchParams.get("limit"));
        const offset = Number(url.searchParams.get("offset"));
        pages.push([limit, offset]);
        return [200, JSON.stringify({ ...served, rows: served.rows.slice(offset, offset + limit) })];
      },
    };
    await withApi(routes, async (api) => {
      const compare = (url = api.url) => score("--offline", "--compare", url);
      const out = await compare();
      assert.match(out.stdout, /page offset=0: 6 rows, \d+ bytes, identical/);
      assert.deepEqual(pages, [[200, 0]]);

      served = { ...known, asOf: "2026-10-24T00:07:12.345Z" };
      let stderr = await refused(compare());
      assert.match(stderr, /asOf: api "2026-10-24T00:07:12\.345Z", rebuilt "2026-10-24T00:05:00\.388Z"/);

      served = { ...known, rows: known.rows.map((r, i) => (i === 1 ? { ...r, skillFair: r.skillFair + 0.000001 } : r)) };
      stderr = await refused(compare(`${api.url}/forecasts/board`));
      assert.match(stderr, /rows\[1\]\.skillFair: api [-\d.]+, rebuilt [-\d.]+/);
      assert.match(stderr, /FAIL the rebuilt board differs/);

      served = { ...served, settled: known.settled + 1, settlementsRoot: "ab".repeat(32) };
      stderr = await refused(compare(), 3);
      assert.ok(
        stderr.includes(
          `the API scored 57 settlements (settlementsRoot "${"ab".repeat(32)}"); this rebuild scored 56 (settlementsRoot "${known.settlementsRoot}"). The boards were built from different settlements.`,
        ),
        stderr,
      );
      assert.doesNotMatch(stderr, /rows\[/);

      served = Object.fromEntries(Object.entries(known).reverse());
      stderr = await refused(compare());
      assert.match(stderr, /same values, different bytes at character \d+/);

      served = { ...known, "\n::error::x": 1 };
      stderr = await refused(compare());
      assert.match(stderr, /\["\\n::error::x"\]: api 1, rebuilt undefined/);
    });
  });
});
