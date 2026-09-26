// ==UserScript==
// @name         Magnet to qBittorrent (域名即分类)
// @namespace    https://github.com/ghisgit/magnet_to_qBittorrent
// @version      3.0.1
// @description  识别磁力链接与裸 infohash（40 位 hex / base32），一键发送到 qBittorrent，按域名自动分类；内置现代化设置面板
// @author       ghisgit
// @homepageURL  https://github.com/ghisgit/magnet_to_qBittorrent
// @supportURL   https://github.com/ghisgit/magnet_to_qBittorrent/issues
// @downloadURL  https://raw.githubusercontent.com/ghisgit/magnet_to_qBittorrent/master/Magnet_to_qBittorrent.js
// @updateURL    https://raw.githubusercontent.com/ghisgit/magnet_to_qBittorrent/master/Magnet_to_qBittorrent.js
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @connect      *
// @noframes
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  "use strict";

  // ===========================================================================
  // ==M2Q-PURE-BEGIN==  (self-contained: literals + functions only, no DOM, no
  // globals. Consumed by test/scan.test.mjs via slice + new Function(block).)
  // ===========================================================================

  var HEX40_RE = /^[0-9a-f]{40}$/i;
  var HEX64_RE = /^[0-9a-f]{64}$/i;
  var BASE32_RE = /^[a-z2-7]{32}$/;
  var TOKEN_RE = /(?<![0-9a-zA-Z])([0-9a-zA-Z]{32,64})(?![0-9a-zA-Z])/g;
  var MAGNET_RE = /magnet:\?[^\s"'<>\\]+/i;
  var MAGNET_HASH_RE = /xt=urn:btih:([0-9a-zA-Z]{32,64})/i;
  var TRACKER_KIND = "__trackers__";

  var DEFAULT_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
  ];

  // -- settings schema -------------------------------------------------------

  function defaultSettings(version) {
    return {
      schema: 3,
      scriptVersion: version,
      // --- fields shared with v2.1 (same names, so old installs migrate free) ---
      host: "http://localhost:8080",
      username: "",
      password: "",
      category: "",
      domains: "",
      extraParams: "{}",
      // --- new in v3 ---
      rules: [],
      disabledDomains: [],
      trackers: DEFAULT_TRACKERS.slice(),
      detectMagnet: true,
      detectHex40: true,
      detectBase32: false,
      detectV2: false,
      detectRawHash: false,
      enableFloatingButton: true,
      autoScan: true,
      batchButton: true,
      savepath: "",
      tags: "",
      maxButtonsPerPage: 200,
      customSelectors: "",
      allowDuplicate: false,
      buttonStyle: "chip",
      floatPos: null,
      theme: "auto",
    };
  }

  function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function normalizeSettings(settings, defaults) {
    var out = Object.assign({}, defaults || defaultSettings("0"), settings || {});
    // Flat scalar fields -----------------------------------------------------
    out.schema = 3;
    out.host = typeof out.host === "string" && out.host.trim() ? out.host.trim().replace(/\/+$/, "") : "http://localhost:8080";
    if (/^https?:\/?$/i.test(out.host)) out.host = "http://localhost:8080";
    out.username = typeof out.username === "string" ? out.username : "";
    out.password = typeof out.password === "string" ? out.password : "";
    out.category = typeof out.category === "string" ? out.category.trim() : "";
    out.domains = typeof out.domains === "string" ? out.domains : "";
    out.extraParams = typeof out.extraParams === "string" && out.extraParams.trim() ? out.extraParams : "{}";
    out.savepath = typeof out.savepath === "string" ? out.savepath.trim() : "";
    out.tags = typeof out.tags === "string" ? out.tags.trim() : "";
    out.customSelectors = typeof out.customSelectors === "string" ? out.customSelectors : "";
    out.buttonStyle = out.buttonStyle === "plain" ? "plain" : "chip";
    out.theme = out.theme === "light" || out.theme === "dark" ? out.theme : "auto";
    out.maxButtonsPerPage = clampInt(out.maxButtonsPerPage, 1, 5000, 200);
    var bools = [
      "detectMagnet",
      "detectHex40",
      "detectBase32",
      "detectV2",
      "detectRawHash",
      "enableFloatingButton",
      "autoScan",
      "batchButton",
      "allowDuplicate",
    ];
    for (var i = 0; i < bools.length; i++) out[bools[i]] = out[bools[i]] !== false;

    // Legacy flat `domains` string -> structured rules -----------------------
    if (Array.isArray(out.rules) && out.rules.length === 0 && typeof out.domains === "string" && out.domains.trim()) {
      out.rules = parseDomainRules(out.domains);
    }
    out.rules = normalizeRules(out.rules);
    out.disabledDomains = normalizeDisabled(out.disabledDomains);
    out.trackers = normalizeTrackers(out.trackers);
    out.floatPos = normalizePos(out.floatPos);
    return out;
  }

  function clampInt(v, min, max, fallback) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) n = fallback;
    return Math.min(max, Math.max(min, n));
  }

  function normalizePos(pos) {
    if (!isPlainObject(pos)) return null;
    var x = Number(pos.x);
    var y = Number(pos.y);
    if (!isFinite(x) || !isFinite(y)) return null;
    return { x: x, y: y };
  }

  function normalizeTrackers(list) {
    var arr = Array.isArray(list) ? list : typeof list === "string" ? list.split(/[\n,]+/) : [];
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < arr.length; i++) {
      var t = String(arr[i] == null ? "" : arr[i]).trim();
      if (!t || seen[t]) continue;
      seen[t] = true;
      out.push(t);
    }
    return out;
  }

  function normalizeDisabled(list) {
    var arr = Array.isArray(list) ? list : typeof list === "string" ? list.split(/[\n,]+/) : [];
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < arr.length; i++) {
      var d = String(arr[i] == null ? "" : arr[i])
        .trim()
        .toLowerCase();
      if (!d || seen[d]) continue;
      seen[d] = true;
      out.push(d);
    }
    return out;
  }

  function normalizeRules(rules) {
    if (typeof rules === "string") return parseDomainRules(rules);
    if (!Array.isArray(rules)) return [];
    var out = [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (typeof r === "string") {
        var parsed = parseDomainRules(r);
        for (var k = 0; k < parsed.length; k++) out.push(parsed[k]);
        continue;
      }
      if (!isPlainObject(r)) continue;
      var domain = String(r.domain == null ? "" : r.domain).trim();
      if (!domain) continue;
      out.push({
        domain: domain,
        category: String(r.category == null ? "" : r.category).trim(),
        regex: r.regex === true,
      });
    }
    return out;
  }

  // -- domain rules ----------------------------------------------------------

  // Legacy syntax kept intact: "domain1:cat1, domain2, domain3:cat3"
  // (empty string => allow every domain; category may itself contain colons)
  function parseDomainRules(str) {
    if (typeof str !== "string") return [];
    var out = [];
    var parts = str.split(",");
    for (var i = 0; i < parts.length; i++) {
      var trimmed = String(parts[i]).trim();
      if (!trimmed) continue;
      var idx = trimmed.indexOf(":");
      var domain = idx === -1 ? trimmed : trimmed.slice(0, idx).trim();
      var category = idx === -1 ? "" : trimmed.slice(idx + 1).trim();
      if (!domain) continue;
      out.push({ domain: domain, category: category, regex: false });
    }
    return out;
  }

  function rulesToString(rules) {
    return normalizeRules(rules)
      .map(function (r) {
        var d = (r.regex ? "re:" : "") + r.domain;
        return r.category ? d + ":" + r.category : d;
      })
      .join(", ");
  }

  function compileRule(domain, regex) {
    if (!regex) return null;
    try {
      return new RegExp(domain, "i");
    } catch (e) {
      return null;
    }
  }

  function ruleMatches(rule, hostname) {
    if (!rule || !rule.domain) return false;
    var host = String(hostname || "").toLowerCase();
    if (rule.regex || rule.domain.slice(0, 3) === "re:") {
      var pattern = rule.domain.slice(0, 3) === "re:" ? rule.domain.slice(3) : rule.domain;
      var re = compileRule(pattern, true);
      if (!re) return false;
      return re.test(host);
    }
    return host.indexOf(rule.domain.toLowerCase()) !== -1;
  }

  // Empty rule list => every domain allowed (unchanged v2.1 behaviour).
  function isDomainAllowed(hostname, rules) {
    var list = normalizeRules(rules);
    if (list.length === 0) return true;
    for (var i = 0; i < list.length; i++) if (ruleMatches(list[i], hostname)) return true;
    return false;
  }

  function getCategoryForDomain(hostname, rules, globalCategory) {
    var list = normalizeRules(rules);
    var host = String(hostname || "").toLowerCase();
    for (var i = 0; i < list.length; i++) {
      if (ruleMatches(list[i], host)) return list[i].category || globalCategory || "";
    }
    return globalCategory || "";
  }

  function isDisabledOn(hostname, disabledDomains) {
    var host = String(hostname || "").toLowerCase();
    var list = normalizeDisabled(disabledDomains);
    for (var i = 0; i < list.length; i++) if (host.indexOf(list[i]) !== -1) return true;
    return false;
  }

  // -- hash / magnet ---------------------------------------------------------

  function detectHashKind(token, opts) {
    if (typeof token !== "string") return null;
    var o = opts || {};
    var t = token.trim();
    if (HEX40_RE.test(t)) return o.hex40 === false ? null : { hash: t.toLowerCase(), kind: "hex40" };
    if (HEX64_RE.test(t)) return o.v2 ? { hash: t.toLowerCase(), kind: "v2" } : null;
    if (typeof t.toLowerCase === "function" && BASE32_RE.test(t.toLowerCase())) {
      return o.base32 ? { hash: t.toLowerCase(), kind: "base32" } : null;
    }
    return null;
  }

  function scanHashesInText(text, opts) {
    var out = [];
    if (!text) return out;
    var re = new RegExp(TOKEN_RE.source, "g");
    var m;
    while ((m = re.exec(text)) !== null) {
      var hit = detectHashKind(m[1], opts);
      if (hit) {
        hit.index = m.index;
        hit.length = m[1].length;
        hit.raw = m[1];
        out.push(hit);
      }
    }
    return out;
  }

  function normalizeHash(hash) {
    if (typeof hash !== "string") return null;
    var t = hash.trim();
    if (HEX40_RE.test(t)) return t.toLowerCase();
    if (HEX64_RE.test(t)) return t.toLowerCase();
    if (BASE32_RE.test(t.toLowerCase())) return t.toLowerCase();
    return null;
  }

  function hashFromMagnet(magnet) {
    if (typeof magnet !== "string") return null;
    var m = magnet.match(MAGNET_HASH_RE);
    return m ? normalizeHash(m[1]) : null;
  }

  function buildMagnet(hash, opts) {
    var normalized = normalizeHash(hash);
    if (!normalized) return null;
    var o = opts || {};
    var parts = ["magnet:?xt=urn:btih:" + normalized];
    var name = typeof o.name === "string" ? o.name.trim() : "";
    if (name) parts.push("&dn=" + encodeURIComponent(name));
    var trackers = normalizeTrackers(o.trackers);
    for (var i = 0; i < trackers.length; i++) parts.push("&tr=" + encodeURIComponent(trackers[i]));
    return parts.join("");
  }

  function trackersInMagnet(magnet) {
    var out = [];
    var re = /[?&]tr=([^&\s]+)/gi;
    var m;
    while ((m = re.exec(String(magnet || ""))) !== null) {
      try {
        out.push(decodeURIComponent(m[1]));
      } catch (e) {
        out.push(m[1]);
      }
    }
    return out;
  }

  // A ready magnet often carries no tracker at all (some sites paste a bare
  // "magnet:?xt=urn:btih:HASH"). Add the configured ones so the peer lookup works.
  function enrichMagnet(magnet, trackers) {
    if (!magnet || !hashFromMagnet(magnet)) return null;
    var configured = normalizeTrackers(trackers);
    if (!configured.length) return magnet;
    var present = Object.create(null);
    trackersInMagnet(magnet).forEach(function (t) {
      present[t.toLowerCase()] = true;
    });
    var parts = [];
    configured.forEach(function (t) {
      if (present[t.toLowerCase()]) return;
      present[t.toLowerCase()] = true;
      parts.push("&tr=" + encodeURIComponent(t));
    });
    return parts.length ? magnet + parts.join("") : magnet;
  }

  // Accepts either a ready magnet URI or a bare hash and always returns a magnet.
  function coerceMagnet(raw, opts) {
    var o = opts || {};
    if (typeof raw !== "string") return null;
    var value = raw.trim();
    if (!value) return null;
    if (/^magnet:/i.test(value)) return MAGNET_RE.test(value) && hashFromMagnet(value) ? value : null;
    var hash = normalizeHash(value);
    if (!hash) return null;
    return buildMagnet(hash, o);
  }

  function extractMagnetHint(text) {
    if (typeof text !== "string") return null;
    var m = text.match(MAGNET_RE);
    if (!m) return null;
    return hashFromMagnet(m[0]) ? m[0] : null;
  }

  function makeMagnetItem(kind, opts) {
    var o = opts || {};
    var magnet = o.magnet || null;
    var hash = o.hash || (magnet ? hashFromMagnet(magnet) : null);
    if (!hash && o.raw) hash = normalizeHash(o.raw);
    if (!hash && magnet) return null;
    if (!magnet) magnet = buildMagnet(hash, { name: o.name, trackers: o.trackers });
    return {
      hash: hash,
      magnet: magnet,
      kind: kind || o.kind || "hex40",
      origin: o.origin || null,
      name: o.name || null,
    };
  }

  // Reduces any mix of {hash} / {magnet} / raw strings to unique magnet items.
  function dedupeMagnets(items, opts) {
    var o = opts || {};
    var trackers = normalizeTrackers(o.trackers);
    var allowDuplicate = o.allowDuplicate === true;
    var seen = Object.create(null);
    var out = [];
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it == null) continue;
      if (typeof it === "string") it = { magnet: /^magnet:/i.test(it) ? it : null, hash: /^magnet:/i.test(it) ? null : it, raw: it };
      var magnet = coerceMagnet(it.magnet || it.raw || it.hash || "", { trackers: trackers, name: it.name });
      if (magnet) magnet = enrichMagnet(magnet, trackers);
      var hash = it.hash ? normalizeHash(it.hash) : magnet ? hashFromMagnet(magnet) : null;
      if (!hash || !magnet) continue;
      if (seen[hash] && !allowDuplicate) continue;
      seen[hash] = true;
      out.push({ hash: hash, magnet: magnet, kind: it.kind || "hex40", origin: it.origin || null, name: it.name || null });
    }
    return out;
  }

  function parseExtraParams(raw) {
    if (typeof raw !== "string" || !raw.trim()) return {};
    try {
      var obj = JSON.parse(raw);
      if (!isPlainObject(obj)) return {};
      return obj;
    } catch (e) {
      return {};
    }
  }

  function extraParamsError(raw) {
    if (typeof raw !== "string" || !raw.trim()) return null;
    try {
      var obj = JSON.parse(raw);
      if (!isPlainObject(obj)) return "必须是 JSON 对象，例如 {\"paused\": true}";
      return null;
    } catch (e) {
      return String((e && e.message) || e);
    }
  }

  // -- misc formatting -------------------------------------------------------

  function describeHash(hash) {
    if (!hash || hash.length < 12) return hash || "";
    return hash.slice(0, 8) + "…" + hash.slice(-4);
  }

  function hostFromUrl(url) {
    var m = String(url || "").match(/^([a-z][a-z0-9+.-]*:)\/\//i);
    var rest = m ? String(url).slice(m[0].length) : String(url || "");
    var cut = rest.search(/[/?#]/);
    return cut === -1 ? rest : rest.slice(0, cut);
  }

  function normalizeHostInput(host) {
    var h = String(host || "").trim().replace(/\/+$/, "");
    if (!h) return "";
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) h = "http://" + h;
    return h.replace(/\/+$/, "");
  }

  function isValidHostInput(host) {
    var h = normalizeHostInput(host);
    if (!h) return false;
    if (!/^https?:\/\/[^\s/]+$/i.test(h)) return false;
    return !!hostFromUrl(h);
  }

  function apiErrorText(status, body) {
    var b = String(body == null ? "" : body).trim();
    if (status === 0) return "网络错误：无法连接，请检查地址、端口与网络";
    if (status === 401) return "认证失败（401）：用户名或密码错误";
    if (status === 403) return "被拒绝（403）：通常是用户名或密码错误，或 IP 被 qB 的“仅允许白名单”限制";
    if (status === 404) return "接口不存在（404）：地址可能不是 qB WebUI，或版本过旧";
    if (status === 415) return "种子文件无效（415）";
    if (status >= 500) return "qBittorrent 内部错误（" + status + "）" + (b ? "：" + b.slice(0, 120) : "");
    if (status !== 200) return "请求失败（HTTP " + status + "）" + (b ? "：" + b.slice(0, 120) : "");
    if (/^fails\.?$/i.test(b)) return "qBittorrent 返回 Fails.：链接无效或已被拒绝";
    return null;
  }

  function isOkResponse(status, body) {
    if (status < 200 || status >= 300) return false;
    var b = String(body == null ? "" : body).trim();
    if (/^fails\.?$/i.test(b)) return false;
    return true;
  }

  function joinApiPath(host, path) {
    return String(host || "").replace(/\/+$/, "") + path;
  }

  if (typeof exports !== "undefined" && exports) {
    exports.defaultSettings = defaultSettings;
    exports.normalizeSettings = normalizeSettings;
    exports.normalizeRules = normalizeRules;
    exports.normalizeDisabled = normalizeDisabled;
    exports.normalizeTrackers = normalizeTrackers;
    exports.parseDomainRules = parseDomainRules;
    exports.rulesToString = rulesToString;
    exports.ruleMatches = ruleMatches;
    exports.isDomainAllowed = isDomainAllowed;
    exports.getCategoryForDomain = getCategoryForDomain;
    exports.isDisabledOn = isDisabledOn;
    exports.detectHashKind = detectHashKind;
    exports.scanHashesInText = scanHashesInText;
    exports.normalizeHash = normalizeHash;
    exports.hashFromMagnet = hashFromMagnet;
    exports.buildMagnet = buildMagnet;
    exports.coerceMagnet = coerceMagnet;
    exports.enrichMagnet = enrichMagnet;
    exports.trackersInMagnet = trackersInMagnet;
    exports.extractMagnetHint = extractMagnetHint;
    exports.makeMagnetItem = makeMagnetItem;
    exports.dedupeMagnets = dedupeMagnets;
    exports.parseExtraParams = parseExtraParams;
    exports.extraParamsError = extraParamsError;
    exports.describeHash = describeHash;
    exports.hostFromUrl = hostFromUrl;
    exports.normalizeHostInput = normalizeHostInput;
    exports.isValidHostInput = isValidHostInput;
    exports.apiErrorText = apiErrorText;
    exports.isOkResponse = isOkResponse;
    exports.joinApiPath = joinApiPath;
    exports.DEFAULT_TRACKERS = DEFAULT_TRACKERS;
    exports.TRACKER_KIND = TRACKER_KIND;
    exports.TOKEN_RE = TOKEN_RE;
  }

  // ==M2Q-PURE-END==

  // ===========================================================================
  // Runtime (browser only). Everything below may touch DOM / GM_* APIs.
  // The whole block is skipped when the file is pulled into a test harness.
  // ===========================================================================

  if (typeof exports !== "undefined" && exports) return;

  // ==M2Q-SCANNER-BEGIN==
  var SCRIPT_VERSION = "3.0.1";
  var STORE_KEY = "magnet2qb_settings";
  var UI_ATTR = "data-m2q-ui";
  var LOG_PREFIX = "[Magnet2qB]";

  var scannerBlock = function ({
    document,
    window,
    location,
    NodeFilter,
    exports,
    module,
    boot,
    settings,
    defaults: defaultsParam,
    SCRIPT_VERSION,
    LOG_PREFIX,
    STORE_KEY,
    UI_ATTR,
    normalizeSettings,
    isDisabledOn,
    isDomainAllowed,
    getCategoryForDomain,
    rulesToString,
    parseDomainRules,
    normalizeDisabled,
    normalizeTrackers,
    scanHashesInText,
    buildMagnet,
    coerceMagnet,
    enrichMagnet,
    extractMagnetHint,
    makeMagnetItem,
    dedupeMagnets,
    normalizeHash,
    hashFromMagnet,
    parseExtraParams,
    extraParamsError,
    describeHash,
    isValidHostInput,
    normalizeHostInput,
    apiErrorText,
    isOkResponse,
    joinApiPath,
  }) {

  var defaults = defaultsParam || normalizeSettings({}, boot && boot.defaults);
  var settings = boot && boot.ready ? loadSettings() : boot && boot.settings ? boot.settings : loadSettings();
  var runtime = {
    win: typeof window !== "undefined" && window ? window : null,
    doc: typeof document !== "undefined" && document ? document : null,
    roots: [],
    toastRoot: null,
    panel: null,
    counts: { found: 0, injected: 0, exchanges: 0 },
    lastConnection: null,
    categories: null,
    categoriesError: null,
    observer: null,
    scanTimer: null,
    badge: null,
    floatRoot: null,
    floatBtn: null,
    floatMenu: null,
    started: false,
    historyPatched: false,
  };

  // Late-bound DOM access keeps the module loadable in environments without a
  // document (test harness / sandboxed evaluation) and avoids DOM calls at load.
  function doc() {
    return runtime.doc || (typeof document !== "undefined" ? document : null);
  }

  function win() {
    return runtime.win || (typeof window !== "undefined" ? window : null);
  }

  function docRoot() {
    var d = doc();
    return d ? d.body || d.documentElement : null;
  }

  // ------------------------------------------------------------------ storage

  function hasGM() {
    return typeof GM_getValue === "function" && typeof GM_setValue === "function";
  }

  function rawGet(key) {
    if (hasGM()) {
      try {
        return GM_getValue(key, null);
      } catch (e) {
        logWarn("GM_getValue 失败", e);
      }
    }
    try {
      return win().localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function rawSet(key, value) {
    if (hasGM()) {
      try {
        GM_setValue(key, value);
        return;
      } catch (e) {
        logWarn("GM_setValue 失败", e);
      }
    }
    try {
      win().localStorage.setItem(key, value);
    } catch (e) {
      /* ignore */
    }
  }

  function loadSettings() {
    var raw = rawGet(STORE_KEY);
    if (typeof raw !== "string" || !raw) return normalizeSettings({}, defaults);
    try {
      return normalizeSettings(JSON.parse(raw), defaults);
    } catch (e) {
      logWarn("设置解析失败，已使用默认值", e);
      return normalizeSettings({}, defaults);
    }
  }

  function saveSettingsLocal() {
    try {
      rawSet(STORE_KEY, JSON.stringify(settings));
    } catch (e) {
      logWarn("设置保存失败", e);
    }
  }

  function logWarn() {
    try {
      console.warn.apply(console, [LOG_PREFIX].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------- current site

  function currentHost() {
    try {
      return location.hostname || "";
    } catch (e) {
      return "";
    }
  }

  function siteEnabled() {
    var host = currentHost();
    if (isDisabledOn(host, settings.disabledDomains)) return false;
    return isDomainAllowed(host, settings.rules);
  }

  function currentCategory() {
    return getCategoryForDomain(currentHost(), settings.rules, settings.category);
  }

  function detectOptions() {
    return {
      magnet: settings.detectMagnet !== false,
      hex40: settings.detectHex40 !== false,
      base32: settings.detectBase32 === true,
      v2: settings.detectV2 === true,
      rawHash: settings.detectRawHash === true,
      customSelectors: settings.customSelectors || "",
    };
  }

  // ---------------------------------------------------------------- UI layer

  function makeLayer(hostEl) {
    if (hostEl && typeof hostEl.attachShadow === "function") {
      var shadow = hostEl.attachShadow({ mode: "open" });
      var style = doc().createElement("style");
      style.textContent = UI_CSS;
      shadow.appendChild(style);
      var root = doc().createElement("div");
      root.className = "m2q-root";
      shadow.appendChild(root);
      return { root: root, shadow: shadow };
    }
    var plain = doc().createElement("div");
    plain.className = "m2q-root";
    plain.setAttribute("style", "all:initial");
    if (hostEl) hostEl.appendChild(plain);
    return { root: plain, shadow: null };
  }

  function mountUi() {
    if (runtime.roots.length) return runtime.roots[0];
    var hostEl = doc().createElement("div");
    hostEl.setAttribute(UI_ATTR, "1");
    hostEl.style.cssText = "all:initial;position:static;";
    docRoot().appendChild(hostEl);
    var layer = makeLayer(hostEl);
    layer.host = hostEl;
    runtime.roots.push(layer);
    return layer;
  }

  function toastLayer() {
    if (runtime.toastRoot) return runtime.toastRoot;
    var hostEl = doc().createElement("div");
    hostEl.setAttribute(UI_ATTR, "1");
    hostEl.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;";
    docRoot().appendChild(hostEl);
    var layer = makeLayer(hostEl);
    layer.host = hostEl;
    runtime.toastRoot = layer;
    return layer;
  }

  var TOAST_COLORS = { info: "#2563eb", ok: "#16a34a", warn: "#d97706", error: "#dc2626" };

  function toast(msg, type, ms) {
    try {
      var layer = toastLayer();
      var el = doc().createElement("div");
      el.className = "m2q-toast";
      el.style.setProperty("--tone", TOAST_COLORS[type] || TOAST_COLORS.info);
      var text = doc().createElement("span");
      text.textContent = String(msg == null ? "" : msg);
      el.appendChild(text);
      layer.root.appendChild(el);
      var ttl = typeof ms === "number" ? ms : type === "error" ? 6000 : 3600;
      win().setTimeout(function () {
        el.style.opacity = "0";
        el.style.transform = "translateY(6px)";
        win().setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 320);
      }, ttl);
      return el;
    } catch (e) {
      logWarn("toast 失败", e);
      return null;
    }
  }

  function el(tag, props, children) {
    var node = doc().createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value == null) return;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "html") node.innerHTML = value;
        else if (key === "style") node.setAttribute("style", value);
        else if (key.slice(0, 2) === "on" && typeof value === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === "dataset") {
          Object.keys(value).forEach(function (dk) {
            node.dataset[dk] = value[dk];
          });
        } else node.setAttribute(key, value === true ? "" : String(value));
      });
    }
    (children || []).forEach(function (child) {
      if (child == null) return;
      node.appendChild(typeof child === "string" ? doc().createTextNode(child) : child);
    });
    node.setAttribute(UI_ATTR, "1");
    return node;
  }

  function field(labelText, control, hint) {
    var wrap = el("label", { class: "m2q-field" });
    wrap.appendChild(el("span", { class: "m2q-label", text: labelText }));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(el("span", { class: "m2q-hint", text: hint }));
    return wrap;
  }

  function toggleRow(labelText, checked, onChange, hint) {
    var input = el("input", { type: "checkbox" });
    input.checked = !!checked;
    input.addEventListener("change", function () {
      onChange(input.checked);
    });
    var row = el("label", { class: "m2q-toggle" }, [
      input,
      el("span", { class: "m2q-toggle-text" }, [el("span", { text: labelText }), hint ? el("span", { class: "m2q-hint", text: hint }) : null]),
    ]);
    row.__input = input;
    return row;
  }

  // --------------------------------------------------------------- qB client

  function requestJson(options) {
    return new Promise(function (resolve, reject) {
      var headers = Object.assign({}, options.headers || {});
      var user = options.username == null ? settings.username : options.username;
      var pass = options.password == null ? settings.password : options.password;
      if (user && pass) {
        headers.Authorization = "Basic " + btoa(user + ":" + pass);
      }
      var finish = function (status, body, finalUrl) {
        resolve({ status: status, body: body, url: finalUrl || options.url });
      };
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: options.method || "GET",
          url: options.url,
          headers: headers,
          data: options.data,
          timeout: options.timeout || 20000,
          withCredentials: true,
          onload: function (res) {
            finish(res.status, res.responseText, res.finalUrl);
          },
          onerror: function () {
            finish(0, "");
          },
          ontimeout: function () {
            finish(0, "");
          },
          onabort: function () {
            finish(0, "");
          },
        });
        return;
      }
      var init = { method: options.method || "GET", headers: headers, credentials: "include" };
      if (options.data !== undefined) init.body = options.data;
      fetch(options.url, init)
        .then(function (res) {
          return res.text().then(function (text) {
            finish(res.status, text, res.url);
          });
        })
        .catch(function () {
          finish(0, "");
        });
    });
  }

  function apiGet(path, conn) {
    var opts = { url: joinApiPath((conn && conn.host) || settings.host, path) };
    if (conn) {
      opts.username = conn.username;
      opts.password = conn.password;
    }
    return requestJson(opts);
  }

  function apiPostForm(path, formData, conn) {
    var opts = { method: "POST", url: joinApiPath((conn && conn.host) || settings.host, path), data: formData };
    if (conn) {
      opts.username = conn.username;
      opts.password = conn.password;
    }
    return requestJson(opts);
  }

  function apiLogin(host, username, password) {
    var body = "username=" + encodeURIComponent(username || "") + "&password=" + encodeURIComponent(password || "");
    return requestJson({
      method: "POST",
      url: joinApiPath(normalizeHostInput(host), "/api/v2/auth/login"),
      data: body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }

  function apiVersion(conn) {
    return apiGet("/api/v2/app/version", conn);
  }

  function apiWebApiVersion(conn) {
    return apiGet("/api/v2/app/webapiVersion", conn);
  }

  function apiCategories(conn) {
    return apiGet("/api/v2/torrents/categories", conn);
  }

  function categoriesFromPayload(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) {
      return payload
        .map(function (item) {
          return item && (item.name || item.category) ? String(item.name || item.category) : "";
        })
        .filter(Boolean);
    }
    if (typeof payload === "object") return Object.keys(payload);
    return [];
  }

  function buildAddForm(items, category, extra, formFactory) {
    var make = formFactory || function () {
      return new FormData();
    };
    var form = make();
    var urls = items
      .map(function (item) {
        return typeof item === "string" ? item : item && item.magnet;
      })
      .filter(Boolean);
    form.append("urls", urls.join("\n"));
    if (category) form.append("category", category);
    if (settings.savepath) form.append("savepath", settings.savepath);
    if (settings.tags) form.append("tags", settings.tags);
    Object.keys(extra || {}).forEach(function (key) {
      if (key === "urls" || key === "category") return;
      var value = extra[key];
      if (value == null) return;
      form.append(key, typeof value === "boolean" ? String(value) : String(value));
    });
    return form;
  }

  function sendMagnets(items) {
    var unique = dedupeMagnets(items, { trackers: settings.trackers, allowDuplicate: settings.allowDuplicate === true });
    if (!unique.length) {
      toast("没有可发送的磁力链接", "warn");
      return Promise.resolve({ ok: false, sent: 0 });
    }
    var category = currentCategory();
    var form = buildAddForm(unique, category, parseExtraParams(settings.extraParams));
    return apiPostForm("/api/v2/torrents/add", form).then(function (res) {
      var err = apiErrorText(res.status, res.body);
      if (err || !isOkResponse(res.status, res.body)) {
        toast("❌ 添加失败：" + (err || "未知错误"), "error");
        return { ok: false, sent: 0, error: err };
      }
      runtime.counts.sent = (runtime.counts.sent || 0) + unique.length;
      var label = unique.length > 1 ? unique.length + " 个磁力链接" : describeHash(unique[0].hash);
      toast("✅ 已发送到 qBittorrent：" + label + (category ? "（分类 " + category + "）" : ""), "ok");
      return { ok: true, sent: unique.length, category: category };
    });
  }

  // ------------------------------------------------------------------ scanner

  var EXCLUDED_TAGS = ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "TEMPLATE", "HEAD", "IFRAME", "CANVAS"];
  var HASH_ATTRS = ["data-hash", "data-infohash", "data-info-hash", "data-magnet", "data-magnet-uri", "data-btih"];

  function isExcluded(node) {
    // Text nodes are not elements, so start the walk at the parent, otherwise the
    // loop below never runs and <script>/<style> content would be scanned.
    var cur = node && node.nodeType === 1 ? node : node && node.parentNode;
    while (cur && cur.nodeType === 1) {
      var tag = cur.tagName ? String(cur.tagName).toUpperCase() : "";
      if (EXCLUDED_TAGS.indexOf(tag) !== -1) return true;
      if (cur.hasAttribute && (cur.hasAttribute(UI_ATTR) || cur.hasAttribute("contenteditable") || cur.isContentEditable)) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  function walkTextNodes(root, visit) {
    var filter = typeof NodeFilter !== "undefined" && NodeFilter ? NodeFilter : { SHOW_TEXT: 4 };
    var walker = doc().createTreeWalker(root, filter.SHOW_TEXT, null, false);
    var node = walker.nextNode();
    var count = 0;
    while (node) {
      count++;
      if (count > 40000) break;
      visit(node);
      node = walker.nextNode();
    }
  }

  function btnLabel() {
    return settings.buttonStyle === "plain" ? "qB" : "📥 qB";
  }

  function createInlineButton(item) {
    var btn = doc().createElement("button");
    btn.type = "button";
    btn.className = "m2q-btn";
    btn.textContent = btnLabel();
    btn.title = "把这枚磁力链接发送到 qBittorrent（" + describeHash(item.hash) + "）";
    btn.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      btn.disabled = true;
      btn.classList.add("is-busy");
      sendMagnets([item]).then(function (result) {
        btn.disabled = false;
        btn.classList.remove("is-busy");
        if (result && result.ok) {
          btn.classList.add("is-done");
          btn.textContent = "✓";
          win().setTimeout(function () {
            btn.classList.remove("is-done");
            btn.textContent = btnLabel();
          }, 1800);
        }
      });
      return false;
    });
    return btn;
  }

  function wrapButton(btn) {
    // Built by hand rather than with el(): el() stamps data-m2q-ui, which would make
    // the hash text inside this wrapper invisible to a later scan/batch pass.
    var wrap = doc().createElement("span");
    wrap.className = "m2q-chip-wrap";
    wrap.appendChild(btn);
    return wrap;
  }

  function anchorButton(node, button) {
    if (!node.parentNode) return false;
    node.parentNode.insertBefore(wrapButton(button), node.nextSibling);
    return true;
  }

  // Splits `node` around the match so the button lands exactly where the hash is.
  function splitAndInsert(node, start, length, btn) {
    var doc = node.ownerDocument || document;
    var text = node.nodeValue || "";
    var before = text.slice(0, start);
    var token = text.slice(start, start + length);
    var after = text.slice(start + length);
    var computed;
    try {
      computed = win().getComputedStyle ? win().getComputedStyle(node.parentNode) : null;
    } catch (e) {
      computed = null;
    }
    var display = computed ? computed.display : "";
    var blockish = computed ? computed.display === "block" || computed.display === "list-item" || computed.display === "flex" : true;
    // Deliberately NOT stamped with UI_ATTR: the wrapper now encloses the hash text,
    // and a later scan (or "send everything on this page") must still be able to read
    // it. Everything else the script injects stays off-limits.
    var wrap = doc.createElement("span");
    wrap.className = blockish ? "m2q-chip-wrap is-block" : "m2q-chip-wrap";
    wrap.appendChild(doc.createTextNode(token));
    wrap.appendChild(btn);
    var parent = node.parentNode;
    if (!parent) return false;
    if (before) parent.insertBefore(doc.createTextNode(before), node);
    parent.insertBefore(wrap, node);
    if (after) parent.insertBefore(doc.createTextNode(after), node);
    parent.removeChild(node);
    return true;
  }

  function reportScan(counts) {
    runtime.counts.found = counts.found || 0;
    runtime.counts.injected += counts.injected || 0;
    runtime.counts.exchanges = counts.exchanges || 0;
    updateBadge();
  }

  function updateBadge() {
    if (!settings.batchButton) return;
    var total = runtime.counts.found;
    if (total < 2) {
      if (runtime.badge && runtime.badge.parentNode) runtime.badge.parentNode.removeChild(runtime.badge);
      runtime.badge = null;
      return;
    }
    if (!runtime.badge) {
      var badge = el("div", { class: "m2q-badge", title: "本页识别到的磁力链接数量（点击全部发送）" });
      badge.addEventListener("click", function () {
        sendAllOnPage();
      });
      runtime.badge = badge;
      var layer = mountUi();
      layer.root.appendChild(badge);
    }
    runtime.badge.textContent = "⚡ " + total;
  }

  function collectAnchors() {
    var seen = Object.create(null);
    var out = [];
    var nodes = doc().querySelectorAll(
      'a[href^="magnet:" i], a[data-magnet], a[data-hash], a[data-infohash], a[data-btih], ' +
        'a[title*="magnet:" i], [data-magnet]:not(a), [data-infohash]:not(a), [data-hash]:not(a), [data-btih]:not(a)'
    );
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (isExcluded(node)) continue;
      var magnet = null;
      var kind = "text";
      var href = node.getAttribute("href") || "";
      if (/^magnet:/i.test(href)) {
        magnet = coerceMagnet(href, { trackers: settings.trackers });
        kind = "anchor";
      }
      if (!magnet) {
        for (var a = 0; a < HASH_ATTRS.length; a++) {
          var attr = node.getAttribute(HASH_ATTRS[a]);
          if (!attr) continue;
          magnet = coerceMagnet(attr, { trackers: settings.trackers });
          if (magnet) {
            kind = "attr";
            break;
          }
        }
      }
      if (!magnet) {
        var titleAttr = node.getAttribute("title") || "";
        magnet = extractMagnetHint(titleAttr);
        if (magnet) kind = "title";
      }
      if (!magnet && settings.detectRawHash) {
        var hrefHash = normalizeHash(href.replace(/^#/, ""));
        if (hrefHash) {
          magnet = buildMagnet(hrefHash, { trackers: settings.trackers });
          kind = "href-hash";
        }
      }
      if (!magnet) continue;
      var item = makeMagnetItem(kind, { magnet: magnet, origin: "anchor" });
      if (!item || seen[item.hash]) continue;
      seen[item.hash] = true;
      out.push({ item: item, node: node });
    }
    return out;
  }

  function collectAttrSources() {
    var out = [];
    var selectorParts = [];
    for (var i = 0; i < HASH_ATTRS.length; i++) {
      // data-magnet is included here as well: collectAnchors() only looks at the
      // attribute on <a>, and the hash set upstream collapses any overlap.
      selectorParts.push("[" + HASH_ATTRS[i] + "]");
    }
    var nodes = doc().querySelectorAll(selectorParts.join(","));
    for (var n = 0; n < nodes.length; n++) {
      var node = nodes[n];
      if (isExcluded(node)) continue;
      var found = null;
      for (var a = 0; a < HASH_ATTRS.length; a++) {
        var attr = node.getAttribute(HASH_ATTRS[a]);
        if (!attr) continue;
        found = coerceMagnet(attr, { trackers: settings.trackers });
        if (found) break;
      }
      if (!found) continue;
      var item = makeMagnetItem("attr", { magnet: found, origin: "attr" });
      if (item) out.push({ item: item, node: node });
    }
    return out;
  }

  function collectCustomSelectors(opts) {
    var out = [];
    if (!opts || !opts.customSelectors || !String(opts.customSelectors).trim()) return out;
    var parts = String(opts.customSelectors)
      .split(/[\n,]+/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      var nodes;
      try {
        nodes = doc().querySelectorAll(parts[i]);
      } catch (e) {
        continue;
      }
      for (var n = 0; n < nodes.length; n++) {
        var node = nodes[n];
        if (isExcluded(node)) continue;
        var text = node.textContent || "";
        var hint = extractMagnetHint(text);
        var magnet = hint;
        var kind = "text";
        if (!magnet) {
          var hits = scanHashesInText(text, { hex40: true, base32: opts.base32, v2: opts.v2 });
          if (hits.length) {
            magnet = buildMagnet(hits[0].hash, { trackers: settings.trackers });
            kind = hits[0].kind;
          }
        }
        if (!magnet) continue;
        var item = makeMagnetItem(kind, { magnet: magnet, origin: "selector" });
        if (item) out.push({ item: item, node: node });
      }
    }
    return out;
  }

  function scan() {
    var opts = detectOptions();
    var counts = { found: 0, injected: 0, exchanges: 0, seenTotal: runtime.counts.found || 0 };
    if (!doc().body) return counts;

    var inject = siteEnabled();
    var allowDuplicate = settings.allowDuplicate === true;
    // Per-source collection dedupes this pass; pageSeen is the long-lived memory that
    // makes repeated scans idempotent (a rescan must not stack a second button on a
    // hash that already has one).
    var seen = Object.create(null);
    runtime.pageSeen = runtime.pageSeen || Object.create(null);
    var jobs = [];

    function take(item, entry) {
      if (!item) return;
      if (seen[item.hash]) return;
      seen[item.hash] = true;
      if (runtime.pageSeen[item.hash] && !allowDuplicate) return;
      runtime.pageSeen[item.hash] = true;
      jobs.push(entry(item));
    }

    var anchors = collectAnchors();
    for (var i = 0; i < anchors.length; i++) {
      (function (entry) {
        take(entry.item, function (item) {
          return { item: item, mode: "anchor", node: entry.node };
        });
      })(anchors[i]);
    }

    var attrs = collectAttrSources();
    for (var k = 0; k < attrs.length; k++) {
      (function (entry) {
        take(entry.item, function (item) {
          return { item: item, mode: "node", node: entry.node };
        });
      })(attrs[k]);
    }

    var customs = collectCustomSelectors(opts);
    for (var c = 0; c < customs.length; c++) {
      (function (entry) {
        take(entry.item, function (item) {
          return { item: item, mode: "node", node: entry.node };
        });
      })(customs[c]);
    }

    if (opts.hex40 || opts.base32 || opts.v2) {
      walkTextNodes(doc().body, function (textNode) {
        if (!textNode.nodeValue || textNode.nodeValue.length < 32) return;
        if (isExcluded(textNode)) return;
        var textHits = scanHashesInText(textNode.nodeValue, opts);
        for (var h = 0; h < textHits.length; h++) {
          var hit = textHits[h];
          take(makeMagnetItem(hit.kind, { hash: hit.hash, kind: hit.kind, origin: "text" }), function (item) {
            return {
              item: item,
              mode: "text",
              node: textNode,
              start: hit.index,
              length: hit.length,
            };
          });
        }
      });
    }

    counts.exchanges = jobs.length;
    counts.found = counts.seenTotal + jobs.length;
    if (!inject) {
      reportScan(counts);
      return counts;
    }

    var budget = settings.maxButtonsPerPage;
    for (var j = 0; j < jobs.length; j++) {
      var job = jobs[j];
      if (counts.injected >= budget) break;
      var button = createInlineButton(job.item);
      var ok = false;
      if (job.mode === "text") ok = splitAndInsert(job.node, job.start, job.length, button);
      else ok = anchorButton(job.node, button);
      if (ok) {
        if (job.mode === "anchor" && job.node.dataset) job.node.dataset.m2qDone = "1";
        counts.injected++;
      }
    }
    reportScan(counts);
    return counts;
  }

  function collectPageMagnets() {
    var opts = detectOptions();
    var anchors = collectAnchors();
    var attrs = collectAttrSources();
    var all = [];
    for (var i = 0; i < anchors.length; i++) all.push(anchors[i].item);
    for (var k = 0; k < attrs.length; k++) all.push(attrs[k].item);
    var customs = collectCustomSelectors(opts);
    for (var c = 0; c < customs.length; c++) all.push(customs[c].item);
    walkTextNodes(doc().body, function (textNode) {
      if (!textNode.nodeValue || textNode.nodeValue.length < 32) return;
      if (isExcluded(textNode)) return;
      var hits = scanHashesInText(textNode.nodeValue, opts);
      for (var h = 0; h < hits.length; h++) {
        all.push({ hash: hits[h].hash, kind: hits[h].kind, origin: "text" });
      }
    });
    return dedupeMagnets(all, { trackers: settings.trackers });
  }

  // Re-runs detection while keeping the per-page memory, so already-decorated
  // hashes are never given a second button.
  function rescanPage() {
    return scan();
  }

  function sendAllOnPage() {
    var items = collectPageMagnets();
    if (!items.length) {
      toast("本页没有识别到磁力链接或 infohash", "warn");
      return;
    }
    var known = runtime.counts.sent || 0;
    toast("正在发送 " + items.length + " 个磁力链接…", "info");
    sendMagnets(items).then(function (result) {
      if (result && result.ok) runtime.counts.sent = known + result.sent;
    });
  }

  // ---------------------------------------------------------------- scheduling

  // Galleries reflow when images finish loading, which moves inline buttons away
  // from the hash text. Re-scan once the page has settled.
  function rescanAfterImages() {
    if (!settings.autoScan || typeof doc().addEventListener !== "function") return;
    if (runtime.imagesHooked) return;
    runtime.imagesHooked = true;
    var pending = false;
    var onLoad = function (event) {
      var target = event && event.target;
      if (!target || String(target.tagName).toUpperCase() !== "IMG") return;
      pending = true;
      setTimeout(function () {
        pending = false;
        scheduleScan(400);
      }, 400);
    };
    doc().addEventListener("load", onLoad, true);
  }

  function scheduleScan(delay) {
    if (runtime.scanTimer) clearTimeout(runtime.scanTimer);
    runtime.scanTimer = setTimeout(function () {
      runtime.scanTimer = null;
      try {
        scan();
      } catch (e) {
        logWarn("扫描出错", e);
      }
    }, typeof delay === "number" ? delay : 250);
  }

  function observe() {
    if (!settings.autoScan || typeof MutationObserver !== "function") return;
    var pending = false;
    runtime.observer = new MutationObserver(function (records) {
      var relevant = false;
      for (var i = 0; i < records.length && !relevant; i++) {
        var record = records[i];
        if (record.target && record.target.nodeType === 1 && record.target.closest && record.target.closest("[" + UI_ATTR + "]")) continue;
        var added = record.addedNodes || [];
        for (var a = 0; a < added.length; a++) {
          var node = added[a];
          if (!node || node.nodeType !== 1) continue;
          // Ignore our own injections, otherwise every button we add would schedule
          // another scan and the observer would feed itself forever.
          if (node.hasAttribute && node.hasAttribute(UI_ATTR)) continue;
          relevant = true;
          break;
        }
      }
      if (!relevant || pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        scheduleScan(200);
      }, 200);
    });
    runtime.observer.observe(doc().body, { childList: true, subtree: true });
  }

  function patchHistory() {
    if (runtime.historyPatched) return;
    var hist = typeof history !== "undefined" && history ? history : null;
    if (!hist) return;
    runtime.historyPatched = true;
    var wrap = function (name) {
      var original = hist[name];
      if (typeof original !== "function") return;
      hist[name] = function () {
        var result = original.apply(this, arguments);
        scheduleScan(300);
        return result;
      };
    };
    wrap("pushState");
    wrap("replaceState");
    win().addEventListener("popstate", function () {
      scheduleScan(300);
    });
  }

  // ------------------------------------------------------------ floating menu

  function floatLayer() {
    if (runtime.floatRoot) return runtime.floatRoot;
    var layer = mountUi();
    runtime.floatRoot = layer;
    return layer;
  }

  function applyFloatPos(node) {
    if (settings.floatPos) {
      node.style.left = settings.floatPos.x + "px";
      node.style.top = settings.floatPos.y + "px";
      node.style.right = "auto";
      node.style.bottom = "auto";
    }
  }

  function makeDraggable(node, handle) {
    var start = null;
    var moved = false;
    handle.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) return;
      var rect = node.getBoundingClientRect();
      start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      moved = false;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (e) {
        /* ignore */
      }
    });
    handle.addEventListener("pointermove", function (event) {
      if (!start) return;
      var dx = event.clientX - start.x;
      var dy = event.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      node.style.left = Math.max(4, Math.min(win().innerWidth - 44, start.left + dx)) + "px";
      node.style.top = Math.max(4, Math.min(win().innerHeight - 44, start.top + dy)) + "px";
      node.style.right = "auto";
      node.style.bottom = "auto";
    });
    var end = function (event) {
      if (!start) return;
      start = null;
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (e) {
        /* ignore */
      }
      if (!moved) return;
      var rect = node.getBoundingClientRect();
      settings.floatPos = { x: Math.round(rect.left), y: Math.round(rect.top) };
      saveSettingsLocal();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    return function () {
      return moved;
    };
  }

  function closeFloatMenu() {
    if (runtime.floatMenu && runtime.floatMenu.parentNode) runtime.floatMenu.parentNode.removeChild(runtime.floatMenu);
    runtime.floatMenu = null;
  }

  function menuItem(text, onClick) {
    var node = el("div", { class: "m2q-menu-item", text: text });
    node.addEventListener("click", function () {
      closeFloatMenu();
      onClick();
    });
    return node;
  }

  function updateFloatButtonState() {
    if (!runtime.floatBtn) return;
    var enabled = siteEnabled();
    runtime.floatBtn.classList.toggle("is-off", !enabled);
    runtime.floatBtn.title = enabled
      ? "Magnet2qB 菜单（本站已启用，分类：" + (currentCategory() || "无") + "）"
      : "Magnet2qB 菜单（本站未启用，点击可启用）";
  }

  function createFloatingButton() {
    if (runtime.floatBtn) return;
    var layer = floatLayer();
    var btn = el("div", { class: "m2q-float", title: "Magnet2qB 菜单" });
    btn.appendChild(el("span", { class: "m2q-float-icon", text: "⚙" }));
    btn.appendChild(el("span", { class: "m2q-float-dot" }));
    layer.root.appendChild(btn);
    runtime.floatBtn = btn;
    var wasDragged = makeDraggable(btn, btn);
    applyFloatPos(btn);
    updateFloatButtonState();

    btn.addEventListener("click", function (event) {
      if (wasDragged()) return;
      event.stopPropagation();
      if (runtime.floatMenu) {
        closeFloatMenu();
        return;
      }
      showFloatMenu();
    });
  }

  // Anchor the popup to the button and keep it fully inside the viewport, so a
  // dragged button near an edge does not push its own menu off screen.
  function positionFloatMenu(menu) {
    var btn = runtime.floatBtn;
    if (!btn || !btn.getBoundingClientRect) return;
    var rect = btn.getBoundingClientRect();
    var width = menu.offsetWidth || 240;
    var height = menu.offsetHeight || 260;
    var viewportWidth = win().innerWidth || 1280;
    var viewportHeight = win().innerHeight || 800;
    var left = rect.left + rect.width - width;
    var top = rect.top - height - 10;
    if (top < 8) top = rect.bottom + 10;
    left = Math.max(8, Math.min(left, viewportWidth - width - 8));
    top = Math.max(8, Math.min(top, viewportHeight - height - 8));
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.right = "auto";
    menu.style.bottom = "auto";
  }

  function showFloatMenu() {
    var layer = floatLayer();
    var count = runtime.counts.found;
    var enabled = siteEnabled();
    var menu = el("div", { class: "m2q-menu" });
    menu.appendChild(el("div", { class: "m2q-menu-head", text: "Magnet2qB v" + SCRIPT_VERSION }));
    menu.appendChild(
      el("div", {
        class: "m2q-menu-sub",
        text: currentHost() + " · " + (enabled ? "已启用" : "未启用") + " · " + (currentCategory() || "无分类"),
      })
    );
    menu.appendChild(menuItem("⚙ 打开设置", openSettings));
    menu.appendChild(menuItem("⚡ 发送本页全部磁力" + (count > 1 ? " (" + count + ")" : ""), sendAllOnPage));
    menu.appendChild(menuItem("🔄 重新扫描本页", function () {
      rescanPage();
      toast("已重新扫描", "info");
    }));
    menu.appendChild(menuItem("🔌 测试 qB 连接", function () {
      testConnectionQuick();
    }));
    menu.appendChild(
      menuItem(enabled ? "🚫 在本站停用脚本" : "✅ 在本站启用脚本", function () {
        toggleSite();
      })
    );
    menu.appendChild(
      menuItem(settings.enableFloatingButton ? "🙈 隐藏悬浮按钮（设置里可恢复）" : "👁 显示悬浮按钮", function () {
        settings.enableFloatingButton = !settings.enableFloatingButton;
        saveSettingsLocal();
        applyFloatingVisibility();
      })
    );
    layer.root.appendChild(menu);
    runtime.floatMenu = menu;
    positionFloatMenu(menu);

    var close = function (ev) {
      if (menu.contains(ev.target) || ev.target === runtime.floatBtn) return;
      closeFloatMenu();
      doc().removeEventListener("click", close, true);
    };
    setTimeout(function () {
      doc().addEventListener("click", close, true);
    }, 0);
    win().setTimeout(function () {
      doc().removeEventListener("click", close, true);
    }, 20000);
  }

  function applyFloatingVisibility() {
    if (!runtime.floatBtn) return;
    runtime.floatBtn.style.display = settings.enableFloatingButton ? "" : "none";
  }

  function toggleSite() {
    var host = currentHost();
    if (!host) return;
    if (isDisabledOn(host, settings.disabledDomains)) {
      settings.disabledDomains = settings.disabledDomains.filter(function (entry) {
        return host.indexOf(entry) === -1;
      });
      toast("已在本站启用（" + host + "）", "ok");
    } else if (isDomainAllowed(host, settings.rules)) {
      settings.rules = settings.rules.filter(function (rule) {
        return !ruleMatches(rule, host);
      });
      if (settings.rules.length === 0 && (settings.domains || "").trim()) {
        // keep the legacy string in sync so old tooling still sees the change
        settings.domains = rulesToString(settings.rules);
      }
      if (!isDomainAllowed(host, settings.rules)) {
        settings.disabledDomains = normalizeDisabled(settings.disabledDomains.concat([host]));
      }
      toast("已在本站停用（" + host + "）", "warn");
    } else {
      settings.rules = settings.rules.concat([{ domain: host, category: settings.category || "", regex: false }]);
      settings.domains = rulesToString(settings.rules);
      toast("已在本站启用（" + host + "），分类：" + (settings.category || "无"), "ok");
    }
    saveSettingsLocal();
    updateFloatButtonState();
    location.reload();
  }

  function testConnectionQuick() {
    toast("正在测试 qBittorrent 连接…", "info");
    apiVersion().then(function (res) {
      var err = apiErrorText(res.status, res.body);
      if (err) {
        toast("❌ " + err, "error");
        return;
      }
      toast("✅ 连接成功，qBittorrent " + String(res.body).trim(), "ok");
    });
  }

  // ------------------------------------------------------------ settings panel

  function openSettings() {
    closeFloatMenu();
    if (runtime.panel) closeSettings();
    var layer = mountUi();
    var overlay = el("div", { class: "m2q-overlay" });
    var panel = el("div", { class: "m2q-panel" });
    var head = el("div", { class: "m2q-head" });
    head.appendChild(
      el("div", {}, [
        el("div", { class: "m2q-title", text: "⚙️ Magnet2qB 设置" }),
        el("div", { class: "m2q-sub", text: "v" + SCRIPT_VERSION + " · " + currentHost() + " · " + (siteEnabled() ? "本站已启用" : "本站未启用") }),
      ])
    );
    var closeBtn = el("button", { class: "m2q-x", type: "button", text: "✕", title: "关闭 (Esc)" });
    closeBtn.addEventListener("click", closeSettings);
    head.appendChild(closeBtn);

    var tabs = el("div", { class: "m2q-tabs" });
    var body = el("div", { class: "m2q-body" });
    var foot = el("div", { class: "m2q-foot" });
    panel.appendChild(head);
    panel.appendChild(tabs);
    panel.appendChild(body);
    panel.appendChild(foot);
    overlay.appendChild(panel);
    layer.root.appendChild(overlay);

    var panelState = {
      layer: layer,
      overlay: overlay,
      panel: panel,
      // draft copy of the settings being edited in this panel session
      values: normalizeSettings(Object.assign({}, settings), defaults),
      rendered: false,
      err: el("div", { class: "m2q-err" }),
      dirty: false,
      active: "conn",
      tabs: tabs,
      body: body,
      foot: foot,
      status: null,
      categoriesRow: null,
      invalid: [],
      onKey: null,
    };
    runtime.panel = panelState;

    var tabDefs = [
      ["conn", "🔌 连接", renderConnTab],
      ["cats", "🗂 分类", renderCatsTab],
      ["rules", "🌐 域名规则", renderRulesTab],
      ["detect", "🎯 识别与外观", renderDetectTab],
      ["about", "🩺 诊断", renderAboutTab],
    ];
    var tabButtons = {};
    tabDefs.forEach(function (def) {
      var button = el("button", { class: "m2q-tab", type: "button", text: def[1] });
      button.addEventListener("click", function () {
        panelState.active = def[0];
        renderActive();
      });
      tabButtons[def[0]] = button;
      tabs.appendChild(button);
    });

    panelState.renderers = {};
    tabDefs.forEach(function (def) {
      panelState.renderers[def[0]] = def[2];
    });
    panelState.tabButtons = tabButtons;

    function renderActive() {
      // Capture whatever the outgoing tab had typed, so switching tabs never loses
      // edits (each tab is rendered on demand and would otherwise be discarded).
      if (panelState.rendered) collectFields();
      Object.keys(tabButtons).forEach(function (key) {
        tabButtons[key].classList.toggle("is-active", key === panelState.active);
      });
      body.innerHTML = "";
      panelState.err.textContent = "";
      panelState.invalid = [];
      panelState.rendered = true;
      (panelState.renderers[panelState.active] || renderConnTab)();
    }
    panelState.renderActive = renderActive;

    foot.appendChild(panelState.err);
    var spacer = el("div", { class: "m2q-spacer" });
    foot.appendChild(spacer);
    var testBtn = el("button", { class: "m2q-btn2", type: "button", text: "🔌 测试连接" });
    testBtn.addEventListener("click", function () {
      readForm();
      testConnection(testBtn);
    });
    var cancelBtn = el("button", { class: "m2q-btn2", type: "button", text: "取消" });
    cancelBtn.addEventListener("click", closeSettings);
    var saveBtn = el("button", { class: "m2q-btn2 is-primary", type: "button", text: "保存设置" });
    saveBtn.addEventListener("click", function () {
      saveForm();
    });
    foot.appendChild(testBtn);
    foot.appendChild(cancelBtn);
    foot.appendChild(saveBtn);

    panelState.onKey = function (event) {
      if (event.key === "Escape") {
        closeSettings();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === "s") {
        event.preventDefault();
        saveForm();
      }
    };
    doc().addEventListener("keydown", panelState.onKey, true);
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) closeSettings();
    });

    panelState.testBtn = testBtn;
    renderActive();

    // -- form plumbing -------------------------------------------------------

    function inputs() {
      return panelState.panel.querySelectorAll("[data-m2q-field]");
    }

    // Edits are accumulated in `values` so they survive tab switches: every tab
    // renders from the draft, and readForm() is a pure snapshot of it.
    function collectFields() {
      var list = inputs();
      for (var i = 0; i < list.length; i++) {
        var node = list[i];
        var key = node.getAttribute("data-m2q-field");
        if (node.type === "checkbox") panelState.values[key] = node.checked;
        else if (node.getAttribute("data-m2q-array") === "trackers") {
          panelState.values.trackers = normalizeTrackers(node.value);
        } else if (node.getAttribute("data-m2q-array") === "disabledDomains") {
          panelState.values.disabledDomains = normalizeDisabled(node.value);
        } else panelState.values[key] = node.value;
      }
    }

    function readForm() {
      collectFields();
      var values = Object.assign({}, panelState.values);
      if (panelState.rulesBox) values.rules = readRuleRows();
      return values;
    }

    function markInvalid(node, message) {
      panelState.invalid.push({ node: node, message: message });
      node.classList.add("is-invalid");
    }

    function clearInvalid() {
      panelState.invalid.forEach(function (entry) {
        entry.node.classList.remove("is-invalid");
      });
      panelState.invalid = [];
      panelState.err.textContent = "";
    }

    function showErrors() {
      if (!panelState.invalid.length) return;
      panelState.err.textContent = panelState.invalid[0].message;
      if (panelState.invalid[0].node.focus) {
        try {
          panelState.invalid[0].node.focus();
        } catch (e) {
          /* ignore */
        }
      }
    }

    function validate(values) {
      var errors = [];
      if (!isValidHostInput(values.host)) errors.push(["host", "qB 地址无效，示例：http://127.0.0.1:8080"]);
      var jsonError = extraParamsError(values.extraParams);
      if (jsonError) errors.push(["extraParams", "额外参数 JSON 错误：" + jsonError]);
      var rules = values.rules || [];
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (!rule.domain) continue;
        if (rule.regex) {
          try {
            new RegExp(rule.domain, "i");
          } catch (e) {
            errors.push(["rule:" + i, "第 " + (i + 1) + " 条规则的正则无效：" + (e && e.message)]);
          }
        }
      }
      if (values.customSelectors) {
        var parts = String(values.customSelectors)
          .split(/[\n,]+/)
          .map(function (s) {
            return s.trim();
          })
          .filter(Boolean);
        for (var s = 0; s < parts.length; s++) {
          try {
            doc().querySelector(parts[s]);
          } catch (e) {
            errors.push(["customSelectors", "自定义选择器无效：" + parts[s]]);
          }
        }
      }
      return errors;
    }

    function saveForm() {
      clearInvalid();
      var values = readForm();
      var errors = validate(values);
      var list = inputs();
      var byField = {};
      for (var i = 0; i < list.length; i++) {
        byField[list[i].getAttribute("data-m2q-field")] = list[i];
      }
      var ruleInputs = panelState.panel.querySelectorAll("[data-m2q-rule-input]");
      for (var e = 0; e < errors.length; e++) {
        var key = errors[e][0];
        if (key.indexOf("rule:") === 0) {
          var index = parseInt(key.slice(5), 10);
          if (ruleInputs[index]) markInvalid(ruleInputs[index], errors[e][1]);
          else panelState.invalid.push({ node: panelState.panel, message: errors[e][1] });
        } else if (byField[key]) markInvalid(byField[key], errors[e][1]);
        else panelState.invalid.push({ node: panelState.panel, message: errors[e][1] });
      }
      if (panelState.invalid.length) {
        showErrors();
        return;
      }
      var next = normalizeSettings(Object.assign({}, settings, values), defaults);
      next.domains = values.hasOwnProperty("rules") ? rulesToString(next.rules) : next.domains;
      settings = next;
      saveSettingsLocal();
      toast("✅ 设置已保存", "ok");
      closeSettings();
      if (settings.autoScan) scheduleScan(60);
      else if (doc().body) {
        scan();
      }
      updateFloatButtonState();
      applyFloatingVisibility();
    }
    panelState.readForm = readForm;
    panelState.saveForm = saveForm;

    // -- tab: connection -----------------------------------------------------

    function renderConnTab() {
      var draft = panelState.values;
      var hostInput = el("input", { class: "m2q-input", type: "text", value: draft.host });
      hostInput.setAttribute("data-m2q-field", "host");
      var userInput = el("input", { class: "m2q-input", type: "text", value: draft.username, autocomplete: "username" });
      userInput.setAttribute("data-m2q-field", "username");
      var passInput = el("input", { class: "m2q-input", type: "password", value: draft.password, autocomplete: "current-password" });
      passInput.setAttribute("data-m2q-field", "password");
      var showPass = el("input", { type: "checkbox" });
      showPass.addEventListener("change", function () {
        passInput.type = showPass.checked ? "text" : "password";
      });
      var passRow = el("div", { class: "m2q-row" }, [passInput, el("label", { class: "m2q-inline" }, [showPass, el("span", { text: "显示" })])]);

      var savepathInput = el("input", { class: "m2q-input", type: "text", value: draft.savepath, placeholder: "留空 = 使用 qB 默认保存路径" });
      savepathInput.setAttribute("data-m2q-field", "savepath");
      var tagsInput = el("input", { class: "m2q-input", type: "text", value: draft.tags, placeholder: "例如：anime,自动" });
      tagsInput.setAttribute("data-m2q-field", "tags");

      panelState.status = el("div", { class: "m2q-status", text: "尚未测试连接" });
      if (runtime.lastConnection) setConnectionStatus(runtime.lastConnection);

      body.appendChild(field("qBittorrent WebUI 地址", hostInput, "示例：http://127.0.0.1:8080 或 http://192.168.1.10:8080"));
      body.appendChild(field("用户名", userInput, "留空表示 qB 未开启认证"));
      body.appendChild(field("密码", passRow));
      body.appendChild(field("默认保存路径 savepath（可选）", savepathInput));
      body.appendChild(field("Tags 标签（可选）", tagsInput));
      body.appendChild(panelState.status);

      var note = el("div", { class: "m2q-note" });
      note.innerHTML =
        "<b>填完请点右下角「保存设置」。</b><br>" +
        "若测试连接提示网络错误：确认 qB 已开启 WebUI、开启「允许远程访问」并在 <code>工具 → 选项 → Web UI</code> 里关闭「仅允许本地主机」或把本站加入白名单。";
      body.appendChild(note);
    }

    function setConnectionStatus(info) {
      if (!panelState.status) return;
      panelState.status.innerHTML = "";
      var badgeClass = info.ok ? "m2q-pill is-ok" : "m2q-pill is-bad";
      panelState.status.appendChild(el("div", { class: badgeClass, text: info.ok ? "✅ 连接正常" : "❌ 连接失败" }));
      var lines = [];
      if (info.ok) {
        lines.push("qBittorrent 版本：" + (info.version || "未知"));
        lines.push("WebAPI 版本：" + (info.webapi || "未知"));
        lines.push("分类数量：" + (info.categories == null ? "未获取" : info.categories));
        if (info.warning) lines.push("⚠ " + info.warning);
      } else {
        lines.push(info.error || "未知错误");
      }
      panelState.status.appendChild(el("div", { class: "m2q-status-lines", text: lines.join("\n") }));
    }

    function testConnection(button) {
      var values = readForm();
      if (!isValidHostInput(values.host)) {
        panelState.err.textContent = "请先填写有效的 qB 地址，例如 http://127.0.0.1:8080";
        return;
      }
      var conn = {
        host: normalizeHostInput(values.host),
        username: values.username,
        password: values.password,
      };
      if (button) {
        button.disabled = true;
        button.textContent = "测试中…";
      }
      if (panelState.status) panelState.status.textContent = "正在测试…";
      var info = { ok: false };
      apiVersion(conn)
        .then(function (res) {
          var err = apiErrorText(res.status, res.body);
          if (err) {
            info.error = err;
            throw new Error(err);
          }
          info.ok = true;
          info.version = String(res.body).trim();
          return apiWebApiVersion(conn).then(
            function (r2) {
              if (r2.status === 200) info.webapi = String(r2.body).trim();
            },
            function () {
              /* optional endpoint */
            }
          );
        })
        .then(function () {
          return apiCategories(conn).then(
            function (res) {
              if (res.status !== 200) {
                info.warning = "分类列表获取失败（HTTP " + res.status + "）";
                return;
              }
              try {
                var list = categoriesFromPayload(JSON.parse(res.body));
                info.categories = list.length;
                runtime.categories = list;
                runtime.categoriesError = null;
              } catch (e) {
                info.warning = "分类接口返回的不是 JSON";
              }
            },
            function () {
              info.warning = "分类列表获取失败";
            }
          );
        })
        .then(function () {
          runtime.lastConnection = info;
          setConnectionStatus(info);
          if (info.ok) toast("✅ 连接成功：qBittorrent " + info.version, "ok");
          else toast("❌ " + info.error, "error");
        })
        .catch(function () {
          runtime.lastConnection = info;
          setConnectionStatus(info);
          toast("❌ " + (info.error || "连接失败"), "error");
        })
        .then(function () {
          if (button) {
            button.disabled = false;
            button.textContent = "🔌 测试连接";
          }
        });
    }
    panelState.testConnection = testConnection;

    // -- tab: categories -----------------------------------------------------

    function renderCategoryOptions(select) {
      var current = select.value;
      var options = [""];
      (runtime.categories || []).forEach(function (name) {
        if (options.indexOf(name) === -1) options.push(name);
      });
      if (current && options.indexOf(current) === -1) options.push(current);
      select.innerHTML = "";
      options.forEach(function (name) {
        var option = el("option", { value: name, text: name || "（不设置分类）" });
        select.appendChild(option);
      });
      select.value = current;
    }

    function renderCatsTab() {
      var select = el("select", { class: "m2q-input" });
      select.setAttribute("data-m2q-field", "category");
      renderCategoryOptions(select);
      select.value = panelState.values.category || "";
      panelState.categoriesRow = select;

      var note = el("div", { class: "m2q-hint", text: runtime.categories ? "已从 qBittorrent 读取 " + runtime.categories.length + " 个分类" : "尚未从 qB 读取分类（可在「连接」页测试连接后回来）" });
      var refresh = el("button", { class: "m2q-btn2", type: "button", text: "🔄 从 qB 重新读取分类" });
      refresh.addEventListener("click", function () {
        refresh.disabled = true;
        refresh.textContent = "读取中…";
        apiCategories()
          .then(function (res) {
            if (res.status !== 200) {
              toast("读取失败：" + (apiErrorText(res.status, res.body) || "未知错误"), "error");
              return;
            }
            var list = categoriesFromPayload(JSON.parse(res.body));
            runtime.categories = list;
            runtime.categoriesError = null;
            renderCategoryOptions(select);
            note.textContent = "已从 qBittorrent 读取 " + list.length + " 个分类";
            toast("✅ 已读取 " + list.length + " 个分类", "ok");
          })
          .catch(function () {
            toast("分类接口返回异常，请检查地址与认证", "error");
          })
          .then(function () {
            refresh.disabled = false;
            refresh.textContent = "🔄 从 qB 重新读取分类";
          });
      });

      body.appendChild(field("全局默认分类", select, "当前域名没有命中任何规则时使用"));
      body.appendChild(refresh);
      body.appendChild(note);

      var preview = el("div", { class: "m2q-note" });
      preview.innerHTML =
        "当前站点 <b>" +
        escapeHtml(currentHost()) +
        "</b> 命中结果：<b style='color:" +
        (siteEnabled() ? "#15803d" : "#b45309") +
        "'>" +
        (siteEnabled() ? "已启用" : "未启用") +
        "</b>，分类 <b>" +
        escapeHtml(currentCategory() || "（无）") +
        "</b>";
      body.appendChild(preview);
    }

    // -- tab: domain rules ---------------------------------------------------

    function readRuleRows() {
      var rows = panelState.panel.querySelectorAll("[data-m2q-rule-row]");
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var inputsInRow = rows[i].querySelectorAll("[data-m2q-rule-input]");
        var regexBox = rows[i].querySelector("[data-m2q-rule-regex]");
        var selectBox = rows[i].querySelector("[data-m2q-rule-cat]");
        var domain = inputsInRow[0] ? inputsInRow[0].value.trim() : "";
        if (!domain) continue;
        out.push({ domain: domain, category: selectBox ? selectBox.value.trim() : "", regex: !!(regexBox && regexBox.checked) });
      }
      return out;
    }

    function addRuleRow(rule) {
      var data = rule || { domain: "", category: "", regex: false };
      var row = el("div", { class: "m2q-rule" });
      row.setAttribute("data-m2q-rule-row", "");
      var domainInput = el("input", { class: "m2q-input", type: "text", value: data.domain, placeholder: "example.com" });
      domainInput.setAttribute("data-m2q-rule-input", "");
      var regexBox = el("input", { type: "checkbox" });
      regexBox.setAttribute("data-m2q-rule-regex", "");
      regexBox.checked = !!data.regex;
      var catSelect = el("select", { class: "m2q-input" });
      catSelect.setAttribute("data-m2q-rule-cat", "");
      var value = data.category == null ? "" : data.category;
      var options = [""].concat(runtime.categories || []);
      if (value && options.indexOf(value) === -1) options.push(value);
      options.forEach(function (name) {
        catSelect.appendChild(el("option", { value: name, text: name || "（用全局默认）" }));
      });
      catSelect.value = value;
      var del = el("button", { class: "m2q-x2", type: "button", text: "✕", title: "删除这条规则" });
      del.addEventListener("click", function () {
        row.parentNode.removeChild(row);
      });
      var regexLabel = el("label", { class: "m2q-inline", title: "勾选后该字段按正则表达式匹配" }, [regexBox, el("span", { text: "正则" })]);
      row.appendChild(domainInput);
      row.appendChild(regexLabel);
      row.appendChild(catSelect);
      row.appendChild(del);
      panelState.rulesBox.appendChild(row);
    }

    function renderRulesTab() {
      panelState.rulesBox = el("div", { class: "m2q-rules" });
      var headRow = el("div", { class: "m2q-rule is-head" }, [
        el("span", { text: "域名（留空则全部启用）" }),
        el("span", { text: "模式" }),
        el("span", { text: "分类" }),
        el("span", { text: "" }),
      ]);
      body.appendChild(headRow);
      body.appendChild(panelState.rulesBox);
      (panelState.values.rules || []).forEach(function (rule) {
        addRuleRow(rule);
      });

      var actions = el("div", { class: "m2q-actions" });
      var addBtn = el("button", { class: "m2q-btn2", type: "button", text: "＋ 添加规则" });
      addBtn.addEventListener("click", function () {
        addRuleRow({ domain: "", category: "", regex: false });
      });
      var hereBtn = el("button", { class: "m2q-btn2", type: "button", text: "📌 添加当前站点（" + currentHost() + "）" });
      hereBtn.addEventListener("click", function () {
        addRuleRow({ domain: currentHost(), category: settings.category || "", regex: false });
      });
      actions.appendChild(addBtn);
      actions.appendChild(hereBtn);
      body.appendChild(actions);

      var note = el("div", { class: "m2q-note" });
      note.innerHTML =
        "<b>匹配规则：</b>域名按“包含”匹配（<code>example</code> 能匹配 <code>example.com</code>），勾选「正则」后按正则表达式匹配。<br>" +
        "<b>空列表 = 所有网站都启用</b>；只要填了一条规则，就只有命中的网站会注入按钮（悬浮菜单始终可用，方便随时改设置）。<br>" +
        "分类留空表示“用全局默认分类”。";
      body.appendChild(note);
    }

    // -- tab: detection & appearance ----------------------------------------

    function renderDetectTab() {
      var trackersArea = el("textarea", { class: "m2q-input", rows: "6", placeholder: "每行一个 tracker，例如 udp://tracker.opentrackr.org:1337/announce" });
      trackersArea.value = (panelState.values.trackers || []).join("\n");
      trackersArea.setAttribute("data-m2q-field", "trackers");
      trackersArea.setAttribute("data-m2q-array", "trackers");

      var extraArea = el("textarea", { class: "m2q-input", rows: "3", placeholder: '{"paused": true, "skip_checking": false}' });
      extraArea.value = panelState.values.extraParams;
      extraArea.setAttribute("data-m2q-field", "extraParams");

      var selectorsArea = el("textarea", { class: "m2q-input", rows: "2", placeholder: "例如 .download-box, #magnet-area（逗号或换行分隔）" });
      selectorsArea.value = panelState.values.customSelectors;
      selectorsArea.setAttribute("data-m2q-field", "customSelectors");

      body.appendChild(el("div", { class: "m2q-section", text: "识别开关" }));
      body.appendChild(
        toggleRow("识别 <a href> 磁力链接", settings.detectMagnet, function (v) {
          settings.detectMagnet = v;
        }, "关闭后不再处理页面里现成的 magnet: 链接")
      );
      body.appendChild(
        toggleRow("识别 40 位十六进制 infohash（推荐）", settings.detectHex40, function (v) {
          settings.detectHex40 = v;
        }, "核心能力：只贴一串 hash、没有 magnet 链接的页面靠它出按钮")
      );
      body.appendChild(
        toggleRow("识别 32 位 base32 infohash", settings.detectBase32, function (v) {
          settings.detectBase32 = v;
        }, "少数站点使用；误报率略高，默认关闭")
      );
      body.appendChild(
        toggleRow("把 <a href=\"#hash\"> 当作磁力", settings.detectRawHash, function (v) {
          settings.detectRawHash = v;
        }, "某些站点把 hash 做成页内锚点")
      );

      body.appendChild(el("div", { class: "m2q-section", text: "行为与外观" }));
      body.appendChild(
        toggleRow("显示悬浮齿轮按钮", settings.enableFloatingButton, function (v) {
          settings.enableFloatingButton = v;
          applyFloatingVisibility();
        })
      );
      body.appendChild(
        toggleRow("内容变化时自动扫描", settings.autoScan, function (v) {
          settings.autoScan = v;
        }, "瀑布流/翻页站点建议开启")
      );
      body.appendChild(
        toggleRow("多于 1 个磁力时显示批量徽标", settings.batchButton, function (v) {
          settings.batchButton = v;
          updateBadge();
        })
      );
      body.appendChild(
        toggleRow("允许重复添加同一 hash", settings.allowDuplicate, function (v) {
          settings.allowDuplicate = v;
        })
      );

      var styleSelect = el("select", { class: "m2q-input" });
      [["chip", "📥 qB（推荐）"], ["plain", "qB（纯文字）"]].forEach(function (pair) {
        styleSelect.appendChild(el("option", { value: pair[0], text: pair[1] }));
      });
      styleSelect.value = panelState.values.buttonStyle;
      styleSelect.setAttribute("data-m2q-field", "buttonStyle");

      var maxInput = el("input", { class: "m2q-input", type: "number", min: "1", max: "5000", value: String(panelState.values.maxButtonsPerPage) });
      maxInput.setAttribute("data-m2q-field", "maxButtonsPerPage");
      body.appendChild(field("按钮样式", styleSelect));
      body.appendChild(field("每页最多注入按钮数", maxInput, "避免极端页面卡顿"));

      body.appendChild(el("div", { class: "m2q-section", text: "tracker 列表（用于把裸 hash 合成为 magnet）" }));
      body.appendChild(trackersArea);
      var hint = el("div", { class: "m2q-hint", text: "留空也合法，但冷门种子可能找不到 peer；公共 tracker 会失效，失效后自行替换即可。" });
      body.appendChild(hint);
      var reset = el("button", { class: "m2q-btn2", type: "button", text: "恢复默认 tracker 列表" });
      reset.addEventListener("click", function () {
        trackersArea.value = DEFAULT_TRACKERS.join("\n");
      });
      body.appendChild(reset);

      body.appendChild(el("div", { class: "m2q-section", text: "高级" }));
      body.appendChild(field("额外下载参数 (JSON)", extraArea, '直接透传给 /api/v2/torrents/add，例如 {"paused":true}'));
      body.appendChild(field("自定义选择器（可选）", selectorsArea, "命中这些元素的容器也会被扫描"));

      var disabledArea = el("textarea", { class: "m2q-input", rows: "2", placeholder: "每行一个域名，例如 example.com" });
      disabledArea.value = (panelState.values.disabledDomains || []).join("\n");
      disabledArea.setAttribute("data-m2q-field", "disabledDomains");
      disabledArea.setAttribute("data-m2q-array", "disabledDomains");
      body.appendChild(field("永久停用的域名", disabledArea, "这些域名即使命中规则也不注入按钮"));
    }

    // -- tab: diagnostics ----------------------------------------------------

    function renderAboutTab() {
      var versions = el("div", { class: "m2q-kv" });
      var lc = runtime.lastConnection;
      var lines = [
        ["脚本版本", SCRIPT_VERSION],
        ["当前域名", currentHost()],
        ["本站状态", siteEnabled() ? "已启用" : (isDisabledOn(currentHost(), settings.disabledDomains) ? "已手动停用" : "未命中规则")],
        ["当前分类", currentCategory() || "（无）"],
        ["识别开关", "magnet=" + (settings.detectMagnet ? "on" : "off") + " hex40=" + (settings.detectHex40 ? "on" : "off") + " base32=" + (settings.detectBase32 ? "on" : "off")],
        ["本页磁力 / 会话内已注入", runtime.counts.found + " / " + runtime.counts.injected],
        ["本页已发送", String(runtime.counts.sent || 0)],
        ["qB 地址", settings.host],
        ["认证", settings.username && settings.password ? "已设置（Basic）" : "未设置"],
        ["上次连接", lc ? (lc.ok ? "成功 · qB " + lc.version + " · WebAPI " + (lc.webapi || "?") : "失败 · " + lc.error) : "未测试"],
      ];
      lines.forEach(function (pair) {
        versions.appendChild(el("div", { class: "m2q-k", text: pair[0] }));
        versions.appendChild(el("div", { class: "m2q-v", text: pair[1] }));
      });
      body.appendChild(versions);

      var actions = el("div", { class: "m2q-actions" });
      var rescan = el("button", { class: "m2q-btn2", type: "button", text: "🔄 重新扫描本页" });
      rescan.addEventListener("click", function () {
        var result = rescanPage();
        toast("扫描完成：本页 " + result.found + " 个，本次新注入 " + result.injected + " 个", "info");
        if (panelState.renderActive) panelState.renderActive();
      });
      var sendAll = el("button", { class: "m2q-btn2", type: "button", text: "⚡ 发送本页全部磁力" });
      sendAll.addEventListener("click", function () {
        sendAllOnPage();
      });
      var copy = el("button", { class: "m2q-btn2", type: "button", text: "📋 复制诊断信息" });
      copy.addEventListener("click", function () {
        var text = [
          "Magnet2qB v" + SCRIPT_VERSION,
          "page=" + location.href,
          "host=" + currentHost(),
          "enabled=" + siteEnabled(),
          "rules=" + rulesToString(settings.rules),
          "disabled=" + (settings.disabledDomains || []).join("|"),
          "qb=" + settings.host,
          "qB version=" + (lc && lc.ok ? lc.version : "n/a"),
          "counts=" + JSON.stringify(runtime.counts),
          "ua=" + navigator.userAgent,
        ].join("\n");
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            function () {
              toast("诊断信息已复制", "ok");
            },
            function () {
              toast("复制失败，请手动选择文本", "error");
            }
          );
        } else {
          toast("当前环境不支持剪贴板 API", "warn");
        }
      });
      actions.appendChild(rescan);
      actions.appendChild(sendAll);
      actions.appendChild(copy);
      body.appendChild(actions);

      var note = el("div", { class: "m2q-note" });
      note.innerHTML =
        "<b>常见问题</b><br>" +
        "· <b>页面上没有按钮</b>：确认「本站状态 = 已启用」，再点「重新扫描本页」；若识别数为 0，说明页面里既没有 magnet 链接也没有 40 位 hash。<br>" +
        "· <b>点击后 qB 没反应</b>：先「测试连接」，403/401 通常是账号密码问题。<br>" +
        "· <b>地址用 localhost 时脚本连不上</b>：把 qB 地址改成 <code>http://127.0.0.1:8080</code> 试试。";
      body.appendChild(note);
    }

    // expose for external triggers
    runtime.panelApi = {
      renderActive: function () {
        renderActive();
      },
      setStatus: setConnectionStatus,
      testConnection: function () {
        testConnection(panelState.testBtn);
      },
    };
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function closeSettings() {
    var panel = runtime.panel;
    if (!panel) return;
    if (panel.onKey) doc().removeEventListener("keydown", panel.onKey, true);
    if (panel.overlay && panel.overlay.parentNode) panel.overlay.parentNode.removeChild(panel.overlay);
    runtime.panel = null;
  }

  // ------------------------------------------------------------------- styles

  var UI_CSS = `
:host, .m2q-root { all: initial; }
.m2q-root {
  --bg: #ffffff; --fg: #1f2937; --muted: #6b7280; --line: #e5e7eb;
  --field: #ffffff; --accent: #2563eb; --accent-fg: #ffffff; --soft: #f3f4f6;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 13px; line-height: 1.5; color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .m2q-root { --bg:#1e1f22; --fg:#e5e7eb; --muted:#9ca3af; --line:#33363b; --field:#26282c; --soft:#2a2d31; --accent:#3b82f6; }
}
.m2q-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 2147482000; display: flex; align-items: center; justify-content: center; padding: 16px; }
.m2q-panel { width: 660px; max-width: 100%; max-height: 86vh; background: var(--bg); border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,.45); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line); }
.m2q-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
.m2q-title { font-size: 15px; font-weight: 700; }
.m2q-sub { font-size: 12px; color: var(--muted); margin-top: 2px; word-break: break-all; }
.m2q-x, .m2q-x2 { background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 15px; border-radius: 6px; padding: 2px 8px; }
.m2q-x:hover, .m2q-x2:hover { background: var(--soft); color: var(--fg); }
.m2q-x2 { font-size: 12px; padding: 2px 6px; }
.m2q-tabs { display: flex; gap: 2px; padding: 8px 12px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.m2q-tab { background: transparent; border: 0; border-bottom: 2px solid transparent; color: var(--muted); padding: 7px 11px; cursor: pointer; font-size: 13px; border-radius: 6px 6px 0 0; font-family: inherit; }
.m2q-tab:hover { color: var(--fg); background: var(--soft); }
.m2q-tab.is-active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.m2q-body { padding: 14px 18px 18px; overflow: auto; flex: 1 1 auto; display: flex; flex-direction: column; gap: 12px; }
.m2q-field { display: flex; flex-direction: column; gap: 5px; }
.m2q-label { font-weight: 600; font-size: 12px; }
.m2q-hint { color: var(--muted); font-size: 11.5px; font-weight: 400; }
.m2q-input { width: 100%; box-sizing: border-box; background: var(--field); color: var(--fg); border: 1px solid var(--line); border-radius: 7px; padding: 7px 9px; font-size: 13px; font-family: inherit; }
.m2q-input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
.m2q-input.is-invalid { border-color: #dc2626; box-shadow: 0 0 0 1px #dc2626; }
textarea.m2q-input { resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.m2q-row { display: flex; gap: 8px; align-items: center; }
.m2q-row .m2q-input { flex: 1 1 auto; }
.m2q-inline { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 11.5px; white-space: nowrap; }
.m2q-toggle { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
.m2q-toggle:hover { background: var(--soft); }
.m2q-toggle input { margin-top: 2px; }
.m2q-toggle-text { display: flex; flex-direction: column; }
.m2q-section { font-weight: 700; font-size: 12px; color: var(--muted); margin-top: 6px; text-transform: uppercase; letter-spacing: .04em; }
.m2q-note { background: var(--soft); border-radius: 8px; padding: 10px 12px; font-size: 12px; color: var(--fg); }
.m2q-note code { background: rgba(127,127,127,.18); padding: 0 4px; border-radius: 4px; }
.m2q-status { display: flex; flex-direction: column; gap: 6px; }
.m2q-pill { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; width: fit-content; }
.m2q-pill.is-ok { background: #dcfce7; color: #15803d; }
.m2q-pill.is-bad { background: #fee2e2; color: #b91c1c; }
.m2q-status-lines { white-space: pre-line; color: var(--muted); font-size: 12px; }
.m2q-foot { display: flex; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--line); background: var(--soft); }
.m2q-spacer { flex: 1 1 auto; }
.m2q-err { color: #dc2626; font-size: 12px; max-width: 46%; }
.m2q-btn2 { background: var(--field); color: var(--fg); border: 1px solid var(--line); border-radius: 7px; padding: 7px 13px; cursor: pointer; font-size: 13px; font-family: inherit; }
.m2q-btn2:hover { background: var(--soft); }
.m2q-btn2.is-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
.m2q-btn2:disabled { opacity: .6; cursor: default; }
.m2q-rules { display: flex; flex-direction: column; gap: 8px; }
.m2q-rule { display: grid; grid-template-columns: 1fr auto 150px auto; gap: 8px; align-items: center; }
.m2q-rule.is-head { color: var(--muted); font-size: 11.5px; font-weight: 600; }
.m2q-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.m2q-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 12.5px; }
.m2q-k { color: var(--muted); }
.m2q-v { word-break: break-all; }
.m2q-chip-wrap { display: inline; }
.m2q-chip-wrap.is-block { display: block; margin: 6px 0; }
.m2q-btn { background: #16a34a; color: #fff; border: 0; border-radius: 5px; padding: 2px 8px; margin: 0 0 0 6px; font-size: 11.5px; font-family: inherit; line-height: 18px; cursor: pointer; vertical-align: middle; opacity: .88; transition: opacity .15s, transform .15s; }
.m2q-btn:hover { opacity: 1; }
.m2q-btn.is-busy { opacity: .55; cursor: progress; }
.m2q-btn.is-done { background: #2563eb; }
.m2q-float { position: fixed; right: 16px; bottom: 16px; width: 40px; height: 40px; border-radius: 50%; background: rgba(17,24,39,.72); color: #fff; display: flex; align-items: center; justify-content: center; cursor: grab; z-index: 2147482100; box-shadow: 0 3px 12px rgba(0,0,0,.35); user-select: none; touch-action: none; }
.m2q-float:hover { background: rgba(17,24,39,.9); }
.m2q-float-icon { font-size: 19px; line-height: 1; pointer-events: none; }
.m2q-float-dot { position: absolute; right: 3px; top: 3px; width: 9px; height: 9px; border-radius: 50%; background: #22c55e; border: 1.5px solid rgba(0,0,0,.35); pointer-events: none; }
.m2q-float.is-off .m2q-float-dot { background: #9ca3af; }
.m2q-menu { position: fixed; right: 16px; bottom: 64px; min-width: 232px; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.35); padding: 6px; z-index: 2147482101; }
.m2q-menu-head { font-weight: 700; padding: 6px 10px 2px; font-size: 12.5px; }
.m2q-menu-sub { color: var(--muted); font-size: 11.5px; padding: 0 10px 6px; border-bottom: 1px solid var(--line); margin-bottom: 4px; word-break: break-all; }
.m2q-menu-item { padding: 7px 10px; border-radius: 7px; cursor: pointer; font-size: 13px; }
.m2q-menu-item:hover { background: var(--soft); }
.m2q-badge { position: fixed; right: 16px; bottom: 64px; background: #2563eb; color: #fff; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 600; cursor: pointer; z-index: 2147482099; box-shadow: 0 3px 12px rgba(0,0,0,.3); }
.m2q-toast { position: fixed; right: 16px; bottom: 74px; max-width: min(420px, 86vw); background: var(--bg); color: var(--fg); border-left: 4px solid var(--tone, #2563eb); border-radius: 8px; padding: 9px 13px; box-shadow: 0 8px 26px rgba(0,0,0,.32); font-size: 12.5px; word-break: break-word; transition: opacity .3s, transform .3s; margin-top: 8px; }
.m2q-toast + .m2q-toast { margin-bottom: 0; }
@media (max-width: 560px) {
  .m2q-rule { grid-template-columns: 1fr; }
  .m2q-rule.is-head { display: none; }
  .m2q-err { display: none; }
  .m2q-body { padding: 12px; }
}
`;


  // ---------------------------------------------------------------------- init

  function init() {
    if (runtime.started) return;
    runtime.started = true;
    // Persist the normalised settings so a v2.1 install is migrated in place
    // (flat `domains` string -> structured rules) without the user opening the panel.
    saveSettingsLocal();
    try {
      if (settings.enableFloatingButton) createFloatingButton();
      else mountUi();
    } catch (e) {
      logWarn("悬浮按钮创建失败", e);
    }
    scheduleScan(80);
    observe();
    patchHistory();
    rescanAfterImages();
    if (typeof GM_registerMenuCommand === "function") {
      try {
        GM_registerMenuCommand("⚙️ Magnet2qB 设置", openSettings);
        GM_registerMenuCommand("🔄 重新扫描本页", rescanPage);
      } catch (e) {
        /* ignore */
      }
    }
    doc().addEventListener(
      "keydown",
      function (event) {
        if (event.altKey && String(event.key).toLowerCase() === "q") {
          event.preventDefault();
          openSettings();
        }
      },
      true
    );
    console.info(LOG_PREFIX + " v" + SCRIPT_VERSION + " 已加载 · 本站" + (siteEnabled() ? "已启用" : "未启用"));
  }

  if (doc().readyState === "loading") {
    doc().addEventListener("DOMContentLoaded", init, { once: true });
  } else if (doc().body) {
    init();
  } else {
    doc().addEventListener("DOMContentLoaded", init, { once: true });
  }
  if (boot) {
    boot.settings = settings;
    boot.defaults = defaults;
  }

  return {
    settings: settings,
    runtime: runtime,
    defaults: defaults,
    doc: doc,
    win: win,
    scan: scan,
    collectPageMagnets: collectPageMagnets,
    collectAnchors: collectAnchors,
    createInlineButton: createInlineButton,
    splitAndInsert: splitAndInsert,
    anchorButton: anchorButton,
    isExcluded: isExcluded,
    detectOptions: detectOptions,
    siteEnabled: siteEnabled,
    currentCategory: currentCategory,
    currentHost: currentHost,
    buildAddForm: buildAddForm,
    sendMagnets: sendMagnets,
    apiErrorText: apiErrorText,
    requestJson: requestJson,
    openSettings: openSettings,
    closeSettings: closeSettings,
    mountUi: mountUi,
    toast: toast,
    updateBadge: updateBadge,
    applyFloatingVisibility: applyFloatingVisibility,
    el: el,
    EXCLUDED_TAGS: EXCLUDED_TAGS,
    HASH_ATTRS: HASH_ATTRS,
  };
}

  // ==M2Q-SCANNER-END==

  var bootPayload = {
    // The block owns the live settings objects. Handing a payload in (and getting it
    // back out) keeps this scope from referring to names the block declares itself.
    settings: null,
    defaults: normalizeSettings({}, defaultSettings(SCRIPT_VERSION)),
    ready: true,
  };
  return scannerBlock({
    document: typeof document !== "undefined" ? document : undefined,
    window: typeof window !== "undefined" ? window : undefined,
    location: typeof location !== "undefined" ? location : undefined,
    NodeFilter: typeof NodeFilter !== "undefined" ? NodeFilter : undefined,
    exports: typeof exports !== "undefined" ? exports : undefined,
    module: typeof module !== "undefined" ? module : undefined,
    boot: bootPayload,
    settings: bootPayload.settings,
    defaults: bootPayload.defaults,
    SCRIPT_VERSION: SCRIPT_VERSION,
    LOG_PREFIX: LOG_PREFIX,
    STORE_KEY: STORE_KEY,
    UI_ATTR: UI_ATTR,
    normalizeSettings: normalizeSettings,
    isDisabledOn: isDisabledOn,
    isDomainAllowed: isDomainAllowed,
    getCategoryForDomain: getCategoryForDomain,
    rulesToString: rulesToString,
    parseDomainRules: parseDomainRules,
    normalizeDisabled: normalizeDisabled,
    normalizeTrackers: normalizeTrackers,
    scanHashesInText: scanHashesInText,
    buildMagnet: buildMagnet,
    coerceMagnet: coerceMagnet,
    enrichMagnet: enrichMagnet,
    extractMagnetHint: extractMagnetHint,
    makeMagnetItem: makeMagnetItem,
    dedupeMagnets: dedupeMagnets,
    normalizeHash: normalizeHash,
    hashFromMagnet: hashFromMagnet,
    parseExtraParams: parseExtraParams,
    extraParamsError: extraParamsError,
    describeHash: describeHash,
    isValidHostInput: isValidHostInput,
    normalizeHostInput: normalizeHostInput,
    apiErrorText: apiErrorText,
    isOkResponse: isOkResponse,
    joinApiPath: joinApiPath,
  });
})();
