---
name: pdf
description: Read the text of a PDF the user shared or that sits in the workspace. Use when a task needs what a PDF says.
---

# Reading a PDF

Run the bundled liteparse in read-only bash, always with this command:

```
lit parse <path to the pdf> --no-ocr --max-pages 20 -q
```

- Add `--format markdown` when headings and tables matter.
- Tell the user you read at most the first 20 pages.
- Never run it through `npx`, which downloads code. Never use OCR, batch parsing, screenshots, image extraction or output files.
- Bash stops after 30 seconds or 256 KiB of output. Don't retry a PDF that hits either limit.
- Empty or garbled output means the PDF is probably a scan. Tell the user it has no text you can read, and don't guess what it says.
