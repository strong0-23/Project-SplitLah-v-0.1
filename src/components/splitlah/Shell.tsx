import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Step } from "@/lib/storage";

const STEPS: { key: Step; label: string }[] = [
  { key: "scan", label: "Scan" },
  { key: "review", label: "Review" },
  { key: "split", label: "Split" },
  { key: "summary", label: "Summary" },
];

export function Shell({ step, children, footer }: { step: Step; children: ReactNode; footer?: ReactNode }) {
  const idx = STEPS.findIndex((s) => s.key === step);
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 pb-3 pt-4 backdrop-blur">
        <div className="flex items-baseline justify-between">
          <p className="text-xl font-extrabold tracking-tight text-primary">Splitlah</p>
          <p className="text-xs text-muted-foreground">Snap. Split. Settle.</p>
        </div>
        <ol className="mt-3 grid grid-cols-4 gap-1.5" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s.key} aria-current={i === idx ? "step" : undefined} className="text-center">
              <div className={cn("h-1.5 rounded-full", i <= idx ? "bg-primary" : "bg-border")} />
              <span className={cn("mt-1 block text-xs", i === idx ? "font-semibold text-foreground" : "text-muted-foreground")}>{i + 1}. {s.label}</span>
            </li>
          ))}
        </ol>
      </header>
      <main className="flex-1 space-y-4 px-4 py-4">{children}</main>
      {footer && <div className="sticky bottom-0 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">{footer}</div>}
    </div>
  );
}
