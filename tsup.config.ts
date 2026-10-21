import { readFileSync } from 'node:fs';
import { defineConfig, type Options } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

type EsbuildPlugin = NonNullable<Options['esbuildPlugins']>[number];

/**
 * Provides `virtual:ui-html`: the page in src/ui, with its CSS and bundled
 * script inlined, as one string. The CLI serves it without extra files.
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
      const html = readFileSync('src/ui/index.html', 'utf8')
        .replace('/*__STYLES__*/', () => styles)
        .replace('/*__SCRIPT__*/', () => script);
      return {
        contents: `export default ${JSON.stringify(html)};`,
        loader: 'js',
        watchFiles: ['src/ui/index.html', 'src/ui/styles.css', ...Object.keys(result.metafile?.inputs ?? {})],
      };
    });
  },
};

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  esbuildPlugins: [uiPage],
});
