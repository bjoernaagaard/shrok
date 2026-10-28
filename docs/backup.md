# Backing up

Everything Shrok knows lives in its data folder: chats, memory, saved items, schedules, approvals and the SimpleX keys that make it your contact. Back up that folder while Shrok is stopped, because its databases may be mid-write while it runs.

| Install | Data folder | Stop | Start |
| --- | --- | --- | --- |
| Homebrew | `~/Library/Application Support/Shrok` | `brew services stop shrok` | `brew services start shrok` |
| Debian or Ubuntu | `/var/lib/shrok` | `sudo systemctl stop shrok` | `sudo systemctl start shrok` |
| Docker | the volume `<folder>_shrok-data`, where `<folder>` is the name of the folder holding `compose.yaml` | `docker compose stop` | `docker compose start` |

For example, on Debian or Ubuntu:

```sh
sudo systemctl stop shrok
sudo sh -c '
  PRIVATE_UMASK=0077
  umask "$PRIVATE_UMASK"
  backup_dir=$(mktemp -d /var/backups/shrok.XXXXXXXX)
  tar -czf "$backup_dir/shrok-backup.tar.gz" -C /var/lib shrok
  printf "Backup saved in %s\n" "$backup_dir"
'
sudo systemctl start shrok
```

In Docker:

```sh
docker compose stop
backup_dir=$(mktemp -d "$PWD/shrok-backup.XXXXXXXX")
docker run --rm -v "$(basename "$PWD")_shrok-data:/data:ro" -v "$backup_dir":/backup \
  debian:trixie-slim sh -c 'PRIVATE_UMASK=0077; umask "$PRIVATE_UMASK"; tar -czf /backup/shrok-backup.tar.gz -C / data'
printf 'Backup saved in %s\n' "$backup_dir"
docker compose start
```

These commands create a fresh private backup directory and set a private umask inside the process that creates the archive. The archive is owned by root and readable only by root. Use `sudo` when copying it, and keep the destination private too. The backup holds your SimpleX keys and everything you told Shrok.

## Restoring

Stop Shrok, replace the data folder with the backup, keeping its owner and its 0700 mode, then start Shrok. Your phone stays paired, because the keys come back with the folder. Don't run the restored copy and the original at the same time: they would be the same SimpleX contact. Shrok refuses to start twice on one folder, but it can't see a copy on another machine.
