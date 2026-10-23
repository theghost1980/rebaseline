import type { Failure, Report, Resolution, Shot, UnresolvedReason } from '../core/types.js';
import { type WriteResult, WriterError, restoreBaseline, writeBaseline } from '../core/writer.js';
import { displayPath } from '../lib/paths.js';
import type { ActionResult, Decision, ImageKind, OtherFailureView, ShotView, StateView } from './view.js';

/** An action the page asked for could not be done. `status` is the HTTP status to answer with. */
export class SessionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SessionError';
    this.status = status;
  }
}

interface Entry {
  failure: Failure;
  shot: Shot;
  resolution: Resolution;
  decision: Decision;
  /** Set while the accepted image is on disk. */
  write: WriteResult | null;
}

export interface AcceptedFile {
  target: string;
  kind: 'changed' | 'new';
  untracked: boolean;
  /** The file was a Git LFS pointer; it now holds the image. */
  lfs: boolean;
  created: boolean;
}

export interface SessionResults {
  accepted: AcceptedFile[];
  rejected: number;
  pending: number;
  /** New screenshots that were rejected: [target, sha1 of the reported image]. */
  rejectedNew: { target: string; sha1: string }[];
}

const UNRESOLVED_MESSAGES: Record<UnresolvedReason, string> = {
  'missing-image': 'The screenshot image is missing from the report folder.',
  'no-expected-image': 'The report has no expected image for this screenshot.',
  'no-match': 'Could not find the baseline file for this screenshot in this folder.',
  ambiguous: 'Several files could be the baseline for this screenshot.',
  'outside-repo': 'The snapshot path in the report is outside this repository.',
  'invalid-path': 'The snapshot path in the report cannot be used.',
};

export class ReviewSession {
  readonly report: Report;
  readonly root: string;
  private readonly entries = new Map<string, Entry>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(report: Report, resolutions: Map<string, Resolution>, root: string) {
    this.report = report;
    this.root = root;
    for (const failure of report.failures) {
      for (const shot of failure.shots) {
        const resolution = resolutions.get(shot.id);
        if (!resolution) throw new Error(`No resolution for screenshot ${shot.id}`);
        this.entries.set(shot.id, { failure, shot, resolution, decision: 'pending', write: null });
      }
    }
  }

  view(): StateView {
    return {
      version: __VERSION__,
      report: displayPath(this.report.dir),
      projects: this.report.projectNames,
      shots: [...this.entries.values()].map((e) => this.shotView(e)),
      others: this.report.failures.filter((f) => f.shots.length === 0).map(otherView),
    };
  }

  /** File to serve for an image of a screenshot, or null. */
  imagePath(id: string, kind: ImageKind): string | null {
    const shot = this.entries.get(id)?.shot;
    const image = shot?.[kind];
    return image && image.sha1 !== null ? image.file : null;
  }

  accept(id: string): Promise<ActionResult> {
    return this.serial(async () => {
      const entry = this.entry(id);
      const { resolution } = entry;
      if (resolution.status !== 'resolved') {
        throw new SessionError(409, `This screenshot cannot be accepted. ${UNRESOLVED_MESSAGES[resolution.reason]}`);
      }
      if (entry.decision === 'accepted') return { shot: this.shotView(entry) };

      const other = [...this.entries.values()].find(
        (e) => e !== entry && e.decision === 'accepted' && e.write?.target === resolution.target,
      );
      if (other) {
        throw new SessionError(409, `"${other.failure.title}" was already accepted for ${resolution.target}. Reject it first.`);
      }

      try {
        entry.write = await writeBaseline(this.root, resolution.target, entry.shot.actual.file);
      } catch (err) {
        throw err instanceof WriterError ? new SessionError(409, err.message) : err;
      }
      entry.decision = 'accepted';
      return { shot: this.shotView(entry) };
    });
  }

  reject(id: string): Promise<ActionResult> {
    return this.serial(async () => {
      const entry = this.entry(id);
      let message: string | undefined;
      if (entry.decision === 'accepted' && entry.write) {
        if (entry.write.previous) {
          try {
            await restoreBaseline(this.root, entry.write.target, entry.write.previous);
          } catch (err) {
            throw err instanceof WriterError ? new SessionError(409, err.message) : err;
          }
          message = `Restored the previous ${entry.write.target}.`;
        } else {
          message = `${entry.write.target} was already created and stays on disk.`;
        }
        entry.write = null;
      }
      entry.decision = 'rejected';
      return message ? { shot: this.shotView(entry), message } : { shot: this.shotView(entry) };
    });
  }

  /** Resolves when no accept or reject is in progress. */
  async idle(): Promise<void> {
    await this.queue;
  }

  results(): SessionResults {
    const entries = [...this.entries.values()];
    return {
      accepted: entries.flatMap((e) =>
        e.decision === 'accepted' && e.write && e.resolution.status === 'resolved'
          ? [
              {
                target: e.write.target,
                kind: e.resolution.kind,
                untracked: e.resolution.via === 'untracked',
                lfs: e.resolution.via === 'lfs',
                created: e.write.created,
              },
            ]
          : [],
      ),
      rejected: entries.filter((e) => e.decision === 'rejected').length,
      pending: entries.filter((e) => e.decision === 'pending').length,
      rejectedNew: entries.flatMap((e) =>
        e.decision === 'rejected' && e.resolution.status === 'resolved' && e.resolution.kind === 'new' && e.shot.actual.sha1
          ? [{ target: e.resolution.target, sha1: e.shot.actual.sha1 }]
          : [],
      ),
    };
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new SessionError(404, 'Unknown screenshot');
    return entry;
  }

  /** Runs actions one at a time so two quick clicks never write the same file at once. */
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action, action);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private shotView(entry: Entry): ShotView {
    const { failure, shot, resolution } = entry;
    const target = resolution.status === 'resolved' ? resolution.target : null;
    return {
      id: shot.id,
      name: shot.name,
      project: failure.projectName,
      title: failure.title,
      titlePath: failure.titlePath,
      file: failure.file,
      line: failure.line,
      retries: failure.retries,
      error: failure.error,
      stoppedAtScreenshot: failure.stoppedAtScreenshot && shot.missingPath === null,
      kind: resolution.kind,
      target,
      via: resolution.status === 'resolved' ? resolution.via : null,
      unresolved:
        resolution.status === 'unresolved'
          ? { reason: resolution.reason, message: UNRESOLVED_MESSAGES[resolution.reason], candidates: resolution.candidates }
          : null,
      images: {
        expected: shot.expected?.sha1 != null && resolution.kind === 'changed',
        actual: shot.actual.sha1 !== null,
        diff: shot.diff?.sha1 != null,
      },
      decision: entry.decision,
      sameTarget: target
        ? [...this.entries.values()]
            .filter((e) => e !== entry && e.resolution.status === 'resolved' && e.resolution.target === target)
            .map((e) => e.shot.id)
        : [],
    };
  }
}

function otherView(failure: Failure): OtherFailureView {
  return {
    id: failure.id,
    project: failure.projectName,
    title: failure.title,
    titlePath: failure.titlePath,
    file: failure.file,
    line: failure.line,
    status: failure.status,
    error: failure.error,
    unsavedSnapshots: unsavedSnapshots(failure),
  };
}

/** "Snapshot doesn't exist" paths that came without an image: Playwright did not save them. */
export function unsavedSnapshots(failure: Failure): string[] {
  return failure.missingSnapshots.filter((p) => !failure.shots.some((s) => s.missingPath === p));
}
