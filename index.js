const http = require("http");
const https = require("https");
const net = require("net");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT, 10) || 5000;
const MAX_NODES = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEGACY_WS_PATH = process.env.WS_PATH || "/vless";
const SUB_TOKEN = process.env.SUB_TOKEN || "";
const REGION = { code: "", name: "" };

function uuidToBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function deriveUuid(baseUuid, index) {
  const bytes = crypto.createHash("sha256").update(`${baseUuid}:${index}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildUuidList(raw) {
  const seen = new Set();
  const uuids = String(raw || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((uuid) => UUID_RE.test(uuid))
    .filter((uuid) => {
      if (seen.has(uuid)) return false;
      seen.add(uuid);
      return true;
    })
    .slice(0, MAX_NODES);

  if (uuids.length === 0) uuids.push(crypto.randomUUID().toLowerCase());
  while (uuids.length < MAX_NODES) uuids.push(deriveUuid(uuids[0], uuids.length));
  return uuids;
}

function httpsJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "infrlo-vless" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) request.destroy(new Error("Response too large"));
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Timed out")));
    request.on("error", reject);
  });
}

function regionDisplayName(code, fallback) {
  if (!code) return fallback || "";
  try {
    const displayNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
    return displayNames.of(code) || fallback || code;
  } catch {
    return fallback || code;
  }
}

async function detectRegion() {
  const providers = [
    { url: "https://ipwho.is/", pick: (data) => [data.country_code, data.country] },
    { url: "https://api.country.is/", pick: (data) => [data.country, data.country] },
  ];

  for (const provider of providers) {
    try {
      const data = await httpsJson(provider.url);
      if (data.success === false) continue;
      const [code, fallback] = provider.pick(data);
      if (code) return { code: String(code).toUpperCase(), name: regionDisplayName(code, fallback) };
    } catch {}
  }
  return null;
}

function applyRegion(region) {
  if (!region) return;
  REGION.code = region.code;
  REGION.name = region.name;
  for (const node of NODES) node.name = `${node.baseName} · ${region.name}`;
}

const UUID_LIST = buildUuidList(process.env.UUID);
const NODES = UUID_LIST.map((uuid, index) => ({
  name: `infrlo-vless${index + 1}`,
  baseName: `infrlo-vless${index + 1}`,
  uuid,
  path: `/vless${index + 1}`,
  uuidBytes: uuidToBytes(uuid),
}));

const ENDPOINTS = NODES.map((node) => ({ path: node.path, uuidBytes: node.uuidBytes }));
if (!ENDPOINTS.some((endpoint) => endpoint.path === LEGACY_WS_PATH)) {
  ENDPOINTS.push({ path: LEGACY_WS_PATH, uuidBytes: NODES[0].uuidBytes });
}

function getUrl(req) {
  return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
}

function getBaseUrl(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return `${forwardedProto || "https"}://${host}`;
}

function buildUrl(baseUrl, path, format, token) {
  const url = new URL(path, baseUrl);
  if (format) url.searchParams.set("format", format);
  if (SUB_TOKEN) url.searchParams.set("token", token || SUB_TOKEN);
  return url.toString();
}

function checkAuth(url, res) {
  if (!SUB_TOKEN || url.searchParams.get("token") === SUB_TOKEN) return true;
  res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Unauthorized");
  return false;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function vlessLink(host, node) {
  const params = new URLSearchParams({
    security: "tls",
    type: "ws",
    path: node.path,
    sni: host,
    host,
    fp: "chrome",
    alpn: "h2,http/1.1",
  });
  return `vless://${node.uuid}@${host}:443?${params}#${encodeURIComponent(node.name)}`;
}

function clashSub(host) {
  const yaml = (value) => JSON.stringify(String(value));
  const proxies = NODES.map((node) => [
    `  - name: ${yaml(node.name)}`,
    "    type: vless",
    `    server: ${yaml(host)}`,
    "    port: 443",
    `    uuid: ${node.uuid}`,
    "    network: ws",
    "    tls: true",
    "    udp: true",
    `    servername: ${yaml(host)}`,
    "    skip-cert-verify: true",
    "    ws-opts:",
    `      path: ${yaml(node.path)}`,
    "      headers:",
    `        Host: ${yaml(host)}`,
    "    client-fingerprint: chrome",
  ].join("\n"));

  return [
    "mixed-port: 7890",
    "allow-lan: false",
    "mode: rule",
    "log-level: info",
    "proxies:",
    proxies.join("\n"),
    "proxy-groups:",
    `  - name: ${yaml("代理")}`,
    "    type: select",
    "    proxies:",
    ...NODES.map((node) => `      - ${yaml(node.name)}`),
    "      - DIRECT",
    "rules:",
    "  - GEOIP,CN,DIRECT",
    "  - MATCH,代理",
  ].join("\n");
}

function homePage(req) {
  const baseUrl = getBaseUrl(req);
  const clashUrl = buildUrl(baseUrl, "/sub", "clash");
  const importUrl = `clash://install-config?url=${encodeURIComponent(clashUrl)}`;
  const host = baseUrl.replace(/^https?:\/\//, "");
  const cards = NODES.map((node) => {
    const link = vlessLink(req.headers.host || `localhost:${PORT}`, node);
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=${encodeURIComponent(link)}`;
    const nodeImportUrl = `clash://install-config?url=${encodeURIComponent(clashUrl)}`;
    return `<article class="node">
<div class="qr"><img src="${escapeHtml(qrUrl)}" alt="${escapeHtml(node.name)} QR" loading="lazy"></div>
<div class="node-info"><div class="node-title"><span>${escapeHtml(node.name)}</span><span class="badge">${escapeHtml(node.path)}</span></div>
<code>${escapeHtml(node.uuid)}</code>
<div class="node-actions"><button class="btn small" data-copy="${escapeHtml(link)}">复制节点</button><button class="btn small secondary" data-copy="${escapeHtml(clashUrl)}">复制订阅</button><a class="btn small secondary" href="${escapeHtml(nodeImportUrl)}">导入 Clash</a></div></div>
</article>`;
  }).join("\n");
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clash 订阅</title><style>
:root{--bg:#f5f5f7;--surface:#fff;--text:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--soft:#f2f2f7;--blue:#0071e3;--green:#16794a}
@media(prefers-color-scheme:dark){:root{--bg:#000;--surface:#1c1c1e;--text:#f5f5f7;--muted:#98989d;--line:#3a3a3c;--soft:#2c2c2e;--blue:#2997ff;--green:#30a46c}}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;min-height:100vh}
.shell{max-width:1040px;margin:0 auto;padding:32px 20px 48px}
header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:28px}
h1{font-size:32px;font-weight:650;letter-spacing:-.4px;line-height:1.15}
.subtitle{color:var(--muted);font-size:14px;margin-top:8px}
.panel-link{color:var(--blue);text-decoration:none;font-size:14px;font-weight:550;padding:8px 0;white-space:nowrap}
.panel-link:hover{text-decoration:underline}
.clash-panel{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:26px}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
.title{font-size:22px;font-weight:650}
.node-count{font-size:13px;color:var(--blue);background:var(--soft);border-radius:999px;padding:5px 10px;white-space:nowrap}
.url-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:stretch}
.url-box{min-width:0;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:13px 15px}
.url-label{display:block;color:var(--muted);font-size:12px;margin-bottom:7px}
.url{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;color:var(--text);white-space:nowrap;overflow-x:auto;padding-bottom:2px}
.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;font:inherit;font-weight:650;cursor:pointer;text-decoration:none;transition:filter .15s ease}
.btn:hover{filter:brightness(1.08)}
.copy-btn{min-width:88px;padding:0 20px;background:var(--blue);color:#fff;font-size:15px}
.import-btn{width:100%;height:54px;margin-top:12px;background:var(--green);color:#fff;font-size:17px}
.nodes-section{margin-top:28px}
.nodes-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}
.nodes-title{font-size:22px;font-weight:650}
.node{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:16px;display:grid;grid-template-columns:180px minmax(0,1fr);gap:20px;margin-top:12px}
.qr{width:180px;height:180px;background:var(--soft);border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.qr img{width:100%;height:100%;object-fit:contain}
.node-info{min-width:0;display:flex;flex-direction:column;justify-content:center}
.node-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:18px;font-weight:650;margin-bottom:10px}
.badge{font-size:12px;color:var(--blue);background:var(--soft);padding:4px 8px;border-radius:999px;font-family:ui-monospace,monospace}
.node code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--muted);word-break:break-all;line-height:1.5}
.node-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.btn.small{padding:9px 13px;font-size:14px}
.btn.secondary{background:var(--soft);color:var(--text);border:1px solid var(--line)}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#1d1d1f;color:#fff;padding:10px 24px;border-radius:8px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:99}
.toast.show{opacity:1}
@media(max-width:640px){.shell{padding:24px 14px 36px}header{margin-bottom:22px}h1{font-size:26px}.clash-panel{padding:18px}.url-row{grid-template-columns:1fr}.copy-btn{height:46px}.import-btn{font-size:16px}}
@media(max-width:680px){.node{grid-template-columns:1fr}.qr{width:156px;height:156px;margin:0 auto}.node-info{text-align:center}.node-title,.node-actions{justify-content:center}}
</style></head><body><div class="shell">
<header><div><h1>Clash 订阅</h1><div class="subtitle">${escapeHtml(host)} · ${NODES.length} 个节点</div></div><a class="panel-link" href="#nodes">节点列表</a></header>
<main class="clash-panel"><div class="panel-head"><div class="title">订阅地址</div><div class="node-count">Clash Meta</div></div>
<div class="url-row"><div class="url-box"><span class="url-label">Clash 订阅 URL</span><code class="url">${escapeHtml(clashUrl)}</code></div><button class="btn copy-btn" data-copy="${escapeHtml(clashUrl)}">复制</button></div>
<a class="btn import-btn" href="${escapeHtml(importUrl)}">一键导入 Clash</a></main>
<section class="nodes-section" id="nodes"><div class="nodes-header"><h2 class="nodes-title">节点列表</h2><span class="node-count">${NODES.length} 个节点</span></div>${cards}</section>
</div><div class="toast" id="toast"></div><script>
document.addEventListener("click",async(event)=>{const button=event.target.closest("[data-copy]");if(!button)return;try{await navigator.clipboard.writeText(button.dataset.copy);const toast=document.getElementById("toast");toast.textContent="已复制";toast.classList.add("show");setTimeout(()=>toast.classList.remove("show"),1600)}catch(error){window.prompt("复制链接",button.dataset.copy)}});
</script></body></html>`;
}

function panelPage(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  const baseUrl = getBaseUrl(req);
  const token = SUB_TOKEN || undefined;
  const clashUrl = buildUrl(baseUrl, "/sub", "clash", token);
  const v2rayUrl = buildUrl(baseUrl, "/sub", undefined, token);
  const cards = NODES.map((node) => {
    const link = vlessLink(host, node);
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=${encodeURIComponent(link)}`;
    const importUrl = `clash://install-config?url=${encodeURIComponent(clashUrl)}`;
    return `<article class="node">
<div class="qr"><img src="${escapeHtml(qrUrl)}" alt="${escapeHtml(node.name)} QR" loading="lazy"></div>
<div class="node-info"><div class="node-title"><span>${escapeHtml(node.name)}</span><span class="badge">${escapeHtml(node.path)}</span></div>
<code>${escapeHtml(node.uuid)}</code>
<div class="actions"><button class="btn small" data-copy="${escapeHtml(link)}">复制节点</button><button class="btn small secondary" data-copy="${escapeHtml(clashUrl)}">复制订阅</button><a class="btn small secondary" href="${escapeHtml(importUrl)}">导入 Clash</a></div></div>
</article>`;
  }).join("\n");

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VLESS 节点面板</title><style>
:root{--bg:#f5f5f7;--c:#fff;--t:#1d1d1f;--m:#6e6e73;--a:#06c;--h:rgba(0,0,0,.1);--soft:#f2f2f7}
@media(prefers-color-scheme:dark){:root{--bg:#000;--c:#1c1c1e;--t:#f5f5f7;--m:#98989d;--a:#2997ff;--h:rgba(255,255,255,.12);--soft:#2c2c2e}}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--t);-webkit-font-smoothing:antialiased;padding:28px 18px 48px}
main{max-width:960px;margin:0 auto}
header{margin-bottom:24px}
h1{font-size:30px;font-weight:650;letter-spacing:-.4px}
.subtitle{color:var(--m);font-size:14px;margin-top:6px}
.subscriptions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.node{background:var(--c);border:1px solid var(--h);border-radius:14px;padding:18px;display:grid;grid-template-columns:180px 1fr;gap:20px;margin-top:14px}
.qr{width:180px;height:180px;background:var(--soft);border-radius:10px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.qr img{width:100%;height:100%;object-fit:contain}
.node-info{min-width:0;display:flex;flex-direction:column;justify-content:center}
.node-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:18px;font-weight:650;margin-bottom:10px}
.badge{font-size:12px;color:var(--a);background:var(--soft);padding:4px 8px;border-radius:999px;font-family:ui-monospace,monospace}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--m);word-break:break-all;line-height:1.5}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 15px;border-radius:9px;border:none;font:inherit;font-size:14px;font-weight:550;cursor:pointer;background:var(--a);color:#fff;text-decoration:none}
.btn.secondary{background:var(--soft);color:var(--t);border:1px solid var(--h)}
.btn:hover{filter:brightness(1.06)}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#1d1d1f;color:#fff;padding:10px 24px;border-radius:12px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:99}
.toast.show{opacity:1}
@media(max-width:680px){.node{grid-template-columns:1fr}.qr{width:156px;height:156px}.node-info{text-align:center}.node-title,.actions{justify-content:center}h1{font-size:26px}}
</style></head><body><main><header><h1>VLESS 节点面板</h1><div class="subtitle">${escapeHtml(host)} · 共 ${NODES.length} 个节点 · 旧路径 ${escapeHtml(LEGACY_WS_PATH)} 指向节点 1</div>
<div class="subscriptions"><button class="btn" data-copy="${escapeHtml(v2rayUrl)}">复制 V2Ray 订阅</button><button class="btn secondary" data-copy="${escapeHtml(clashUrl)}">复制 Clash 订阅</button><a class="btn secondary" href="${escapeHtml(clashUrl)}">打开 Clash YAML</a></div></header>
${cards}
</main><div class="toast" id="toast"></div><script>
document.addEventListener("click",async(event)=>{const button=event.target.closest("[data-copy]");if(!button)return;try{await navigator.clipboard.writeText(button.dataset.copy);const toast=document.getElementById("toast");toast.textContent="已复制";toast.classList.add("show");setTimeout(()=>toast.classList.remove("show"),1600)}catch(error){window.prompt("复制链接",button.dataset.copy)}});
</script></body></html>`;
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = getUrl(req);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Bad Request");
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("OK");
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(homePage(req));
  }

  if (url.pathname === "/panel") {
    if (!checkAuth(url, res)) return;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(panelPage(req));
  }

  if (url.pathname === "/sub") {
    if (!checkAuth(url, res)) return;
    const host = req.headers.host || `localhost:${PORT}`;
    if (url.searchParams.get("format") === "clash") {
      res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8" });
      return res.end(clashSub(host));
    }
    const links = NODES.map((node) => vlessLink(host, node)).join("\n");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(Buffer.from(links).toString("base64"));
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

function handleVLESS(ws, expectedUuidBytes) {
  ws.once("message", (data, isBinary) => {
    if (!isBinary) {
      ws.close(1008, "Binary required");
      return;
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;

    if (buf[offset++] !== 0x00) {
      ws.close(1008, "Unsupported version");
      return;
    }
    const clientUuid = buf.subarray(offset, offset + 16);
    offset += 16;
    if (Buffer.compare(clientUuid, expectedUuidBytes) !== 0) {
      ws.close(1008, "Invalid UUID");
      return;
    }
    const addonsLength = buf[offset++];
    offset += addonsLength;
    if (buf[offset++] !== 0x01) {
      ws.close(1008, "Only TCP supported");
      return;
    }

    const port = buf.readUInt16BE(offset);
    offset += 2;
    const addressType = buf[offset++];
    let address;
    if (addressType === 0x01) {
      address = `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
      offset += 4;
    } else if (addressType === 0x02) {
      const length = buf[offset++];
      address = buf.subarray(offset, offset + length).toString("ascii");
      offset += length;
    } else if (addressType === 0x03) {
      address = buf.subarray(offset, offset + 16).toString("hex").match(/.{1,4}/g).join(":");
      offset += 16;
    } else {
      ws.close(1008, "Unknown address type");
      return;
    }

    const payload = buf.subarray(offset);
    const tcp = net.connect({ port, host: address }, () => {
      ws.send(Buffer.from([0x00, 0x00]));
      if (payload.length > 0) tcp.write(payload);
      tcp.on("data", (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk);
      });
    });

    tcp.on("error", () => {
      try {
        ws.close();
      } catch {}
    });
    tcp.on("close", () => {
      try {
        ws.close();
      } catch {}
    });
    ws.on("message", (chunk) => {
      const dataBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (tcp.writable) tcp.write(dataBuffer);
    });
    ws.on("close", () => tcp.destroy());
    ws.on("error", () => tcp.destroy());
  });
}

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let pathname;
  try {
    pathname = getUrl(req).pathname;
  } catch {
    socket.destroy();
    return;
  }

  const endpoint = ENDPOINTS.find((item) => item.path === pathname);
  if (!endpoint) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    handleVLESS(ws, endpoint.uuidBytes);
  });
});

async function start() {
  applyRegion(await detectRegion());

  server.listen(PORT, () => {
    console.log(`VLESS+WS server running on port ${PORT}`);
    console.log(`Region: ${REGION.name || "unknown"}${REGION.code ? ` (${REGION.code})` : ""}`);
    console.log(`Node paths: ${NODES.map((node) => node.path).join(", ")}`);
    if (LEGACY_WS_PATH !== NODES[0].path) console.log(`Legacy path: ${LEGACY_WS_PATH} -> node 1`);
    console.log(`UUIDs: ${UUID_LIST.join(", ")}`);
    console.log(`Dashboard: /${SUB_TOKEN ? "?token=***" : ""}`);
    console.log(`Subscription: /sub${SUB_TOKEN ? "?token=***" : ""}`);
  });
}

start();
