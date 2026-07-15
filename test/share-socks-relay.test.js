"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { createShareSocksServer } = require("../src/share");

/**
 * Build a SOCKS5 CONNECT request for a domain name.
 */
function socksConnectRequest(host, port) {
  const hostBuf = Buffer.from(host, "utf8");
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  return Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
    hostBuf,
    portBuf
  ]);
}

/**
 * Parse the SOCKS5 handshake response.
 * Returns { success, bindType, bindAddr, bindPort } on success,
 * or throws on failure byte.
 */
function parseSocksResponse(buf) {
  // Expect 10 bytes: ver(1) rep(1) rsv(1) atyp(1) addr(4|16) port(2)
  if (buf.length < 10) return null;
  if (buf[0] !== 0x05) throw new Error(`Bad SOCKS version: ${buf[0]}`);
  if (buf[1] !== 0x00) throw new Error(`SOCKS request rejected: code ${buf[1]}`);
  return { success: true };
}

describe("share SOCKS5 relay", () => {
  let echoServer;
  let echoPort;
  let socksServer;
  let socksPort;

  before(async () => {
    // Start a tiny TCP echo server on a random port
    echoPort = await new Promise((resolve, reject) => {
      const srv = net.createServer((c) => {
        c.on("data", (d) => c.write(d));
        c.on("error", () => {});
      });
      srv.listen(0, "127.0.0.1", () => {
        resolve(srv.address().port);
      });
      srv.on("error", reject);
      echoServer = srv;
    });

    // Start the SOCKS5 share server on a random port
    socksServer = await createShareSocksServer({
      host: "127.0.0.1",
      port: 0,
      onBytes: () => {}
    });
    socksPort = socksServer.address().port;
  });

  after(async () => {
    if (socksServer) {
      await new Promise((r) => socksServer.close(r));
    }
    if (echoServer) {
      await new Promise((r) => echoServer.close(r));
    }
  });

  it("relays data through SOCKS5 to a TCP echo server", async () => {
    // Connect to SOCKS server
    const client = new net.Socket();
    const connectPromise = new Promise((resolve, reject) => {
      client.connect(socksPort, "127.0.0.1", resolve);
      client.on("error", reject);
    });
    await connectPromise;

    try {
      // Step 1: SOCKS5 greeting
      client.write(Buffer.from([0x05, 0x01, 0x00]));
      const greeting = await new Promise((resolve) => {
        client.once("data", (data) => resolve(data));
      });
      assert.deepEqual([...greeting], [0x05, 0x00], "SOCKS5 greeting should succeed (no auth)");

      // Step 2: SOCKS5 CONNECT request to echo server
      client.write(socksConnectRequest("127.0.0.1", echoPort));
      const response = await new Promise((resolve) => {
        client.once("data", (data) => resolve(data));
      });
      const parsed = parseSocksResponse(response);
      assert.ok(parsed.success, "SOCKS5 CONNECT should succeed");

      // Step 3: Send test data through the relay
      const testMsg = Buffer.from("Hello SOCKS5 relay!");
      client.write(testMsg);

      const echo = await new Promise((resolve) => {
        client.once("data", (data) => resolve(data));
      });

      assert.ok(echo.equals(testMsg), `Echo should match sent data. Got: ${echo.toString()}`);

    } finally {
      client.destroy();
    }
  });

  it("handles multiple data chunks", async () => {
    const client = new net.Socket();
    const connectPromise = new Promise((resolve, reject) => {
      client.connect(socksPort, "127.0.0.1", resolve);
      client.on("error", reject);
    });
    await connectPromise;

    try {
      // Greeting
      client.write(Buffer.from([0x05, 0x01, 0x00]));
      const greeting = await new Promise((resolve) => {
        client.once("data", (data) => resolve(data));
      });
      assert.deepEqual([...greeting], [0x05, 0x00]);

      // CONNECT
      client.write(socksConnectRequest("127.0.0.1", echoPort));
      const response = await new Promise((resolve) => {
        client.once("data", (data) => resolve(data));
      });
      assert.ok(parseSocksResponse(response).success);

      // Multiple messages in sequence
      for (const msg of ["one", "two", "three"]) {
        client.write(Buffer.from(msg));
        const echo = await new Promise((resolve) => {
          client.once("data", (data) => resolve(data));
        });
        assert.equal(echo.toString(), msg, `Should echo "${msg}"`);
      }
    } finally {
      client.destroy();
    }
  });

  it("rejects unsupported SOCKS command", async () => {
    const client = new net.Socket();
    const connectPromise = new Promise((resolve, reject) => {
      client.connect(socksPort, "127.0.0.1", resolve);
      client.on("error", reject);
    });
    await connectPromise;

    try {
      // Greeting
      client.write(Buffer.from([0x05, 0x01, 0x00]));
      const greeting = await new Promise((resolve) => {
        client.once("data", (data) => resolve(data));
      });
      assert.deepEqual([...greeting], [0x05, 0x00]);

      // BIND command (0x02) instead of CONNECT (0x01) — should be rejected
      const bindReq = Buffer.concat([
        Buffer.from([0x05, 0x02, 0x00, 0x03, 9]),
        Buffer.from("127.0.0.1"),
        Buffer.from([0x00, 0x50])
      ]);
      client.write(bindReq);

      const response = await new Promise((resolve) => {
        client.once("data", (data) => resolve(data));
      });
      // Code 0x07 = Command not supported
      assert.equal(response[1], 0x07, "BIND command should be rejected");
    } finally {
      client.destroy();
    }
  });
});
