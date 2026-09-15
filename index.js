const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

// ── Config ──────────────────────────────────────────
const PORT = process.env.PORT || process.env.HTTP_PORT || process.env.APP_PORT || 5000;
const SUB_TOKEN = process.env.SUB_TOKEN || "";

// Parse UUID list (comma-separated), up to 5
const rawUUIDs = (process.env.UUID || "").split(",").map(s => s.trim()).filter(Boolean);
if (rawUUIDs.length === 0) {
  rawUUIDs.push(crypto.randomUUID());
}
const UUID_LIST = rawUUIDs.slice(0, 5); // max 5

// Build node configs: each UUID maps to a path
const nodes = UUID_LIST.map((uuid, i) => ({
  uuid: uuid.toLowerCase(),
  path: UUID_LIST.length === 1 ? "/vless" : `/vless${i + 1}`,
  name: UUID_LIST.length === 1 ? "infrlo-vless" : `infrlo-vless-${i + 1}`,
}));

// ── UUID → bytes map ────────────────────────────────
function uuidToBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}
const uuidMap = new Map();
nodes.forEach(n => uuidMap.set(n.path, uuidToBytes(n.uuid)));

// ── VLESS handshake + forwarding ────────────────────
function handleVLESS(ws, expectedUUID) {
  ws.once("message", (data, isBinary) => {
    if (!isBinary) { ws.close(1008, "Binary required"); return; }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;

    if (buf[offset++] !== 0x00) { ws.close(1008, "Unsupported version"); return; }

    const clientUUID = buf.slice(offset, offset + 16); offset += 16;
    if (Buffer.compare(clientUUID, expectedUUID) !== 0) {
      ws.close(1008, "Invalid UUID"); return;
    }

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
}

// ── HTTP Server ─────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const host = req.headers.host || "localhost";

  // Health check
  if (path === "/" || path === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OK");
  }

  // Env debug
  if (path === "/env") {
    const safe = {};
    for (const k of Object.keys(process.env).sort()) {
      const v = process.env[k];
      safe[k] = /key|secret|token|pass/i.test(k) ? "***" : v;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ PORT, nodes: nodes.length, paths: nodes.map(n => n.path), env: safe }));
  }

  // Subscription endpoint
  if (path === "/sub") {
    // Token check
    if (SUB_TOKEN && url.searchParams.get("token") !== SUB_TOKEN) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden");
    }

    const format = url.searchParams.get("format") || "base64";

    if (format === "clash") {
      return serveClashSub(res, host);
    }

    // Default: base64 VLESS links (one per line)
    const links = nodes.map(n => buildVlessLink(n.uuid, host, n.path, n.name));
    const raw = links.join("\n");
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Subscription-Userinfo": `upload=0; download=0; total=0; expire=0`,
    });
    return res.end(Buffer.from(raw).toString("base64"));
  }

  // Admin panel
  if (path === "/panel") {
    return servePanel(res, host);
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

// ── QR Code generator ───────────────────────────────
const QRCode = require("qrcode");

// ── Apple-style Admin Panel ─────────────────────────
function servePanel(res, host) {
  const qrData = nodes.map(n => buildVlessLink(n.uuid, host, n.path, n.name));
  const subBase64 = Buffer.from(nodes.map(n => buildVlessLink(n.uuid, host, n.path, n.name)).join("\n")).toString("base64");
  
  // Generate QR codes as SVG data URIs (server-side, lightweight)
  const qrPromises = qrData.map(link => QRCode.toString(link, { type: "svg", margin: 1, width: 200, color: { dark: "#1d1d1f", light: "#ffffff" } }));
  
  Promise.all(qrPromises).then(qrSvgs => {
    const nodeCards = nodes.map((n, i) => `
      <div class="card">
        <div class="card-header">
          <span class="badge">${nodes.length > 1 ? `Node ${i + 1}` : "Active"}</span>
          <span class="path-mono">${n.path}</span>
        </div>
        <div class="card-body">
          <div class="qr-wrap">${qrSvgs[i]}</div>
          <div class="node-info">
            <div class="info-row">
              <span class="label">UUID</span>
              <code class="uuid" title="${n.uuid}">${n.uuid.slice(0, 8)}⋯${n.uuid.slice(-4)}</code>
              <button class="btn-copy" onclick="cp('${n.uuid}')">拷贝</button>
            </div>
            <div class="info-row">
              <span class="label">VLESS</span>
              <button class="btn-copy" onclick="cp('${buildVlessLink(n.uuid, host, n.path, n.name).replace(/'/g, "\\'")}')">拷贝链接</button>
            </div>
          </div>
        </div>
      </div>`).join("");

    const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VLESS Panel — ${host}</title>
<style>
:root {
  --bg: #f5f5f7;
  --card-bg: #ffffff;
  --text: #1d1d1f;
  --text-muted: #86868b;
  --accent: #0066cc;
  --accent-hover: #0071e3;
  --hairline: rgba(0,0,0,0.08);
  --radius: 16px;
  --shadow: 0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #000000;
    --card-bg: #1c1c1e;
    --text: #f5f5f7;
    --text-muted: #98989d;
    --accent: #2997ff;
    --accent-hover: #40a9ff;
    --hairline: rgba(255,255,255,0.1);
    --shadow: 0 1px 3px rgba(0,0,0,0.3);
  }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  background: var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  font-size: 17px;
  line-height: 1.47;
  letter-spacing: -0.374px;
}
.container { max-width: 680px; margin: 0 auto; padding: 40px 20px 80px; }
.header { text-align: center; padding: 48px 0 32px; }
.header h1 { font-size: 34px; font-weight: 600; letter-spacing: -0.28px; margin-bottom: 8px; }
.header .domain { font-size: 15px; color: var(--text-muted); font-weight: 400; }
.status { display: inline-flex; align-items: center; gap: 6px; background: var(--card-bg); border: 1px solid var(--hairline); border-radius: 20px; padding: 6px 14px; font-size: 13px; font-weight: 500; margin-top: 12px; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: #34c759; animation: pulse 2s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; padding: 0 0 32px; }
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 10px 20px; border-radius: 12px; border: none;
  font-family: inherit; font-size: 15px; font-weight: 500;
  cursor: pointer; transition: all 0.15s ease;
  background: var(--accent); color: #fff; text-decoration: none;
}
.btn:hover { background: var(--accent-hover); transform: scale(1.02); }
.btn-ghost { background: var(--card-bg); color: var(--accent); border: 1px solid var(--hairline); }
.btn-ghost:hover { background: var(--card-bg); color: var(--accent-hover); border-color: var(--accent); }
.card {
  background: var(--card-bg); border-radius: var(--radius);
  box-shadow: var(--shadow); margin-bottom: 16px;
  overflow: hidden; border: 1px solid var(--hairline);
}
.card-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--hairline); }
.badge { font-size: 12px; font-weight: 600; color: var(--accent); background: rgba(0,102,204,0.08); padding: 3px 10px; border-radius: 8px; }
.path-mono { font-family: "SF Mono", "Menlo", monospace; font-size: 13px; color: var(--text-muted); }
.card-body { display: flex; gap: 20px; padding: 20px; align-items: center; flex-wrap: wrap; }
.qr-wrap { flex-shrink: 0; width: 100px; height: 100px; border-radius: 10px; overflow: hidden; border: 1px solid var(--hairline); }
.qr-wrap svg { width: 100%; height: 100%; }
.node-info { flex: 1; min-width: 200px; }
.info-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.label { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; min-width: 44px; }
.uuid { font-family: "SF Mono", "Menlo", monospace; font-size: 13px; color: var(--text); background: var(--bg); padding: 4px 8px; border-radius: 6px; }
.btn-copy {
  font-family: inherit; font-size: 12px; font-weight: 500;
  padding: 4px 12px; border-radius: 8px; border: 1px solid var(--hairline);
  background: var(--card-bg); color: var(--accent); cursor: pointer;
  transition: all 0.1s; white-space: nowrap;
}
.btn-copy:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
.toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #1d1d1f; color: #fff; padding: 10px 24px; border-radius: 12px; font-size: 14px; opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 99; }
.toast.show { opacity: 1; }
.footer { text-align: center; padding: 24px; font-size: 12px; color: var(--text-muted); }
@media (max-width: 480px) { .card-body { flex-direction: column; align-items: flex-start; } .container { padding: 16px 12px 60px; } .header h1 { font-size: 28px; } }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>VLESS</h1>
    <div class="domain">${host}</div>
    <div class="status"><span class="status-dot"></span>在线 · ${nodes.length} 个节点</div>
  </div>
  <div class="actions">
    <a class="btn" href="/sub">📋 订阅链接</a>
    <a class="btn btn-ghost" href="/sub?format=clash">⚡ Clash 订阅</a>
  </div>
  ${nodeCards}
  <div class="footer">VLESS over WebSocket · Powered by Infrlo</div>
</div>
<div class="toast" id="toast"></div>
<script>
function cp(t) {
  navigator.clipboard.writeText(t).then(() => {
    const el = document.getElementById("toast");
    el.textContent = "已拷贝";
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 1500);
  });
}
</script>
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
}

// ── VLESS link builder ──────────────────────────────
function buildVlessLink(uuid, host, wpath, name) {
  const params = new URLSearchParams({
    security: "tls", type: "ws", path: wpath,
    sni: host, host: host, fp: "chrome", alpn: "h2,http/1.1",
  });
  return `vless://${uuid}@${host}:443?${params}#${encodeURIComponent(name)}`;
}

// ── Clash subscription ──────────────────────────────
function serveClashSub(res, host) {
  const proxyLines = nodes.map(n => {
    return [
      `  - name: "${n.name}"`,
      `    type: vless`,
      `    server: ${host}`,
      `    port: 443`,
      `    uuid: ${n.uuid}`,
      `    network: ws`,
      `    tls: true`,
      `    udp: false`,
      `    servername: ${host}`,
      `    skip-cert-verify: true`,
      `    ws-opts:`,
      `      path: ${n.path}`,
      `      headers:`,
      `        Host: ${host}`,
      `    client-fingerprint: chrome`,
    ].join("\n");
  }).join("\n");

  const proxyNames = nodes.map(n => `      - "${n.name}"`).join("\n");

  const yaml = [
    "mixed-port: 7890",
    "allow-lan: false",
    "mode: rule",
    "log-level: info",
    "",
    "proxies:",
    proxyLines,
    "",
    "proxy-groups:",
    '  - name: "🚀 节点选择"',
    "    type: select",
    "    proxies:",
    proxyNames,
    "      - DIRECT",
    "",
    "rules:",
    "  - GEOIP,CN,DIRECT",
    "  - MATCH,🚀 节点选择",
  ].join("\n");

  res.writeHead(200, {
    "Content-Type": "text/yaml; charset=utf-8",
    "Content-Disposition": "attachment; filename=infrlo-clash.yaml",
  });
  res.end(yaml);
}

// ── WebSocket servers (one per UUID path) ───────────
nodes.forEach(n => {
  const wss = new WebSocketServer({ server, path: n.path });
  const uuidKey = uuidMap.get(n.path);
  wss.on("connection", (ws) => handleVLESS(ws, uuidKey));
  console.log(`  Path: ${n.path}  UUID: ${n.uuid.slice(0, 8)}...`);
});

// ── Start ───────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`VLESS+WS server running on port ${PORT}`);
  console.log(`Nodes: ${nodes.length}`);
  console.log(`Sub token: ${SUB_TOKEN ? "enabled" : "disabled"}`);
  console.log(`Subscription: http://localhost:${PORT}/sub`);
});