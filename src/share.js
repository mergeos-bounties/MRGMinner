"use strict";

/**
 * Bandwidth share stream — residential exit for TrucVPN clients.
 *
 * Sharers run a local SOCKS5-compatible exit + HTTP control plane.
 * Bytes relayed accrue estimated MRG (mock ledger rate until MergeOS
 * exposes a dedicated bandwidth credit API).
 *
 * TrucVPN discovers exits via: GET {shareUrl}/v1/exits
 */

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

/** Default: 5 MRG per GB shared (sharer reward). */
const DEFAULT_MRG_PER_GB = 5;

function shareDir() {
  return process.env.MRGMINNER_SHARE_DIR || path.join(os.homedir(), ".mergeide", "share");
}

function shareStatePath() {
  const dir = shareDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "share-state.json");
}

function runningFilePath() {
  return path.join(shareDir(), "share-running.json");
}

function readRunningFile() {
  const p = runningFilePath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function deleteRunningFile() {
  const p = runningFilePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function loadShareState() {
  const p = shareStatePath();
  if (!fs.existsSync(p)) {
    return {
      bytes_in: 0,
      bytes_out: 0,
      sessions: 0,
      mrg_earned_total: 0,
      mrg_per_gb: DEFAULT_MRG_PER_GB,
      history: []
    };
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {
      bytes_in: 0,
      bytes_out: 0,
      sessions: 0,
      mrg_earned_total: 0,
      mrg_per_gb: DEFAULT_MRG_PER_GB,
      history: []
    };
  }
}

function saveShareState(state) {
  fs.writeFileSync(shareStatePath(), JSON.stringify(state, null, 2) + "\n", "utf8");
}

function mrgForBytes(bytes, mrgPerGb) {
  const gb = Number(bytes) / (1024 * 1024 * 1024);
  return Math.round(gb * Number(mrgPerGb || DEFAULT_MRG_PER_GB) * 1000) / 1000;
}

function parseRegionSpecs(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return [value];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [region, cityOrWeight, weight] = entry.split(":").map((part) => part.trim());
      const parsed = { region };
      if (cityOrWeight) {
        if (weight === undefined && Number.isFinite(Number(cityOrWeight))) {
          parsed.weight = Number(cityOrWeight);
        } else {
          parsed.city = cityOrWeight;
        }
      }
      if (weight !== undefined) {
        parsed.weight = Number(weight);
      }
      return parsed;
    });
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeShareRegions(options, defaults) {
  const specs = parseRegionSpecs(options.regions || options.advertisedRegions || options.exits);
  const entries = specs.length ? specs : [defaults];

  return entries.map((entry, index) => {
    const region = String(entry.region || entry.code || defaults.region).trim() || defaults.region;
    const city = String(entry.city || defaults.city).trim() || defaults.city;
    const exitId =
      entry.exitId ||
      entry.exit_id ||
      entry.id ||
      (specs.length ? `${defaults.exitId}-${region}-${index + 1}` : defaults.exitId);
    const mrgPerGb = positiveNumber(entry.mrgPerGb || entry.mrg_per_gb, defaults.mrgPerGb);
    const weight = positiveNumber(entry.weight || entry.routingWeight || entry.routing_weight, 1);

    return {
      exit_id: String(exitId),
      name: entry.name || `${city} residential share`,
      region,
      city,
      weight,
      worker_id: defaults.workerId,
      mrg_per_gb: mrgPerGb,
      advertise_host: entry.advertiseHost || entry.advertise_host || defaults.advertiseHost
    };
  });
}

/**
 * Minimal SOCKS5 server that dials destinations directly from the sharer's network
 * (residential IP of the host). This is the "share path" TrucVPN tunnels through.
 */
function createShareSocksServer({ host, port, onBytes, maxConnections }) {
  let activeConnections = 0;
  const server = net.createServer((client) => {
    if (maxConnections && activeConnections >= maxConnections) {
      client.destroy();
      return;
    }
    activeConnections++;
    let buf = Buffer.alloc(0);
    let stage = "greeting";

    const fail = () => {
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
    };

    client.on("error", fail);
    client.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 2) {
          return;
        }
        const n = buf[1];
        if (buf.length < 2 + n) {
          return;
        }
        client.write(Buffer.from([0x05, 0x00]));
        buf = buf.subarray(2 + n);
        stage = "request";
      }
      if (stage !== "request") {
        return;
      }
      if (buf.length < 7) {
        return;
      }
      if (buf[0] !== 0x05 || buf[1] !== 0x01) {
        client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return fail();
      }
      const atyp = buf[3];
      let off = 4;
      let hostName = "";
      if (atyp === 0x01) {
        if (buf.length < off + 6) {
          return;
        }
        hostName = `${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`;
        off += 4;
      } else if (atyp === 0x03) {
        const len = buf[off++];
        if (buf.length < off + len + 2) {
          return;
        }
        hostName = buf.subarray(off, off + len).toString("utf8");
        off += len;
      } else {
        client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return fail();
      }
      const portNum = buf.readUInt16BE(off);
      stage = "relay";
      client.removeAllListeners("data");

      const remote = net.connect({ host: hostName, port: portNum }, () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.on("data", (c) => {
          onBytes && onBytes("in", c.length);
          remote.write(c);
        });
        remote.on("data", (c) => {
          onBytes && onBytes("out", c.length);
          client.write(c);
        });
      });
      remote.on("error", fail);
      client.on("error", () => remote.destroy());
      client.on("close", () => {
        activeConnections--;
        remote.destroy();
      });
      remote.on("close", () => client.destroy());
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

/**
 * HTTP control plane for discovery + earnings status.
 * Also accepts HTTP CONNECT so TrucVPN can use protocol http-connect.
 */
function createShareControlServer({ host, port, meta, getStats, socksPort, onBytes }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    if (url.pathname === "/v1/health") {
      return sendJson(res, { ok: true, role: "mrgminner-share", ...meta });
    }
    if (url.pathname === "/v1/exits") {
      const load = Math.min(0.95, (getStats().active_connections || 0) / 50);
      const exits = meta.regions.flatMap((advertised) => {
        const exit = {
          id: advertised.exit_id,
          name: advertised.name,
          region: advertised.region,
          city: advertised.city,
          weight: advertised.weight,
          latency_ms: 15,
          load,
          protocol: "socks5",
          host: advertised.advertise_host || meta.advertise_host || host,
          port: socksPort,
          residential: true,
          source: "mrgminner-share",
          mrg_per_gb_sharer: advertised.mrg_per_gb
        };
        return [
          exit,
          {
            ...exit,
            id: `${advertised.exit_id}-http`,
            protocol: "http-connect",
            port
          }
        ];
      });
      return sendJson(res, { exits, sharer: meta.worker_id });
    }
    if (url.pathname === "/v1/earnings") {
      return sendJson(res, getStats());
    }
    if (url.pathname === "/v1/claim-mock" && req.method === "POST") {
      // Offline mock: snapshot earnings into history (no real payout API required)
      const stats = getStats();
      const state = loadShareState();
      const claim = {
        id: `share_${crypto.randomBytes(4).toString("hex")}`,
        at: new Date().toISOString(),
        bytes_total: stats.bytes_total,
        mrg_earned: stats.mrg_earned_session,
        worker_id: meta.worker_id,
        note: "mock claim — wire to MergeOS bandwidth ledger when available"
      };
      state.mrg_earned_total = Math.round((Number(state.mrg_earned_total) + claim.mrg_earned) * 1000) / 1000;
      state.history = [claim, ...(state.history || [])].slice(0, 50);
      saveShareState(state);
      return sendJson(res, { ok: true, claim, lifetime_mrg: state.mrg_earned_total });
    }
    res.writeHead(404);
    res.end("not found");
  });

  server.on("connect", (req, clientSocket, head) => {
    const [h, p] = String(req.url || "").split(":");
    const remote = net.connect({ host: h, port: Number(p || 443) }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) {
        onBytes && onBytes("in", head.length);
        remote.write(head);
      }
      clientSocket.on("data", (c) => {
        onBytes && onBytes("in", c.length);
        remote.write(c);
      });
      remote.on("data", (c) => {
        onBytes && onBytes("out", c.length);
        clientSocket.write(c);
      });
    });
    remote.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => remote.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function sendJson(res, data) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

/**
 * Start share node. Returns handle with stop() and stats().
 */
async function startShare(options = {}) {
  const host = options.host || "127.0.0.1";
  const controlPort = Number(options.port || 17890);
  const socksPort = Number(options.socksPort || controlPort + 10);
  const region = options.region || "vn";
  const city = options.city || "Ho Chi Minh";
  const workerId = options.workerId || "mrgminner:share-local";
  const mrgPerGb = Number(options.mrgPerGb || DEFAULT_MRG_PER_GB);
  const exitId = options.exitId || `share-${region}-${crypto.randomBytes(2).toString("hex")}`;
  const advertiseHost = options.advertiseHost || host;
  const maxConnections = options.maxConnections ? Number(options.maxConnections) : 0;
  const maxMbps = options.maxMbps ? Number(options.maxMbps) : 0;
  const advertisedRegions = normalizeShareRegions(options, {
    region,
    city,
    exitId,
    workerId,
    mrgPerGb,
    advertiseHost
  });
  const primaryRegion = advertisedRegions[0];

  const session = {
    bytes_in: 0,
    bytes_out: 0,
    active_connections: 0,
    started_at: Date.now(),
    mrg_per_gb: mrgPerGb
  };

  let throttleWindow = { bytes: 0, start: Date.now() };

  const onBytes = (dir, n) => {
    if (dir === "in") {
      session.bytes_in += n;
    } else {
      session.bytes_out += n;
    }
    if (maxMbps > 0) {
      throttleWindow.bytes += n;
      const elapsed = (Date.now() - throttleWindow.start) / 1000;
      if (elapsed > 0) {
        const bps = throttleWindow.bytes / elapsed;
        const maxBps = maxMbps * 1024 * 1024;
        if (bps > maxBps) {
          const sleepMs = Math.ceil(((bps - maxBps) / maxBps) * 100);
          const startSleep = Date.now();
          while (Date.now() - startSleep < sleepMs) {
            /* spin-wait — simple throttle */
          }
        }
      }
      if (elapsed > 1) {
        throttleWindow = { bytes: 0, start: Date.now() };
      }
    }
  };

  // wrap socks to count connections
  const socksServer = await createShareSocksServer({
    host,
    port: socksPort,
    onBytes: (dir, n) => {
      onBytes(dir, n);
    },
    maxConnections
  });

  const meta = {
    exit_id: primaryRegion.exit_id,
    name: primaryRegion.name,
    region: primaryRegion.region,
    city: primaryRegion.city,
    worker_id: workerId,
    mrg_per_gb: primaryRegion.mrg_per_gb,
    advertise_host: primaryRegion.advertise_host,
    regions: advertisedRegions
  };

  const getStats = () => {
    const bytes_total = session.bytes_in + session.bytes_out;
    const lifetime = loadShareState();
    return {
      ok: true,
      exit_id: primaryRegion.exit_id,
      worker_id: workerId,
      region: primaryRegion.region,
      city: primaryRegion.city,
      advertised_regions: advertisedRegions.map((advertised) => ({
        exit_id: advertised.exit_id,
        region: advertised.region,
        city: advertised.city,
        weight: advertised.weight,
        mrg_per_gb: advertised.mrg_per_gb
      })),
      bytes_in: session.bytes_in,
      bytes_out: session.bytes_out,
      bytes_total,
      active_connections: session.active_connections,
      uptime_sec: Math.round((Date.now() - session.started_at) / 1000),
      mrg_per_gb: mrgPerGb,
      mrg_earned_session: mrgForBytes(bytes_total, mrgPerGb),
      mrg_earned_lifetime: lifetime.mrg_earned_total || 0,
      control: `http://${host}:${controlPort}`,
      socks: `${host}:${socksPort}`,
      max_connections: maxConnections || undefined,
      max_mbps: maxMbps || undefined,
      stream: "bandwidth-share"
    };
  };

  const controlServer = await createShareControlServer({
    host,
    port: controlPort,
    meta,
    getStats,
    socksPort,
    onBytes
  });

  // persist running marker
  const running = {
    pid: process.pid,
    control: `http://${host}:${controlPort}`,
    socks: `${host}:${socksPort}`,
    meta,
    max_connections: maxConnections || undefined,
    max_mbps: maxMbps || undefined,
    started_at: new Date().toISOString()
  };
  fs.writeFileSync(runningFilePath(), JSON.stringify(running, null, 2) + "\n", "utf8");

  return {
    meta,
    getStats,
    async stop() {
      // flush session bytes into durable state
      const st = loadShareState();
      st.bytes_in += session.bytes_in;
      st.bytes_out += session.bytes_out;
      st.sessions += 1;
      st.mrg_earned_total =
        Math.round(
          (Number(st.mrg_earned_total) + mrgForBytes(session.bytes_in + session.bytes_out, mrgPerGb)) * 1000
        ) / 1000;
      saveShareState(st);
      await new Promise((r) => socksServer.close(() => r()));
      await new Promise((r) => controlServer.close(() => r()));
      deleteRunningFile();
    }
  };
}

function earningsReport() {
  const st = loadShareState();
  const totalBytes = Number(st.bytes_in || 0) + Number(st.bytes_out || 0);
  return {
    stream: "bandwidth-share",
    bytes_in: st.bytes_in || 0,
    bytes_out: st.bytes_out || 0,
    bytes_total: totalBytes,
    sessions: st.sessions || 0,
    mrg_per_gb: st.mrg_per_gb || DEFAULT_MRG_PER_GB,
    mrg_earned_total: st.mrg_earned_total || 0,
    history: st.history || [],
    note: "Sharer MRG from residential bandwidth. Pair with TrucVPN clients."
  };
}

module.exports = {
  DEFAULT_MRG_PER_GB,
  startShare,
  earningsReport,
  mrgForBytes,
  loadShareState,
  saveShareState,
  shareStatePath,
  runningFilePath,
  readRunningFile,
  deleteRunningFile,
  shareDir
};
