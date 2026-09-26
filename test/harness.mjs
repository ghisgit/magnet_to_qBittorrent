/**
 * Loads Magnet_to_qBittorrent.js, extracts its two self-contained blocks and
 * wires them up against a minimal DOM shim so the scanner can be exercised
 * offline.
 *
 *   PURE block    -- hash/magnet/domain-rule logic, exports nothing but
 *                    `exports.*` assignments; wrapped by the module itself when
 *                    the file is require()d.
 *   SCANNER block -- everything that touches the DOM; wrapped in
 *                    `var scannerBlock = function(document, window, ...){...}`
 *                    so a test can hand it a fake environment.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createDocument, MiniNode } from "./minidom.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(HERE, "..", "Magnet_to_qBittorrent.js");
export const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, "utf8");

function sliceBlock(source, marker) {
  const begin = `// ==M2Q-${marker}-BEGIN==`;
  const end = `// ==M2Q-${marker}-END==`;
  const start = source.indexOf(begin);
  const stop = source.indexOf(end);
  if (start === -1 || stop === -1) throw new Error(`marker ${marker} not found in userscript`);
  return source.slice(start + begin.length, stop);
}

export const PURE_SOURCE = sliceBlock(SCRIPT_SOURCE, "PURE");
export const SCANNER_SOURCE = sliceBlock(SCRIPT_SOURCE, "SCANNER");

/** The real pure kernel (the module exports its own `exports.*` surface). */
export const pure = require(SCRIPT_PATH);

export function readFixture(name) {
  return readFileSync(path.join(HERE, "fixtures", name), "utf8");
}

function makeClassList(node) {
  return node.classList;
}

/** window/realm stub good enough for timers, events and getComputedStyle. */
// Userscript timers (toast dismissal, debounce) outlive a test; unref them so the
// test process is not held open waiting for them.
function bgTimeout(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (handle && typeof handle.unref === "function") handle.unref();
  return handle;
}

function bgInterval(fn, ms) {
  const handle = setInterval(fn, ms);
  if (handle && typeof handle.unref === "function") handle.unref();
  return handle;
}

function makeWindow() {
  const listeners = new Map();
  return {
    __gm: [],
    setTimeout: bgTimeout,
    clearTimeout: (id) => clearTimeout(id),
    setInterval: bgInterval,
    clearInterval: (id) => clearInterval(id),
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    },
    dispatchEvent(event) {
      (listeners.get(event.type) || []).slice().forEach((handler) => handler(event));
      return true;
    },
    getComputedStyle(node) {
      const tag = node && node.tagName ? node.tagName : "DIV";
      const inline = ["SPAN", "A", "CODE", "B", "I", "EM", "STRONG", "LABEL"];
      return { display: inline.indexOf(tag) === -1 ? "block" : "inline" };
    },
    localStorage: (() => {
      const store = new Map();
      return {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
      };
    })(),
  };
}

/**
 * Instantiates the scanner against a parsed HTML document.
 * options: { html, hostname, settings, gmResponse }
 */
export function bootScanner(options = {}) {
  const document = options.document || createDocument(options.html || "<html><body></body></html>");
  const window = makeWindow();
  const location = {
    href: `https://${options.hostname || "example.com"}/post/1`,
    hostname: options.hostname || "example.com",
    pathname: "/post/1",
  };
  const settings = Object.assign(pure.defaultSettings("3.0.0-test"), options.settings || {});
  const toasts = [];
  const requests = [];

  // The scanner derives its live settings from storage (loadSettings()), normalising
  // against `defaultsParam`. Seed that store so the test's settings are the ones used.
  const store = {
    getItem: () => JSON.stringify(settings),
    setItem: () => {},
    removeItem: () => {},
  };

  const api = {
    document,
    window,
    location,
    NodeFilter: { SHOW_TEXT: 4 },
    exports: undefined,
    module: undefined,
    defaults: pure.defaultSettings("3.0.0-test"),
    SCRIPT_VERSION: "3.0.0-test",
    LOG_PREFIX: "[test]",
    STORE_KEY: "magnet2qb_settings_test",
    UI_ATTR: "data-m2q-ui",
    // pure helpers the scanner reaches for
    normalizeSettings: pure.normalizeSettings,
    isDisabledOn: pure.isDisabledOn,
    isDomainAllowed: pure.isDomainAllowed,
    getCategoryForDomain: pure.getCategoryForDomain,
    rulesToString: pure.rulesToString,
    parseDomainRules: pure.parseDomainRules,
    normalizeDisabled: pure.normalizeDisabled,
    normalizeTrackers: pure.normalizeTrackers,
    scanHashesInText: pure.scanHashesInText,
    buildMagnet: pure.buildMagnet,
    coerceMagnet: pure.coerceMagnet,
    enrichMagnet: pure.enrichMagnet,
    extractMagnetHint: pure.extractMagnetHint,
    makeMagnetItem: pure.makeMagnetItem,
    dedupeMagnets: pure.dedupeMagnets,
    normalizeHash: pure.normalizeHash,
    hashFromMagnet: pure.hashFromMagnet,
    parseExtraParams: pure.parseExtraParams,
    extraParamsError: pure.extraParamsError,
    describeHash: pure.describeHash,
    isValidHostInput: pure.isValidHostInput,
    normalizeHostInput: pure.normalizeHostInput,
    apiErrorText: pure.apiErrorText,
    isOkResponse: pure.isOkResponse,
    joinApiPath: pure.joinApiPath,
  };

  // The scanner block ends by returning its own API object; append the return so
  // vm.compileFunction hands the block's factory back, then invoke it explicitly
  // with the same dependency list the userscript passes at load time.
  const source = "\n" + SCANNER_SOURCE + "\nreturn scannerBlock;\n";
  const factory = vm.compileFunction(source, ["document", "window", "location", "api"], { filename: "magnet2qb-scanner.js" });
  const blockFactory = factory(document, window, location, api);
  window.localStorage = store;
  const scanner = blockFactory({
    document,
    window,
    location,
    NodeFilter: { SHOW_TEXT: 4 },
    exports: undefined,
    module: undefined,
    settings,
    boot: {
      // The block publishes its normalised live settings back through this payload,
      // matching how the userscript passes its own boot object in.
      settings: Object.assign({}, api.defaults, settings),
      defaults: Object.assign({}, api.defaults, settings, { scriptVersion: api.SCRIPT_VERSION }),
      ready: true,
    },
    settings: undefined,
    defaults: undefined,
    SCRIPT_VERSION: api.SCRIPT_VERSION,
    LOG_PREFIX: api.LOG_PREFIX,
    STORE_KEY: api.STORE_KEY,
    UI_ATTR: api.UI_ATTR,
    normalizeSettings: api.normalizeSettings,
    isDisabledOn: api.isDisabledOn,
    isDomainAllowed: api.isDomainAllowed,
    getCategoryForDomain: api.getCategoryForDomain,
    rulesToString: api.rulesToString,
    parseDomainRules: api.parseDomainRules,
    normalizeDisabled: api.normalizeDisabled,
    normalizeTrackers: api.normalizeTrackers,
    scanHashesInText: api.scanHashesInText,
    buildMagnet: api.buildMagnet,
    coerceMagnet: api.coerceMagnet,
    enrichMagnet: api.enrichMagnet,
    extractMagnetHint: api.extractMagnetHint,
    makeMagnetItem: api.makeMagnetItem,
    dedupeMagnets: api.dedupeMagnets,
    normalizeHash: api.normalizeHash,
    hashFromMagnet: api.hashFromMagnet,
    parseExtraParams: api.parseExtraParams,
    extraParamsError: api.extraParamsError,
    describeHash: api.describeHash,
    isValidHostInput: api.isValidHostInput,
    normalizeHostInput: api.normalizeHostInput,
    apiErrorText: api.apiErrorText,
    isOkResponse: api.isOkResponse,
    joinApiPath: api.joinApiPath,
  });

  // transport spy: record every GM_xmlhttpRequest call, reply with gmResponse
  window.GM_xmlhttpRequest = function (details) {
    requests.push(details);
    if (typeof options.gmResponse === "function") {
      setTimeout(() => options.gmResponse(details), 0);
      return;
    }
    const reply = Object.assign({ status: 200, responseText: "Ok." }, options.gmResponse || {});
    setTimeout(() => details.onload && details.onload(reply), 0);
  };

  function stubGlobals() {
    globalThis.window = window;
    globalThis.document = document;
    window.GM_xmlhttpRequest = window.GM_xmlhttpRequest;
    globalThis.GM_xmlhttpRequest = window.GM_xmlhttpRequest;
    return () => {
      delete globalThis.window;
      delete globalThis.document;
      delete globalThis.GM_xmlhttpRequest;
    };
  }

  const restoreGlobals = stubGlobals();

  return {
    ...scanner,
    pure,
    document,
    window,
    location,
    settings,
    requests,
    toasts,
    restore: restoreGlobals,
    /** buttons injected by the last scan() */
    buttons() {
      return document.querySelectorAll(".m2q-btn");
    },
    /** every injected chip wrapper */
    chips() {
      return document.querySelectorAll(".m2q-chip-wrap");
    },
    /** resolve pending fake XHR replies */
    flush(ms = 5) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

export { bgTimeout, bgInterval };

export function makeElement(document, tag, attributes = {}, text) {
  const node = document.createElement(tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  if (text != null) node.textContent = text;
  return node;
}

export { createDocument, MiniNode, makeClassList };
