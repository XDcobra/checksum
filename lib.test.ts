import { describe, expect, test } from "bun:test";
import {
  type Asset,
  HttpError,
  classifyError,
  decideFinal,
  findUnhashed,
  normalizeAsset,
  processAsset,
  resolveReplacement,
  serializeChecksums,
  sameVersion,
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

describe("decideFinal", () => {
  const H = (a: Asset, hash: string) => ({ asset: a, hash });
  const run = (
    listing: Asset[] | null,
    hashed: [string, { asset: Asset; hash: string }][],
    errors: [string, string][] = [],
    failOnError = true,
    allowDelete = true
  ) => decideFinal({ listing, hashed: new Map(hashed), errors: new Map(errors), failOnError, allowDelete });

  test("all uploaded assets hashed: upload, in the order of the final listing", () => {
    const a = A("a"), b = A("b");
    const d = run([b, a], [["a", H(a, "ha")], ["b", H(b, "hb")]]);
    expect(d.action).toBe("upload");
    expect(d.lines).toEqual(["b\thb", "a\tha"]);
    expect(d.failures.size).toBe(0);
  });

  test("an uploaded asset without a hash from this run is a failure (nothing is carried over)", () => {
    const d = run([A("a"), A("late")], [["a", H(A("a"), "ha")]]);
    expect(d.action).toBe("keep");
    expect([...d.failures.keys()]).toEqual(["late"]);
    expect(d.failures.get("late")).toContain("not hashed in this run");
  });

  test("an asset replaced after hashing (new id or newer updated_at) is a failure", () => {
    const d = run(
      [A("a", "2"), A("b", "1", "2026-03-01T00:00:00Z"), A("c")],
      [["a", H(A("a"), "ha")], ["b", H(A("b"), "hb")], ["c", H(A("c"), "hc")]]
    );
    expect(d.action).toBe("keep");
    expect([...d.failures.keys()]).toEqual(["a", "b"]);
    expect(d.failures.get("a")).toBe("changed after it was hashed");
    expect(d.lines).toEqual(["c\thc"]);
  });

  test("an asset replaced mid-run and hashed again gets the new hash", () => {
    const v2 = A("a", "2", "2026-03-01T00:00:00Z");
    const d = run([v2], [["a", H(v2, "new")]]);
    expect(d.action).toBe("upload");
    expect(d.lines).toEqual(["a\tnew"]);
  });

  test("the error of this run is reported for a listed asset", () => {
    const d = run([A("a"), A("bad")], [["a", H(A("a"), "ha")]], [["bad", "HTTP 500"]]);
    expect(d.failures.get("bad")).toBe("HTTP 500");
  });

  test("errors of assets that are no longer listed are dropped", () => {
    const d = run([A("a")], [["a", H(A("a"), "ha")]], [["deleted", "HTTP 404"]]);
    expect(d.action).toBe("upload");
    expect(d.failures.size).toBe(0);
  });

  test("assets not uploaded yet are skipped, not failures", () => {
    const d = run([A("a"), A("open", "1", undefined, "starter")], [["a", H(A("a"), "ha")]]);
    expect(d.action).toBe("upload");
    expect(d.notUploaded).toEqual(["open"]);
    expect(d.lines).toEqual(["a\tha"]);
  });

  test("fail-on-error false: upload without the failed assets", () => {
    const d = run([A("a"), A("bad")], [["a", H(A("a"), "ha")]], [["bad", "HTTP 500"]], false);
    expect(d.action).toBe("upload");
    expect(d.lines).toEqual(["a\tha"]);
    expect([...d.failures.keys()]).toEqual(["bad"]);
  });

  test("fail-on-error false and nothing hashed: keep, never replace or delete the old file", () => {
    expect(run([A("bad")], [], [["bad", "HTTP 500"]], false).action).toBe("keep");
  });

  test("no final listing: keep in either mode, errors are reported", () => {
    const d = run(null, [["a", H(A("a"), "ha")]], [["bad", "x"]]);
    expect(d.action).toBe("keep");
    expect(d.lines).toEqual([]);
    expect([...d.failures.keys()]).toEqual(["bad"]);
    expect(run(null, [], [], false).action).toBe("keep");
  });

  test("no in-scope asset left: delete the old file", () => {
    expect(run([], []).action).toBe("delete");
    expect(run([], [], [], false).action).toBe("delete");
  });

  test("no in-scope asset left but patterns are used: keep", () => {
    expect(run([], [], [], true, false).action).toBe("keep");
  });

  test("only assets still being uploaded: keep", () => {
    expect(run([A("open", "1", undefined, "starter")], []).action).toBe("keep");
  });

  test("duplicates are written once; empty result serializes to empty text", () => {
    expect(run([A("a"), A("a")], [["a", H(A("a"), "ha")]]).lines).toEqual(["a\tha"]);
    expect(serializeChecksums([])).toBe("");
    expect(serializeChecksums(["a\t1", "b\t2"])).toBe("a\t1\nb\t2\n");
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

describe("findUnhashed", () => {
  test("uploaded assets without a hash of their listed version; not-uploaded ones are ignored", () => {
    const H = (a: Asset) => ({ asset: a, hash: "h" });
    const hashed = new Map([["a", H(A("a"))], ["b", H(A("b"))], ["c", H(A("c"))]]);
    const listing = [A("a", "9"), A("b"), A("c", "1", "2027-01-01T00:00:00Z"), A("d"), A("e", "1", undefined, "open")];
    expect(findUnhashed(listing, hashed).map((a) => a.name)).toEqual(["a", "c", "d"]);
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
