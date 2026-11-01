# Whole-block translations with opaque original atoms

Status: **offline prepared; not enabled; quality unproven**.

The compact ranked-record candidate failed. A whole-paper translation with 210 required root strings now uses fluent translated strings containing opaque `<n_.../>` tags for original math, references and digit-bearing model/dataset identifiers. Code identifies each tag and restores its original value; the model does not calculate ranks or split prose into numbered records. The source contains the masked block text, its kind and tag meanings. All PDF pages remain reference context in the same request.

There are 212 targets: 210 generated and two uncertain-math blocks kept as originals. The 441 generated original atoms comprise 105 math, 201 reference and 135 literal identifier occurrences. The underlying decoder checks exact tags, original identifier inventory, known duplicate numeric tuples and unchanged descriptive captions. A complete validated JSON member is the streaming unit. Unknown, missing, duplicate or foreign atoms are withheld; code never guesses missing placement. Manual repair still uses full reference context.

This does **not** guarantee claim attachment or semantic correctness. A copied tag can still be attached to the wrong claim, and prose can still borrow a neighboring fragment. The frozen 73-block independent panel includes the previously failing comparisons, source boundaries, figure/table labels and math cases. It is unchanged from the compact experiment. No API judge is used.

[The preregistered plan](atom-tag-experiment-plan.json) permits **one exploratory call**, with the same model and LangTalk project, a 150-second deadline, zero retries and zero automatic repairs. Stop on any transport, decoder, coverage or independent content failure. A single pass would still require unchanged independent confirmation before default adoption. No Chrome operation, viewer-default change or merge is part of this trial.
