// Runs a JavaScript expression inside the live app window over the DevTools
// protocol, so a UI claim can be checked against what the app actually does.
//
//   1. start the app with a debugging port:
//        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'
//        & "$env:LOCALAPPDATA\Programs\DJ Task Manager\dj-task-manager.exe"
//   2. node tools/cdp-eval.js "document.title"
//      node tools/cdp-eval.js --async "window.__TAURI__.core.invoke('stats')"
//
// --async awaits the returned promise (needed for any invoke() call).
const PORT = Number(process.env.CDP_PORT || 9223);
let expr = process.argv.slice(2).filter((a) => a !== '--async').join(' ');
const awaitPromise = process.argv.includes('--async');
if (!expr) {
  console.error('usage: node tools/cdp-eval.js [--async] "<expression>"');
  process.exit(2);
}
// Reading the expression from a file keeps shell quoting out of the picture.
if (expr.startsWith('@')) {
  expr = require('fs').readFileSync(expr.slice(1), 'utf8');
}

async function main() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`devtools endpoint not reachable on ${PORT}: ${res.status}`);
  const targets = await res.json();
  const pages = targets.filter((t) => t.type === 'page');
  if (!pages.length) throw new Error('no page target; is the app running with the debug port?');
  const page = pages.find((t) => /task|alarm|localhost|tauri/i.test(t.title + t.url)) || pages[0];

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const out = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timeout after 15s')), 15000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: expr, awaitPromise, returnByValue: true, allowUnsafeEvalBlocklist: true },
      }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      resolve(msg);
      ws.close();
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(`websocket error: ${e.message || 'closed'}`)); });
  });

  if (out.error) throw new Error(JSON.stringify(out.error));
  const detail = out.result?.exceptionDetails;
  if (detail) {
    console.error('threw in page:', detail.exception?.description || detail.text);
    process.exit(1);
  }
  const v = out.result?.result?.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
