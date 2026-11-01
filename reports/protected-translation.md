# Original-glyph protection candidate

Status: **G1 rejected; G2/G3 not run; not the default viewer translator**.

The existing keyed translator remains the production default. Prior B/P/M experiment failures remain failures; this is a separate, frozen candidate.

## Source and transport

- Paper: <https://arxiv.org/pdf/2301.08243>, 17 pages.
- The narrow TeX overprinted-accent layout fix is committed as `8626f66`. It joins the RCDM paragraph rather than asking the model to reconstruct a formula split across five blocks. Only two pages change text segmentation; targets change from 217 to 213.
- Original mathematical glyph bounds remain local. The model receives opaque math/reference tags and their original source meanings as context, plus the entire document. Its output contains translations and copied tags, without repeating the original prose.
- Each target requires its own exact tag multiset. Reordering is allowed for Japanese grammar, while missing, duplicate, foreign, malformed and cross-target tags are withheld. Reference numbers are restored locally. Math is rendered from the original PDF crop, bypassing LaTeX reconstruction and font substitution.
- The two uncertain source blocks, `p3-b21` and `p4-b6`, remain original. They account for 1,079 of 70,788 target characters (about 1.52%). The candidate generates 211 blocks. Original retention is counted separately in orchestration and completion status; it is not reported as successful translation of those blocks.

## Offline verification

- `node --test tests/*.test.mjs`: 243 tests passed, including candidate request capture/replay, source-bound tag validation, streaming withholding, original retention, view switching, crop geometry, export density and saved-PDF text extraction.
- A synthetic Japanese geometry fixture on the actual page 16 was exported and rendered with Poppler. The original hat, omega, subscript and norm glyphs remained visible. This is a rendering check, not a semantic translation score or an all-page visual audit.
- Independent assistant reviewers found and verified fixes for two regressions: math images remaining visible over the original view, and embedding a clipped full source page duplicating unrelated PDF text once per formula. Export now embeds only glyph PNGs, at a fixed minimum 216 dpi independent of view zoom. These images do not add selectable math text; the existing original text beneath white overlays remains a known export limitation.
- A protected inventory does not prove claim alignment or mathematical meaning. Untagged Latin variables, ASCII expressions (`x^2`, `x/y`, `x*y`) or Unicode subscripts can still be redundantly generated; fixed-source semantic review explicitly checks these. Extra Greek/Unicode Sm operators, generated LaTeX, C0 characters other than LF and tag-like markup are rejected. Unprotected literal dollar signs retain the source block explicitly, avoiding ambiguity with the existing inline-math renderer.
- Chrome was not operated. No additional model requests were used for these checks or assistant reviews.

## Live gate

The separate frozen plan records the exact input, implementation and request hashes before generation. The maximum is three unchanged full-document calls: first test, then two confirmations. Stop at the first transport, structural, protection, coverage, latency or independent assistant semantic-review failure. No repair, retry, split request, model judge or prompt tuning is allowed inside this experiment.

The fixed 40-source panel is mapped by exact source text or unambiguous bounding-box containment after layout joins. Adding all mathematical targets yields 72 unique target blocks. Original fallback coverage remains explicit. The latency ceiling is 131.4 seconds, retaining 1.25 times the prior 105.12-second unchanged baseline; a single baseline is not evidence of a speed improvement.

Only a candidate that passes all three calls and source reviews can replace the default factory. Merge still requires the user's review and permission. Formatter/lint work remains deferred until after that merge.

## G1 result and decision

The single frozen call completed in **113.766 seconds** (first text 4.981 seconds). All **211/211** required properties arrived with no unknown, duplicate or empty properties. Latency passed the 131.4-second ceiling, but protection and content gates failed. **208 generated translations were accepted, three withheld, and two separately retained as original**; 210/213 source targets were accounted for by the safe output map. Output usage was 22,302 tokens. Initial-token and usage fields are retained verbatim in the metrics, without inferring a bill.

| Source target | Exact protection failure |
| --- | --- |
| `p3-b0` | The reference tag for `[4, 5, 18]` was omitted, despite its presence in both context and the property instruction. |
| `p3-b3` | Math variable `z` had its tag kind changed from `<m_f3db/>` to `<r_f3db/>`. This is tag corruption, not a different actual bibliography entry. |
| `p16-b12` | The tag for the unseen test image representation `sy` was omitted. The rejoined RCDM paragraph and other formula tags did not prevent this omission. |

There were 306 expected target tags and 304 syntactically valid output tags: three expected IDs were absent and one foreign tag replaced the corrupted math tag. Missing tags were never appended automatically or guessed into place. Invalid translations were withheld by the actual candidate parser; the raw strings were used only for diagnostics.

Three independent assistant reviewers compared all **72 fixed panel targets**: 70 generated targets (67 parser-accepted, three withheld) and two explicit original fallbacks. This was not human scoring and used no additional Gemini judge calls. Findings included:

- **Accepted content failure:** `p5-b25` changed the model identifier `RN152` to `RN151`, while its math/reference tags passed.
- **Accepted content failure:** `p15-b31` weakened an asserted performance drop to a possibility. `p2-b25` also used an incorrect technical term for an off-the-shelf evaluation.
- **Scope/fluency concerns:** `p1-b35` can overstate the reduced-prior-knowledge comparison; `p3-b1` has an ambiguous input/target-image relationship. Cross-page sentence continuations remain awkward in `p6-b60` and adjacent `p7-b51`.
- **Additional context diagnostic, outside the frozen panel:** reading `p6-b28` to resolve the continuation of `p5-b80` found an omitted qualification about avoiding hand-crafted augmentations. This is recorded separately, not added to the fixed panel after seeing results.
- The reviewers did not identify unrelated-paragraph substitution or a cascade of shifted assignments within the fixed panel. Correct Japanese reordering in `p12-b5` retained the associated ViT/VISSL references. They did not find a clear extra untagged ASCII formula/subscript reconstruction in the reviewed generated targets. These bounded observations do not establish general reliability.

### Additional source geometry defect

The review found another extraction issue at `p4-b20`/`p4-b21`: a detached overbar belongs to the target encoder's `theta-bar`, but appears at the end of the preceding block and is not protected. Its baseline is 272.035, while the theta baseline is 274.664 in scale-1 viewport coordinates. The protected theta crop is `[439.408, 267.450, 444.684, 276.897]`. An offline Poppler crop using those bounds excludes the bar visible in the original page. Therefore source-glyph reuse alone does not prove preservation when the source bounds are incomplete. This was not reclassified as a successful formula after generation, and no Chrome UI check was performed.

### Stop and next boundary

**G1 failed; G2/G3 were not run. Exactly one new generation request was made.** The original factory remains active. Neither the frozen prompt nor its decoding rules were relaxed to rescue this output. The prototype is retained for reproducibility, not enabled in the viewer. The earlier layout join fixes are distinct from adoption of this translation protocol.

Further local tag spelling or copy instructions cannot guarantee exact output: the model still has to reproduce each identifier and can also change unprotected model names and claim strength. The next design needs to address detached accents and block boundaries offline, then consider structured math/reference nodes or a different target granularity. That would be a separate plan and experiment, with request-count and Japanese-word-order tradeoffs stated before any new generation.

Frozen plan: [protected-experiment-plan.json](protected-experiment-plan.json). Sanitized metrics: [protected-translation-evaluation.json](protected-translation-evaluation.json). Raw requests/responses and review panels remain local under `/private/tmp/pdf-viewer-protected-frozen-2/`; API keys were neither printed nor stored in these artifacts.
