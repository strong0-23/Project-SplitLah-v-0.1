import { useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { centsToInput, parseMoney } from "@/lib/money";
import type { Cents } from "@/lib/types";

const button = cva(
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-lg px-4 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline: "border border-input bg-card text-foreground hover:bg-muted",
        ghost: "text-foreground hover:bg-muted",
        danger: "text-destructive hover:bg-destructive/10",
        accent: "bg-accent text-accent-foreground hover:bg-accent/85",
      },
      size: { md: "", sm: "min-h-10 px-3 text-sm", icon: "h-12 w-12 px-0" },
      block: { true: "w-full" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export function Button({ className, variant, size, block, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button type="button" className={cn(button({ variant, size, block }), className)} {...p} />;
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn("rounded-xl border border-border bg-card p-4", className)}>{children}</section>;
}

export function Notice({ tone = "warning", children, title }: { tone?: "warning" | "error" | "success" | "info"; children: ReactNode; title?: string }) {
  const tones = {
    warning: "bg-warning text-warning-foreground",
    error: "bg-destructive/10 text-destructive",
    success: "bg-success text-success-foreground",
    info: "bg-muted text-muted-foreground",
  };
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("rounded-lg px-3 py-2.5 text-sm", tones[tone])}>
      {title && <p className="font-semibold">{title}</p>}
      <div>{children}</div>
    </div>
  );
}

export function Label({ htmlFor, children, hint }: { htmlFor: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-foreground">
      {children}
      {hint && <span className="ml-1 font-normal text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** Text input bound to integer cents. Keeps the typed string locally; reports null when blank. */
export function MoneyInput({ label, hint, value, onChange, flagged, id: idProp, compact }: {
  label: string; hint?: ReactNode; value: Cents | null; onChange: (c: Cents | null) => void; flagged?: boolean | undefined; id?: string; compact?: boolean;
}) {
  const auto = useId();
  const id = idProp ?? auto;
  const [text, setText] = useState(centsToInput(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const parsed = text.trim() === "" ? null : parseMoney(text);
    if (parsed !== value && !error) setText(centsToInput(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div>
      <Label htmlFor={id} hint={hint}>{label}{flagged && <span className="ml-1 rounded bg-warning px-1 text-xs text-warning-foreground">check</span>}</Label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          className={cn("field-input money pl-7", compact && "h-11")}
          value={text}
          placeholder="0.00"
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => {
            const t = e.target.value.slice(0, 14);
            setText(t);
            if (t.trim() === "") { setError(null); onChange(null); return; }
            const c = parseMoney(t);
            if (c === null) setError("Enter an amount like 12.50");
            else { setError(null); onChange(c); }
          }}
        />
      </div>
      {error && <p id={`${id}-err`} className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  const id = useId();
  return (
    <div className="flex min-h-12 items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm">
        <span className="font-medium">{label}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </label>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-6 w-11 shrink-0 cursor-pointer accent-primary" />
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-1 rounded-lg bg-muted p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cn("min-h-10 rounded-md px-2 text-sm font-medium", value === o.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
