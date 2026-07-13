"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { redactToken } = require("../src/cli");

test("redactToken hides middle of token", () => {
  assert.equal(redactToken("abc12345"), "ab****45");
});

test("redactToken returns (not set) for empty token", () => {
  assert.equal(redactToken(""), "(not set)");
});

test("redactToken returns short tokens as-is", () => {
  assert.equal(redactToken("abc"), "abc");
});
