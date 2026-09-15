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
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  if (req.url === "/sub") {
    const host = req.headers.host || `localhost:${PORT}`;
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