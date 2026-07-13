"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { countOpenTasks, formatStatusBarText } = require("../src/extension");

test("countOpenTasks counts only tasks with status open", () => {
  const tasks = [
    { id: "a", status: "open" },
    { id: "b", status: "claimed" },
    { id: "c", status: "open" },
    { id: "d", status: "submitted" }
  ];
  assert.equal(countOpenTasks(tasks), 2);
});

test("countOpenTasks tolerates empty and non-array input", () => {
  assert.equal(countOpenTasks([]), 0);
  assert.equal(countOpenTasks(undefined), 0);
  assert.equal(countOpenTasks(null), 0);
  assert.equal(countOpenTasks([null, undefined, {}]), 0);
});

test("formatStatusBarText renders the open task count with an icon", () => {
  assert.equal(formatStatusBarText(0), "$(checklist) 0 open MRG tasks");
  assert.equal(formatStatusBarText(3), "$(checklist) 3 open MRG tasks");
});

test("formatStatusBarText uses the singular label for one task", () => {
  assert.equal(formatStatusBarText(1), "$(checklist) 1 open MRG task");
});
