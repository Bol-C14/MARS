"""Browser acceptance for the teaching IDE: real key and mouse events through
Playwright against a private local server. Run from the repository root after
`sh teaching/scripts/build.sh`:  python3 teaching/tests/browser_acceptance.py
Exit 0 = all checks passed, 1 = a check failed, 2 = no usable browser."""
import glob, json, os, pathlib, re, socket, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("SKIP browser acceptance: Python Playwright is not installed")
    sys.exit(2)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def launch(p):
    """Playwright's own browser, else installed Chrome, else any cached Chromium."""
    attempts = [{}, {"channel": "chrome"}] + [
        {"executable_path": path}
        for path in sorted(glob.glob(os.path.expanduser(
            "~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/*.app/Contents/MacOS/*")), reverse=True)
        + sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome")), reverse=True)
    ]
    for kw in attempts:
        try:
            return p.chromium.launch(**kw)
        except Exception:
            continue
    print("SKIP browser acceptance: no Chromium/Chrome could be launched")
    sys.exit(2)


class Run:
    def __init__(self, page):
        self.page, self.passed = page, []

    def check(self, name, ok, detail=""):
        if not ok:
            raise AssertionError(f"{name} {detail}".strip())
        self.passed.append(name)

    def until(self, expression, arg=None, timeout=15000):
        self.page.wait_for_function(expression, arg=arg, timeout=timeout)

    def js(self, expression, arg=None):
        return self.page.evaluate(expression, arg)


def scenario(r, page, mod):
    state = lambda: r.js("() => window.marsIDE.state")
    r.until("() => window.marsIDE?.state?.status === 'paused'")

    # --- M1/M2 workflow (ported from the earlier smoke script) ---
    page.keyboard.press(f"{mod}+Shift+P")
    page.locator("#picker-input").press_sequentially("实线")
    r.check("command palette filters", page.locator("#picker-list .command-item").count() == 1)
    page.keyboard.press("Escape")

    page.select_option("#example", label="Hexadecimal · 位与字符")
    page.locator("#project-confirm").click()
    r.until("() => window.marsIDE.files['main.s']?.includes('Hex') && window.marsIDE.state?.step === 0")
    page.locator("#run").click()
    r.until("() => window.marsIDE.state?.status === 'waiting'")
    r.check("status chip says waiting for input", "等待输入" in page.locator("#status").inner_text())
    page.locator("#stdin").fill("898")
    page.locator("#input-form button").click()
    # Trial A4: submitting input resumes the interrupted run and echoes the input.
    r.until("() => window.marsIDE.state?.status === 'ended'")
    r.check("hexOut output", page.locator("#output").inner_text().endswith("00000382"))
    r.check("input is echoed in the console", page.locator("#output .echo").inner_text() == "898")
    r.check("status chip says ended", "已结束" in page.locator("#status").inner_text())
    ended = page.locator(".cm-inline-value").all_inner_texts()
    r.check("syscall lines show the service and what it did", "$v0 = 0d10 退出程序 → 程序结束" in ended, str(ended))
    page.locator("#back").click()
    r.until("() => window.marsIDE.state?.status === 'paused'")
    page.locator('[data-register="$v0"]').click()
    page.locator("#refs").click()
    r.check("register references", page.locator("[data-ref]").count() > 0)
    page.locator("#modal .close").click()
    page.locator("#clear-focus").click()

    page.select_option("#example", label="Task 1 · 文件与调用")
    page.locator("#project-confirm").click()
    r.until("() => window.marsIDE.program.instructions.some(i => i.file === 'task1.s') && window.marsIDE.state?.step === 0")
    address = r.js("() => window.marsIDE.program.instructions.find(i => i.file === 'task1.s' && i.line === 21).address")
    page.locator('[data-view="machine"]').click()
    page.locator(f'[data-machine-bp="{address}"]').click()
    page.locator("#run").click()
    r.until("(a) => window.marsIDE.state?.pc === a", address)
    chip = page.locator("#status").inner_text()
    r.check("breakpoint stop explained in Chinese", "停在断点前" in chip and "task1.s 第 21 行" in chip and "第 1 次" in chip, chip)
    r.check("no English stop reason in the banner", "Breakpoint" not in page.locator("#banner").inner_text())
    # Round 3: refreshing for focus mode must not erase why the machine stopped.
    page.keyboard.press(f"{mod}+K")
    page.keyboard.press("f")
    r.until("() => !document.getElementById('focus-lens').hidden")
    page.wait_for_timeout(300)
    r.check("opening focus mode keeps the breakpoint stop reason", "停在断点前" in page.locator("#status").inner_text(),
            page.locator("#status").inner_text())
    page.keyboard.press("Escape")
    r.js("(a) => window.marsIDE.gotoAddress(a)", address)
    page.locator("#step").click()
    r.until("() => window.marsIDE.state?.last.instruction.op === 'lbu'")
    page.locator(".overlay-settings summary").click()
    page.select_option("#relation-scope", "all")
    r.until("() => document.querySelectorAll('#overlay>path').length > 0")
    r.check("preview lines", page.locator("#overlay>path[stroke-dasharray]").count() > 0)
    page.locator("#dashed").uncheck()
    r.until("() => document.querySelectorAll('#overlay>path[stroke-dasharray]').length === 0")
    r.check("actual lines independent of preview", page.locator("#overlay>path").count() > 0)
    page.locator("#solid").uncheck()
    r.until("() => document.querySelectorAll('#overlay>path').length === 0")
    r.check("both layers off", True)
    page.locator("#solid").check()
    page.locator("#dashed").check()
    page.locator(".overlay-settings summary").click()
    page.locator("#zoom").click()
    page.set_viewport_size({"width": 1280, "height": 850})
    r.until("() => document.querySelectorAll('#overlay>path').length > 0")
    paths = r.js("() => [...document.querySelectorAll('#overlay>path')].map(p => p.getAttribute('d'))")
    r.check("finite overlay anchors after zoom/resize", all("NaN" not in p for p in paths))
    page.locator('[data-view="cfg"]').click()
    r.check("CFG blocks", page.locator(".block").count() > 1)
    page.locator('[data-view="source"]').click()
    page.locator('[data-bottom="trace"]').click()
    r.check("loop iteration groups", page.locator(".loop-history").count() > 0)
    page.locator("#add-watch").click()
    page.locator("#watch-target").fill("$t0")
    page.select_option("#watch-access", "read")
    page.locator("#watch-form button").click()
    page.locator("#run").click()
    r.until("() => window.marsIDE.state?.stopReason.includes('Watchpoint')")
    r.check("read watchpoint", True)
    r.js("() => document.querySelector('[data-watch]')?.click()")

    # --- M2.5: inline values ---
    r.check("inline execution values", page.locator(".cm-inline-value").count() > 0)

    # --- 2026-10-23 feedback: decisions inline, A−/A＋, splitters, one pulse ---
    inline = page.locator(".cm-inline-value").all_inner_texts()
    r.check("branch lines show the comparison and outcome", any("成立" in t or "跳到" in t for t in inline), str(inline))
    r.check("pseudo lines leave out the $at scratch value", not any("$at" in t for t in inline), str(inline))
    code_size = lambda: r.js("() => getComputedStyle(document.documentElement).getPropertyValue('--code').trim()")
    before = code_size()
    page.locator("#zoom-out").click()
    smaller = code_size()
    page.locator("#zoom").click()
    r.check("A− shrinks the code and A＋ grows it back", int(smaller[:-2]) == int(before[:-2]) - 1 and code_size() == before, f"{before} {smaller} {code_size()}")
    width = lambda: page.locator(".sidebar").bounding_box()["width"]
    start, line = width(), page.locator("#split-left").bounding_box()
    page.mouse.move(line["x"] + 0.5, line["y"] + 200)
    page.mouse.down()
    page.mouse.move(line["x"] + 60, line["y"] + 200, steps=4)
    page.mouse.up()
    dragged = width()
    page.locator("#split-left").dblclick()
    r.check("dragging a panel line resizes it; double-click restores", abs(dragged - start - 60) <= 2 and abs(width() - start) <= 1, f"{start} {dragged} {width()}")
    r.js("() => window.marsIDE.editor.focus()")
    for _ in range(3):
        page.keyboard.press("F11")
    page.wait_for_timeout(150)
    pulses = r.js("() => document.getAnimations().filter(a => a.effect?.target?.classList?.contains('cm-line') && a.playState === 'running' && a.effect.getKeyframes().some(k => 'background' in k || 'backgroundColor' in k)).map(a => a.effect.getTiming().iterations)")
    r.check("fast stepping leaves one single arrival pulse", pulses == [1] or pulses == [], str(pulses))

    # --- Trial C: read-only radix switch; code never changes (C2) ---
    code_before = r.js("() => window.marsIDE.editor.state.doc.toString()")
    for mode, prefix in (("hex", "0x"), ("bin", "0b"), ("dec", "0d"), ("ascii", "'")):
        page.select_option("#radix", mode)
        cell = page.locator('[data-register="$t0"] span').nth(1).inner_text()
        r.check(f"radix {mode} shows {prefix}", cell.startswith(prefix), cell)
    r.check("memory header names the cell radix", "字符" in page.locator("#mem-radix").inner_text())
    r.check("radix never rewrites code", r.js("() => window.marsIDE.editor.state.doc.toString()") == code_before)
    page.select_option("#radix", "auto")
    # C3: register names, not numbers, wherever machine statements appear.
    shown = page.locator("#last-card").inner_text() + page.locator("#next-card").inner_text() + page.locator("#trace").inner_text()
    r.check("machine statements use register names", not re.search(r"\$\d", shown), shown[:200])
    # C5: delay-slot nops are dimmed and say why.
    slot = page.locator(".cm-line.delay-nop").first
    r.check("delay-slot nop is marked", slot.count() > 0 and "延迟槽占位" in (slot.get_attribute("title") or ""))

    # --- Trial A: running is visible; demo follows across files and says so ---
    page.keyboard.press("Shift+F5")
    r.until("() => window.marsIDE.state?.step === 0")
    r.until("() => document.querySelector('.cm-editor').classList.contains('arrival-spotlight')", timeout=3000)
    r.check("spotlight marks where execution stopped after a jump", True)
    r.until("() => !document.querySelector('.cm-editor').classList.contains('arrival-spotlight')", timeout=3000)
    r.check("spotlight fades by itself", True)
    page.select_option("#demo-speed", "150")
    page.locator("#demo").click()
    r.until("() => document.getElementById('status').dataset.state === 'running'")
    r.check("status chip shows running during a demo", "运行中" in page.locator("#status").inner_text())
    notice = page.wait_for_function(
        "() => { const t = document.getElementById('banner').textContent; return t.startsWith('执行进入') && t }",
        timeout=30000).json_value()
    r.check("demo announces entering another file", any(f in notice for f in ("main.s", "task1.s", "libio.s")), notice)
    page.keyboard.press("F6")
    r.until("() => document.getElementById('status').dataset.state !== 'running'")
    r.check("pause ends the running state", "运行中" not in page.locator("#status").inner_text())


    # --- Round 2: breakpoints on label lines, step wording, ASCII table ---
    label_line = r.js("""() => { const d = window.marsIDE.editor.state.doc,
        file = document.querySelector('.tabs .active [data-tab]')?.textContent.replace(' •', '').trim(),
        has = (n) => window.marsIDE.program.instructions.some((i) => i.file === file && i.line === n);
        for (let i = 1; i < d.lines; i++)
          if (/^\\s*[A-Za-z_][\\w.]*:\\s*(#.*)?$/.test(d.line(i).text) && has(i + 1)) return i;
        return 0 }""")
    r.check("found a label line to test", label_line > 0)
    r.js("(n) => { const e = window.marsIDE.editor; e.dispatch({ selection: { anchor: e.state.doc.line(n).from } }); e.focus() }", label_line)
    bp_before = page.locator(".bp-row").count()
    page.keyboard.press("F9")
    r.check("F9 on a label line sets a breakpoint on its first instruction",
            page.locator(".bp-row").count() == bp_before + 1 and f"第 {label_line + 1} 行" in page.locator("#banner").inner_text(),
            page.locator("#banner").inner_text())
    r.js("(n) => { const e = window.marsIDE.editor; e.dispatch({ selection: { anchor: e.state.doc.line(n + 1).from } }); e.focus() }", label_line)
    page.keyboard.press("F9")
    r.check("the same breakpoint toggles off from its instruction line", page.locator(".bp-row").count() == bp_before)
    r.check("state reads as steps executed", page.locator("#location").inner_text().startswith("已执行"))
    page.locator("#radix-help").click()
    help_text = page.locator("#modal").inner_text()
    r.check("radix help opens with one number in every notation",
            page.locator("#modal .radix-example").inner_text().count("=") == 3, page.locator("#modal .radix-example").inner_text())
    r.check("radix help explains prefixes and lists characters", "0d" in help_text and "104" in help_text and "h" in help_text)
    page.locator("#modal .close").click()
    # Round 3: ASCII shows characters only for characters.
    page.select_option("#radix", "ascii")
    sp = page.locator('[data-register="$sp"]')
    r.check("ASCII falls back to decimal for a non-character", sp.locator("span").nth(1).inner_text().startswith("0d")
            and "不是可显示字符" in (sp.get_attribute("title") or ""))
    page.select_option("#radix", "auto")
    # Round 3: MARS's English text takes this line's operands.
    r.js("() => [...document.querySelectorAll('.tabs button')].find(b => b.textContent.trim() === 'task1.s')?.click()")
    point = r.js("""() => { const e = window.marsIDE.editor, d = e.state.doc;
        for (let i = 1; i <= d.lines; i++) { const k = d.line(i).text.indexOf('beqz $t0');
          if (k >= 0) { e.dispatch({ selection: { anchor: d.line(i).from + k }, scrollIntoView: true }); return i } } return 0 }""")
    page.wait_for_timeout(200)
    xy = r.js("""(n) => { const e = window.marsIDE.editor, l = e.state.doc.line(n), k = l.text.indexOf('beqz');
        const c = e.coordsAtPos(l.from + k + 1); return c && { x: c.left + 2, y: (c.top + c.bottom) / 2 } }""", point)
    page.mouse.move(xy["x"], xy["y"])
    r.until("() => !document.getElementById('tooltip').hidden", timeout=3000)
    tip = page.locator("#tooltip").inner_text()
    r.check("MARS description uses this line's operands", "$t0" in tip and "task1_done" in tip and "已代入本行的操作数" in tip, tip)
    page.mouse.move(5, 5)
    # Round 3: reassembling keeps the file being read.
    page.locator("#assemble").click()
    r.until("() => window.marsIDE.state?.step === 0")
    r.check("reassembly keeps the open file", "task1.s" in page.locator(".tabs .active").inner_text())

    # --- M2.5: VS Code keys ---
    page.keyboard.press("Shift+F5")
    r.until("() => window.marsIDE.state?.step === 0")
    r.js("() => window.marsIDE.editor.focus()")
    page.keyboard.press("F11")
    r.until("() => window.marsIDE.state?.step === 2")  # la expands to two instructions
    page.keyboard.press("Alt+F11")
    r.until("() => window.marsIDE.state?.step === 3")
    page.wait_for_timeout(1300)
    page.keyboard.press("Alt+F11")
    r.until("() => window.marsIDE.state?.step === 4")
    page.wait_for_timeout(150)
    r.check("no spotlight for an adjacent single step",
            not r.js("() => document.querySelector('.cm-editor').classList.contains('arrival-spotlight')"))
    page.keyboard.press("Shift+F9")
    r.until("() => window.marsIDE.state?.step === 3")
    page.keyboard.press("Shift+F9")
    r.until("() => window.marsIDE.state?.step === 2")
    r.js("() => { try { localStorage.removeItem('key-hint:F7') } catch {} }")
    page.keyboard.press("F7")
    r.check("retired key hint", "Alt+F11" in page.locator("#banner").inner_text() and state()["step"] == 2)
    r.check("debug keys F11 / Alt+F11 / Shift+F9 / Shift+F5", True)

    # --- M2.5 W7: quick open, outline, peek, context menu, logpoint ---
    page.keyboard.press(f"{mod}+P")
    page.locator("#picker-input").press_sequentially("loadf")
    page.keyboard.press("Enter")
    r.until("() => document.querySelector('.tabs .active [data-tab]')?.textContent.includes('libio.s')")
    line = r.js("() => { const e = window.marsIDE.editor; return e.state.doc.lineAt(e.state.selection.main.head).text }")
    r.check("quick open jumps to label", line.startswith("loadFile:"), line)
    page.keyboard.press(f"{mod}+Shift+O")
    r.check("outline lists current-file labels",
            page.locator("#picker-input").input_value() == "@" and page.locator("#picker-list .command-item").count() > 5)
    page.keyboard.press("Escape")
    r.js("""() => { const tab = [...document.querySelectorAll('.tabs button')].find(b => b.textContent.trim() === 'task1.s');
        tab.click(); const e = window.marsIDE.editor, d = e.state.doc;
        for (let i = 1; i <= d.lines; i++) { const k = d.line(i).text.indexOf('$s0'); if (k >= 0) { e.dispatch({ selection: { anchor: d.line(i).from + k + 1 } }); break } }
        e.focus() }""")
    page.keyboard.press("Shift+F12")
    r.until("() => document.querySelectorAll('.cm-peek-row').length > 3")
    r.check("peek references inline", "写入" in page.locator(".cm-peek").inner_text())
    # Round 2: the list takes keyboard focus and ↓ moves through it.
    r.until("() => document.activeElement?.classList.contains('cm-peek-row')", timeout=3000)
    page.keyboard.press("ArrowDown")
    r.check("peek list is keyboard navigable",
            r.js("() => [...document.querySelectorAll('.cm-peek-row')].indexOf(document.activeElement)") == 1)
    page.keyboard.press("Escape")
    r.until("() => !document.querySelector('.cm-peek')")
    row = page.locator(".cm-line", has_text="lbu $t0, 0($s0)").first
    row.hover()
    page.wait_for_timeout(200)
    row.click(button="right")
    r.check("editor context menu", page.locator("#context-menu button").count() == 5)
    r.check("hover tooltip closes when the menu opens", page.locator("#tooltip").is_hidden())
    page.locator("#context-menu button", has_text="编辑断点").click()
    page.locator("#bp-hit").fill("2")
    page.locator("#bp-log").fill("byte={$t0}")
    page.locator("#bp-form button.primary").click()
    r.check("logpoint glyph in sidebar", "◆" in page.locator("#breakpoints").inner_text())
    page.keyboard.press("Shift+F5")
    r.until("() => window.marsIDE.state?.step === 0")
    r.js("() => document.querySelectorAll('[data-bp-enable]').forEach(c => { if (!c.closest('.bp-row').textContent.includes('◆')) { c.checked = false; c.dispatchEvent(new Event('change')) } })")
    page.keyboard.press("F5")
    r.until("() => window.marsIDE.state?.status === 'ended'")
    page.locator('[data-bottom="logs"]').click()
    logs = page.locator("#logs").inner_text()
    r.check("logpoint logs once on 2nd hit without pausing", logs.count("byte=") == 1, logs)

    # --- M2.5 W4: focus mode ---
    page.keyboard.press("Shift+F5")
    r.until("() => window.marsIDE.state?.step === 0")
    r.js("() => document.querySelector('[data-bottom=console]').click()")
    for _ in range(3):
        page.keyboard.press("F11")
        page.wait_for_timeout(150)
    page.keyboard.press(f"{mod}+K")
    page.keyboard.press("f")
    r.until("() => !document.getElementById('focus-lens').hidden && document.querySelectorAll('.fseg').length > 0")
    r.check("focus mode via Cmd/Ctrl+K F", True)
    r.check("focus input hint describes automatic resume, not browsing arrows",
            page.locator("#focus-input span").text_content() == "提交后继续被中断的操作")
    r.check("lens shows touched objects", page.locator(".fobj").count() > 0)
    template = page.locator("#focus-eq").inner_text()
    r.until("(t) => document.getElementById('focus-eq').textContent !== t", template)
    r.check("fill-in beats play", True)
    # Every beat answers "why": the last beat (write-back) too (trial B2).
    r.until("() => document.querySelector('.fdot.now') && [...document.querySelectorAll('.fdot')].at(-1).classList.contains('now')", timeout=10000)
    page.keyboard.press("?")
    why = page.locator("#focus-why-text")
    r.check("final beat has a why", why.is_visible() and len(why.inner_text()) > 10, why.inner_text())
    page.keyboard.press("?")
    before = state()["step"]
    # Plain arrows only look (trial B1): the selection moves, the machine does not.
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(300)
    r.check("plain ↓ selects without executing",
            state()["step"] == before and "预计" in page.locator("#focus-tag").inner_text())
    page.keyboard.press("ArrowUp")
    r.check("plain ↑ returns to the completed step", page.locator("#focus-tag").inner_text() == "刚完成")
    page.keyboard.press("Shift+ArrowDown")
    r.until("(n) => window.marsIDE.state?.step > n", before)
    page.keyboard.press("Shift+ArrowUp")
    r.until("(n) => window.marsIDE.state?.step === n", before)
    r.check("Shift+↑/↓ move by source line", True)
    page.keyboard.press("Tab")
    page.keyboard.press("Tab")
    r.check("Tab selects a predicted step", "预计" in page.locator("#focus-tag").inner_text())
    page.keyboard.press("Enter")
    r.until("(n) => window.marsIDE.state?.step > n", before)
    r.check("Enter runs to the selected step", r.js("() => document.getElementById('focus-tag').textContent") == "刚完成")
    # Holding ↓: OS auto-repeat arrives as keydown events with repeat set.
    held = r.js("""async () => {
        const start = window.marsIDE.state?.step, tokens = [];
        const send = (type, repeat) => window.dispatchEvent(new KeyboardEvent(type, { key: 'ArrowDown', shiftKey: true, repeat, bubbles: true }));
        send('keydown', false);
        for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 40)); send('keydown', true); tokens.push(document.querySelectorAll('.ftoken').length) }
        await new Promise(r => setTimeout(r, 300));
        const moved = window.marsIDE.state?.step - start;
        send('keyup', false);
        await new Promise(r => setTimeout(r, 1500));
        return { moved, maxTokens: Math.max(...tokens), playedAfter: document.querySelector('.fdot.now') !== null };
    }""")
    r.check("holding an arrow is throttled", 2 <= held["moved"] <= 40, str(held))
    r.check("no animation backlog while holding", held["maxTokens"] == 0, str(held))
    r.check("narration resumes after release", held["playedAfter"], str(held))
    page.keyboard.press("Escape")
    r.check("Esc leaves focus mode", page.locator("#focus-lens").is_hidden())

    # --- edit invalidation and reassembly (ported) ---
    page.locator("#theme").click()
    r.js("() => { const e = window.marsIDE.editor; e.dispatch({ changes: { from: e.state.doc.length, insert: '\\n# edit test' } }) }")
    r.check("dirty source blocks stale execution", page.locator("#step").is_disabled())
    page.locator("#assemble").click()
    r.until("() => window.marsIDE.state?.step === 0 && !document.querySelector('#step').disabled")
    r.check("reassembly restores execution", True)


def reduced_motion(r, page, mod):
    """With prefers-reduced-motion the lens shows the conclusion, nothing moves."""
    r.until("() => window.marsIDE?.state?.status === 'paused'")
    r.js("() => window.marsIDE.editor.focus()")
    for _ in range(4):
        page.keyboard.press("F11")
        page.wait_for_timeout(120)
    page.keyboard.press(f"{mod}+K")
    page.keyboard.press("f")
    r.until("() => document.querySelectorAll('.fdot').length > 0")
    page.wait_for_timeout(1200)
    dots = r.js("() => [...document.querySelectorAll('.fdot')].map(d => d.className)")
    r.check("reduced motion shows the conclusion", "now" in dots[-1], str(dots))
    r.check("reduced motion: no moving values", page.locator(".ftoken").count() == 0)
    page.keyboard.press("Escape")
    page.keyboard.press("F5")
    r.until("() => window.marsIDE.state?.status !== 'paused' || window.marsIDE.state?.stopReason !== ''")
    page.wait_for_timeout(300)
    r.check("reduced motion: no spotlight", not r.js("() => document.querySelector('.cm-editor').classList.contains('arrival-spotlight')"))


def main():
    port = free_port()
    server = subprocess.Popen(
        ["java", "-Djava.awt.headless=true", "-cp", "teaching/build/classes", "mars.ide.Server", str(port)],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        with sync_playwright() as p:
            browser = launch(p)
            version = browser.version
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"http://127.0.0.1:{port}")
            page.select_option("#example", label="Hexadecimal · 位与字符")
            page.locator("#project-confirm").click()
            mod = "Meta" if "Mac" in page.evaluate("navigator.platform") else "Control"
            r = Run(page)
            try:
                scenario(r, page, mod)
                calm = browser.new_page(viewport={"width": 1280, "height": 850}, reduced_motion="reduce")
                calm.on("pageerror", lambda e: errors.append(str(e)))
                calm.goto(f"http://127.0.0.1:{port}")
                calm.select_option("#example", label="Hexadecimal · 位与字符")
                calm.locator("#project-confirm").click()
                calm.wait_for_function("() => window.marsIDE?.state?.status === 'paused'")
                reduced_motion(Run(calm), calm, mod)
                r.passed += ["reduced motion shows the conclusion", "reduced motion: no moving values", "reduced motion: no spotlight"]
                r.check("no page errors", not errors, json.dumps(errors))
            except Exception as e:
                page.screenshot(path=str(ROOT / "teaching/test-results/browser-failure.png"))
                print(f"FAIL after {len(r.passed)} checks: {e}")
                print("passed:", ", ".join(r.passed))
                sys.exit(1)
            finally:
                browser.close()
        print(f"PASS: {len(r.passed)} browser checks (Chromium {version}), real key events, no page errors")
    finally:
        server.terminate()
        server.wait(timeout=5)


if __name__ == "__main__":
    main()
