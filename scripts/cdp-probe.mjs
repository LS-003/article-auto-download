#!/usr/bin/env node
// cdp-probe.mjs — inspect a page in the CDP-controlled Chrome without the proxy's eval wrapper.
// Usage: node cdp-probe.mjs <targetId>
const targetId = process.argv[2];
if (!targetId) { console.error("usage: node cdp-probe.mjs <targetId>"); process.exit(2); }

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

try {
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const expr = `JSON.stringify({
    title: document.title,
    url: location.href,
    ct: document.contentType,
    text: (document.body ? document.body.innerText : "").slice(0, 1200),
    buttons: Array.from(document.querySelectorAll("button, input[type=button], input[type=submit]")).slice(0, 10).map(b => (b.innerText || b.value || b.type || "").trim()),
    inputs: Array.from(document.querySelectorAll("input")).slice(0, 10).map(i => i.type + ":" + (i.name || "")),
    iframes: Array.from(document.querySelectorAll("iframe")).slice(0, 5).map(f => f.src || "(no src)"),
    links: Array.from(document.querySelectorAll("a")).slice(0, 8).map(a => (a.innerText || "").trim() + " -> " + a.href)
  })`;
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  console.log(JSON.stringify(r, null, 2));
} catch (e) {
  console.error("probe failed:", e.message);
  process.exit(1);
} finally {
  ws.close();
}
