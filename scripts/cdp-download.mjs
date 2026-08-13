#!/usr/bin/env node
// cdp-download.mjs — download a URL (typically a publisher PDF) through the
// user-authenticated Chrome instance via CDP download behavior.
// Usage:
//   node cdp-download.mjs --url <pdf-url> --out <file.pdf> [--timeout 120000]
//   node cdp-download.mjs --article <article-url> --out <file.pdf> [--timeout 120000]
import fs from "node:fs";
import path from "node:path";

const args = { timeout: 120000 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--url") args.url = process.argv[++i];
  else if (a === "--article") args.article = process.argv[++i];
  else if (a === "--out") args.out = process.argv[++i];
  else if (a === "--timeout") args.timeout = Number(process.argv[++i]);
  else if (a === "--help") { args.help = true; }
}
if (args.help || (!args.url && !args.article) || !args.out) {
  console.error("Usage: node cdp-download.mjs --url <pdf-url> | --article <article-url> --out <file.pdf> [--timeout ms]");
  process.exit(2);
}

const outPath = path.resolve(args.out);
const outDir = path.dirname(outPath);
fs.mkdirSync(outDir, { recursive: true });

const version = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
let attachedSession = null;
let downloadState = { started: false, completed: false, failed: false };

function send(method, params = {}, sessionId) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

ws.onmessage = (evt) => {
  const msg = JSON.parse(evt.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method === "Page.downloadWillBegin") {
    downloadState.started = true;
    downloadState.guid = msg.params.guid;
    downloadState.suggested = msg.params.suggestedFilename || "";
  }
  if (msg.method === "Page.downloadProgress") {
    if (msg.params.state === "completed") downloadState.completed = true;
    if (msg.params.state === "canceled") downloadState.failed = true;
  }
};

async function main() {
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

try {
  // Create a fresh page target and attach.
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  attachedSession = sessionId;
  await send("Page.enable", {}, sessionId);

  // Allow downloads into the target folder (browser-level behavior).
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: outDir, eventsEnabled: true });

  let pdfUrl = args.url;
  if (args.article && !args.url) {
    // Load the article page first, then click its "View PDF" link (user-like flow).
    await send("Page.navigate", { url: args.article }, sessionId);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const { result } = await send(
        "Runtime.evaluate",
        { expression: `document.readyState`, returnByValue: true },
        sessionId
      );
      if (result.value === "complete") break;
    }
    const findJs = `(() => {
      const els = Array.from(document.querySelectorAll('a, button'));
      const hit = els.find((el) => {
        const href = (el.href || "").toLowerCase();
        const txt = (el.innerText || "").toLowerCase();
        return href.includes("pdfft") || href.includes("/pdf") || href.includes("download") || txt.includes("download pdf") || (el.dataset && el.dataset.testid === "download");
      });
      return hit ? (hit.href || hit.innerText || "element") : null;
    })()`;
    const { result } = await send("Runtime.evaluate", { expression: findJs, returnByValue: true }, sessionId);
    pdfUrl = result.value;
    if (!pdfUrl) throw new Error("no PDF link found on article page");
    console.log(JSON.stringify({ stage: "article-loaded", pdfUrl }));
    // Real mouse click (user gesture) on the View PDF link.
    const rectJs = `(() => {
      const els = Array.from(document.querySelectorAll('a, button'));
      const hit = els.find((el) => {
        const href = (el.href || "").toLowerCase();
        const txt = (el.innerText || "").toLowerCase();
        return href.includes("pdfft") || href.includes("/pdf") || href.includes("download") || txt.includes("download pdf") || (el.dataset && el.dataset.testid === "download");
      });
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, href: hit.href || "", tag: hit.tagName, text: (hit.innerText || "").slice(0, 40) });
    })()`;
    const { result: rectResult } = await send("Runtime.evaluate", { expression: rectJs, returnByValue: true }, sessionId);
    const rect = JSON.parse(rectResult.value);
    if (!rect) throw new Error("no PDF link found on article page");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
  } else {
    await send("Page.navigate", { url: pdfUrl }, sessionId);
  }

  const deadline = Date.now() + args.timeout;
  while (Date.now() < deadline) {
    if (downloadState.failed) throw new Error("download canceled");
    // Chrome saves under an auto-generated name in outDir; find the freshest file.
    const candidates = fs
      .readdirSync(outDir)
      .filter((f) => f.endsWith(".pdf") || f.endsWith(".crdownload"))
      .map((f) => path.join(outDir, f))
      .filter((f) => {
        try { return Date.now() - fs.statSync(f).mtimeMs < 60000; } catch { return false; }
      })
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length > 0) {
      const newest = candidates[0];
      if (newest.endsWith(".crdownload")) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const size = fs.statSync(newest).size;
      if (size > 0) {
        const head = fs.readFileSync(newest).subarray(0, 8).toString("ascii");
        if (head.startsWith("%PDF")) {
          fs.renameSync(newest, outPath);
          console.log(JSON.stringify({ ok: true, out: outPath, bytes: size, signature: head }));
          process.exitCode = 0;
          return;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("timeout waiting for download");
} finally {
  try {
    if (attachedSession) await send("Target.detachFromTarget", { sessionId: attachedSession });
  } catch {}
  ws.close();
}
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
