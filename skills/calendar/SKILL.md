---
name: calendar
description: Look at or add to the user's Google Calendar. Use for questions about their plans, free time, or making an event.
---

# Google Calendar

- Read plans with `calendar_events`. `days: 1` is today.
- Add an event with `calendar_add`. Its times use the UTC offset the owner's zone has on that day, which changes with summer time. It waits for the owner's /yes on the exact event.
- Show times to the owner as plain clock times, without a zone.
- Guests, `run_program` and other calendar operations are blocked. Ask the owner to add guests or finish other steps in Google Calendar.
