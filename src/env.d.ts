/** Package version, injected at build time by tsup and vitest. */
declare const __VERSION__: string;

/** The review page as one HTML string, produced at build time from src/ui. */
declare module 'virtual:ui-html' {
  const html: string;
  export default html;
  /** The logo, src/ui/logo.svg, served as the favicon. */
  export const faviconSvg: string;
  /** src/ui/favicon.ico (16 and 32 px), in base64. */
  export const faviconIco: string;
}
