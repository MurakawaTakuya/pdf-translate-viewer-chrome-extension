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

`compare-inputs.mjs` compares the frozen legacy request on the original extraction (A) with the current production request on the revised extraction (C). It retains full reference text and lists exact source targets separately; this intentionally duplicates target source in the input, increasing input tokens. The output schema is unchanged. Preparation is offline by default; an exclusive new output directory is required each time.

```sh
node scripts/evaluation/compare-inputs.mjs --baseline-input /path/to/original-pages.json --input /path/to/revised-pages.json --output /path/to/new-plan
```

Only `--run --project PROJECT_ID --key-resource RESOURCE` enables up to four generation calls, in fixed A1/C1/C2/A2 order, without retries. The fixed panel from the first comparison is mapped to revised targets before inference, allowing a former fragment to belong to a larger logical paragraph. Inspect the whole revised target's source scope, not just its old fragment. Extraction, order and input protocol change together, so this experiment does not isolate the contribution of each. No output format or prompt tuning is done after observing the results.
