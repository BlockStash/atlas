# Market Control

Independent country-market administration UI. This is a separate React/Vite application, not a page inside Atlas.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:3001. The Atlas backend must be running on port 4000 and configured with `contracts/deployments/sepolia-v2.json`. The dev server proxies read-only configuration/catalog/history API requests; `VITE_API_TARGET` overrides its target. No owner or signer key belongs in this application.

Connect a Sepolia wallet. Reads are public, while each write simulates and requests a wallet signature. Only each selected market's onchain owner can grant/revoke roles, transfer ownership or upgrade. Scoped operators manage stocks, pricing, sessions or pauses according to their role. Token treasury minting uses the settlement token's own MINTER_ROLE.

Use Overview for market sessions/status, Stocks for single/batch onboarding and activation, Price feeds for native/FX/USD-USDT observations, Treasury for distribution, Access for delegated roles and two-step ownership, and Upgrades for validated UUPS implementations. New stock IDs stay unpriced until a fresh observation is published.

Production builds: `npm run build`. Host `dist/` independently and configure a same-origin `/api` reverse proxy to the backend. `npm run preview` serves static output for inspection but does not provide a production API reverse proxy.

See [the full protocol guide](../contracts/README.md) for deployment, pricing-provider inputs, upgrade storage validation, migration and POC boundaries.
