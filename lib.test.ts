import { describe, expect, test } from "bun:test";
import {
  type Asset,
  HttpError,
  classifyError,
  findStale,
  mergeChecksums,
  normalizeAsset,
  parseChecksumFile,
  processAsset,
  resolveReplacement,
  serializeChecksums,
  withRetry,
} from "./lib";

const A = (name: string, id = "1", updatedAt = "2026-01-01T00:00:00Z", state = "uploaded"): Asset => ({
  name,
  id,
  updatedAt,
  state,
  size: 1,
});
const noSleep = async () => {};

describe("parseChecksumFile", () => {
  test("parses tab separated lines, skips blanks and malformed lines, keeps order", () => {
    const m = parseChecksumFile("b\t22\n\na\t11\r\nbroken line\n\t99\nc\t\n");
    expect([...m]).toEqual([
      ["b", "22"],
      ["a", "11"],
    ]);
  });
  test("empty text", () => {
    expect(parseChecksumFile("").size).toBe(0);
  });
});

describe("normalizeAsset", () => {
  test("maps REST snake_case and numeric ids", () => {
    const a = normalizeAsset({ id: 5, name: "x", size: 1, updated_at: "t", state: "uploaded" });
    expect(a.id).toBe("5");
    expect(a.updatedAt).toBe("t");
  });
  test("keeps gh cli shape", () => {
    expect(normalizeAsset({ id: "RA_x", name: "x", size: 1, updatedAt: "t" }).updatedAt).toBe("t");
  });
});

describe("mergeChecksums", () => {
  const existing = new Map([
    ["a", "old-a"],
    ["b", "old-b"],
    ["gone", "old-gone"],
  ]);
  const base = "2026-02-01T00:00:00Z";

  test("fresh replaces old, old kept for untouched assets, removed assets dropped, release order", () => {
    const assets = [A("c"), A("b"), A("a")];
    const lines = mergeChecksums({
      assets,
      existing,
      fresh: new Map([["a", "new-a"], ["c", "new-c"]]),
      existingUpdatedAt: base,
    });
    expect(lines).toEqual(["c\tnew-c", "b\told-b", "a\tnew-a"]);
  });

  test("asset newer than the checksum file and not re-hashed loses its old entry", () => {
    const assets = [A("a", "1", "2026-03-01T00:00:00Z"), A("b")];
    const lines = mergeChecksums({ assets, existing, fresh: new Map(), existingUpdatedAt: base });
    expect(lines).toEqual(["b\told-b"]);
  });

  test("newer asset that was re-hashed gets the fresh entry", () => {
    const assets = [A("a", "2", "2026-03-01T00:00:00Z")];
    const lines = mergeChecksums({
      assets,
      existing,
      fresh: new Map([["a", "new"]]),
      existingUpdatedAt: base,
    });
    expect(lines).toEqual(["a\tnew"]);
  });

  test("entries with a different hash length (other algorithm) are not reused", () => {
    const lines = mergeChecksums({
      assets: [A("a"), A("b")],
      existing: new Map([["a", "abcd"], ["b", "ab"]]),
      fresh: new Map(),
      expectedHashLength: 4,
    });
    expect(lines).toEqual(["a\tabcd"]);
  });

  test("duplicates are written once; empty result serializes to empty text", () => {
    expect(mergeChecksums({ assets: [A("a"), A("a")], existing, fresh: new Map(), existingUpdatedAt: base })).toEqual(["a\told-a"]);
    expect(serializeChecksums([])).toBe("");
    expect(serializeChecksums(["a\t1", "b\t2"])).toBe("a\t1\nb\t2\n");
  });
});

describe("classifyError", () => {
  test("404 gone, 5xx/429/network retry, other 4xx fatal", () => {
    expect(classifyError(new HttpError(404, ""))).toBe("gone");
    expect(classifyError(new HttpError(500, ""))).toBe("retry");
    expect(classifyError(new HttpError(503, ""))).toBe("retry");
    expect(classifyError(new HttpError(429, ""))).toBe("retry");
    expect(classifyError(new HttpError(403, ""))).toBe("fatal");
    expect(classifyError(new TypeError("fetch failed"))).toBe("retry");
  });
});

describe("withRetry", () => {
  test("retries with exponential backoff then succeeds", async () => {
    const delays: number[] = [];
    let n = 0;
    const r = await withRetry(
      async () => {
        if (++n < 3) throw new HttpError(502, "bad gateway");
        return "ok";
      },
      { baseDelayMs: 10, sleep: async (ms) => void delays.push(ms) }
    );
    expect(r).toBe("ok");
    expect(delays).toEqual([10, 20]);
  });
  test("gives up after 3 attempts", async () => {
    let n = 0;
    await expect(
      withRetry(async () => { n++; throw new HttpError(500, "x"); }, { sleep: noSleep })
    ).rejects.toThrow("x");
    expect(n).toBe(3);
  });
  test("does not retry 404 or fatal errors", async () => {
    for (const status of [404, 403]) {
      let n = 0;
      await expect(
        withRetry(async () => { n++; throw new HttpError(status, "x"); }, { sleep: noSleep })
      ).rejects.toThrow();
      expect(n).toBe(1);
    }
  });
});

describe("resolveReplacement", () => {
  const old = A("x", "1", "2026-01-01T00:00:00Z");
  test("missing -> gone", () => expect(resolveReplacement(old, [A("y")])).toEqual({ kind: "gone" }));
  test("different id -> replaced", () => {
    const n = A("x", "2");
    expect(resolveReplacement(old, [n])).toEqual({ kind: "replaced", asset: n });
  });
  test("same id but newer updated_at -> replaced", () => {
    const n = A("x", "1", "2026-01-02T00:00:00Z");
    expect(resolveReplacement(old, [n]).kind).toBe("replaced");
  });
  test("same version -> unchanged", () => expect(resolveReplacement(old, [A("x")]).kind).toBe("unchanged"));
  test("replacement still uploading -> gone", () =>
    expect(resolveReplacement(old, [A("x", "2", undefined, "open")]).kind).toBe("gone"));
});

describe("findStale", () => {
  test("detects changed id or newer updated_at only for hashed assets", () => {
    const hashed = new Map([["a", A("a")], ["b", A("b")], ["c", A("c")]]);
    const current = [A("a", "9"), A("b"), A("c", "1", "2027-01-01T00:00:00Z"), A("d")];
    expect(findStale(hashed, current).map((a) => a.name)).toEqual(["a", "c"]);
  });
});

describe("processAsset", () => {
  const retry = { sleep: noSleep };
  test("hashes on success", async () => {
    const r = await processAsset(A("x"), { hash: async () => "h", listAssets: async () => [], retry });
    expect(r).toMatchObject({ kind: "hashed", hash: "h", replaced: false });
  });
  test("404 then replacement exists: hashes the new version", async () => {
    const newer = A("x", "2");
    const r = await processAsset(A("x"), {
      hash: async (a) => {
        if (a.id === "1") throw new HttpError(404, "nf");
        return "new-hash";
      },
      listAssets: async () => [newer],
      retry,
    });
    expect(r).toMatchObject({ kind: "hashed", hash: "new-hash", replaced: true });
  });
  test("404 and asset deleted: gone, not an error", async () => {
    const r = await processAsset(A("x"), {
      hash: async () => { throw new HttpError(404, "nf"); },
      listAssets: async () => [],
      retry,
    });
    expect(r.kind).toBe("gone");
  });
  test("5xx persists after retries: failed, no re-list", async () => {
    let lists = 0;
    let hashes = 0;
    const r = await processAsset(A("x"), {
      hash: async () => { hashes++; throw new HttpError(503, "down"); },
      listAssets: async () => { lists++; return []; },
      retry,
    });
    expect(r.kind).toBe("failed");
    expect(hashes).toBe(3);
    expect(lists).toBe(0);
  });
  test("404 with unchanged listing: failed", async () => {
    const r = await processAsset(A("x"), {
      hash: async () => { throw new HttpError(404, "nf"); },
      listAssets: async () => [A("x")],
      retry,
    });
    expect(r.kind).toBe("failed");
  });
});
