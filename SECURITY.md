# Security policy

## Supported versions

Security fixes go into the newest release only. During the beta, that is the newest `0.1.0-beta.N`.

## Reporting a vulnerability

Please do not open a public issue. Report it privately on GitHub: open the [Security tab](https://github.com/theghost1980/rebaseline/security), click **Report a vulnerability**, and describe the problem, how to reproduce it and what it affects.

You can expect a first answer within a week. Once a fix is published, the advisory is made public and credits you, unless you prefer otherwise.

## What rebaseline promises

- It writes only `.png` files, only inside the current git repository and never in `.git`, and only when you accept a screenshot on the review page.
- The review page is served on `127.0.0.1` only. Its address holds a random token that the page's requests must carry, and requests made under another host name are refused.
- `pull` uses your GitHub CLI (`gh`) to read workflow runs and download their artifacts into a temporary folder that is removed afterwards. `review --report <zip>` extracts a zip you downloaded in the same way.
- It sends no data anywhere and has no telemetry.

Reports that break one of these promises are especially welcome: for example, a report or artifact that makes rebaseline write outside the repository, or a web page that can act on the review page.
