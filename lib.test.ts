import { describe, expect, test } from "bun:test";
import {
  type Asset,
  HttpError,
  classifyError,
  findStale,
  buildChecksumLines,
  normalizeAsset,
  processAsset,
  resolveReplacement,
  serializeChecksums,
  sameVersion,
  shouldUpload,
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

describe("buildChecksumLines", () => {
  const H = (a: Asset, hash: string) => ({ asset: a, hash });

  test("only hashes of this run, in the order of the final listing", () => {
    const a = A("a"), b = A("b"), c = A("c");
    const hashed = new Map([["a", H(a, "ha")], ["c", H(c, "hc")]]);
    expect(buildChecksumLines([c, b, a], hashed)).toEqual(["c\thc", "a\tha"]);
  });

  test("asset without a hash from this run gets no entry (nothing is carried over)", () => {
    expect(buildChecksumLines([A("a"), A("b")], new Map([["a", H(A("a"), "ha")]]))).toEqual(["a\tha"]);
  });

  test("asset replaced after hashing (new id or newer updated_at) gets no entry", () => {
    const hashed = new Map([["a", H(A("a"), "ha")], ["b", H(A("b"), "hb")], ["c", H(A("c"), "hc")]]);
    const final = [A("a", "2"), A("b", "1", "2026-03-01T00:00:00Z"), A("c")];
    expect(buildChecksumLines(final, hashed)).toEqual(["c\thc"]);
  });

  test("asset replaced mid-run and hashed again gets the new hash", () => {
    const v2 = A("a", "2", "2026-03-01T00:00:00Z");
    expect(buildChecksumLines([v2], new Map([["a", H(v2, "new")]]))).toEqual(["a\tnew"]);
  });

  test("failed or vanished assets (no hash) and assets not uploaded get no entry", () => {
    const hashed = new Map([["a", H(A("a"), "ha")], ["gone", H(A("gone"), "hg")], ["open", H(A("open"), "ho")]]);
    const final = [A("a"), A("failed"), A("open", "1", undefined, "open")];
    expect(buildChecksumLines(final, hashed)).toEqual(["a\tha"]);
  });

  test("duplicates are written once; empty result serializes to empty text", () => {
    expect(buildChecksumLines([A("a"), A("a")], new Map([["a", H(A("a"), "ha")]]))).toEqual(["a\tha"]);
    expect(serializeChecksums([])).toBe("");
    expect(serializeChecksums(["a\t1", "b\t2"])).toBe("a\t1\nb\t2\n");
  });
});

describe("shouldUpload", () => {
  test("fail-on-error and a failure: no upload", () => expect(shouldUpload(1, true)).toBe(false));
  test("all ok: upload", () => expect(shouldUpload(0, true)).toBe(true));
  test("vanished asset is no failure: upload without it", () => {
    const final = [A("a")]; // "gone" was hashed earlier or skipped, not in the final listing
    const lines = buildChecksumLines(final, new Map([["a", { asset: A("a"), hash: "ha" }]]));
    expect(shouldUpload(0, true)).toBe(true);
    expect(lines).toEqual(["a\tha"]);
  });
  test("fail-on-error false and a failure: upload without the failed asset", () => {
    const lines = buildChecksumLines([A("a"), A("bad")], new Map([["a", { asset: A("a"), hash: "ha" }]]));
    expect(shouldUpload(1, false)).toBe(true);
    expect(lines).toEqual(["a\tha"]);
  });
});

describe("sameVersion", () => {
  test("compares id and updated_at instants", () => {
    expect(sameVersion(A("a"), A("a"))).toBe(true);
    expect(sameVersion(A("a", "1", "2026-01-01T00:00:00Z"), A("a", "1", "2026-01-01T00:00:00.000Z"))).toBe(true);
    expect(sameVersion(A("a"), A("a", "2"))).toBe(false);
    expect(sameVersion(A("a"), A("a", "1", "2025-12-01T00:00:00Z"))).toBe(false);
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
