import { mkdirSync, rmSync } from "node:fs";
import { TEST_IMPORT_DIR, TEST_SLIP_DIR } from "./slip-dir.js";

/** Shared temp folders for files written by tests: emptied before the run and removed after it. */
const dirs = [TEST_SLIP_DIR, TEST_IMPORT_DIR];

export function setup() {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
  }
}

export function teardown() {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
