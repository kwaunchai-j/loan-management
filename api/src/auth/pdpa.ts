import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db.js";
import { asyncHandler, sendError } from "../http.js";
import type { AuthMiddleware } from "./middleware.js";

/**
 * Version label of the PDPA terms a borrower accepts (stored in Borrower.pdpaVersion).
 * The wording of the terms is shown by the web app; bump this only when the wording changes.
 * Access is gated on `pdpaAcceptedAt` (DES-002); a version bump does not force re-acceptance.
 */
export const PDPA_VERSION = "2";

const acceptBody = z.object({ version: z.string().min(1).max(32) });

export function createPdpaRouter(deps: { prisma: Db; auth: AuthMiddleware }): Router {
  const router = Router();

  async function status(borrowerId: string) {
    const b = await deps.prisma.borrower.findUniqueOrThrow({
      where: { id: borrowerId },
      select: { pdpaAcceptedAt: true, pdpaVersion: true },
    });
    return {
      currentVersion: PDPA_VERSION,
      accepted: b.pdpaAcceptedAt !== null,
      acceptedAt: b.pdpaAcceptedAt,
      acceptedVersion: b.pdpaVersion,
    };
  }

  router.get(
    "/",
    deps.auth.authorizeBorrowerForPdpa,
    asyncHandler(async (req, res) => {
      res.status(200).json(await status(req.user!.borrowerId!));
    }),
  );

  router.post(
    "/accept",
    deps.auth.authorizeBorrowerForPdpa,
    asyncHandler(async (req, res) => {
      const body = acceptBody.safeParse(req.body);
      if (!body.success) {
        return sendError(res, 400, "VALIDATION_ERROR", "กรุณาระบุเวอร์ชันของเงื่อนไขที่ยอมรับ");
      }
      if (body.data.version !== PDPA_VERSION) {
        return sendError(
          res,
          400,
          "PDPA_VERSION_MISMATCH",
          "เงื่อนไขมีการเปลี่ยนแปลง กรุณาโหลดหน้าใหม่แล้วอ่านเงื่อนไขล่าสุด",
        );
      }
      const borrowerId = req.user!.borrowerId!;
      // Only the first acceptance writes, so the recorded time is never overwritten (and is race-safe).
      await deps.prisma.borrower.updateMany({
        where: { id: borrowerId, pdpaAcceptedAt: null },
        data: { pdpaAcceptedAt: new Date(), pdpaVersion: PDPA_VERSION },
      });
      res.status(200).json(await status(borrowerId));
    }),
  );

  return router;
}
