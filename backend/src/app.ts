import { protocolRouter } from "./protocol/router.js";
import express, { type RequestHandler } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { randomBytes } from "node:crypto";
import { getAddress, isAddress, verifyMessage } from "ethers";
import { z } from "zod";
import { ProfileStore } from "./store.js";
import type { ProfileRepository } from "./profile-repository.js";
import { createEnsResolver, normalizedEnsName } from "./ens.js";
import { markets, portfolio } from "./data.js";
import {
  verifyWorldId,
  VerificationError,
  createWorldRequest,
  requireWorldConfig,
  type WorldIdConfig,
  type PendingProof,
} from "./world-id.js";
import type { WalletSession } from "./types.js";
import {
  passkeyConfig,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "./passkey.js";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import {
  cryptoAssets,
  defaultCryptoAccount,
  executeCryptoTrade,
  FEE_BPS,
} from "./crypto.js";

export interface AppOptions {
  dataFile: string;
  frontendOrigin: string;
  demoWallet: boolean;
  demoWorldId: boolean;
  production: boolean;
  now?: () => number;
  worldId?: WorldIdConfig;
  worldIdFetch?: typeof fetch;
  store?: ProfileRepository;
  ensResolve?: (name: string) => Promise<string | null>;
  passkeyRpId?: string;
}
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine(isAddress)
  .transform((value) => getAddress(value));
const profileSchema = z
  .object({
    selectedMarkets: z
      .array(z.enum(["india", "usa", "uk", "singapore", "europe", "crypto"]))
      .min(1)
      .max(6)
      .transform((value) => [...new Set(value)])
      .optional(),
    preferredAsset: z.enum(["USDT", "ATLAS"]).optional(),
    experienceLevel: z
      .enum(["beginner", "intermediate", "advanced"])
      .optional(),
    currentStep: z.number().int().min(0).max(5).optional(),
    onboardingComplete: z.boolean().optional(),
    productTourComplete: z.boolean().optional(),
  })
  .strict();
const COOKIE = "atlas_session";
const CHALLENGE_TTL = 5 * 60 * 1000;
const SESSION_TTL = 24 * 60 * 60 * 1000;
export function createApp(options: AppOptions) {
  const app = express(),
    store = options.store ?? new ProfileStore(options.dataFile),
    now = options.now ?? Date.now;
  const resolveEns =
    options.ensResolve ??
    createEnsResolver(
      process.env.SEPOLIA_RPC_URL ||
        "https://ethereum-sepolia-rpc.publicnode.com",
    );
  const challenges = new Map<
    string,
    { message: string; expires: number; ensName?: string }
  >();
  const sessions = new Map<
    string,
    { wallet: WalletSession; expires: number }
  >();
  const worldRequests = new Map<string, PendingProof>();
  const rates = new Map<string, { count: number; expires: number }>();
  const fail = (
    res: express.Response,
    status: number,
    code: string,
    message: string,
  ) => res.status(status).json({ error: { code, message } });
  const cookieOptions = {
    httpOnly: true,
    secure: options.production,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL,
  };
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: options.frontendOrigin, credentials: true }));
  app.use(express.json({ limit: "24kb" }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.headers.origin && req.headers.origin !== options.frontendOrigin) {
        fail(
          res,
          403,
          "ORIGIN_REJECTED",
          "This request did not come from Atlas.",
        );
        return;
      }
      if (req.headers["content-type"] && !req.is("application/json")) {
        fail(res, 415, "JSON_REQUIRED", "Send this request as JSON.");
        return;
      }
    }
    next();
  });
  const limit: RequestHandler = (req, res, next) => {
    const timestamp = now();
    for (const [key, value] of rates)
      if (value.expires <= timestamp) rates.delete(key);
    const key = req.ip ?? "local";
    const entry = rates.get(key);
    if (entry && entry.count >= 30) {
      fail(
        res,
        429,
        "RATE_LIMITED",
        "Too many attempts. Please wait a minute.",
      );
      return;
    }
    rates.set(key, {
      count: (entry?.count ?? 0) + 1,
      expires: entry?.expires ?? timestamp + 60000,
    });
    next();
  };
  const authenticated: RequestHandler = (req, res, next) => {
    const token = req.cookies[COOKIE] as string | undefined;
    const session = token ? sessions.get(token) : undefined;
    if (!session || session.expires <= now()) {
      if (token) sessions.delete(token);
      fail(res, 401, "AUTH_REQUIRED", "Connect your wallet to continue.");
      return;
    }
    res.locals.wallet = session.wallet;
    next();
  };
  function issueSession(
    req: express.Request,
    res: express.Response,
    wallet: WalletSession,
  ) {
    for (const [key, value] of sessions)
      if (value.expires <= now()) sessions.delete(key);
    if (req.cookies[COOKIE]) sessions.delete(req.cookies[COOKIE] as string);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { wallet, expires: now() + SESSION_TTL });
    res.cookie(COOKIE, token, cookieOptions);
  }
  app.get("/api/health", (_req, res) =>
    res.json({
      status: "ok",
      service: "atlas-backend",
      demo: {
        wallet: options.demoWallet && !options.production,
        worldId: options.demoWorldId && !options.production,
      },
    }),
  );
  app.get("/api/ens/resolve", limit, async (req, res) => {
    const { name } = z
      .object({ name: z.string().min(3).max(255) })
      .parse(req.query);
    const normalized = normalizedEnsName(name),
      address = await resolveEns(normalized);
    if (!address)
      throw new VerificationError(
        "ENS_NOT_FOUND",
        "This ENS name has no Ethereum address record on Sepolia.",
        404,
      );
    res
      .set("Cache-Control", "no-store")
      .json({ name: normalized, address, chainId: 11155111 });
  });
  app.post("/api/auth/challenge", limit, async (req, res) => {
    const { address, ensName: inputName } = z
      .object({
        address: addressSchema,
        ensName: z.string().max(255).optional(),
      })
      .strict()
      .parse(req.body);
    const ensName = inputName ? normalizedEnsName(inputName) : undefined;
    if (
      ensName &&
      (await resolveEns(ensName))?.toLowerCase() !== address.toLowerCase()
    )
      throw new VerificationError(
        "ENS_WALLET_MISMATCH",
        "Connect the wallet that this Sepolia ENS name resolves to.",
        403,
      );
    for (const [key, value] of challenges)
      if (value.expires <= now()) challenges.delete(key);
    const expires = now() + CHALLENGE_TTL;
    const message = [
      `${new URL(options.frontendOrigin).host} wants you to sign in to Atlas:`,
      address,
      "",
      "Sign in to Atlas. This signature does not authorize a transaction.",
      "",
      ...(ensName ? [`ENS Name: ${ensName}`] : []),
      `URI: ${options.frontendOrigin}`,
      "Version: 1",
      "Chain ID: 11155111",
      `Nonce: ${randomBytes(16).toString("hex")}`,
      `Issued At: ${new Date(now()).toISOString()}`,
      `Expiration Time: ${new Date(expires).toISOString()}`,
    ].join("\n");
    challenges.set(address.toLowerCase(), { message, expires, ensName });
    res.json({ message, expiresAt: new Date(expires).toISOString() });
  });
  app.post("/api/auth/verify", limit, async (req, res) => {
    const { address, signature } = z
      .object({ address: addressSchema, signature: z.string().max(2048) })
      .parse(req.body);
    const key = address.toLowerCase(),
      challenge = challenges.get(key);
    challenges.delete(key); // Challenges are one-use, including failed signature attempts.
    if (!challenge || challenge.expires <= now()) {
      fail(
        res,
        401,
        "CHALLENGE_EXPIRED",
        "Your sign-in request expired. Please connect again.",
      );
      return;
    }
    let recovered: string;
    try {
      recovered = verifyMessage(challenge.message, signature);
    } catch {
      fail(
        res,
        401,
        "INVALID_SIGNATURE",
        "The wallet signature could not be verified.",
      );
      return;
    }
    if (recovered.toLowerCase() !== key) {
      fail(
        res,
        401,
        "INVALID_SIGNATURE",
        "The wallet signature could not be verified.",
      );
      return;
    }
    if (
      challenge.ensName &&
      (await resolveEns(challenge.ensName))?.toLowerCase() !== key
    )
      throw new VerificationError(
        "ENS_CHANGED",
        "This ENS record changed during sign-in. Start again.",
        409,
      );
    const wallet: WalletSession = { address, network: "Sepolia", demo: false };
    const profile = challenge.ensName
      ? await store.update(address, {
          ensName: challenge.ensName,
          ensChainId: 11155111,
          ensVerifiedAt: new Date().toISOString(),
        })
      : await store.get(address);
    issueSession(req, res, wallet);
    res.json({ wallet, profile });
  });
  app.post("/api/auth/demo", limit, async (req, res) => {
    if (!options.demoWallet || options.production) {
      fail(
        res,
        403,
        "DEMO_DISABLED",
        "Investor demo authentication is unavailable.",
      );
      return;
    }
    // Each demo visitor gets a distinct wallet namespace, so preferences cannot cross sessions.
    const address = getAddress(`0x${randomBytes(20).toString("hex")}`);
    const wallet: WalletSession = {
      address,
      network: "Sepolia demo",
      demo: true,
    };
    issueSession(req, res, wallet);
    res.json({ wallet, profile: await store.get(address) });
  });
  app.get("/api/auth/session", authenticated, async (_req, res) => {
    const wallet = res.locals.wallet as WalletSession;
    res.set("Cache-Control", "no-store");
    res.json({ wallet, profile: await store.get(wallet.address) });
  });
  app.post("/api/auth/logout", (req, res) => {
    sessions.delete(req.cookies[COOKIE] as string);
    res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
    res.json({ ok: true });
  });
  app.get("/api/storage/status", authenticated, async (_req, res) => {
    res
      .set("Cache-Control", "no-store")
      .json((await store.status?.()) ?? { driver: "local", ready: true });
  });
  app.post("/api/profile/ens", authenticated, async (req, res) => {
    const wallet = res.locals.wallet as WalletSession;
    if (wallet.demo)
      throw new VerificationError(
        "REAL_WALLET_REQUIRED",
        "Connect MetaMask to link an ENS name.",
        403,
      );
    const { name } = z
      .object({ name: z.string().min(3).max(255) })
      .strict()
      .parse(req.body);
    const ensName = normalizedEnsName(name);
    if (
      (await resolveEns(ensName))?.toLowerCase() !==
      wallet.address.toLowerCase()
    )
      throw new VerificationError(
        "ENS_WALLET_MISMATCH",
        "This name must resolve to your connected wallet on Sepolia before it can be linked.",
        403,
      );
    res.json(
      await store.update(wallet.address, {
        ensName,
        ensChainId: 11155111,
        ensVerifiedAt: new Date().toISOString(),
      }),
    );
  });
  app.delete("/api/profile/ens", authenticated, async (_req, res) => {
    res.json(
      await store.update((res.locals.wallet as WalletSession).address, {
        ensName: null,
        ensChainId: null,
        ensVerifiedAt: null,
      }),
    );
  });
  app.get("/api/profile", authenticated, async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await store.get((res.locals.wallet as WalletSession).address));
  });
  app.put("/api/profile", authenticated, async (req, res) => {
    const patch = profileSchema.parse(req.body),
      wallet = res.locals.wallet as WalletSession;
    const existing = await store.get(wallet.address);
    if (existing.onboardingComplete) patch.onboardingComplete = true;
    if (existing.productTourComplete) patch.productTourComplete = true;
    if (
      patch.onboardingComplete &&
      !existing.passkeyVerified &&
      (!existing.worldIdVerified ||
        (existing.worldIdVerifiedDemo &&
          (!options.demoWorldId || options.production)) ||
        (options.production && existing.worldIdEnvironment === "staging"))
    ) {
      fail(
        res,
        409,
        "VERIFICATION_REQUIRED",
        "Verify with World ID or a passkey before completing onboarding.",
      );
      return;
    }
    res.json(await store.update(wallet.address, patch));
  });
  app.post("/api/world-id/request", limit, authenticated, (req, res) => {
    const wallet = res.locals.wallet as WalletSession;
    if (wallet.demo)
      throw new VerificationError(
        "REAL_WALLET_REQUIRED",
        "Connect a real MetaMask wallet to verify with World App.",
        403,
      );
    const config = requireWorldConfig(options.worldId, options.production);
    for (const [nonce, pending] of worldRequests)
      if (pending.expiresAt <= Date.now()) worldRequests.delete(nonce);
    const request = createWorldRequest(config, wallet.address);
    const sessionToken = req.cookies[COOKIE] as string;
    for (const [nonce, pending] of worldRequests)
      if (pending.sessionToken === sessionToken) worldRequests.delete(nonce);
    worldRequests.set(request.rp_context.nonce, {
      walletAddress: wallet.address,
      sessionToken,
      nonce: request.rp_context.nonce,
      expiresAt: request.rp_context.expires_at * 1000,
    });
    res.set("Cache-Control", "no-store").json(request);
  });
  app.post("/api/world-id/verify", limit, authenticated, async (req, res) => {
    const input = z
      .object({
        demo: z.boolean().optional(),
        proof: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .parse(req.body);
    const wallet = res.locals.wallet as WalletSession;
    const nonce =
      typeof input.proof?.nonce === "string" ? input.proof.nonce : "";
    const candidate = worldRequests.get(nonce);
    const pending =
      candidate?.sessionToken === req.cookies[COOKIE] ? candidate : undefined;
    if (pending) worldRequests.delete(nonce); // Consume before contacting World ID to reject concurrent replay.
    const result = await verifyWorldId(input, {
      demoEnabled: options.demoWorldId,
      production: options.production,
      config: options.worldId,
      pending,
      address: wallet.address,
      fetcher: options.worldIdFetch,
    });
    const profile = await store.update(wallet.address, {
      worldIdVerified: true,
      worldIdVerifiedDemo: result.demo,
      worldIdEnvironment: result.environment,
      worldIdNullifier: result.nullifier,
    });
    const { nullifier, ...publicResult } = result;
    void nullifier;
    res.json({ ...publicResult, profile });
  });
  const passkeys = passkeyConfig(options.frontendOrigin, options.passkeyRpId);
  const passkeyChallenges = new Map<
    string,
    { challenge: string; address: string; expiresAt: number }
  >();
  app.post(
    "/api/passkey/register/options",
    limit,
    authenticated,
    async (req, res) => {
      const wallet = res.locals.wallet as WalletSession;
      const profile = await store.get(wallet.address);
      for (const [key, value] of passkeyChallenges)
        if (value.expiresAt <= Date.now()) passkeyChallenges.delete(key);
      const registration = await passkeyRegistrationOptions(
        passkeys,
        wallet.address,
        profile.passkeyCredentialId,
      );
      passkeyChallenges.set(req.cookies[COOKIE] as string, {
        challenge: registration.challenge,
        address: wallet.address,
        expiresAt: Date.now() + CHALLENGE_TTL,
      });
      res.set("Cache-Control", "no-store").json(registration);
    },
  );
  app.post(
    "/api/passkey/register/verify",
    limit,
    authenticated,
    async (req, res) => {
      const wallet = res.locals.wallet as WalletSession;
      const { response } = z
        .object({ response: z.record(z.string(), z.unknown()) })
        .strict()
        .parse(req.body);
      const sessionToken = req.cookies[COOKIE] as string;
      const pending = passkeyChallenges.get(sessionToken);
      passkeyChallenges.delete(sessionToken); // Single use, even on failure.
      if (
        !pending ||
        pending.expiresAt <= Date.now() ||
        pending.address !== wallet.address
      )
        throw new VerificationError(
          "PASSKEY_CHALLENGE_EXPIRED",
          "Passkey request expired. Please try again.",
          400,
        );
      const credential = await verifyPasskeyRegistration(
        passkeys,
        response as unknown as RegistrationResponseJSON,
        pending.challenge,
      );
      const profile = await store.update(wallet.address, {
        ...credential,
        passkeyVerified: true,
        passkeyVerifiedAt: new Date().toISOString(),
      });
      res.json({ verified: true, profile });
    },
  );
  // Serialize simulated trades per wallet so concurrent requests cannot double-spend.
  const cryptoLocks = new Map<string, Promise<unknown>>();
  function withCryptoLock<T>(address: string, run: () => Promise<T>) {
    const previous = cryptoLocks.get(address) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(run);
    const tail = result.catch(() => {});
    cryptoLocks.set(address, tail);
    void tail.then(() => {
      if (cryptoLocks.get(address) === tail) cryptoLocks.delete(address);
    });
    return result;
  }
  app.get("/api/crypto", authenticated, async (_req, res) => {
    const wallet = res.locals.wallet as WalletSession;
    const profile = await store.get(wallet.address);
    res.set("Cache-Control", "no-store").json({
      demo: true,
      feeBps: Number(FEE_BPS),
      assets: cryptoAssets,
      account: profile.cryptoAccount ?? defaultCryptoAccount(),
    });
  });
  app.post("/api/crypto/trade", limit, authenticated, async (req, res) => {
    const wallet = res.locals.wallet as WalletSession;
    const input = z
      .object({
        symbol: z.string().min(1).max(12),
        side: z.enum(["buy", "sell"]),
        amount: z.string().min(1).max(40),
      })
      .strict()
      .parse(req.body);
    const result = await withCryptoLock(wallet.address, async () => {
      const profile = await store.get(wallet.address);
      const { account, trade } = executeCryptoTrade(
        profile.cryptoAccount ?? defaultCryptoAccount(),
        input,
      );
      await store.update(wallet.address, { cryptoAccount: account });
      return { account, trade };
    });
    res.json({ demo: true, ...result });
  });
  app.get("/api/markets", (_req, res) => res.json({ demo: true, markets }));
  app.get("/api/portfolio", authenticated, (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(portfolio);
  });
  app.use("/api/protocol", protocolRouter());
  app.use((_req, res) =>
    fail(res, 404, "NOT_FOUND", "This Atlas endpoint does not exist."),
  );
  const errorHandler: express.ErrorRequestHandler = (
    error,
    _req,
    res,
    _next,
  ) => {
    if (error instanceof z.ZodError) {
      fail(
        res,
        400,
        "INVALID_REQUEST",
        "Please check the values and try again.",
      );
      return;
    }
    if (error instanceof VerificationError) {
      fail(res, error.status, error.code, error.message);
      return;
    }
    if (error instanceof SyntaxError) {
      fail(res, 400, "INVALID_JSON", "The request could not be read.");
      return;
    }
    console.error(
      "Atlas request failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    fail(
      res,
      500,
      "SERVER_ERROR",
      "Atlas could not complete this request. Please try again.",
    );
  };
  app.use(errorHandler);
  return app;
}
