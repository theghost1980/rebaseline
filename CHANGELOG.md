# Changelog

## Versions

- **Betas** are published as `0.1.0-beta.N` under the npm `beta` tag, so you run them with `npx rebaseline@beta`. Until `0.1.0`, a plain `npx rebaseline` installs `0.0.1`, which only holds the name.
- **Between betas**, commands and options may still change. Every change is listed here.
- **`0.1.0`** is published as `latest` once beta testers have used rebaseline on their own projects and no serious bug is open. A serious bug is one that writes to the wrong file or loses data, breaks `review` or `pull`, or makes rebaseline fail on a supported system.
- **After `0.1.0`**, while the version is `0.x`, a minor version (`0.2.0`) can change behavior and a patch version (`0.1.1`) only fixes bugs.

## 0.1.0-beta.0 (unreleased)

First public beta.

- `review`: reviews a local Playwright HTML report in the browser and writes the screenshots you accept to their baseline files. `--run` runs the tests first.
- `pull`: does the same with the report of a GitHub Actions run, chosen from the current branch, a pull request (`--pr`) or a run (`--run`). Sharded reports are joined.
- Baselines are found by content, so any `snapshotPathTemplate` works. Git LFS pointers are supported.
- Playwright 1.40 to 1.64, Node.js 22 or newer, on macOS, Windows and Linux.
