import { tmpdir } from "node:os";
import path from "node:path";

export const TEST_SLIP_DIR = path.join(tmpdir(), "loan-management-test-slips");
export const TEST_IMPORT_DIR = path.join(tmpdir(), "loan-management-test-imports");
