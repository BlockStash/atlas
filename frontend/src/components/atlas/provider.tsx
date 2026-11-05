"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { MotionConfig } from "framer-motion";
import { api } from "@/lib/api";
import type { UserOnboardingState, WalletState } from "@/lib/types";
const defaults: UserOnboardingState = {
  ensName: null,
  ensChainId: null,
  ensVerifiedAt: null,
  worldIdVerified: false,
  worldIdVerifiedDemo: false,
  worldIdEnvironment: null,
  selectedMarkets: ["india"],
  preferredAsset: "USDT",
  experienceLevel: "intermediate",
  currentStep: 0,
  onboardingComplete: false,
  productTourComplete: false,
};
type Profile = Partial<UserOnboardingState>;
type Session = { wallet: WalletState; profile: Profile };
type Context = {
  wallet: WalletState | null;
  state: UserOnboardingState;
  ready: boolean;
  modal: boolean;
  setModal: (v: boolean) => void;
  update: (v: Partial<UserOnboardingState>) => void;
  acceptSession: (s: Session) => void;
  logout: () => Promise<void>;
  toast: (m: string) => void;
  verifyHuman: (proof?: unknown) => Promise<void>;
  sync: () => Promise<void>;
};
function preferences(s: UserOnboardingState) {
  return {
    selectedMarkets: s.selectedMarkets,
    preferredAsset: s.preferredAsset,
    experienceLevel: s.experienceLevel,
    currentStep: s.currentStep,
    onboardingComplete: s.onboardingComplete,
    productTourComplete: s.productTourComplete,
  };
}
const AtlasContext = createContext<Context | null>(null);
const keys: Record<string, keyof UserOnboardingState> = {
  atlas_onboarding_complete: "onboardingComplete",
  atlas_product_tour_complete: "productTourComplete",
  atlas_selected_markets: "selectedMarkets",
  atlas_preferred_asset: "preferredAsset",
  atlas_experience_level: "experienceLevel",
  atlas_world_id_verified_demo: "worldIdVerifiedDemo",
};
export function AtlasProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<WalletState | null>(null),
    [state, setState] = useState(defaults),
    [ready, setReady] = useState(false),
    [modal, setModal] = useState(false),
    [notice, setNotice] = useState("");
  const router = useRouter(),
    path = usePathname();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const toast = useCallback((message: string) => {
    setNotice(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(""), 4500);
  }, []);
  const acceptSession = useCallback((session: Session) => {
    setWallet(session.wallet);
    setState(
      Object.fromEntries(
        Object.entries(defaults).map(([key, value]) => [
          key,
          session.profile[key as keyof UserOnboardingState] ?? value,
        ]),
      ) as UserOnboardingState,
    );
  }, []);
  useEffect(() => {
    api<Session>("/auth/session")
      .then(acceptSession)
      .catch(() => {})
      .finally(() => setReady(true));
  }, [acceptSession]);
  useEffect(() => {
    if (!ready || path.startsWith("/admin")) return;
    if (path !== "/" && !wallet) router.replace("/");
    if (path === "/" && wallet)
      router.replace(state.onboardingComplete ? "/dashboard" : "/onboarding");
    if (
      wallet &&
      path !== "/" &&
      path !== "/onboarding" &&
      !state.onboardingComplete
    )
      router.replace("/onboarding");
  }, [ready, wallet, path, state.onboardingComplete, router]);
  useEffect(() => {
    if (!ready || !wallet) return;
    try {
      Object.entries(keys).forEach(([key, value]) =>
        localStorage.setItem(key, JSON.stringify(state[value])),
      );
      localStorage.setItem("atlas_current_step", String(state.currentStep));
    } catch {
      toast(
        "Browser storage is unavailable. Your preferences are saved to your Atlas profile.",
      );
    }
  }, [state, ready, wallet, toast]);
  const update = useCallback((patch: Partial<UserOnboardingState>) => {
    setState((s) => ({ ...s, ...patch }));
  }, []);
  const sync = useCallback(async () => {
    await api("/profile", preferences(stateRef.current), "PUT");
  }, []);
  useEffect(() => {
    if (!ready || !wallet || !state.selectedMarkets.length) return;
    const id = setTimeout(() => {
      api("/profile", preferences(state), "PUT").catch(() =>
        toast(
          "Could not sync preferences. Check your Arkiv connection and try again.",
        ),
      );
    }, 700);
    return () => clearTimeout(id);
  }, [state, wallet, ready, toast]);
  const logout = useCallback(async () => {
    await api("/auth/logout", {});
    setWallet(null);
    setState(defaults);
    router.replace("/");
  }, [router]);
  useEffect(() => {
    if (!wallet || wallet.demo) return;
    let cleanup: (() => void) | undefined;
    let disposed = false;
    import("@/lib/wallet")
      .then(async ({ walletClient }) => {
        const client = await walletClient();
        if (disposed) return;
        const provider = client.getProvider();
        const invalidated = () => {
          logout().catch(() => {});
          toast(
            "Your wallet account or network changed. Please reconnect to continue.",
          );
        };
        provider.on("accountsChanged", invalidated);
        provider.on("chainChanged", invalidated);
        provider.on("disconnect", invalidated);
        cleanup = () => {
          provider.removeListener("accountsChanged", invalidated);
          provider.removeListener("chainChanged", invalidated);
          provider.removeListener("disconnect", invalidated);
        };
      })
      .catch(() =>
        toast(
          "Could not restore the wallet connection. Reconnect from your wallet page.",
        ),
      );
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [wallet, logout, toast]);
  useEffect(() => {
    const expire = () => {
      setWallet(null);
      setState(defaults);
      router.replace("/");
      toast("Your Atlas session expired. Please reconnect your wallet.");
    };
    window.addEventListener("atlas-session-expired", expire);
    return () => window.removeEventListener("atlas-session-expired", expire);
  }, [router, toast]);
  const verifyHuman = useCallback(
    async (proof?: unknown) => {
      const result = await api<{ profile: UserOnboardingState }>(
        "/world-id/verify",
        proof ? { proof } : { demo: true },
      );
      update({
        worldIdVerified: result.profile.worldIdVerified,
        worldIdVerifiedDemo: result.profile.worldIdVerifiedDemo,
        worldIdEnvironment: result.profile.worldIdEnvironment ?? null,
      });
    },
    [update],
  );
  return (
    <MotionConfig reducedMotion="user">
      <AtlasContext.Provider
        value={{
          wallet,
          state,
          ready,
          modal,
          setModal,
          update,
          acceptSession,
          logout,
          toast,
          verifyHuman,
          sync,
        }}
      >
        {children}
        {notice && (
          <div role="status" className="toast">
            <span className="status-dot" />
            {notice}
            <button
              aria-label="Dismiss notification"
              onClick={() => setNotice("")}
            >
              ×
            </button>
          </div>
        )}
      </AtlasContext.Provider>
    </MotionConfig>
  );
}
export function useAtlas() {
  const ctx = useContext(AtlasContext);
  if (!ctx) throw new Error("AtlasProvider is required");
  return ctx;
}
