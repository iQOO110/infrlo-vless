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

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

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