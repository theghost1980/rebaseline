import { runGit } from '../core/git.js';
import { UserError } from '../lib/errors.js';

export interface RepoRef {
  /** github.com, or the host of a GitHub Enterprise server. */
  host: string;
  owner: string;
  name: string;
}

/** The [HOST/]OWNER/REPO form gh accepts in --repo. */
export function repoName(repo: RepoRef): string {
  return repo.host === 'github.com' ? `${repo.owner}/${repo.name}` : `${repo.host}/${repo.owner}/${repo.name}`;
}

export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return repoName(a).toLowerCase() === repoName(b).toLowerCase();
}

function isSegment(s: string | undefined): s is string {
  return s !== undefined && /^[\w.-]+$/.test(s) && s !== '.' && s !== '..';
}

function repoRef(host: string, owner: string | undefined, name: string | undefined): RepoRef | null {
  const lowerHost = host.toLowerCase();
  if (!isSegment(owner) || !isSegment(name)) return null;
  return { host: lowerHost === 'www.github.com' ? 'github.com' : lowerHost, owner, name };
}

/** Parses "owner/name" or "host/owner/name". */
export function parseRepoName(value: string): RepoRef | null {
  const parts = value.trim().replace(/\.git$/i, '').split('/');
  if (parts.length === 2) return repoRef('github.com', parts[0], parts[1]);
  if (parts.length === 3 && parts[0]) return repoRef(parts[0], parts[1], parts[2]);
  return null;
}

/** Parses a git remote URL: https://host/owner/name.git, ssh://git@host/owner/name or git@host:owner/name. */
export function parseRemoteUrl(url: string): RepoRef | null {
  const value = url.trim();
  const match =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(value) ?? /^(?:[^@/\\]+@)?([^/:\\]+):(?!\/)(.+)$/.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const parts = match[2].replace(/\/+$/, '').replace(/\.git$/i, '').split('/');
  return parts.length === 2 ? repoRef(match[1], parts[0], parts[1]) : null;
}

/** A remote URL for messages, without any user name or token in it. */
function safeUrl(url: string): string {
  return url.replace(/^([a-z+]+:\/\/)[^@/]+@/i, '$1');
}

/**
 * The GitHub repository to read runs from: --repo, then GH_REPO, then the
 * remote chosen with "gh repo set-default", then origin or the only remote.
 */
export async function findRepo(cwd: string, explicit?: string): Promise<RepoRef> {
  if (explicit !== undefined) {
    const repo = parseRepoName(explicit);
    if (!repo) throw new UserError(`Invalid --repo: ${explicit}`, 'Use the form owner/name, for example --repo octo-org/website.');
    return repo;
  }
  const fromEnv = process.env.GH_REPO;
  if (fromEnv) {
    const repo = parseRepoName(fromEnv);
    if (!repo) throw new UserError(`Invalid GH_REPO: ${fromEnv}`, 'Set it to owner/name, or remove it to use the git remote.');
    return repo;
  }

  // Exits with 1 when nothing matches, so a failure here means "no remotes".
  const config = await runGit(['config', '--get-regexp', '^remote\\..*\\.(url|gh-resolved)$'], cwd).catch(() => '');
  const urls = new Map<string, string>();
  let resolved: string | null = null;
  for (const line of config.split(/\r?\n/)) {
    const m = /^remote\.(.+)\.(url|gh-resolved) (.*)$/.exec(line.trim());
    if (!m?.[1] || m[3] === undefined) continue;
    if (m[2] === 'url') {
      if (!urls.has(m[1])) urls.set(m[1], m[3]);
    } else if (m[3] === 'base') {
      resolved = m[1];
    } else {
      const repo = parseRepoName(m[3]);
      if (repo) return repo;
    }
  }

  let remote: string | undefined;
  if (resolved && urls.has(resolved)) remote = resolved;
  else if (urls.has('origin')) remote = 'origin';
  else if (urls.size === 1) remote = [...urls.keys()][0];

  if (!remote) {
    throw new UserError(
      urls.size === 0 ? 'This repository has no git remote' : 'This repository has several git remotes and none is called origin',
      'Pass the GitHub repository with --repo owner/name.',
    );
  }
  const url = urls.get(remote) ?? '';
  const repo = parseRemoteUrl(url);
  if (!repo) {
    throw new UserError(`The ${remote} remote is not a GitHub repository: ${safeUrl(url)}`, 'Pass the GitHub repository with --repo owner/name.');
  }
  return repo;
}

/** The branch name on the remote for the current checkout. */
export async function currentBranch(cwd: string): Promise<string> {
  let branch: string;
  try {
    branch = (await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)).trim();
  } catch {
    throw new UserError('Your checkout is not on a branch', 'Choose the run with --run <id|url> or --pr <number>.');
  }
  // A local branch can track a remote branch with another name.
  const merge = (await runGit(['config', '--get', `branch.${branch}.merge`], cwd).catch(() => '')).trim();
  return merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : branch;
}

/** The commit checked out, or null in a repository without commits. */
export async function headCommit(cwd: string): Promise<string | null> {
  try {
    return (await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd)).trim() || null;
  } catch {
    return null;
  }
}
