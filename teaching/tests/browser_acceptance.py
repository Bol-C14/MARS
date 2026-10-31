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
    # Relation-line settings live in focus mode now (classroom 2026-10-24).
    def lens_settings(action):
        page.locator("#focus-open").click()
        r.until("() => !document.getElementById('focus-lens').hidden")
        if page.locator("#focus-head .overlay-settings").get_attribute("open") is None:
            page.locator("#focus-head .overlay-settings summary").click()
        action()
        page.locator("#focus-close").click()
    lens_settings(lambda: page.select_option("#relation-scope", "all"))
    r.until("() => document.querySelectorAll('#overlay>path').length > 0")
    r.check("relation settings are reached from focus mode", page.locator("#focus-head .overlay-settings").count() == 1 and page.locator("footer .overlay-settings").count() == 0)
    r.check("preview lines", page.locator("#overlay>path[stroke-dasharray]").count() > 0)
    lens_settings(lambda: page.locator("#dashed").uncheck())
    r.until("() => document.querySelectorAll('#overlay>path[stroke-dasharray]').length === 0")
    r.check("actual lines independent of preview", page.locator("#overlay>path").count() > 0)
    lens_settings(lambda: page.locator("#solid").uncheck())
    r.until("() => document.querySelectorAll('#overlay>path').length === 0")
    r.check("both layers off", True)
    lens_settings(lambda: (page.locator("#solid").check(), page.locator("#dashed").check(), page.locator("#focus-head .overlay-settings summary").click()))
    page.locator("#view-menu-button").click()
    page.locator("#zoom").click()
    page.keyboard.press("Escape")
    page.set_viewport_size({"width": 1280, "height": 850})
    r.until("() => document.querySelectorAll('#overlay>path').length > 0")
    paths = r.js("() => [...document.querySelectorAll('#overlay>path')].map(p => p.getAttribute('d'))")
    r.check("finite overlay anchors after zoom/resize", all("NaN" not in p for p in paths))
    page.locator('[data-view="cfg"]').click()
    r.check("CFG blocks", page.locator(".block").count() > 1)
    page.locator('[data-view="source"]').click()
    page.locator('[data-bottom="trace"]').click()
    r.check("loop iteration groups", page.locator(".loop-history").count() > 0)
    page.locator("#side-tab-stops").click()
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
    page.locator("#view-menu-button").click()
    page.locator("#zoom-out").click()
    smaller = code_size()
    page.locator("#zoom").click()
    page.keyboard.press("Escape")
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
    r.js("""() => { window.assembleBlinks = 0; window.editorTop = document.getElementById('editor').getBoundingClientRect().top;
        new MutationObserver(() => window.assembleBlinks++).observe(document.getElementById('assemble'), { attributes: true, attributeFilter: ['disabled'] }); }""")
    page.locator("#demo").click()
    r.until("() => document.getElementById('status').dataset.state === 'running'")
    r.check("status chip shows running during a demo", "运行中" in page.locator("#status").inner_text())
    notice = page.wait_for_function(
        "() => { const t = document.getElementById('banner').textContent; return t.startsWith('执行进入') && t }",
        timeout=30000).json_value()
    r.check("demo announces entering another file", any(f in notice for f in ("main.s", "task1.s", "libio.s")), notice)
    r.check("a notice does not move the layout", r.js("() => document.getElementById('editor').getBoundingClientRect().top === window.editorTop"))
    r.check("notices sit at the foot of the left column", r.js("""() => { const b = document.getElementById('banner').getBoundingClientRect(), s = document.querySelector('.sidebar').getBoundingClientRect(); return b.height > 0 && b.left >= s.left && b.right <= s.right && Math.abs(b.bottom - s.bottom) < 2 }"""))
    r.check("the assemble button holds still through a demonstration", r.js("() => window.assembleBlinks") == 0 and page.locator("#assemble").is_enabled(), r.js("() => window.assembleBlinks"))
    page.keyboard.press("F6")
    r.until("() => document.getElementById('status').dataset.state !== 'running'")
    r.check("pause ends the running state", "运行中" not in page.locator("#status").inner_text())
    r.until("() => document.getElementById('demo').textContent.includes('继续')")
    r.check("a paused demonstration offers to continue", True)
    page.locator("#demo").click()
    r.until("() => document.getElementById('demo').textContent.includes('暂停')")
    r.check("the running demonstration's button pauses it", page.locator("#status").get_attribute("data-state") == "running" and page.locator("#run").is_disabled())
    page.locator("#demo").click()
    r.until("() => document.getElementById('demo').textContent.includes('继续')")
    r.check("the same button pauses a continued demonstration", page.locator("#status").get_attribute("data-state") != "running")


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
    # Round 4: the Chinese purpose replaces MARS's English text; this line's formula names the operands.
    r.check("a branch is explained in Chinese with this line's operands", "等于 0 就跳转" in tip and "$t0" in tip and "task1_done" in tip and "MARS 原文" not in tip, tip)
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
    page.locator("#view-menu-button").click()
    page.locator("#theme").click()
    r.js("() => { const e = window.marsIDE.editor; e.dispatch({ changes: { from: e.state.doc.length, insert: '\\n# edit test' } }) }")
    r.check("dirty source blocks stale execution", page.locator("#step").is_disabled())
    page.locator("#assemble").click()
    r.until("() => window.marsIDE.state?.step === 0 && !document.querySelector('#step').disabled")
    r.check("reassembly restores execution", True)


def classroom_p1(r, page, mod):
    """2026-10-24 classroom P1: layout, menus, inspector, BIN, syscalls, terminal."""
    r.until("() => window.marsIDE?.state?.status === 'paused'")
    # Toolbar: stepping is a group of named icons; words stay on main actions.
    r.check("step icons carry names and shortcuts", "源码单步" in page.locator("#source").get_attribute("aria-label") and "F11" in page.locator("#source").get_attribute("data-tip") and page.locator("#source .tool-label").bounding_box()["width"] <= 2)
    page.locator("#over").hover()
    r.check("the add-watch button says what it does", "添加" in page.locator("#add-watch").inner_text())
    r.check("hovering an icon shows its name", "跨过调用" in r.js("() => getComputedStyle(document.getElementById('over'), '::after').content"))
    r.check("there is no separate pause button", page.locator("#pause").count() == 0 and "▶ 运行" in page.locator("#run").inner_text())
    # Header: project actions in one menu, with replace vs add and browser vs computer spelled out.
    page.locator("#project-menu-button").click()
    menu = page.locator("#project-menu").inner_text()
    r.check("the project menu separates replace, add, save and export", all(w in menu for w in ("打开工程", "替换当前工程", "添加文件", "追加", "保存到此浏览器", "导出到电脑")))
    page.keyboard.press("Escape")
    r.check("Escape closes the project menu", page.locator("#project-menu").is_hidden())
    r.check("the project name shows its save state", page.locator(".project-state #workspace-status").is_visible())
    # Left: one group at a time, chosen by mouse or keyboard, remembered.
    page.locator("#side-tab-symbols").click()
    r.check("side tabs show one group at a time", page.locator("#side-symbols").is_visible() and page.locator("#side-files").is_hidden() and page.locator("#side-tab-symbols").get_attribute("aria-selected") == "true")
    page.keyboard.press("ArrowDown")
    r.check("arrow keys move between side tabs", page.locator("#side-stops").is_visible())
    # Right: panels fold to their titles and keep the rest usable.
    page.locator("#panel-registers .panel-toggle").click()
    r.check("a right-hand panel folds to its title", page.locator("#registers-body").is_hidden() and page.locator("#panel-registers .panel-toggle").is_visible() and "fill" in page.locator("#panel-memory").get_attribute("class"))
    page.reload(); r.until("() => Boolean(window.marsIDE)")
    r.check("folded panels and the side tab are remembered", page.locator("#registers-body").is_hidden() and page.locator("#side-stops").is_visible())
    page.locator("#view-menu-button").click(); page.locator("#reset-layout").click()
    r.check("reset layout restores panels and the files tab", page.locator("#registers-body").is_visible() and page.locator("#side-files").is_visible())
    before = page.locator("#panel-context").bounding_box()["height"]
    line = page.locator("#split-context").bounding_box()
    page.mouse.move(line["x"] + 40, line["y"] + 0.5); page.mouse.down(); page.mouse.move(line["x"] + 40, line["y"] + 50, steps=4); page.mouse.up()
    r.check("the inspector and registers split their height by dragging", page.locator("#panel-context").bounding_box()["height"] > before + 40)
    page.locator("#split-context").dblclick()
    # A full-speed run is paused from its own button, and F6 still works.
    page.locator("#project-menu-button").click(); page.locator("#new-project").click(); page.locator("#project-confirm").click()
    r.js("() => { const e = window.marsIDE.editor; e.dispatch({ changes: { from: 0, to: e.state.doc.length, insert: '.text\\nmain:\\n j main\\n nop\\n' } }) }")
    page.locator("#assemble").click(); r.until("() => window.marsIDE.state?.status === 'paused' && window.marsIDE.state.step === 0")
    page.locator("#run").click()
    r.until("() => document.getElementById('run').textContent.includes('暂停')")
    r.check("the run button pauses a running program, and demo waits", page.locator("#run").is_enabled() and page.locator("#demo").is_disabled())
    page.locator("#run").click()
    r.until("() => document.getElementById('run').textContent.includes('运行') && document.getElementById('status').dataset.state !== 'running'")
    r.check("a paused run keeps the run button, not a demo continue", "演示" in page.locator("#demo").inner_text())
    page.locator("#run").click()
    r.until("() => document.getElementById('run').textContent.includes('暂停')")
    page.keyboard.press("F6")
    r.until("() => document.getElementById('status').dataset.state !== 'running'")
    r.check("F6 pauses a run too", True)
    # Instruction detail: rule, this line, values before, calculation, result.
    page.locator("#project-menu-button").click(); page.locator("#new-project").click(); page.locator("#project-confirm").click()
    r.js("() => { const e = window.marsIDE.editor; e.dispatch({ changes: { from: 0, to: e.state.doc.length, insert: '.text\\nmain:\\n li $s0, 7\\n li $t0, 3\\n add $s0, $s0, $t0\\n li $v0, 10\\n syscall\\n' } }) }")
    page.locator("#assemble").click(); r.until("() => window.marsIDE.state?.status === 'paused' && window.marsIDE.state.step === 0")
    for _ in range(2):
        page.locator("#source").click(); page.wait_for_timeout(150)
    r.until("() => window.marsIDE.state.step === 2")
    word = page.locator(".cm-line").nth(4).locator("text=add")
    word.hover()
    r.until("() => !document.getElementById('tooltip').hidden")
    tip = page.locator("#tooltip").inner_text()
    r.check("the hover note leads with how to open the details", "详情在右侧“详细检查”" in tip.splitlines()[0] and "本行：$s0 ← $s0 + $t0" in tip, tip)
    r.check("the hover note says how the instruction is written", "写法：add rd, rs, rt" in tip, tip)
    page.locator("#tooltip .tip-detail").click()
    r.check("opening details draws the eye to the panel", "attention" in (page.locator("#panel-context").get_attribute("class") or ""))
    detail = page.locator("#context").inner_text()
    r.check("the detail spells out each part of the written form", "add rd, rs, rt" in detail and "rd = $s0" in detail and "结果写入这个寄存器" in detail, detail)
    r.check("a preview is marked as not yet executed", "即将执行" in detail and "预览：尚未执行" in detail, detail)
    r.check("the detail shows the general rule and this line", "rd ← rs + rt" in detail and "$s0 ← $s0 + $t0" in detail, detail)
    def edit_point(line, word):
        return page.evaluate("""([n,w]) => { const e=window.marsIDE.editor, l=e.state.doc.line(n), c=e.coordsAtPos(l.from+(w?l.text.indexOf(w)+1:l.length)); return [c.left+(w?1:200),(c.top+c.bottom)/2]; }""", [line, word])
    def key_click(key, line, word):
        x, y = edit_point(line, word)
        page.keyboard.down(key); page.mouse.click(x, y); page.keyboard.up(key); page.wait_for_timeout(120)
        page.mouse.move(5, 5)
        return page.locator("#context").inner_text()
    r.check("both Cmd and Ctrl click open details on every platform", all("add rd, rs, rt" in key_click(k, 5, "add") for k in ("Control", mod)))
    r.check("Ctrl click leaves no menu open", page.locator("#context-menu").count() == 0)
    page.locator("#panel-context .panel-toggle").click()
    key_click(mod, 5, "add")
    r.check("details reopen a folded panel", "collapsed" not in (page.locator("#panel-context").get_attribute("class") or "") and page.locator("#context").bounding_box()["height"] > 40)
    page.evaluate("window.marsIDE.inspectToken('$t0')")
    r.check("the blank after a line opens its instruction, not its last word", "add rd, rs, rt" in key_click(mod, 5, ""))
    page.locator("#source").click(); r.until("() => window.marsIDE.state.step === 3")
    detail = page.locator("#context").inner_text()
    r.check("after running, the detail uses the values from before the write", "刚执行（第 3 步）" in detail and "$s0 = 0d7，$t0 = 0d3" in detail and "$s0：0d7 → 0d10" in detail, detail)
    page.locator("#back").click(); r.until("() => window.marsIDE.state.step === 2")
    r.check("the pinned detail follows the selected history step", "即将执行" in page.locator("#context").inner_text())
    # BIN: the whole 32-bit pattern, wrapping only at byte boundaries.
    page.select_option("#radix", "bin")
    sp = page.locator('[data-register="$sp"] .value')
    r.check("BIN registers show all 32 bits with leading zeros", sp.inner_text().replace("\n", "") == "0b0111_1111_1111_1111_1110_1111_1111_1100" and page.locator('[data-register="$zero"] .value').inner_text().replace("\n", "").count("0") == 33)
    r.check("BIN values do not overflow their register cell", r.js("() => [...document.querySelectorAll('#registers .reg')].every(e => e.scrollWidth <= e.clientWidth + 1)"))
    page.select_option("#radix", "auto")
    # Syscalls: per-service explanation from the number before the call.
    page.select_option("#example", label="Hexadecimal · 位与字符"); page.locator("#project-confirm").click()
    r.until("() => window.marsIDE.state?.status === 'paused' && window.marsIDE.state.step === 0")
    page.locator('[data-bottom="trace"]').click()
    for _ in range(3):
        page.locator("#source").click(); page.wait_for_timeout(150)
    r.until("() => window.marsIDE.state.output.length > 0")
    r.check("new output marks the hidden console tab", "unread" in page.locator('[data-bottom="console"]').get_attribute("class"))
    page.locator("#source").click(); page.locator("#source").click()
    r.until("() => window.marsIDE.state.status === 'waiting'")
    r.check("waiting for input brings the console forward and lights the input", page.locator("#console").is_visible() and "waiting" in page.locator("#console").get_attribute("class") and "等待输入" in page.locator("#stdin").get_attribute("placeholder"))
    r.check("waiting does not take keyboard focus", r.js("() => document.activeElement?.id") != "stdin")
    r.js("() => window.marsIDE.inspectToken('syscall', { file: 'main.s', line: 11 })")
    detail = page.locator("#context").inner_text()
    r.check("the syscall detail explains the service while it waits", "syscall：读取整数" in detail and "$v0 = 5 选定了“读取整数”（第 10 行 li $v0,5 放入" in detail and "正在等待输入" in detail and "$v0 变为" not in detail and "服务号" not in detail, detail)
    page.locator("#stdin").fill("898"); page.locator("#input-form button").click()
    r.until("() => window.marsIDE.state.status !== 'waiting'")
    detail = page.locator("#context").inner_text()
    r.check("after the read, the detail still names the value from before the call", "$v0 = 5 选定了“读取整数”" in detail and "$v0 变为 0d898" in detail and "原来的 5 被覆盖" in detail, detail)
    # A breakpoint hit while its group is hidden marks the tab.
    page.locator("#side-tab-files").click()
    r.js("() => window.marsIDE.gotoAddress(window.marsIDE.program.instructions.find(i => i.line === 18).address)")
    page.keyboard.press("F9"); page.keyboard.press("F5")
    r.until("() => (window.marsIDE.state?.stopReason || '').startsWith('Breakpoint')")
    r.check("a breakpoint hit marks the hidden breakpoint tab", page.locator("#stops-badge").is_visible())
    page.locator("#side-tab-stops").click()
    r.check("opening the tab clears the mark", page.locator("#stops-badge").is_hidden())


HELLO = """.data
greeting: .asciiz "Hello!"
.text
.globl main
main:
    la $a0, greeting
    li $v0, 4
    syscall
    li $v0, 10
    syscall
"""
NAME = """.data
greeting: .asciiz "Hello, "
bang:     .asciiz "!"
name:     .space 32
.text
.globl main
main:
    la $a0, name
    li $a1, 32
    li $v0, 8
    syscall
    la $a0, greeting
    li $v0, 4
    syscall
    la $a0, name
    li $v0, 4
    syscall
    la $a0, bang
    li $v0, 4
    syscall
    li $t0, START
    addi $t0, $t0, 1
EXTRA    li $v0, 10
    syscall
"""


def classroom_p2(r, page, mod):
    """2026-10-24 classroom P2: untaken branch, bits, search, and the tutorial."""
    def card():
        return page.locator("#tutorial").inner_text()
    def step_done(title):
        r.until("(t) => { const c = document.getElementById('tutorial'); return c && c.innerText.includes(t) && !!c.querySelector('[data-t=next]'); }", title)
        page.locator('#tutorial [data-t="next"]').click()
    def write(text):
        r.js("(t) => { const e = window.marsIDE.editor; e.dispatch({ changes: { from: 0, to: e.state.doc.length, insert: t } }) }", text)
    def run_with(*inputs, through_breakpoints=True):
        """Assemble and run, answering input waits and continuing past breakpoints."""
        page.locator("#assemble").click()
        r.until("() => window.marsIDE.state?.status === 'paused' && window.marsIDE.state.step === 0")
        page.locator("#run").click()
        pending = list(inputs)
        for _ in range(20):
            r.until("() => !document.getElementById('run').disabled || ['ended', 'error'].includes(window.marsIDE.state?.status)")
            page.wait_for_timeout(150)
            status = r.js("() => window.marsIDE.state.status")
            if status == "waiting" and pending:
                page.locator("#stdin").fill(pending.pop(0)); page.locator("#input-form button").click()
            elif status == "paused" and through_breakpoints and (r.js("() => window.marsIDE.state.stopReason") or "").startswith(("Breakpoint", "Watchpoint")) is False:
                break
            elif status == "paused" and through_breakpoints and r.js("() => window.marsIDE.state.stopReason.startsWith('Breakpoint')"):
                page.locator("#run").click()
            else:
                break
    # Focus mode: the untaken side of a branch, and bits of a shift.
    page.select_option("#example", label="Hexadecimal · 位与字符"); page.locator("#project-confirm").click()
    r.until("() => window.marsIDE.state?.status === 'paused' && window.marsIDE.state.step === 0")
    page.locator("#run").click()
    r.until("() => window.marsIDE.state.status === 'waiting'")
    page.locator("#stdin").fill("300"); page.locator("#input-form button").click()
    r.until("() => window.marsIDE.state.status === 'ended'")
    shift = r.js("() => window.marsIDE.program.instructions.find(i => i.op === 'srl').address")
    page.locator("#assemble").click(); r.until("() => window.marsIDE.state?.step === 0")
    r.js("(a) => window.marsIDE.gotoAddress(a)", shift)
    page.keyboard.press("F9"); page.locator("#run").click()
    r.until("() => window.marsIDE.state.status === 'waiting'")
    page.locator("#stdin").fill("300"); page.locator("#input-form button").click()
    r.until("(a) => window.marsIDE.state.pc === a", shift)
    page.locator("#source").click(); r.until("() => window.marsIDE.state.last?.instruction.op === 'srl'")
    page.locator("#focus-open").click(); r.until("() => !document.getElementById('focus-lens').hidden")
    page.wait_for_timeout(500)
    page.locator("#focus-bits-toggle").click()
    r.check("a shift can be followed bit by bit", "srl：逐位移位" in page.locator("#focus-bits").inner_text() and "第 1/" in page.locator("#focus-bits").inner_text())
    page.locator("#bits-next").click()
    r.check("bit steps move one shift at a time", "第 1 次移动" in page.locator("#focus-bits").inner_text())
    page.locator("#focus-bits-toggle").click()
    untaken = page.locator(".funtaken").first
    r.check("a conditional branch shows its untaken side, folded", untaken.count() == 1 and "未走的路径" in untaken.inner_text() and untaken.get_attribute("open") is None)
    untaken.locator("summary").click()
    r.check("the untaken side shows code only, marked as not executed", "没有执行" in untaken.inner_text() and untaken.locator(".frow.untaken").count() > 0)
    page.locator("#focus-close").click()
    # Search: from what one wants to do to the instruction or service.
    page.locator("#find-instruction").click()
    page.locator("#find-input").fill("打印字符")
    r.check("search finds a service from what one wants to do", "syscall 11 · 打印字符" in page.locator("#find-list .selected").inner_text() and "li $v0, 11" in page.locator("#find-detail").inner_text())
    page.locator("#find-input").fill("比较大小")
    r.check("search lists comparisons and says real or pseudo", any(w in page.locator("#find-list").inner_text() for w in ("slt", "blt")) and ("伪指令" in page.locator("#find-list").inner_text()))
    page.locator("#find-input").fill("打印字符")
    r.check("loose matches fold away behind real answers", "lb" not in page.locator("#find-list > button").all_inner_texts().__str__() and "其他可能相关" in page.locator("#find-list").inner_text())
    page.locator("#find-input").fill("zzz不存在")
    r.check("search says when nothing matches", "没有找到匹配" in page.locator("#find-detail").inner_text())
    page.keyboard.press("Escape")
    # The tutorial, walked through as a student would.
    page.locator("#start-tutorial").click(); page.locator("#tutorial-begin").click()
    r.until("() => !document.getElementById('tutorial').hidden")
    r.check("the tutorial opens its own project and keeps the old one aside", r.js("() => Object.keys(window.marsIDE.files).length") == 0 and r.js("() => !!localStorage.getItem('tutorial-backup')"))
    r.check("the tutorial starts from a goal, not a list of features", "新建 hello.s" in card() and "第一个程序放在哪里" in card())
    page.locator('#tutorial [data-t="hint"]').click()
    r.check("hints come one at a time", "提示 1" in card() and "提示 2" not in card())
    page.locator("#new-file").click(); page.locator("#project-value").fill("hello.s"); page.locator("#project-form button.primary").click()
    step_done("新建 hello.s")
    r.check("the next step stays locked until it really happened", page.locator('#tutorial [data-t="next"]').count() == 0)
    page.locator('#tutorial [data-t="answer"]').click()
    r.check("the reference answer is shown, not typed in", "参考答案" in card() and r.js("() => window.marsIDE.files['hello.s']") == "")
    write(HELLO); run_with()
    step_done("让程序打印 Hello!")
    write(NAME.replace("START", "41").replace("    li $t0, 41\n    addi $t0, $t0, 1\n", "").replace("EXTRA", "")); run_with("Alice")
    r.until("() => document.getElementById('tutorial').innerText.includes('回车')")
    step_done("读取名字")
    page.locator(".cm-line").nth(16).click(); page.keyboard.press("F9")
    page.locator("#assemble").click(); r.until("() => window.marsIDE.state?.step === 0")
    page.locator("#run").click(); r.until("() => window.marsIDE.state?.status === 'waiting'")
    page.locator("#stdin").fill("Alice"); page.locator("#input-form button").click()
    step_done("停在打印名字之前")
    page.locator(".cm-line").nth(16).locator("text=syscall").hover()
    page.locator("#tooltip .tip-detail").click()
    step_done("看懂这个 syscall")
    page.locator('#tutorial [data-go="inspect:$a0"]').click(); page.locator("#point").click()
    step_done("顺着地址找到名字")
    page.locator('#tutorial [data-go="focus"]').click(); r.until("() => !document.getElementById('focus-lens').hidden")
    page.wait_for_timeout(600)
    page.keyboard.press("Shift+ArrowDown")
    r.until("() => window.marsIDE.state.last?.instruction.op === 'syscall'")
    r.check("the tutorial card stays reachable above focus mode", r.js("() => { const b = document.querySelector('#tutorial [data-t]').getBoundingClientRect(); return !!document.elementFromPoint(b.x + 2, b.y + 2)?.closest('#tutorial'); }"))
    step_done("在专注模式里执行它")
    page.locator("#focus-close").click()
    r.check("the overflow step shows the code to add", "0x7fffffff" in card())
    write(NAME.replace("START", "0x7fffffff").replace("EXTRA", "")); run_with("Alice")
    step_done("让计算越界")
    page.locator("#back").click(); r.until("() => window.marsIDE.state.status === 'paused'")
    page.locator(".cm-line").nth(21).locator("text=addi").hover(); page.locator("#tooltip .tip-detail").click()
    step_done("看出错前的数值")
    page.locator('#tutorial [data-go="side:stops"]').click()
    page.locator("#add-watch").click(); page.locator("#watch-target").fill("$t0"); page.select_option("#watch-access", "write"); page.locator("#watch-form button").click()
    run_with("Alice")
    step_done("用观察点找到写入")
    r.js("() => document.querySelector('[data-watch]')?.click()")
    write(NAME.replace("START", "0x7fffffff").replace("addi $t0", "addiu $t0").replace("EXTRA", "")); run_with("Alice")
    r.until("() => window.marsIDE.state.status === 'ended'")
    r.check("silencing the overflow with addiu is not accepted as a fix", "溢出还在" in card() and page.locator('#tutorial [data-t="next"]').count() == 0)
    write(NAME.replace("START", "41").replace("EXTRA", "")); run_with("Alice")
    step_done("修好它")
    age = "    li $v0, 5\n    syscall\n    addi $a0, $v0, 1\n    li $v0, 1\n    syscall\n"
    write(NAME.replace("START", "41").replace("EXTRA", age)); run_with("Alice", "17")
    step_done("读取年龄")
    page.locator('#tutorial [data-go="menu:project"]').click(); page.locator("#save").click()
    with page.expect_download():
        page.locator("#download-zip").click()
    step_done("导出你的工程")
    r.check("the finish offers to keep the exercise or go back", page.locator("#tutorial-restore").is_visible() and page.locator("#tutorial-keep").is_visible())
    page.locator("#tutorial-restore").click()
    r.until("() => document.getElementById('tutorial').hidden")
    r.check("going back restores the project from before the tutorial", r.js("() => Object.keys(window.marsIDE.files)") != ["hello.s"])


def trial4_a(r, page, mod):
    """Round-4 trial, group A: the end of a run, restarting, status wording."""
    page.locator("#project-menu-button").click(); page.locator("#new-project").click(); page.locator("#project-confirm").click()
    r.check("a fresh project says it is not assembled yet, not modified", "尚未汇编" in page.locator("#status").inner_text())
    main = ".text\n.globl main\nmain:\n li $a0, 7\n jal square\n nop\n move $a0, $v0\n li $v0, 1\n syscall\n li $v0, 10\n syscall\n"
    helper = ".text\n.globl square\nsquare:\n mul $v0, $a0, $a0\n jr $ra\n nop\n"
    page.locator("#project-menu-button").click(); page.locator("#import").click()
    with page.expect_file_chooser() as chooser:
        page.locator("#choose-files").click()
    chooser.value.set_files([{"name": "main.s", "mimeType": "text/plain", "buffer": main.encode()}, {"name": "helper.s", "mimeType": "text/plain", "buffer": helper.encode()}])
    page.locator("#project-confirm").click()
    page.locator("#side-tab-files").click()
    page.locator('[data-file="main.s"]').click()
    page.locator("#assemble").click(); r.until("() => window.marsIDE.state?.status === 'paused'")
    page.locator("#run").click(); r.until("() => window.marsIDE.state?.status === 'ended'")
    page.wait_for_timeout(300)
    r.check("after the end no line is marked as next and the card says it ended", page.locator(".cm-line.next-line").count() == 0 and "程序已结束" in page.locator("#next-card").inner_text())
    r.check("after the end the editor stays where execution finished", page.locator(".file-tab.active").inner_text().startswith("main.s"))
    r.check("after the end run offers to start again", page.locator("#run").inner_text().strip() == "↻ 从头运行" and page.locator("#run").is_enabled())
    r.check("disabled step buttons say why", "程序已结束" in page.locator("#source").get_attribute("data-tip"))
    r.js("() => window.marsIDE.gotoAddress(window.marsIDE.program.instructions.find(i => i.op === 'mul').address)")
    page.keyboard.press("F9")
    page.locator("#run").click()
    r.until("() => (window.marsIDE.state?.stopReason || '').startsWith('Breakpoint')")
    r.check("starting again keeps breakpoints and stops at them", page.locator("#run").inner_text().strip() == "▶ 运行")
    page.locator('[data-file="main.s"]').click()
    r.js("() => { const e = window.marsIDE.editor; e.dispatch({ changes: { from: 0, insert: 'oops\\n' } }) }")
    page.locator("#assemble").click(); r.until("() => window.marsIDE.state?.status === 'error'")
    r.check("an assembly error brings the problems list forward", page.locator("#problems").is_visible())
    r.js("() => { const e = window.marsIDE.editor; e.dispatch({ changes: { from: 0, to: 5, insert: '' } }) }")
    page.locator("#assemble").click(); r.until("() => window.marsIDE.state?.status === 'paused'")
    r.check("a clean assembly puts the console back", page.locator("#console").is_visible())
    page.select_option("#example", label="Hexadecimal · 位与字符"); page.locator("#project-confirm").click()
    r.until("() => window.marsIDE.state?.status === 'paused' && window.marsIDE.state.step === 0")
    page.locator("#run").click(); r.until("() => window.marsIDE.state.status === 'waiting'")
    page.locator("#stdin").fill("898"); page.locator("#input-form button").click()
    r.until("() => window.marsIDE.state.status === 'ended'")
    page.locator("#run").click()
    r.until("() => window.marsIDE.state.status === 'waiting'")
    r.check("starting again asks for input again instead of replaying it", page.locator("#output").inner_text().strip() == "Enter an integer:")


def trial4_b(r, page, mod):
    """Round-4 trial, group B: the inspector follows execution unless pinned."""
    page.locator("#project-menu-button").click(); page.locator("#new-project").click(); page.locator("#project-confirm").click()
    r.js("() => { const e = window.marsIDE.editor; e.dispatch({ changes: { from: 0, to: e.state.doc.length, insert: '.text\\nmain:\\n li $s0, 7\\n li $t0, 3\\n add $s0, $s0, $t0\\n li $t1, -1\\n sub $t2, $t0, $s0\\n li $v0, 10\\n syscall\\n' } }) }")
    page.locator("#assemble").click(); r.until("() => window.marsIDE.state?.status === 'paused' && window.marsIDE.state.step === 0")
    mode = lambda: page.locator("#context .inspect-mode").inner_text()
    r.check("before anything ran the inspector previews the next line", "跟随执行 · 即将执行的第 3 行" in mode(), mode())
    page.locator("#source").click(); page.locator("#source").click(); r.until("() => window.marsIDE.state.step === 2")
    r.check("the inspector follows the line that just ran", "跟随执行 · 刚执行的第 4 行" in mode() and page.locator("#clear-focus").is_hidden(), mode())
    page.locator(".cm-line").nth(4).locator("text=add").hover(); page.locator("#tooltip .tip-detail").click()
    detail = page.locator("#context").inner_text()
    r.check("opening an object pins it", "已固定 · add · 第 5 行" in mode() and "当前执行前数值" in detail and "完成执行后数值" in detail, detail)
    r.check("a register on both sides is explained", "右边的 $s0 用的是执行前的 0d7，结果 0d10 写回后 $s0 才变" in detail, detail)
    page.locator("#source").click(); r.until("() => window.marsIDE.state.step === 3")
    page.locator("#context #detail-bits").click()
    r.until("() => !document.getElementById('focus-lens').hidden && !document.getElementById('focus-bits').hidden && document.getElementById('focus-bits').innerText.includes('add：')")
    r.check("the inspector opens the bit view of this step in focus mode", "add：逐位相加" in page.locator("#focus-bits").inner_text())
    page.locator("#focus-close").click()
    page.locator("#source").click(); page.locator("#source").click(); r.until("() => window.marsIDE.state.step === 5")
    r.check("a pinned object says where execution has gone", "执行已到第" in mode(), mode())
    page.locator("#follow-again").click()
    r.check("back to following shows the line that just ran", "跟随执行 · 刚执行的第 7 行" in mode(), mode())
    page.locator('[data-register="$s0"]').click()
    r.check("register details speak of steps, not snapshots", "执行 5 步后的值" in page.locator("#context").inner_text() and "快照" not in page.locator("#context").inner_text())


def trial4_c(r, page, mod):
    """Round-4 trial, group C: concepts the students were missing."""
    page.locator("#project-menu-button").click(); page.locator("#new-project").click(); page.locator("#project-confirm").click()
    r.js("() => { const e = window.marsIDE.editor; e.dispatch({ changes: { from: 0, to: e.state.doc.length, insert: '.text\\nmain:\\n li $s0, 10\\n li $t0, 3\\n sub $t2, $t0, $s0\\n li $v0, 10\\n syscall\\n' } }) }")
    page.locator("#assemble").click(); r.until("() => window.marsIDE.state?.status === 'paused' && window.marsIDE.state.step === 0")
    r.check("the register panel says what the prefixes mean", page.locator("#reg-legend").inner_text() == "0d 十进制 · 0x 十六进制")
    page.locator(".cm-line").nth(4).locator("text=sub").hover()
    r.until("() => !document.getElementById('tooltip').hidden")
    r.check("instructions without a hand-written note still explain themselves in Chinese", "两个寄存器相减" in page.locator("#tooltip").inner_text() and "Subtraction" not in page.locator("#tooltip").inner_text())
    for _ in range(3):
        page.locator("#source").click(); page.wait_for_timeout(150)
    r.until("() => window.marsIDE.state.step === 3")
    page.select_option("#radix", "bin")
    r.check("BIN names its prefix and explains a negative value", page.locator("#reg-legend").inner_text() == "0b 二进制" and "最高位是 1：按有符号数读是 -7（补码）" in page.locator('[data-register="$t2"]').get_attribute("title"))
    page.locator("#radix-help").click()
    r.check("the BIN help shows how negative numbers are written", "−1 是 32 个 1" in page.locator("#modal").inner_text())
    page.keyboard.press("Escape")
    page.select_option("#radix", "auto")
    page.locator(".cm-line").nth(4).locator("text=sub").hover(); page.locator("#tooltip .tip-detail").click()
    titles = page.locator("#context .reg-term").evaluate_all("els => els.map(e => e.title)")
    r.check("register names in the inspector can be hovered for their use", any(t.startswith("$t2：") and len(t) > 6 for t in titles), str(titles))
    page.locator("#context #detail-bits").click()
    r.until("() => !document.getElementById('focus-bits').hidden && document.getElementById('focus-bits').innerText.includes('sub：')")
    term = page.locator("#focus-bits abbr.term", has_text="补码")
    r.check("two's complement is defined where it first appears", term.count() >= 1 and "取反，再加 1" in term.first.get_attribute("title"), page.locator("#focus-bits").inner_html()[:600])
    page.locator("#focus-close").click()
    page.select_option("#example", label="Hexadecimal · 位与字符"); page.locator("#project-confirm").click()
    r.until("() => window.marsIDE.state?.status === 'paused' && window.marsIDE.state.step === 0")
    page.locator("#run").click(); r.until("() => window.marsIDE.state.status === 'waiting'")
    page.locator("#stdin").fill("898"); page.locator("#input-form button").click()
    r.until("() => window.marsIDE.state.status === 'ended'")
    inline = page.locator(".cm-inline-value").all_inner_texts()
    r.check("printing a character says which code it is", any("编码 50 是字符 '2'" in t for t in inline), str(inline))
    line = r.js("() => window.marsIDE.program.instructions.find(i => i.op === 'syscall' && i.line > 25).line")
    r.js("(l) => window.marsIDE.inspectToken('syscall', { file: 'main.s', line: l })", line)
    page.locator("#char-table").click()
    r.check("the character service links to the character table", "字符" in page.locator("#modal").inner_text())
    page.keyboard.press("Escape")


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
    if page.locator("#focus-bits-toggle").is_visible():
        page.locator("#focus-bits-toggle").click()
        r.check("reduced motion: bit steps are listed at once", page.locator(".bits-step").count() > 1 and page.locator("#bits-play").count() == 0)
        page.locator("#focus-bits-toggle").click()
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
                calm.close()
                wide = browser.new_page(viewport={"width": 1440, "height": 1000})
                wide.on("pageerror", lambda e: errors.append(str(e)))
                wide.goto(f"http://127.0.0.1:{port}")
                wide.select_option("#example", label="Hexadecimal · 位与字符")
                wide.locator("#project-confirm").click()
                p1 = Run(wide)
                try:
                    classroom_p1(p1, wide, mod)
                    classroom_p2(p1, wide, mod)
                    trial4_a(p1, wide, mod)
                    trial4_b(p1, wide, mod)
                    trial4_c(p1, wide, mod)
                except Exception:
                    wide.screenshot(path=str(ROOT / "teaching/test-results/browser-failure-wide.png"))
                    raise
                finally:
                    r.passed += p1.passed
                r.passed += ["reduced motion shows the conclusion", "reduced motion: no moving values", "reduced motion: no spotlight"]
                r.check("no page errors", not errors, json.dumps(errors))
            except Exception as e:
                page.screenshot(path=str(ROOT / "teaching/test-results/browser-failure.png"))
                print(f"FAIL after {len(r.passed)} checks: {e}")
                import traceback
                print("".join(l for l in traceback.format_exc().splitlines(True) if "browser_acceptance.py" in l))
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
