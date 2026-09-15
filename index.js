const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 5000;
const UUID = (process.env.UUID || crypto.randomUUID()).toLowerCase();
const WS_PATH = process.env.WS_PATH || "/vless";

function uuidToBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

const uuidBytes = uuidToBytes(UUID);

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }
    const host = req.headers.host || "localhost";
    const clashUrl = `https://${host}/sub?format=clash`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clash 订阅</title><style>
:root{--bg:#f5f5f7;--c:#fff;--t:#1d1d1f;--m:#86868b;--a:#06c;--h:rgba(0,0,0,.08)}
@media(prefers-color-scheme:dark){:root{--bg:#000;--c:#1c1c1e;--t:#f5f5f7;--m:#98989d;--a:#2997ff;--h:rgba(255,255,255,.1)}}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--t);-webkit-font-smoothing:antialiased;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:var(--c);border-radius:20px;padding:40px 32px;max-width:440px;width:90%;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.04);border:1px solid var(--h)}
h1{font-size:28px;font-weight:600;letter-spacing:-.3px;margin-bottom:4px}
.dom{font-size:14px;color:var(--m);margin-bottom:28px}
.url{font-family:monospace;font-size:13px;color:var(--a);background:var(--bg);padding:12px 16px;border-radius:10px;word-break:break-all;display:block;border:1px solid var(--h);margin-bottom:16px;text-align:left}
.btn{display:inline-flex;align-items:center;gap:6px;padding:12px 28px;border-radius:12px;border:none;font:inherit;font-size:15px;font-weight:500;cursor:pointer;background:var(--a);color:#fff}
.btn:hover{filter:brightness(1.1);transform:scale(1.02)}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#1d1d1f;color:#fff;padding:10px 24px;border-radius:12px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:99}
.toast.show{opacity:1}
</style></head><body><div class="card">
<h1>⚡ Clash 订阅</h1><div class="dom">${host}</div>
<code class="url">${clashUrl}</code>
<button class="btn" onclick="navigator.clipboard.writeText('${clashUrl}').then(()=>{const e=document.getElementById('toast');e.textContent='已复制，去 Clash 粘贴';e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2000)})">📋 复制订阅 URL</button>
</div><div class="toast" id="toast"></div></body></html>`);
    return;
  }

  if (req.url === "/sub") {
    const host = req.headers.host || `localhost:${PORT}`;
    if (req.url.includes("format=clash")) {
      res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8" });
      return res.end([
        "mixed-port: 7890","allow-lan: false","mode: rule","log-level: info",
        "proxies:",
        `  - name: "infrlo-vless"`,`    type: vless`,`    server: ${host}`,`    port: 443`,
        `    uuid: ${UUID}`,`    network: ws`,`    tls: true`,`    udp: true`,
        `    servername: ${host}`,`    skip-cert-verify: true`,
        `    ws-opts:`,`      path: ${WS_PATH}`,`      headers:`,`        Host: ${host}`,
        `    client-fingerprint: chrome`,
        "proxy-groups:",
        '  - name: "🚀 代理"',"    type: select","    proxies:",
        '      - "infrlo-vless"',"      - DIRECT",
        "rules:",
        "  - GEOIP,CN,DIRECT","  - MATCH,🚀 代理",
      ].join("\n"));
    }
    const params = new URLSearchParams({
      security: "tls", type: "ws", path: WS_PATH,
      sni: host, host: host, fp: "chrome", alpn: "h2,http/1.1",
    });
    const link = `vless://${UUID}@${host}:443?${params}#infrlo-vless`;
    const base64 = Buffer.from(link).toString("base64");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(base64);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on("connection", (ws) => {
  ws.once("message", (data, isBinary) => {
    if (!isBinary) { ws.close(1008, "Binary required"); return; }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;

    if (buf[offset++] !== 0x00) { ws.close(1008, "Unsupported version"); return; }
    const clientUUID = buf.slice(offset, offset + 16); offset += 16;
    if (Buffer.compare(clientUUID, uuidBytes) !== 0) { ws.close(1008, "Invalid UUID"); return; }
    const addonsLen = buf[offset++]; offset += addonsLen;
    if (buf[offset++] !== 0x01) { ws.close(1008, "Only TCP supported"); return; }

    const port = buf.readUInt16BE(offset); offset += 2;
    const addrType = buf[offset++];
    let address;
    if (addrType === 0x01) {
      address = `${buf[offset]}.${buf[offset+1]}.${buf[offset+2]}.${buf[offset+3]}`;
      offset += 4;
    } else if (addrType === 0x02) {
      const len = buf[offset++];
      address = buf.slice(offset, offset + len).toString("ascii");
      offset += len;
    } else if (addrType === 0x03) {
      address = buf.slice(offset, offset + 16).toString("hex").match(/.{1,4}/g).join(":");
      offset += 16;
    } else {
      ws.close(1008, "Unknown address type"); return;
    }

    const payload = buf.slice(offset);
    const tcp = net.connect({ port, host: address }, () => {
      ws.send(Buffer.from([0x00, 0x00]));
      if (payload.length > 0) tcp.write(payload);
      tcp.on("data", (chunk) => { if (ws.readyState === ws.OPEN) ws.send(chunk); });
    });

    tcp.on("error", () => { try { ws.close(); } catch {} });
    tcp.on("close", () => { try { ws.close(); } catch {} });
    ws.on("message", (chunk) => {
      const d = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (tcp.writable) tcp.write(d);
    });
    ws.on("close", () => tcp.destroy());
    ws.on("error", () => tcp.destroy());
  });
});

server.listen(PORT, () => {
  console.log(`VLESS+WS server running on port ${PORT}`);
  console.log(`WebSocket path: ${WS_PATH}`);
  console.log(`UUID: ${UUID}`);
  console.log(`Subscription: http://localhost:${PORT}/sub`);
});