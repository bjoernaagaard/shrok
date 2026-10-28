---
name: saving-shares
description: Save a link, post, PDF, file or image the user shared from their phone as a searchable item. Use for every message that starts with [Shared link], [Shared file] or [Shared image], and when they ask you to keep something.
---

# Saving shares

Each share becomes one item through `save_item`. Items are ordinary Markdown with YAML frontmatter for `id`, `title`, `kind`, `source` when available, `created`, `updated`, and `tags`. Shrok supplies the identifier and timestamps. The identifier and filename stay fixed when an item is updated, so incoming links keep working. Saving the same source again updates the item, so a share that arrives twice stays one item.

1. Work out the kind.
   - A link to a post on X (x.com or twitter.com, with `/status/`) is a `post`. Follow the x-posts skill.
   - Any other link is a `link`. Use the title and preview the share carries. Open the page with `web_fetch` only when the preview is empty or the user asks for more.
   - A PDF is a `document`. Follow the pdf skill.
   - A picture is an `image`. Look at it with `read`, then describe what it shows.
   - Anything the user asks you to keep that has no file or link is a `note`.
2. Write the body in Markdown: two or three sentences saying what it is and why it may matter to them, then the full text worth searching later (the post, the page's main text, the document's text).
3. Search existing items by the main subjects with `search_items`. Read relevant matches before linking to them. When there is a meaningful connection, finish the body with `## Related items` and a list of standard Markdown links, each explaining the connection. Link relative to the item itself: a search result at `items/example.md` becomes `[Example](example.md)`, not `[Example](items/example.md)`. Use actual filenames, never guessed paths or `[[wikilinks]]`. A shared generic tag alone is not a reason to link. Omit the section when nothing is related.
4. If updating an existing item, read its current file and preserve its content and related links unless the user asked to change them. Pass its `id` to `save_item`, especially when changing the title or source.
5. Call `save_item` with `kind`, `title`, `body`, the link as `source`, the shared file's path as `file`, and a few lowercase `tags`. Put only the Markdown body in `body`; Shrok writes the frontmatter.
6. Answer in one short line: what you saved. Don't repeat the text back.

When they ask for something they saved, use `search_items` with a few distinctive words, then `read` the item's path if the snippet isn't enough.
