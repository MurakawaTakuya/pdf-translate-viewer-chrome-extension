# Original-glyph protection candidate

Status: **offline prototype; not the default viewer translator; live validation pending**.

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
