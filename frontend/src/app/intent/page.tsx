import { Suspense } from "react";
import { IntentDashboard } from "@/components/intent/dashboard";
export default function Page() {
  return (
    <Suspense>
      <IntentDashboard />
    </Suspense>
  );
}
