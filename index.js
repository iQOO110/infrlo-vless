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
const parsedTrafficTotalGb = Number.parseFloat(process.env.TRAFFIC_TOTAL_GB);
const TRAFFIC_TOTAL_GB = Number.isFinite(parsedTrafficTotalGb) && parsedTrafficTotalGb >= 0 ? parsedTrafficTotalGb : 60;
const TRAFFIC_TOTAL_BYTES = Math.round(TRAFFIC_TOTAL_GB * 1024 ** 3);
const TRAFFIC_EXPIRE = Math.max(0, parseInt(process.env.TRAFFIC_EXPIRE, 10) || 0);
const WS_MAX_PAYLOAD = 16 * 1024 * 1024;
const WS_BUFFER_LIMIT = 512 * 1024;
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

const ENDPOINTS = NODES.map((node, nodeIndex) => ({ path: node.path, uuidBytes: node.uuidBytes, nodeIndex }));
if (!ENDPOINTS.some((endpoint) => endpoint.path === LEGACY_WS_PATH)) {
  ENDPOINTS.push({ path: LEGACY_WS_PATH, uuidBytes: NODES[0].uuidBytes, nodeIndex: 0 });
}

const STATS = {
  startedAt: Date.now(),
  nodes: NODES.map((node, index) => ({
    index,
    uploadBytes: 0,
    downloadBytes: 0,
    activeConnections: 0,
    connections: 0,
  })),
};

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

function addTraffic(nodeIndex, direction, bytes) {
  const nodeStats = STATS.nodes[nodeIndex];
  if (!nodeStats || !Number.isFinite(bytes) || bytes <= 0) return;
  if (direction === "upload") nodeStats.uploadBytes += bytes;
  if (direction === "download") nodeStats.downloadBytes += bytes;
}

function getTrafficTotals() {
  const totals = { uploadBytes: 0, downloadBytes: 0, totalBytes: 0, activeConnections: 0, connections: 0 };
  for (const node of STATS.nodes) {
    totals.uploadBytes += node.uploadBytes;
    totals.downloadBytes += node.downloadBytes;
    totals.totalBytes += node.uploadBytes + node.downloadBytes;
    totals.activeConnections += node.activeConnections;
    totals.connections += node.connections;
  }
  return totals;
}

function subscriptionHeaders(contentType) {
  const totals = getTrafficTotals();
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Subscription-Userinfo": `upload=${totals.uploadBytes}; download=${totals.downloadBytes}; total=${TRAFFIC_TOTAL_BYTES}; expire=${TRAFFIC_EXPIRE}`,
  };
}

function getStatsSnapshot() {

  const nodes = STATS.nodes.map((nodeStats, index) => {
    const node = NODES[index];
    const totalBytes = nodeStats.uploadBytes + nodeStats.downloadBytes;
    return {
      name: node.name,
      path: node.path,
      uploadBytes: nodeStats.uploadBytes,
      downloadBytes: nodeStats.downloadBytes,
      totalBytes,
      activeConnections: nodeStats.activeConnections,
      connections: nodeStats.connections,
    };
  });

  const totals = getTrafficTotals();

  return {
    startedAt: STATS.startedAt,
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - STATS.startedAt) / 1000)),
    region: { code: REGION.code, name: REGION.name },
    totals,
    nodes,
  };
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
  const v2rayUrl = buildUrl(baseUrl, "/sub");
  const region = REGION.name || "地区识别中";
  const vlessQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=${encodeURIComponent(v2rayUrl)}`;
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Infrlo VLESS 订阅</title><style>
:root{--bg:#07101f;--card:#111c2f;--surface:#0b1526;--line:#22314a;--text:#f4f7fb;--muted:#98a6bb;--blue:#2f72f6;--green:#24c38a;--copy:#24344e}

*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;min-height:100vh}
.shell{max-width:900px;margin:0 auto;padding:40px 24px 48px}
header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding-bottom:22px;border-bottom:1px solid var(--line);margin-bottom:24px}
.brand{display:flex;align-items:center;gap:12px}
.brand-mark{width:34px;height:34px;border-radius:9px;background:var(--blue);display:grid;place-items:center;font-size:16px;font-weight:750;color:#fff;flex:0 0 auto}
h1{font-size:28px;font-weight:700;letter-spacing:-.3px;line-height:1.2}
.subtitle{color:var(--muted);font-size:14px;margin-top:5px}
.status{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid #1e614c;border-radius:999px;background:#0c2926;color:#4ce0a7;font-size:12px;font-weight:650;white-space:nowrap}
.status-dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(36,195,138,.12)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
.section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:22px}
h2{font-size:19px;font-weight:700}
.section-copy{color:var(--muted);font-size:13px;line-height:1.6;margin-top:6px}
.region{display:inline-flex;align-items:center;padding:5px 10px;border-radius:999px;background:#172844;color:#9fc1ff;font-size:12px;white-space:nowrap}
.service{padding:2px 0}
.service-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:12px}
.service-title{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:700}
.clash-mark{width:22px;height:22px;border-radius:6px;background:#2563eb;display:grid;place-items:center;color:#fff;font-size:11px;font-weight:750;flex:0 0 auto}
.service-copy{color:var(--muted);font-size:13px;line-height:1.65;margin-top:7px;max-width:650px}
.field-label{display:block;color:var(--muted);font-size:12px;margin-bottom:7px}
.url-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:stretch}
.url{display:flex;align-items:center;min-width:0;min-height:40px;padding:9px 12px;background:var(--surface);border:1px solid var(--line);border-radius:7px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#dbe5f2;white-space:nowrap;overflow-x:auto}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 14px;border:0;border-radius:7px;font:inherit;font-size:13px;font-weight:650;cursor:pointer;text-decoration:none;transition:background .15s ease,filter .15s ease;white-space:nowrap}
.btn:hover{filter:brightness(1.08)}
.import-btn{background:var(--blue);color:#fff}
.copy-btn{background:var(--copy);color:var(--text);border:1px solid #334563}
.divider{height:1px;background:var(--line);margin:24px 0}
.vless-layout{display:grid;grid-template-columns:180px minmax(0,1fr);gap:28px;align-items:center;margin-top:16px}
.qr-wrap{display:flex;flex-direction:column;align-items:center;gap:9px}
.qr{width:168px;height:168px;background:#fff;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.qr-caption{color:var(--muted);font-size:12px;text-align:center}
.qr img{width:100%;height:100%;object-fit:contain}
.stats-card{margin-top:18px}
.live-badge{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border-radius:999px;background:#102a3d;color:#8bd8ff;font-size:11px;font-weight:650;white-space:nowrap}
.live-dot{width:6px;height:6px;border-radius:50%;background:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.12)}
.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:18px}
.summary-item{min-width:0;padding:14px;background:var(--surface);border:1px solid var(--line);border-radius:8px}
.summary-label{color:var(--muted);font-size:11px;margin-bottom:6px}
.summary-value{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stats-table{border-top:1px solid var(--line)}
.stats-row{display:grid;grid-template-columns:minmax(0,1.45fr) repeat(4,minmax(68px,1fr));gap:12px;align-items:center;padding:11px 0;border-bottom:1px solid #1a2940}
.stats-head{color:var(--muted);font-size:11px;font-weight:650;padding-top:12px;padding-bottom:8px}
.stats-node{min-width:0;font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stats-number{color:#dbe5f2;font-size:12px;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.stats-foot{display:flex;justify-content:space-between;gap:12px;padding-top:12px;color:var(--muted);font-size:11px}
footer{color:#718096;font-size:12px;line-height:1.6;text-align:center;margin-top:20px}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#eff6ff;color:#0b1526;padding:9px 20px;border-radius:7px;font-size:13px;font-weight:650;opacity:0;transition:opacity .2s;pointer-events:none;z-index:99}
.toast.show{opacity:1}
@media(max-width:640px){.shell{padding:28px 16px 40px}header{display:block}h1{font-size:23px}.status{margin-top:16px}.card{padding:18px}.section-head{display:block}.region{margin-top:10px}.service-head{display:block}.import-btn{margin-top:12px}.vless-layout{grid-template-columns:1fr;gap:22px}.url{font-size:12px}}
@media(max-width:640px){.stats-card{margin-top:14px}.live-badge{margin-top:10px}.summary{grid-template-columns:1fr}.summary-value{font-size:18px}.stats-head{display:none}.stats-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 12px;padding:13px 0}.stats-node{grid-column:1/-1}.stats-number{text-align:left}.stats-number::before{content:attr(data-label);display:block;margin-bottom:2px;color:var(--muted);font-size:10px}.stats-foot{display:block}.stats-foot span{display:block}.stats-foot span+span{margin-top:4px}}
</style></head><body><div class="shell">
<header><div class="brand"><div class="brand-mark">C</div><div><h1>Infrlo VLESS</h1><div class="subtitle">Clash / Mihomo / 通用客户端订阅</div></div></div><div class="status"><span class="status-dot"></span>服务运行正常</div></header>
<main class="card"><div class="section-head"><div><h2>订阅导入</h2><div class="section-copy">选择适合你客户端的方式，以下地址均包含 ${NODES.length} 个节点。</div></div><div class="region">${escapeHtml(region)}</div></div>
<article class="service"><div class="service-head"><div><div class="service-title"><span class="clash-mark">C</span><span>Clash / Mihomo</span></div><div class="service-copy">适用于 Clash Verge、Clash Meta 和 Mihomo，导入后自动包含全部节点。</div></div><a class="btn import-btn" href="${escapeHtml(importUrl)}">导入 Clash</a></div>
<label class="field-label">Clash 订阅地址</label><div class="url-row"><code class="url">${escapeHtml(clashUrl)}</code><button class="btn copy-btn" data-copy="${escapeHtml(clashUrl)}">复制</button></div></article>
<div class="divider"></div>
<article class="service"><div class="service-head"><div><div class="service-title">通用订阅</div><div class="service-copy">适用于 Shadowrocket、v2rayN、Sing-box 等客户端，扫码或复制地址即可导入全部节点。</div></div></div>
<div class="vless-layout"><div class="qr-wrap"><div class="qr"><img src="${escapeHtml(vlessQrUrl)}" alt="通用订阅二维码"></div><div class="qr-caption">扫码导入全部节点</div></div>
<div><label class="field-label">通用订阅地址</label><div class="url-row"><code class="url">${escapeHtml(v2rayUrl)}</code><button class="btn copy-btn" data-copy="${escapeHtml(v2rayUrl)}">复制</button></div></div></div></article>
</main>
<section class="card stats-card"><div class="section-head"><div><h2>流量统计</h2><div class="section-copy">按节点统计自本次服务启动以来的实时流量。</div></div><div class="live-badge"><span class="live-dot"></span>每 5 秒更新</div></div>
<div class="summary"><div class="summary-item"><div class="summary-label">总上传</div><div class="summary-value" id="total-upload">0 B</div></div><div class="summary-item"><div class="summary-label">总下载</div><div class="summary-value" id="total-download">0 B</div></div><div class="summary-item"><div class="summary-label">当前连接</div><div class="summary-value" id="total-active">0</div></div></div>
<div class="stats-table"><div class="stats-row stats-head"><div>节点</div><div class="stats-number">上传</div><div class="stats-number">下载</div><div class="stats-number">在线</div><div class="stats-number">累计</div></div><div id="node-stats"></div></div>
<div class="stats-foot"><span id="stats-uptime">运行时间统计中</span><span>服务重启后统计数据会清零</span></div></section>
<footer>节点名称会按服务器地区自动更新，订阅内容共 ${NODES.length} 个节点。</footer>
</div><div class="toast" id="toast"></div><script>
document.addEventListener("click",async(event)=>{const button=event.target.closest("[data-copy]");if(!button)return;try{await navigator.clipboard.writeText(button.dataset.copy);const toast=document.getElementById("toast");toast.textContent="已复制";toast.classList.add("show");setTimeout(()=>toast.classList.remove("show"),1600)}catch(error){window.prompt("复制链接",button.dataset.copy)}});
const totalUpload=document.getElementById("total-upload");
const totalDownload=document.getElementById("total-download");
const totalActive=document.getElementById("total-active");
const nodeStats=document.getElementById("node-stats");
const statsUptime=document.getElementById("stats-uptime");
function formatBytes(value){const bytes=Math.max(0,Number(value)||0);if(bytes<1024)return Math.round(bytes)+" B";const units=["KB","MB","GB","TB"];let size=bytes/1024;let unit=0;while(size>=1024&&unit<units.length-1){size/=1024;unit++}return (size>=100?size.toFixed(0):size.toFixed(1))+" "+units[unit]}
function formatDuration(seconds){const total=Math.max(0,Math.floor(Number(seconds)||0));const days=Math.floor(total/86400);const hours=Math.floor((total%86400)/3600);const minutes=Math.floor((total%3600)/60);if(days)return days+" 天 "+hours+" 小时";if(hours)return hours+" 小时 "+minutes+" 分钟";if(minutes)return minutes+" 分钟";return total+" 秒"}
function statNumber(label,value){const cell=document.createElement("div");cell.className="stats-number";cell.dataset.label=label;cell.textContent=value;return cell}
function renderStats(stats){const totals=stats.totals||{};totalUpload.textContent=formatBytes(totals.uploadBytes);totalDownload.textContent=formatBytes(totals.downloadBytes);totalActive.textContent=String(totals.activeConnections||0);nodeStats.replaceChildren();for(const node of stats.nodes||[]){const row=document.createElement("div");row.className="stats-row";const name=document.createElement("div");name.className="stats-node";name.textContent=node.name;row.append(name,statNumber("上传",formatBytes(node.uploadBytes)),statNumber("下载",formatBytes(node.downloadBytes)),statNumber("在线",String(node.activeConnections||0)),statNumber("累计",String(node.connections||0)));nodeStats.appendChild(row)}statsUptime.textContent="已运行 "+formatDuration(stats.uptimeSeconds)}
async function refreshStats(){try{const response=await fetch("/api/stats",{cache:"no-store"});if(!response.ok)throw new Error("HTTP "+response.status);renderStats(await response.json())}catch(error){statsUptime.textContent="统计服务暂不可用"}}
refreshStats();
setInterval(refreshStats,5000);
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

  if (url.pathname === "/api/stats") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(JSON.stringify(getStatsSnapshot()));
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(homePage(req));
  }

  if (url.pathname === "/panel") {
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  if (url.pathname === "/sub") {
    if (!checkAuth(url, res)) return;
    const host = req.headers.host || `localhost:${PORT}`;
    if (url.searchParams.get("format") === "clash") {
      res.writeHead(200, subscriptionHeaders("text/yaml; charset=utf-8"));
      return res.end(clashSub(host));
    }
    const links = NODES.map((node) => vlessLink(host, node)).join("\n");
    res.writeHead(200, subscriptionHeaders("text/plain; charset=utf-8"));
    return res.end(Buffer.from(links).toString("base64"));
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

function handleVLESS(ws, expectedUuidBytes, nodeIndex) {
  // Oversized frames can error before the handshake creates a TCP socket.
  ws.on("error", () => {});
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
    const nodeStats = STATS.nodes[nodeIndex];
    if (!nodeStats) {
      ws.close(1011, "Stats unavailable");
      return;
    }
    nodeStats.connections += 1;
    nodeStats.activeConnections += 1;
    addTraffic(nodeIndex, "upload", payload.length);

    let released = false;
    const releaseConnection = () => {
      if (released) return;
      released = true;
      nodeStats.activeConnections = Math.max(0, nodeStats.activeConnections - 1);
    };

    const tcp = net.connect({ port, host: address }, () => {
      ws.send(Buffer.from([0x00, 0x00]));
      if (payload.length > 0) tcp.write(payload);
      tcp.on("data", (chunk) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount >= WS_BUFFER_LIMIT) tcp.pause();
        ws.send(chunk, { binary: true }, () => {
          if (tcp.isPaused()) tcp.resume();
        });
        addTraffic(nodeIndex, "download", chunk.length);
      });
    });

    tcp.on("error", () => {
      releaseConnection();
      try {
        ws.close();
      } catch {}
    });
    tcp.on("close", () => {
      releaseConnection();
      try {
        ws.close();
      } catch {}
    });
    ws.on("message", (chunk) => {
      const dataBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!tcp.writable) return;
      addTraffic(nodeIndex, "upload", dataBuffer.length);
      if (!tcp.write(dataBuffer)) {
        ws.pause();
        tcp.once("drain", () => ws.resume());
      }
    });
    ws.on("close", () => {
      releaseConnection();
      tcp.destroy();
    });
    ws.on("error", () => {
      releaseConnection();
      tcp.destroy();
    });
  });
}

const wss = new WebSocketServer({
  noServer: true,
  clientTracking: false,
  perMessageDeflate: false,
  maxPayload: WS_MAX_PAYLOAD,
});

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
    handleVLESS(ws, endpoint.uuidBytes, endpoint.nodeIndex);
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
