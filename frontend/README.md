# Atlas frontend

Next.js App Router frontend for the Atlas investor experience. From the repository root, run `npm run setup` then `npm run dev` and open http://127.0.0.1:3000.

Routes: `/`, `/onboarding`, `/dashboard`, `/markets`, `/portfolio`, `/wallet`.

The central `AtlasProvider` owns wallet/session state and all onboarding preferences. Financial data comes from the backend via the `/api` Next.js proxy. Browser persistence is best effort; server profiles are authoritative. Demo controls depend on `.env.local` flags and corresponding backend flags.

`npm run typecheck`, `npm run lint`, and `npm run build` validate this project. See the root README for configuration and the demo walkthrough.
