# Contributing

## Before you write code

Open an issue for anything bigger than a typo or a one-line fix, so the change is agreed before the work exists.

- Bugs and feature ideas: [Issues](https://github.com/Yivas/pi-subagents-plus/issues).
- Vulnerabilities: [private vulnerability reporting](https://github.com/Yivas/pi-subagents-plus/security/advisories/new), not a public issue.

## What belongs here

This fork tracks [upstream pi-subagents](https://github.com/nicobailon/pi-subagents) and replaces it in Pi. A problem that exists in upstream behavior, and is not about how this fork ships it, belongs in the upstream repository: a fix there reaches every user.

Fork work is what this package adds on top of upstream. Features of this fork sit behind a setting that is off by default, so with every fork setting off the package behaves exactly like upstream. Tests must keep that true.

## Checks

Run these before opening a pull request:

```bash
npm run typecheck
npm run test:unit
npm run test:integration
```

`npm test` runs the unit tests only. Add or update the test that covers your change, and name it after the source file it exercises.

## Pull requests

One pull request, one change. Say what problem it solves, what you changed, and how you checked it. Expect questions about scope: a change that reaches the child launch paths, the public API, or the run lifecycle needs the design agreed before it lands.

Write code, comments, and documentation in English.
