---
name: pdf
description: Read the text of a PDF the user shared or that sits in the workspace. Use when a task needs what a PDF says.
---

# Reading a PDF

Run liteparse in read-only bash. It is installed with Shrok and works offline. Never use OCR, and never run it through `npx`, which downloads code. Bash always enforces a 30-second deadline and a 256 KiB total output budget, without saving full output to disk. Do not retry a document that hits either budget.

```
readonly MAX_PDF_PAGES=20
lit parse <path to the pdf> --no-ocr --max-pages "$MAX_PDF_PAGES" -q
```

- Add `--format markdown` when headings and tables matter.
- Keep `MAX_PDF_PAGES` at 20 on every parse, and say that you read at most the first 20 pages. Do not use batch parsing, screenshots, image extraction, or output files.
- If the output is empty or garbled, the PDF is probably a scan. Tell the user that it has no text you can read, rather than guessing what it says.
