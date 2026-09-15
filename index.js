const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

// Infrlo sometimes injects PORT, sometimes doesn't. Try multiple sources.
const PORT = process.env.PORT || process.env.HTTP_PORT || process.env.APP_PORT || 3000;
const UUID = (process.env.UUID || crypto.randomUUID()).toLowerCase();
const WS_PATH = process.env.WS_PATH || "/vless";

// Debug: log all env vars on startup (exclude secrets)
const safeEnv = {};
for (const k of Object.keys(process.env).sort()) {
  const v = process.env[k];
  if (k.toLowerCase().includes('key') || k.toLowerCase().includes('secret') || k.toLowerCase().includes('token') || k.toLowerCase().includes('pass')) {
    safeEnv[k] = '***';
  } else {
    safeEnv[k] = v;
  }
}
console.log('ENV:', JSON.stringify(safeEnv, null, 2));

function uuidToBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function formatUUID(buf) {
  const hex = buf.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
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
      security: "tls",
      type: "ws",
      path: WS_PATH,
      sni: host,
      host: host,
      fp: "chrome",
      alpn: "h2,http/1.1",
    });
    const link = `vless://${UUID}@${host}:443?${params}#infrlo-vless`;
    const base64 = Buffer.from(link).toString("base64");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(base64);
    return;
  }

  if (req.url === "/env") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ PORT, UUID: '***', WS_PATH, env: safeEnv }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on("connection", (ws, req) => {
  ws.once("message", (data, isBinary) => {
    if (!isBinary) {
      ws.close(1008, "Binary required");
      return;
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;

    // Version (1 byte)
    const version = buf[offset++];
    if (version !== 0x00) {
      ws.close(1008, "Unsupported version");
      return;
    }

    // UUID (16 bytes)
    const clientUUID = buf.slice(offset, offset + 16);
    offset += 16;
    if (Buffer.compare(clientUUID, uuidBytes) !== 0) {
      ws.close(1008, "Invalid UUID");
      return;
    }

    // Addons length (1 byte) + addons
    const addonsLen = buf[offset++];
    offset += addonsLen;

    // Command (1 byte): 1=TCP, 2=UDP, 3=MUX
    const cmd = buf[offset++];
    if (cmd !== 0x01) {
      ws.close(1008, "Only TCP supported");
      return;
    }

    // Port (2 bytes, big endian)
    const port = buf.readUInt16BE(offset);
    offset += 2;

    // Address type (1 byte): 1=IPv4, 2=Domain, 3=IPv6
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
      ws.close(1008, "Unknown address type");
      return;
    }

    // Remaining bytes are the initial payload
    const payload = buf.slice(offset);

    // Connect to target
    const tcp = net.connect({ port, host: address }, () => {
      // Send VLESS response header: version(1) + addons_length(1=0)
      ws.send(Buffer.from([0x00, 0x00]));

      if (payload.length > 0) {
        tcp.write(payload);
      }

      // TCP -> WS
      tcp.on("data", (chunk) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(chunk);
        }
      });
    });

    tcp.on("error", () => {
      try { ws.close(); } catch {}
    });
    tcp.on("close", () => {
      try { ws.close(); } catch {}
    });

    // WS -> TCP (subsequent messages)
    ws.on("message", (chunk) => {
      const d = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (tcp.writable) {
        tcp.write(d);
      }
    });

    ws.on("close", () => {
      tcp.destroy();
    });

    ws.on("error", () => {
      tcp.destroy();
    });
  });
});

server.listen(PORT, () => {
  console.log(`VLESS+WS server running on port ${PORT}`);
  console.log(`WebSocket path: ${WS_PATH}`);
  console.log(`UUID: ${UUID}`);
  console.log(`Subscription: http://localhost:${PORT}/sub`);
});
