import { locale, timeZone } from "./settings.ts";

export const localTime = new Intl.DateTimeFormat(locale, {
  dateStyle: "full",
  timeStyle: "short",
  timeZone,
});

export const clockTime = new Intl.DateTimeFormat(locale, {
  timeStyle: "short",
  timeZone,
});
