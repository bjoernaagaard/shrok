---
name: calendar
description: Look at or add to the user's Google Calendar. Use for questions about their plans, free time, or making an event.
---

# Google Calendar

| Task                   | Tool                                          |
| ---------------------- | --------------------------------------------- |
| Today or the next days | `calendar_events` with `days` (1 is today)    |
| Add an event for them  | `calendar_add` with `summary`, `start`, `end` |

- Times for `calendar_add` are RFC 3339 with the UTC offset the owner's time zone has on that day, as the tool's `start` field describes. Mind summer time.
- Show times to them as plain clock times, without a zone.
- `calendar_add` adds no guests and waits for the owner's approval of the exact event with /yes. Inviting guests is unsupported; ask the owner to add them in Google Calendar.
- `run_program` and unreviewed calendar operations are blocked. Ask the owner to complete unsupported steps manually, not through another tool.
