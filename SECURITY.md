# Security

This tool reads your Claude Code login token from the macOS keychain and sends it
to exactly one place: `api.anthropic.com`, in the `Authorization` header of the
usage request. It binds its HTTP server to `127.0.0.1` only. Anything that
weakens either of those is a security bug.

**Please report vulnerabilities privately** via GitHub's
[private vulnerability reporting](https://github.com/gipsic/claude-usage/security/advisories/new)
rather than a public issue. You'll get an acknowledgement within 72 hours and a
fix or a plan within 14 days for anything confirmed. Credit is given in the
release notes unless you'd rather not.

In scope: token handling, the local HTTP API, the installer and launchd agent,
anything that reads or writes outside `~/.claude-usage`. Out of scope: Anthropic's
own services, and issues requiring an attacker to already run code as your user.

Supported: the latest release on `main`.
