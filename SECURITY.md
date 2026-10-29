# Security Policy

## Supported versions

The latest `-plus` release is supported, and so is `main`. Older releases get no fixes; a fix ships in the next `-plus` release.

| Version | Supported |
|---------|-----------|
| latest `-plus` release | yes |
| `main` | yes |
| older releases | no |

## Report a vulnerability

Use GitHub private vulnerability reporting:

<https://github.com/Yivas/pi-subagents-plus/security/advisories/new>

Do not open a public issue for a vulnerability that is not fixed yet.

## What to include

- The `pi-subagents-plus` version and the Pi version (`pi --version`).
- The agent, workflow, or script involved, and the `config.json` keys that change its behavior.
- The steps that trigger the problem, and what you expected instead.
- The error, command output, or transcript excerpt that shows it.
- Whether upstream [pi-subagents](https://github.com/nicobailon/pi-subagents) shows the same problem.

Remove API keys, tokens, private prompts and paths, and any transcript that carries personal data before you paste it.

## What happens next

The report stays private until it is published as a security advisory. The fix ships in the next `-plus` release, and the advisory names the reporter.

## Scope

The extension runs inside Pi with the permissions you gave Pi: it reads files, runs commands, and calls models. Problems that need an already-compromised Pi setup, a hostile `config.json` planted by someone else, or a model behaving badly as the only trigger are configuration problems, not vulnerabilities in this package.

Bugs and feature ideas go to [Issues](https://github.com/Yivas/pi-subagents-plus/issues). Problems that exist in upstream behavior belong in the [upstream repository](https://github.com/nicobailon/pi-subagents).
