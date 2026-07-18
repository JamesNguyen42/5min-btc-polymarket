"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLocalOriginPolicy } = require("../lib/local-origin-policy");

function request(headers = {}) {
  return { headers, socket: { encrypted: false } };
}

test("same-origin proposal mutations are allowed", () => {
  const policy = createLocalOriginPolicy([]);
  const req = request({
    host: "127.0.0.1:3000",
    origin: "http://127.0.0.1:3000",
    "sec-fetch-site": "same-origin",
  });
  assert.equal(policy.isAllowedMutation(req), true);
  assert.equal(policy.corsHeaders(req)["access-control-allow-origin"], "http://127.0.0.1:3000");
});

test("foreign web origins cannot mutate or obtain permissive CORS", () => {
  const policy = createLocalOriginPolicy([]);
  const req = request({
    host: "127.0.0.1:3000",
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(policy.isAllowedMutation(req), false);
  assert.equal(policy.corsHeaders(req)["access-control-allow-origin"], undefined);
});

test("an explicitly configured frontend origin is allowed", () => {
  const policy = createLocalOriginPolicy(["https://dashboard.example"]);
  const req = request({
    host: "api.example",
    origin: "https://dashboard.example",
    "sec-fetch-site": "cross-site",
    "x-forwarded-proto": "https",
  });
  assert.equal(policy.isAllowedMutation(req), true);
});

test("cross-site browser metadata is rejected even when Origin is missing", () => {
  const policy = createLocalOriginPolicy([]);
  assert.equal(policy.isAllowedMutation(request({ host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" })), false);
});
