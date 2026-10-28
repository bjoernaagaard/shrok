# Upgrading

Take a [backup](backup.md) first. Upgrades keep the data folder, so your phone stays paired.

| Install | Upgrade |
| --- | --- |
| Homebrew | `brew upgrade shrok`, then `brew services restart shrok` |
| Debian or Ubuntu | Download the new `.deb` and run `sudo apt install ./shrok_*_$(dpkg --print-architecture).deb`. The package restarts Shrok if it was running. |
| Docker | `docker compose pull && docker compose up -d` |
| Portable archive | Stop Shrok, move the old folder aside, and repeat the extraction and ownership commands in [setup.md](setup.md#portable-archive) before starting Shrok. The data folder is elsewhere, so nothing is lost. |

Shrok takes up to 20 seconds to stop, while it closes SimpleX and its browser. The systemd unit and `compose.yaml` wait 30 seconds before they force it.

The release notes say when an upgrade needs more than this.
