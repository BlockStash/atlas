import { Suspense } from "react";
import { StrategyDetailPage } from "@/components/strategies/detail";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={<p className="protocol-loading">Loading strategy…</p>}>
      <StrategyDetailPage id={id} />
    </Suspense>
  );
}
