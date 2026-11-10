import { $, Glob, type SupportedCryptoAlgorithms } from "bun";
import { appendFile, readFile, stat } from "fs/promises";

interface Asset {
  apiUrl?: string;
  browser_download_url?: string;
  contentType?: string;
  createdAt?: string;
  downloadCount?: number;
  id?: string;
  label?: string;
  name: string;
  size: number;
  state?: string;
  updatedAt?: string;
  url?: string;
}

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

/**
 * Stream an asset from GitHub into Bun.CryptoHasher.
 * Peak RAM ≈ chunk size; the asset is never written to disk.
 */
async function hashAssetFromRelease(asset: Asset): Promise<string> {
  const { url, useApiHeaders } = resolveAssetFetch(asset);
  const token = githubToken();
  const headers: Record<string, string> = {};

  if (useApiHeaders) {
    headers.Accept = "application/octet-stream";
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  console.log(`Streaming hash for ${asset.name} (${formatBytes(asset.size)})...`);

  const res = await fetch(url, {
    headers,
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(
      `Failed to download ${asset.name}: ${res.status} ${res.statusText}`
    );
  }
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
const minSizeImmediateUpload = 1000 * 1000 * 500; // 500MB
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

let releaseContent: string;
const token = githubToken();
if (isDryRun && !token) {
  releaseContent = await getReleaseNoAuth(repo, tag);
} else {
  releaseContent = await $`gh release view ${tag} -R ${repo} --json assets`.text();
}
const releases: { assets: Asset[] } = JSON.parse(releaseContent);

for (const asset of releases.assets) {
  if (asset.name == checkSumPath) {
    console.info("Found existing checksum in assets");
    continue;
  }
  if (patterns.length && !shouldIncludeAsset(asset.name, patterns)) {
    console.log(`Skip ${asset.name}`);
    continue;
  }

  const checksum = await hashAssetFromRelease(asset);
  await appendFile(checkSumPath, `${asset.name}\t${checksum}\n`);

  if (asset.size > minSizeImmediateUpload) {
    console.log(`Uploading immediately due to large file: ${asset.name}`);
    await uploadChecksumFile(checkSumPath, repo, tag);
  }
}

await uploadChecksumFile(checkSumPath, repo, tag);

console.log(
  `Release Tag: ${tag}, Repo: ${repo}, Algorithm: ${hashAlgorithm}, Patterns: ${JSON.stringify(
    patterns
  )}, Assets processed: ${releases.assets.length}`
);
console.log(`Checksum file content:\n${await readFile(checkSumPath, "utf-8")}`);
