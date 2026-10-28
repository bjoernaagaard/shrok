# Pairing your phone

Shrok talks to exactly one person, its owner. You become the owner by connecting from SimpleX on your phone through a one-time link that `shrok pair` prints.

1. With Shrok running, open a terminal on the same machine, as the user Shrok runs as:

   | Install          | Command                                |
   | ---------------- | -------------------------------------- |
   | Homebrew         | `shrok pair`                           |
   | Portable archive | `/path/to/shrok/bin/shrok pair`        |
   | Debian or Ubuntu | `sudo -u shrok shrok pair`             |
   | Docker           | `docker compose exec shrok shrok pair` |

2. In SimpleX on your phone, tap **+**, then **Connect via link**, and paste the link.
3. When the terminal says **Paired**, send Shrok a message.

The link works once, and only for 15 minutes. It is deleted if you press Ctrl-C, if it expires, or when Shrok restarts. It is shown only in your terminal, never in Shrok's log. Only the phone that connects through it becomes the owner. Anyone else who finds Shrok in SimpleX is ignored.

`shrok pair` talks to Shrok through a socket in the data folder, so only Shrok's own user can use it. If you set `SHROK_DATA_DIR` when starting Shrok, set it to the same path when pairing.

## A new phone

```sh
shrok pair --replace
```

Use the command for your installation from the table above, followed by `--replace`. Type `REPLACE` to confirm. The phone that connects through the new link becomes the owner, and the old one stops being it. This must be run in a terminal, so a script can't do it by accident.
