#!/usr/bin/env node
// cdp-harvest.mjs — open each record's article page in the authenticated Chrome,
// and save the rendered full-text HTML (and a plain-text extraction) to disk.
// Usage:
//   node cdp-harvest.mjs --list <harvest-list.csv> --out <dir> [--min-delay 8000] [--max-delay 15000] [--timeout 60000] [--no-skip-existing]
import fs from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";

const args = { minDelay: 8000, maxDelay: 15000, timeout: 60000, skipExisting: true, maxBlockedStreak: 3 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--list") args.list = process.argv[++i];
  else if (a === "--out") args.out = process.argv[++i];
  else if (a === "--min-delay") args.minDelay = Number(process.argv[++i]);
  else if (a === "--max-delay") args.maxDelay = Number(process.argv[++i]);
  else if (a === "--timeout") args.timeout = Number(process.argv[++i]);
  else if (a === "--no-skip-existing") args.skipExisting = false;
}
if (!args.list || !args.out) {
  console.error("Usage: node cdp-harvest.mjs --list <csv> --out <dir> [--delay ms] [--timeout ms]");
  process.exit(2);
}

const lines = readFileSync(args.list, "utf8").split(/\r?\n/).filter(Boolean);
const header = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
const rows = lines.slice(1)
  .map((l) => {
    const parts = l.split(",");
    return {
      record_id: (parts[idx.record_id] || "").replace(/^"|"$/g, ""),
      url: (parts[idx.authoritative_url] || "").replace(/^"|"$/g, ""),
    };
  })
  .filter((r) => r.record_id && r.url);

const htmlDir = path.join(path.resolve(args.out), "FullText");
const textDir = path.join(path.resolve(args.out), "FullTextText");
fs.mkdirSync(htmlDir, { recursive: true });
fs.mkdirSync(textDir, { recursive: true });

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

const results = [];
let blockedStreak = 0;
try {
  for (const row of rows) {
    if (args.skipExisting && fs.existsSync(path.join(htmlDir, row.record_id + ".html"))) {
      results.push({ record_id: row.record_id, status: "skipped_existing", bytes: 0, secs: "0.0", title: "" });
      console.log(`${row.record_id} -> skipped_existing`);
      continue;
    }
    const start = Date.now();
    let status = "ok";
    let bytes = 0;
    let title = "";
    let targetId = null;
    let sessionId = null;
    try {
      const created = await send("Target.createTarget", { url: "about:blank" });
      targetId = created.targetId;
      const attached = await send("Target.attachToTarget", { targetId, flatten: true });
      sessionId = attached.sessionId;
      await send("Page.enable", {}, sessionId);
      await send("Page.navigate", { url: row.url }, sessionId);

      let ready = "";
      for (let i = 0; i < Math.ceil(args.timeout / 1000); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { result } = await send(
          "Runtime.evaluate",
          { expression: `document.readyState`, returnByValue: true },
          sessionId
        );
        ready = result?.value || "";
        if (ready === "complete") break;
      }
      if (ready !== "complete") { status = "load_timeout"; continue; }

      const expr = `JSON.stringify({
        title: document.title,
        url: location.href,
        len: document.documentElement.outerHTML.length,
        textLen: (document.body ? document.body.innerText : "").length
      })`;
      let meta = null;
      for (let i = 0; i < Math.ceil(args.timeout / 3000); i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const { result } = await send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
        meta = JSON.parse(result.value);
        if (meta.len >= 30000 || meta.textLen >= 2000) break;
      }
      title = meta?.title || "";
      if (meta && (meta.len >= 30000 || meta.textLen >= 2000)) {
        const htmlExpr = `document.documentElement.outerHTML`;
        const htmlRes = await send("Runtime.evaluate", { expression: htmlExpr, returnByValue: true }, sessionId);
        const html = htmlRes.result.value || "";
        const textExpr = `document.body ? document.body.innerText : ""`;
        const textRes = await send("Runtime.evaluate", { expression: textExpr, returnByValue: true }, sessionId);
        const text = textRes.result.value || "";
        fs.writeFileSync(path.join(htmlDir, row.record_id + ".html"), html, "utf8");
        fs.writeFileSync(path.join(textDir, row.record_id + ".txt"), text, "utf8");
        bytes = html.length;
        status = "saved";
      } else {
        status = "blocked_or_no_content";
      }
    } catch (e) {
      status = "error";
    } finally {
      if (sessionId) await send("Target.detachFromTarget", { sessionId }).catch(() => {});
      if (targetId) await send("Target.closeTarget", { targetId }).catch(() => {});
    }
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    results.push({ record_id: row.record_id, status, bytes, secs, title: title.slice(0, 80) });
    console.log(`${row.record_id} -> ${status} (${bytes} bytes, ${secs}s)`);
    blockedStreak = status === "blocked_or_no_content" ? blockedStreak + 1 : 0;
    if (blockedStreak >= args.maxBlockedStreak) {
      console.log(`circuit breaker: ${blockedStreak} consecutive blocked pages, stopping to avoid IP/account flags`);
      break;
    }
    const wait = args.minDelay + Math.floor(Math.random() * (args.maxDelay - args.minDelay));
    await new Promise((r) => setTimeout(r, wait));
  }
} finally {
  ws.close();
}

console.log(JSON.stringify({ summary: { total: rows.length, saved: results.filter((r) => r.status === "saved").length, skipped: results.filter((r) => r.status === "skipped_existing").length }, results }, null, 2));
