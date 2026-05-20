# docs/

| File | Status | How to produce |
|---|---|---|
| `architecture.svg` | ✅ committed | Hand-authored SVG of the three-layer pipeline. |
| `architecture.png` | ⬜ optional | Export `architecture.svg` to PNG if a raster is needed for the README. |
| `counterexample.png` | ⬜ screenshot | See below — capture the Forge counterexample terminal output. |
| `aderyn-report.md` | ⬜ generated | Produced by the `static-analysis` CI job (or `aderyn .` locally). |

## Capturing `counterexample.png`

The fuzz harness is only convincing if you can see it *fail*. To produce the
counterexample screenshot:

1. In `src/Vault.sol`, temporarily replace the body of `borrow()` with the
   forced violation:

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

4. **Restore `borrow()`** to the correct implementation and re-run the suite to
   confirm all 8 invariants pass again.
