/**
 * Minimal DOM shim -- just enough surface for the userscript's scanner.
 *
 * Deliberately dependency-free so the suite runs offline. It implements only:
 *   createElement / createTextNode / createDocumentFragment / createTreeWalker
 *   querySelectorAll / matches / closest   (type, #id, .class, [attr], [attr="v" i], :not(...),
 *                                           comma lists, descendant and ">" combinators)
 *   textContent (get/set) / nodeValue / dataset / insertBefore / removeChild
 *   Document.parse(html)
 *
 * Anything the scanner touches that is missing here is intentionally absent --
 * if production code starts needing more DOM API, this file must grow with it.
 */

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "\u00a9" };

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : whole;
  });
}

class ClassList {
  constructor(node) {
    this.node = node;
  }
  _list() {
    return String(this.node.getAttribute("class") || "")
      .split(/\s+/)
      .filter(Boolean);
  }
  contains(name) {
    return this._list().indexOf(name) !== -1;
  }
  add(...names) {
    const list = this._list();
    names.forEach((n) => {
      if (n && list.indexOf(n) === -1) list.push(n);
    });
    this.node.setAttribute("class", list.join(" "));
  }
  remove(...names) {
    this.node.setAttribute(
      "class",
      this._list()
        .filter((n) => names.indexOf(n) === -1)
        .join(" ")
    );
  }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : !!force;
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
  get value() {
    return this._list().join(" ");
  }
}

class MiniNode {
  constructor(type, name) {
    this.nodeType = type; // 1 = element, 3 = text, 11 = fragment
    this.nodeName = type === 1 ? String(name).toUpperCase() : type === 3 ? "#text" : "#document-fragment";
    this.tagName = type === 1 ? String(name).toUpperCase() : undefined;
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = null;
    this.attributes = new Map();
    this.nodeValue = type === 3 ? "" : null;
    this._listeners = Object.create(null);
    this.style = { cssText: "", setProperty() {}, removeProperty() {}, getPropertyValue: () => "" };
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }
  get nextSibling() {
    const siblings = this.parentNode ? this.parentNode.childNodes : [];
    const index = siblings.indexOf(this);
    return index === -1 ? null : siblings[index + 1] || null;
  }
  get previousSibling() {
    const siblings = this.parentNode ? this.parentNode.childNodes : [];
    const index = siblings.indexOf(this);
    return index <= 0 ? null : siblings[index - 1] || null;
  }

  get classList() {
    return new ClassList(this);
  }
  get className() {
    return this.getAttribute("class") || "";
  }
  set className(value) {
    this.setAttribute("class", value);
  }
  get id() {
    return this.getAttribute("id") || "";
  }
  get isContentEditable() {
    return this.hasAttribute("contenteditable");
  }
  get dataset() {
    if (!this._dataset) {
      const node = this;
      this._dataset = new Proxy(
        {},
        {
          get(_target, key) {
            const attr = "data-" + String(key).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
            const value = node.getAttribute(attr);
            return value == null ? undefined : value;
          },
          set(_target, key, value) {
            const attr = "data-" + String(key).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
            node.setAttribute(attr, String(value));
            return true;
          },
          has(_target, key) {
            const attr = "data-" + String(key).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
            return node.hasAttribute(attr);
          },
        }
      );
    }
    return this._dataset;
  }

  get textContent() {
    if (this.nodeType === 3) return this.nodeValue;
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.childNodes.forEach((child) => {
      child.parentNode = null;
    });
    this.childNodes = [];
    if (value !== "" && value != null) {
      const text = this.ownerDocument.createTextNode(String(value));
      this.appendChild(text);
    }
  }
  get innerHTML() {
    return this.textContent;
  }
  set innerHTML(html) {
    this.childNodes.forEach((child) => {
      child.parentNode = null;
    });
    this.childNodes = [];
    if (html) {
      const fragment = parseFragment(String(html), this.ownerDocument);
      while (fragment.firstChild) this.appendChild(fragment.firstChild);
    }
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    this.attributes.set(key, String(value));
    if (key === "style") this.style.cssText = String(value);
  }
  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }
  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  get value() {
    const live = this._live && this._live.value;
    if (live !== undefined) return live;
    const attr = this.getAttribute("value");
    return attr == null ? "" : attr;
  }
  set value(v) {
    this._live = this._live || {};
    this._live.value = String(v);
    this.setAttribute("value", String(v));
  }
  get checked() {
    const live = this._live && this._live.checked;
    if (live !== undefined) return live;
    return this.hasAttribute("checked");
  }
  set checked(v) {
    this._live = this._live || {};
    this._live.checked = !!v;
    if (v) this.setAttribute("checked", "");
    else this.removeAttribute("checked");
  }
  get type() {
    return this.getAttribute("type") || "text";
  }
  set type(v) {
    this.setAttribute("type", v);
  }
  get rows() {
    return this.getAttribute("rows") || "";
  }
  set rows(v) {
    this.setAttribute("rows", String(v));
  }
  get disabled() {
    return (this._live && this._live.disabled) || this.hasAttribute("disabled");
  }
  set disabled(v) {
    this._live = this._live || {};
    this._live.disabled = !!v;
  }

  appendChild(node) {
    if (!node) throw new Error("appendChild(null)");
    if (node.nodeType === 11) {
      while (node.firstChild) this.appendChild(node.firstChild);
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    node.ownerDocument = this.ownerDocument || node.ownerDocument;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, reference) {
    if (node.nodeType === 11) {
      while (node.firstChild) this.insertBefore(node.firstChild, reference);
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    node.parentNode = this;
    node.ownerDocument = this.ownerDocument || node.ownerDocument;
    if (index === -1) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index === -1) throw new Error("removeChild: node is not a child");
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  contains(node) {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  cloneNode() {
    throw new Error("cloneNode not implemented in the test shim");
  }

  addEventListener(type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners[type] || [];
    const index = list.indexOf(handler);
    if (index !== -1) list.splice(index, 1);
  }
  dispatchEvent(event) {
    const list = this._listeners[event.type] || [];
    list.slice().forEach((handler) => handler.call(this, event));
    return true;
  }
  click() {
    this.dispatchEvent({ type: "click", target: this, preventDefault() {}, stopPropagation() {} });
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  focus() {}

  querySelectorAll(selector) {
    const matcher = compileSelector(selector);
    const out = [];
    collect(this, matcher, out);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  matches(selector) {
    const matcher = compileSelector(selector);
    return matcher(this);
  }
  closest(selector) {
    const matcher = compileSelector(selector);
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (matcher(cur)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
}

class MiniDocument extends MiniNode {
  constructor() {
    super(11, "#document");
    this.ownerDocument = this;
    this.readyState = "complete";
  }
  createElement(tag) {
    const node = new MiniNode(1, tag);
    node.ownerDocument = this;
    return node;
  }
  createTextNode(value) {
    const node = new MiniNode(3, "#text");
    node.nodeValue = String(value);
    node.ownerDocument = this;
    return node;
  }
  createDocumentFragment() {
    const node = new MiniNode(11, "#document-fragment");
    node.ownerDocument = this;
    return node;
  }
  createTreeWalker(root, whatToShow = 4) {
    const nodes = [];
    if (whatToShow & 4) collectText(root, nodes);
    let index = -1;
    return {
      nextNode() {
        index += 1;
        return nodes[index] || null;
      },
      currentNode: null,
      root,
    };
  }
  get body() {
    return this.querySelector("body");
  }
  get documentElement() {
    return this.children[0] || null;
  }
  get defaultView() {
    return null;
  }
  getElementById(id) {
    return this.querySelector("#" + id);
  }
}

function collectText(node, out) {
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) out.push(child);
    else if (child.nodeType === 1) collectText(child, out);
  });
}

function collect(node, matcher, out) {
  node.childNodes.forEach((child) => {
    if (child.nodeType !== 1) return;
    if (matcher(child)) out.push(child);
    collect(child, matcher, out);
  });
}

// -- selector engine ---------------------------------------------------------

function splitTop(selector, delimiter) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    if (char === delimiter && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function compileCompound(compound, chain) {
  const trimmed = compound.trim();
  if (!trimmed) return () => false;
  const simple = [];
  const pattern = /(^[a-z*][a-z0-9-]*)|(#[\w-]+)|(\.[\w-]+)|(\[[^\]]+\])|(:not\([^)]*\))/gi;
  let match;
  while ((match = pattern.exec(trimmed)) !== null) {
    simple.push(match[0]);
  }
  return (node) => {
    for (const token of simple) {
      if (token === "*") continue;
      if (token[0] === "#") {
        if (node.getAttribute("id") !== token.slice(1)) return false;
      } else if (token[0] === ".") {
        if (!node.classList.contains(token.slice(1))) return false;
      } else if (token[0] === "[") {
        if (!attrMatches(node, token.slice(1, -1))) return false;
      } else if (/^:not\(/i.test(token)) {
        const inner = token.slice(5, -1);
        if (compileSelector(inner)(node)) return false;
      } else if (node.tagName !== token.toUpperCase()) return false;
    }
    return chain ? chain(node) : true;
  };
}

function attrMatches(node, body) {
  const m = body.match(/^([\w-]+)\s*(?:([~^$*|]?=)\s*"([^"]*)"\s*(i)?)?$/i);
  if (!m) return false;
  const [, name, operator, value, insensitive] = m;
  if (!node.hasAttribute(name)) return false;
  if (!operator) return true;
  let actual = node.getAttribute(name);
  const expected = insensitive ? String(value).toLowerCase() : String(value);
  if (insensitive) actual = actual.toLowerCase();
  if (operator === "=") return actual === expected;
  if (operator === "~=") return actual.split(/\s+/).indexOf(expected) !== -1;
  if (operator === "^=") return actual.startsWith(expected);
  if (operator === "$=") return actual.endsWith(expected);
  if (operator === "*=") return actual.indexOf(expected) !== -1;
  return false;
}

const selectorCache = new Map();

function compileSelector(selector) {
  const key = String(selector).trim();
  if (selectorCache.has(key)) return selectorCache.get(key);
  const groups = splitTop(key, ",").map((group) => {
    const descendant = splitTop(group.trim().replace(/\s*>\s*/g, " > "), " ").filter(Boolean);
    const chain = [];
    descendant.forEach((part) => {
      if (part === ">") {
        chain[chain.length - 1].direct = true;
        return;
      }
      chain.push({ compound: part, direct: false });
    });
    return chain.map((step, index) => ({ step, index }));
  });
  const matcher = (node) => {
    if (!node || node.nodeType !== 1) return false;
    return groups.some((chain) => {
      const last = chain[chain.length - 1];
      if (!last) return false;
      const lastMatcher = compileCompound(last.step.compound, null);
      if (!lastMatcher(node)) return false;
      let index = chain.length - 2;
      let current = node.parentNode;
      while (index >= 0 && current) {
        if (current.nodeType !== 1) {
          current = current.parentNode;
          continue;
        }
        const step = chain[index].step;
        if (compileCompound(step.compound, null)(current)) {
          index -= 1;
          current = current.parentNode;
          continue;
        }
        if (step.direct) return false;
        current = current.parentNode;
      }
      return index < 0;
    });
  };
  selectorCache.set(key, matcher);
  return matcher;
}

// -- parser ------------------------------------------------------------------

function parseAttributes(source) {
  const attributes = [];
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    if (!name || name === "/") continue;
    const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : "";
    attributes.push([name, decodeEntities(value)]);
  }
  return attributes;
}

function parseFragment(html, document) {
  const fragment = document.createDocumentFragment();
  const stack = [fragment];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      appendText(stack[stack.length - 1], html.slice(i), document);
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], html.slice(i, lt), document);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (/^<!doctype/i.test(html.slice(lt, lt + 9))) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    const close = html.indexOf(">", lt);
    if (close === -1) {
      appendText(stack[stack.length - 1], html.slice(lt), document);
      break;
    }
    const raw = html.slice(lt + 1, close);
    i = close + 1;
    if (raw[0] === "/") {
      const name = raw.slice(1).trim().toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth].nodeName.toLowerCase() === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const nameMatch = raw.match(/^([a-z0-9-]+)/i);
    if (!nameMatch) continue;
    const tag = nameMatch[1].toLowerCase();
    const element = document.createElement(tag);
    parseAttributes(raw.slice(nameMatch[1].length).replace(/\/$/, "")).forEach(([name, value]) => element.setAttribute(name, value));
    stack[stack.length - 1].appendChild(element);
    if (selfClosing || VOID_TAGS.has(tag)) continue;
    if (RAW_TEXT_TAGS.has(tag)) {
      const closer = html.toLowerCase().indexOf("</" + tag, i);
      const text = html.slice(i, closer === -1 ? html.length : closer);
      if (text) element.appendChild(document.createTextNode(decodeEntities(text)));
      if (closer === -1) {
        i = html.length;
      } else {
        const end = html.indexOf(">", closer);
        i = end === -1 ? html.length : end + 1;
      }
      continue;
    }
    stack.push(element);
  }
  return fragment;
}

function appendText(parent, text, document) {
  if (!text) return;
  parent.appendChild(document.createTextNode(decodeEntities(text)));
}

export function createDocument(html = "") {
  const document = new MiniDocument();
  const fragment = parseFragment(String(html), document);
  while (fragment.firstChild) document.appendChild(fragment.firstChild);
  return document;
}

export { MiniNode, MiniDocument, compileSelector };
