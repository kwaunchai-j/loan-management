import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isValidImportKey, LocalDiskImportStorage, newImportKey } from "../src/imports/storage.js";

describe("import staging storage", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "import-unit-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const storage = new LocalDiskImportStorage(path.join(dir, "nested", "imports"));

  it("accepts only keys it generates", () => {
    expect(isValidImportKey(newImportKey("csv"))).toBe(true);
    expect(isValidImportKey(newImportKey("xlsx"))).toBe(true);
    for (const bad of ["", "../x.csv", "..\\x.xlsx", `${"a".repeat(32)}.xls`, `${"A".repeat(32)}.csv`, `${"a".repeat(31)}.csv`, `${"a".repeat(32)}.csv.exe`, `${"a".repeat(32)}.csv\n`, "a/b.csv"]) {
      expect(isValidImportKey(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("stores, returns and deletes a file, creating the folder on demand", async () => {
    const key = newImportKey("csv");
    const data = Buffer.from("ชื่อผู้ยืม,จำนวนเงิน\r\n");
    await storage.put(key, data);
    const got = await storage.get(key);
    expect(got!.data.equals(data)).toBe(true);
    expect(Math.abs(Date.now() - got!.createdAt.getTime())).toBeLessThan(60_000);
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
    await storage.delete(key); // deleting twice is fine
  });

  it("never overwrites, and never touches the disk for an invalid key", async () => {
    const key = newImportKey("xlsx");
    await storage.put(key, Buffer.from("a"));
    await expect(storage.put(key, Buffer.from("b"))).rejects.toThrow();
    for (const bad of ["../../etc/passwd", "..\\..\\win.ini", "plain"]) {
      expect(await storage.get(bad)).toBeNull();
      await expect(storage.put(bad, Buffer.from("x"))).rejects.toThrow("invalid import key");
      await storage.delete(bad); // a no-op, not an error
    }
  });

  it("purges only old files that it created itself", async () => {
    const old = newImportKey("csv");
    const fresh = newImportKey("csv");
    await storage.put(old, Buffer.from("old"));
    await storage.put(fresh, Buffer.from("fresh"));
    const root = path.join(dir, "nested", "imports");
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(path.join(root, old), twoDaysAgo, twoDaysAgo);
    const stranger = path.join(root, "notes.txt"); // not ours: must survive
    writeFileSync(stranger, "keep me");
    utimesSync(stranger, twoDaysAgo, twoDaysAgo);

    expect(await storage.purgeOlderThan(86_400_000)).toBe(1);
    expect(await storage.get(old)).toBeNull();
    expect(await storage.get(fresh)).not.toBeNull();
    expect(await new LocalDiskImportStorage(path.join(dir, "missing")).purgeOlderThan(1)).toBe(0); // no folder yet
    expect((await import("node:fs")).existsSync(stranger)).toBe(true);
  });
});
