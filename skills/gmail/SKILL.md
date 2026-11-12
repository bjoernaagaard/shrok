---
name: gmail
description: Read, search, tidy, draft and send email in the user's Gmail. Use for anything about their email.
---

# Gmail

- Find mail with `gmail_search`, which takes any Gmail search, such as `is:unread`, `from:anna` or `newer_than:7d`. Read one message with `gmail_read` and its id, and summarize it yourself (in a flow, with `transform_text`).
- Archive, mark read or unread, or label mail with `gmail_modify`. It acts at once, so only when the owner asked or a flow he saved says so.
- Write a new email or a reply as a draft with `gmail_draft`. For a reply, pass the message id as `reply_to`. Tell the owner the draft is in Gmail.
- Send only when the owner asked to send. Use `gmail_send`, with `reply_to` for a reply. It asks for his /yes on the exact email and the account it sends from, unless he allowed those recipients with /always. When he may want to edit the wording, save a draft instead.
- For other Google operations, use `run_program` with `gws`. Each command asks for his /yes unless he allowed that exact command.
