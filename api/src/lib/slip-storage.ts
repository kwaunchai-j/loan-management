import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Transfer-slip storage (T-203). Slips are sensitive financial documents: only ADMIN can read
 * them, file names never come from the client, and the type is decided from the bytes, not from
 * the client's Content-Type or file name. The storage sits behind an interface so the folder (or,
 * later, an object store in Thailand) is a deployment choice made through env.
 */
export interface SlipStorage {
  /** Stores new bytes under `key`; never overwrites an existing slip. */
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  /** Deletes a slip that no record refers to (a failed save). Missing is not an error. */
  remove(key: string): Promise<void>;
}

export interface SlipType {
  ext: "jpg" | "png";
  mime: "image/jpeg" | "image/png";
}

/** 32 hex chars (128 random bits) plus an extension we chose. Anything else is not a slip key. */
const KEY_PATTERN = /^[a-f0-9]{32}\.(jpg|png)$/;

export function isValidSlipKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function slipTypeOfKey(key: string): SlipType | null {
  if (!isValidSlipKey(key)) return null;
  return key.endsWith(".png") ? { ext: "png", mime: "image/png" } : { ext: "jpg", mime: "image/jpeg" };
}

/** JPEG and PNG only, recognised by their magic bytes. */
export function detectSlipType(data: Buffer): SlipType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length >= png.length && png.every((b, i) => data[i] === b)) {
    return { ext: "png", mime: "image/png" };
  }
  return null;
}

export function newSlipKey(type: SlipType): string {
  return `${randomBytes(16).toString("hex")}.${type.ext}`;
}

export class LocalDiskSlipStorage implements SlipStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  /** The key is validated before it ever reaches the file system, so it cannot escape the folder. */
  private pathOf(key: string): string {
    if (!isValidSlipKey(key)) throw new Error("invalid slip key");
    return path.join(this.root, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.pathOf(key);
    await mkdir(this.root, { recursive: true });
    await writeFile(file, data, { flag: "wx", mode: 0o600 });
  }

  async get(key: string): Promise<Buffer | null> {
    if (!isValidSlipKey(key)) return null;
    try {
      return await readFile(this.pathOf(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    if (!isValidSlipKey(key)) return false;
    try {
      return (await stat(this.pathOf(key))).isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    if (!isValidSlipKey(key)) return;
    await rm(this.pathOf(key), { force: true });
  }
}
