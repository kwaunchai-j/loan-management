import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob", () => {
  class BlobNotFoundError extends Error {}
  return { BlobNotFoundError, put: vi.fn(), get: vi.fn(), head: vi.fn(), del: vi.fn(), list: vi.fn() };
});

import * as sdk from "@vercel/blob";
import { BlobImportStorage, BlobSlipStorage, vercelBlobClient, type BlobClient } from "../src/lib/blob-storage.js";
import { newImportKey } from "../src/imports/storage.js";
import { newSlipKey } from "../src/lib/slip-storage.js";

// ---------------------------------------------------------------------------------------------
// a stand-in store with the same rules as the real one: a second put to a path fails
// ---------------------------------------------------------------------------------------------
class FakeStore implements BlobClient {
  files = new Map<string, { data: Buffer; uploadedAt: Date; contentType: string }>();
  async put(pathname: string, body: Buffer, o: { contentType: string }) {
    if (this.files.has(pathname)) throw new Error("This blob already exists");
    this.files.set(pathname, { data: Buffer.from(body), uploadedAt: new Date(), contentType: o.contentType });
  }
  async get(pathname: string) {
    const f = this.files.get(pathname);
    return f ? { data: f.data, uploadedAt: f.uploadedAt } : null;
  }
  async exists(pathname: string) {
    return this.files.has(pathname);
  }
  async remove(pathname: string) {
    this.files.delete(pathname);
  }
  async list(prefix: string) {
    return [...this.files].filter(([p]) => p.startsWith(prefix)).map(([pathname, f]) => ({ pathname, uploadedAt: f.uploadedAt }));
  }
}

const jpegKey = () => newSlipKey({ ext: "jpg", mime: "image/jpeg" });
const pngKey = () => newSlipKey({ ext: "png", mime: "image/png" });

describe("BlobSlipStorage", () => {
  it("keeps a slip under slips/<key> with the right content type, and gives the same bytes back", async () => {
    const store = new FakeStore();
    const s = new BlobSlipStorage(store);
    const jk = jpegKey();
    const pk = pngKey();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await s.put(jk, bytes);
    await s.put(pk, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(store.files.get(`slips/${jk}`)!.contentType).toBe("image/jpeg");
    expect(store.files.get(`slips/${pk}`)!.contentType).toBe("image/png");
    expect((await s.get(jk))!.equals(bytes)).toBe(true);
    expect(await s.exists(jk)).toBe(true);
  });

  it("answers null / false for a slip that is not there, and removing twice is fine", async () => {
    const s = new BlobSlipStorage(new FakeStore());
    const k = jpegKey();
    expect(await s.get(k)).toBeNull();
    expect(await s.exists(k)).toBe(false);
    await s.put(k, Buffer.from("x"));
    await s.remove(k);
    await s.remove(k);
    expect(await s.exists(k)).toBe(false);
  });

  it("never overwrites an existing slip", async () => {
    const s = new BlobSlipStorage(new FakeStore());
    const k = jpegKey();
    await s.put(k, Buffer.from("first"));
    await expect(s.put(k, Buffer.from("second"))).rejects.toThrow();
    expect((await s.get(k))!.toString()).toBe("first");
  });

  it.each(["", "../x.jpg", "a/b.jpg", `${"a".repeat(32)}.gif`, `${"A".repeat(32)}.jpg`, `${"a".repeat(31)}.jpg`, "slips/../../x", `${"a".repeat(32)}.jpg\n`])(
    "never asks the store about the key %j",
    async (bad) => {
      const store = new FakeStore();
      const spies = ["put", "get", "exists", "remove"] as const;
      for (const m of spies) vi.spyOn(store, m);
      const s = new BlobSlipStorage(store);
      await expect(s.put(bad, Buffer.from("x"))).rejects.toThrow("invalid slip key");
      expect(await s.get(bad)).toBeNull();
      expect(await s.exists(bad)).toBe(false);
      await s.remove(bad);
      for (const m of spies) expect(store[m]).not.toHaveBeenCalled();
    },
  );
});

describe("BlobImportStorage", () => {
  it("stores under imports/<key>, with the right content type, and returns bytes and the upload time", async () => {
    const store = new FakeStore();
    const s = new BlobImportStorage(store);
    const csv = newImportKey("csv");
    const xlsx = newImportKey("xlsx");
    await s.put(csv, Buffer.from("ชื่อ,จำนวน\r\n"));
    await s.put(xlsx, Buffer.from("PK"));
    expect(store.files.get(`imports/${csv}`)!.contentType).toBe("text/csv");
    expect(store.files.get(`imports/${xlsx}`)!.contentType).toContain("spreadsheetml");
    const got = await s.get(csv);
    expect(got!.data.toString()).toBe("ชื่อ,จำนวน\r\n");
    expect(Math.abs(Date.now() - got!.createdAt.getTime())).toBeLessThan(60_000);
  });

  it("deletes a file, never overwrites, and answers null for a missing or invalid key", async () => {
    const s = new BlobImportStorage(new FakeStore());
    const k = newImportKey("csv");
    await s.put(k, Buffer.from("a"));
    await expect(s.put(k, Buffer.from("b"))).rejects.toThrow();
    await s.delete(k);
    await s.delete(k);
    expect(await s.get(k)).toBeNull();
    for (const bad of ["../../etc/passwd", "plain", `${"a".repeat(32)}.xls`]) {
      expect(await s.get(bad)).toBeNull();
      await expect(s.put(bad, Buffer.from("x"))).rejects.toThrow("invalid import key");
      await s.delete(bad);
    }
  });

  it("purges only our own files that are older than the limit, and says how many", async () => {
    const store = new FakeStore();
    const s = new BlobImportStorage(store);
    const old = newImportKey("csv");
    const fresh = newImportKey("csv");
    await s.put(old, Buffer.from("old"));
    await s.put(fresh, Buffer.from("fresh"));
    store.files.get(`imports/${old}`)!.uploadedAt = new Date(Date.now() - 2 * 86_400_000);
    // something we did not create, however old, is left alone
    store.files.set("imports/notes.txt", { data: Buffer.from("x"), uploadedAt: new Date(0), contentType: "text/plain" });
    store.files.set(`slips/${jpegKey()}`, { data: Buffer.from("x"), uploadedAt: new Date(0), contentType: "image/jpeg" });
    expect(await s.purgeOlderThan(86_400_000)).toBe(1);
    expect(await s.get(old)).toBeNull();
    expect(await s.get(fresh)).not.toBeNull();
    expect(store.files.has("imports/notes.txt")).toBe(true);
    expect([...store.files.keys()].some((p) => p.startsWith("slips/"))).toBe(true);
    expect(await s.purgeOlderThan(86_400_000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe("vercelBlobClient (the real calls, with the SDK replaced)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("put: private store, no suffix, no overwrite, with the content type", async () => {
    await vercelBlobClient.put("slips/a.jpg", Buffer.from("x"), { contentType: "image/jpeg" });
    expect(sdk.put).toHaveBeenCalledWith("slips/a.jpg", Buffer.from("x"), { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "image/jpeg" });
  });

  it("get: reads from a private store bypassing the cache, and returns the bytes and upload time", async () => {
    const uploadedAt = new Date("2026-10-30T05:00:00Z");
    vi.mocked(sdk.get).mockResolvedValue({ statusCode: 200, stream: new Response("hello").body, blob: { uploadedAt } } as never);
    const r = await vercelBlobClient.get("slips/a.jpg");
    expect(sdk.get).toHaveBeenCalledWith("slips/a.jpg", { access: "private", useCache: false });
    expect(r!.data.toString()).toBe("hello");
    expect(r!.uploadedAt).toBe(uploadedAt);
  });

  it("get: null when the store has no such blob, or does not answer 200", async () => {
    vi.mocked(sdk.get).mockResolvedValueOnce(null as never);
    expect(await vercelBlobClient.get("slips/none.jpg")).toBeNull();
    vi.mocked(sdk.get).mockResolvedValueOnce({ statusCode: 304, stream: null, blob: {} } as never);
    expect(await vercelBlobClient.get("slips/none.jpg")).toBeNull();
  });

  it("exists: true when the blob has metadata, false for 'not found', and any other failure is not hidden", async () => {
    vi.mocked(sdk.head).mockResolvedValueOnce({} as never);
    expect(await vercelBlobClient.exists("slips/a.jpg")).toBe(true);
    vi.mocked(sdk.head).mockRejectedValueOnce(new sdk.BlobNotFoundError());
    expect(await vercelBlobClient.exists("slips/a.jpg")).toBe(false);
    vi.mocked(sdk.head).mockRejectedValueOnce(new Error("store suspended"));
    await expect(vercelBlobClient.exists("slips/a.jpg")).rejects.toThrow("store suspended");
  });

  it("remove deletes by pathname", async () => {
    await vercelBlobClient.remove("slips/a.jpg");
    expect(sdk.del).toHaveBeenCalledWith("slips/a.jpg");
  });

  it("list: follows the pages until there are no more", async () => {
    const d = new Date("2026-10-30T05:00:00Z");
    vi.mocked(sdk.list)
      .mockResolvedValueOnce({ blobs: [{ pathname: "imports/1.csv", uploadedAt: d }], hasMore: true, cursor: "c1" } as never)
      .mockResolvedValueOnce({ blobs: [{ pathname: "imports/2.csv", uploadedAt: d }], hasMore: false } as never);
    expect(await vercelBlobClient.list("imports/")).toEqual([
      { pathname: "imports/1.csv", uploadedAt: d },
      { pathname: "imports/2.csv", uploadedAt: d },
    ]);
    expect(sdk.list).toHaveBeenNthCalledWith(1, { prefix: "imports/", cursor: undefined, limit: 1000 });
    expect(sdk.list).toHaveBeenNthCalledWith(2, { prefix: "imports/", cursor: "c1", limit: 1000 });
  });
});
