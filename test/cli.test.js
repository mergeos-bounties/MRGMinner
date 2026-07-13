"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { buildCompareNotes, parseFlags } = require("../src/cli");

test("buildCompareNotes includes task header and provider table", () => {
  const task = { id: "tsk_42", title: "Implement compare", reward_cents: 20000 };
  const results = [
    { provider: "codex", error: null, command: "codex", args: ["exec", "prompt.md"], commandLine: "codex exec prompt.md" },
    { provider: "claude", error: null, command: "claude", args: ["-p", "prompt.md"], commandLine: "claude -p prompt.md" }
  ];
  const artifacts = { promptFile: "/tmp/.mergeide/tasks/tsk_42/prompt.md" };

  const notes = buildCompareNotes(task, results, artifacts);

  assert.match(notes, /# Multi-Provider Compare/);
  assert.match(notes, /Task: tsk_42 — Implement compare/);
  assert.match(notes, /Reward: 200\.00 MRG/);
  assert.match(notes, /\| 1 \| codex \| `codex exec prompt\.md` \|/);
  assert.match(notes, /\| 2 \| claude \| `claude -p prompt\.md` \|/);
  assert.match(notes, /- Command: `claude`/);
  assert.match(notes, /- Args: `\["exec","prompt\.md"\]`/);
});

test("buildCompareNotes handles single provider", () => {
  const task = { id: "tsk_1", title: "Single", reward_cents: 1000 };
  const results = [
    { provider: "custom", error: null, command: "my-cli", args: ["run", "task.json"], commandLine: "my-cli run task.json" }
  ];
  const artifacts = { promptFile: "/tmp/prompt.md" };

  const notes = buildCompareNotes(task, results, artifacts);

  assert.match(notes, /\| 1 \| custom \| `my-cli run task\.json` \|/);
  assert.match(notes, /- Args: `\["run","task\.json"\]`/);
});

test("buildCompareNotes shows error row when provider fails", () => {
  const task = { id: "tsk_3", title: "Errored", reward_cents: 5000 };
  const results = [
    { provider: "codex", error: null, command: "codex", args: ["exec", "p.md"], commandLine: "codex exec p.md" },
    { provider: "bogus", error: "AI CLI command is empty", command: "", args: [], commandLine: "" }
  ];
  const artifacts = { promptFile: "/tmp/p.md" };

  const notes = buildCompareNotes(task, results, artifacts);

  assert.match(notes, /\| 1 \| codex \| `codex exec p\.md` \|/);
  assert.match(notes, /\| 2 \| bogus \| _error: AI CLI command is empty_ \|/);
  assert.match(notes, /- Error: AI CLI command is empty/);
});

test("buildCompareNotes outputs reward with two decimal places", () => {
  const task = { id: "tsk_5", title: "Zero reward", reward_cents: 0 };
  const results = [
    { provider: "codex", error: null, command: "codex", args: [], commandLine: "codex" }
  ];
  const artifacts = { promptFile: "/tmp/p.md" };

  const notes = buildCompareNotes(task, results, artifacts);

  assert.match(notes, /Reward: 0\.00 MRG/);
});

test("parseFlags handles --presets flag", () => {
  const flags = parseFlags(["--presets", "codex,claude,custom"]);
  assert.equal(flags.presets, "codex,claude,custom");
});

test("parseFlags defaults presets not set", () => {
  const flags = parseFlags([]);
  assert.equal(flags.presets, undefined);
});
