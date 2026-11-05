import { TradingPage } from "@/components/protocol/trade";
import { Suspense } from "react";
export default function Page() {
  return (
    <Suspense
      fallback={<p className="protocol-loading">Loading stock trading…</p>}
    >
      <TradingPage />
    </Suspense>
  );
}
