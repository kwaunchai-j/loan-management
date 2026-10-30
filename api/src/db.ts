import { PrismaClient } from "@prisma/client";

export type Db = PrismaClient;

export function createPrisma(): Db {
  return new PrismaClient();
}
