# Shallow ranked-node candidate

Status: **prepared offline; not the viewer default; live quality pending**.

## Confirmed API diagnostic

A separately declared, single-call diagnostic D1 sent the exact prior nested-node request SHA-256 `ef78e067fea178ec46d3b37a011966d6298abb98f4e968b09ddbd9332a59bc7f`, with the repaired error reader. The API again returned HTTP 400, now with a specific serving-state-complexity error. No model text or completion was returned. This identifies the cause of the reproduced request; the original N1 body remains lost, and N1 was not rescored.

Very large or deeply nested schemas can exceed the service's state complexity, as described in the [official structured-output limitations](https://ai.google.dev/gemini-api/docs/structured-output). This is a schema constraint failure, not evidence about translation quality. See [the sanitized diagnostic](node-api-diagnostic.json).

## Shallow representation

The candidate keeps the same source atoms, whole-document context, model, project and local fidelity decoder. It replaces nested objects and integer fields with **651 required root string fields**: 441 atom occurrences plus 210 tail/whole fields. Field names use short opaque hashes with collision extension and a non-numeric prefix to preserve source enumeration order.

An atom field contains `ASCII-rank:preceding prose`. The first colon is the separator; all later colons and LF characters remain prose. Empty preceding prose is allowed. Tail/whole fields are plain strings, with their roles fixed locally. Rank spelling, safe integer range and exact per-block permutation are validated locally without coercing or repairing invalid values.

All fields of a block must arrive before it can be previewed. Local code reconstructs the same original atoms and invokes the existing node checks, including normalized identifier inventories. Missing/bad fields withhold the whole block. Manual repair targets the whole block with full source context. Nested objects, arrays, numeric types, enums, patterns and bounds are absent from the service schema.

Shallowness does not prove API acceptance: 651 required properties may still exceed service limits. Exact atom insertion does not prove the model attached the atom to the right claim or translated every condition. Reordering, comparative scope, negation, names, untagged formulas and prose completeness require independent semantic review.

## Frozen boundary

[flat-node-experiment-plan.json](flat-node-experiment-plan.json) records the source, request and implementation hashes before generation. The model stays `gemini-3.5-flash-lite` in LangTalk. There are 212 source targets: 210 generated and the same two separately retained original blocks. The same 73-source panel is preserved. At most three unchanged calls are allowed, stopping on the first transport, completion, structure, decoder, coverage, 150-second latency or independent semantic-review failure. No automatic retry, repair, prompt/schema adjustment or model judge in this experiment.

Offline tests: **266 passed**. Independent assistant protocol checks confirmed field binding, strict rank parsing, block-atomic streaming, cancellation and full-context repair. Synthetic test prose establishes representation only, not model translation quality. Chrome was not operated; the production factory remains unchanged.
