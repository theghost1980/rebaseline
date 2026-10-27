import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Options } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

type EsbuildPlugin = NonNullable<Options['esbuildPlugins']>[number];

/**
 * Provides `virtual:ui-html`: the page in src/ui, with its logo, CSS and
 * bundled script inlined, as one string, plus the favicons (the logo as SVG,
 * and favicon.ico in base64). The CLI serves them without extra files.
 */
const uiPage: EsbuildPlugin = {
  name: 'ui-page',
  setup(build) {
    build.onResolve({ filter: /^virtual:ui-html$/ }, () => ({ path: 'ui-html', namespace: 'ui-page' }));
    build.onLoad({ filter: /.*/, namespace: 'ui-page' }, async () => {
      const result = await build.esbuild.build({
        entryPoints: ['src/ui/main.ts'],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        minify: true,
        legalComments: 'none',
        metafile: true,
      });
      const script = (result.outputFiles?.[0]?.text ?? '').replace(/<\/script/gi, '<\\/script');
      const styles = readFileSync('src/ui/styles.css', 'utf8');
      const logo = readFileSync('src/ui/logo.svg', 'utf8').trim();
      const html = readFileSync('src/ui/index.html', 'utf8')
        .replace('<!--__LOGO__-->', () => logo)
        .replace('/*__STYLES__*/', () => styles)
        .replace('/*__SCRIPT__*/', () => script);
      const ico = readFileSync('src/ui/favicon.ico').toString('base64');
      return {
        contents: [
          `export default ${JSON.stringify(html)};`,
          `export const faviconSvg = ${JSON.stringify(logo)};`,
          `export const faviconIco = ${JSON.stringify(ico)};`,
        ].join('\n'),
        loader: 'js',
        watchFiles: ['src/ui/index.html', 'src/ui/styles.css', 'src/ui/logo.svg', 'src/ui/favicon.ico', ...Object.keys(result.metafile?.inputs ?? {})],
      };
    });
  },
};

/** Licenses that may be bundled into the CLI. */
const ALLOWED_LICENSES = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);

/**
 * Writes THIRD_PARTY_LICENSES.txt next to the output with the license of every
 * package bundled into it, and fails the build if one is not allowed.
 */
const thirdPartyLicenses: EsbuildPlugin = {
  name: 'third-party-licenses',
  setup(build) {
    build.initialOptions.metafile = true;
    build.onEnd((result) => {
      if (!result.metafile || result.errors.length > 0) return;
      // The package folder of each bundled file: the part up to the last node_modules/<name> or node_modules/@scope/<name>.
      const roots = new Set<string>();
      for (const input of Object.keys(result.metafile.inputs)) {
        const root = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, '/'))?.[1];
        if (root) roots.add(root);
      }
      const sections = [...roots].sort().map((root) => {
        const meta = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string; version: string; license?: string };
        if (!meta.license || !ALLOWED_LICENSES.has(meta.license)) {
          throw new Error(`${meta.name} cannot be bundled: its license (${meta.license ?? 'none'}) is not in the allowed list`);
        }
        const file = readdirSync(root).find((name) => /^licen[cs]e/i.test(name));
        const text = file ? readFileSync(path.join(root, file), 'utf8').trim() : `License: ${meta.license}`;
        return `${meta.name}@${meta.version} (${meta.license})\n\n${text}`;
      });
      const outDir = build.initialOptions.outdir ?? 'dist';
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        path.join(outDir, 'THIRD_PARTY_LICENSES.txt'),
        `The rebaseline CLI includes the following packages. Their licenses follow.\n\n${sections.join(`\n\n${'-'.repeat(72)}\n\n`)}\n`,
      );
    });
  },
};

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  // Every dependency goes into dist/cli.js, so npx downloads one small package.
  noExternal: [/.*/],
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  esbuildPlugins: [uiPage, thirdPartyLicenses],
});
