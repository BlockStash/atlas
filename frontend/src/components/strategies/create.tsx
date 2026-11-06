"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Sparkles } from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { DashboardShell } from "@/components/dashboard/shell";
import { StrategyStudio } from "./studio";
import { useStrategyStore } from "./ui";

export function CreateStrategyPage() {
  const { toast } = useAtlas();
  const store = useStrategyStore();
  const router = useRouter();
  const prompt = useSearchParams().get("prompt")?.slice(0, 1000) || undefined;
  return (
    <DashboardShell>
      <main className="protocol-content strategies-page studio-page">
        <div className="studio-title">
          <Link className="text-button" href="/strategies/mine">
            <ArrowLeft size={14} /> My strategies
          </Link>
          <h1>
            <Sparkles size={24} /> Create with Atlas AI
          </h1>
          <p>
            Describe your strategy on the left and watch it build on the right.
            Refine it by chatting, then save. New strategies are private by
            default.
          </p>
        </div>
        <StrategyStudio
          autoPrompt={prompt}
          submitLabel="Save strategy"
          onCancel={() => router.push("/strategies/mine")}
          onSubmit={async (v) => {
            try {
              const s = await store.create(v);
              toast(
                `“${s.name}” saved as ${s.visibility}${s.ens ? ` at ${s.ens}` : ""}. Run a backtest next.`,
              );
              router.push(`/strategies/${s.id}`);
            } catch (e) {
              toast(
                e instanceof Error ? e.message : "Could not save the strategy.",
              );
            }
          }}
        />
      </main>
    </DashboardShell>
  );
}
