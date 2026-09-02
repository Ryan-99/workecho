import http from "node:http";
import WebSocket from "ws";

const port = Number(process.argv[2] ?? 9231);
const expr = process.argv[3];
const get = (p) =>
  new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port, path: p }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res(JSON.parse(d)));
    }).on("error", rej);
  });

const list = await get("/json/list");
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
ws.on("message", (m) => {
  const d = JSON.parse(m);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  }
});
await new Promise((r) => ws.once("open", r));
const i = ++id;
const p = new Promise((res) => pending.set(i, res));
ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
const r = await p;
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r.result).slice(0, 800));
process.exit(0);
