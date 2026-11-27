import { $, Glob, type SupportedCryptoAlgorithms } from "bun";
import { readFile, stat, writeFile } from "fs/promises";
import {
  type Asset,
  HttpError,
  buildChecksumLines,
  type HashedAsset,
  findStale,
  normalizeAsset,
  processAsset,
  serializeChecksums,
  shouldUpload,
  withRetry,
} from "./lib";

const PROGRESS_BYTES = 64 * 1024 * 1024; // 64 MiB
const PROGRESS_MS = 5000;

async function getReleaseNoAuth(repo: string, tag: string) {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch release details: ${response.statusText}`);
  }

  return await response.text();
}

function parsePatternsInput(patternsInput: string): string[] {
  return patternsInput
    .split("\n")
    .map((pattern) => pattern.replace(/^"|"$/g, "").trim())
    .filter((pattern) => pattern !== "");
}

function githubToken(): string | undefined {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || undefined;
}

/** Prefer the Releases Assets API URL; fall back to browser download for public dry-runs. */
function resolveAssetFetch(asset: Asset): {
  url: string;
  useApiHeaders: boolean;
} {
  if (asset.apiUrl) {
    return { url: asset.apiUrl, useApiHeaders: true };
  }
  if (asset.url?.includes("api.github.com")) {
    return { url: asset.url, useApiHeaders: true };
  }
  if (asset.browser_download_url) {
    return { url: asset.browser_download_url, useApiHeaders: false };
  }
  if (asset.url) {
    return { url: asset.url, useApiHeaders: false };
  }
  throw new Error(`No download URL for asset ${asset.name}`);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/** Start downloading an asset; throws HttpError on a non-2xx status. */
async function fetchAsset(asset: Asset): Promise<Response> {
  const { url, useApiHeaders } = resolveAssetFetch(asset);
  const token = githubToken();
  const headers: Record<string, string> = {};

  if (useApiHeaders) {
    headers.Accept = "application/octet-stream";
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  const res = await fetch(url, {
    headers,
    redirect: "follow",
  });

  if (!res.ok) {
    throw new HttpError(
      res.status,
      `Failed to download ${asset.name}: ${res.status} ${res.statusText}`
    );
  }
  return res;
}

/**
 * Stream an asset from GitHub into Bun.CryptoHasher.
 * Peak RAM ≈ chunk size; the asset is never written to disk.
 */
async function hashAssetFromRelease(asset: Asset): Promise<string> {
  console.log(`Streaming hash for ${asset.name} (${formatBytes(asset.size)})...`);

  const res = await fetchAsset(asset);
  if (!res.body) {
    throw new Error(`No response body for ${asset.name}`);
  }

  const hasher = new Bun.CryptoHasher(
    hashAlgorithm as SupportedCryptoAlgorithms
  );

  let received = 0;
  let lastProgressAt = Date.now();
  let lastProgressBytes = 0;

  for await (const chunk of res.body) {
    hasher.update(chunk);
    received += chunk.byteLength;

    const now = Date.now();
    if (
      received - lastProgressBytes >= PROGRESS_BYTES ||
      now - lastProgressAt >= PROGRESS_MS
    ) {
      const total =
        asset.size > 0 ? ` / ${formatBytes(asset.size)}` : "";
      console.log(`  ${asset.name}: ${formatBytes(received)}${total}`);
      lastProgressAt = now;
      lastProgressBytes = received;
    }
  }

  if (asset.size > 0 && received !== asset.size) {
    console.warn(
      `Size mismatch for ${asset.name}: expected ${asset.size}, got ${received}`
    );
  }

  const digest = hasher.digest("hex");
  console.log(`Hashed ${asset.name}: ${digest}`);
  return digest;
}

function shouldIncludeAsset(assetName: string, patterns: string[]) {
  let matched = false;
  let excluded = false;

  for (const pattern of patterns) {
    const glob = new Glob(pattern);

    if (pattern.startsWith("!") && !glob.match(assetName)) {
      excluded = true;
      break;
    } else if (glob.match(assetName)) {
      matched = true;
    }
  }

  if (excluded) {
    return false;
  }
  if (matched) {
    return true;
  }
  return false;
}

async function uploadChecksumFile(
  checkSumPath: string,
  repo: string,
  tag: string
): Promise<void> {
  if (isDryRun) {
    console.info(
      `Dry run. Skipping upload of ${checkSumPath} to ${repo}@${tag}`
    );
    return;
  }
  const fileInfo = await stat(checkSumPath);
  if (fileInfo.size === 0) {
    console.warn("Checksum is empty. Skipping upload.");
  } else {
    console.log("Uploading checksum file.");
    await $`gh release upload -R ${repo} ${tag} ${checkSumPath} --clobber`;
  }
}

console.log("Starting checksum action...");
console.log(`Checksum file name: ${process.env.INPUT_FILE_NAME}`);
console.log(`Hash Algorithm: ${process.env.INPUT_ALGORITHM || "sha256"}`);
console.log(`Repo: ${process.env.INPUT_REPO}`);
console.log(`Tag Input: ${process.env.INPUT_TAG}`);
console.log(`Patterns Input: ${process.env.INPUT_PATTERNS}`);
console.log(`Dry Run: ${process.env.INPUT_DRY_RUN}`);

const checkSumPath = process.env.INPUT_FILE_NAME!;
const isDryRun = process.env.INPUT_DRY_RUN === "true";
const isPreRelease = process.env.INPUT_PRE_RELEASE === "true";

const hashAlgorithm = process.env.INPUT_ALGORITHM || "sha256";

const githubContext = JSON.parse(process.env.GITHUB_CONTEXT ?? "{}");
const repo = process.env.INPUT_REPO || githubContext.repository;

const tagInput = process.env.INPUT_TAG;
let tag = "";
if (tagInput) {
  tag = tagInput.trim();
} else {
  if (isPreRelease) {
    // https://github.com/cli/cli/issues/9909#issuecomment-2473608076
    tag =
      await $`gh release list -R ${repo} --json isPrerelease,tagName --jq 'map(select(.isPrerelease)) | first | .tagName'`
        .text()
        .then((t) => t.trim());
  } else {
    tag = await $`gh release view -R ${repo} --json tagName --jq .tagName`
      .text()
      .then((t) => t.trim());
  }
}

const patterns = parsePatternsInput(process.env.INPUT_PATTERNS ?? "");

const failOnError = process.env.INPUT_FAIL_ON_ERROR !== "false";

async function listAssets(): Promise<Asset[]> {
  let releaseContent: string;
  if (isDryRun && !githubToken()) {
    releaseContent = await getReleaseNoAuth(repo, tag);
  } else {
    releaseContent = await $`gh release view ${tag} -R ${repo} --json assets`.text();
  }
  const release: { assets: unknown[] } = JSON.parse(releaseContent);
  return release.assets.map(normalizeAsset);
}

const retryOptions = {
  attempts: 3,
  baseDelayMs: 2000,
  onRetry: (err: unknown, attempt: number, delayMs: number) =>
    console.warn(
      `Attempt ${attempt} failed (${err instanceof Error ? err.message : err}); retrying in ${delayMs} ms`
    ),
};

const inScope = (list: Asset[]) =>
  list.filter(
    (a) =>
      a.name !== checkSumPath &&
      (!patterns.length || shouldIncludeAsset(a.name, patterns))
  );

let assets = await withRetry(listAssets, retryOptions);

// Only hashes computed in this run; an existing checksum file on the release is never read or merged.
const hashedResults = new Map<string, HashedAsset>(); // name -> hashed version + hash
const hashedVersion = new Map<string, Asset>(); // name -> asset version that was hashed
const rehashed = new Set<string>();
const skippedGone = new Set<string>();
const failed = new Map<string, string>(); // name -> error message

async function processOne(asset: Asset): Promise<void> {
  const outcome = await processAsset(asset, {
    hash: hashAssetFromRelease,
    listAssets: async () => {
      assets = await listAssets();
      return assets;
    },
    retry: retryOptions,
    log: (msg) => console.warn(msg),
  });
  if (outcome.kind === "hashed") {
    hashedResults.set(asset.name, { asset: outcome.asset, hash: outcome.hash });
    hashedVersion.set(asset.name, outcome.asset);
    failed.delete(asset.name);
    skippedGone.delete(asset.name);
    if (outcome.replaced) rehashed.add(asset.name);
  } else if (outcome.kind === "gone") {
    console.warn(`::warning::${asset.name} no longer exists in the release, skipped`);
    hashedResults.delete(asset.name);
    hashedVersion.delete(asset.name);
    skippedGone.add(asset.name);
  } else {
    const msg =
      outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    console.error(`Failed to hash ${asset.name}: ${msg}`);
    hashedResults.delete(asset.name);
    failed.set(asset.name, msg);
  }
}

const notUploaded = new Set<string>();
for (const asset of assets) {
  if (asset.name == checkSumPath) continue;
  if (patterns.length && !shouldIncludeAsset(asset.name, patterns)) {
    console.log(`Skip ${asset.name}`);
    continue;
  }
  if (asset.state !== undefined && asset.state !== "uploaded") {
    console.warn(`Skip ${asset.name}: state is "${asset.state}", not "uploaded"`);
    notUploaded.add(asset.name);
    continue;
  }

  await processOne(asset);
}

// Assets may have been replaced or added while we were hashing: re-list and catch up.
for (let round = 0; round < 3; round++) {
  try {
    assets = await withRetry(listAssets, retryOptions);
  } catch (err) {
    console.warn(`Could not re-list the release: ${err instanceof Error ? err.message : err}`);
    break;
  }
  const todo = inScope(assets).filter(
    (a) =>
      (a.state === undefined || a.state === "uploaded") &&
      !failed.has(a.name) &&
      (!hashedVersion.has(a.name) || findStale(hashedVersion, [a]).length > 0)
  );
  if (todo.length === 0) break;
  for (const asset of todo) {
    console.log(`Catching up on ${asset.name} (new or changed during the run)`);
    const wasHashed = hashedVersion.has(asset.name);
    await processOne(asset);
    if (wasHashed && hashedResults.has(asset.name)) rehashed.add(asset.name);
  }
}

// Final listing right before the single upload: only hashes of the version that is listed now are written.
let finalAssets = assets;
try {
  finalAssets = await withRetry(listAssets, retryOptions);
  assets = finalAssets;
} catch (err) {
  console.warn(
    `Could not list the release before the upload (${err instanceof Error ? err.message : err}); using the last listing`
  );
}
for (const asset of findStale(hashedVersion, finalAssets)) {
  console.error(`${asset.name} changed after it was hashed; no entry is written`);
  hashedResults.delete(asset.name);
  failed.set(asset.name, "changed after it was hashed");
}
const lines = buildChecksumLines(inScope(finalAssets), hashedResults);
await writeFile(checkSumPath, serializeChecksums(lines));
const uploadAllowed = shouldUpload(failed.size, failOnError);
if (uploadAllowed) {
  await uploadChecksumFile(checkSumPath, repo, tag);
} else {
  console.error(
    `${failed.size} asset(s) could not be hashed and fail-on-error is set: not uploading, the existing ${checkSumPath} on the release stays untouched`
  );
}

const finalScope = inScope(assets);
const stillNotUploaded = finalScope.filter(
  (a) => a.state !== undefined && a.state !== "uploaded"
).length;
const summary = {
  processed: lines.length,
  rehashedAfterReplacement: rehashed.size,
  skippedGone: skippedGone.size,
  skippedNotUploaded: stillNotUploaded,
  failed: failed.size,
};

console.log(
  `Release Tag: ${tag}, Repo: ${repo}, Algorithm: ${hashAlgorithm}, Patterns: ${JSON.stringify(
    patterns
  )}`
);
console.log(
  `Summary: processed=${summary.processed}, re-hashed after replacement=${summary.rehashedAfterReplacement}, skipped (gone)=${summary.skippedGone}, skipped (not uploaded)=${summary.skippedNotUploaded}, failed=${summary.failed}`
);
console.log(`Checksum file content:\n${await readFile(checkSumPath, "utf-8")}`);

if (failed.size > 0) {
  const level = failOnError ? "error" : "warning";
  for (const [name, msg] of failed) {
    console.log(`::${level}::Could not checksum ${name}: ${msg}`);
  }
  if (failOnError) process.exit(1);
}
