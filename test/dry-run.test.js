"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { selectNextTask } = require("../src/cli");

test("selectNextTask returns first open task matching kind", () => {
  const tasks = [
    { id: "tsk_001", title: "Task A", status: "closed", required_worker_kind: "human" },
    { id: "tsk_002", title: "Task B", status: "open", required_worker_kind: "agent" },
    { id: "tsk_003", title: "Task C", status: "open", required_worker_kind: "human" },
  ];
  const result = selectNextTask(tasks, { kind: "agent" });
  assert.equal(result.id, "tsk_002");
});

test("selectNextTask returns first open task when no kind filter", () => {
  const tasks = [
    { id: "tsk_001", status: "closed" },
    { id: "tsk_002", status: "open", title: "Task B" },
  ];
  const result = selectNextTask(tasks, {});
  assert.equal(result.id, "tsk_002");
});

test("selectNextTask returns undefined when no open tasks match", () => {
  const tasks = [
    { id: "tsk_001", status: "closed", required_worker_kind: "agent" },
  ];
  const result = selectNextTask(tasks, { kind: "agent" });
  assert.equal(result, undefined);
});
