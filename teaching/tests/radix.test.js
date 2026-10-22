import test from "node:test";
import assert from "node:assert/strict";
import { formatValue } from "../ui/radix.js";

const f = (n, o) => formatValue(n, o).text;

test("every mode carries its prefix", () => {
  assert.equal(f(898, { radix: "hex" }), "0x00000382");
  assert.equal(f(898, { radix: "dec" }), "0d898");
  assert.equal(f(898, { radix: "bin" }), "0b0011_1000_0010");
  assert.equal(formatValue(898, { radix: "bin" }).full, "0b0000_0000_0000_0000_0000_0011_1000_0010");
  assert.equal(f(72, { radix: "ascii" }), "'H'");
});

test("auto: small values in decimal, addresses and bit patterns in hex", () => {
  assert.equal(f(12), "0d12");
  assert.equal(f(-2), "0d-2");
  assert.equal(f(0x10010000), "0x10010000");
  assert.equal(f(4, { kind: "address" }), "0x00000004");
  assert.equal(f(0xff, { kind: "bits" }), "0x000000ff");
});

test("bytes and half-words respect their width and sign", () => {
  assert.equal(f(0xf0, { radix: "dec", width: 1 }), "0d-16");
  assert.equal(f(0xf0, { radix: "hex", width: 1 }), "0xf0");
  assert.equal(f(0xf0, { radix: "bin", width: 1 }), "0b1111_0000");
  assert.equal(f(0xfffe, { radix: "dec", width: 2 }), "0d-2");
});

test("ascii reads bytes in memory order and escapes the unprintable", () => {
  assert.equal(f(0x6948, { radix: "ascii" }), "'Hi'");
  assert.equal(f(0, { radix: "ascii", width: 1 }), "'\\0'");
  assert.equal(f(10, { radix: "ascii", width: 1 }), "'\\n'");
  assert.equal(f(0xfffffffe, { radix: "ascii" }), "'\\xfe\\xff\\xff\\xff'");
});

test("a printable byte gets a faint character note outside ascii mode only", () => {
  assert.equal(formatValue(72, { width: 1 }).note, "'H'");
  assert.equal(formatValue(72, { width: 1, radix: "ascii" }).note, "");
  assert.equal(formatValue(72).note, "");
  assert.equal(formatValue(7, { width: 1 }).note, "");
});

import { glossify } from "../ui/glossary.js";
test("glossary marks the first use of each term and escapes the rest", () => {
  const html = glossify("伪指令 <la> 展开为机器指令；伪指令再出现不重复标记");
  assert.equal((html.match(/<abbr/g) || []).length, 2);
  assert.match(html, /&lt;la&gt;/);
  assert.match(html, /title="汇编器提供的便捷写法/);
});

test("raw memory bytes use unsigned decimal while signed values keep their meaning", () => {
  for (const n of [0, 127, 128, 254, 255]) {
    assert.equal(f(n, { radix: "dec", width: 1, kind: "bits" }), `0d${n}`);
  }
  assert.equal(f(0xfffe, { radix: "dec", width: 2, kind: "bits" }), "0d65534");
  assert.equal(f(-1, { radix: "dec", kind: "bits" }), "0d4294967295");
  assert.equal(f(254, { radix: "dec", width: 1 }), "0d-2");
  assert.equal(f(-2, { radix: "dec" }), "0d-2");
});
