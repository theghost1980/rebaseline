/** An image file stored in the report folder. */
export interface ReportImage {
  /** Absolute path of the file. */
  file: string;
  /** SHA-1 of the file content, or null when the file is missing. */
  sha1: string | null;
  /** SHA-256 of the file content, to match Git LFS pointers; null when the file is missing. */
  sha256?: string | null;
}

/** A failed screenshot comparison. */
export interface Shot {
  /** Unique within the report. */
  id: string;
  /** Attachment base name: "hero" for hero-actual.png. */
  name: string;
  actual: ReportImage;
  expected: ReportImage | null;
  diff: ReportImage | null;
  /** Snapshot path from "A snapshot doesn't exist at <path>", exactly as the report has it. */
  missingPath: string | null;
}

/** The last result of a test that did not pass. */
export interface Failure {
  /** Unique within the report. */
  id: string;
  title: string;
  /** Describe blocks followed by the test title. */
  titlePath: string[];
  projectName: string;
  /** Test file as the report shows it, with forward slashes. */
  file: string;
  line: number;
  column: number;
  /** Status of the last result: failed, timedOut, interrupted... */
  status: string;
  /** Number of retries before the last result. */
  retries: number;
  /** Error messages of the last result, without terminal escape codes. */
  error: string;
  /** Empty when the failure is not a screenshot comparison. */
  shots: Shot[];
  /** Every "A snapshot doesn't exist at" path found in the errors. */
  missingSnapshots: string[];
  /** A screenshot mismatch stopped the test, so later screenshots in it were not compared. */
  stoppedAtScreenshot: boolean;
}

/** Operating systems as Playwright writes them in snapshot file names. */
export type Platform = 'linux' | 'darwin' | 'win32';

export interface Report {
  /** Absolute path of the report folder. */
  dir: string;
  projectNames: string[];
  failures: Failure[];
  /** Operating system the tests ran on, when the report tells. Chooses among identical baselines of several systems. */
  platform: Platform | null;
}

/** "changed" replaces an existing baseline; "new" creates one. */
export type ShotKind = 'changed' | 'new';

export type UnresolvedReason =
  /** The actual image is not in the report folder. */
  | 'missing-image'
  /** A changed screenshot without its expected image. */
  | 'no-expected-image'
  /** No file in the repository matches the expected image. */
  | 'no-match'
  /** Several files match and nothing tells them apart. */
  | 'ambiguous'
  /** The reported path points outside this repository. */
  | 'outside-repo'
  /** The reported path cannot be used as a repository path. */
  | 'invalid-path';

/**
 * How a target was found: a tracked file, a tracked Git LFS pointer whose
 * image is not downloaded, a file git does not track yet, or the path
 * reported for a new screenshot.
 */
export type ResolvedVia = 'tracked' | 'lfs' | 'untracked' | 'path';

/** Where an accepted screenshot would be written. */
export type Resolution =
  | { status: 'resolved'; kind: ShotKind; target: string; via: ResolvedVia }
  | { status: 'unresolved'; kind: ShotKind; reason: UnresolvedReason; candidates: string[] };
