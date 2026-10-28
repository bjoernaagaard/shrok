# Security

Thank you for looking at the safety of Shrok. This page explains which versions receive security fixes and how you can report a problem in private.

## Supported versions

Only the latest release receives security fixes. Older releases do not receive fixes. Update to the latest release before you report a problem, and check whether the problem still happens there. The upgrade guide in [docs/upgrade.md](docs/upgrade.md) explains how to update each install type.

## How to report a problem

Report security problems in private through GitHub. Open the Security tab of [github.com/bjoernaagaard/shrok](https://github.com/bjoernaagaard/shrok) and choose "Report a vulnerability", or go straight to the [private report form](https://github.com/bjoernaagaard/shrok/security/advisories/new). Do not open a public issue, a public discussion, or a pull request for a security problem, because other people could use those details against users who have not updated yet.

Write as much of the following as you can in your report.

- The Shrok version, your operating system, and how you installed Shrok.
- What an attacker could reach or change, such as mail, calendar events, files, or approval requests.
- The steps that show the problem, in order, so the maintainer can see the same result.
- Any logs or error text that help, after you remove secrets from them.

Never include API keys, OAuth tokens, SimpleX keys or invite links, or real mail and calendar content in a report. A made up example that shows the same behaviour is enough.

## What happens next

One person maintains Shrok. Reports are read in private as time allows. You should expect a first reply within 7 days in most cases, and a quiet week does not mean your report was lost. The maintainer may ask follow up questions so the problem can be reproduced and understood. Fix time depends on how serious the problem is and how clear the cause is, so this page promises no fixed date for a fix or a release.

Please keep the details private until a fixed release is out, so users get a fair chance to update. After a fix ships, the maintainer plans to publish a GitHub security advisory that describes the problem and the fixed version. The advisory can credit you by name, or leave your name out if you say so in your report.

For ordinary bugs that have no security impact, open a normal GitHub issue instead.
