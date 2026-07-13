"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyAgentRole,
  formClaimBlock,
  buildFleetReport,
  mockFleetPayload,
  normalizeNode,
  ROLE_JOB,
  ROLE_REVIEW,
  ROLE_AUDIT
} = require("../src/nodes");

test("classifyAgentRole maps coding / review / audit", () => {
  assert.equal(classifyAgentRole({ type: "coding-agent", supported_actions: ["generate"] }), ROLE_JOB);
  assert.equal(classifyAgentRole({ type: "review-agent", supported_actions: ["review"] }), ROLE_REVIEW);
  assert.equal(classifyAgentRole({ type: "repo-scan-agent", capabilities: ["security_review"] }), ROLE_AUDIT);
});

test("mock fleet has online roles and ready claim-block", () => {
  const report = mockFleetPayload();
  assert.ok(report.stats.online_nodes >= 3);
  assert.equal(report.stats.online_by_role.job >= 1, true);
  assert.equal(report.stats.online_by_role.review >= 1, true);
  assert.equal(report.stats.online_by_role.audit >= 1, true);
  assert.equal(report.stats.claim_block_ready, true);
  assert.equal(report.claim_block.ready, true);
  assert.equal(report.claim_block.mrg_eligible, true);
  assert.match(report.claim_block.block_id, /^blk_/);
  assert.equal(report.claim_block.hash_chain.complete, true);
  assert.ok(report.claim_block.members.job);
  assert.ok(report.claim_block.members.review);
  assert.ok(report.claim_block.members.audit);
});

test("formClaimBlock incomplete without audit", () => {
  const nodes = [
    normalizeNode({
      id: "job1",
      type: "coding-agent",
      status: "active",
      supported_actions: ["generate"],
      open_task_count: 1
    }),
    normalizeNode({
      id: "rev1",
      type: "review-agent",
      status: "active",
      supported_actions: ["review"]
    })
  ];
  const block = formClaimBlock(nodes, [{ entry_hash: "b".repeat(64), status: "verified" }]);
  assert.equal(block.ready, false);
  assert.ok(block.missing.includes("auditor"));
  assert.equal(block.mrg_eligible, false);
});

test("buildFleetReport sorts online first", () => {
  const report = buildFleetReport({
    agents: [
      { id: "a", type: "coding-agent", status: "standby", supported_actions: ["generate"] },
      { id: "b", type: "coding-agent", status: "active", supported_actions: ["generate"] }
    ],
    feed: { stats: { token_symbol: "MRG" }, items: [] },
    ledgerItems: []
  });
  assert.equal(report.nodes[0].online, true);
});
