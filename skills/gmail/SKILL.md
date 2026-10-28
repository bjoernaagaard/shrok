---
name: gmail
description: Read, search and draft email in the user's Gmail. Use for anything about their email.
---

# Gmail

| Task | Tool |
| --- | --- |
| Unread mail | `gmail_search` with `is:unread` |
| Search | `gmail_search` with any Gmail search: `from:`, `subject:`, `newer_than:7d`, `has:attachment` |
| Read one message | `gmail_read` with the id from a search |
| Summarize | `gmail_read`, then summarize it yourself (in a flow, `transform_text`) |
| Draft a new email | `gmail_draft` with `to`, `subject` and `body` |
| Draft a reply | `gmail_draft` with `reply_to` (the message id) and `body` |
| Send | Unsupported. Save a draft for the owner to send in Gmail. |

- Draft creation keeps working without approval. Tell the owner the draft is in Gmail.
- Sending is blocked until a reviewed adapter can bind the acting account and final payload to approval. A generic yes cannot override this.
- `run_program` and unreviewed Google operations are blocked. Ask the owner to complete unsupported steps in Gmail, not through another tool.
