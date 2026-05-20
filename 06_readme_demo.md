# Spec 06 — README Template + Demo Polish

**Paste this into Claude and say:** "Fill in this README template for the Guardian Pipeline repo. Use the project details, research citations, and structure exactly as specified."

---

## Context

This is the final phase. The README is the first thing a recruiter, interviewer, or protocol team sees. It must:
1. Lead with the research gap this project closes.
2. Show the architecture at a glance.
3. Let someone run the project locally in under 5 minutes.
4. Link to the live demo video and dashboard.

---

## README.md template

```markdown
# Guardian Pipeline

[![Invariant CI](https://github.com/YOUR_USERNAME/guardian-pipeline/actions/workflows/invariant-ci.yml/badge.svg)](https://github.com/YOUR_USERNAME/guardian-pipeline/actions/workflows/invariant-ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-≥85%25-brightgreen)](./docs/)
[![Built on Base](https://img.shields.io/badge/Base_L2-0052FF?logo=data:...)](https://base.org)

> An automated DeFi assurance pipeline that bridges the gap between pre-deployment invariant fuzz testing and live on-chain protocol monitoring.

**Demo video:** [Watch 3-min Loom ↗](YOUR_LOOM_URL)  
**Live dashboard:** [guardian-pipeline.vercel.app ↗](YOUR_VERCEL_URL)

---

## Research motivation

This project is grounded in two empirical findings:

- **Bourveau et al. (2024)** — *Decentralized Finance (DeFi) assurance: early evidence* — analysed 8,500+ smart contract audit reports and found that continuous, multi-layered assurance — not one-time audits — is the distinguishing characteristic of protocols that survive. ([Link to paper])

- **Landsman et al. (2025)** — *Auditing Smart Contracts* — found that traditional point-in-time static audits show little empirical evidence of preventing complex runtime exploits, including economic flash-loan attacks and dynamic balance manipulation. ([Link to paper])

**The gap:** No existing open-source tool unifies (a) pre-deployment invariant fuzz testing in a CI pipeline with (b) live on-chain monitoring enforcing those same invariants post-launch. This project builds both layers.

---

## Architecture

```
Git push → GitHub Actions → Forge fuzz (10,000+ runs) → Slither → Report
                                     ↓ validates
              Protocol Contracts (Vault · AMM · Lending) · Anvil fork
                                     ↓ monitors  
  Alchemy RPC → Guardian Bot → Eval Engine → Alert Router → Discord + Dashboard
```

Three layers:
1. **CI/CD layer** — Foundry invariant fuzz tests run on every commit. Green badge = all 8 invariants hold across 10,000 randomised call sequences.
2. **Smart contract layer** — A simple over-collateralised lending vault with 8 mathematical invariants defined as NatSpec assertions and Foundry handlers.
3. **Runtime guardian** — TypeScript bot on Base L2. On each block, fetches vault state, evaluates invariants, and fires structured Discord alerts within one block of a violation.

![Architecture diagram](docs/architecture.png)

---

## The 8 invariants

| ID | Name | Formula |
|---|---|---|
| INV-01 | Solvency | `totalBorrowed ≤ totalDeposited` |
| INV-02 | Liquidity buffer | `tokenBalance(vault) ≥ totalDeposited - totalBorrowed` |
| INV-03 | Share price floor | `sharePrice ≥ 1e18` |
| INV-04 | Share accounting | `totalShares = Σ userShares[i]` |
| INV-05 | Collateral cap | `∀u: userBorrowed[u] ≤ userShares[u] × sharePrice / 1e18 × collateralRatio` |
| INV-06 | No share inflation | `sharePrice × totalShares / 1e18 ≤ totalDeposited` |
| INV-07 | Non-negative net | `totalDeposited ≥ totalBorrowed` |
| INV-08 | Zero-state consistency | `totalShares == 0 ↔ totalDeposited == 0` |

---

## Foundry counterexample

When INV-01 was deliberately broken during development, Forge produced this call sequence:

![Counterexample](docs/counterexample.png)

This is the empirical validation that the fuzz harness catches violations Landsman et al. (2025) describe as missed by static analysis.

---

## Quickstart

### Prerequisites

- [Foundry](https://getfoundry.sh/) installed
- Node.js ≥ 20
- Alchemy API key (free tier works)
- Discord webhook URL

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/guardian-pipeline
cd guardian-pipeline
forge install
cd guardian && npm install
```

### 2. Configure environment

```bash
cp guardian/.env.example guardian/.env
# Edit guardian/.env with your keys
```

### 3. Run the invariant test suite

```bash
# Fast (CI config)
forge test --match-contract InvariantVault -vvv

# Deep (10,000 runs)
FOUNDRY_PROFILE=deep forge test --match-contract InvariantVault -vvv
```

### 4. Deploy to Base Sepolia

```bash
source guardian/.env
forge script script/DeployVault.s.sol --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
# Copy the deployed address into guardian/.env → VAULT_ADDRESS
```

### 5. Start the Guardian bot

```bash
cd guardian
npm run dev
```

### 6. Trigger the demo exploit (separate terminal)

```bash
cast send $VAULT_ADDRESS "attack()" \
  --private-key $ATTACKER_KEY \
  --rpc-url $BASE_SEPOLIA_RPC
```

Guardian detects the violation on the next block. Discord alert fires. Dashboard turns red.

---

## Repo structure

```
guardian-pipeline/
├── src/                  # Solidity contracts
├── test/invariant/       # Foundry fuzz harness + handlers
├── .github/workflows/    # CI/CD pipeline
├── guardian/             # TypeScript Guardian bot
├── dashboard/            # React monitoring dashboard
└── docs/                 # Architecture diagram, screenshots
```

---

## Tech stack

| Layer | Tools |
|---|---|
| Smart contracts | Solidity 0.8.24 · OpenZeppelin · Foundry/Forge · Anvil · Cast |
| Static analysis | Slither · Aderyn |
| CI/CD | GitHub Actions |
| Guardian bot | TypeScript · viem · Alchemy SDK · WebSocket · pino |
| Alerts | Discord webhooks |
| Dashboard | React · Vite · Supabase real-time |
| Deploy | Vercel (dashboard) · Base Sepolia (contracts) |

---

## Related work

This project extends concepts from a prior Rust-based prototype — [Guardian of the Chain](YOUR_PREVIOUS_REPO_LINK) — which demonstrated that on-chain invariant monitoring could have detected the Euler Finance exploit 7 minutes early. This version adds the CI/CD pre-deployment layer, Base L2 targeting, a React dashboard, and academic grounding.

---

## Licence

MIT
```

---

## Loom demo script (3 minutes)

Record in one take. No editing needed.

**Minute 0:00–0:30 — The research gap**
- Screen: Open the GitHub repo README. Scroll to "Research motivation."
- Narrate: "Landsman et al. (2025) found that static audits miss runtime exploits like flash-loan attacks. Bourveau et al. say continuous assurance is what separates surviving protocols. This project builds both layers."

**Minute 0:30–1:00 — CI passing**
- Screen: GitHub Actions tab, all 5 jobs green.
- Click into `invariant-fuzz` job. Show the `forge test` output with 8 passing invariants.
- Narrate: "On every commit, Foundry runs 2,000 randomised call sequences. All 8 invariants pass."

**Minute 1:00–1:45 — Guardian bot live**
- Screen: Split — bot terminal (left), Discord channel (right).
- Bot terminal showing structured pino logs: `{"block":12345678,"allPassed":true,"latencyMs":1.4}`.
- Narrate: "The Guardian bot checks invariants on every Base Sepolia block. Currently all healthy."

**Minute 1:45–2:30 — Triggering the exploit**
- Screen: Third terminal. Run `cast send ... "attack()"`.
- Switch back to bot terminal. On next log line, violation fires: `{"block":12345679,"violations":["INV-01","INV-02"],"latencyMs":1.9}`.
- Discord embed appears. Show it full-screen.
- Narrate: "1.9 seconds. The Guardian caught the solvency violation on the next block."

**Minute 2:30–3:00 — Dashboard**
- Screen: Open Vercel dashboard URL.
- INV-01 and INV-02 cards are red. Alert feed shows the violation with Basescan link.
- Narrate: "The dashboard updates in real time via Supabase subscriptions. This is the continuous assurance layer Bourveau et al. described."

---

## Final checklist before sharing

```
☐  forge test --match-contract InvariantVault -vvv  →  all green
☐  GitHub Actions all 5 jobs green on main branch
☐  Slither report committed to docs/
☐  counterexample.png in docs/
☐  Vercel dashboard live and loading
☐  Discord alert fires on attack() call
☐  Loom link in README
☐  Both paper citations in README with descriptions
☐  rahilbhavan.com updated with project card
☐  .env.example committed (no real keys)
☐  .env in .gitignore
```
