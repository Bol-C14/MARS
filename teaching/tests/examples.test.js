// Example projects (classroom 2026-11-04): one copy per interface language,
// told apart only by their comments. A failure names the example, the file
// and the first line where the code of two copies differs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LANGUAGES } from "../ui/i18n/index.js";

const ROOT = path.resolve(import.meta.dirname, "../examples");
const examples = fs.readdirSync(ROOT).filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory());
const codes = LANGUAGES.map((l) => l.code);

// A line without its comment: from the first # that is not inside quotes.
function code(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

test("there are examples, each with a title and a copy for every language", () => {
  assert.ok(examples.length > 0);
  for (const name of examples) {
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, name, "example.json"), "utf8"));
    for (const c of codes) {
      assert.ok(meta.title?.[c], `${name}: example.json has no title for ${c}`);
      assert.ok(fs.existsSync(path.join(ROOT, name, c)), `${name}: no ${c} copy`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, name, codes[0], meta.entry || "main.s")), `${name}: entry missing`);
  }
});

test("the copies of an example differ only in their comments", () => {
  for (const name of examples) {
    const [first, ...rest] = codes;
    const list = (c) => fs.readdirSync(path.join(ROOT, name, c)).sort();
    for (const c of rest) {
      assert.deepEqual(list(c), list(first), `${name}: ${c} has other files than ${first}`);
      for (const file of list(first)) {
        const read = (lang) => fs.readFileSync(path.join(ROOT, name, lang, file), "utf8");
        if (!/\.(s|asm)$/.test(file)) {
          assert.equal(read(c), read(first), `${name}/${file}: data files must be the same in every language`);
          continue;
        }
        const a = read(first).split("\n").map(code),
          b = read(c).split("\n").map(code);
        const at = a.findIndex((l, i) => l !== b[i]);
        assert.ok(at < 0 && a.length === b.length, `${name}/${file} line ${at + 1}: ${first} "${a[at]}" vs ${c} "${b[at]}"`);
      }
    }
  }
});

test("program text is ASCII: MARS keeps one byte per character", () => {
  for (const name of examples)
    for (const c of codes)
      for (const file of fs.readdirSync(path.join(ROOT, name, c)).filter((f) => /\.(s|asm)$/.test(f)))
        fs.readFileSync(path.join(ROOT, name, c, file), "utf8")
          .split("\n")
          .forEach((line, i) => assert.match(code(line), /^[\x00-\x7f]*$/, `${name}/${c}/${file} line ${i + 1}: non-ASCII outside a comment`));
});
