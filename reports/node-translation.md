# Ranked original-node candidate

Status: **offline prototype; live experiment pending; not the viewer default**.

The model remains `gemini-3.5-flash-lite`, using the same LangTalk project and Interactions endpoint. The prior protected-tag G1 remains rejected. This is a new candidate, not a relaxed re-score of that output.

## What changed

- A detached math accent is associated with its unique overlapping math glyph before baseline grouping. This fixes a bar being pulled into a caption band in the other column. On the paper, only page 4's text segmentation changes: 26 to 25 blocks, reducing total translation targets from 213 to 212. An ambiguous orphan accent marks its source block uncertain.
- Mathematical crops use the containing text line's baseline. Original painted glyph coordinates stay unchanged. Independent source review confirmed the theta/bar union and the position of isolated superscript exponents; 18 source-span baselines change. Scientific coefficients and exponents such as `3e−5` move as one node, and percent signs stay with identifiers such as `ImageNet-1%`.
- Required atom properties replace free-text tag copying. Each atom has `{o: integer, t: string}`, plus a block-level `tail`. Code sorts the exact rank permutation and inserts each original atom after its preceding Japanese prose. It permits Japanese reordering without character offsets. Strings for blocks without atoms keep the existing simple form.
- The source context contains the whole document and interleaved original prose/atom parts. The prompt asks for one natural translation of the whole matching block before dividing its prose into fields, not independent fragment translation.
- Source references, glyph crops and digit-bearing names such as `RN152` remain local. Original spelling survives NFKC-aware identifier detection. The assembled output is also checked against the source identifier multiset to prevent appending a digit or prefix and creating `RN1521` or `RNRN152`.
- Nested duplicate keys (including escaped spellings), foreign/missing fields, invalid order permutations, generated markup/LaTeX/Greek/Unicode Sm operators and free normalized alphanumeric identifiers are rejected. A whole block must finish and pass before a streaming preview appears. Later document-wide errors still roll back previews under the existing viewer orchestration.

## Offline validation and limits

All **258 Node tests passed**, with the final request-fixture change additionally checked by its relevant evaluator test. Independent assistant reviews found and verified fixes for atom-only proper-name rejection, Unicode source/output normalization asymmetry, and identifier concatenation across node boundaries. The math reviewer independently checked six actual scientific expressions and the theta-bar crop. Chrome was not operated.

Replay of 208 previously accepted strings produced 198 exact structural round trips; 10 did not satisfy the new original-identifier/prose checks. These are compatibility diagnostics, not new successful translations, and no failed historical result was rescued. `roundtrip-nodes.mjs` reproduces this offline check.

The candidate has **212 source targets: 210 generated and two explicitly original** (`p3-b21`, `p4-b6`). There are **441 generated atom occurrences**: 105 math, 201 reference and 135 literal identifier nodes. Original retention is counted separately, never as translated coverage. The prior fixed 72-source panel maps to 71 current targets after the page-4 join; two previously diagnosed adjacent blocks are declared before inference, yielding **73 review targets**.

Code guarantees the insertion of each registered original atom only after the required fields and rank permutation validate. It does **not** guarantee the atom's attachment to the correct claim, complete prose coverage, negation, natural phrasing or comparative strength. Formula/identifier boundaries are still extraction-dependent. ASCII formulas and spaced identifier paraphrases require semantic review. English names/bibliographies are allowed; this codec does not broadly prove that all ordinary English prose has been translated.

## Frozen live boundary

[node-experiment-plan.json](node-experiment-plan.json) freezes the exact request, source and implementation (including evaluator/display/export), source coverage and panel. At most three identical full-document calls are allowed: N1, then two confirmations only after passing automatic and independent assistant reviews. Stop at the first failure. No automatic repair, retry, schema/prompt changes, model switch or model-judge request.

For this new representation, the time ceiling is **150 seconds**, declared before its first API call. Extra JSON fields increase output overhead, so this changes the prior 131.4-second condition explicitly, rather than rescuing a measured failure. The previous G1 reference was 113.766 seconds; no same-condition speed improvement is claimed.

The existing keyed factory remains active until this candidate passes its frozen checks. Merge requires user permission; formatter/lint and Release work remain deferred.
