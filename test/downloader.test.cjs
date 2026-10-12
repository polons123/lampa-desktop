const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lampa-dl-"));
const sent = [];
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron")
    return {
      app: { getPath: () => home, on() {} },
      shell: { showItemInFolder() {}, openPath: async () => "" },
    };
  return load.call(this, request, ...rest);
};
const downloader = require("../src/modules/downloader");
Module._load = load;
downloader.init(() => ({
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: (_c, job) => sent.push(job) },
}));

const body = Buffer.alloc(300000, "film");
let server;
let base;
let dropOnce = true;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith("/flaky")) {
      // First request: send half and cut the connection; then honour Range.
      const range = /bytes=(\d+)-/.exec(req.headers.range || "");
      const from = range ? Number(range[1]) : 0;
      res.writeHead(range ? 206 : 200, {
        "content-type": "video/x-matroska",
        "content-length": body.length - from,
        ...(range && {
          "content-range": `bytes ${from}-${body.length - 1}/${body.length}`,
        }),
      });
      if (req.method === "HEAD") return res.end();
      if (dropOnce && !range) {
        dropOnce = false;
        res.write(body.subarray(0, 100000));
        return setTimeout(() => req.socket.destroy(), 50);
      }
      return res.end(body.subarray(from));
    }
    if (req.url.startsWith("/missing")) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function finished(id) {
  for (let i = 0; i < 100; i++) {
    const job = downloader.list().find((item) => item.id === id);
    if (["done", "error", "canceled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("download did not finish");
}

test("file names are cleaned and extensions chosen", () => {
  assert.equal(downloader.sanitizeName('A/B: "C"?*'), "A B C");
  assert.equal(downloader.sanitizeName("..."), "Lampa");
  assert.equal(downloader.sanitizeName(""), "Lampa");
  assert.equal(downloader.extensionFor("http://x/a.MP4?x=1", ""), "mp4");
  assert.equal(
    downloader.extensionFor("http://x/stream", "video/x-matroska"),
    "mkv",
  );
  assert.equal(downloader.extensionFor("http://x/stream.exe", ""), "mkv");
});

test("headers are filtered", () => {
  assert.deepEqual(
    downloader.safeHeaders({
      Referer: "http://a",
      Range: "bytes=1-",
      "Bad Name": "x",
      Cookie: "a=b\r\nX: y",
      "User-Agent": "ua",
    }),
    { Referer: "http://a", "User-Agent": "ua" },
  );
});

test("only http(s) links are accepted", () => {
  assert.equal(
    downloader.start({ url: "file:///etc/passwd", title: "x" }).ok,
    false,
  );
  assert.equal(downloader.start({ url: "javascript:1", title: "x" }).ok, false);
});

test("a plain file is saved under ~/Movies/Lampa", async () => {
  const { id } = downloader.start({
    tool: "curl",
    url: `${base}/film`,
    title: "Фильм/Тест (2020)",
  });
  const job = await finished(id);
  assert.equal(job.status, "done", job.error);
  assert.equal(job.file, "Фильм Тест (2020).mkv");
  const file = path.join(home, "Movies", "Lampa", job.file);
  assert.equal(fs.statSync(file).size, body.length);
  assert.equal(fs.existsSync(file + ".part"), false);
  assert.ok(sent.some((item) => item.id === id && item.status === "done"));
});

test("a second download of the same title gets a new name", async () => {
  const { id } = downloader.start({
    tool: "curl",
    url: `${base}/film?again=1`,
    title: "Фильм/Тест (2020)",
  });
  const job = await finished(id);
  assert.equal(job.file, "Фильм Тест (2020) (2).mkv");
});

test("curl resumes a dropped connection", async () => {
  const { id } = downloader.start({
    tool: "curl",
    url: `${base}/flaky`,
    title: "Flaky",
  });
  const job = await finished(id);
  assert.equal(job.status, "done", job.error);
  const data = fs.readFileSync(path.join(home, "Movies", "Lampa", job.file));
  assert.ok(data.equals(body));
});

test("a 404 fails at once and leaves nothing behind", async () => {
  const { id } = downloader.start({
    tool: "curl",
    url: `${base}/missing`,
    title: "Nope",
  });
  const job = await finished(id);
  assert.equal(job.status, "error");
  assert.match(job.error, /404/);
  assert.equal(
    fs.existsSync(path.join(home, "Movies", "Lampa", "Nope.mkv.part")),
    false,
  );
});

test("a finished entry can be removed, the file stays", async () => {
  const done = downloader.list().find((job) => job.status === "done");
  assert.equal(downloader.remove(done.id), true);
  assert.equal(
    downloader.list().some((job) => job.id === done.id),
    false,
  );
  assert.ok(fs.existsSync(path.join(home, "Movies", "Lampa", done.file)));
});

// External programs (skipped when not installed).
const tools = Object.fromEntries(
  downloader.tools().all.map((tool) => [tool.id, tool.available]),
);

test(
  "curl downloads a file with a known size",
  { skip: !tools.curl },
  async () => {
    const { id } = downloader.start({
      tool: "curl",
      url: `${base}/curl-film.mp4`,
      title: "Curl Film",
    });
    const job = await finished(id);
    assert.equal(job.status, "done", job.error);
    assert.equal(job.file, "Curl Film.mp4");
    const file = path.join(home, "Movies", "Lampa", job.file);
    assert.equal(fs.statSync(file).size, body.length);
    assert.equal(fs.existsSync(file + ".part"), false);
  },
);

test("curl reports an HTTP error", { skip: !tools.curl }, async () => {
  const { id } = downloader.start({
    tool: "curl",
    url: `${base}/missing`,
    title: "Curl Nope",
  });
  const job = await finished(id);
  assert.equal(job.status, "error");
  assert.match(job.error, /404/);
});

test("yt-dlp downloads a direct file", { skip: !tools["yt-dlp"] }, async () => {
  const { id } = downloader.start({
    tool: "yt-dlp",
    url: `${base}/direct.mp4`,
    title: "Ytdlp Film",
  });
  const job = await finished(id);
  assert.equal(job.status, "done", job.error);
  assert.match(job.file, /^Ytdlp Film\.\w+$/);
  const file = path.join(home, "Movies", "Lampa", job.file);
  assert.equal(fs.statSync(file).size, body.length);
});

test("an unknown tool is refused", () => {
  const result = downloader.start({ tool: "rm", url: `${base}/x`, title: "x" });
  assert.equal(result.ok, false);
});
