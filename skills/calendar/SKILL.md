---
name: calendar
description: Look at, add to or change the user's Google Calendar. Use for questions about his plans or free time, and for making, moving or cancelling events.
---

# Google Calendar

- Read plans with `calendar_events`. `days: 1` is today. Each event has the `id` the other tools take.
- Add an event with `calendar_add`. Its times use the UTC offset the owner's zone has on that day, which changes with summer time.
- Move, rename or change an event, or set its guests, with `calendar_update`. Guests get an invitation email, so only invite people the owner named.
- Delete an event with `calendar_delete`. Guests get a cancellation.
- Adding, changing and deleting ask for the owner's /yes on the exact change, unless he allowed that kind with /always.
- Show times to the owner as plain clock times, without a zone.
