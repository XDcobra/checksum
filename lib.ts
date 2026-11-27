/**
 * Pure helpers for the checksum action (no network, no filesystem), so they can be unit tested.
 */

export interface Asset {
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

/** Normalize `gh release view --json assets` and REST API (snake_case) asset objects. */
export function normalizeAsset(raw: any): Asset {
  return {
    ...raw,
    id: raw.id !== undefined && raw.id !== null ? String(raw.id) : undefined,
    updatedAt: raw.updatedAt ?? raw.updated_at,
    createdAt: raw.createdAt ?? raw.created_at,
    contentType: raw.contentType ?? raw.content_type,
    downloadCount: raw.downloadCount ?? raw.download_count,
  };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export type ErrorKind = "gone" | "retry" | "fatal";

/** 404 -> the asset may have been replaced or deleted; 5xx/429/network -> retry; other 4xx -> fatal. */
export function classifyError(err: unknown): ErrorKind {
  if (err instanceof HttpError) {
    if (err.status === 404) return "gone";
    if (err.status >= 500 || err.status === 408 || err.status === 429) return "retry";
    return "fatal";
  }
  return "retry"; // network errors, aborted streams, ...
}

function isNewer(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta > tb;
}

/** True when `current` is the same version (id and updated_at) of the asset as `hashed`. */
export function sameVersion(hashed: Asset, current: Asset): boolean {
  if (hashed.id !== undefined && current.id !== undefined && hashed.id !== current.id) return false;
  if (hashed.updatedAt !== undefined && current.updatedAt !== undefined) {
    const th = Date.parse(hashed.updatedAt);
    const tc = Date.parse(current.updatedAt);
    if (Number.isNaN(th) || Number.isNaN(tc)) return hashed.updatedAt === current.updatedAt;
    return th === tc;
  }
  return true;
}

export interface HashedAsset {
  /** The asset version that was hashed. */
  asset: Asset;
  hash: string;
}

/**
 * Lines of the checksum file, in release order of the final listing. An asset gets an entry only if
 * a hash was computed in this run, it is `uploaded` in the final listing, and the listed version
 * (id + updated_at) is the hashed one. Nothing is ever carried over from an older checksum file.
 */
export function buildChecksumLines(finalAssets: Asset[], hashed: Map<string, HashedAsset>): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const asset of finalAssets) {
    if (seen.has(asset.name)) continue;
    seen.add(asset.name);
    if (asset.state !== undefined && asset.state !== "uploaded") continue;
    const h = hashed.get(asset.name);
    if (!h || !sameVersion(h.asset, asset)) continue;
    lines.push(`${asset.name}\t${h.hash}`);
  }
  return lines;
}

/**
 * Upload only when it is safe: with fail-on-error any failed asset blocks the upload (the existing
 * checksum file stays untouched); otherwise the file is uploaded without the failed assets.
 * Assets that vanished or are not `uploaded` are not failures.
 */
export function shouldUpload(failedCount: number, failOnError: boolean): boolean {
  return !(failOnError && failedCount > 0);
}

export function serializeChecksums(lines: string[]): string {
  return lines.length ? lines.join("\n") + "\n" : "";
}

export type Replacement =
  | { kind: "gone" }
  | { kind: "replaced"; asset: Asset }
  | { kind: "unchanged" };

/** After a 404: find out what happened to `old` in a freshly listed release. */
export function resolveReplacement(old: Asset, current: Asset[]): Replacement {
  const found = current.find((a) => a.name === old.name);
  if (!found) return { kind: "gone" };
  if (found.state !== undefined && found.state !== "uploaded") return { kind: "gone" };
  const idChanged = found.id !== undefined && old.id !== undefined && found.id !== old.id;
  if (idChanged || isNewer(found.updatedAt, old.updatedAt)) {
    return { kind: "replaced", asset: found };
  }
  return { kind: "unchanged" };
}

/** Assets we hashed whose version in `current` differs from the hashed one. */
export function findStale(hashed: Map<string, Asset>, current: Asset[]): Asset[] {
  const stale: Asset[] = [];
  for (const asset of current) {
    const h = hashed.get(asset.name);
    if (!h) continue;
    if (!sameVersion(h, asset)) stale.push(asset);
  }
  return stale;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/** Retry `fn` with exponential backoff on "retry" errors; other errors are thrown immediately. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 2000;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (classifyError(err) !== "retry" || attempt >= attempts) throw err;
      const delay = base * 2 ** (attempt - 1);
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}

export type AssetOutcome =
  | { kind: "hashed"; asset: Asset; hash: string; replaced: boolean }
  | { kind: "gone" }
  | { kind: "failed"; error: unknown };

export interface ProcessDeps {
  hash: (asset: Asset) => Promise<string>;
  listAssets: () => Promise<Asset[]>;
  retry?: RetryOptions;
  log?: (msg: string) => void;
}

const MAX_REPLACEMENTS = 3;

/** Hash one asset with retries; on 404 re-list and follow a replacement. Never throws. */
export async function processAsset(
  initial: Asset,
  deps: ProcessDeps
): Promise<AssetOutcome> {
  const log = deps.log ?? (() => {});
  let asset = initial;
  let replaced = false;
  for (let round = 0; round <= MAX_REPLACEMENTS; round++) {
    try {
      const hash = await withRetry(() => deps.hash(asset), deps.retry);
      return { kind: "hashed", asset, hash, replaced };
    } catch (error) {
      if (classifyError(error) !== "gone") return { kind: "failed", error };
      let current: Asset[];
      try {
        current = await withRetry(deps.listAssets, deps.retry);
      } catch (listError) {
        return { kind: "failed", error: listError };
      }
      const res = resolveReplacement(asset, current);
      if (res.kind === "gone") return { kind: "gone" };
      if (res.kind === "unchanged") return { kind: "failed", error };
      log(`${asset.name} was replaced during the run, hashing the new version`);
      asset = res.asset;
      replaced = true;
    }
  }
  return { kind: "failed", error: new Error(`${initial.name} kept changing`) };
}
