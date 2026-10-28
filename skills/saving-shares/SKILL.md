---
name: saving-shares
description: Save a link, post, PDF, file or image the user shared from their phone as a searchable item. Use for every message that starts with [Shared link], [Shared file] or [Shared image], and when they ask you to keep something.
---

# Saving shares

Each share becomes one item, saved with `save_item`. Saving the same source again updates that item.

1. Pick the kind.
   - A post on X (an x.com or twitter.com link with `/status/`) is a `post`. Follow the x-posts skill.
   - Any other link is a `link`. Use the share's title and preview, and open the page with `web_fetch` only when the preview is empty or the user asks for more.
   - A PDF is a `document`. Follow the pdf skill.
   - A picture is an `image`. Look at it with `read` and describe it.
   - Anything else the user asks you to keep is a `note`.
2. Write the body. Start with two or three sentences on what it is and why it may matter to the user, then add the full text worth searching later.
3. Search for related items with `search_items` on the main subjects, and read the matches before you link to them. A shared generic tag alone is not a reason to link.
4. When you update an existing item, read it first and keep its content and links unless the user asked for a change. Pass its `id`.
5. Call `save_item` with `kind`, `title`, `body`, the link as `source`, the shared file's path as `file`, and a few lowercase `tags`.
6. Reply in one short line saying what you saved, without repeating the text.

To find a saved item, use `search_items` with a few distinctive words, then `read` its path if the snippet isn't enough.
