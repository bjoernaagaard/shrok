---
name: x-posts
description: Save or read posts on X (Twitter). Use when the user shares an x.com or twitter.com link, or asks about a post.
---

# Posts on X

Reading a post through the X API costs the user money: about $0.005 per post from their prepaid credits. Reading the same post again within the same UTC day is free.

- Never read the same post twice. Search the saved items first with `search_items`, using the post's id (the number after `/status/`). If it is saved, answer from the item.
- When a shared post's preview already holds its full text, save it from the preview. Don't read it from X.
- When the preview is missing or cut off, read the post with `x_read_post`, giving it the link. Save its author, date and full text.
- Posting, replying, liking and following are unsupported. The owner must complete those steps in X; a generic approval cannot authorize them.
