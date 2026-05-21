# Documentation

| Document | Contents |
|----------|----------|
| [architecture.md](architecture.md) | The four layers and how state flows between them |
| [invariants.md](invariants.md) | All 8 invariants — formulas, failure modes, coverage matrix |
| [setup.md](setup.md) | End-to-end local setup, Base Sepolia deployment, and the demo |
| [assurance.md](assurance.md) | The Assurance Score, exploit replays, and audit traceability |

New here? Start with the [root README](../README.md), then
[architecture.md](architecture.md).

---

## Assets

| File | Status | How to produce |
|------|--------|----------------|
| `architecture.svg` | committed | Hand-authored SVG of the multi-layer pipeline |
| `architecture.png` | optional | Export `architecture.svg` to PNG if a raster is needed |
| `counterexample.png` | screenshot | See below |
| `aderyn-report.md` | generated | Produced by the `static-analysis` CI job (or `aderyn .` locally) |

## Capturing `counterexample.png`

The fuzz harness is only convincing if you can see it *fail*. To produce the
counterexample screenshot:

1. In `src/Vault.sol`, temporarily replace the body of `borrow()` with a forced
   violation:

   ```solidity
   // BUG: forced INV-01 violation — delete after screenshot
   totalBorrowed = totalDeposited + 1;
   ```

2. Run the deep profile:

   ```bash
   FOUNDRY_PROFILE=deep forge test --match-contract InvariantVault -vvv
   ```

3. Forge prints a shrunk counterexample call sequence under
   `[FAIL] invariant_solvency()`. Screenshot that terminal output and save it
   here as `counterexample.png`.

4. **Restore `borrow()`** and re-run the suite to confirm all 8 invariants pass
   again.
