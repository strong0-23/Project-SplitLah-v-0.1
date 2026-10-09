import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useBill } from "@/hooks/use-bill";
import { ScanStep } from "@/components/splitlah/ScanStep";
import { ReviewStep } from "@/components/splitlah/ReviewStep";
import { SplitStep } from "@/components/splitlah/SplitStep";
import { SummaryStep } from "@/components/splitlah/SummaryStep";
import type { Step } from "@/lib/storage";

const searchSchema = z.object({ step: z.enum(["scan", "review", "split", "summary"]).optional().catch(undefined) });

export const Route = createFileRoute("/")({
  validateSearch: (s) => searchSchema.parse(s),
  head: () => ({
    meta: [
      { title: "Splitlah — Snap. Split. Settle." },
      { name: "description", content: "Scan a receipt and split the bill to the cent, with service charge and GST. Runs entirely on your device." },
      { property: "og:title", content: "Splitlah — Snap. Split. Settle." },
      { property: "og:description", content: "Scan a receipt and split the bill to the cent, with service charge and GST." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: App,
});

function App() {
  const step: Step = Route.useSearch().step ?? "scan";
  const navigate = useNavigate({ from: "/" });
  const { ready, hasSession } = useBill();
  const go = (s: Step) => { void navigate({ to: "/", search: { step: s } }); window.scrollTo(0, 0); };

  if (!ready) return <div className="min-h-screen" aria-busy="true" />;
  const effective: Step = hasSession ? step : "scan";
  if (effective === "review") return <ReviewStep go={go} />;
  if (effective === "split") return <SplitStep go={go} />;
  if (effective === "summary") return <SummaryStep go={go} />;
  return <ScanStep go={go} />;
}
