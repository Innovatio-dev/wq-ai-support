# WealthQuest Support KB

A Karpathy-style "LLM wiki" for the WealthQuest support agent: plain Markdown files with YAML frontmatter and Obsidian `[[wikilinks]]`. Open the folder as an Obsidian vault to browse it and see the link graph. The agent needs no vector database at this size: it reads `index.md`, picks articles, opens them, and answers from them.

## Layout

```
kb-support/
  index.md                  router file; the agent reads this first (keep under ~3,500 tokens)
  log.md                    append-only change log
  README.md                 this file (schema and rules)
  _lint.mjs                 validator (Node 22, no dependencies)
  payments-billing/         "Payments & billing"
  account/                  "Manage your account"
    logging-in/             subcategory "Logging in"
    profile-help/           subcategory "Profile help"
    account-settings/       subcategory "Account settings"
    security/               subcategory "Security"
  membership/               "WealthQuest membership"
  in-app-features/          "In-app features"
  device-troubleshooting/   "Device & troubleshooting"
  safety-privacy/           "Safety & privacy"
```

Folder names and display names match the WealthQuest Support help center categories.

## Article frontmatter

```yaml
---
title: "How to reset or change your WealthQuest password"   # H1 uses the same text
category: "Manage your account"         # one of the six display names above
subcategory: "Logging in"               # required under "Manage your account"; null everywhere else
summary: "One sentence, 25 words or fewer; reused verbatim in index.md."
aliases:                                # 3 to 6 phrasings users actually type
  - "forgot password"
related:                                # 2 to 4 [[path/slug]] links, no .md
  - "[[account/logging-in/cant-log-in]]"
escalate_if:                            # when the agent must offer a support ticket
  - "account locked after 5 failed attempts and still locked after 30 minutes"
cta:                                    # optional; or `cta: null`
  label: "Change your password"
  url: "/backoffice/settings/security"
updated: 2026-09-15                     # YYYY-MM-DD, bump on every edit
---
```

The linter parses a small YAML subset: scalars, `null`, block lists (`  - item`) and a one-level map (`cta`). Always quote strings, and quote wikilinks in YAML.

## Article body

1. `# Title` (same as `title`)
2. A short intro (1 to 3 sentences) that answers the question if it can.
3. `##` sections with numbered steps. Use the exact Back Office labels in **bold** (e.g. **Profile settings → Security**).
4. A final `## Related articles` section listing `[[path/slug]]` links.

Length: 150 to 400 words. Write in the second person, plain language, no filler.

## Content rules

- **Never promise or imply income.** Compensation stays brief and links to [[membership/compensation-plan-guide]] (which links to the full plan). Detailed rules live in the separate `kb-compplan` vault.
- Facts that must stay consistent across articles: $99 activation + $29/month license; 14-day full refund; 24-hour grace period after a failed payment; KYC through Sumsub **and** PayQuicker, Applicant status up to 30 days; commission week Tuesday 12:00 a.m. to Monday 11:59 p.m. PT; payout to Wallet Friday 12:00 a.m. PT; 90% cash / 10% Gold Points; tickets answered by email within 24 hours; WealthVentures is the only live product line; GoldMind and Liquid Gold are not live and unrelated to Gold Points.
- Slugs are kebab-case and never renamed. If users use a new phrase, add an alias instead.

## Add or change an article

1. Create `<folder>/<slug>.md` using the frontmatter and body templates above.
2. Link it from at least one existing article's body or `related` list (no orphans), and link out to 2 to 4 related articles.
3. Add one line to `index.md` under its category or subcategory:
   `- [[folder/slug]] — <summary> · aka: <alias1>; <alias2>; ...`
4. Append to `log.md`: `## [YYYY-MM-DD] ingest | <title>` (use `update` for edits, `delete` for removals).
5. Run `node _lint.mjs` and fix everything it reports.

## Lint rules (`node _lint.mjs`)

The linter checks every `.md` file except `index.md`, `log.md` and `README.md`:

- Required fields: `title`, `category`, `subcategory`, `summary`, `aliases`, `related`, `escalate_if`, `updated`. `cta`, if present, has `label` and `url`.
- `category` is one of the six display names; `subcategory` is valid for its category (`null` outside "Manage your account").
- `summary` is 25 words or fewer; 3 to 6 `aliases`; 2 to 4 `related`, each a single wikilink; `updated` is `YYYY-MM-DD`.
- The body starts with an H1 and contains `## Related articles`.
- Every `[[link]]` in frontmatter and body resolves to an existing file.
- **No orphans**: every article is linked from at least one other article.
- **Index coverage**: every article appears in `index.md`, and every index link resolves.
- `log.md` headers follow `## [YYYY-MM-DD] <op> | <subject>`.

It exits with status 1 and lists every problem, or prints a pass line with the index size estimate (characters / 4).
