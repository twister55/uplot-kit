import { defineConfig } from 'tsup';

export default defineConfig({
	tsconfig: 'tsconfig.app.json',
	entry: ['src/index.ts'],
	format: ['esm'],
	dts: { compilerOptions: { composite: false } },
	sourcemap: true,
	clean: true,
	treeshake: true,
	outDir: 'dist',
	target: 'es2022',
	external: ['uplot']
});
