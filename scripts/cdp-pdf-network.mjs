#!/usr/bin/env node
// cdp-pdf-network.mjs — article → click "View PDF" → capture the PDF response body
// via the CDP Network domain and write it to disk.
// Usage:
//   node cdp-pdf-network.mjs --article <article-url> --out <file.pdf> [--timeout 120000]
import fs from "node:fs";
import path from "node:path";

const args = { timeout: 120000 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--article") args.article = process.argv[++i];
  else if (a === "--out") args.out = process.argv[++i];
  else if (a === "--timeout") args.timeout = Number(process.argv[++i]);
}
if (!args.article || !args.out) {
  console.error("Usage: node cdp-pdf-network.mjs --article <article-url> --out <file.pdf>");
  process.exit(2);
}

const outPath = path.resolve(args.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const version = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const pdfRequests = new Map(); // requestId -> { url, mimeType }
const finished = new Set();

function send(method, params = {}, sessionId) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

function isPdfishUrl(u) {
  if (!u) return false;
  return (
    u.includes(".pdf") ||
    u.includes("pdf.sciencedirectassets.com") ||
    u.includes("download_pub")
  ) && !u.includes("crasolve");
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
  if (msg.method === "Network.responseReceived") {
    const { requestId, response } = msg.params;
    if (isPdfishUrl(response.url) || (response.mimeType || "").includes("pdf")) {
      pdfRequests.set(requestId, { url: response.url, mimeType: response.mimeType, status: response.status });
    }
  }
  if (msg.method === "Network.loadingFinished") {
    if (pdfRequests.has(msg.params.requestId)) finished.add(msg.params.requestId);
  }
};

await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

async function main() {
  let createdTarget = null;
  let sessionId = null;
  try {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    createdTarget = targetId;
    const attached = await send("Target.attachToTarget", { targetId, flatten: true });
    sessionId = attached.sessionId;
    await send("Page.enable", {}, sessionId);
    await send("Network.enable", {}, sessionId);
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
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`;
    const { result: rectRes } = await send("Runtime.evaluate", { expression: findJs, returnByValue: true }, sessionId);
    const rect = JSON.parse(rectRes.value || "null");
    if (!rect) throw new Error("no PDF element found on article page");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);

    const deadline = Date.now() + args.timeout;
    while (Date.now() < deadline) {
      const candidate = Array.from(pdfRequests.entries()).find(([rid]) => finished.has(rid));
      if (candidate) {
        const [requestId, meta] = candidate;
        try {
          const { body, base64Encoded } = await send("Network.getResponseBody", { requestId }, sessionId);
          const buf = Buffer.from(body, base64Encoded ? "base64" : "utf8");
          if (buf.length > 20000 && buf.subarray(0, 8).toString("ascii").startsWith("%PDF")) {
            fs.writeFileSync(outPath, buf);
            console.log(JSON.stringify({ ok: true, out: outPath, bytes: buf.length, url: meta.url.slice(0, 160), mime: meta.mimeType, status: meta.status }));
            return;
          }
          // Not a real PDF; drop and keep waiting.
          pdfRequests.delete(requestId);
          finished.delete(requestId);
        } catch (e) {
          pdfRequests.delete(requestId);
          finished.delete(requestId);
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("timeout waiting for PDF response");
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
