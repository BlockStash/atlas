import type { Metadata } from "next";
import { AtlasProvider } from "@/components/atlas/provider";
import { WalletModal } from "@/components/wallet/wallet-modal";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import "./globals.css";
import "./theme-light.generated.css";
import "./theme-light.css";
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
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <AtlasProvider>
          {children}
          <WalletModal />
        </AtlasProvider>
      </body>
    </html>
  );
}
