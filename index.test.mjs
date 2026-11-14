import assert from "node:assert/strict";
import { test } from "node:test";

import { channelGoVersion, check, compareGoVersions, get, goDirective, parseGoVersion, stableRelease } from "./index.mjs";

test("goDirective", () => {
  assert.equal(goDirective("go.mod", "module x\n\ngo 1.25\n"), "1.25");
  assert.equal(goDirective("go.mod", "module x\n\ngo 1.25.3 // pinned\n\nrequire y v1.0.0\n"), "1.25.3");
  assert.equal(goDirective("go.mod", "module x\n\ngo 1.24\ntoolchain go1.26.0\n"), "1.24");
  assert.throws(() => goDirective("go.mod", "module x\n"), /no go directive/);
  assert.throws(() => goDirective("go.mod", "module x\n\ngo banana\n"), /invalid go version/);
});

test("parseGoVersion matches go/version.IsValid", () => {
  for (const v of ["1", "1.20", "1.21", "1.21.3", "1.21rc1", "1.22beta2"]) {
    assert.ok(parseGoVersion(v), v);
  }
  for (const v of ["", "banana", "1.", "1.021", "1.21.3rc1", "go1.21"]) {
    assert.equal(parseGoVersion(v), null, v);
  }
});

test("compareGoVersions matches go/version.Compare", () => {
  const ordered = ["1.20", "1.20.1", "1.21", "1.21rc1", "1.21rc2", "1.21.0", "1.21.1", "1.21.10", "1.22beta1"];
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(compareGoVersions(ordered[i - 1], ordered[i]), -1, `${ordered[i - 1]} < ${ordered[i]}`);
    assert.equal(compareGoVersions(ordered[i], ordered[i - 1]), 1, `${ordered[i]} > ${ordered[i - 1]}`);
  }
  assert.equal(compareGoVersions("1.20", "1.20.0"), 0);
});

// The tests below query the live NixOS infrastructure.

test("stableRelease", async () => {
  assert.match(await stableRelease(), /^\d{2}\.(05|11)$/);
});

test("channelGoVersion", async () => {
  const release = await stableRelease();
  const { channel, go } = await channelGoVersion(release);
  assert.ok(channel.startsWith(`nixos-${release}.`), channel);
  assert.ok(compareGoVersions(go, "1.22") >= 0, go);
});

test("check", async () => {
  assert.match(await check("go.mod", "module x\n\ngo 1.22\n"), /^go\.mod requires go 1\.22; nixos-/);
  await assert.rejects(check("go.mod", "module x\n\ngo 1.99\n"), /requires go 1\.99, but nixos-/);
});

test("get does not retry client errors", async () => {
  // A retry would wait 2s first.
  const start = Date.now();
  await assert.rejects(get("https://channels.nixos.org/check-nixpkgs-go-missing"), /404/);
  assert.ok(Date.now() - start < 2000, `took ${Date.now() - start}ms; looks like it retried`);
});
