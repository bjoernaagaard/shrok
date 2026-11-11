---
name: x-posts
description: Save or read posts on X (Twitter). Use when the user shares an x.com or twitter.com link, or asks about a post.
---

# Posts on X

Each `x_read_post` costs the user about $0.005 from their prepaid X credits, so read a post at most once.

1. Search the saved items with `search_items` for the post's id, the number after `/status/`. If it is saved, answer from the item.
2. If the shared preview holds the full text, save the post from the preview.
3. Otherwise read it with `x_read_post` and the link, and save its author, date and full text.

To post, reply, like or follow, use `run_program` with `xurl`, only when the owner asked. Each command waits for his /yes on the exact command.
