"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { main, selectNextTask } = require("../src/cli");

test("selectNextTask picks the first open task matching kind and agent", () => {
  const tasks = [
    { id: "t1", status: "claimed", required_worker_kind: "agent" },
    { id: "t2", status: "open", required_worker_kind: "human" },
    { id: "t3", status: "open", required_worker_kind: "agent", suggested_agent_type: "codex" },
    { id: "t4", status: "open", required_worker_kind: "agent", suggested_agent_type: "claude" }
  ];
  const picked = selectNextTask(tasks, { kind: "agent", agent: "claude" });
  assert.equal(picked.id, "t4");
});

test("next --dry-run prints task + prompt without invoking the AI CLI", async () => {
  const originalFetch = global.fetch;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mrgminner-dryrun-"));
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  // A command that would fail loudly if spawned, proving no AI CLI ran.
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify([
      {
        id: "prj_public_0001:7",
        status: "open",
        title: "Add ledger proof panel",
        acceptance: "Panel renders the current ledger tip.",
        required_worker_kind: "agent",
        suggested_agent_type: "codex",
        reward_cents: 5000
      }
    ])
  });

  try {
    await main([
      "next",
      "--dry-run",
      "--kind", "agent",
      "--mergeos-url", "https://mergeos.shop",
      "--token", "unit-test-token",
      "--command", "definitely-not-a-real-ai-binary-should-never-run",
      "--workspace", workspaceRoot
    ]);
  } finally {
    console.log = originalLog;
    global.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }

  const output = logs.join("\n");
  assert.match(output, /--dry-run \(no AI CLI invoked\)/);
  assert.match(output, /Selected prj_public_0001:7: Add ledger proof panel/);
  assert.match(output, /# --- prompt ---/);
  // Prompt body from buildTaskPrompt must be present.
  assert.match(output, /# MRGMinner Task/);
  assert.match(output, /Add ledger proof panel/);
  assert.match(output, /Panel renders the current ledger tip/);
  // The configured AI command is shown but never executed.
  assert.match(output, /definitely-not-a-real-ai-binary-should-never-run/);
});

test("next --dry-run --json emits a structured payload without running the CLI", async () => {
  const originalFetch = global.fetch;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mrgminner-dryrun-json-"));
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify([
      {
        id: "prj_public_0001:9",
        status: "open",
        title: "Wire status bar",
        acceptance: "Show open task count.",
        required_worker_kind: "agent",
        suggested_agent_type: "claude",
        reward_cents: 5000
      }
    ])
  });

  try {
    await main([
      "next",
      "--dry-run",
      "--json",
      "--mergeos-url", "https://mergeos.shop",
      "--token", "unit-test-token",
      "--provider", "claude",
      "--workspace", workspaceRoot
    ]);
  } finally {
    console.log = originalLog;
    global.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }

  const parsed = JSON.parse(logs.join("\n"));
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.selected.id, "prj_public_0001:9");
  assert.equal(parsed.selected.title, "Wire status bar");
  assert.equal(parsed.ai_command, "claude");
  assert.deepEqual(parsed.ai_args, ["-p", parsed.prompt]);
  assert.match(parsed.prompt, /# MRGMinner Task/);
});
