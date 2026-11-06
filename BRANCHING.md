# Branch Strategy

A lightweight flow for a small team shipping fast: one demo-ready branch, one integration branch, short-lived work branches.

```
feat/*, fix/*, contracts/*  ──PR──▶  stage  ──PR (release)──▶  main
                                                                  │
hotfix/*  ◀───────────── branched from main ──────────────────────┘
          ──PR──▶ main, then main is merged back into stage
```

## Long-lived branches

| Branch  | Purpose                                                        | Who pushes                  |
| ------- | -------------------------------------------------------------- | --------------------------- |
| `main`  | Always demo-ready. What judges/users see. Matches deployed contracts in `contracts/deployments/`. | PR only, from `stage` or `hotfix/*` |
| `stage` | Integration branch. Everything merges here first and gets tested together. | PR only, from work branches |

No direct pushes to either. Protect both on GitHub (Settings → Branches): require a PR, require 1 approval, require the checks below to pass.

## Work branches

Branch from `stage`, keep them small, delete after merge.

| Prefix        | Use for                                           | Example                          |
| ------------- | ------------------------------------------------- | -------------------------------- |
| `feat/`       | New user-facing feature                           | `feat/passkey-login`             |
| `fix/`        | Bug fix found on `stage`                          | `fix/localhost-origin`           |
| `contracts/`  | Solidity changes, deployments, upgrades           | `contracts/stock-onboarding-v2`  |
| `chore/`      | Tooling, deps, config, docs                       | `chore/prettier-config`          |
| `hotfix/`     | Urgent fix to `main` (branch from `main`)         | `hotfix/price-feed-crash`        |

Optionally scope by app: `feat/frontend-trade-page`, `fix/backend-worldid-nonce`, `feat/admin-new-stock`.

## Day-to-day

```sh
git switch stage && git pull --rebase
git switch -c feat/my-thing
# ...commit...
git fetch origin && git rebase origin/stage   # keep current, avoids "Merge branch 'main' of ..." noise
git push -u origin feat/my-thing
# open PR → stage
```

- Set `git config pull.rebase true` so pulls don't create merge commits.
- **Squash-merge** work branches into `stage` (one clean commit per change).
- **Merge-commit** (no squash) `stage` → `main`, so history between the two stays aligned.

## Required checks before merging

Into `stage`:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
```

Into `main` (release), additionally:

```sh
npm run build
npm run test:smoke
npm run protocol:smoke      # if contracts changed
npm run upgrade:validate    # if upgradeable contracts changed
```

## Contracts & deployments

Contract changes are the one thing you can't roll back with `git revert`, so they get extra care:

1. Do all Solidity work on a `contracts/*` branch; run `npm run protocol:test` and `npm run upgrade:validate`.
2. Deploy to Sepolia **from that branch only after review**, then commit the updated `contracts/deployments/*.json` and `contracts/abi/` in the same PR.
3. A deployment manifest on `main` must always match what is live on Sepolia — the frontend/backend read it.
4. Never change storage layout of an upgradeable contract without `upgrade:validate` passing.

## Secrets

`.env` files are never committed — only `*.env.example`. If a key (World ID signing key, deployer private key, RPC key) is ever pushed, rotate it immediately; removing it from history is not enough.

## Releases

When `stage` is stable, open a PR `stage → main` titled `release: <short description>`. After merge, tag it:

```sh
git switch main && git pull
git tag -a v0.x.0 -m "release: ..." && git push origin v0.x.0
```

Tag the version shown at a demo or submission so it can always be reproduced.

## Hotfixes

```sh
git switch main && git pull
git switch -c hotfix/thing
# fix, PR → main, merge
git switch stage && git merge origin/main && git push   # bring the fix back into stage
```
