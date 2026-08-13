#!/usr/bin/env node
// cdp-pdf-fetch.mjs — article → click "View PDF" → locate the PDF tab → fetch bytes
// from the PDF origin (same-origin fetch carries the signed URL / session).
// Usage:
//   node cdp-pdf-fetch.mjs --article <article-url> --out <file.pdf> [--click-timeout 60000] [--fetch-timeout 180000]
import fs from "node:fs";
import path from "node:path";

const args = { clickTimeout: 60000, fetchTimeout: 180000, cooldown: 15000 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--article") args.article = process.argv[++i];
  else if (a === "--out") args.out = process.argv[++i];
  else if (a === "--click-timeout") args.clickTimeout = Number(process.argv[++i]);
  else if (a === "--fetch-timeout") args.fetchTimeout = Number(process.argv[++i]);
  else if (a === "--cooldown") args.cooldown = Number(process.argv[++i]);
}
if (!args.article || !args.out) {
  console.error("Usage: node cdp-pdf-fetch.mjs --article <article-url> --out <file.pdf>");
  process.exit(2);
}

const outPath = path.resolve(args.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const version = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
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
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

function isPdfishUrl(u) {
  if (!u) return false;
  return (
    u.includes(".pdf") ||
    u.includes("pdf.sciencedirectassets.com") ||
    u.includes("download_pub")
  ) && !u.includes("crasolve");
}

async function getPageTargets() {
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  return list.filter((t) => t.type === "page").map((t) => ({ ...t, targetId: t.id }));
}

async function fetchFromSession(sessionId, url) {
  const fetchJs = `(async () => {
    const r = await fetch(${JSON.stringify(url)}, { credentials: "include" });
    const ct = r.headers.get("content-type") || "";
    const ab = await r.arrayBuffer();
    window.__pdfBytes = new Uint8Array(ab);
    return { ok: r.ok, status: r.status, ct, size: window.__pdfBytes.length, head: Array.from(window.__pdfBytes.slice(0, 8)) };
  })()`;
  const { result } = await send("Runtime.evaluate", { expression: fetchJs, returnByValue: true, awaitPromise: true }, sessionId);
  const meta = result.value;
  if (!meta && result.exceptionDetails) {
    throw new Error(`page fetch exception: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
  }
  if (!meta || !meta.ok || !meta.size) throw new Error(`fetch failed: ${JSON.stringify(meta)}`);
  const head = Buffer.from(meta.head || []);
  if (!head.toString("ascii").startsWith("%PDF")) throw new Error(`not a PDF: ct=${meta.ct} head=${head.toString("ascii")}`);
  const stream = fs.createWriteStream(outPath);
  const size = Number(meta.size);
  for (let start = 0; start < size; start += 262144) {
    const end = Math.min(start + 262144, size);
    const chunkJs = `(() => {
      const bytes = window.__pdfBytes.slice(${start}, ${end});
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    })()`;
    const { result: chunkResult } = await send("Runtime.evaluate", { expression: chunkJs, returnByValue: true }, sessionId);
    stream.write(Buffer.from(chunkResult.value, "base64"));
  }
  await new Promise((res, rej) => { stream.end(res); stream.on("error", rej); });
  return size;
}

async function main() {
  let createdTarget = null;
  let sessionId = null;
  try {
    if (fs.existsSync(outPath)) {
      console.log(JSON.stringify({ ok: false, status: "skipped_existing", out: outPath }));
      return;
    }
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    createdTarget = targetId;
    const attached = await send("Target.attachToTarget", { targetId, flatten: true });
    sessionId = attached.sessionId;
    await send("Page.enable", {}, sessionId);
    await send("Page.navigate", { url: args.article }, sessionId);

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const { result } = await send("Runtime.evaluate", { expression: `document.readyState`, returnByValue: true }, sessionId);
      if (result?.value === "complete") break;
    }

    const findJs = `(() => {
      const els = Array.from(document.querySelectorAll('a, button'));
      const hit = els.find((el) => {
        const href = (el.href || "").toLowerCase();
        const txt = (el.innerText || "").toLowerCase();
        return href.includes("pdfft") || href.includes("/pdf") || href.includes("download") || txt.includes("download pdf") || (el.dataset && el.dataset.testid === "download");
      });
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, href: hit.href || "" });
    })()`;
    const { result: rectRes } = await send("Runtime.evaluate", { expression: findJs, returnByValue: true }, sessionId);
    const rect = JSON.parse(rectRes.value || "null");
    if (!rect) throw new Error("no PDF element found on article page");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);

    // Wait for either this tab or a new tab to land on a PDF URL.
    let pdfSession = null;
    let pdfUrl = null;
    const deadline = Date.now() + args.clickTimeout;
    while (Date.now() < deadline) {
      const { result } = await send("Runtime.evaluate", { expression: `location.href`, returnByValue: true }, sessionId);
      const href = result?.value || "";
      if (href.includes("crasolve") || href.includes("CPE00001")) {
        throw new Error("publisher bot block (crasolve/CPE00001) — IP likely flagged; aborting this item");
      }
      if (isPdfishUrl(href)) { pdfSession = sessionId; pdfUrl = href; break; }
      const targets = await getPageTargets();
      const hit = targets.find((t) => t.targetId !== createdTarget && isPdfishUrl(t.url));
      if (hit) {
        const attached = await send("Target.attachToTarget", { targetId: hit.targetId, flatten: true });
        pdfSession = attached.sessionId;
        pdfUrl = hit.url;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!pdfSession) throw new Error("PDF tab not found (blocked or no download)");
    console.log(JSON.stringify({ stage: "pdf-tab", url: pdfUrl.slice(0, 160) }));

    let size = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        size = await fetchFromSession(pdfSession, pdfUrl);
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 8000));
      }
    }
    const head = fs.readFileSync(outPath).subarray(0, 8).toString("ascii");
    console.log(JSON.stringify({ ok: true, out: outPath, bytes: size, signature: head }));
    await new Promise((r) => setTimeout(r, args.cooldown));
  } finally {
    try {
      if (createdTarget) await send("Target.closeTarget", { targetId: createdTarget }).catch(() => {});
    } catch {}
    ws.close();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
