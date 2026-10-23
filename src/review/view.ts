// Data exchanged between the local server and the review page. Types only:
// this file is also compiled for the browser.

export type Decision = 'pending' | 'accepted' | 'rejected';

export type ImageKind = 'expected' | 'actual' | 'diff';

export interface ShotView {
  id: string;
  /** Screenshot name, such as "hero". */
  name: string;
  project: string;
  title: string;
  titlePath: string[];
  file: string;
  line: number;
  retries: number;
  error: string;
  /** The test stopped at this screenshot, so it may have more after it. */
  stoppedAtScreenshot: boolean;
  kind: 'changed' | 'new';
  /** Repository path that accepting writes, when it is known. */
  target: string | null;
  /** "untracked" when the file exists but git does not track it yet; "lfs" when it is a Git LFS pointer. */
  via: 'tracked' | 'lfs' | 'untracked' | 'path' | null;
  /** Why the screenshot cannot be accepted. */
  unresolved: { reason: string; message: string; candidates: string[] } | null;
  images: Record<ImageKind, boolean>;
  decision: Decision;
  /** Ids of other screenshots that would write the same file. */
  sameTarget: string[];
}

export interface OtherFailureView {
  id: string;
  project: string;
  title: string;
  titlePath: string[];
  file: string;
  line: number;
  status: string;
  error: string;
  /** New snapshots Playwright reported but did not save (update mode "none"). */
  unsavedSnapshots: string[];
}

export interface StateView {
  version: string;
  /** Report folder, for display. */
  report: string;
  projects: string[];
  shots: ShotView[];
  /** Failures that are not screenshot comparisons. */
  others: OtherFailureView[];
}

export interface ActionResult {
  shot: ShotView;
  /** Extra information for the user, such as "previous file restored". */
  message?: string;
}

export interface ErrorResult {
  error: string;
}
