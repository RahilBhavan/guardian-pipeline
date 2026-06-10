# CLAUDE.md

Behavioral rules for coding work in this repo. Project-specific stack details live elsewhere (READMEs, docs/).

---

## 1. Spec before code

Most failures are spec failures. Resolve ambiguity before the first line.

- State assumptions in plain text: `ASSUME: <claim>. Proceed?`
- Two interpretations → list both. Do not pick silently.
- Confused → stop, name the confusion in one sentence, ask one question.
- "I'll figure it out as I go" is forbidden.

✅ `ASSUME: validate at the handler boundary; reject empty as 400. OK?`
❌ Start coding "validation" with no agreed definition of valid.

## 2. Minimum diff

Smallest code that meets the spec. Speculation is a defect.

- No abstraction for a single use-site.
- No flags, DI, interfaces, or "extensibility" unless requested.
- No error handling for impossible cases. Trust internal invariants.
- 200 lines that should be 50 → discard, write 50.

✅ One inline function at the call site.
❌ `IFooStrategy` + factory + three implementations for one caller.

## 3. Surgical edits

Every changed line traces directly to the request.

- No reformatting, renames, comment polish, or import reordering in passing.
- Match local style even when you disagree.
- Spot adjacent dead code → mention in summary, do not delete.
- Remove only imports/vars that *your* change orphaned.

✅ Bug fix touches 4 lines in `auth.ts`. End of diff.
❌ Bug fix in `auth.ts` that also reflows 30 lines and renames `usr` → `user`.

## 4. Goal → verify loop

Every task has an automatic check. Loop until green.

Rewrite the task as a check before coding:

| Task | Check |
|------|-------|
| Add validation | 5 invalid inputs return 400 |
| Fix the bug | Failing test reproduces it, then turns green |
| Refactor X | Existing test suite passes before and after |
| Add feature Y | New test asserting Y, green |

For multi-step work, plan up front:

```
1. <step> → verify: <command or assertion>
2. <step> → verify: <command or assertion>
3. <step> → verify: <command or assertion>
```

Loop locally until each `verify` passes. Paste the green output. No "should work."

## 5. Build up to the claim

A hard goal is met by building the missing artifact — never by weakening the claim.

- No relabeling, softened prose, or dropped verify targets to make reality fit.
- Documenting partial coverage as "done" is a violation.
- If the full claim is genuinely out of scope → stop and say so. Do not silently narrow it.

✅ Write the missing test/code so coverage actually hits the target.
❌ Edit the README/labels/verify list down to what already passes.

---

## Failure modes — these are violations

| What you did | What to do instead |
|---|---|
| Started coding to "see what works" | State assumptions, get confirmation |
| Added an interface + factory for one call site | Inline the function |
| Reformatted the file you edited | Restrict diff to the requested change |
| Reported "done" without running the check | Run it, paste the output |
| Picked one of two interpretations silently | Surface both, let the user pick |
| Deleted "obviously dead" adjacent code | Mention it in the summary, leave it |
| Wrote 200 lines | Throw out, write 50 |
| Weakened a claim/label/README to match what already passes | Build the missing artifact, or stop and say the claim is out of scope |
