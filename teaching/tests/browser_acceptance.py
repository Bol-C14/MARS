"""Browser acceptance for the teaching IDE: real key and mouse events through
Playwright against a private local server. Run from the repository root after
`sh teaching/scripts/build.sh`:  python3 teaching/tests/browser_acceptance.py
Exit 0 = all checks passed, 1 = a check failed, 2 = no usable browser."""
import glob, json, os, pathlib, socket, subprocess, sys, time

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
    page.check("#fast-run")

    # --- M1/M2 workflow (ported from the earlier smoke script) ---
    page.keyboard.press(f"{mod}+Shift+P")
    page.locator("#picker-input").press_sequentially("实线")
    r.check("command palette filters", page.locator("#picker-list .command-item").count() == 1)
    page.keyboard.press("Escape")

    page.select_option("#example", label="Hexadecimal · 位与字符")
    r.until("() => window.marsIDE.files['main.s']?.includes('Hex') && window.marsIDE.state.step === 0")
    page.locator("#run").click()
    r.until("() => window.marsIDE.state.status === 'waiting'")
    page.locator("#stdin").fill("898")
    page.locator("#input-form button").click()
    r.until("() => window.marsIDE.state.status === 'paused'")
    page.locator("#run").click()
    r.until("() => window.marsIDE.state.status === 'ended'")
    r.check("hexOut output", page.locator("#output").inner_text().endswith("00000382"))
    page.locator("#back").click()
    r.until("() => window.marsIDE.state.status === 'paused'")
    page.locator('[data-register="$v0"]').click()
    page.locator("#refs").click()
    r.check("register references", page.locator("[data-ref]").count() > 0)
    page.locator("#modal .close").click()
    page.locator("#clear-focus").click()

    page.select_option("#example", label="Task 1 · 文件与调用")
    r.until("() => window.marsIDE.program.instructions.some(i => i.file === 'task1.s') && window.marsIDE.state.step === 0")
    address = r.js("() => window.marsIDE.program.instructions.find(i => i.file === 'task1.s' && i.line === 21).address")
    page.locator('[data-view="machine"]').click()
    page.locator(f'[data-machine-bp="{address}"]').click()
    page.locator("#run").click()
    r.until("(a) => window.marsIDE.state.pc === a", address)
    r.check("breakpoint pause", "Breakpoint" in page.locator("#banner").inner_text())
    r.js("(a) => window.marsIDE.gotoAddress(a)", address)
    page.locator("#step").click()
    r.until("() => window.marsIDE.state.last.instruction.op === 'lbu'")
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
    r.until("() => window.marsIDE.state.stopReason.includes('Watchpoint')")
    r.check("read watchpoint", True)
    r.js("() => document.querySelector('[data-watch]')?.click()")

    # --- M2.5: inline values ---
    r.check("inline execution values", page.locator(".cm-inline-value").count() > 0)

    # --- M2.5: VS Code keys ---
    page.keyboard.press("Shift+F5")
    r.until("() => window.marsIDE.state.step === 0")
    r.js("() => window.marsIDE.editor.focus()")
    page.keyboard.press("F11")
    r.until("() => window.marsIDE.state.step === 2")  # la expands to two instructions
    page.keyboard.press("Alt+F11")
    r.until("() => window.marsIDE.state.step === 3")
    page.keyboard.press("Shift+F9")
    r.until("() => window.marsIDE.state.step === 2")
    r.js("() => { try { localStorage.removeItem('key-hint:F7') } catch {} }")
    page.keyboard.press("F7")
    r.check("retired key hint", "Alt+F11" in page.locator("#banner").inner_text() and state()["step"] == 2)
    r.check("debug keys F11 / Alt+F11 / Shift+F9 / Shift+F5", True)

    # --- M2.5 W7: quick open, outline, peek, context menu, logpoint ---
    page.keyboard.press(f"{mod}+P")
    page.locator("#picker-input").press_sequentially("loadf")
    page.keyboard.press("Enter")
    r.until("() => document.querySelector('.tabs .active')?.textContent.includes('libio.s')")
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
    page.keyboard.press("Escape")
    r.until("() => !document.querySelector('.cm-peek')")
    row = page.locator(".cm-line", has_text="lbu $t0, 0($s0)").first
    row.click(button="right")
    r.check("editor context menu", page.locator("#context-menu button").count() == 5)
    page.locator("#context-menu button", has_text="编辑断点").click()
    page.locator("#bp-hit").fill("2")
    page.locator("#bp-log").fill("byte={$t0}")
    page.locator("#bp-form button.primary").click()
    r.check("logpoint glyph in sidebar", "◆" in page.locator("#breakpoints").inner_text())
    page.keyboard.press("Shift+F5")
    r.until("() => window.marsIDE.state.step === 0")
    r.js("() => document.querySelectorAll('[data-bp-enable]').forEach(c => { if (!c.closest('.bp-row').textContent.includes('◆')) { c.checked = false; c.dispatchEvent(new Event('change')) } })")
    page.keyboard.press("F5")
    r.until("() => window.marsIDE.state.status === 'ended'")
    page.locator('[data-bottom="logs"]').click()
    logs = page.locator("#logs").inner_text()
    r.check("logpoint logs once on 2nd hit without pausing", logs.count("byte=") == 1, logs)

    # --- M2.5 W4: focus mode ---
    page.keyboard.press("Shift+F5")
    r.until("() => window.marsIDE.state.step === 0")
    r.js("() => document.querySelector('[data-bottom=console]').click()")
    for _ in range(3):
        page.keyboard.press("F11")
        page.wait_for_timeout(150)
    page.keyboard.press(f"{mod}+K")
    page.keyboard.press("f")
    r.until("() => !document.getElementById('focus-lens').hidden && document.querySelectorAll('.fseg').length > 0")
    r.check("focus mode via Cmd/Ctrl+K F", True)
    r.check("lens shows touched objects", page.locator(".fobj").count() > 0)
    template = page.locator("#focus-eq").inner_text()
    r.until("(t) => document.getElementById('focus-eq').textContent !== t", template)
    r.check("fill-in beats play", True)
    before = state()["step"]
    page.keyboard.press("ArrowDown")
    r.until("(n) => window.marsIDE.state.step > n", before)
    page.keyboard.press("ArrowUp")
    r.until("(n) => window.marsIDE.state.step === n", before)
    r.check("lens arrow keys move by source line", True)
    page.keyboard.press("Tab")
    page.keyboard.press("Tab")
    r.check("Tab selects a predicted step", "预计" in page.locator("#focus-tag").inner_text())
    page.keyboard.press("Enter")
    r.until("(n) => window.marsIDE.state.step > n", before)
    r.check("Enter runs to the selected step", r.js("() => document.getElementById('focus-tag').textContent") == "刚完成")
    # Holding ↓: OS auto-repeat arrives as keydown events with repeat set.
    held = r.js("""async () => {
        const start = window.marsIDE.state.step, tokens = [];
        const send = (type, repeat) => window.dispatchEvent(new KeyboardEvent(type, { key: 'ArrowDown', repeat, bubbles: true }));
        send('keydown', false);
        for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 40)); send('keydown', true); tokens.push(document.querySelectorAll('.ftoken').length) }
        await new Promise(r => setTimeout(r, 300));
        const moved = window.marsIDE.state.step - start;
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
    r.until("() => window.marsIDE.state.step === 0 && !document.querySelector('#step').disabled")
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
            mod = "Meta" if "Mac" in page.evaluate("navigator.platform") else "Control"
            r = Run(page)
            try:
                scenario(r, page, mod)
                calm = browser.new_page(viewport={"width": 1280, "height": 850}, reduced_motion="reduce")
                calm.on("pageerror", lambda e: errors.append(str(e)))
                calm.goto(f"http://127.0.0.1:{port}")
                reduced_motion(Run(calm), calm, mod)
                r.passed += ["reduced motion shows the conclusion", "reduced motion: no moving values"]
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
