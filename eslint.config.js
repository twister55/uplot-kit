import path from 'node:path';

import js from '@eslint/js';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importPlugin from 'eslint-plugin-import-x';
import perfectionist from 'eslint-plugin-perfectionist';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	importPlugin.flatConfigs.recommended,
	importPlugin.flatConfigs.typescript,
	{
		languageOptions: {
			globals: {
				...globals.browser
			}
		},
		plugins: {
			perfectionist,
			'unused-imports': unusedImports
		},
		settings: {
			// Resolve imports through tsconfig paths
			'import-x/resolver-next': [createTypeScriptImportResolver()]
		},
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off',

			'object-shorthand': 'error',
			eqeqeq: ['error', 'always', { null: 'ignore' }],
			'prefer-template': 'error',
			'no-console': ['warn', { allow: ['warn', 'error'] }],
			'no-nested-ternary': 'error',
			'no-promise-executor-return': 'error',
			'no-await-in-loop': 'warn',
			'no-restricted-syntax': [
				'error',
				{
					selector: 'ForInStatement',
					message: 'Use Object.keys/entries/values instead of for...in.'
				},
				{ selector: 'WithStatement', message: 'with is not allowed.' }
			],
			'@typescript-eslint/no-inferrable-types': 'error',
			'no-throw-literal': 'error',
			'@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
			'@typescript-eslint/no-non-null-assertion': 'warn',

			// unused-imports: auto-removes unused imports via --fix
			'@typescript-eslint/no-unused-vars': 'off',
			'unused-imports/no-unused-imports': 'error',
			'unused-imports/no-unused-vars': [
				'error',
				{
					args: 'all',
					argsIgnorePattern: '^_',
					caughtErrors: 'all',
					caughtErrorsIgnorePattern: '^_',
					destructuredArrayIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					ignoreRestSiblings: true
				}
			],

			// type imports: import type { A } for type-only, import { fn, type A } for mixed
			'@typescript-eslint/consistent-type-imports': [
				'error',
				{
					prefer: 'type-imports',
					fixStyle: 'inline-type-imports',
					disallowTypeAnnotations: false
				}
			],
			'@typescript-eslint/no-import-type-side-effects': 'error',

			// import-x
			// Published code may only reach for peer deps; devDeps are for tooling and tests.
			'import-x/no-extraneous-dependencies': [
				'error',
				{
					devDependencies: ['*.config.ts', '*.config.js', '**/*.test.ts', '**/*.spec.ts'],
					peerDependencies: true
				}
			],
			'import-x/no-named-as-default-member': 'off',
			'import-x/no-duplicates': ['error', { considerQueryString: true }],
			'import-x/newline-after-import': 'error',
			'import-x/order': [
				'error',
				{
					groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
					pathGroupsExcludedImportTypes: ['builtin'],
					'newlines-between': 'always',
					alphabetize: { order: 'asc', caseInsensitive: true }
				}
			],

			'perfectionist/sort-named-imports': [
				'error',
				{
					type: 'natural',
					// value imports first, then type imports
					groups: ['value-import', 'type-import']
				}
			]
		}
	},
	// Root config files run in Node
	{
		files: ['*.config.ts', '*.config.js'],
		languageOptions: {
			globals: {
				...globals.node
			}
		}
	},

	// Keep last — turns off rules that conflict with prettier, which `pnpm lint` runs separately
	prettier,

	// eslint-config-prettier turns off curly; re-enable it after prettier so it actually
	// runs. Line length is left to prettier's printWidth — max-len is deliberately not
	// restored.
	{
		rules: {
			curly: ['error', 'all']
		}
	}
);
