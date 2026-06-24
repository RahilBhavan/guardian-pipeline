# Social — X/Twitter content

Launch content for Guardian Pipeline. Three threads plus a 3-day schedule of
5 tweets/day. Written to be copy-pasted straight into X.

## Posting principles (baked into the copy below)

- **Tweet 1 of a thread carries no link.** X throttles reach on link tweets, so
  the link lives in the final tweet or a reply.
- **One idea per tweet.** Lead with the number, not the adjective.
- **Tag only where the tweet is genuinely about that tool or team.** Confirm
  every handle before posting: `@foundry_rs`, `@trailofbits`, `@CyfrinUpdraft`,
  `@base`, `@CertoraInc`, `@FortaNetwork`, `@supabase`.
- **Do not @-tag individual researchers from the main tweets** — it reads as
  cold spam. If you want eyes from a specific person, reply to your own thread
  and mention them there with a reason.
- **Honesty framing is the differentiator, not a hedge.** Leaning into "here is
  what this is not" is what makes it credible to the audience that matters.

---

# THREAD 1 — The thesis

**Image plan:** attach `docs/architecture.svg` to **tweet 3**. Tweet 1 stays
text-only so nothing competes with the hook.

**1/**
```
An audit is a snapshot. It tells you your code looked sound the day it was signed. It says nothing about the parameters, the market, or the attacker that shows up eight months later.

I built a research demo around the obvious follow-up question.
```

**2/**
```
What if the properties you fuzz before deploying are the exact same ones you watch after?

Usually they aren't. Pre-deploy fuzzing and post-deploy monitoring (@FortaNetwork and peers) are built as separate tools, checking separately-written properties. They drift apart quietly.
```

**3/** _(image: docs/architecture.svg)_
```
So Guardian Pipeline writes the properties once. Twelve invariants. Then it enforces that same definition on both sides of deploy: a Foundry fuzz campaign in CI, and a runtime monitor whose checks mirror the harness function for function.
```

**4/**
```
The monitor is not a sampled approximation. It is a 1:1 mirror of the Solidity invariants. It reads every account from vault events and checks exact per-user state. A CI job fails the build the moment the two sides drift out of sync.
```

**5/**
```
Worth saying plainly: this is a portfolio and research project, not production infrastructure. The vault is a teaching example. The score is self-graded. The idea is the deliverable.

Code and a one-page writeup: github.com/rahilbhavan/guardian-pipeline
```

---

# THREAD 2 — What is behind the green badge

**Image plan:** terminal screenshot of `forge test` passing on **tweet 2**; a
mutant test failing on the corrupted vault on **tweet 4** (optional).

**1/**
```
"Twelve invariants, fuzzed" is easy to put on a badge. Here is what is actually behind it, and how I keep myself honest about which of those invariants are real and which are just bookkeeping.
```

**2/** _(image: forge test output)_
```
Every push runs a 2,000-run Foundry campaign against the vault. Up to roughly 300,000 handler calls. Green means all twelve invariants survived the whole campaign without a single failure.

Foundry (@foundry_rs) does the heavy lifting here.
```

**3/**
```
But the twelve are not equal, and the repo says so. Some are accounting identities. Some are structural. Around eight are fuzz-tensioned, meaning one wrong rounding direction breaks them. INV-01 caught a real one-wei solvency leak during development.
```

**4/** _(optional image: a mutant test catching the break)_
```
How do I know the fuzzer would actually catch a break? Mutation testing. Each load-bearing invariant has a paired mutant that corrupts the vault on purpose and asserts the matching check fires. A test that cannot fail is not a test.
```

**5/**
```
And ten historical exploit classes, each replayed against an attackable variant and the real vault. Ten prevented, zero missed. CI regenerates that line in the README so it cannot quietly rot.

Built on Slither (@trailofbits) and Aderyn (@CyfrinUpdraft).
```

---

# THREAD 3 — A self-graded score, and why I say so loudly

**Image plan:** screenshot of the traceability matrix or the AMC score panel on
**tweet 4**. Tweet 1 stays text-only.

**1/**
```
Most audit scores are a feeling with a number attached to it. I built a self-grading assurance score for my own project, and then spent more words on what it is not than on what it is. That was the point.
```

**2/**
```
The AMC score is gated in CI at 80 and regenerated on every commit. Three parts: static verification at 45%, exploit resistance at 35%, finding traceability at 20%.
```

**3/**
```
Here is the honest part. I write the invariants, pick the exploit set, tag the findings, and grade the result. So the score measures methodology rigor, not security. Read it as "this codebase grades itself against the rubric it ships," not a third-party certification.
```

**4/** _(image: traceability matrix / AMC panel)_
```
The piece I am actually proud of is traceability. Every review finding is bound to at least one invariant, one harness test, and one monitor check. Eight of eight covered, zero gaps, and CI fails if that matrix drifts from the README.
```

**5/**
```
Stated gaps, on purpose: no formal verification yet (@CertoraInc, the open door), the monitor has never faced a real attacker, and the review is a self-review.

Naming the gaps is the methodology. github.com/rahilbhavan/guardian-pipeline
```

---

# 3-DAY SCHEDULE — 5 tweets/day

Slots: 9:00, 12:00, 15:00, 18:00, 20:00. Image notes are per tweet.

## Day 1 — The problem and the idea

**9:00**
```
An audit attests that your code looked sound the day it was signed. It cannot speak to the market eight months later. Guardian Pipeline is a research demo of the alternative: prove your safety properties before deploy, then watch the same ones after.
```

**12:00**
```
The quiet failure mode in smart-contract security: your pre-deploy fuzzer and your post-deploy monitor check separately-written properties. They drift. Guardian Pipeline writes the twelve invariants once and runs both sides off that single definition.
```

**15:00** _(image: docs/architecture.svg)_
```
Four layers. A Foundry fuzz campaign in CI. The vault itself. A TypeScript monitor that mirrors the harness. An assurance layer that scores the whole thing. Built on Base Sepolia (@base). Diagram below.
```

**18:00**
```
Scope, stated up front, because the project insists on it. This is not production infrastructure. The vault is a teaching example. The hosted monitor is best-effort. The score is self-graded. The idea is the product.
```

**20:00**
```
The framing comes from two empirical papers on DeFi audit markets, Bourveau et al. 2024 and Landsman et al. 2025. Both find that audit effectiveness is an open question. Guardian Pipeline is one design response to that, not a claim either paper makes.
```

## Day 2 — How it works

**9:00** _(image: forge test output)_
```
Every push runs a 2,000-run Foundry campaign, up to roughly 300,000 handler calls. The green badge means all twelve invariants survived without one failure. Foundry (@foundry_rs) underneath. Output below.
```

**12:00**
```
The twelve invariants are not equal, and the repo says so. Some are accounting identities. Some are structural. Around eight are fuzz-tensioned, where one wrong rounding direction breaks them. INV-01 caught a real one-wei solvency leak during development.
```

**15:00**
```
How do I know the fuzzer would catch a break, not just pass? Mutation testing. Each load-bearing invariant has a mutant that corrupts the vault on purpose and asserts the matching check fires. A test that cannot fail proves nothing.
```

**18:00** _(image: a Solidity invariant_* fn next to its evaluator.ts mirror)_
```
The off-chain monitor is a 1:1 mirror of the Solidity invariants, not a sampled proxy. It reads every account from vault events and checks exact per-user state. A CI job fails the build if any harness invariant has no matching monitor check.
```

**20:00**
```
Ten historical exploit classes, each replayed against an attackable variant and the real vault. Ten prevented, zero missed. CI regenerates that sentence in the README so it cannot quietly rot. Built on Slither (@trailofbits).
```

## Day 3 — Assurance, runtime, and the honest close

**9:00**
```
Most audit scores are a feeling with a number attached. The AMC score here is gated in CI at 80 and regenerated every commit, and it measures methodology rigor, not security. I grade my own work, so I say that loudly.
```

**12:00** _(image: traceability matrix / AMC panel)_
```
Traceability matrix: every review finding bound to at least one invariant, one harness test, and one monitor check. Eight of eight covered, zero gaps, and CI fails if it drifts from the README. Screenshot below.
```

**15:00**
```
The runtime monitor is TypeScript and viem. It checks all twelve invariants per block and writes violations to Supabase (@supabase). Two modes: a per-block daemon, and a free scheduled GitHub Actions pass against the public demo vault. Best-effort, not an SLA.
```

**18:00** _(image: live dashboard at guardian.rahilbhavan.com)_
```
Live dashboard, all twelve invariants plus the score panels and realtime alerts: guardian.rahilbhavan.com. The detection demo is staged. A planted flag forces a violation and the monitor catches it on the next block. Staged, not a caught attack.
```

**20:00**
```
The gaps, stated on purpose. No formal verification yet (@CertoraInc, this is the open door). The monitor has never faced a real attacker. The review is a self-review. Naming the gaps is the methodology. github.com/rahilbhavan/guardian-pipeline
```

---

# Image checklist (capture before posting)

| Image | Goes on | How to get it |
|---|---|---|
| `docs/architecture.svg` | Thread 1 T3, Day 1 15:00 | Already in repo |
| `forge test` terminal output | Thread 2 T2, Day 2 9:00 | Run `forge test`, screenshot the pass summary |
| Mutant test failing | Thread 2 T4, Day 2 15:00 | Run a `test/mutant/MutantINV*.t.sol`, screenshot the catch |
| Solidity invariant next to its TS mirror | Day 2 18:00 | Screenshot an `invariant_*` fn beside its `guardian/src/evaluator.ts` mirror |
| Traceability matrix / AMC panel | Thread 3 T4, Day 3 12:00 | Screenshot the table in `docs/assurance.md` or the dashboard score panel |
| Live dashboard | Day 3 18:00 | Screenshot guardian.rahilbhavan.com |

# Handles to verify

`@foundry_rs` · `@trailofbits` · `@CyfrinUpdraft` · `@base` · `@CertoraInc` ·
`@FortaNetwork` · `@supabase`
