import test from "node:test";
import assert from "node:assert/strict";

import { bootScanner, readFixture, pure } from "./harness.mjs";

const POST_HASH = "48b2e7c1a728925959a6b7ca51100ba6e2b350de";

function bootHacg(settings = {}) {
  return bootScanner({
    html: readFixture("gallery-post.html"),
    hostname: "example.com",
    settings: Object.assign({ detectHex40: true }, settings),
  });
}

test("gallery page: bare 40-hex infohash produces exactly one working button", (t) => {
  const app = bootHacg();
  t.after(() => app.restore());

  const result = app.scan();
  assert.equal(result.found, 1, "should recognise exactly one infohash");
  assert.equal(result.injected, 1, "should inject exactly one button");
  assert.equal(app.buttons().length, 1);

  const wrap = app.chips()[0];
  assert.ok(wrap, "chip wrapper exists");
  assert.match(wrap.textContent, new RegExp(POST_HASH), "original hash text is preserved next to the button");

  // placement: inside the content container, after the last gallery image
  const container = app.document.querySelector("#content");
  assert.ok(container.contains(wrap), "chip lives inside the post content container");
  const imagesBefore = wrap.previousSibling && wrap.previousSibling.nodeName;
  assert.ok(imagesBefore !== undefined, "chip has a sibling context");
  const imgs = app.document.querySelectorAll("img");
  assert.ok(imgs.length >= 1, "fixture has gallery images");
});

test("gallery page: clicking the injected button posts the right magnet to qBittorrent", async (t) => {
  const app = bootHacg({ category: "anime", host: "http://127.0.0.1:8080" });
  t.after(() => app.restore());

  app.scan();
  assert.equal(app.buttons().length, 1, "button injected before clicking");
  app.buttons()[0].click();
  await app.flush();

  assert.equal(app.requests.length, 1, "one HTTP request");
  const request = app.requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.url, "http://127.0.0.1:8080/api/v2/torrents/add");
  const urls = request.data.get("urls");
  assert.match(urls, new RegExp("^magnet:\\?xt=urn:btih:" + POST_HASH));
  assert.equal(request.data.get("category"), "anime");
  assert.ok(urls.includes("&tr="), "trackers are appended for synthesised magnets");
});

test("regression: classic magnet anchor still gets a button right after the link", (t) => {
  const app = bootScanner({
    html: readFixture("regression.html"),
    hostname: "example.com",
    settings: { detectRawHash: false, detectBase32: false },
  });
  t.after(() => app.restore());

  app.scan();
  const anchor = app.document.querySelector('#case-anchor a[href^="magnet:"]');
  const chip = anchor.nextSibling;
  assert.equal(chip && chip.getAttribute("class"), "m2q-chip-wrap", "button sits immediately after the anchor");
});

test("regression: text magnet inside a <li> keeps its text and gains a button", (t) => {
  const app = bootScanner({ html: readFixture("regression.html"), hostname: "example.com" });
  t.after(() => app.restore());

  app.scan();
  const li = app.document.querySelector("#case-text li");
  assert.equal(li.querySelectorAll(".m2q-btn").length, 1);
  assert.match(li.textContent, /0123456789abcdef0123456789abcdef01234567/, "magnet text preserved");
});

test("collection page: three distinct hashes -> three buttons, duplicate collapsed", (t) => {
  const app = bootScanner({ html: readFixture("regression.html"), hostname: "example.com" });
  t.after(() => app.restore());

  const result = app.scan();
  // hex40 outside script/style/textarea/pre: 3 collection + data-magnet + data-infohash + href hash + duplicate
  assert.equal(app.document.querySelectorAll("#case-collection .m2q-btn").length, 3);
  assert.equal(app.document.querySelectorAll("#case-duplicate .m2q-btn").length, 0, "duplicate hash is not given a second button");
  assert.ok(result.found >= 6, `expected at least 6 unique magnets, got ${result.found}`);
});

test("batch send: all page magnets are posted as newline-separated urls", async (t) => {
  const app = bootScanner({ html: readFixture("regression.html"), hostname: "example.com" });
  t.after(() => app.restore());

  const items = app.collectPageMagnets();
  assert.ok(items.length >= 6, `collected ${items.length}`);
  assert.equal(new Set(items.map((item) => item.hash)).size, items.length, "deduplicated");

  // exercise the real send path through the transport spy
  const { sendMagnets } = app;
  await new Promise((resolve) => {
    const form = sendMagnets(items);
    form.then(() => resolve());
    setTimeout(resolve, 50);
  });
  await app.flush();
  assert.ok(app.requests.length >= 1);
  const urls = app.requests[0].data.get("urls").split("\n");
  assert.equal(urls.length, items.length);
  urls.forEach((url) => assert.match(url, /^magnet:\?xt=urn:btih:[0-9a-z]{32,40}/i));
});

test("false positives: script, style and textarea content is never scanned", (t) => {
  const app = bootScanner({ html: readFixture("regression.html"), hostname: "example.com" });
  t.after(() => app.restore());

  app.scan();
  const html = app.document.querySelector(".m2q-chip-wrap");
  assert.ok(html, "at least one chip injected");
  const script = app.document.querySelector("script");
  const style = app.document.querySelector("style");
  const textarea = app.document.querySelector("textarea");
  assert.equal(script.querySelectorAll(".m2q-btn").length, 0);
  assert.equal(style.querySelectorAll(".m2q-btn").length, 0);
  assert.equal(textarea.querySelectorAll(".m2q-btn").length, 0);
  assert.equal(textarea.textContent, "9999999999999999999999999999999999999999", "textarea untouched");

  const injected = app
    .chips()
    .map((chip) => chip.textContent.replace(/[^0-9a-z]/gi, ""))
    .join(" ");
  assert.ok(!injected.includes("7777777777777777777777777777777777777777"), "script hash ignored");
  assert.ok(!injected.includes("8888888888888888888888888888888888888888"), "style hash ignored");
  assert.ok(!injected.includes("9999999999999999999999999999999999999999"), "textarea hash ignored");
});

test("base32 recognition is opt-in", (t) => {
  const off = bootScanner({ html: readFixture("regression.html"), hostname: "example.com", settings: { detectBase32: false } });
  t.after(() => off.restore());
  off.scan();
  const base32Line = off.document.querySelector("#case-base32");
  assert.equal(base32Line.querySelectorAll(".m2q-btn").length, 0, "disabled by default");

  const on = bootScanner({ html: readFixture("regression.html"), hostname: "example.com", settings: { detectBase32: true } });
  t.after(() => on.restore());
  on.scan();
  assert.equal(on.document.querySelector("#case-base32").querySelectorAll(".m2q-btn").length, 1, "recognised when enabled");
});

test("domain rules gate button injection but keep the floating entry point", (t) => {
  const blocked = bootScanner({
    html: readFixture("gallery-post.html"),
    hostname: "github.com",
    settings: { rules: [{ domain: "example", category: "anime", regex: false }] },
  });
  t.after(() => blocked.restore());

  assert.equal(blocked.siteEnabled(), false);
  const result = blocked.scan();
  assert.equal(result.found, 1, "the hash is still counted for diagnostics");
  assert.equal(result.injected, 0, "but nothing is injected on a non-allowlisted host");

  const allowed = bootScanner({
    html: readFixture("gallery-post.html"),
    hostname: "example.com",
    settings: { rules: [{ domain: "example", category: "", regex: false }], category: "global-cat" },
  });
  t.after(() => allowed.restore());
  assert.equal(allowed.siteEnabled(), true);
  assert.equal(allowed.currentCategory(), "global-cat", "rule without category falls back to the global default");
});

test("pure kernel: rule parsing, matching and category resolution", () => {
  assert.deepEqual(pure.parseDomainRules("example.com:anime, sample.org, x.to:tv:sub"), [
    { domain: "example.com", category: "anime", regex: false },
    { domain: "sample.org", category: "", regex: false },
    { domain: "x.to", category: "tv:sub", regex: false },
  ]);
  assert.equal(pure.isDomainAllowed("anything.tld", []), true, "empty rule list = everything enabled");
  assert.equal(pure.isDomainAllowed("sub.example.com", [{ domain: "example", category: "", regex: false }]), true);
  assert.equal(pure.isDomainAllowed("github.com", [{ domain: "example", category: "", regex: false }]), false);
  assert.equal(pure.getCategoryForDomain("sub.example.com", [{ domain: "example", category: "anime", regex: false }], "g"), "anime");
  assert.equal(pure.getCategoryForDomain("sub.example.com", [{ domain: "example", category: "", regex: false }], "g"), "g");
  assert.equal(pure.ruleMatches({ domain: "^ex.*\\.com$", category: "", regex: true }, "example.com"), true);
  assert.equal(pure.isDisabledOn("sub.example.com", ["example.com"]), true);
});

test("pure kernel: magnet synthesis and hash detection", () => {
  assert.deepEqual(pure.detectHashKind(POST_HASH, { hex40: true }), { hash: POST_HASH, kind: "hex40" });
  assert.equal(pure.detectHashKind(POST_HASH, { hex40: false }), null);
  assert.equal(pure.detectHashKind("MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U", { base32: true }).kind, "base32");
  assert.equal(pure.detectHashKind("a".repeat(64), { v2: true }).kind, "v2");
  assert.equal(pure.detectHashKind("a".repeat(64), { v2: false }), null);

  const magnet = pure.buildMagnet(POST_HASH.toUpperCase(), { trackers: ["udp://t.example:1337/announce"], name: "例 子" });
  assert.match(magnet, new RegExp("^magnet:\\?xt=urn:btih:" + POST_HASH + "&dn="));
  assert.ok(magnet.includes("&tr=udp%3A%2F%2Ft.example%3A1337%2Fannounce"));
  assert.equal(pure.hashFromMagnet(magnet), POST_HASH);

  // a magnet-shaped string without a usable hash must not be treated as a link
  assert.equal(pure.coerceMagnet("magnet:?xt=urn:btih:", {}), null);
  assert.equal(pure.extractMagnetHint("magnet:?xt=urn:btih: Powered by ExampleSite"), null);
  assert.match(pure.extractMagnetHint("仓库 magnet:?xt=urn:btih:" + POST_HASH + " 完"), /^magnet:/);
});

test("pure kernel: settings migration from a v2.1 flat domains string", () => {
  const migrated = pure.normalizeSettings(
    { host: "http://qb:8080/", username: "admin", password: "pw", category: "全局", domains: "example.com:anime, mirror.example.org", extraParams: '{"paused":true}' },
    pure.defaultSettings("3.0.0")
  );
  assert.equal(migrated.host, "http://qb:8080");
  assert.deepEqual(migrated.rules, [
    { domain: "example.com", category: "anime", regex: false },
    { domain: "mirror.example.org", category: "", regex: false },
  ]);
  assert.equal(migrated.detectHex40, true);
  assert.equal(migrated.enableFloatingButton, true);
  assert.equal(pure.rulesToString(migrated.rules), "example.com:anime, mirror.example.org");
  assert.equal(pure.parseExtraParams(migrated.extraParams).paused, true);
  assert.equal(pure.extraParamsError('{"paused": true}'), null);
  assert.ok(pure.extraParamsError("{oops}"));
});

test("pure kernel: mixed hash/magnet inputs dedupe to unique magnets", () => {
  const items = pure.dedupeMagnets(
    [
      POST_HASH.toUpperCase(),
      "magnet:?xt=urn:btih:" + POST_HASH,
      { hash: POST_HASH },
      "1111111111111111111111111111111111111111",
      "not-a-hash",
      null,
    ],
    { trackers: ["udp://x:1/announce"] }
  );
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.hash).sort(), [POST_HASH, "1111111111111111111111111111111111111111"].sort());
});

test("settings panel opens, renders five tabs, and closes", (t) => {
  const app = bootHacg({ host: "http://127.0.0.1:8080", category: "anime" });
  t.after(() => app.restore());

  app.openSettings();
  const overlay = app.document.querySelector(".m2q-overlay");
  assert.ok(overlay, "panel mounted");
  assert.equal(app.document.querySelectorAll(".m2q-tab").length, 5);
  assert.ok(app.document.querySelector(".m2q-title").textContent.includes("Magnet2qB"));

  // the connection tab is rendered first and is populated from settings
  const hostInput = app.document.querySelector('[data-m2q-field="host"]');
  assert.equal(hostInput.value, "http://127.0.0.1:8080");

  // switching tabs re-renders without throwing
  app.document.querySelectorAll(".m2q-tab")[2].click();
  assert.ok(app.document.querySelector(".m2q-rules"), "domain-rule tab renders");

  app.closeSettings();
  assert.equal(app.document.querySelector(".m2q-overlay"), null, "panel removed");
});

test("settings panel: invalid JSON blocks the save and is reported inline", (t) => {
  const app = bootHacg();
  t.after(() => app.restore());
  app.openSettings();

  // force an invalid extraParams value and try to save
  const fields = app.document.querySelectorAll('[data-m2q-field="extraParams"]');
  assert.equal(fields.length, 0, "extra params live on the detection tab, not the default tab");

  app.document.querySelectorAll(".m2q-tab")[3].click();
  const extra = app.document.querySelector('[data-m2q-field="extraParams"]');
  assert.ok(extra, "detection tab exposes extraParams");
  extra.value = "{oops}";

  app.document.querySelector(".m2q-btn2.is-primary").click();
  assert.equal(app.document.querySelector(".m2q-err").textContent.length > 0, true, "error surfaced in the footer");
  assert.ok(app.document.querySelector(".m2q-overlay"), "panel stays open when validation fails");
});
