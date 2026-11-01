# Compact per-block ranked records

Status: **offline prepared; not the viewer default; API acceptance and quality pending**.

The repeated nested request and then the shallow 651-field candidate were both rejected with explicit serving-state complexity. Those outcomes remain failures with no model text. This separate candidate returns to **one required string per block**, matching the general schema shape already used by the viewer.

## Encoding and boundary

There are 210 required root string properties. For a block with k registered atoms, its string contains exactly k+1 LF-separated lines. The first k lines are fixed source slots, each encoded as `Japanese-rank:preceding prose`. The last line is the tail and has no rank. A blank tail retains the final LF. Blocks without atoms remain ordinary prose strings.

The line position identifies the original source atom; its rank independently identifies its Japanese occurrence order. Local code checks exact line count, strict ASCII ranks, the exact rank permutation, original-identifier inventory and existing source checks before inserting original math/reference/identifier values. A complete JSON member and all valid records are required for a preview. No trimming, guessing, repair or general unescaping is used. Prose inside one record cannot contain LF; within-block formatting breaks must be represented with spaces.

**Per-atom fields are no longer required by the API schema.** Their record count is a local requirement. This removes service complexity at the cost of positional source-slot risk. Models can swap the prose associated with two source slots while preserving all ranks and original atoms. Reviewers reproduced a valid-looking comparison that reverses which model is older and stronger. Extra LF and a missing record can also cancel in the count. Therefore successful parsing/inventory is not evidence of claim attachment, complete translation, negation or comparative correctness.

## Verification before inference

All **271 tests passed**. The prompt clarification was additionally checked by the relevant four tests. Independent assistant reviews confirmed empty-tail preservation, first-colon rank parsing, atomic withholding/repair, full source context, cache retention and cancellation. They explicitly identified the semantic limitations above. The simple examples are representation fixtures, not model-quality evidence. Chrome was not operated.

[compact-node-experiment-plan.json](compact-node-experiment-plan.json) freezes the request, source, implementation and 73-source review panel. It keeps the same Flash-Lite model, LangTalk project, 212 source targets (210 generated, two separately original) and whole-document context in one request. At most three identical calls are permitted, stopping at the first failure. The 150-second ceiling and all semantic requirements are fixed before C1. No automatic retry, repair, schema relaxation, prompt change or model judge is allowed inside this experiment.

The existing keyed viewer factory remains active. This prototype is not enabled pending API acceptance and full independent quality checks. Merge still requires user permission.
