# WealthQuest Compensation Plan wiki

A Karpathy-style "LLM wiki" of the **WealthQuest Compensation Plan Agreement (effective 10.08.2026)**. The 37-page plan is split into 21 topic pages, flat in one folder, linked with Obsidian `[[wikilinks]]`. The agent reads `index.md`, opens the matching pages, and answers from them with section citations.

The plan PDF is the raw source and is never edited. This wiki is the compiled layer. If the two ever differ, the plan PDF wins, and the page must be fixed.

## Layout

```
kb-compplan/
  index.md      router file; read first (about 1,700 tokens)
  log.md        append-only change log
  README.md     this file
  _lint.mjs     validator (Node 22, no dependencies)
  *.md          21 pages, one per plan section or group of sections (§1–§21)
```

## Page frontmatter

```yaml
---
title: "Stable Income Team Bonus (SITB)"
section: "§9"                 # plan section(s) covered; starts with §
summary: "One sentence, 30 words or fewer; reused verbatim in index.md."
aliases:                      # 3 to 6 phrasings users actually type
  - "daily bonus"
related:                      # 2 to 4 [[slug]] links, no .md
  - "[[rank-ladder]]"
---
```

## Page body

1. `# Title`
2. `## §x.y Heading` sections in the plan's order. The wording follows the plan closely; lists and tables are reformatted for reading, never reworded in substance.
3. Every plan table as a Markdown table, with numbers exactly as in the source.
4. Summary tables that don't exist in the plan are labelled **"Summary table (derived from §…)"**. The plan text on the same page governs.
5. `## Related pages` with `[[slug]]` links.
6. Last line: `Source: WealthQuest Compensation Plan Agreement, effective 10.08.2026, §x`

## Accuracy rules

- **Never change a number.** Amounts, percentages, BV thresholds, day counts and times are copied from the plan. A cross-check is run on every ingest: every number in the wiki must appear in the source, and every number in the source must appear somewhere in the wiki (see `log.md`).
- Keep the plan's disclaimers next to the figures they qualify (§9.3, §12.3, §13.2, §13.7, §21).
- Agents must never present a figure as a projection or promise of income.

## Updating after a plan amendment

1. Save the new plan text as the raw source.
2. Edit only the affected pages. Keep slugs; add aliases for new terms.
3. Update `summary` and the matching line in `index.md` if the page's scope changed.
4. Update the effective date in every Source line if the plan's effective date changed.
5. Append to `log.md`: `## [YYYY-MM-DD] update | <page title> (§x)`.
6. Re-run the number cross-check and `node _lint.mjs`.

## Lint rules (`node _lint.mjs`)

- Required fields: `title`, `section`, `summary`, `aliases`, `related`. `section` starts with `§`.
- `summary` is 30 words or fewer; 3 to 6 `aliases`; 2 to 4 `related`, each a single wikilink.
- The body starts with an H1, contains `## Related pages`, and ends with the Source line.
- Every `[[link]]` resolves to an existing page.
- **No orphans**: every page is linked from at least one other page.
- **Index coverage**: every page appears in `index.md`, and every index link resolves.
- `log.md` headers follow `## [YYYY-MM-DD] <op> | <subject>`.
