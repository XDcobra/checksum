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

export function isUploaded(asset: Asset): boolean {
  return asset.state === undefined || asset.state === "uploaded";
}

/** Uploaded assets of `listing` without a hash of their listed version (id + updated_at) from this run. */
export function findUnhashed(listing: Asset[], hashed: Map<string, HashedAsset>): Asset[] {
  return listing.filter((asset) => {
    if (!isUploaded(asset)) return false;
    const h = hashed.get(asset.name);
    return !h || !sameVersion(h.asset, asset);
  });
}

/**
 * What to do with the checksum file on the release:
 * - `upload`: replace it with `lines`;
 * - `delete`: the final listing has no in-scope assets left, so the old file describes nothing that exists;
 * - `keep`: leave the file on the release untouched.
 */
export type FinalAction = "upload" | "delete" | "keep";

export interface FinalDecision {
  /** Lines of the checksum file, in the order of the final listing. */
  lines: string[];
  /** Uploaded assets of the final listing without a hash of their listed version from this run. */
  failures: Map<string, string>;
  /** In-scope assets of the final listing that are not `uploaded` yet. */
  notUploaded: string[];
  action: FinalAction;
}

/**
 * Decide the end of the run from the final listing alone (in-scope assets only; `null` when the
 * release could not be listed). Every uploaded asset in it must have a hash of the listed version
 * computed in this run, otherwise it is a failure. Errors of assets that are no longer listed are
 * dropped. Nothing is ever carried over from an older checksum file.
 *
 * With `failOnError` any failure keeps the old file. Without it the file is uploaded without the
 * failed assets, unless no asset could be hashed at all. The file is deleted only when the final
 * listing succeeded, nothing failed, no in-scope asset is listed any more and `allowDelete` is set
 * (the caller passes false when patterns are used, so a pattern that matches nothing keeps the file).
 */
export function decideFinal(input: {
  listing: Asset[] | null;
  hashed: Map<string, HashedAsset>;
  errors: Map<string, string>;
  failOnError: boolean;
  allowDelete: boolean;
}): FinalDecision {
  const { listing, hashed, errors, failOnError, allowDelete } = input;
  if (listing === null) {
    return { lines: [], failures: new Map(errors), notUploaded: [], action: "keep" };
  }
  const lines: string[] = [];
  const failures = new Map<string, string>();
  const notUploaded: string[] = [];
  const seen = new Set<string>();
  for (const asset of listing) {
    if (seen.has(asset.name)) continue;
    seen.add(asset.name);
    if (!isUploaded(asset)) {
      notUploaded.push(asset.name);
      continue;
    }
    const h = hashed.get(asset.name);
    if (h && sameVersion(h.asset, asset)) {
      lines.push(`${asset.name}\t${h.hash}`);
      continue;
    }
    failures.set(
      asset.name,
      errors.get(asset.name) ??
        (h ? "changed after it was hashed" : "not hashed in this run (added or replaced at the end of the run)")
    );
  }
  let action: FinalAction;
  if (failures.size > 0 && failOnError) action = "keep";
  else if (lines.length > 0) action = "upload";
  else if (failures.size > 0 || notUploaded.length > 0 || !allowDelete) action = "keep";
  else action = "delete";
  return { lines, failures, notUploaded, action };
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
