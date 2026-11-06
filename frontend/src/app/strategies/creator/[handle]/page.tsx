import { CreatorPage } from "@/components/strategies/creator";
export default async function Page({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  return <CreatorPage handle={decodeURIComponent(handle)} />;
}
