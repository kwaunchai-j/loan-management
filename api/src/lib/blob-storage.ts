import { BlobNotFoundError, del, get, head, list, put } from "@vercel/blob";
import { isValidImportKey, type ImportStorage, type StagedFile } from "../imports/storage.js";
import { isValidSlipKey, slipTypeOfKey, type SlipStorage } from "./slip-storage.js";

/**
 * Slips and staged import files in a PRIVATE Vercel Blob store (for a deployment on Vercel, where the
 * function's disk is read-only and lost between calls). Same rules as the disk versions: only a key we
 * generated is ever used (validated before it reaches the store), nothing is ever overwritten, and the
 * files are readable only through the API (a private store has no public URL at all).
 * Credentials come from the environment (OIDC on Vercel, or BLOB_READ_WRITE_TOKEN elsewhere).
 */

/** The few Blob calls we use, so tests can supply a fake store. */
export interface BlobClient {
  put(pathname: string, body: Buffer, options: { contentType: string }): Promise<void>;
  /** The bytes and upload time, or null when there is no such blob. */
  get(pathname: string): Promise<{ data: Buffer; uploadedAt: Date } | null>;
  exists(pathname: string): Promise<boolean>;
  remove(pathname: string): Promise<void>;
  /** Every blob under a prefix (all pages). */
  list(prefix: string): Promise<Array<{ pathname: string; uploadedAt: Date }>>;
}

export const vercelBlobClient: BlobClient = {
  async put(pathname, body, { contentType }) {
    // never overwrite (a repeated key must fail, as the disk version's "wx" does) and never add a suffix
    await put(pathname, body, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType });
  },
  async get(pathname) {
    const r = await get(pathname, { access: "private", useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return { data: Buffer.from(await new Response(r.stream).arrayBuffer()), uploadedAt: r.blob.uploadedAt };
  },
  async exists(pathname) {
    try {
      await head(pathname);
      return true;
    } catch (err) {
      if (err instanceof BlobNotFoundError) return false;
      throw err;
    }
  },
  async remove(pathname) {
    await del(pathname); // deleting something that is not there is not an error
  },
  async list(prefix) {
    const out: Array<{ pathname: string; uploadedAt: Date }> = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      for (const b of page.blobs) out.push({ pathname: b.pathname, uploadedAt: b.uploadedAt });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  },
};

const SLIP_PREFIX = "slips/";
const IMPORT_PREFIX = "imports/";

export class BlobSlipStorage implements SlipStorage {
  constructor(private readonly client: BlobClient = vercelBlobClient) {}

  /** The key is validated first, so nothing but `slips/<32 hex>.jpg|png` is ever asked of the store. */
  private pathOf(key: string): string {
    if (!isValidSlipKey(key)) throw new Error("invalid slip key");
    return `${SLIP_PREFIX}${key}`;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const type = slipTypeOfKey(key);
    if (!type) throw new Error("invalid slip key");
    await this.client.put(this.pathOf(key), data, { contentType: type.mime });
  }

  async get(key: string): Promise<Buffer | null> {
    if (!isValidSlipKey(key)) return null;
    return (await this.client.get(this.pathOf(key)))?.data ?? null;
  }

  async exists(key: string): Promise<boolean> {
    if (!isValidSlipKey(key)) return false;
    return this.client.exists(this.pathOf(key));
  }

  async remove(key: string): Promise<void> {
    if (!isValidSlipKey(key)) return;
    await this.client.remove(this.pathOf(key));
  }
}

export class BlobImportStorage implements ImportStorage {
  constructor(private readonly client: BlobClient = vercelBlobClient) {}

  private pathOf(key: string): string {
    if (!isValidImportKey(key)) throw new Error("invalid import key");
    return `${IMPORT_PREFIX}${key}`;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.put(this.pathOf(key), data, {
      contentType: key.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv",
    });
  }

  async get(key: string): Promise<StagedFile | null> {
    if (!isValidImportKey(key)) return null;
    const found = await this.client.get(this.pathOf(key));
    return found ? { data: found.data, createdAt: found.uploadedAt } : null;
  }

  async delete(key: string): Promise<void> {
    if (!isValidImportKey(key)) return;
    await this.client.remove(this.pathOf(key));
  }

  async purgeOlderThan(maxAgeMs: number): Promise<number> {
    let removed = 0;
    for (const b of await this.client.list(IMPORT_PREFIX)) {
      const key = b.pathname.slice(IMPORT_PREFIX.length);
      if (!isValidImportKey(key)) continue; // never touch anything we did not create
      if (Date.now() - b.uploadedAt.getTime() > maxAgeMs) {
        await this.client.remove(b.pathname);
        removed++;
      }
    }
    return removed;
  }
}
