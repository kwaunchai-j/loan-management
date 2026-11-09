"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Alert, Badge, Button, TextField } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { slipLimit } from "@/lib/limits";
import { profileSchema, type Profile } from "@/lib/schemas";
import { checkNationalId, checkRealName } from "@/lib/validation";

const ACCEPTED = ["image/jpeg", "image/png"];

type Errors = { fullName?: string; nationalId?: string; photo?: string };

/**
 * "ยืนยันตัวตน" (CR-8): the borrower states their real name as on the ID card, types the ID number and sends a photo of the
 * card. The name can be stated only once (afterwards only the lender changes it); the number and the photo can be corrected.
 * Only what changed is sent: the name and number in one PATCH /me/profile, then the photo to POST /me/id-card.
 */
export function IdentityForm({ current, onSaved, onSubmitting }: { current: Profile; onSaved: (text: string) => void | Promise<void>; onSubmitting: () => void }) {
  const [fullName, setFullName] = useState(current.fullName);
  const [nationalId, setNationalId] = useState(current.nationalId ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  function pick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setPreview(null);
    setFile(null);
    setErrors((x) => ({ ...x, photo: undefined }));
    if (!f) return;
    const problem = !ACCEPTED.includes(f.type) ? "รองรับเฉพาะไฟล์รูป JPEG หรือ PNG" : f.size > slipLimit().bytes ? `ไฟล์ใหญ่เกิน ${slipLimit().mb} MB` : null;
    if (problem) {
      setErrors((x) => ({ ...x, photo: problem }));
      if (input.current) input.current.value = "";
      return;
    }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setApiError(null);
    const found: Errors = {
      fullName: current.realNameConfirmed ? undefined : (checkRealName(fullName, current.username) ?? undefined),
      nationalId: checkNationalId(nationalId) ?? undefined,
      photo: errors.photo ?? (!file && !current.hasIdCard ? "กรุณาแนบรูปบัตรประชาชน" : undefined),
    };
    setErrors(found);
    if (found.fullName || found.nationalId || found.photo) return;

    // only what changed is sent; the name is sent whenever it is not confirmed yet (stating it is the confirmation)
    const send: { fullName?: string; nationalId?: string } = {};
    if (!current.realNameConfirmed) send.fullName = fullName.trim().replace(/\s+/g, " ");
    const digits = nationalId.trim().replace(/[\s-]/g, "");
    if (digits !== (current.nationalId ?? "")) send.nationalId = digits;
    if (Object.keys(send).length === 0 && !file) {
      setApiError("ไม่มีการเปลี่ยนแปลง");
      return;
    }
    setBusy(true);
    onSubmitting();
    try {
      if (Object.keys(send).length > 0) await apiFetch("/me/profile", { method: "PATCH", json: send, schema: profileSchema });
      if (file) await apiFetch("/me/id-card", { method: "POST", file, schema: profileSchema });
      await onSaved("บันทึกข้อมูลยืนยันตัวตนแล้ว");
    } catch (err) {
      setApiError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
      {apiError && <Alert kind="error">{apiError}</Alert>}
      {current.realNameConfirmed ? (
        <p className="text-sm text-slate-800">
          ชื่อ-นามสกุลจริง: <strong>{current.fullName}</strong> <Badge tone="green">ยืนยันแล้ว</Badge>
          <span className="mt-1 block text-slate-600">ถ้าชื่อไม่ถูกต้อง กรุณาแจ้งผู้ให้กู้ให้แก้ให้</span>
        </p>
      ) : (
        <TextField
          label="ชื่อ-นามสกุลจริง (ตามบัตรประชาชน)"
          autoComplete="name"
          value={fullName}
          error={errors.fullName}
          hint="ต้องเป็นชื่อจริงและนามสกุลจริง ไม่ใช้ชื่อเล่นหรือชื่อผู้ใช้ ยืนยันได้ครั้งเดียว หลังจากนั้นผู้ให้กู้เป็นผู้แก้ไขให้"
          onChange={(e) => setFullName(e.target.value)}
        />
      )}
      <TextField
        label="เลขบัตรประชาชน (13 หลัก)"
        inputMode="numeric"
        autoComplete="off"
        value={nationalId}
        error={errors.nationalId}
        hint="ตัวเลข 13 หลัก ใส่ขีดหรือไม่ใส่ก็ได้"
        onChange={(e) => setNationalId(e.target.value)}
      />
      <div className="space-y-2">
        <label className="block text-sm font-medium text-slate-800">
          รูปบัตรประชาชน (ภาพ JPEG หรือ PNG ไม่เกิน {slipLimit().mb} MB)
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png"
            onChange={pick}
            className="mt-1 block min-h-11 w-full text-base file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-teal-700 file:px-4 file:font-medium file:text-white"
          />
        </label>
        <p className="text-sm text-slate-600">
          {current.hasIdCard ? (
            <>
              <Badge tone="green">ส่งรูปแล้ว</Badge> เลือกไฟล์ใหม่ถ้าต้องการเปลี่ยนรูป รูปนี้เห็นได้เฉพาะผู้ให้กู้
            </>
          ) : (
            "ถ่ายให้เห็นชื่อและเลขบัตรชัดเจน รูปนี้เห็นได้เฉพาะผู้ให้กู้"
          )}
        </p>
        {errors.photo && (
          <p role="alert" className="text-sm font-medium text-red-700">
            {errors.photo}
          </p>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element -- a local blob preview, not a site image */}
        {preview && <img src={preview} alt="ตัวอย่างรูปบัตรที่เลือก" className="h-28 rounded border border-slate-200" />}
      </div>
      <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
        {busy ? "กำลังบันทึก..." : "บันทึกการยืนยันตัวตน"}
      </Button>
    </form>
  );
}
