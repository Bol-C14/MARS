// Keyboard bindings aligned with VS Code (DESIGN §3.9, P21). Pure: turns key
// events into action names; the IDE decides what each action does.

const navigation = (mac) =>
  mac
    ? [
        ["Ctrl+-", "navBack"],
        ["Ctrl+Shift+-", "navForward"],
      ]
    : [
        ["Alt+ArrowLeft", "navBack"],
        ["Alt+ArrowRight", "navForward"],
      ];

export function bindings(mac) {
  return new Map([
    ["F5", "run"],
    ["Shift+F5", "stop"],
    ["Mod+Shift+F5", "restart"],
    ["F6", "pause"],
    ["F10", "over"],
    ["F11", "source"],
    ["Alt+F11", "step"],
    ["Shift+F11", "out"],
    ["Shift+F9", "back"],
    ["F9", "breakpoint"],
    ["Mod+Enter", "assemble"],
    ["Mod+P", "quickOpen"],
    ["Mod+Shift+P", "commands"],
    ["F1", "commands"],
    ["Mod+Shift+O", "outline"],
    ["Mod+K F", "focus"],
    ...navigation(mac),
  ]);
}

// Keys whose meaning changed in the VS Code migration. Each hint is shown once.
export const retired = {
  F7: "机器单步已改为 Alt+F11（F11 为源码单步）",
  F8: "跨过调用已改为 F10",
  F9: "F9 现在切换断点；运行／继续改为 F5，暂停为 F6",
  "Alt+ArrowLeft": "回退一步已改为 Shift+F9",
  "Mod+K":
    "命令面板已改为 Cmd/Ctrl+Shift+P 或 F1；Cmd/Ctrl+K 现在是组合键前缀（如 Cmd/Ctrl+K F 进入专注模式）",
};

export function keyName(e, mac) {
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return null;
  const mod = mac ? e.metaKey : e.ctrlKey;
  const key = /^Key[A-Z]$/.test(e.code)
    ? e.code.slice(3)
    : e.code === "Minus"
      ? "-"
      : e.key.length === 1
        ? e.key.toUpperCase()
        : e.key;
  return [
    mod && "Mod",
    mac && e.ctrlKey && "Ctrl",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
}

// Display form for menus and tooltips.
export function label(binding, mac) {
  return binding
    .split(" ")
    .map((part) =>
      part
        .replace("Mod", mac ? "⌘" : "Ctrl")
        .replace("Shift", mac ? "⇧" : "Shift")
        .replace("Alt", mac ? "⌥" : "Alt")
        .replace("Ctrl+", mac ? "⌃" : "Ctrl+")
        .replace("ArrowLeft", "←")
        .replace("ArrowRight", "→")
        .replace(/\+/g, mac ? "" : "+"),
    )
    .join(" ");
}

export const CHORD_MS = 1500;

// Tracks the Cmd/Ctrl+K chord prefix between key presses.
export class Keymap {
  constructor(mac) {
    this.mac = mac;
    this.map = bindings(mac);
    this.pending = null;
  }
  // → { action?, pending?, hint?, retiredKey? } for one keydown.
  handle(e, now = Date.now()) {
    const name = keyName(e, this.mac);
    if (!name) return {};
    if (this.pending != null && now - this.pending < CHORD_MS) {
      this.pending = null;
      const action = this.map.get("Mod+K " + name.replace(/^Mod\+/, ""));
      return action
        ? { action }
        : { hint: retired["Mod+K"], retiredKey: "Mod+K" };
    }
    this.pending = null;
    if (name === "Mod+K") {
      this.pending = now;
      return { pending: true };
    }
    const action = this.map.get(name);
    const retiredKey = name in retired ? name : null;
    return {
      action,
      ...(retiredKey ? { hint: retired[retiredKey], retiredKey } : {}),
    };
  }
  // A chord that timed out without a second key.
  expire(now = Date.now()) {
    if (this.pending != null && now - this.pending >= CHORD_MS) {
      this.pending = null;
      return { hint: retired["Mod+K"], retiredKey: "Mod+K" };
    }
    return {};
  }
  find(action) {
    for (const [key, a] of this.map) if (a === action) return key;
    return null;
  }
}
