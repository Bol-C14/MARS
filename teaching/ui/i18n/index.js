// Interface languages (classroom 2026-11-03). Every visible text lives in a
// catalog under ui/i18n, keyed by where it is used; zh-CN is the reference
// and tests/i18n.test.js keeps every other catalog in step with it: the same
// keys, the same {placeholders}, and no Chinese left in the code itself.
//
// Messages: "{name}" inserts a parameter; "{n, plural, one {# step} other
// {# steps}}" picks a form by number, with # for the number. Braces that do
// not start a parameter name (a breakpoint log's {$t0}) stay as written.
//
// To add a language: copy en.json to <code>.json, translate every value,
// and add it to LANGUAGES below; the test lists anything missing.
import zhCN from "./zh-CN.json" with { type: "json" };
import en from "./en.json" with { type: "json" };

export const LANGUAGES = [
  { code: "zh-CN", name: "简体中文", messages: zhCN },
  { code: "en", name: "English", messages: en },
];
const REFERENCE = "zh-CN";
const STORE = "mars-trace:language";

// ?lang=pseudo: English made about 40% longer and marked, to find layouts
// that a longer language would break before anyone translates it.
const pseudo = (text) =>
  "⟦" + text.replace(/(\{[^{}]*\}|<[^>]*>)|[A-Za-z]+/g, (m, keep) => (keep ? m : m + "·".repeat(Math.ceil(m.length * 0.4)))) + "⟧";
let pseudoMessages = null;
function pseudoCatalog() {
  return (pseudoMessages ??= Object.fromEntries(Object.entries(en).map(([k, v]) => [k, v.includes("plural") ? v : pseudo(v)])));
}

function pick() {
  const known = (code) =>
    LANGUAGES.find((l) => l.code.toLowerCase() === String(code).toLowerCase()) ||
    LANGUAGES.find((l) => l.code.split("-")[0] === String(code).toLowerCase().split("-")[0]);
  try {
    const asked = new URLSearchParams(location.search).get("lang");
    if (asked === "pseudo") return "pseudo";
    if (asked && known(asked)) return known(asked).code;
  } catch {}
  try {
    const saved = localStorage.getItem(STORE);
    if (saved && known(saved)) return known(saved).code;
  } catch {}
  // The browser's language decides; anything we do not have reads English.
  for (const l of globalThis.navigator?.languages || [globalThis.navigator?.language || ""])
    if (/^zh\b/i.test(l)) return "zh-CN";
  return "en";
}

let current = pick();
const listeners = new Set();
const catalog = (code) => (code === "pseudo" ? pseudoCatalog() : LANGUAGES.find((l) => l.code === code)?.messages || {});

export const language = () => current;

export function setLanguage(code) {
  if (!LANGUAGES.some((l) => l.code === code) || code === current) return;
  current = code;
  try {
    localStorage.setItem(STORE, code);
  } catch {}
  if (globalThis.document) {
    document.documentElement.lang = code;
    applyDom();
  }
  for (const fn of listeners) fn(code);
}

/** Run `fn` after every language change (re-rendering what it drew). */
export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function plural(n, forms) {
  const rule = new Intl.PluralRules(current === "pseudo" ? "en" : current).select(Number(n));
  return (forms[rule] ?? forms.other ?? "").replace(/#/g, String(n));
}

// Parses one message; nested braces only occur inside plural forms.
export function format(message, params = {}) {
  let out = "",
    i = 0;
  while (i < message.length) {
    const open = message.indexOf("{", i);
    if (open < 0) break;
    const m = /^\{([A-Za-z_]\w*)(\s*,\s*plural\s*,)?/.exec(message.slice(open));
    if (!m) {
      out += message.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    out += message.slice(i, open);
    if (!m[2]) {
      const close = message.indexOf("}", open);
      out += params[m[1]] ?? "";
      i = close + 1;
      continue;
    }
    // {n, plural, one {...} other {...}}
    let j = open + m[0].length,
      depth = 1;
    const forms = {};
    while (j < message.length && depth > 0) {
      const sel = /^\s*([=\w]+)\s*\{/.exec(message.slice(j));
      if (!sel) {
        j = message.indexOf("}", j) + 1;
        depth--;
        break;
      }
      let k = j + sel[0].length,
        d = 1;
      const startText = k;
      while (k < message.length && d > 0) {
        if (message[k] === "{") d++;
        else if (message[k] === "}") d--;
        k++;
      }
      forms[sel[1]] = format(message.slice(startText, k - 1), params);
      j = k;
      const end = /^\s*\}/.exec(message.slice(j));
      if (end) {
        j += end[0].length;
        depth--;
      }
    }
    out += plural(params[m[1]], forms);
    i = j;
  }
  return out + message.slice(i);
}

/** The text for `key` in the current language, with `params` filled in. */
export function t(key, params) {
  let message = catalog(current)[key];
  if (message == null) message = catalog("en")[key] ?? catalog(REFERENCE)[key];
  if (message == null) {
    if (globalThis.console) console.warn("Missing text", key);
    return key;
  }
  return params || message.includes("{") ? format(message, params) : message;
}

/**
 * A table of texts built once per language: `build` runs again after a
 * language change, so code that keeps the table sees the new language.
 */
export function localized(build) {
  let cache, built;
  const now = () => (built === current ? cache : ((built = current), (cache = build())));
  return new Proxy(
    {},
    {
      get(_, k) {
        const target = now(),
          v = Reflect.get(target, k);
        return typeof v === "function" ? v.bind(target) : v;
      },
      has: (_, k) => k in now(),
      ownKeys: () => Reflect.ownKeys(now()).filter((k) => k !== "length"),
      getOwnPropertyDescriptor(_, k) {
        const d = Reflect.getOwnPropertyDescriptor(now(), k);
        return d && { ...d, configurable: true };
      },
    },
  );
}

/**
 * Static page text: an element with data-i18n="key" gets that text; for an
 * attribute, data-i18n-title, data-i18n-aria-label, data-i18n-placeholder
 * and data-i18n-tip (data-tip) name the key.
 */
const ATTRS = ["title", "aria-label", "placeholder", "tip"];
export function applyDom(root = globalThis.document) {
  if (!root) return;
  // data-i18n-params='{"n":3}' fills a message's parameters.
  const params = (el) => (el.dataset.i18nParams ? JSON.parse(el.dataset.i18nParams) : undefined);
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n, params(el));
  for (const a of ATTRS)
    for (const el of root.querySelectorAll(`[data-i18n-${a}]`)) {
      const name = a === "tip" ? "data-tip" : a;
      el.setAttribute(name, t(el.getAttribute(`data-i18n-${a}`)));
      if (a === "tip") delete el.dataset.tipBase;
    }
}

if (globalThis.document) document.documentElement.lang = current;
