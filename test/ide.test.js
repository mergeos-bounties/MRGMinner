"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  buildWorkGroups,
  clientHtml,
  normalizeCommandArgs,
  parseCommandLine,
  resolveWorkspacePath,
  sanitizeTerminalText,
  startIDE
} = require("../src/ide");

test("parseCommandLine preserves quoted command arguments", () => {
  assert.deepEqual(parseCommandLine('prompt "prj_0525:1" --out "chain file.json"'), [
    "prompt",
    "prj_0525:1",
    "--out",
    "chain file.json"
  ]);
});

test("normalizeCommandArgs allows safe commands and guards mutating task commands", () => {
  assert.deepEqual(normalizeCommandArgs(["mrgminner", "status"]), ["status"]);
  assert.deepEqual(normalizeCommandArgs(["claim", "prj_1:1", "--with-intent", "--yes"]), [
    "claim",
    "prj_1:1",
    "--with-intent"
  ]);
  assert.throws(() => normalizeCommandArgs(["claim", "prj_1:1"]), /requires --yes/);
  assert.throws(() => normalizeCommandArgs(["next"]), /requires --yes/);
  assert.deepEqual(normalizeCommandArgs(["next", "--dry-run"]), ["next", "--dry-run"]);
  assert.throws(() => normalizeCommandArgs(["login"]), /not available/);
});

test("resolveWorkspacePath rejects paths outside the workspace", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mrgminner-ide-"));
  assert.equal(resolveWorkspacePath(workspace, "."), path.resolve(workspace));
  assert.throws(() => resolveWorkspacePath(workspace, ".."), /escapes workspace/);
});

test("sanitizeTerminalText removes ANSI control codes and normalizes newlines", () => {
  assert.equal(
    sanitizeTerminalText("\u001b[2m2026\u001b[0m \u001b[33mWARN\u001b[0m ok\r\nnext\rline\u0007"),
    "2026 WARN ok\nnext\nline"
  );
});

test("clientHtml includes the local IDE shell", () => {
  assert.match(clientHtml(), /MRGMinner IDE/);
  assert.match(clientHtml(), /id="editor"/);
  assert.match(clientHtml(), /id="terminal-output"/);
  assert.match(clientHtml(), /id="activity-bar"/);
  assert.match(clientHtml(), /id="stop-run"/);
  assert.match(clientHtml(), /id="terminal-resizer"/);
  assert.match(clientHtml(), /Resume/);
  assert.match(clientHtml(), /AbortController/);
  assert.match(clientHtml(), /cleanTerminalText/);
  assert.match(clientHtml(), /id="docker-status"/);
  assert.match(clientHtml(), /id="work-groups"/);
  assert.match(clientHtml(), /class="inspector-tab active"/);
  assert.match(clientHtml(), /Run task/);
  assert.doesNotMatch(clientHtml(), /data-action="intent"/);
  assert.doesNotMatch(clientHtml(), /id="run-command"/);
});

test("buildWorkGroups groups funded and in-progress project tasks", () => {
  const groups = buildWorkGroups([
    { id: "p1:1", project_id: "p1", project_title: "Funded Project", status: "open", reward_cents: 2500 },
    { id: "p2:1", project_id: "p2", project_title: "Active Project", status: "in_progress", reward_cents: 5000 }
  ], {
    funded_projects: [{ id: "p1", title: "Funded Project", status: "funded", budget_cents: 2500 }],
    active_projects: [{ id: "p2", title: "Active Project", status: "in_progress", budget_cents: 5000 }]
  });

  assert.equal(groups[0].id, "all");
  assert.equal(groups.find((group) => group.project_id === "p1").status_group, "funded");
  assert.equal(groups.find((group) => group.project_id === "p2").status_group, "in_progress");
});

test("startIDE serves bootstrap data", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mrgminner-ide-"));
  const settings = path.join(workspace, "settings.json");
  const handle = await startIDE({
    host: "127.0.0.1",
    port: 0,
    settings,
    workspaceRoot: workspace
  });
  try {
    const response = await fetch(`${handle.url}api/bootstrap`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.app.name, "MRGMinner IDE");
    assert.equal(payload.workspace.root, path.resolve(workspace));
    assert.equal(payload.docker.sandbox_enabled, true);
    assert.ok(Array.isArray(payload.ai.providers));

    const tasksResponse = await fetch(`${handle.url}api/tasks`);
    const tasksPayload = await tasksResponse.json();
    assert.equal(tasksResponse.status, 200);
    assert.ok(tasksPayload.tasks.some((task) => task.id === "local:welcome-ai"));
  } finally {
    await new Promise((resolve) => handle.server.close(resolve));
  }
});

test("command stream emits ndjson command events", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mrgminner-ide-stream-"));
  const settings = path.join(workspace, "settings.json");
  const handle = await startIDE({
    host: "127.0.0.1",
    port: 0,
    settings,
    workspaceRoot: workspace
  });
  try {
    const response = await fetch(`${handle.url}api/command/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandLine: "status" })
    });
    const text = await response.text();
    const events = text.trim().split("\n").map((line) => JSON.parse(line));

    assert.equal(response.status, 200);
    assert.equal(events[0].type, "start");
    assert.ok(events.some((event) => event.type === "event"));
    assert.ok(events.some((event) => event.type === "result" || event.type === "error"));
  } finally {
    await new Promise((resolve) => handle.server.close(resolve));
  }
});
