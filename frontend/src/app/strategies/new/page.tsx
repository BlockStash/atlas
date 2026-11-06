import { Suspense } from "react";
import { CreateStrategyPage } from "@/components/strategies/create";
export default function Page() {
  return (
    <Suspense fallback={<p className="protocol-loading">Loading studio…</p>}>
      <CreateStrategyPage />
    </Suspense>
  );
}
