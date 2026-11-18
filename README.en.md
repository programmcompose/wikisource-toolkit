# Wikisource Toolkit

Bun and TypeScript tools for scan-based proofreading, OCR comparison, validating ProofreadPage transclusions, and planning batch edits. The default editorial workflow targets the first edition of the Great Soviet Encyclopedia on Russian Wikisource.

```sh
bun run demo
bun test
```

The demo runs against a local MediaWiki mock with three original sample pages. Open `.demo/review/index.html` for the scans, rendered previews and OCR changes. See `.demo/vols/07/checks.jsonl` for the corresponding decisions and `.demo/vols/07/manifest-pages.jsonl` for the publication plan.

- [Russian workflows](docs/workflows.md) for proofreading, preparing transclusions, and reviewing edits.
- [Data formats and JSON Schemas](docs/formats.md) for programmatic use.
- [OCR evaluation](docs/evaluation.md) with an offline sample and a reproducible input format.
- [Wordlist extraction](docs/wordlists.md) from coordinate OCR and two-column PDF text.

The example needs neither wiki credentials nor network access. Production publication requires an explicit flag and credentials, while transclusion previews use MediaWiki's parse API. The scripts use edition-specific names and templates, which need adapting for other collections. The code is available under [MIT](LICENSE).
