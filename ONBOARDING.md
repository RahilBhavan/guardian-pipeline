# Welcome to Guardian Pipeline

## How We Use Claude

Based on rahilbhavan's usage over the last 30 days:

Work Type Breakdown:
  Plan Design      ████████████████████  36%
  Build Feature    ███████████████░░░░░  27%
  Debug Fix        ██████████░░░░░░░░░░  18%
  Improve Quality  █████░░░░░░░░░░░░░░░  9%

Top Skills & Commands:
  /goal   ████████████████████  5x/month
  /clear  ████████████████░░░░  4x/month

Top MCP Servers:
  Supabase  ████████████████████  25 calls
  Vercel    ███░░░░░░░░░░░░░░░░░  4 calls

## Your Setup Checklist

### Codebases
- [ ] [guardian-pipeline](https://github.com/rahilbhavan/guardian-pipeline) — clone and run `make install && make verify`

### MCP Servers to Activate
- [ ] **Supabase** — alert store + dashboard read path
- [ ] **Vercel** — dashboard deployment

### Skills to Know About
- `/goal` — session anchor for multi-step work
- `/clear` — reset context between unrelated tasks
- `/bootstrap-project` — generate project-specific CLAUDE.md

## Team Tips

- Read [docs/assurance.md](docs/assurance.md) first — AMC is the project's thesis.
- Never commit `.env` files; bot writes need `SUPABASE_SERVICE_KEY`.
- Branch off `main`; CI runs 7 jobs including mirror-parity and assurance gates.

## Get Started

1. `forge test` — contract + fuzz suite (no external services).
2. `cd assurance && npm test` — AMC tooling tests.
3. Follow [docs/setup.md](docs/setup.md) for Base Sepolia + bot + dashboard.
4. Optional: run the staged detection demo (`./scripts/staged-detection-demo.sh`) — see the [staged detection demo](README.md#the-staged-detection-demo) section.
