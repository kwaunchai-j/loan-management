import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPassword, passwordPolicyViolation } from "../lib/password.js";

/**
 * Creates the first ADMIN from environment variables (never hard-coded).
 *   ADMIN_USERNAME, ADMIN_PASSWORD  ->  npm run admin:create
 * Refuses to run if any ADMIN already exists. The account must change its password on first login.
 * Remove ADMIN_PASSWORD from the environment afterwards.
 */
async function main() {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error("Set ADMIN_USERNAME and ADMIN_PASSWORD in the environment first.");
  }
  if (username.length > 64) throw new Error("ADMIN_USERNAME must be at most 64 characters.");
  const violation = passwordPolicyViolation(password);
  if (violation) throw new Error(`ADMIN_PASSWORD rejected: ${violation}`);

  const prisma = new PrismaClient();
  try {
    if ((await prisma.user.count({ where: { role: "ADMIN" } })) > 0) {
      throw new Error("An ADMIN already exists; nothing was changed.");
    }
    await prisma.user.create({
      data: {
        username,
        passwordHash: await hashPassword(password),
        role: "ADMIN",
        mustChangePassword: true,
      },
    });
    console.log(`Created ADMIN "${username}". Change the password at first login.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "failed");
  process.exitCode = 1;
});
