# Whole-block translations with opaque original atoms

Status: **failed mechanical and independent content review; not enabled**.

The compact ranked-record candidate failed. A whole-paper translation with 210 required root strings now uses fluent translated strings containing opaque `<n_.../>` tags for original math, references and digit-bearing model/dataset identifiers. Code identifies each tag and restores its original value; the model does not calculate ranks or split prose into numbered records. The source contains the masked block text, its kind and tag meanings. All PDF pages remain reference context in the same request.

There are 212 targets: 210 generated and two uncertain-math blocks kept as originals. The 441 generated original atoms comprise 105 math, 201 reference and 135 literal identifier occurrences. The underlying decoder checks exact tags, original identifier inventory, known duplicate numeric tuples and unchanged descriptive captions. A complete validated JSON member is the streaming unit. Unknown, missing, duplicate or foreign atoms are withheld; code never guesses missing placement. Manual repair still uses full reference context.

This does **not** guarantee claim attachment or semantic correctness. A copied tag can still be attached to the wrong claim, and prose can still borrow a neighboring fragment. The frozen 73-block independent panel includes the previously failing comparisons, source boundaries, figure/table labels and math cases. It is unchanged from the compact experiment. No API judge is used.

[The preregistered plan](atom-tag-experiment-plan.json) permits **one exploratory call**, with the same model and LangTalk project, a 150-second deadline, zero retries and zero automatic repairs. Stop on any transport, decoder, coverage or independent content failure. A single pass would still require unchanged independent confirmation before default adoption. No Chrome operation, viewer-default change or merge is part of this trial.

## T1 actual result

The single planned request completed with HTTP 200 in 88.880 seconds; first model text arrived after 3.158 seconds. All 210 root properties were present, without extra, duplicate or empty values. The decoder accepted 189 generated values, withheld 21 and retained the two planned originals. The mechanical gate failed. No retries, repairs, second generation or model-judge call followed.

Three independent assistant reviewers checked the complete frozen 73-block panel: 64 accepted generated values, seven withheld and two original retentions. No unrelated-paragraph cascade was found in the accepted panel, and the previously duplicated cross-column predicate at p1-b7/p1-b34 was no longer duplicated. This is an observed result for this sample, not proof of global alignment.

Content still fails: p12-b5 omits the sentence specifying only center crop and horizontal flipping; p17-b0 omits two claims; p3-b3 attaches z to a sentence ending rather than additional information; p16-b0 repeats original scalar math values in prose; p2-b25 mistranslates off-the-shelf evaluations. The amount comparison in p1-b35 remains unclear, and p13-b5 has a prediction-direction concern where the English itself is awkward. Exact tags and required keys did not catch these semantic defects.

Decoder diagnostics distinguish two tag-inventory failures, 14 values with free digit-bearing identifiers, and five restored-identifier/format failures. The last category is not assumed to be semantic corruption: PDF hyphenation can split a model name that Japanese output rejoins. Values were not remapped or rescued after the fact.

A follow-up offline guard compares counts of registered decimal scalar values from original math against the complete source and restored result. It catches the actual p16-b0 repeated scalars; integer values are excluded to avoid collisions with ordinary phrases such as twice becoming 2回, and commas separate decimal tokens. This conservative check can still withhold legitimate numeric paraphrases; it does not guarantee mathematical equivalence, claim attachment or complete translation. Historical T1 remains a failure. The viewer retains its previous keyed factory. See [sanitized evaluation](atom-tag-evaluation.json).
