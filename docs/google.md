# Google: Gmail, Calendar and Drive

With Google set up, Shrok can search, read, tidy and send your mail, read and change your calendar, and find and read files in your Drive. Before it sends an email or changes your calendar, it asks you on your phone to approve that exact action.

Shrok uses the [Google Workspace CLI](https://www.npmjs.com/package/@googleworkspace/cli), `gws`, and offers Google only when `gws` is installed and both of its keys are set.

1. In the [Google Cloud console](https://console.cloud.google.com), create a project, turn on the Gmail, Google Calendar and Google Drive APIs, and create an OAuth client of type **Desktop app**.
2. Install `gws` where Shrok's service can find it, such as `npm install -g @googleworkspace/cli`.
3. Give Shrok the client's ID and secret as `GOOGLE_WORKSPACE_CLI_CLIENT_ID` and `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET`, the same way you gave it the model key.
   - Homebrew: add both to `secrets.env`, as in [setup.md](setup.md#homebrew).
   - Debian or Ubuntu: encrypt both with `systemd-creds`, as in [setup.md](setup.md#debian-and-ubuntu).
4. Log in as the user Shrok runs as, with the same two values in the environment:

   ```sh
   GOOGLE_WORKSPACE_CLI_CLIENT_ID=... GOOGLE_WORKSPACE_CLI_CLIENT_SECRET=... gws auth login -s gmail,calendar,drive
   ```

   On Debian or Ubuntu, run it as the `shrok` user: `sudo -u shrok env HOME=/var/lib/shrok ... gws auth login`. `gws` opens a browser to sign in and keeps its tokens in `~/.config/gws` of that user.

5. Restart Shrok. Ask it "what's on my calendar this week?" to check.

Shrok's own sandbox can't read `~/.config/gws`, so a command Shrok runs in `bash` can't take your tokens.
