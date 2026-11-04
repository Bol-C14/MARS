"""The English interface in a real browser (classroom 2026-11-03): an English
browser gets English; menus, assembling, stepping, the inspector, focus mode,
search, errors and the tutorial show no Chinese outside the student's own
code; switching language while paused keeps the program where it was.
Run from the repository root after the build:  python3 teaching/tests/i18n_browser.py
Exit 0 = all checks passed, 1 = a check failed, 2 = no usable browser."""
import json, pathlib, socket, subprocess, sys, time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from browser_acceptance import ROOT, free_port, launch  # noqa: E402

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("SKIP i18n browser check: Python Playwright is not installed")
    sys.exit(2)

# Chinese anywhere on the page, text or attribute, except the student's own
# code and output, file names, and the language list (each language is
# listed under its own name).
SCAN = r"""() => {
  const HAN = /[㐀-鿿]/;
  const skip = '.cm-content, .cm-gutters, #output, #language-list, [data-i18n="menu.view.language"], #files .tree-name, #tabs, #project-title, .tutorial-answer, .funtaken .frow code, .frow code, #focus-src';
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode, el = n.parentElement;
    if (!HAN.test(n.textContent) || !el || el.closest(skip) || el.closest('script, style')) continue;
    out.push(n.textContent.trim().slice(0, 70));
  }
  for (const el of document.querySelectorAll('[title], [aria-label], [placeholder], [data-tip]')) {
    if (el.closest(skip)) continue;
    for (const a of ['title', 'aria-label', 'placeholder', 'data-tip']) {
      const v = el.getAttribute(a);
      if (v && HAN.test(v)) out.push(`${el.id || el.tagName.toLowerCase()} ${a}: ${v.slice(0, 70)}`);
    }
  }
  return [...new Set(out)];
}"""

# Text that spills out of its box or is cut without "…" (an ellipsis shows
# the full text on hover). Longer languages make this the usual layout bug.
SPILL = r"""() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!(el.checkVisibility && el.checkVisibility()) || el.closest('.cm-editor, #output, svg') || el.classList.contains('tool-label')) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (/auto|scroll/.test(cs.overflowX) || cs.textOverflow === 'ellipsis') continue;
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) { out.push(el.textContent.trim().slice(0, 50)); continue; }
    let p = el.parentElement;
    while (p && getComputedStyle(p).overflowX === 'visible') p = p.parentElement;
    if (p && p !== document.body && !/auto|scroll/.test(getComputedStyle(p).overflowX) && el.getBoundingClientRect().right > p.getBoundingClientRect().right + 2)
      out.push(el.textContent.trim().slice(0, 50));
  }
  return [...new Set(out)];
}"""

PROGRAM = """.data
values: .word 7, -2, 9, 4
prompt: .asciiz "Number: "
.text
.globl main
main:
    la $a0, values
    li $a1, 4
    jal sum
    nop
    move $a0, $v0
    li $v0, 1
    syscall
    li $v0, 10
    syscall
sum:
    move $v0, $zero
loop:
    beqz $a1, done
    nop
    lw $t0, 0($a0)
    addu $v0, $v0, $t0
    addiu $a0, $a0, 4
    addiu $a1, $a1, -1
    b loop
    nop
done:
    jr $ra
    nop
"""


def main():
    port = free_port()
    server = subprocess.Popen(
        ["java", "-Djava.awt.headless=true", "-cp", "teaching/build/classes", "mars.ide.Server", str(port)],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    passed, failures = [], []
    try:
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        with sync_playwright() as p:
            browser = launch(p)
            page = browser.new_page(locale="en-US", viewport={"width": 1440, "height": 950})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            def check(name, ok, detail=""):
                (passed if ok else failures).append(name if ok else f"{name}: {detail}")

            def clean(where):
                left = page.evaluate(SCAN)
                check(f"no Chinese {where}", not left, json.dumps(left, ensure_ascii=False)[:900])

            page.goto(f"http://127.0.0.1:{port}")
            page.wait_for_function("() => Boolean(window.marsIDE)")
            page.wait_for_timeout(400)
            check("an English browser gets English", page.evaluate("document.documentElement.lang") == "en" and page.locator("#project-menu-button").inner_text() == "Project")
            clean("on the first page")
            for menu in ("project", "learn", "view"):
                page.locator(f"#{menu}-menu-button").click()
                page.wait_for_timeout(100)
                clean(f"in the {menu} menu")
                page.keyboard.press("Escape")
            page.locator("#engine").click(); clean("in the core menu"); page.keyboard.press("Escape")

            page.evaluate("(t) => { const e = window.marsIDE.editor; e.dispatch({ changes: { from: 0, to: e.state.doc.length, insert: t } }) }", PROGRAM)
            page.locator("#assemble").click()
            page.wait_for_function("() => window.marsIDE.state?.status === 'paused'")
            for _ in range(3):
                page.locator("#source").click()
                page.wait_for_function("(n) => window.marsIDE.state.step >= n", arg=1)
            page.wait_for_timeout(300)
            clean("while paused after stepping")
            page.evaluate("() => window.marsIDE.inspectToken('lw', {file: 'main.s', line: 21})")
            page.wait_for_timeout(200)
            clean("in the inspector for an instruction")
            page.evaluate("() => window.marsIDE.inspectToken('$a0')"); page.wait_for_timeout(150)
            clean("in the inspector for a register")
            page.evaluate("() => window.marsIDE.inspectToken('syscall', {file: 'main.s', line: 13})"); page.wait_for_timeout(150)
            clean("in the inspector for a syscall")
            page.locator("#focus-open").click()
            page.wait_for_function("() => !document.getElementById('focus-lens').hidden")
            page.wait_for_timeout(500)
            clean("in focus mode")
            page.keyboard.press("Escape")
            page.locator("#commands").click(); page.wait_for_timeout(150); clean("in the command palette"); page.keyboard.press("Escape")
            page.locator("#learn-menu-button").click(); page.locator("#find-instruction").click()
            page.locator("#find-input").fill("add") if page.locator("#find-input").count() else page.keyboard.type("add")
            page.wait_for_timeout(200)
            clean("in instruction search")
            found = page.locator("#modal").inner_text()
            check("English words find instructions", "addu" in found or "addition" in found.lower(), found[:200])
            page.keyboard.press("Escape")
            page.locator("#radix-help").click(); page.wait_for_timeout(150); clean("in the number format help"); page.keyboard.press("Escape")

            # Live switch: the paused program stays where it was.
            step = page.evaluate("window.marsIDE.state.step")
            page.locator("#view-menu-button").click()
            page.locator('[data-language="zh-CN"]').click()
            page.wait_for_timeout(300)
            check("switching to Chinese applies at once", page.locator("#project-menu-button").inner_text() == "工程" and "完整运行" in (page.locator("#run").get_attribute("aria-label") or "") + (page.locator("#run").inner_text()) or "回到开头" in (page.locator("#run").get_attribute("aria-label") or ""))
            check("switching keeps the paused program", page.evaluate("window.marsIDE.state.step") == step and page.evaluate("window.marsIDE.state.status") == "paused")
            page.keyboard.press("Escape")
            page.locator("#view-menu-button").click()
            page.locator('[data-language="en"]').click()
            page.wait_for_timeout(300)
            page.keyboard.press("Escape")
            clean("after switching back to English")
            page.reload(); page.wait_for_function("() => Boolean(window.marsIDE)")
            check("the chosen language is remembered", page.evaluate("document.documentElement.lang") == "en")

            # MARS messages: English as MARS wrote them.
            page.evaluate("() => { const e = window.marsIDE.editor; e.dispatch({ changes: { from: 0, to: e.state.doc.length, insert: '.text\\nmain:\\n add $t0, $t1\\n' } }) }")
            page.locator("#assemble").click()
            page.wait_for_function("() => window.marsIDE.state?.status === 'error'")
            problems = page.locator("#problems").inner_text()
            check("assembly errors read as MARS wrote them", "Too few or incorrectly formatted operands" in problems, problems[:200])
            clean("with an assembly error")

            page.locator("#learn-menu-button").click(); page.locator("#start-tutorial").click(); page.wait_for_timeout(200)
            clean("in the tutorial start")
            page.locator("#tutorial-begin").click(); page.wait_for_timeout(500)
            clean("in the first tutorial step")
            check("no page errors", not errors, json.dumps(errors)[:400])

            # Layout: English and a pseudo-language about 40% longer fit at
            # common widths, while paused, in focus mode and in each menu.
            for lang in ("en", "pseudo"):
                for width, height in ((1280, 800), (1024, 720)):
                    view = browser.new_page(locale="en-US", viewport={"width": width, "height": height})
                    view.goto(f"http://127.0.0.1:{port}/?lang={lang}")
                    view.wait_for_function("() => Boolean(window.marsIDE)")
                    view.evaluate("(t) => { const e = window.marsIDE.editor; e.dispatch({ changes: { from: 0, to: e.state.doc.length, insert: t } }) }", PROGRAM)
                    view.locator("#assemble").click()
                    view.wait_for_function("() => window.marsIDE.state?.status === 'paused'")
                    view.locator("#source").click(); view.locator("#source").click()
                    view.wait_for_timeout(300)
                    spilled = view.evaluate(SPILL)
                    for menu in ("project", "learn", "view"):
                        view.locator(f"#{menu}-menu-button").click(); view.wait_for_timeout(80)
                        spilled += view.evaluate(SPILL); view.keyboard.press("Escape")
                    view.locator("#focus-open").click(); view.wait_for_timeout(600)
                    spilled += view.evaluate(SPILL)
                    check(f"{lang} text fits at {width}px", not spilled, json.dumps(sorted(set(spilled)), ensure_ascii=False)[:600])
                    view.close()
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)
    if failures:
        print("FAIL i18n browser check")
        for f in failures:
            print("  -", f)
        print("passed:", passed)
        sys.exit(1)
    print(f"PASS: {len(passed)} English interface checks")


main()
