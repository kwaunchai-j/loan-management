"use client";

import Link from "next/link";
import { use, useState } from "react";
import { BorrowerForm } from "@/components/BorrowerForm";
import { Alert, Badge, Button, Card, PageTitle, PasswordField, Spinner } from "@/components/ui";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { borrowerSchema, type Borrower } from "@/lib/schemas";
import { useApi } from "@/lib/use-api";
import { checkPassword, generatePassword, maskAccount } from "@/lib/validation";

export default function BorrowerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const borrower = useApi(`/admin/borrowers/${encodeURIComponent(id)}`, borrowerSchema);
  return (
    <>
      <Link href="/admin/borrowers" className="text-sm font-medium text-teal-800 hover:underline">
        ← กลับไปรายชื่อ
      </Link>
      {borrower.loading && <Spinner />}
      {borrower.error && <Alert kind="error">{borrower.error}</Alert>}
      {borrower.data && <Detail b={borrower.data} onChanged={borrower.reload} />}
    </>
  );
}

function Detail({ b, onChanged }: { b: Borrower; onChanged: () => void }) {
  const [showAccount, setShowAccount] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>{b.fullName}</PageTitle>
        {b.account === null ? (
          <Badge tone="gray">ยังไม่มีบัญชี (นำเข้า)</Badge>
        ) : b.account.isActive ? (
          <Badge tone="green">ใช้งานอยู่</Badge>
        ) : (
          <Badge tone="red">ปิดใช้งาน</Badge>
        )}
      </div>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

      <Card title="ข้อมูลผู้ยืม">
        <dl className="grid gap-3 sm:grid-cols-2">
          <Item label="เบอร์โทรศัพท์" value={b.phone ?? "-"} />
          <Item label="ธนาคาร" value={b.bankName ?? "-"} />
          <div>
            <dt className="text-sm text-slate-600">เลขบัญชี (เห็นเฉพาะผู้ดูแล)</dt>
            <dd className="flex items-center gap-2 font-mono text-base">
              {b.bankAccountNo === null ? "-" : showAccount ? b.bankAccountNo : maskAccount(b.bankAccountNo)}
              {b.bankAccountNo !== null && (
                <button
                  type="button"
                  aria-pressed={showAccount}
                  onClick={() => setShowAccount((s) => !s)}
                  className="min-h-9 rounded px-2 font-sans text-sm font-medium text-teal-800 hover:bg-teal-50"
                >
                  {showAccount ? "ซ่อน" : "แสดง"}
                </button>
              )}
            </dd>
          </div>
          <Item label="ชื่อผู้ใช้" value={b.account?.username ?? "-"} />
          <Item
            label="เงื่อนไขข้อมูลส่วนบุคคล (PDPA)"
            value={b.pdpaAcceptedAt ? `ยอมรับเมื่อ ${formatDateTime(b.pdpaAcceptedAt)} (เวอร์ชัน ${b.pdpaVersion ?? "-"})` : "ยังไม่ยอมรับ"}
          />
          <Item label="สร้างเมื่อ" value={formatDateTime(b.createdAt)} />
        </dl>
      </Card>

      <Card title="แก้ไขข้อมูล">
        <p className="mb-3 text-sm text-slate-600">กรอกเฉพาะช่องที่ต้องการเปลี่ยน ระบบจะบันทึกเฉพาะส่วนที่แก้</p>
        <BorrowerForm
          key={`${b.fullName}|${b.phone}|${b.bankName}|${b.bankAccountNo}`}
          initial={{ fullName: b.fullName, phone: b.phone ?? "", bankName: b.bankName ?? "", bankAccountNo: b.bankAccountNo ?? "" }}
          required={false}
          submitLabel="บันทึกการแก้ไข"
          onSubmit={async (values) => {
            await apiFetch(`/admin/borrowers/${encodeURIComponent(b.id)}`, { method: "PATCH", json: values, schema: borrowerSchema });
            setNotice({ kind: "success", text: "บันทึกข้อมูลเรียบร้อยแล้ว" });
            onChanged();
          }}
        />
      </Card>

      {b.account === null ? (
        <Alert kind="info">ผู้ยืมรายนี้ถูกนำเข้าจากไฟล์ และยังไม่มีบัญชีเข้าสู่ระบบ จึงเปิด/ปิดบัญชีหรือรีเซ็ตรหัสผ่านไม่ได้</Alert>
      ) : (
        <>
          <ActiveSection b={b} isActive={b.account.isActive} onDone={(text) => { setNotice({ kind: "success", text }); onChanged(); }} onError={(text) => setNotice({ kind: "error", text })} />
          <ResetPassword b={b} onError={(text) => setNotice({ kind: "error", text })} onDone={onChanged} />
        </>
      )}
    </>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className="text-base text-slate-900">{value}</dd>
    </div>
  );
}

function ActiveSection({
  b,
  isActive,
  onDone,
  onError,
}: {
  b: Borrower;
  isActive: boolean;
  onDone: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function apply() {
    setBusy(true);
    try {
      await apiFetch(`/admin/borrowers/${encodeURIComponent(b.id)}/active`, {
        method: "PUT",
        json: { isActive: !isActive },
        schema: borrowerSchema,
      });
      setConfirming(false);
      onDone(isActive ? "ปิดใช้งานบัญชีแล้ว ผู้ยืมเข้าสู่ระบบไม่ได้" : "เปิดใช้งานบัญชีแล้ว");
    } catch (err) {
      setConfirming(false);
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={isActive ? "ปิดใช้งานบัญชี" : "เปิดใช้งานบัญชี"}>
      <p className="mb-3 text-sm text-slate-700">
        {isActive
          ? "ผู้ยืมที่ถูกปิดใช้งานจะเข้าสู่ระบบไม่ได้ทันที ข้อมูลสัญญาและประวัติยังอยู่ครบ"
          : "บัญชีนี้ถูกปิดอยู่ เปิดใช้งานเพื่อให้ผู้ยืมเข้าสู่ระบบได้อีกครั้ง"}
      </p>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-900">{isActive ? `ปิดใช้งานบัญชีของ ${b.fullName}?` : `เปิดใช้งานบัญชีของ ${b.fullName}?`}</span>
          <Button variant={isActive ? "danger" : "primary"} disabled={busy} onClick={() => void apply()}>
            {busy ? "กำลังบันทึก..." : "ยืนยัน"}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
            ยกเลิก
          </Button>
        </div>
      ) : (
        <Button variant={isActive ? "danger" : "primary"} onClick={() => setConfirming(true)}>
          {isActive ? "ปิดใช้งานบัญชี" : "เปิดใช้งานบัญชี"}
        </Button>
      )}
    </Card>
  );
}

function ResetPassword({ b, onError, onDone }: { b: Borrower; onError: (text: string) => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<string | null>(null); // shown once, then forgotten

  async function submit() {
    const bad = checkPassword(password);
    setProblem(bad);
    if (bad) return;
    setBusy(true);
    try {
      await apiFetch(`/admin/borrowers/${encodeURIComponent(b.id)}/reset-password`, {
        method: "POST",
        json: { newPassword: password },
        schema: borrowerSchema,
      });
      setIssued(password);
      setPassword("");
      onDone();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="รีเซ็ตรหัสผ่าน">
      <p className="mb-3 text-sm text-slate-700">
        ตั้งรหัสผ่านชั่วคราวใหม่ ผู้ยืมจะถูกออกจากระบบทุกอุปกรณ์ และต้องเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งถัดไป
      </p>
      {issued && (
        <div className="mb-3 space-y-1">
          <Alert kind="success">รีเซ็ตรหัสผ่านเรียบร้อยแล้ว</Alert>
          <p className="text-sm text-slate-600">รหัสผ่านชั่วคราว (แสดงครั้งเดียว ส่งให้ผู้ยืมผ่านช่องทางที่ปลอดภัย)</p>
          <p className="font-mono text-lg">{issued}</p>
          <Button variant="secondary" onClick={() => setIssued(null)}>
            ซ่อนรหัสผ่าน
          </Button>
        </div>
      )}
      <div className="space-y-3">
        <PasswordField
          label="รหัสผ่านชั่วคราวใหม่"
          autoComplete="new-password"
          value={password}
          error={problem}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setPassword(generatePassword())}>
            สุ่มรหัสผ่าน
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? "กำลังบันทึก..." : "รีเซ็ตรหัสผ่าน"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
