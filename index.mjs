// check-nixpkgs-go fails when go.mod requires a newer Go than the current
// nixpkgs stable channel ships. It uses only Node's standard library.

import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

const prometheusURL = "https://prometheus.nixos.org";
const channelsURL = "https://channels.nixos.org";
const hydraURL = "https://hydra.nixos.org";

// check compares the go directive in data, the contents of goMod, with the Go
// in nixpkgs stable, and returns a summary or throws if the Go is too new.
export async function check(goMod, data) {
  const required = goDirective(goMod, data);
  const release = await context("finding nixpkgs stable release", stableRelease());
  const { channel, go } = await context(
    `finding Go version in nixpkgs ${release}`,
    channelGoVersion(release),
  );
  if (compareGoVersions(required, go) > 0) {
    throw new Error(`${goMod} requires go ${required}, but ${channel} only has go ${go}`);
  }
  return `${goMod} requires go ${required}; ${channel} has go ${go}`;
}

// readGoMod reads goMod from the workspace or, when the repository isn't
// checked out, from Gitea's API at the commit being tested.
export async function readGoMod(goMod) {
  try {
    return await readFile(resolve(process.env.GITHUB_WORKSPACE ?? ".", goMod), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = process.env;
  if (!server || !repo || !sha) {
    throw new Error(`${goMod} not found, and GITHUB_SERVER_URL, GITHUB_REPOSITORY or GITHUB_SHA is unset`);
  }
  // Gitea serves the default branch for a ref it can't resolve, such as an
  // abbreviated commit, so only accept a full commit ID.
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw new Error(`GITHUB_SHA ${sha} isn't a full commit ID`);
  const file = posix.normalize(`/${goMod}`).slice(1).split("/").map(encodeURIComponent).join("/");
  const url = `${server.replace(/\/$/, "")}/api/v1/repos/${repo}/raw/${file}?ref=${encodeURIComponent(sha)}`;
  const headers = process.env.INPUT_TOKEN ? { Authorization: `token ${process.env.INPUT_TOKEN}` } : {};
  const res = await context(
    `${goMod} not found locally, and fetching it from ${repo} at ${sha} failed`,
    get(url, headers),
  );
  console.log(`Read ${goMod} from ${repo} at ${sha}`);
  return res.text();
}

// goDirective returns the version from go.mod's `go` line.
export function goDirective(goMod, data) {
  for (const line of data.split("\n")) {
    const fields = line.split("//")[0].trim().split(/\s+/);
    if (fields.length === 2 && fields[0] === "go") {
      if (!parseGoVersion(fields[1])) {
        throw new Error(`${goMod} has an invalid go version ${JSON.stringify(fields[1])}`);
      }
      return fields[1];
    }
  }
  throw new Error(`${goMod} has no go directive`);
}

// stableRelease asks the NixOS channel monitor for the newest stable
// release, e.g. "26.05".
export async function stableRelease() {
  const query = new URLSearchParams({ query: 'channel_revision{status="stable",variant="primary"}' });
  const { data } = await getJSON(`${prometheusURL}/api/v1/query?${query}`);
  let newest = "";
  for (const { metric } of data?.result ?? []) {
    // "YY.MM" sorts correctly as a string.
    const m = /^nixos-(\d{2}\.\d{2})$/.exec(metric?.channel);
    if (m && m[1] > newest) newest = m[1];
  }
  if (!newest) throw new Error("no stable nixos-YY.MM channel listed");
  return newest;
}

// channelGoVersion returns the release the nixos-<release> channel points at,
// e.g. "nixos-26.05.13936.ac588ef1c914", and the version of nixpkgs' default
// `go` in the Hydra evaluation that release was built from, e.g. "1.26.10".
export async function channelGoVersion(release) {
  // The channel redirects each file to the same file in its current release
  // directory, which records the Hydra evaluation in src-url.
  const rev = await get(`${channelsURL}/nixos-${release}/git-revision`);
  await rev.body?.cancel();
  const dir = new URL(".", rev.url);
  const channel = posix.basename(dir.pathname);
  const src = (await (await get(new URL("src-url", dir))).text()).trim();
  const evalID = /\/eval\/(\d+)$/.exec(src)?.[1];
  if (!evalID) throw new Error(`${channel} has an unexpected src-url ${JSON.stringify(src)}`);

  const build = await getJSON(`${hydraURL}/eval/${evalID}/job/nixpkgs.go.x86_64-linux`);
  if (build.finished !== 1 || build.buildstatus !== 0) {
    throw new Error(`Hydra build ${JSON.stringify(build.nixname)} in eval ${evalID} did not succeed`);
  }
  const go = /^go-(.*)$/.exec(build.nixname)?.[1];
  if (!go || !parseGoVersion(go)) {
    throw new Error(`unexpected Hydra build name ${JSON.stringify(build.nixname)}`);
  }
  return { channel, go };
}

// parseGoVersion ports Go's internal/gover.Parse for versions without the
// "go" prefix, like "1.21", "1.21rc1" and "1.21.3". It returns null for an
// invalid version.
export function parseGoVersion(x) {
  const m = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*)|([a-z]+)(0|[1-9]\d*)?)?)?$/.exec(x);
  if (!m) return null;
  const [, major, minor, patch, kind = "", pre = ""] = m;
  if (minor === undefined) return { major, minor: "0", patch: "0", kind, pre };
  // A missing patch is the same as ".0" before Go 1.21, and sorts before
  // the release candidates from Go 1.21 on.
  const defaultPatch = !kind && compareInts(minor, "21") < 0 ? "0" : "";
  return { major, minor, patch: patch ?? defaultPatch, kind, pre };
}

// compareGoVersions ports Go's go/version.Compare: 1.21 < 1.21rc1 < 1.21.0.
export function compareGoVersions(x, y) {
  const a = parseGoVersion(x) ?? {};
  const b = parseGoVersion(y) ?? {};
  for (const k of ["major", "minor", "patch"]) {
    const c = compareInts(a[k] ?? "", b[k] ?? "");
    if (c) return c;
  }
  const kinds = (a.kind ?? "") < (b.kind ?? "") ? -1 : (a.kind ?? "") > (b.kind ?? "") ? 1 : 0;
  return kinds || compareInts(a.pre ?? "", b.pre ?? "");
}

// compareInts compares decimal strings without leading zeros.
function compareInts(x, y) {
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

async function getJSON(url) {
  const res = await get(url, { Accept: "application/json" });
  return res.json();
}

// get fetches url, retrying server errors and network failures twice.
export async function get(url, headers = {}) {
  let err;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 2000));
    let res;
    try {
      res = await fetch(url, {
        headers: { ...headers, "User-Agent": "check-nixpkgs-go" },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      err = e;
      continue;
    }
    if (res.ok) return res;
    await res.body?.cancel();
    err = new Error(`GET ${url}: ${res.status} ${res.statusText}`);
    if (res.status < 500) throw err;
  }
  throw err;
}

async function context(message, promise) {
  try {
    return await promise;
  } catch (err) {
    throw new Error(`${message}: ${err.message}`, { cause: err });
  }
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const goMod = process.env["INPUT_GO-MOD-FILE"] || "go.mod";
  try {
    console.log(await check(goMod, await readGoMod(goMod)));
  } catch (err) {
    console.log(`::error file=${goMod}::${err.message}`);
    process.exitCode = 1;
  }
}
