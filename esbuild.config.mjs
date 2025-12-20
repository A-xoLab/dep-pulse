import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'], // VS Code provides this at runtime
  format: 'cjs', // VS Code extensions must use CommonJS
  platform: 'node',
  target: 'node18', // Match VS Code's Node.js version
  sourcemap: !isProduction,
  minify: isProduction,
  // Keep class names and function names for better error messages
  keepNames: true,
  // Log build info
  logLevel: 'info',
};

async function build() {
  try {
    if (isWatch) {
      // Watch mode for development
      const context = await esbuild.context(buildOptions);
      await context.watch();
      console.log('Watching for changes...');
    } else {
      // Single build
      await esbuild.build(buildOptions);
      console.log('Build complete!');
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();

