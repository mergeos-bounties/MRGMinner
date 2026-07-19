"use strict";

const { describe, it, after, before } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { startShare, mrgForBytes, earningsReport, readRunningFile, deleteRunningFile, DEFAULT_MRG_PER_GB } = require("../src/share");

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

  it("maxConnections flag appears in stats", async () => {
    const limitHandle = await startShare({
      host: "127.0.0.1",
      port: 18030,
      socksPort: 18040,
      maxConnections: 5,
      workerId: "test:connlimit"
    });
    try {
      const stats = limitHandle.getStats();
      assert.equal(stats.max_connections, 5);
    } finally {
      await limitHandle.stop();
    }
  });

  it("readRunningFile returns null when not running", () => {
    const dir = process.env.MRGMINNER_SHARE_DIR || path.join(os.homedir(), ".mergeide", "share");
    const runFile = path.join(dir, "share-running.json");
    if (fs.existsSync(runFile)) fs.unlinkSync(runFile);
    assert.equal(readRunningFile(), null);
  });
});
