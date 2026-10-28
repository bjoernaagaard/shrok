---
name: gmail
description: Read, search and draft email in the user's Gmail. Use for anything about their email.
---

# Gmail

- Find mail with `gmail_search`, which takes any Gmail search, such as `is:unread`, `from:anna` or `newer_than:7d`. Read one message with `gmail_read` and its id, and summarize it yourself (in a flow, with `transform_text`).
- Write a new email or a reply as a draft with `gmail_draft`. For a reply, pass the message id as `reply_to`. Tell the owner the draft is in Gmail.
- Sending is blocked, and a generic yes can't unblock it. `run_program` and other Google operations are blocked too. Ask the owner to finish those steps in Gmail.
