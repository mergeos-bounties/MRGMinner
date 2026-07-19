"use strict";

const { describe, it, after, before } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { startShare, mrgForBytes, earningsReport, DEFAULT_MRG_PER_GB, postEarningsToLedger } = require("../src/share");

describe("share bandwidth stream", () => {
  let handle;

  after(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
  });

  it("computes mrg for bytes", () => {
    const oneGb = 1024 * 1024 * 1024;
    assert.equal(mrgForBytes(oneGb, 5), 5);
    assert.equal(DEFAULT_MRG_PER_GB, 5);
  });

  it("starts control plane and lists exits", async () => {
    handle = await startShare({
      host: "127.0.0.1",
      port: 17990,
      socksPort: 18000,
      region: "vn",
      city: "Test City",
      workerId: "test:share"
    });
    const health = await fetch("http://127.0.0.1:17990/v1/health").then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.role, "mrgminner-share");
    const exits = await fetch("http://127.0.0.1:17990/v1/exits").then((r) => r.json());
    assert.ok(Array.isArray(exits.exits));
    assert.ok(exits.exits.length >= 1);
    assert.equal(exits.exits[0].residential, true);
    const stats = handle.getStats();
    assert.equal(stats.stream, "bandwidth-share");
    assert.ok(typeof stats.mrg_earned_session === "number");
  });

  it("advertises every configured logical region with weights", async () => {
    const regionalHandle = await startShare({
      host: "127.0.0.1",
      port: 18010,
      socksPort: 18020,
      region: "vn",
      city: "Ho Chi Minh",
      exitId: "share-primary",
      workerId: "test:share",
      regions: "vn:Ho Chi Minh:70,sg:Singapore:30"
    });

    try {
      const exits = await fetch("http://127.0.0.1:18010/v1/exits").then((r) => r.json());
      assert.equal(exits.exits.length, 4);
      assert.deepEqual(
        exits.exits.map((exit) => [exit.id, exit.region, exit.city, exit.weight, exit.protocol]),
        [
          ["share-primary-vn-1", "vn", "Ho Chi Minh", 70, "socks5"],
          ["share-primary-vn-1-http", "vn", "Ho Chi Minh", 70, "http-connect"],
          ["share-primary-sg-2", "sg", "Singapore", 30, "socks5"],
          ["share-primary-sg-2-http", "sg", "Singapore", 30, "http-connect"]
        ]
      );
      assert.deepEqual(
        regionalHandle.getStats().advertised_regions.map((exit) => [exit.exit_id, exit.region, exit.weight]),
        [
          ["share-primary-vn-1", "vn", 70],
          ["share-primary-sg-2", "sg", 30]
        ]
      );
    } finally {
      await regionalHandle.stop();
    }
  });

  it("earnings report shape", () => {
    const r = earningsReport();
    assert.equal(r.stream, "bandwidth-share");
    assert.ok("mrg_earned_total" in r);
  });

  it("relays SOCKS5 through share server to a TCP echo", async () => {
    const echoPort = 18101;
    const controlPort = 18102;
    const socksPort = 18103;

    // 1. Start a TCP echo server
    const echoServer = net.createServer((sock) => {
      sock.on("data", (data) => sock.write(data));
    });
    await new Promise((resolve) => echoServer.listen(echoPort, "127.0.0.1", resolve));

    // 2. Start the share server (SOCKS5 proxy)
    const share = await startShare({
      host: "127.0.0.1",
      port: controlPort,
      socksPort,
      region: "vn",
      city: "Test City",
      workerId: "test:socks-relay"
    });

    try {
      // 3. Connect SOCKS5 client → share server → echo server
      const data = await new Promise((resolve, reject) => {
        const client = net.connect({ host: "127.0.0.1", port: socksPort }, () => {
          // SOCKS5 greeting: version=5, 1 auth method (no auth)
          client.write(Buffer.from([0x05, 0x01, 0x00]));
        });

        let buf = Buffer.alloc(0);
        client.on("data", (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length === 2 && buf[0] === 0x05 && buf[1] === 0x00) {
            // Greeting accepted — send connect request
            // ATYP=0x01 (IPv4), 127.0.0.1, port=echoPort
            const req = Buffer.alloc(10);
            req[0] = 0x05; req[1] = 0x01; req[2] = 0x00;
            req[3] = 0x01;
            req[4] = 127; req[5] = 0; req[6] = 0; req[7] = 1;
            req.writeUInt16BE(echoPort, 8);
            client.write(req);
            buf = Buffer.alloc(0);
            return;
          }
          if (buf.length >= 10 && buf[0] === 0x05 && buf[1] === 0x00) {
            // Connect succeeded — send test payload
            const payload = Buffer.from("hello socks5 relay");
            client.write(payload);
            buf = Buffer.alloc(0);
            return;
          }
          if (buf.length > 0) {
            // Echo response received
            client.end();
            resolve(buf.toString("utf8"));
          }
        });
        client.on("error", reject);
        setTimeout(() => reject(new Error("SOCKS5 relay timeout")), 5000);
      });

      assert.equal(data, "hello socks5 relay");
    } finally {
      await share.stop();
      echoServer.close();
    }
  });
});

describe("postEarningsToLedger", () => {
  it("makes correct POST request with auth token", async () => {
    const originalFetch = global.fetch;
    let callUrl, callOptions;
    global.fetch = async (url, options) => {
      callUrl = url;
      callOptions = options;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, claim_id: "test_123" })
      };
    };
    try {
      const stats = { worker_id: "test:worker", bytes_total: 1000, mrg_earned_session: 0.005 };
      const result = await postEarningsToLedger(stats, "test-token", "https://mergeos.shop");
      assert.equal(callUrl, "https://mergeos.shop/v1/bandwidth/claims");
      assert.equal(callOptions.method, "POST");
      assert.equal(callOptions.headers.Authorization, "Bearer test-token");
      const body = JSON.parse(callOptions.body);
      assert.equal(body.worker_id, "test:worker");
      assert.equal(body.bytes_total, 1000);
      assert.equal(body.mrg_earned, 0.005);
      assert.equal(body.stream, "bandwidth-share");
      assert.ok(body.claimed_at);
      assert.equal(result.ok, true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("gracefully skips when no token", async () => {
    const result = await postEarningsToLedger({ worker_id: "test" }, "", "https://mergeos.shop");
    assert.equal(result, null);
  });

  it("gracefully handles API 5xx failure", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => JSON.stringify({ error: "server error" })
    });
    try {
      const result = await postEarningsToLedger(
        { worker_id: "test", bytes_total: 100, mrg_earned_session: 0.001 },
        "test-token",
        "https://mergeos.shop"
      );
      assert.equal(result, null);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("gracefully handles network error", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const result = await postEarningsToLedger(
        { worker_id: "test", bytes_total: 100, mrg_earned_session: 0.001 },
        "test-token",
        "https://mergeos.shop"
      );
      assert.equal(result, null);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
