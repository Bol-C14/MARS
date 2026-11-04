// Keeps the interface languages in step (classroom 2026-11-03): every catalog
// has the reference's keys and {placeholders}; every key the code or the page
// uses exists, none is left unused; no Chinese is written into the code or
// the page outside the catalogs. A failure names what to add or change.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parsers } from "prettier/plugins/acorn";
import { LANGUAGES, format } from "../ui/i18n/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const HAN = /[\u3400-\u9fff]/;
// Chinese punctuation (、。：；（） and the like) left between messages would
// show in every language.
const WIDE = /[\u3001-\u303f\uff01-\uff5e]/;
const reference = LANGUAGES[0].messages;
const sources = ["ui", "ui/i18n"].flatMap((dir) =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(dir, f)),
);
// Each language is listed under its own name (简体中文) in every language.
const NAMES_ITS_LANGUAGES = path.join("ui", "i18n", "index.js");
const html = fs.readFileSync(path.join(ROOT, "web/index.html"), "utf8");

// Placeholder names. A language may use a plural form where the reference
// has a plain parameter ("{n} 个" / "{n, plural, one {# file} …}").
function placeholders(message) {
  const names = new Set();
  for (const m of message.matchAll(/\{([A-Za-z_]\w*)/g)) names.add(m[1]);
  return [...names].sort();
}

function walk(node, fn) {
  if (!node || typeof node.type !== "string") return;
  fn(node);
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "comments") continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn));
    else if (v && typeof v.type === "string") walk(v, fn);
  }
}

const used = new Map();
const chinese = [];
// Keys built from a fixed list (e.g. glossary terms) say so in code with a
// comment `i18n-keys: prefix.*`; keys under those prefixes count as used.
const prefixes = [];
for (const file of sources) {
  const code = fs.readFileSync(path.join(ROOT, file), "utf8");
  const own = [...code.matchAll(/i18n-keys: ([\w.]+)\*/g)].map((m) => m[1]);
  prefixes.push(...own);
  const ast = await parsers.acorn.parse(code, {});
  const line = (n) => code.slice(0, n.start).split("\n").length;
  const exempt = file === NAMES_ITS_LANGUAGES;
  walk(ast, (n) => {
    if (exempt) return;
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "t") {
      const [arg] = n.arguments;
      if (arg?.type === "Literal" && typeof arg.value === "string") used.set(arg.value, `${file}:${line(n)}`);
      // A file that declares its prefix may pass keys from its own table.
      else if (!(own.length && (arg?.type === "Identifier" || (arg?.type === "TemplateLiteral" && own.some((p) => arg.quasis[0].value.raw.startsWith(p))))))
        chinese.push(`${file}:${line(n)} t() needs a literal key or an i18n-keys prefix`);
    }
    // As written: an escape such as "\\uff1f" (accepting a full-width ? typed
    // with a Chinese input method) is not text shown to anyone.
    if (n.type === "Literal" && typeof n.value === "string" && (HAN.test(n.value) || WIDE.test(n.raw))) chinese.push(`${file}:${line(n)} ${n.value.slice(0, 40)}`);
    if (n.type === "TemplateElement" && (HAN.test(n.value.raw) || WIDE.test(n.value.raw))) chinese.push(`${file}:${line(n)} ${n.value.raw.slice(0, 40)}`);
    if (n.type === "Identifier" && HAN.test(n.name)) chinese.push(`${file}:${line(n)} ${n.name}`);
  });
}
// Keys used by the page.
for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.set(m[1], "web/index.html");

test("every catalog has exactly the reference keys", () => {
  for (const { code, messages } of LANGUAGES.slice(1)) {
    const missing = Object.keys(reference).filter((k) => !(k in messages));
    const extra = Object.keys(messages).filter((k) => !(k in reference));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${code}.json`);
  }
});

test("every catalog uses the reference placeholders", () => {
  for (const { code, messages } of LANGUAGES.slice(1))
    for (const [key, zh] of Object.entries(reference))
      if (key in messages) assert.deepEqual(placeholders(messages[key]), placeholders(zh), `${code}.json ${key}`);
});

test("no message is empty and plural forms have an other form", () => {
  for (const { code, messages } of LANGUAGES)
    for (const [key, text] of Object.entries(messages)) {
      assert.ok(String(text).trim(), `${code}.json ${key} is empty`);
      for (const m of String(text).matchAll(/\{\w+\s*,\s*plural\s*,(.*)/g)) assert.match(m[1], /\bother\s*\{/, `${code}.json ${key}`);
      assert.doesNotThrow(() => format(text, {}), `${code}.json ${key}`);
    }
});

test("every key used exists, and every key is used", () => {
  const unknown = [...used].filter(([k]) => !(k in reference)).map(([k, at]) => `${k} (${at})`);
  assert.deepEqual(unknown, [], "keys used but not in zh-CN.json");
  const unused = Object.keys(reference).filter((k) => !used.has(k) && !prefixes.some((p) => k.startsWith(p)));
  assert.deepEqual(unused, [], "keys in zh-CN.json that nothing uses");
});

test("no Chinese is written into the code", () => {
  assert.deepEqual(chinese, []);
});

test("the page's own text is marked and matches the reference", () => {
  // Text between tags, outside comments and scripts.
  const body = html.replace(/<!--[\s\S]*?-->/g, "");
  const problems = [];
  for (const m of body.matchAll(/<([a-z][\w-]*)((?:\s[^>]*)?)>([^<]*)/gi)) {
    const [, tag, attrs, text] = m;
    for (const a of attrs.matchAll(/([\w-]+)="([^"]*)"/g))
      if (HAN.test(a[2]) && !a[1].startsWith("data-i18n")) {
        const name = a[1] === "data-tip" ? "tip" : a[1];
        const key = new RegExp(`data-i18n-${name}="([^"]+)"`).exec(attrs)?.[1];
        if (!key) problems.push(`<${tag}> ${a[1]}="${a[2].slice(0, 30)}" has no data-i18n-${name}`);
        else if (reference[key] !== a[2]) problems.push(`${key}: page says "${a[2]}"`);
      }
    if (HAN.test(text)) {
      const key = /data-i18n="([^"]+)"/.exec(attrs)?.[1];
      if (!key) problems.push(`<${tag}> text "${text.trim().slice(0, 30)}" has no data-i18n`);
      else if (reference[key] !== text.trim()) problems.push(`${key}: page says "${text.trim()}"`);
    }
  }
  assert.deepEqual(problems, []);
});
