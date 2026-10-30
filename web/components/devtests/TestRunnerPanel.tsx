"use client";

// DEV-TOOLS (temporary) — a page of buttons that run the project's automated tests.
// Remove this folder, app/admin/dev-tests and the menu line in lib/access.ts before the real deploy
// (DEV-TOOLS-REMOVAL.md).
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiFetch, errorMessage } from "@/lib/api";
import { Alert, Badge, Button, Card, Spinner } from "@/components/ui";
import { overviewSchema, runResponseSchema, type Run, type Suite } from "./schemas";

const BASE = "/admin/dev-tests";
const STATUS: Record<Run["status"], { label: string; tone: "green" | "red" | "amber" | "gray" }> = {
  running: { label: "กำลังรัน", tone: "amber" },
  passed: { label: "ผ่านทั้งหมด", tone: "green" },
  failed: { label: "มีเคสไม่ผ่าน", tone: "red" },
  error: { label: "รันไม่สำเร็จ", tone: "red" },
  timeout: { label: "หมดเวลา", tone: "red" },
  cancelled: { label: "ยกเลิกแล้ว", tone: "gray" },
};
const PROJECT_LABEL = { api: "เทสต์ API (ใช้ฐานข้อมูลในเครื่อง)", web: "เทสต์หน้าเว็บ" } as const;

const seconds = (run: Run, now: number) => Math.max(0, Math.round(((run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt)) / 1000));

export function TestRunnerPanel({ pollMs = 1500 }: { pollMs?: number }) {
  const [suites, setSuites] = useState<Suite[] | null>(null);
  const [history, setHistory] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const running = run?.status === "running";

  // the result panel sits above the long list of files: bring it into view when a run starts or is opened
  const resultTop = useRef<HTMLDivElement>(null);
  const shownRun = run?.id ?? null;
  useEffect(() => {
    if (shownRun) resultTop.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [shownRun]);

  // the list of test files and the recent runs; asked again (reloadTick) whenever a run has ended
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    apiFetch(BASE, { schema: overviewSchema })
      .then(async (o) => {
        if (cancelled) return;
        setSuites(o.suites);
        setHistory(o.runs);
        setError(null);
        if (o.running) {
          // a run started earlier (before this page was opened) is still going: follow it
          const r = await apiFetch(`${BASE}/runs/${o.running}`, { schema: runResponseSchema });
          if (!cancelled) setRun((cur) => cur ?? r.run);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // the routes do not exist at all when the runner is switched off on the server
        if (err instanceof ApiError && err.status === 404) setOff(true);
        else setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  // follow the run that is going until it ends
  const runId = run?.id ?? null;
  useEffect(() => {
    if (!runId || !running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await apiFetch(`${BASE}/runs/${runId}`, { schema: runResponseSchema });
        if (stopped) return;
        setRun(r.run);
        setNow(Date.now());
        if (r.run.status !== "running") {
          setReloadTick((t) => t + 1);
          return;
        }
      } catch (err) {
        if (stopped) return;
        setError(errorMessage(err));
        return;
      }
      timer = setTimeout(() => void tick(), pollMs);
    };
    timer = setTimeout(() => void tick(), pollMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId, running, pollMs]);

  // the stopwatch
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  async function start(project: Suite["project"], files?: string[]) {
    setStarting(true);
    setError(null);
    try {
      const r = await apiFetch(`${BASE}/runs`, { method: "POST", json: { project, files }, schema: runResponseSchema });
      setRun(r.run);
      setNow(Date.now());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!run) return;
    try {
      await apiFetch(`${BASE}/runs/${run.id}`, { method: "DELETE" });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function open(id: string) {
    try {
      setRun((await apiFetch(`${BASE}/runs/${id}`, { schema: runResponseSchema })).run);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // what the latest finished run said about each file (so a row can show ✓ / ✗ next to its button)
  const lastByFile = useMemo(() => {
    const m = new Map<string, "passed" | "failed">();
    if (run && run.status !== "running") for (const f of run.results) m.set(`${run.project}/${f.file}`, f.status);
    return m;
  }, [run]);

  const grouped = useMemo(() => {
    const out: Record<string, Map<string, Suite[]>> = { api: new Map(), web: new Map() };
    for (const s of suites ?? []) {
      const areas = out[s.project]!;
      areas.set(s.area, [...(areas.get(s.area) ?? []), s]);
    }
    return out;
  }, [suites]);

  if (off) {
    return (
      <Alert kind="warning">
        <p className="font-medium">เครื่องมือรันเทสต์ปิดอยู่</p>
        <p>
          ถ้าต้องการใช้ตอนพัฒนา ให้ใส่ <code>DEV_TEST_RUNNER=true</code> ในไฟล์ <code>api/.env</code> แล้วรีสตาร์ท API (เปิดใช้ไม่ได้เมื่อ <code>NODE_ENV=production</code>)
        </p>
      </Alert>
    );
  }

  const failedFiles = run && run.status !== "running" ? run.results.filter((f) => f.status === "failed").map((f) => f.file) : [];

  return (
    <>
      <Alert kind="warning">
        เครื่องมือสำหรับช่วงพัฒนา จะถูกเอาออกก่อน deploy จริง · เทสต์ API เขียนข้อมูลทดสอบลงฐานข้อมูลในเครื่องนี้ (แล้วลบเอง) และใช้เวลาประมาณ 4 นาทีถ้ารันทั้งหมด
      </Alert>

      {error && <Alert kind="error">{error}</Alert>}
      {!suites && !error && <Spinner />}

      {suites && (
        <Card title="รันเทสต์">
          <div className="flex flex-wrap gap-2">
            <Button disabled={starting || running} onClick={() => void start("web")}>
              รันเทสต์หน้าเว็บทั้งหมด
            </Button>
            <Button disabled={starting || running} onClick={() => void start("api")}>
              รันเทสต์ API ทั้งหมด
            </Button>
            {running && (
              <Button variant="danger" onClick={() => void cancel()}>
                ยกเลิกการรัน
              </Button>
            )}
          </div>
        </Card>
      )}

      <div ref={resultTop} className="scroll-mt-44" />
      {run && <RunView run={run} now={now} onRerunFailed={failedFiles.length > 0 ? () => void start(run.project, failedFiles) : undefined} busy={starting} />}

      {suites &&
        (["web", "api"] as const).map((project) => (
          <Card key={project} title={PROJECT_LABEL[project]}>
            {[...grouped[project]!.entries()].map(([area, files]) => (
              <section key={area} aria-label={`${PROJECT_LABEL[project]} · ${area}`} className="mb-4 last:mb-0">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-slate-900">{area}</h3>
                  <Button variant="secondary" className="min-h-9 px-3 text-sm" disabled={starting || running} onClick={() => void start(project, files.map((f) => f.file))} aria-label={`รันกลุ่ม ${area} (${PROJECT_LABEL[project]})`}>
                    รันทั้งกลุ่ม ({files.length})
                  </Button>
                </div>
                <ul className="divide-y divide-slate-100">
                  {files.map((s) => {
                    const last = lastByFile.get(`${s.project}/${s.file}`);
                    return (
                      <li key={s.file} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-900">{s.file}</p>
                          <p className="text-sm text-slate-600">
                            {s.title} · {s.refs}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {last && <Badge tone={last === "passed" ? "green" : "red"}>{last === "passed" ? "ผ่าน" : "ไม่ผ่าน"}</Badge>}
                          <Button variant="secondary" className="min-h-9 px-3 text-sm" disabled={starting || running} onClick={() => void start(project, [s.file])} aria-label={`รัน ${s.file}`}>
                            รัน
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </Card>
        ))}

      {history.length > 0 && (
        <Card title="การรันล่าสุด">
          <ul className="divide-y divide-slate-100">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-sm text-slate-800">
                  {h.project === "api" ? "API" : "เว็บ"} · {h.files.length} ไฟล์ · {new Date(h.startedAt).toLocaleTimeString("th-TH")}
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={STATUS[h.status].tone}>{STATUS[h.status].label}</Badge>
                  <Button variant="secondary" className="min-h-9 px-3 text-sm" onClick={() => void open(h.id)} aria-label={`ดูผลการรัน ${h.project} เวลา ${new Date(h.startedAt).toLocaleTimeString("th-TH")}`}>
                    ดูผล
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function RunView({ run, now, onRerunFailed, busy }: { run: Run; now: number; onRerunFailed?: () => void; busy: boolean }) {
  const st = STATUS[run.status];
  const c = run.counts;
  return (
    <Card title="ผลการรัน">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="text-sm text-slate-700">
          {run.project === "api" ? "API" : "หน้าเว็บ"} · {run.files.length} ไฟล์ · {seconds(run, now)} วินาที
        </span>
        {c && (
          <span className="text-sm font-medium text-slate-900">
            ผ่าน {c.passed} · ไม่ผ่าน {c.failed}
            {c.skipped > 0 ? ` · ข้าม ${c.skipped}` : ""}
          </span>
        )}
      </div>
      {run.error && (
        <div className="mt-3">
          <Alert kind="error">{run.error}</Alert>
        </div>
      )}
      {run.status === "running" && (
        <pre aria-label="ข้อความจากการรัน" className="mt-3 max-h-48 overflow-auto rounded-xl bg-slate-900 p-3 text-xs text-slate-100">
          {run.outputTail.length > 0 ? run.outputTail.join("\n") : "กำลังเริ่มรัน..."}
        </pre>
      )}
      {run.status !== "running" && run.results.length === 0 && run.outputTail.length > 0 && (
        <pre aria-label="ข้อความจากการรัน" className="mt-3 max-h-48 overflow-auto rounded-xl bg-slate-900 p-3 text-xs text-slate-100">
          {run.outputTail.join("\n")}
        </pre>
      )}
      {run.status !== "running" && run.results.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100">
          {run.results.map((f) => {
            const failed = f.tests.filter((t) => t.status === "failed");
            return (
              <li key={f.file} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-slate-900">{f.file}</span>
                  <span className="flex items-center gap-2 text-sm text-slate-700">
                    {f.tests.length} เคส
                    <Badge tone={f.status === "passed" ? "green" : "red"}>{f.status === "passed" ? "ผ่าน" : "ไม่ผ่าน"}</Badge>
                  </span>
                </div>
                {failed.map((t, i) => (
                  <details key={i} className="mt-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900" open={failed.length <= 3}>
                    <summary className="cursor-pointer font-medium">{[...t.ancestors, t.title].join(" › ")}</summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{t.message}</pre>
                  </details>
                ))}
              </li>
            );
          })}
        </ul>
      )}
      {onRerunFailed && (
        <div className="mt-3">
          <Button onClick={onRerunFailed} disabled={busy}>
            รันซ้ำเฉพาะไฟล์ที่ไม่ผ่าน
          </Button>
        </div>
      )}
    </Card>
  );
}
