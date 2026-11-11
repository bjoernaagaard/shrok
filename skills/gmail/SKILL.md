---
name: gmail
description: Read, search and draft email in the user's Gmail. Use for anything about their email.
---

# Gmail

- Find mail with `gmail_search`, which takes any Gmail search, such as `is:unread`, `from:anna` or `newer_than:7d`. Read one message with `gmail_read` and its id, and summarize it yourself (in a flow, with `transform_text`).
- Write a new email or a reply as a draft with `gmail_draft`. For a reply, pass the message id as `reply_to`. Tell the owner the draft is in Gmail.
- Send only when the owner asked to send. Use `gmail_send`, with `reply_to` for a reply. It waits for the owner's /yes on the exact email and the account it sends from. When he may want to edit the wording, save a draft instead.
- For other Google operations, use `run_program` with `gws`. Each command waits for the owner's /yes.
