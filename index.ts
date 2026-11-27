import { $, Glob, type SupportedCryptoAlgorithms } from "bun";
import { readFile, writeFile } from "fs/promises";
import {
  type Asset,
  HttpError,
  decideFinal,
  findUnhashed,
  type HashedAsset,
  isUploaded,
  normalizeAsset,
  processAsset,
  serializeChecksums,
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
  console.log("Uploading checksum file.");
  // gh deletes the old asset before uploading; a retry after a failed upload just uploads again.
  await withRetry(
    () => $`gh release upload -R ${repo} ${tag} ${checkSumPath} --clobber`,
    retryOptions
  );
}

async function deleteChecksumFile(
  checkSumPath: string,
  repo: string,
  tag: string
): Promise<void> {
  if (isDryRun) {
    console.info(`Dry run. Skipping deletion of ${checkSumPath} from ${repo}@${tag}`);
    return;
  }
  console.warn(`Deleting ${checkSumPath}: the release has no assets left that it could describe.`);
  await withRetry(
    () => $`gh release delete-asset ${tag} ${checkSumPath} -R ${repo} -y`,
    retryOptions
  );
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
const hashed = new Map<string, HashedAsset>(); // name -> hashed version + hash
const rehashed = new Set<string>();
const skippedGone = new Set<string>();
const errors = new Map<string, string>(); // name -> error message of this run

async function processOne(asset: Asset): Promise<void> {
  const wasHashed = hashed.has(asset.name);
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
    hashed.set(asset.name, { asset: outcome.asset, hash: outcome.hash });
    errors.delete(asset.name);
    skippedGone.delete(asset.name);
    if (outcome.replaced || wasHashed) rehashed.add(asset.name);
  } else if (outcome.kind === "gone") {
    console.warn(
      `::warning::${asset.name} is not in the release any more (deleted, or being replaced), skipped`
    );
    hashed.delete(asset.name);
    skippedGone.add(asset.name);
  } else {
    const msg =
      outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    console.error(`Failed to hash ${asset.name}: ${msg}`);
    hashed.delete(asset.name);
    errors.set(asset.name, msg);
  }
}

for (const asset of assets) {
  if (asset.name == checkSumPath) continue;
  if (patterns.length && !shouldIncludeAsset(asset.name, patterns)) {
    console.log(`Skip ${asset.name}`);
    continue;
  }
  if (!isUploaded(asset)) {
    console.warn(`Skip ${asset.name}: state is "${asset.state}", not "uploaded"`);
    continue;
  }

  await processOne(asset);
}

// Assets may have been replaced or added while we were hashing: list again and catch up until a
// listing has nothing left to hash. That listing is the final one the checksum file is built from.
const MAX_CATCH_UP_ROUNDS = 10;
let finalListing: Asset[] | null = null;
for (let round = 0; ; round++) {
  let listing: Asset[];
  try {
    listing = await withRetry(listAssets, retryOptions);
  } catch (err) {
    console.error(
      `Could not list the release (${err instanceof Error ? err.message : err}); the hashes cannot be checked against the current assets`
    );
    break;
  }
  assets = listing;
  const todo = findUnhashed(inScope(listing), hashed).filter((a) => !errors.has(a.name));
  if (todo.length === 0 || round === MAX_CATCH_UP_ROUNDS) {
    finalListing = listing;
    break;
  }
  for (const asset of todo) {
    console.log(`Catching up on ${asset.name} (new or changed during the run)`);
    await processOne(asset);
  }
}

const decision = decideFinal({
  listing: finalListing && inScope(finalListing),
  hashed,
  errors,
  failOnError,
  allowDelete: patterns.length === 0,
});
await writeFile(checkSumPath, serializeChecksums(decision.lines));
const keepReason =
  finalListing === null
    ? "the release could not be listed"
    : decision.failures.size > 0
      ? `${decision.failures.size} asset(s) have no hash of their current version`
      : decision.notUploaded.length > 0
        ? `${decision.notUploaded.length} asset(s) are still being uploaded and nothing else is left to hash`
        : "the patterns match no asset of the release";
if (decision.action === "upload") {
  await uploadChecksumFile(checkSumPath, repo, tag);
} else if (decision.action === "delete") {
  if (finalListing!.some((a) => a.name === checkSumPath)) {
    await deleteChecksumFile(checkSumPath, repo, tag);
  } else {
    console.log(`No in-scope assets and no ${checkSumPath} on the release: nothing to do`);
  }
} else {
  console.error(
    `Not uploading: ${keepReason}. The existing ${checkSumPath} on the release stays untouched`
  );
}

const summary = {
  processed: decision.lines.length,
  rehashedAfterReplacement: rehashed.size,
  skippedGone: skippedGone.size,
  skippedNotUploaded: decision.notUploaded.length,
  failed: decision.failures.size,
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

const level = failOnError ? "error" : "warning";
if (finalListing === null) {
  console.log(`::${level}::Could not list the release before the upload; ${checkSumPath} was not uploaded`);
}
for (const [name, msg] of decision.failures) {
  console.log(`::${level}::Could not checksum ${name}: ${msg}`);
}
if (failOnError && (decision.failures.size > 0 || finalListing === null)) process.exit(1);
