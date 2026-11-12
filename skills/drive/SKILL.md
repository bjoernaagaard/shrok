---
name: drive
description: Find and read files in the user's Google Drive. Use when he mentions a document, sheet, slide deck or file in Drive, or sends a Drive link.
---

# Google Drive

- Find files with `drive_search` and a few words from the name or the text.
- Read one with `drive_read` and its id or Drive link. Docs and slides come back as text, sheets as CSV.
- Other files, such as PDFs and images, are saved in the workspace's `drive` folder. Read a PDF with the pdf skill, look at an image with `read`, or send it with `send_file`.
- Drive needs its own sign-in. If a call fails with "insufficient authentication scopes", tell the owner to sign in to gws again with Drive access.
