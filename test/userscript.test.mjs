/**
 * End-to-end smoke tests for the REAL browser code path.
 *
 * scan.test.mjs instantiates the scanner block directly. This file instead loads
 * the whole userscript the way a userscript manager does -- as an IIFE with GM_*
 * globals present -- and drives init() through DOMContentLoaded. It exists to
 * catch integration bugs (missing globals, bad bindings, load-time crashes) that
 * block-level tests cannot see.
 */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { SCRIPT_SOURCE, readFixture, bgTimeout } from "./harness.mjs";
import { createDocument } from "./minidom.mjs";

const POST_HASH = "48b2e7c1a728925959a6b7ca51100ba6e2b350de";
const STORE_KEY = "magnet2qb_settings";

function makeSandbox(options = {}) {
  const document = createDocument(options.html || readFixture("gallery-post.html"));
  document.readyState = "loading";
  const store = new Map();
  if (options.stored) store.set(STORE_KEY, JSON.stringify(options.stored));

  const requests = [];
  const windowListeners = new Map();
  const window = {
    setTimeout: bgTimeout,
    clearTimeout: (id) => clearTimeout(id),
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, handler) {
      (windowListeners.get(type) || windowListeners.set(type, []).get(type)).push(handler);
    },
    removeEventListener() {},
    getComputedStyle: () => ({ display: "block" }),
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    console,
  };

  const sandbox = {
    document,
    window,
    location: { href: `https://${options.hostname || "example.com"}/post/1`, hostname: options.hostname || "example.com" },
    NodeFilter: { SHOW_TEXT: 4 },
    console: { log() {}, warn() {}, info() {}, error() {} },
    setTimeout: bgTimeout,
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    MutationObserver: undefined,
    FormData,
    encodeURIComponent,
    decodeURIComponent,
    btoa,
    fetch: undefined,
    navigator: { userAgent: "node-test", clipboard: null },
    GM_getValue: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    GM_setValue: (key, value) => store.set(key, String(value)),
    GM_registerMenuCommand: (name) => {
      (sandbox.__menu = sandbox.__menu || []).push(name);
    },
    GM_xmlhttpRequest: (details) => {
      requests.push(details);
      bgTimeout(() => details.onload && details.onload({ status: 200, responseText: "Ok." }), 0);
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  return { sandbox, document, requests, store, window, windowListeners };
}

function runUserscript(sandbox) {
  vm.runInContext(SCRIPT_SOURCE, sandbox, { filename: "Magnet_to_qBittorrent.js" });
}

function settled(ms = 160) {
  return new Promise((resolve) => bgTimeout(resolve, ms));
}

function stored(sandbox) {
  return JSON.parse(sandbox.GM_getValue(STORE_KEY, "{}"));
}

test("userscript loads and initialises without touching a missing global", async () => {
  const { sandbox, document } = makeSandbox();
  runUserscript(sandbox);
  assert.equal(document.querySelectorAll(".m2q-float").length, 0, "nothing injected before DOM is ready");

  document.dispatchEvent({ type: "DOMContentLoaded" });
  await settled(140);

  assert.equal(document.querySelectorAll(".m2q-float").length, 1, "floating settings entry point mounted");
  assert.ok(sandbox.__menu && sandbox.__menu.length >= 1, "GM_registerMenuCommand entry points registered");
});

test("userscript injects a button for the bare hash end to end", async () => {
  const { sandbox, document, requests } = makeSandbox({ hostname: "example.com" });
  runUserscript(sandbox);
  document.dispatchEvent({ type: "DOMContentLoaded" });
  await settled();

  const buttons = document.querySelectorAll(".m2q-btn");
  assert.equal(buttons.length, 1, "exactly one button for the bare infohash");
  assert.equal(buttons[0].textContent, "📥 qB");
  assert.match(document.querySelector("#content").textContent, new RegExp(POST_HASH), "hash text kept");

  buttons[0].click();
  await settled(60);
  assert.equal(requests.length, 1, "one add request");
  assert.equal(requests[0].url, "http://localhost:8080/api/v2/torrents/add");
  assert.match(requests[0].data.get("urls"), new RegExp("^magnet:\\?xt=urn:btih:" + POST_HASH));
});

test("stored settings from a v2.1 install are honoured (host + domain category)", async () => {
  const { sandbox, document, requests } = makeSandbox({
    hostname: "example.com",
    stored: {
      host: "http://192.168.1.9:8080/",
      username: "admin",
      password: "secret",
      category: "global",
      domains: "example.com:anime, mirror.example.org",
      extraParams: '{"paused":true}',
    },
  });
  runUserscript(sandbox);
  document.dispatchEvent({ type: "DOMContentLoaded" });
  await settled();

  document.querySelectorAll(".m2q-btn")[0].click();
  await settled(60);

  const request = requests[0];
  assert.equal(request.url, "http://192.168.1.9:8080/api/v2/torrents/add", "trailing slash trimmed");
  assert.equal(request.data.get("category"), "anime", "per-domain category wins over the global one");
  assert.equal(request.data.get("paused"), "true", "extra params forwarded");
  assert.equal(request.headers.Authorization, "Basic " + btoa("admin:secret"));

  const saved = stored(sandbox);
  assert.equal(saved.schema, 3, "settings were migrated in place");
  assert.deepEqual(saved.rules, [
    { domain: "example.com", category: "anime", regex: false },
    { domain: "mirror.example.org", category: "", regex: false },
  ]);
});

test("collection page: badge counts every hash and sends them in one request", async () => {
  const { sandbox, document, requests } = makeSandbox({ html: readFixture("regression.html"), hostname: "example.com" });
  runUserscript(sandbox);
  document.dispatchEvent({ type: "DOMContentLoaded" });
  await settled();

  const badge = document.querySelector(".m2q-badge");
  assert.ok(badge, "batch badge shown when the page has more than one magnet");
  assert.equal(badge.textContent, "⚡ 8", "badge counts every unique hash on the page");
  assert.equal(document.querySelectorAll(".m2q-btn").length, 8, "every unique hash has its own button");

  badge.click();
  await settled(80);

  assert.equal(requests.length, 1, "one request for the whole batch");
  const urls = requests[0].data.get("urls").split("\n");
  assert.equal(urls.length, 8, "all eight magnets travel together");
  assert.equal(new Set(urls.map((url) => url.toLowerCase())).size, urls.length, "no duplicate hash in the batch");
  urls.forEach((url) => assert.match(url, /^magnet:\?xt=urn:btih:[0-9a-z]{32,40}/i));
});

test("settings panel opens from the floating menu and saves through the real form", async () => {
  const { sandbox, document } = makeSandbox();
  runUserscript(sandbox);
  document.dispatchEvent({ type: "DOMContentLoaded" });
  await settled();

  document.querySelector(".m2q-float").click();
  const openItem = document.querySelectorAll(".m2q-menu-item")[0];
  assert.equal(openItem.textContent, "⚙ 打开设置");
  openItem.click();

  assert.ok(document.querySelector(".m2q-panel"), "panel rendered");
  assert.equal(document.querySelectorAll(".m2q-tab").length, 5, "five tabs");

  document.querySelector('[data-m2q-field="host"]').value = "http://qb.local:9000/";
  document.querySelector(".m2q-btn2.is-primary").click();

  const saved = stored(sandbox);
  assert.equal(saved.host, "http://qb.local:9000", "saved value normalised");
  assert.equal(document.querySelector(".m2q-panel"), null, "panel closed after save");
});

test("settings panel blocks an invalid extra-params JSON instead of silently resetting", async () => {
  const { sandbox, document } = makeSandbox();
  runUserscript(sandbox);
  document.dispatchEvent({ type: "DOMContentLoaded" });
  await settled();

  document.querySelector(".m2q-float").click();
  document.querySelectorAll(".m2q-menu-item")[0].click();
  document.querySelectorAll(".m2q-tab")[3].click();

  document.querySelector('[data-m2q-field="extraParams"]').value = "{oops}";
  document.querySelector(".m2q-btn2.is-primary").click();

  assert.ok(document.querySelector(".m2q-panel"), "panel stays open when validation fails");
  assert.match(document.querySelector(".m2q-err").textContent, /JSON 错误/, "error is reported inline");
  assert.equal(stored(sandbox).extraParams, "{}", "invalid value was not persisted");
});

test("edits survive switching tabs before saving", async () => {
  const { sandbox, document } = makeSandbox();
  runUserscript(sandbox);
  document.dispatchEvent({ type: "DOMContentLoaded" });
  await settled();

  document.querySelector(".m2q-float").click();
  document.querySelectorAll(".m2q-menu-item")[0].click();

  // type on the connection tab...
  const host = document.querySelector('[data-m2q-field="host"]');
  host.value = "http://192.168.1.50:8080";
  // ...then wander to another tab and come back, editing a field there too
  document.querySelectorAll(".m2q-tab")[3].click();
  const trackers = document.querySelector('[data-m2q-field="trackers"]');
  trackers.value = "udp://only.example:1337/announce";
  document.querySelectorAll(".m2q-tab")[0].click();
  assert.equal(document.querySelector('[data-m2q-field="host"]').value, "http://192.168.1.50:8080", "connection tab kept its edit");

  document.querySelector(".m2q-btn2.is-primary").click();

  const saved = stored(sandbox);
  assert.equal(saved.host, "http://192.168.1.50:8080", "host saved from the draft");
  assert.deepEqual(saved.trackers, ["udp://only.example:1337/announce"], "other tab's edit saved too");
});

test("rescanning the page never stacks a second button on the same hash", async () => {
  const { sandbox, document } = makeSandbox({ html: readFixture("regression.html"), hostname: "example.com" });
  runUserscript(sandbox);
  document.dispatchEvent({ type: "DOMContentLoaded" });
  await settled();

  assert.equal(document.querySelectorAll(".m2q-btn").length, 8, "one button per hash after init");
  const badge = document.querySelector(".m2q-badge").textContent;

  document.querySelector(".m2q-float").click();
  const rescan = Array.from(document.querySelectorAll(".m2q-menu-item")).find((item) => item.textContent.includes("重新扫描"));
  rescan.click();
  await settled(320);

  assert.equal(document.querySelectorAll(".m2q-btn").length, 8, "rescan is idempotent");
  assert.equal(document.querySelector(".m2q-badge").textContent, badge, "badge count is stable");
});

test("unchecking the batch badge actually removes it, and the choice persists", async () => {
  const { sandbox, document } = makeSandbox({ html: readFixture("regression.html"), hostname: "example.com" });
  runUserscript(sandbox);
  document.dispatchEvent({ type: "DOMContentLoaded" });
  await settled();

  assert.equal(document.querySelector(".m2q-badge").textContent, "⚡ 8", "badge present while enabled");

  document.querySelector(".m2q-float").click();
  document.querySelectorAll(".m2q-menu-item")[0].click();
  document.querySelectorAll(".m2q-tab")[3].click();

  // the toggle row whose label mentions 批量徽标
  const row = Array.from(document.querySelectorAll(".m2q-toggle")).find((label) => label.textContent.includes("批量徽标"));
  assert.ok(row, "batch badge toggle exists");
  const checkbox = row.querySelector('input[type="checkbox"]');
  assert.equal(checkbox.checked, true, "starts enabled");

  checkbox.checked = false;
  checkbox.dispatchEvent({ type: "change" });

  assert.equal(document.querySelector(".m2q-badge"), null, "badge disappears immediately when unchecked");

  document.querySelector(".m2q-btn2.is-primary").click();
  assert.equal(stored(sandbox).batchButton, false, "disabled state was persisted");
  assert.equal(document.querySelector(".m2q-badge"), null, "still gone after saving");

  // a rescan must not bring it back
  document.querySelector(".m2q-float").click();
  Array.from(document.querySelectorAll(".m2q-menu-item")).find((i) => i.textContent.includes("重新扫描")).click();
  await settled(320);
  assert.equal(document.querySelector(".m2q-badge"), null, "rescan does not resurrect the badge");
});

test("cancelling the panel reverts a toggle preview instead of leaving it applied", async () => {
  const { sandbox, document } = makeSandbox({ html: readFixture("regression.html"), hostname: "example.com" });
  runUserscript(sandbox);
  document.dispatchEvent({ type: "DOMContentLoaded" });
  await settled();

  document.querySelector(".m2q-float").click();
  document.querySelectorAll(".m2q-menu-item")[0].click();
  document.querySelectorAll(".m2q-tab")[3].click();

  const row = Array.from(document.querySelectorAll(".m2q-toggle")).find((label) => label.textContent.includes("批量徽标"));
  const checkbox = row.querySelector('input[type="checkbox"]');
  checkbox.checked = false;
  checkbox.dispatchEvent({ type: "change" });
  assert.equal(document.querySelector(".m2q-badge"), null, "preview hides the badge live");

  // cancel via the footer button
  const cancel = Array.from(document.querySelectorAll(".m2q-btn2")).find((b) => b.textContent === "取消");
  cancel.click();

  assert.equal(document.querySelector(".m2q-badge").textContent, "⚡ 8", "badge is back after cancel");
  assert.equal(stored(sandbox).batchButton, true, "cancel did not persist the change");
});

test("re-enabling hex detection decorates the hashes again", async () => {
  const { sandbox, document } = makeSandbox({ html: readFixture("regression.html"), hostname: "example.com" });
  runUserscript(sandbox);
  document.dispatchEvent({ type: "DOMContentLoaded" });
  await settled();
  assert.equal(document.querySelectorAll(".m2q-btn").length, 8);

  // disable hex40 detection and save
  document.querySelector(".m2q-float").click();
  document.querySelectorAll(".m2q-menu-item")[0].click();
  document.querySelectorAll(".m2q-tab")[3].click();
  const hexRow = Array.from(document.querySelectorAll(".m2q-toggle")).find((label) => label.textContent.includes("40 位十六进制"));
  const hexBox = hexRow.querySelector('input[type="checkbox"]');
  hexBox.checked = false;
  hexBox.dispatchEvent({ type: "change" });
  document.querySelector(".m2q-btn2.is-primary").click();
  assert.equal(stored(sandbox).detectHex40, false);

  await settled(220);
  const afterDisable = document.querySelectorAll(".m2q-btn").length;

  // turn it back on
  document.querySelector(".m2q-float").click();
  document.querySelectorAll(".m2q-menu-item")[0].click();
  document.querySelectorAll(".m2q-tab")[3].click();
  const hexRow2 = Array.from(document.querySelectorAll(".m2q-toggle")).find((label) => label.textContent.includes("40 位十六进制"));
  const hexBox2 = hexRow2.querySelector('input[type="checkbox"]');
  hexBox2.checked = true;
  hexBox2.dispatchEvent({ type: "change" });
  document.querySelector(".m2q-btn2.is-primary").click();

  await settled(320);
  assert.equal(document.querySelectorAll(".m2q-btn").length, 8, "buttons are restored after re-enabling");
  assert.ok(afterDisable <= 8, "disabling never increases the button count");
});
