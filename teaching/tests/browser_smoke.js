async (page) => {
  await page.addInitScript(() => {
    window.testErrors = [];
    window.addEventListener("error", (e) => window.testErrors.push(e.message));
    window.addEventListener("unhandledrejection", (e) =>
      window.testErrors.push(String(e.reason)),
    );
  });
  const assert = (ok, message) => {
    if (!ok) throw Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("http://127.0.0.1:8765");
  await page.waitForFunction(() => window.marsIDE?.state?.status === "paused");
  await page.locator("#commands").click();
  await page.locator("#command-filter").fill("实线");
  assert(
    (await page.locator("[data-command]:visible").count()) === 1,
    "Command filtering",
  );
  await page.locator("#modal .close").click();
  await page.locator("#run").click();
  await page.waitForFunction(() => window.marsIDE.state.status === "waiting");
  await page.locator("#stdin").fill("898");
  await page.locator("#input-form button").click();
  await page.waitForFunction(() => window.marsIDE.state.status === "paused");
  await page.locator("#run").click();
  await page.waitForFunction(() => window.marsIDE.state.status === "ended");
  assert(
    (await page.locator("#output").innerText()).endsWith("00000382"),
    "hexOut output",
  );
  await page.locator("#back").click();
  await page.waitForFunction(() => window.marsIDE.state.status === "paused");
  await page.locator('[data-register="$v0"]').click();
  await page.locator("#refs").click();
  assert((await page.locator("[data-ref]").count()) > 0, "Register references");
  await page.locator("#modal .close").click();
  await page.locator("#clear-focus").click();
  await page.selectOption("#example", { label: "Task 1 · 文件与调用" });
  await page.waitForFunction(
    () =>
      window.marsIDE.program.instructions.some((i) => i.file === "task1.s") &&
      window.marsIDE.state.step === 0,
  );
  const address = await page.evaluate(
    () =>
      window.marsIDE.program.instructions.find(
        (i) => i.file === "task1.s" && i.line === 21,
      ).address,
  );
  await page.locator('[data-view="machine"]').click();
  await page.locator(`[data-machine-bp="${address}"]`).click();
  await page.locator("#run").click();
  await page.waitForFunction((a) => window.marsIDE.state.pc === a, address);
  assert(
    (await page.locator("#banner").innerText()).includes("Breakpoint"),
    "Breakpoint pause",
  );
  await page.evaluate((a) => window.marsIDE.gotoAddress(a), address);
  await page.locator("#step").click();
  await page.waitForFunction(
    () => window.marsIDE.state.last.instruction.op === "lbu",
  );
  await page.waitForFunction(
    () => document.querySelectorAll("#overlay>path").length > 0,
  );
  assert(
    (await page.locator("#overlay>path[stroke-dasharray]").count()) > 0,
    "Preview lines",
  );
  await page.locator("#dashed").uncheck();
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#overlay>path[stroke-dasharray]").length === 0,
  );
  assert(
    (await page.locator("#overlay>path").count()) > 0,
    "Actual lines independent",
  );
  await page.locator("#solid").uncheck();
  await page.waitForFunction(
    () => document.querySelectorAll("#overlay>path").length === 0,
  );
  await page.locator("#solid").check();
  await page.locator("#dashed").check();
  await page.locator("#zoom").click();
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.waitForFunction(
    () => document.querySelectorAll("#overlay>path").length > 0,
  );
  const paths = await page
    .locator("#overlay>path")
    .evaluateAll((paths) => paths.map((p) => p.getAttribute("d")));
  assert(
    paths.every((p) => !p.includes("NaN")),
    "Finite overlay anchors",
  );
  await page.locator('[data-view="cfg"]').click();
  assert((await page.locator(".block").count()) > 1, "CFG blocks");
  await page.locator('[data-view="source"]').click();
  await page.locator('[data-bottom="trace"]').click();
  assert(
    (await page.locator(".loop-history").count()) > 0,
    "Loop iteration groups",
  );
  await page.locator("#add-watch").click();
  await page.locator("#watch-target").fill("$t0");
  await page.selectOption("#watch-access", "read");
  await page.locator("#watch-form button").click();
  await page.locator("#run").click();
  await page.waitForFunction(() =>
    window.marsIDE.state.stopReason.includes("Watchpoint"),
  );
  await page.locator("#theme").click();
  await page.evaluate(() => {
    let e = window.marsIDE.editor;
    e.dispatch({
      changes: { from: e.state.doc.length, insert: "\n# edit test" },
    });
  });
  assert(
    await page.locator("#step").isDisabled(),
    "Dirty source blocks stale execution",
  );
  await page.locator("#assemble").click();
  await page.waitForFunction(
    () =>
      window.marsIDE.state.step === 0 &&
      !document.querySelector("#step").disabled,
  );
  const errors = await page.evaluate(() => window.testErrors);
  assert(errors.length === 0, JSON.stringify(errors));
  return { passed: true, checks: 16, viewport: [1280, 850], errors };
}
