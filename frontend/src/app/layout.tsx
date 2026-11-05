import type { Metadata } from "next";
import { AtlasProvider } from "@/components/atlas/provider";
import { WalletModal } from "@/components/wallet/wallet-modal";
import "./globals.css";
export const metadata: Metadata = {
  title: "Atlas — Global Markets. One Wallet.",
  description:
    "One Wallet. Five Markets. One Global Portfolio. A wallet-native global investment experience.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <AtlasProvider>
          {children}
          <WalletModal />
        </AtlasProvider>
      </body>
    </html>
  );
}
