import { Suspense } from "react";
import { ExploreStrategiesPage } from "@/components/strategies/explore";
export default function Page() {
  return (
    <Suspense
      fallback={<p className="protocol-loading">Loading strategies…</p>}
    >
      <ExploreStrategiesPage />
    </Suspense>
  );
}
