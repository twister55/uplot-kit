import { describe, expect, it } from 'vitest';

import { describeValue, optionOr } from './utils';

describe('describeValue', () => {
	it('spells a number with String, so NaN and the infinities stay distinguishable', () => {
		// JSON.stringify renders all three as `null`, which is the whole reason this function exists:
		// "got null — falling back to null" names none of the three values it is most often given.
		expect(describeValue(NaN)).toBe('NaN');
		expect(describeValue(Infinity)).toBe('Infinity');
		expect(describeValue(-Infinity)).toBe('-Infinity');
		expect(describeValue(1.5)).toBe('1.5');
	});

	it('keeps JSON quoting for everything else, so a string option is visibly a string', () => {
		expect(describeValue('Month')).toBe('"Month"');
		expect(describeValue(null)).toBe('null');
		expect(describeValue(true)).toBe('true');
		expect(describeValue({ base: 2 })).toBe('{"base":2}');
	});

	it.each([
		['undefined', undefined, 'undefined'],
		['a function', () => 1, 'function'],
		['a symbol', Symbol('tz'), 'symbol']
	])('returns a string for %s, which JSON.stringify does not', (_label, value, expected) => {
		// `JSON.stringify` answers with the *value* `undefined` for all three, so the declared
		// `: string` was a lie and any caller doing more than interpolating it would break.
		const described = describeValue(value);

		expect(typeof described).toBe('string');
		expect(described).toBe(expected);
	});

	it.each([
		[
			'a circular object',
			(): unknown => {
				const circular: Record<string, unknown> = {};

				circular.self = circular;

				return circular;
			}
		],
		['a bigint nested in an object', (): unknown => ({ size: 1n })]
	])('does not throw on %s', (_label, build) => {
		// CLAUDE.md's policy is that nothing in src/ throws — and this runs from inside a warning
		// about a bad option, which is the last place that should take the process down.
		expect(() => describeValue(build())).not.toThrow();
		expect(describeValue(build())).toBe('object');
	});

	it('spells a bigint like a number rather than throwing', () => {
		expect(describeValue(9007199254740993n)).toBe('9007199254740993');
	});
});

describe('optionOr', () => {
	it('returns the value and warns about nothing when it is valid', () => {
		const warnings: string[] = [];

		expect(optionOr((detail) => warnings.push(detail), 'base', 2, true, 'a number', 10)).toBe(2);
		expect(warnings).toStrictEqual([]);
	});

	it('names the option, the requirement, the value and the fallback in one warning', () => {
		const warnings: string[] = [];

		expect(optionOr((detail) => warnings.push(detail), 'base', NaN, false, 'finite', 10)).toBe(10);
		expect(warnings).toStrictEqual(['base must be finite, got NaN — falling back to 10']);
	});
});
