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

export function parseChecksumFile(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const name = line.slice(0, tab);
    const hash = line.slice(tab + 1).trim();
    if (hash === "") continue;
    entries.set(name, hash);
  }
  return entries;
}

function isNewer(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta > tb;
}

export interface MergeInput {
  /** Current release assets that are in scope (patterns applied, checksum file excluded), in release order. */
  assets: Asset[];
  /** Entries of the checksum file that existed on the release at the start of the run. */
  existing: Map<string, string>;
  /** Hashes computed in this run. */
  fresh: Map<string, string>;
  /** updated_at of the existing checksum asset; old entries of newer assets are not trusted. */
  existingUpdatedAt?: string;
  /** If set, old entries whose hash length differs (other algorithm) are dropped. */
  expectedHashLength?: number;
}

/**
 * Merge rules, per asset of the current list (release order):
 *  - fresh hash computed in this run -> use it (replaces the old entry)
 *  - else old entry, if the asset was not modified after the existing checksum file -> keep it
 *  - else (modified after, or never listed) -> no entry
 * Entries for assets that are no longer in scope are dropped.
 */
export function mergeChecksums(input: MergeInput): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const asset of input.assets) {
    if (seen.has(asset.name)) continue;
    seen.add(asset.name);
    const fresh = input.fresh.get(asset.name);
    if (fresh !== undefined) {
      lines.push(`${asset.name}\t${fresh}`);
      continue;
    }
    const old = input.existing.get(asset.name);
    if (old === undefined) continue;
    if (input.expectedHashLength && old.length !== input.expectedHashLength) continue;
    if (isNewer(asset.updatedAt, input.existingUpdatedAt)) continue;
    lines.push(`${asset.name}\t${old}`);
  }
  return lines;
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
    const idChanged = h.id !== undefined && asset.id !== undefined && h.id !== asset.id;
    if (idChanged || isNewer(asset.updatedAt, h.updatedAt)) stale.push(asset);
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
