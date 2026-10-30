import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where an uploaded import file waits between "preview" and "confirm" (T-601/T-602). The Data Model
 * has no table for it, so the file itself is kept, under a random key only an ADMIN receives, and
 * deleted as soon as the import is confirmed. Files nobody confirmed are purged after a day.
 * The key (not the client) decides the name and extension; the folder is a deployment choice (env).
 */
export interface StagedFile {
  data: Buffer;
  /** When the file was staged (used to expire it). */
  createdAt: Date;
}

export interface ImportStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<StagedFile | null>;
  delete(key: string): Promise<void>;
  /** Removes staged files older than `maxAgeMs`; returns how many. */
  purgeOlderThan(maxAgeMs: number): Promise<number>;
}

export const STAGED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[a-f0-9]{32}\.(csv|xlsx)$/;

export const isValidImportKey = (key: string) => KEY_PATTERN.test(key);
export const newImportKey = (ext: "csv" | "xlsx") => `${randomBytes(16).toString("hex")}.${ext}`;

export class LocalDiskImportStorage implements ImportStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private pathOf(key: string): string {
    if (!isValidImportKey(key)) throw new Error("invalid import key");
    return path.join(this.root, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.pathOf(key);
    await mkdir(this.root, { recursive: true });
    await writeFile(file, data, { flag: "wx", mode: 0o600 });
  }

  async get(key: string): Promise<StagedFile | null> {
    if (!isValidImportKey(key)) return null;
    try {
      const file = this.pathOf(key);
      const [data, info] = await Promise.all([readFile(file), stat(file)]);
      return { data, createdAt: info.mtime };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    if (!isValidImportKey(key)) return;
    await rm(this.pathOf(key), { force: true });
  }

  async purgeOlderThan(maxAgeMs: number): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
    let removed = 0;
    for (const name of names) {
      if (!isValidImportKey(name)) continue; // never touch anything we did not create
      const file = path.join(this.root, name);
      try {
        if (Date.now() - (await stat(file)).mtimeMs > maxAgeMs) {
          await rm(file, { force: true });
          removed++;
        }
      } catch {
        /* a file that disappears meanwhile is fine */
      }
    }
    return removed;
  }
}
