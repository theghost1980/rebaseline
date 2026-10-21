/** Package version, injected at build time by tsup and vitest. */
declare const __VERSION__: string;

/** The review page as one HTML string, produced at build time from src/ui. */
declare module 'virtual:ui-html' {
  const html: string;
  export default html;
}
