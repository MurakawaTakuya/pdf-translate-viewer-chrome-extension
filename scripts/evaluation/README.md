# Translation format comparison

This standalone experiment compares the production sequential-ID/flat response with opaque IDs and page-grouped responses. It does not change extension behavior.

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
