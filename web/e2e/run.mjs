// Headless browser end-to-end check of the Phase 2 UI against the dev servers.
// Run with: node e2e/run.mjs   (requires uvicorn:8000 + vite:5173 running)
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5173";
const results = [];
const check = (name, ok, detail = "") => results.push([name, !!ok, detail]);

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const setSource = (i, src) =>
  page.evaluate(
    ([idx, s]) => {
      const st = window.__store.getState();
      st.setSource(st.cells[idx].id, s);
    },
    [i, src],
  );
const cellCount = () => page.evaluate(() => window.__store.getState().cells.length);

async function runAndWaitIdle(cellLocator, index) {
  const before = await page.evaluate(
    (i) => window.__store.getState().cells[i].execution_count,
    index,
  );
  await cellLocator.locator(".run-btn").click();
  await page.waitForFunction(
    ([i, b]) => {
      const c = window.__store.getState().cells[i];
      return c && c.execution_state === "idle" && c.execution_count !== b;
    },
    [index, before],
    { timeout: 25000 },
  );
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".toolbar");
  await page.waitForFunction(() => !!window.__store && window.__store.getState().connected, null, {
    timeout: 15000,
  });
  await page.waitForSelector(".cell");

  // 1) starter markdown title is rendered
  const h1 = await page.locator(".cell.markdown .markdown-rendered h1").first().textContent();
  check("markdown title rendered", h1?.includes("Notebook Clone"), `h1=${JSON.stringify(h1)}`);

  const codeCell = page.locator(".cell.code").first();

  // 2) stdout
  await runAndWaitIdle(codeCell, 1);
  const out = await codeCell.locator(".output.stream").first().textContent();
  check("stdout output (hi)", out?.includes("hi"), `out=${JSON.stringify(out)}`);

  // 3) traceback, no crash
  await setSource(1, "1/0");
  await runAndWaitIdle(codeCell, 1);
  const err = await codeCell.locator(".output.error").first().textContent();
  check("traceback (ZeroDivisionError)", err?.includes("ZeroDivisionError"), "");

  // 4) matplotlib inline PNG
  await setSource(
    1,
    "%matplotlib inline\nimport matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([1, 2, 3], [1, 4, 9])",
  );
  await runAndWaitIdle(codeCell, 1);
  const imgSrc = await codeCell.locator("img.output.image").first().getAttribute("src");
  check("matplotlib png", imgSrc?.startsWith("data:image/png;base64,"), "");

  // 5) persistent kernel: define var, then use it from a new cell
  await setSource(1, "persist_var = 123");
  await runAndWaitIdle(codeCell, 1);
  await page.locator(".toolbar button", { hasText: "+ Cell" }).click();
  check("add cell", (await cellCount()) === 3, `count=${await cellCount()}`);
  await setSource(2, "print(persist_var + 1)");
  const lastCell = page.locator(".cell.code").last();
  await runAndWaitIdle(lastCell, 2);
  const ptext = await lastCell.locator(".output.stream").first().textContent();
  check("variable persists across cells", ptext?.includes("124"), `ptext=${JSON.stringify(ptext)}`);

  // 6) restart clears state -> NameError
  await page.locator(".toolbar button", { hasText: "Restart" }).click();
  await page.waitForTimeout(400);
  await page.waitForFunction(() => window.__store.getState().kernelStatus === "ready", null, {
    timeout: 20000,
  });
  await setSource(2, "print(persist_var)");
  await runAndWaitIdle(lastCell, 2);
  const rerr = await lastCell.locator(".output.error").first().textContent();
  check("restart clears state (NameError)", rerr?.includes("NameError"), "");

  // 7) add markdown cell + render
  await page.locator(".add-row button", { hasText: "+ Markdown" }).click();
  const ids = await page.evaluate(() => window.__store.getState().cells.map((c) => c.id));
  await page.evaluate(
    (id) => window.__store.getState().setSource(id, "# Hello E2E"),
    ids[ids.length - 1],
  );
  const mdCell = page.locator(".cell.markdown").last();
  await mdCell.locator(".run-btn").click();
  await mdCell.locator(".markdown-rendered h1").waitFor({ timeout: 5000 });
  const mdh1 = await mdCell.locator(".markdown-rendered h1").textContent();
  check("markdown render", mdh1?.includes("Hello E2E"), `mdh1=${JSON.stringify(mdh1)}`);

  // 8) ANSI-colored traceback -> error output contains colored <span>s
  await setSource(1, "1/0");
  await runAndWaitIdle(codeCell, 1);
  const spanCount = await codeCell.locator(".output.error span").count();
  check("ansi-colored traceback", spanCount > 0, `spans=${spanCount}`);

  // 9) queued indicator: long cell + quick cell, run-all -> quick one is queued
  await setSource(1, "import time; time.sleep(1.5)");
  await setSource(2, "print('done2')");
  await page.locator(".toolbar button", { hasText: "Run all" }).click();
  const sawQueued = await page
    .waitForFunction(
      () => window.__store.getState().cells.some((c) => c.execution_state === "queued"),
      null,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  check("queued indicator", sawQueued, "");
  await page.waitForFunction(
    () => window.__store.getState().cells.every((c) => c.execution_state === "idle"),
    null,
    { timeout: 20000 },
  );

  // 10) checkpoint create -> restore dropdown becomes enabled with an option
  await page.locator(".toolbar button", { hasText: "Checkpoint" }).click();
  const checkpointOk = await page
    .waitForFunction(
      () => {
        const sel = document.querySelector(".restore-select");
        return sel && !sel.disabled && sel.options.length > 1;
      },
      null,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  check("checkpoint created", checkpointOk, "");

  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
} catch (e) {
  check("script completed", false, String(e).split("\n")[0]);
} finally {
  await browser.close();
}

console.log("\n=== E2E UI RESULTS ===");
let allok = true;
for (const [n, ok, d] of results) {
  allok = allok && ok;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}${d ? "  (" + d + ")" : ""}`);
}
console.log(allok ? "=== ALL PASS ===" : "=== SOME FAILED ===");
process.exit(allok ? 0 : 1);
