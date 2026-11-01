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

The separated-target protocol is explicitly selected only by the evaluator (`inputFormat: 'separate-targets'`). The viewer uses the legacy wire format by default because the live comparison still exhibited severe content/ID mismatches. Layout reconstruction remains enabled. This default combination has local regression coverage; the fixed four-call comparison did not include a separate layout-only generation arm.

## Reproduce the current viewer unchanged

`reproduce-current.mjs` captures the request directly from the current production translator, without an input-format override. It exercises the current extraction with the current default wire protocol; it does not reuse a frozen historical baseline. The fixed diagnostic panel is specific to arXiv:2301.08243 and must be present in the extraction before inference.

```sh
node scripts/evaluation/reproduce-current.mjs --input /path/to/revised-pages.json --output /path/to/new-plan
```

Add `--run --project PROJECT_ID --key-resource RESOURCE` only for explicitly authorized live execution. This writes a plan before making at most three identical generation requests, in R1/R2/R3 order, with no retries, prompt changes, repair requests or judge calls. HTTP/transport errors or absent API completion stop the run. A new output directory is required, including for offline preparation.

Raw responses are also replayed offline through the actual production parser. This verifies coverage handling without another model call. Numeric citation differences on pages 1–8 are diagnostic flags, not proof of wrong scope or a translation-quality score. Compare source and raw response content for the fixed source IDs before attributing a visual problem to rendering. Keep full source, request and response files outside Git; publish only sanitized measurements, hashes and observed mappings.
