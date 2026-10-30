"use client";

import { useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

/**
 * The few building blocks every page uses, mobile first: 16 px text in inputs (iPhone does not zoom
 * in), 44 px touch targets, plain Thai wording, and colour never the only signal (icons and words).
 */

const BUTTON_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-base font-medium shadow-sm transition duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100";
const BUTTON_VARIANT = {
  primary: "bg-gradient-to-b from-teal-600 to-teal-700 text-white hover:from-teal-700 hover:to-teal-800",
  secondary: "border border-slate-300 bg-white text-slate-800 hover:border-slate-400 hover:bg-slate-50",
  danger: "bg-gradient-to-b from-red-600 to-red-700 text-white hover:from-red-700 hover:to-red-800",
} as const;

export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_VARIANT }) {
  return <button type={type} className={`${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${className}`} {...props} />;
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  error?: string | null;
  hint?: string;
}

export function TextField({ label, error, hint, className = "", ...props }: FieldProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`block min-h-11 w-full rounded-xl border bg-white px-3 text-base text-slate-900 shadow-sm transition placeholder:text-slate-400 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/30 ${
          error ? "border-red-600" : "border-slate-300"
        } ${className}`}
        {...props}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-slate-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

/** A password box with a show/hide toggle (people mistype long passwords on a phone). */
export function PasswordField({ label, error, hint, ...props }: FieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <TextField label={label} error={error} hint={hint} type={shown ? "text" : "password"} className="pr-16" {...props} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-pressed={shown}
        className="absolute right-2 top-[1.9rem] min-h-9 rounded px-2 text-sm font-medium text-teal-800 hover:bg-teal-50"
      >
        {shown ? "ซ่อน" : "แสดง"}
      </button>
    </div>
  );
}

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  label: string;
  error?: string | null;
}

export function SelectField({ label, error, className = "", children, ...props }: SelectProps) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        className={`block min-h-11 w-full rounded-xl border bg-white px-3 text-base text-slate-900 shadow-sm transition focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/30 ${
          error ? "border-red-600" : "border-slate-300"
        } ${className}`}
        {...props}
      >
        {children}
      </select>
      {error && (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

interface AreaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  label: string;
  error?: string | null;
  hint?: string;
}

export function TextAreaField({ label, error, hint, className = "", ...props }: AreaProps) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <textarea
        id={id}
        rows={3}
        aria-invalid={error ? true : undefined}
        className={`block w-full rounded-xl border bg-white px-3 py-2 text-base text-slate-900 shadow-sm transition focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/30 ${
          error ? "border-red-600" : "border-slate-300"
        } ${className}`}
        {...props}
      />
      {hint && <p className="text-sm text-slate-600">{hint}</p>}
      {error && (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

/** A label above a value, for the read-only facts of a record. */
export function Item({ label, value, strong = false }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div>
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className={strong ? "text-2xl font-bold tabular-nums tracking-tight text-slate-900" : "text-base tabular-nums text-slate-900"}>{value}</dd>
    </div>
  );
}

const ALERT_STYLE = {
  error: "border-red-200 border-l-red-600 bg-red-50 text-red-900",
  warning: "border-amber-200 border-l-amber-500 bg-amber-50 text-amber-900",
  success: "border-emerald-200 border-l-emerald-600 bg-emerald-50 text-emerald-900",
  info: "border-sky-200 border-l-sky-600 bg-sky-50 text-sky-900",
} as const;
const ALERT_ICON = { error: "x", warning: "alert", success: "check", info: "info" } as const;

export function Alert({ kind = "info", children }: { kind?: keyof typeof ALERT_STYLE; children: ReactNode }) {
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`flex gap-3 rounded-xl border border-l-4 p-3 text-sm shadow-sm ${ALERT_STYLE[kind]}`}>
      <Icon name={ALERT_ICON[kind]} className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-200/80 bg-white p-4 shadow-card sm:p-6 ${className}`}>
      {title && (
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-slate-900">
          <span aria-hidden="true" className="h-5 w-1 rounded-full bg-gradient-to-b from-teal-500 to-teal-700" />
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-2xl font-bold tracking-tight text-slate-900">{children}</h1>;
}

export function Spinner({ label = "กำลังโหลด..." }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 p-8 text-slate-600">
      <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-teal-700 border-t-transparent motion-reduce:animate-none" />
      <span>{label}</span>
    </div>
  );
}

const BADGE_STYLE = {
  green: "bg-emerald-50 text-emerald-900 ring-emerald-600/25",
  red: "bg-red-50 text-red-900 ring-red-600/25",
  gray: "bg-slate-100 text-slate-700 ring-slate-500/20",
  amber: "bg-amber-50 text-amber-900 ring-amber-600/30",
} as const;
const BADGE_DOT = { green: "bg-emerald-600", red: "bg-red-600", gray: "bg-slate-500", amber: "bg-amber-500" } as const;

/** A short status label. The words carry the meaning; the colour only helps. */
export function Badge({ tone, children }: { tone: keyof typeof BADGE_STYLE; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset ${BADGE_STYLE[tone]}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${BADGE_DOT[tone]}`} />
      {children}
    </span>
  );
}

const ICON_PATH = {
  home: <path d="M3 11l9-8 9 8M5 10v10h14V10M10 20v-6h4v6" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  document: <path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" />,
  inbox: <path d="M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5" />,
  receipt: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M16 14c3 0 5 2 5 5" />
    </>
  ),
  chart: <path d="M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />,
  bell: <path d="M6 16v-5a6 6 0 0112 0v5l2 2H4zM10 21h4" />,
  sliders: (
    <>
      <path d="M4 7h8M18 7h2M4 17h2M12 17h8" />
      <circle cx="15" cy="7" r="2.5" />
      <circle cx="9" cy="17" r="2.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  logout: <path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  alert: <path d="M12 4l9 16H3zM12 10v4M12 17.5v.01" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.5v.01" />
    </>
  ),
  chevronRight: <path d="M9 6l6 6-6 6" />,
} as const;

export type IconName = keyof typeof ICON_PATH;

/** A small line icon. Purely decorative (hidden from screen readers): the words next to it carry the meaning. */
export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className}>
      {ICON_PATH[name]}
    </svg>
  );
}
