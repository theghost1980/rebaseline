// Stand-in for the GitHub CLI, used through REBASELINE_GH.
//
// FAKE_GH points at a JSON file with the data to serve:
//   runs:      runs as "gh run list --json" prints them, newest first
//   artifacts: { "<run id>": [{ id, name, size_in_bytes, expired, created_at, dir? }] }
//              "dir" is the folder "gh run download" copies for that artifact
//   prs:       { "<number>": { number, headRefName, headRefOid, url } }
//   fail:      { "<command>": { code, stderr } }, for example "run list"
// Every call is appended to <FAKE_GH>.calls as a JSON array, one per line.

const fs = require('node:fs');

const args = process.argv.slice(2);
const dataFile = process.env.FAKE_GH;
const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
fs.appendFileSync(`${dataFile}.calls`, `${JSON.stringify(args)}\n`);

function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function print(value) {
  process.stdout.write(JSON.stringify(value));
}

const command = args[0] === 'api' ? 'api' : `${args[0]} ${args[1]}`;
const failure = data.fail?.[command];
if (failure) fail(failure.code ?? 1, failure.stderr);

if (command === 'run list') {
  const branch = flag('--branch');
  const commit = flag('--commit');
  const runs = (data.runs ?? []).filter((r) => (!branch || r.headBranch === branch) && (!commit || r.headSha === commit));
  print(runs.slice(0, Number(flag('--limit') ?? 20)));
} else if (command === 'run view') {
  const run = (data.runs ?? []).find((r) => String(r.databaseId) === args[2]);
  if (!run) fail(1, `failed to get run: HTTP 404: Not Found (https://api.github.com/repos/x/y/actions/runs/${args[2]})`);
  print(run);
} else if (command === 'pr view') {
  const pr = data.prs?.[args[2]];
  if (!pr) fail(1, `GraphQL: Could not resolve to a PullRequest with the number of ${args[2]}. (repository.pullRequest)`);
  print(pr);
} else if (command === 'api') {
  const m = /actions\/runs\/(\d+)\/artifacts\?.*page=(\d+)/.exec(args[args.length - 1]);
  if (!m) fail(1, `unexpected api call: ${args.join(' ')}`);
  const list = (data.artifacts?.[m[1]] ?? []).map(({ dir, ...artifact }) => artifact);
  print({ total_count: list.length, artifacts: m[2] === '1' ? list : [] });
} else if (command === 'run download') {
  const artifact = (data.artifacts?.[args[2]] ?? []).find((a) => a.name === flag('-n'));
  if (!artifact) fail(1, 'no valid artifacts found to download');
  const dest = flag('-D');
  fs.mkdirSync(dest, { recursive: true });
  if (artifact.dir) fs.cpSync(artifact.dir, dest, { recursive: true });
} else {
  fail(1, `unknown command "${args[0]}" for "gh"`);
}
