import test from "node:test";
import assert from "node:assert/strict";
import { Keymap, keyName, label, CHORD_MS } from "../ui/keymap.js";

const ev = (key, mods = {}, code) => ({
  key,
  code: code ?? (key.length === 1 && /[a-z]/i.test(key) ? "Key" + key.toUpperCase() : key),
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("VS Code debug keys map to IDE actions on both platforms", () => {
  for (const mac of [true, false]) {
    const k = new Keymap(mac),
      mod = mac ? { metaKey: true } : { ctrlKey: true };
    const act = (key, mods = {}, code) => k.handle(ev(key, mods, code)).action;
    assert.equal(act("F5"), "run");
    assert.equal(act("F5", { shiftKey: true }), "stop");
    assert.equal(act("F5", { ...mod, shiftKey: true }), "restart");
    assert.equal(act("F6"), "pause");
    assert.equal(act("F10"), "over");
    assert.equal(act("F11"), "source");
    assert.equal(act("F11", { altKey: true }), "step");
    assert.equal(act("F11", { shiftKey: true }), "out");
    assert.equal(act("F9", { shiftKey: true }), "back");
    assert.equal(act("Enter", mod), "assemble");
    assert.equal(act("p", mod), "quickOpen");
    assert.equal(act("P", { ...mod, shiftKey: true }), "commands");
    assert.equal(act("F1"), "commands");
    assert.equal(act("O", { ...mod, shiftKey: true }), "outline");
  }
});

test("navigation follows the platform: Ctrl+- on macOS, Alt+Arrow elsewhere", () => {
  const m = new Keymap(true),
    w = new Keymap(false);
  assert.equal(m.handle(ev("-", { ctrlKey: true }, "Minus")).action, "navBack");
  assert.equal(m.handle(ev("_", { ctrlKey: true, shiftKey: true }, "Minus")).action, "navForward");
  assert.equal(m.handle(ev("ArrowLeft", { altKey: true })).action, undefined);
  assert.equal(w.handle(ev("ArrowLeft", { altKey: true })).action, "navBack");
  assert.equal(w.handle(ev("ArrowRight", { altKey: true })).action, "navForward");
});

test("Cmd/Ctrl+K starts a chord; F completes focus mode, other keys or timeout explain the change", () => {
  const k = new Keymap(true);
  assert.deepEqual(k.handle(ev("k", { metaKey: true }), 0), { pending: true });
  assert.equal(k.handle(ev("f"), 500).action, "focus");
  k.handle(ev("k", { metaKey: true }), 1000);
  const other = k.handle(ev("x"), 1200);
  assert.equal(other.action, undefined);
  assert.equal(other.retiredKey, "Mod+K");
  k.handle(ev("k", { metaKey: true }), 2000);
  assert.equal(k.expire(2000 + CHORD_MS).retiredKey, "Mod+K");
  assert.equal(k.handle(ev("f"), 2000 + CHORD_MS + 1).action, undefined);
});

test("retired keys carry a hint; F9 now toggles breakpoints", () => {
  const k = new Keymap(false);
  assert.match(k.handle(ev("F7")).hint, /Alt\+F11/);
  assert.match(k.handle(ev("F8")).hint, /F10/);
  const f9 = k.handle(ev("F9"));
  assert.equal(f9.action, "breakpoint");
  assert.match(f9.hint, /F5/);
});

test("modifier-only presses are ignored and labels read naturally", () => {
  assert.equal(keyName(ev("Shift", { shiftKey: true }), true), null);
  assert.equal(label("Mod+Shift+P", true), "⌘⇧P");
  assert.equal(label("Mod+Shift+P", false), "Ctrl+Shift+P");
  assert.equal(label("Mod+K F", false), "Ctrl+K F");
  assert.equal(label("Ctrl+Shift+-", true), "⌃⇧-");
});
