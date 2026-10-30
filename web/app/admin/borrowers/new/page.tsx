"use client";

import Link from "next/link";
import { useState } from "react";
import { BorrowerForm, type BorrowerFields } from "@/components/BorrowerForm";
import { Alert, Button, Card, PageTitle, PasswordField, TextField } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { borrowerSchema, type Borrower } from "@/lib/schemas";
import { checkPassword, checkUsername, generatePassword } from "@/lib/validation";

const EMPTY: BorrowerFields = { fullName: "", phone: "", bankName: "", bankAccountNo: "" };

export default function NewBorrowerPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [created, setCreated] = useState<{ borrower: Borrower; username: string; password: string } | null>(null);

  if (created) {
    return (
      <>
        <PageTitle>สร้างผู้ยืมแล้ว</PageTitle>
        <Alert kind="success">สร้างบัญชีของ {created.borrower.fullName} เรียบร้อยแล้ว</Alert>
        <Card title="ข้อมูลเข้าสู่ระบบ (แสดงครั้งเดียว)">
          <dl className="space-y-2">
            <div>
              <dt className="text-sm text-slate-600">ชื่อผู้ใช้</dt>
              <dd className="font-mono text-lg">{created.username}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-600">รหัสผ่านชั่วคราว</dt>
              <dd className="font-mono text-lg">{created.password}</dd>
            </div>
          </dl>
          <p className="mt-3 text-sm text-slate-700">
            ส่งให้ผู้ยืมผ่านช่องทางที่ปลอดภัย หลังจากหน้านี้ปิด จะดูรหัสผ่านนี้อีกไม่ได้ ผู้ยืมต้องเปลี่ยนรหัสผ่านในการเข้าสู่ระบบครั้งแรก
          </p>
        </Card>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/admin/borrowers/${created.borrower.id}`}
            className="inline-flex min-h-11 items-center rounded-lg bg-teal-700 px-4 font-medium text-white hover:bg-teal-800"
          >
            ดูข้อมูลผู้ยืม
          </Link>
          <Link
            href="/admin/borrowers"
            className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-4 font-medium text-slate-800 hover:bg-slate-50"
          >
            กลับไปรายชื่อ
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <PageTitle>เพิ่มผู้ยืม</PageTitle>
      <Card>
        <BorrowerForm
          initial={EMPTY}
          required
          submitLabel="สร้างบัญชีผู้ยืม"
          precheck={() => checkUsername(username) ?? checkPassword(password)}
          onSubmit={async (values) => {
            const borrower = await apiFetch("/admin/borrowers", {
              method: "POST",
              json: { ...values, username: username.trim(), password },
              schema: borrowerSchema,
            });
            setCreated({ borrower, username: username.trim(), password });
            setPassword("");
          }}
          extra={
            <fieldset className="space-y-4 rounded-lg border border-slate-200 p-3">
              <legend className="px-1 text-sm font-medium text-slate-800">บัญชีเข้าสู่ระบบ</legend>
              <TextField
                label="ชื่อผู้ใช้"
                autoComplete="off"
                autoCapitalize="none"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <PasswordField
                label="รหัสผ่านชั่วคราว"
                autoComplete="new-password"
                value={password}
                hint="อย่างน้อย 10 ตัวอักษร ผู้ยืมต้องเปลี่ยนเองตอนเข้าสู่ระบบครั้งแรก"
                onChange={(e) => setPassword(e.target.value)}
              />
              <Button type="button" variant="secondary" onClick={() => setPassword(generatePassword())}>
                สุ่มรหัสผ่าน
              </Button>
            </fieldset>
          }
        />
      </Card>
    </>
  );
}
