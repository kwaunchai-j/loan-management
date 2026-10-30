"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Alert } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { slipUploadSchema } from "@/lib/schemas";

/** Mirrors the API's limit (DEFAULT_SLIP_MAX_BYTES); the API checks again and its answer wins. */
export const SLIP_MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png"];

/**
 * Chooses a transfer-slip image and uploads it at once (POST /admin/slips), returning the key the
 * server made. The payout form needs that key: no slip, no payout (DES-011). Nothing but a JPEG or
 * PNG up to 5 MB is sent.
 */
export function SlipPicker({
  label = "สลิปการโอนเงิน (ภาพ JPEG หรือ PNG ไม่เกิน 5 MB)",
  error,
  onChange,
}: {
  label?: string;
  error?: string | null;
  /** The key of the uploaded slip, or null when none is chosen (or the upload failed). */
  onChange: (key: string | null) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "uploading" | "done">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    onChange(null);
    setState("idle");
    setProblem(null);
    setPreview(null);
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      setProblem("รองรับเฉพาะไฟล์รูป JPEG หรือ PNG");
      if (input.current) input.current.value = "";
      return;
    }
    if (file.size > SLIP_MAX_BYTES) {
      setProblem("ไฟล์ใหญ่เกิน 5 MB");
      if (input.current) input.current.value = "";
      return;
    }
    setState("uploading");
    try {
      const up = await apiFetch("/admin/slips", { method: "POST", file, schema: slipUploadSchema });
      setPreview(URL.createObjectURL(file));
      setState("done");
      onChange(up.slipFileKey);
    } catch (err) {
      setState("idle");
      setProblem(errorMessage(err));
      if (input.current) input.current.value = "";
    }
  }

  // the upload problem and the form's "attach a slip" can both apply: show each once
  const shown = [...new Set([problem, error].filter((m): m is string => !!m))];
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-slate-800">
        {label}
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png"
          onChange={(e) => void pick(e)}
          className="mt-1 block min-h-11 w-full text-base file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-teal-700 file:px-4 file:font-medium file:text-white"
        />
      </label>
      {state === "uploading" && <p role="status" className="text-sm text-slate-600">กำลังอัปโหลดสลิป...</p>}
      {state === "done" && (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local blob preview, not a site image */}
          {preview && <img src={preview} alt="ตัวอย่างสลิปที่เลือก" className="h-24 rounded border border-slate-200" />}
          <p role="status" className="text-sm font-medium text-emerald-800">✓ อัปโหลดสลิปแล้ว</p>
        </div>
      )}
      {shown.map((m) => (
        <Alert key={m} kind="error">
          {m}
        </Alert>
      ))}
    </div>
  );
}
