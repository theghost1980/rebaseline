# Contributing to rebaseline

Thanks for helping. rebaseline is in beta, so the most useful contribution right now is trying it on your project and saying what happened, especially when something fails.

## Feedback and bugs

- **Beta feedback:** reply in the [beta feedback discussion](https://github.com/theghost1980/rebaseline/discussions/13), or fill in the [feedback form](https://github.com/theghost1980/rebaseline/issues/new?template=beta-feedback.yml).
- **Bugs:** open an [issue](https://github.com/theghost1980/rebaseline/issues/new?template=bug.yml) with your operating system, Node.js and Playwright versions, the command you ran and its output. Running it again with `REBASELINE_DEBUG=1` prints more details.
- **Security problems:** do not open an issue; see the [security policy](SECURITY.md).

## Changes

For anything bigger than a small fix, open an issue first so we can agree on the approach.

### Setup

You need Node.js 22 or newer and git.

```bash
git clone https://github.com/theghost1980/rebaseline
cd rebaseline
npm ci
```

### Checks

Before opening a pull request, run:

```bash
npm run typecheck
npm test
npm run build
node scripts/smoke-package.mjs
```

The end-to-end tests run the built CLI, which the test setup builds first. If tests time out on a slow machine, run the files one at a time with `npx vitest run --no-file-parallelism`. CI runs the same checks on Ubuntu, macOS and Windows.

### Pull requests

- One change per pull request, with tests for new behavior.
- Pull requests are squashed into one commit that takes the pull request title, so the title follows [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:` or `chore:`.
- Changes that users notice go in `CHANGELOG.md`.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE). Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
