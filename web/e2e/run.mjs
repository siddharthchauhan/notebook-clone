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
page.on("dialog", (d) => d.accept()); // auto-accept confirm() (e.g. delete notebook)

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

  // 11) AI assist (Phase 3). Exercised when the server has a provider
  //     configured — the e2e run sets NBCLONE_AI_PROVIDER=echo. When AI is off,
  //     the per-cell controls must be hidden entirely.
  const aiAvailable = await page.evaluate(() => window.__store.getState().aiAvailable);
  if (aiAvailable) {
    const before = await cellCount();
    const firstCode = page.locator(".cell.code").first();
    await firstCode.locator(".ai-toggle").click();
    await firstCode.locator(".ai-input").fill("say hi");
    await firstCode.locator(".ai-generate").click();
    const inserted = await page
      .waitForFunction(
        (n) => {
          const cells = window.__store.getState().cells;
          return cells.length === n + 1 && cells.some((c) => c.source.includes("hello from ai"));
        },
        before,
        { timeout: 10000 },
      )
      .then(() => true)
      .catch(() => false);
    check("ai generate inserts a cell", inserted, "");

    // Explain streams Markdown into a preview panel (non-destructive).
    const explainCell = page.locator(".cell.code").first();
    await explainCell.locator(".ai-toggle").click();
    await explainCell.locator(".ai-explain").click();
    const explained = await explainCell
      .locator(".ai-preview.text")
      .filter({ hasText: "None" })
      .first()
      .waitFor({ timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    check("ai explain panel", explained, "");
  } else {
    const toggles = await page.locator(".ai-toggle").count();
    check("ai controls hidden when unavailable", toggles === 0, `toggles=${toggles}`);
  }

  // 12) variable explorer: define vars, open the panel, see them listed
  await setSource(1, 'explorer_var = 42\nexplorer_map = {"a": 1, "b": 2}');
  await runAndWaitIdle(page.locator(".cell.code").first(), 1);
  await page.locator(".btn-variables").click();
  const sawVar = await page
    .locator(".var-name", { hasText: "explorer_var" })
    .first()
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("variable explorer lists var", sawVar, "");

  // 12b) inspect a variable's value (kernel inspect)
  await page.locator(".var-inspect", { hasText: "explorer_var" }).first().click();
  const inspected = await page
    .locator(".var-inspect-panel")
    .filter({ hasText: "int" })
    .first()
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("variable inspect", inspected, "");

  // 12c) expand a container variable to see its children
  await page.locator(".var-row", { hasText: "explorer_map" }).locator(".var-expand").click();
  const expandedChild = await page
    .locator(".var-child-row", { hasText: "'a'" })
    .first()
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("variable expand children", expandedChild, "");

  // 12d) sort by a column header
  await page.locator(".var-th", { hasText: "Type" }).click();
  const sorted = await page
    .locator(".var-th.sorted", { hasText: "Type" })
    .first()
    .waitFor({ timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  check("variable sort", sorted, "");

  // 12e) delete a variable from the kernel
  await page.locator(".var-row", { hasText: "explorer_var" }).locator(".var-del").click();
  const deleted = await page
    .waitForFunction(
      () => ![...document.querySelectorAll(".var-inspect")].some((el) => el.textContent === "explorer_var"),
      null,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  check("variable delete", deleted, "");

  // 12f) ipywidgets: a live IntSlider renders, with its kernel-side value
  // (exercises the full widget manager + comm_open round-trip in the browser).
  await setSource(1, "import ipywidgets as w\nslider = w.IntSlider(value=5)\nslider");
  await runAndWaitIdle(page.locator(".cell.code").first(), 1);
  const widgetReadout = await page
    .locator(".jupyter-widgets .widget-readout")
    .filter({ hasText: "5" })
    .first()
    .waitFor({ timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("ipywidgets slider renders", widgetReadout, "");

  // 12g) data connectors: create a SQLite DB, then load it via the connector UI
  await setSource(
    1,
    "import sqlite3\n_c = sqlite3.connect('e2e_conn.db')\n_c.execute('DROP TABLE IF EXISTS t')\n_c.execute('CREATE TABLE t (x)')\n_c.execute('INSERT INTO t VALUES (4242)')\n_c.commit()\n_c.close()",
  );
  await runAndWaitIdle(page.locator(".cell.code").first(), 1);
  await page.locator(".btn-data").click();
  await page.selectOption(".conn-select", "sqlite");
  await page.fill('.conn-field[name="db_path"]', "e2e_conn.db");
  await page.fill('.conn-field[name="query"]', "SELECT x FROM t");
  await page.fill('.conn-field[name="var"]', "conn_df");
  await page.locator(".conn-load").click();
  const connLoaded = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll(".outputs")].some(
          (el) => el.textContent && el.textContent.includes("4242"),
        ),
      null,
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);
  check("data connector loads sqlite", connLoaded, "");

  // 12h) SQL block: create a DB, add a SQL block, configure it via the store,
  // run it, and see the queried value render in that block's output.
  await setSource(
    1,
    "import sqlite3\n_c = sqlite3.connect('e2e_sqlblock.db')\n_c.execute('DROP TABLE IF EXISTS t')\n_c.execute('CREATE TABLE t (x)')\n_c.execute('INSERT INTO t VALUES (31337)')\n_c.commit()\n_c.close()",
  );
  await runAndWaitIdle(page.locator(".cell.code").first(), 1);
  await page.locator(".btn-add-sql").click();
  await page.evaluate(() => {
    const st = window.__store.getState();
    const cells = st.cells;
    const sqlCell = cells[cells.length - 1];
    st.setSource(sqlCell.id, "SELECT x FROM t");
    st.setCellMetadata(sqlCell.id, {
      connection: { type: "sqlite", db_path: "e2e_sqlblock.db" },
      result_var: "sqldf",
    });
  });
  await page.locator(".cell.sql .run-btn").last().click();
  const sqlOk = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll(".cell.sql .outputs")].some(
          (el) => el.textContent && el.textContent.includes("31337"),
        ),
      null,
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);
  check("sql block runs query", sqlOk, "");

  // 12i) input block: a no-code control binds a kernel global usable from code.
  await page.locator(".btn-add-input").click();
  await page.evaluate(() => {
    const st = window.__store.getState();
    const cells = st.cells;
    const inp = cells[cells.length - 1];
    st.setCellMetadata(inp.id, {
      input_type: "text",
      var_name: "thresh",
      value: "inp_tok_777",
    });
  });
  await page.locator(".cell.input .run-btn").last().click(); // "Set"
  await setSource(1, "print(thresh)");
  await runAndWaitIdle(page.locator(".cell.code").first(), 1);
  const inputOk = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll(".cell.code .outputs")].some(
          (el) => el.textContent && el.textContent.includes("inp_tok_777"),
        ),
      null,
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  check("input block binds variable", inputOk, "");

  // 13) export endpoints (.ipynb + HTML)
  const ipynbResp = await page.request.get(`${BASE}/api/contents/default/export/ipynb`);
  check(
    "export ipynb",
    ipynbResp.ok() && (ipynbResp.headers()["content-type"] || "").includes("ipynb"),
    `status=${ipynbResp.status()}`,
  );
  const htmlResp = await page.request.get(`${BASE}/api/contents/default/export/html`);
  const htmlBody = await htmlResp.text();
  check(
    "export html",
    htmlResp.ok() && htmlBody.toLowerCase().includes("<html"),
    `status=${htmlResp.status()}`,
  );

  // 14) AI chat (echo provider) — only when AI is configured
  if (aiAvailable) {
    await page.locator(".btn-chat").click();
    await page.locator(".chat-input").fill("ping from e2e");
    await page.locator(".chat-send").click();
    const replied = await page
      .locator(".chat-msg.assistant")
      .filter({ hasText: "ping from e2e" })
      .first()
      .waitFor({ timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    check("ai chat reply", replied, "");
  }

  // 15) multi-notebook: create + switch, then delete (auto-switches away)
  await page.locator(".btn-notebooks").click();
  await page.locator(".nb-new-input").fill("e2e_nb");
  await page.locator(".nb-new").click();
  const switched = await page
    .waitForFunction(() => document.querySelector(".btn-notebooks")?.textContent?.includes("e2e_nb"), null, {
      timeout: 8000,
    })
    .then(() => true)
    .catch(() => false);
  check("notebook create + open", switched, "");

  await page.locator(".nb-item", { hasText: "e2e_nb" }).locator(".nb-delete").click();
  const removed = await page
    .waitForFunction(
      () =>
        !document.querySelector(".btn-notebooks")?.textContent?.includes("e2e_nb") &&
        ![...document.querySelectorAll(".nb-item")].some((el) => el.textContent?.includes("e2e_nb")),
      null,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  check("notebook delete", removed, "");

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
