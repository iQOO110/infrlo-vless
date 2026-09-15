const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || process.env.HTTP_PORT || process.env.APP_PORT || 5000;
const SUB_TOKEN = process.env.SUB_TOKEN || "";
const startTime = Date.now();

const rawUUIDs = (process.env.UUID || "").split(",").map(s => s.trim()).filter(Boolean);
if (rawUUIDs.length === 0) rawUUIDs.push(crypto.randomUUID());
const UUID_LIST = rawUUIDs.slice(0, 5);

const nodes = UUID_LIST.map((uuid, i) => ({
  uuid: uuid.toLowerCase(),
  path: UUID_LIST.length === 1 ? "/vless" : `/vless${i + 1}`,
  name: UUID_LIST.length === 1 ? "infrlo-vless" : `infrlo-vless-${i + 1}`,
}));

const uuidMap = new Map();
nodes.forEach(n => uuidMap.set(n.path, Buffer.from(n.uuid.replace(/-/g, ""), "hex")));

function handleVLESS(ws, expectedUUID) {
  ws.once("message", (data, isBinary) => {
    if (!isBinary) { ws.close(1008, "Binary required"); return; }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let p = 0;
    if (buf[p++] !== 0x00) { ws.close(1008, "Unsupported version"); return; }
    if (Buffer.compare(buf.slice(p, p + 16), expectedUUID) !== 0) { ws.close(1008, "Invalid UUID"); return; }
    p += 16 + 1 + buf[p + 16];
    if (buf[p++] !== 0x01) { ws.close(1008, "Only TCP supported"); return; }
    const port = buf.readUInt16BE(p); p += 2;
    const addrType = buf[p++];
    let addr;
    if (addrType === 1) { addr = `${buf[p]}.${buf[p+1]}.${buf[p+2]}.${buf[p+3]}`; p += 4; }
    else if (addrType === 2) { const l = buf[p++]; addr = buf.slice(p, p + l).toString(); p += l; }
    else if (addrType === 3) { addr = buf.slice(p, p + 16).toString("hex").match(/.{1,4}/g).join(":"); p += 16; }
    else { ws.close(1008, "Unknown address type"); return; }
    const payload = buf.slice(p);
    const tcp = net.connect({ port, host: addr }, () => {
      ws.send(Buffer.from([0, 0]));
      if (payload.length) tcp.write(payload);
      tcp.on("data", c => { if (ws.readyState === ws.OPEN) ws.send(c); });
    });
    tcp.on("error", () => { try { ws.close(); } catch {} });
    tcp.on("close", () => { try { ws.close(); } catch {} });
    ws.on("message", c => { const d = Buffer.isBuffer(c) ? c : Buffer.from(c); if (tcp.writable) tcp.write(d); });
    ws.on("close", () => tcp.destroy());
    ws.on("error", () => tcp.destroy());
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname, host = req.headers.host || "localhost";

  if (path === "/" || path === "/health") {
    res.writeHead(200).end("OK"); return;
  }

  if (path === "/sub") {
    if (SUB_TOKEN && u.searchParams.get("token") !== SUB_TOKEN) { res.writeHead(403).end("Forbidden"); return; }
    if (u.searchParams.get("format") === "clash") return serveClash(res, host);
    const raw = nodes.map(n => buildLink(n, host)).join("\n");
    res.writeHead(200, { "Content-Type": "text/plain", "Subscription-Userinfo": "upload=0; download=0; total=0; expire=0" });
    return res.end(Buffer.from(raw).toString("base64"));
  }

  if (path === "/panel") return servePanel(res, host);

  res.writeHead(404).end("Not Found");
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const node = nodes.find(n => n.path === req.url);
  if (!node) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => handleVLESS(ws, uuidMap.get(node.path)));
});

function buildLink(n, host) {
  const p = new URLSearchParams({ security: "tls", type: "ws", path: n.path, sni: host, host, fp: "chrome", alpn: "h2,http/1.1" });
  return `vless://${n.uuid}@${host}:443?${p}#${encodeURIComponent(n.name)}`;
}

function serveClash(res, host) {
  const lines = nodes.map(n => [
    `  - name: "${n.name}"`, `    type: vless`, `    server: ${host}`, `    port: 443`,
    `    uuid: ${n.uuid}`, `    network: ws`, `    tls: true`, `    udp: true`,
    `    servername: ${host}`, `    skip-cert-verify: true`,
    `    ws-opts:`, `      path: ${n.path}`, `      headers:`, `        Host: ${host}`,
    `    client-fingerprint: chrome`,
  ].join("\n")).join("\n");
  const ns = nodes.map(n => `      - ${n.name}`).join("\n");
  const nq = nodes.map(n => `      - "${n.name}"`).join("\n");

  res.writeHead(200, { "Content-Type": "text/yaml", "Content-Disposition": "attachment; filename=infrlo-clash.yaml", "Subscription-Userinfo": "upload=0; download=0; total=0; expire=0" });
  res.end([
    "mixed-port: 7890", "allow-lan: false", "mode: rule", "log-level: info",
    "ipv6: false", "unified-delay: true", "tcp-concurrent: true",
    "dns:", "  enable: true", "  ipv6: false", "  enhanced-mode: fake-ip",
    "  fake-ip-range: 198.18.0.1/16", "  default-nameserver:", "    - 223.5.5.5", "    - 119.29.29.29",
    "  nameserver:", "    - https://dns.alidns.com/dns-query", "    - https://doh.pub/dns-query",
    "  fallback:", "    - https://1.1.1.1/dns-query", "    - https://8.8.8.8/dns-query",
    "  fallback-filter:", "    geoip: true", "    geoip-code: CN",
    "proxies:", lines,
    "proxy-groups:",
    '  - name: "🚀 节点选择"', "    type: select", "    proxies:", nq, "      - DIRECT",
    '  - name: "⚡ 自动选择"', "    type: url-test", "    url: https://www.gstatic.com/generate_204",
    "    interval: 180", "    tolerance: 50", "    lazy: true", "    proxies:", ns,
    '  - name: "🏠 国内直连"', "    type: select", "    proxies:", "      - DIRECT",
    "rules:", "  - GEOIP,CN,🏠 国内直连", "  - MATCH,🚀 节点选择",
  ].join("\n"));
}

function servePanel(res, host) {
  const clashUrl = `https://${host}/sub?format=clash`;
  const vlessUrl = `https://${host}/sub`;
  const tp = SUB_TOKEN ? `&token=${SUB_TOKEN}` : "";
  const uptime = Math.floor((Date.now() - startTime) / 60000);
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);

  const qr = d => `<img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(d)}" width="100" height="100" style="display:block">`;
  const cards = nodes.map((n, i) => `
<div class="c"><div class="ch"><span class="bd">Node ${i+1}</span><span class="pm">${n.path}</span></div>
<div class="cb"><div class="qr">${qr(buildLink(n, host))}</div><div class="ni">
<div class="ir"><span class="lb">UUID</span><code class="uid">${n.uuid.slice(0,8)}⋯${n.uuid.slice(-4)}</code><button class="btn bc" onclick="cp('${n.uuid}')">拷贝</button></div>
<div class="ir"><span class="lb">VLESS</span><button class="btn bc" onclick="cp('${buildLink(n, host).replace(/'/g, "\\'")}')">拷贝链接</button></div>
</div></div></div>`).join("");

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VLESS — ${host}</title><style>
:root{--bg:#f5f5f7;--c:#fff;--t:#1d1d1f;--m:#86868b;--a:#06c;--h:rgba(0,0,0,.08);--r:16px}
@media(prefers-color-scheme:dark){:root{--bg:#000;--c:#1c1c1e;--t:#f5f5f7;--m:#98989d;--a:#2997ff;--h:rgba(255,255,255,.1)}}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--t);-webkit-font-smoothing:antialiased;font-size:17px;line-height:1.47}
.ct{max-width:680px;margin:0 auto;padding:40px 20px 80px}
.hd{text-align:center;padding:48px 0 32px}
.hd h1{font-size:34px;font-weight:600;letter-spacing:-.28px;margin-bottom:8px}
.hd .dom{font-size:15px;color:var(--m)}
.st{display:inline-flex;align-items:center;gap:6px;background:var(--c);border:1px solid var(--h);border-radius:20px;padding:6px 14px;font-size:13px;font-weight:500;margin-top:12px}
.sd{width:7px;height:7px;border-radius:50%;background:#34c759;animation:p 2s infinite}@keyframes p{0%,100%{opacity:1}50%{opacity:.4}}
.sv{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px}
.si{background:var(--c);border:1px solid var(--h);border-radius:var(--r);padding:16px;text-align:center}
.sv2{display:block;font-size:22px;font-weight:600;margin-bottom:4px}
.sl{font-size:11px;color:var(--m);text-transform:uppercase;letter-spacing:.5px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;border-radius:12px;border:none;font:inherit;font-size:15px;font-weight:500;cursor:pointer;transition:all .15s;background:var(--a);color:#fff;text-decoration:none}
.btn:hover{filter:brightness(1.1);transform:scale(1.02)}
.bg{background:var(--c);color:var(--a);border:1px solid var(--h)}
.bg:hover{filter:none;border-color:var(--a)}
.bs{background:#34c759}.bs:hover{background:#28b84e}
.c{background:var(--c);border-radius:var(--r);box-shadow:0 1px 3px rgba(0,0,0,.04);margin-bottom:16px;border:1px solid var(--h);overflow:hidden}
.ch{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--h)}
.bd{font-size:12px;font-weight:600;color:var(--a);background:rgba(0,102,204,.08);padding:3px 10px;border-radius:8px}
.pm{font-family:monospace;font-size:13px;color:var(--m)}
.cb{display:flex;gap:20px;padding:20px;align-items:center;flex-wrap:wrap}
.qr{flex-shrink:0;width:100px;height:100px;border-radius:10px;overflow:hidden;border:1px solid var(--h)}
.ni{flex:1;min-width:200px}
.ir{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.lb{font-size:12px;font-weight:600;color:var(--m);text-transform:uppercase;min-width:44px}
.uid{font-family:monospace;font-size:13px;background:var(--bg);padding:4px 8px;border-radius:6px}
.surl{font-family:monospace;font-size:13px;color:var(--a);background:var(--bg);padding:8px 12px;border-radius:8px;word-break:break-all;display:block;border:1px solid var(--h)}
.br{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.bc{font:inherit;font-size:12px;font-weight:500;padding:4px 12px;border-radius:8px;border:1px solid var(--h);background:var(--c);color:var(--a);cursor:pointer;white-space:nowrap}
.bc:hover{background:var(--a);color:#fff}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#1d1d1f;color:#fff;padding:10px 24px;border-radius:12px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:99}
.toast.show{opacity:1}
.stt{font-size:20px;font-weight:600;margin:32px 0 16px}
.ft{text-align:center;padding:24px;font-size:12px;color:var(--m)}
@media(max-width:480px){.cb{flex-direction:column;align-items:flex-start}.ct{padding:16px 12px 60px}.hd h1{font-size:28px}.sv{grid-template-columns:1fr}}
</style></head><body><div class="ct">
<div class="hd"><h1>VLESS</h1><div class="dom">${host}</div><div class="st"><span class="sd"></span>在线 · ${nodes.length} 个节点</div></div>
<div class="sv"><div class="si"><span class="sv2">${uptime}m</span><span class="sl">运行时间</span></div><div class="si"><span class="sv2">${mem} MB</span><span class="sl">内存</span></div><div class="si"><span class="sv2">${nodes.length}</span><span class="sl">节点数</span></div></div>
<div class="c" style="border-color:var(--a)"><div class="ch"><span class="bd" style="color:#34c759;background:rgba(52,199,89,.1)">⚡ Clash</span><span class="pm">一键导入</span></div><div class="cb"><div class="qr">${qr(clashUrl)}</div><div class="ni"><code class="surl">${clashUrl}${tp}</code><div class="br"><button class="btn bc" onclick="cp('${clashUrl}${tp}')">📋 复制 URL</button><button class="btn bs" onclick="location.href='clash://install-config?url='+encodeURIComponent('${clashUrl}${tp}')">🚀 一键导入</button></div></div></div></div>
<div class="c"><div class="ch"><span class="bd">📋 V2Ray</span><span class="pm">Base64</span></div><div class="cb"><div class="ni"><code class="surl">${vlessUrl}${tp}</code><div class="br"><button class="btn bc" onclick="cp('${vlessUrl}${tp}')">📋 复制 URL</button></div></div></div></div>
<div class="stt">节点详情</div>${cards}
<div class="ft">VLESS over WebSocket · Powered by Infrlo</div></div>
<div class="toast" id="toast"></div>
<script>function cp(t){navigator.clipboard.writeText(t).then(()=>{const e=document.getElementById("toast");e.textContent="已拷贝";e.classList.add("show");setTimeout(()=>e.classList.remove("show"),1500)})}</script>
</body></html>`);
}

server.listen(PORT, () => {
  nodes.forEach(n => console.log(`  ${n.path}  ${n.uuid.slice(0, 8)}...`));
  console.log(`VLESS running on :${PORT}, ${nodes.length} nodes`);
});