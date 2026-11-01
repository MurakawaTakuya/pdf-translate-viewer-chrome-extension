# Translation format comparison

This standalone experiment compares the frozen sequential-ID/flat response at commit `51e7ec1` with opaque IDs and page-grouped responses. It does not change extension behavior.

Use the production PDF extraction functions to prepare a JSON array of pages. Each page has `page` and `blocks`; each block needs its original `id`, `text` and `translate` flag. Keep extracted source and generated responses outside Git.

Preparation makes no remote calls:

```sh
node scripts/evaluation/compare-formats.mjs --input /path/to/pages.json --output /path/to/new-results
```

Explicit execution uses an existing project API key retrieved through the authenticated Google Cloud CLI. The key remains in process memory, never in command-line arguments, output files or logs. No key is created, API enabled, billing changed, model substituted or inference retried.

```sh
node scripts/evaluation/compare-formats.mjs --input /path/to/pages.json --output /path/to/new-results --run --project PROJECT_ID --key-resource projects/NUMBER/locations/global/keys/KEY_ID
```

The plan is written before inference. Up to four sequential requests run in fixed `A1, B1, B2, A2` order, with identical full source, model, generation configuration and translation-quality instructions. Only the identifier/output protocol changes. HTTP errors, incomplete generations and transport failures stop the run without resending. An existing result directory cannot be reused after inference starts.

Results contain API completion status, token usage, first-text/first-complete-item/total latency, missing-ID positions and per-page coverage, duplicates and wrong-page assignments. ID coverage does **not** prove semantic alignment: inspect corresponding source and translated blocks on a fixed panel separately. Two runs per format on one paper provide a preliminary comparison, not a general reliability guarantee.


## Logical paragraphs and separated input

`extract-pages.mjs` reads a local PDF using the same layout module as the viewer. It uses no browser and sends no remote requests. Keep its output outside Git.

```sh
node scripts/evaluation/extract-pages.mjs /path/to/paper.pdf /path/to/revised-pages.json
```

`compare-inputs.mjs` compares the frozen legacy request on the original extraction (A) with the experimental separated-target request on the revised extraction (C). It retains full reference text and lists exact source targets separately; this intentionally duplicates target source in the input, increasing input tokens. The output schema is unchanged. Preparation is offline by default; an exclusive new output directory is required each time.

```sh
node scripts/evaluation/compare-inputs.mjs --baseline-input /path/to/original-pages.json --input /path/to/revised-pages.json --output /path/to/new-plan
```

Only `--run --project PROJECT_ID --key-resource RESOURCE` enables up to four generation calls, in fixed A1/C1/C2/A2 order, without retries. The fixed panel from the first comparison is mapped to revised targets before inference, allowing a former fragment to belong to a larger logical paragraph. Inspect the whole revised target's source scope, not just its old fragment. Extraction, order and input protocol change together, so this experiment does not isolate the contribution of each. No output format or prompt tuning is done after observing the results.

The separated-target protocol is explicitly selected only by the evaluator (`inputFormat: 'separate-targets'`). This historical experiment still exhibited severe content/ID mismatches. The current viewer instead uses the keyed task-bound codec described below. Layout reconstruction remains enabled; the fixed four-call comparison did not include a separate layout-only generation arm.

## Reproduce the current viewer unchanged

`reproduce-current.mjs` captures the request directly from the current production translator. Its default is the viewer's keyed task-bound codec. Add `--legacy` only to reproduce the previous sequential-ID protocol explicitly. It exercises the current extraction and does not reuse a frozen historical baseline. The fixed diagnostic panel is specific to arXiv:2301.08243 and must be present in the extraction before inference.

```sh
node scripts/evaluation/reproduce-current.mjs --input /path/to/revised-pages.json --output /path/to/new-plan
```

Add `--run --project PROJECT_ID --key-resource RESOURCE` only for explicitly authorized live execution. This writes a plan before making at most three identical generation requests, in R1/R2/R3 order, with no retries, prompt changes, repair requests or judge calls. HTTP/transport errors or absent API completion stop the run. A new output directory is required, including for offline preparation.

Raw responses are also replayed offline through the actual production parser. This verifies coverage handling without another model call. Numeric citation differences on pages 1–8 are diagnostic flags, not proof of wrong scope or a translation-quality score. Compare source and raw response content for the fixed source IDs before attributing a visual problem to rendering. Keep full source, request and response files outside Git; publish only sanitized measurements, hashes and observed mappings.

## Required keyed properties with exact-source tasks

`keyed-format.mjs` prepares one frozen candidate: opaque required properties (K), exact-source property descriptions (S, `--source-bound`), or explicit translation tasks beside each property's source (T, `--task-bound`). The current viewer uses T plus local citation/unchanged-heading guards. A property key or citation match does not establish semantic accuracy.

```sh
node scripts/evaluation/keyed-format.mjs --prepare --input /path/to/pages.json --baseline-plan /path/to/legacy-plan.json --directory /path/to/new-task-plan --task-bound
```

Preparation makes no API call. It fixes the source/request hashes and diagnostic panel before inference. Only explicit authorized execution makes a request:

```sh
node scripts/evaluation/keyed-format.mjs --run --directory /path/to/new-task-plan --label T1 --project PROJECT_ID --key-resource RESOURCE
```

Each label is executed once with an exclusive `.started` file and no retry. There are at most three labels per candidate. The next label requires the previous response to pass both structural checks and an independent manual review bound to its response hash. Failure stops that candidate. K1, S1 and T1 all failed the full quality gate; no second or third runs were made. The guarded T1 replay held two citation failures, and one explicit repair still left one failure. See [the sanitized evaluation report](../../reports/keyed-translation-evaluation.md). No successful full-paper completion is claimed.

The historical first-complete-item latency scanner does not measure keyed properties; its missing `firstItemMs` must not be read as zero or used to claim a speed improvement. Keep raw source, full requests, generated responses and credentials outside Git. The checked-in report contains only measurements, hashes and bounded failure examples.

## Citation inventory and marker comparison

`citation-formats.mjs` freezes three candidates before live execution: B is the byte-identical current viewer, P adds a per-property reference inventory without changing source text, and M substitutes unique per-occurrence reference markers in all context and target text. M requires the exact ordered marker inventory in each output block before local restoration; it never guesses or appends a missing reference. Restored outputs still face the current all-page citation/heading guard and a fixed 40-block source/translation inspection. In the recorded run, independent assistant agents performed this reading; no human scorer or additional Gemini judge request was used.

```sh
node scripts/evaluation/citation-formats.mjs --prepare --input /path/to/pages.json --baseline-plan /path/to/prior-plan.json --directory /path/to/new-citation-plan
node scripts/evaluation/citation-formats.mjs --run --directory /path/to/new-citation-plan --label B1 --project PROJECT_ID --key-resource RESOURCE
```

Explicit initial labels run in B1/P1/M1 order. A transport or incomplete-response failure stops the run; quality failures reject that candidate without tuning or repeating it. A P or M candidate qualifies for two identical confirmation runs only after passing both guards and manual review, with latency at most 1.25 times B1. The selection is recorded in `selection.json`, each preceding review is bound to its response and request hashes, and `.started` files enforce a total budget of five remote calls. No automatic retries or repairs are made. This evaluator does not change the viewer's production request.
# Original-glyph protection candidate

`protected-format.mjs` captures and replays the actual experimental protected translator. It is not the default viewer translator. Offline preparation requires the revised extraction, the earlier extraction and its fixed-panel plan:

```sh
node scripts/evaluation/protected-format.mjs --prepare --input revised-pages.json --old-input old-pages.json --old-plan reports/citation-experiment-plan.json --directory /tmp/new-protected-run
```

Preparation freezes the request, implementation (including evaluator and display/export code), source coverage, 72-target review panel, three-call cap and latency ceiling. Live execution requires explicit `--run --label G1 --project PROJECT --key-resource RESOURCE --directory DIRECTORY`; it reads an existing key through gcloud inside the process. Never print or persist key values. Each subsequent label requires a passing previous guard and hash-bound independent review. Raw responses stay local. No retries, repairs or model-judge calls are permitted in a frozen run.

The recorded G1 failed, so G2/G3 were not run. See [the result](../../reports/protected-translation.md). Do not reinterpret relaxed post-hoc decoding as success or resume that failed run.
