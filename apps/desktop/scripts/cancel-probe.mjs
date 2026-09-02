// 直连运行中的 Workecho(需 --remote-debugging-port)做真实流取消验证
import http from "node:http";
import WebSocket from "ws";
const port = Number(process.argv[2] ?? 9230);

const get = (path) =>
  new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port, path }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res(JSON.parse(d)));
    }).on("error", rej);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await get("/json/list");
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  const send = (m, pr = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method: m, params: pr }));
    });
  const ev = (e) =>
    send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }).then(
      (r) => r.result?.result?.value,
    );
  ws.on("message", (m) => {
    const d = JSON.parse(m);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  });
  await new Promise((r) => ws.once("open", r));

  const mk = `window.piApp.createSession({workspaceId:(await window.piApp.getState()).workspaces[0].id,title:"cancel-final"})`;
  console.log("create:", await ev(`(async()=>{${mk};return "ok"})()`));
  await sleep(1500);
  console.log("submit:", await ev(`window.piApp.submitComposer("从1数到300,每行一个数字,不要停").then(()=>"ok").catch(e=>"ERR:"+String(e))`));

  const statusEv = `(async()=>{const s=await window.piApp.getState();const w=s.workspaces.find(x=>x.id===s.selectedWorkspaceId);const ss=w&&w.sessions.find(x=>x.id===s.selectedSessionId);return ss?ss.status:"nosess"})()`;
  const lenEv = `(async()=>{const t=await window.piApp.getSelectedTranscript();const arr=t.transcript||[];const last=arr[arr.length-1];return last&&last.text?last.text.length:0})()`;

  let running = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const st = await ev(statusEv);
    if (i % 5 === 0) console.log(`poll ${i}: ${st}`);
    if (st === "running") {
      running = true;
      break;
    }
  }
  console.log("reached running:", running);
  if (!running) {
    console.log("lastError:", await ev(`(async()=>String((await window.piApp.getState()).lastError??"").slice(0,200))()`));
    process.exit(0);
  }

  await sleep(4000);
  console.log("pre-cancel len:", await ev(lenEv));
  console.log("cancel:", JSON.stringify(await ev(`window.piApp.cancelCurrentRun().then(s=>({ok:true,rev:s.revision})).catch(e=>({thrown:String(e)}))`)));
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    const st = await ev(statusEv);
    const len = await ev(lenEv);
    console.log(`t+${i}s: ${st} len=${len}`);
    if (st === "idle") {
      console.log("CANCEL VERIFIED (status idle)");
      break;
    }
  }
  process.exit(0);
})();
