import type uPlot from 'uplot';
import { describe, expect, it } from 'vitest';

import { stackedBands, stackedData } from './stacked';

describe('stackedData', () => {
	it('accumulates each subsequent series on top of the previous ones', () => {
		const [xs, first, second] = stackedData([
			[100, 200, 300],
			[1, 2, 3],
			[10, 20, 30]
		]);

		expect(xs).toEqual([100, 200, 300]);
		expect(first).toEqual([1, 2, 3]);
		expect(second).toEqual([11, 22, 33]);
	});

	it('does not accumulate a series excluded by omit, nor factor it into later series', () => {
		const [, first, omitted, third] = stackedData(
			[
				[100, 200],
				[1, 1],
				[50, 50],
				[2, 2]
			],
			{ omit: (i) => i === 2 }
		);

		expect(first).toEqual([1, 1]);
		expect(omitted).toEqual([50, 50]);
		expect(third).toEqual([3, 3]);
	});

	it('leaves null gaps in an omitted series as they are', () => {
		const [, omitted] = stackedData(
			[
				[100, 200],
				[5, null]
			],
			{ omit: (i) => i === 1 }
		);

		expect(omitted).toEqual([5, null]);
	});

	it('returns an omitted series as a fresh copy, not a reference to the input', () => {
		const sourceRow = [5, 6];
		const [, omitted] = stackedData([[100, 200], sourceRow], { omit: (i) => i === 1 });

		expect(omitted).toEqual([5, 6]);
		// mutating the result must not affect the source data
		expect(omitted).not.toBe(sourceRow);
		(omitted as number[])[0] = 999;
		expect(sourceRow[0]).toBe(5);
	});

	it('omits nothing by default', () => {
		expect(stackedData([[100], [1], [2]])).toEqual([[100], [1], [3]]);
	});

	it('holds the running total across a gap in a middle series, leaving every row dense', () => {
		const [, first, second, third] = stackedData([
			[0, 1, 2, 3],
			[10, 10, 10, 10],
			[10, null, null, 10],
			[10, 10, 10, 10]
		]);

		expect(first).toEqual([10, 10, 10, 10]);
		// the gap emits the level of the series below it, not a hole and not 0
		expect(second).toEqual([20, 10, 10, 20]);
		// the series above keeps its own thickness, dipping by exactly the missing sample
		expect(third).toEqual([30, 20, 20, 30]);
	});

	it('emits the baseline for a gap in the lowest series, so the series above fills to it', () => {
		// the reported case: a hole in the bottom series erased the band of the one above it
		const [, first, second, third] = stackedData([
			[0, 1, 2, 3, 4, 5],
			[10, 10, null, null, 10, 10],
			[10, 10, 10, 10, 10, 10],
			[10, 10, 10, 10, 10, 10]
		]);

		expect(first).toEqual([10, 10, 0, 0, 10, 10]);
		expect(second).toEqual([20, 20, 10, 10, 20, 20]);
		expect(third).toEqual([30, 30, 20, 20, 30, 30]);
	});

	it('holds a gapped top series along the stack below it too — the rule is uniform', () => {
		// Nothing is banded above the top series, so this gap would erase no fill and the held
		// line buys nothing here. It is held anyway, on purpose: stackedData's JSDoc says why the
		// rule deliberately does not ask whether a band is drawn above a given gap.
		const [, bottom, top] = stackedData([
			[0, 1],
			[10, 10],
			[5, null]
		]);

		expect(bottom).toEqual([10, 10]);
		expect(top).toEqual([15, 10]);
	});

	it('supports the documented hole recipe: re-punch the topmost stacked row from its raw gaps', () => {
		const rawTop: Array<number | null> = [5, null, NaN, 5];
		const result = stackedData([[0, 1, 2, 3], [10, 10, 10, 10], rawTop, [7, 7, null, 7]], {
			omit: (i) => i === 3
		});

		// Series 3 is omitted, so it is not part of the stack: it keeps its raw values and its own
		// gap, and the top of the *stack* is series 2 — the row the recipe applies to. That is why
		// the README says "topmost stacked series" and not "the last accumulated row".
		expect(result[3]).toEqual([7, 7, null, 7]);

		const top = result[2] as number[];
		expect(top).toEqual([15, 10, 10, 15]);

		// The recipe as documented, gap test included: `== null` alone would miss the NaN, which
		// stackedData held the total across like any other gap. Nothing is banded above the topmost
		// stacked series, so punching its gaps back in erases no neighbour's fill.
		const isGap = (v: number | null | undefined) => v == null || !Number.isFinite(v);
		expect(top.map((v, j) => (isGap(rawTop[j]) ? null : v))).toEqual([15, null, null, 15]);
	});

	it("a gap in the lowest series emits a real 0, outside that series' own data range", () => {
		const [, first] = stackedData([
			[0, 1, 2, 3],
			[100, 105, null, 102]
		]);

		// Not a marker uPlot ignores: 0 is a value it scales, so the y range now reaches down to
		// it. stackedData's JSDoc says what that does on a linear and on a log scale.
		expect(first).toEqual([100, 105, 0, 102]);
	});

	it('cannot distinguish a measured 0 from a gap — read the raw row if you need to', () => {
		const [, sampled] = stackedData([
			[0, 1],
			[0, null]
		]);

		// Cell 0 is 0 because the series measured 0; cell 1 is 0 because no sample exists and the
		// running total below it is 0. Nothing in the output separates them, which is why the
		// documented hole recipe works off the raw row rather than this one.
		expect(sampled).toEqual([0, 0]);
	});

	it.each([
		['leading', [null, null, 10, 10], [0, 0, 10, 10], [10, 10, 20, 20]],
		['trailing', [10, 10, null, null], [10, 10, 0, 0], [20, 20, 10, 10]]
	])('holds the total across %s gaps', (_label, gapped, expectedFirst, expectedSecond) => {
		const [, first, second] = stackedData([[0, 1, 2, 3], gapped, [10, 10, 10, 10]]);

		expect(first).toEqual(expectedFirst);
		expect(second).toEqual(expectedSecond);
	});

	it.each<[string, Array<number | null | undefined> | Float64Array]>([
		['null', [10, null]],
		['undefined — a hole from uPlot.join', [10, undefined]],
		['NaN — the gap marker of a typed-array row', new Float64Array([10, NaN])],
		['Infinity — a rate divided by zero', [10, Infinity]],
		['-Infinity', [10, -Infinity]]
	])('treats %s as a gap', (_label, gapped) => {
		const [, first, second] = stackedData([[0, 1], gapped, [10, 10]]);

		expect(first).toEqual([10, 0]);
		// Folded in rather than screened, a non-finite value would poison the total for every
		// series above it.
		expect(second).toEqual([20, 10]);
	});

	it('emits the baseline for every series of a column that is a gap throughout', () => {
		const [, first, second] = stackedData([
			[0, 1, 2],
			[10, null, 10],
			[10, null, 10]
		]);

		expect(first).toEqual([10, 0, 10]);
		expect(second).toEqual([20, 0, 20]);
	});

	it('re-spells NaN and ±Infinity as null in an omitted series — uPlot would read them as values', () => {
		const [, omitted] = stackedData(
			[
				[0, 1, 2, 3, 4],
				[5, NaN, Infinity, -Infinity, 5]
			],
			{ omit: (i) => i === 1 }
		);

		// uPlot's gap test is `v != null`, so left here these are values. The Infinity alone turns
		// the y range into NaN, and the NaN would too whenever a zoom made it the first point in
		// view — a blank chart, not a hole in one series.
		expect(omitted).toEqual([5, null, null, null, 5]);
	});

	it('leaves undefined in an omitted series as undefined, not null', () => {
		const [, omitted] = stackedData(
			[
				[0, 1, 2],
				[5, undefined, 5]
			],
			{ omit: (i) => i === 1 }
		);

		// toStrictEqual, since toEqual reads undefined and a missing element as the same thing.
		expect(omitted).toStrictEqual([5, undefined, 5]);
	});

	it('aligns an omitted row to the x row length too, shorter or longer', () => {
		const [xs, shorter, longer] = stackedData(
			[
				[100, 200, 300],
				[1, 1],
				[2, 2, 2, 2]
			],
			{ omit: () => true }
		);

		expect(xs).toEqual([100, 200, 300]);
		// The short row runs out into `undefined` — a real element, not a hole in the array.
		expect(shorter).toStrictEqual([1, 1, undefined]);
		expect(longer).toStrictEqual([2, 2, 2]);
	});

	it('returns new arrays without mutating the source data', () => {
		const data: uPlot.AlignedData = [
			[100, 200],
			[1, 2],
			[10, 20]
		];

		stackedData(data);

		expect(data).toEqual([
			[100, 200],
			[1, 2],
			[10, 20]
		]);
	});

	it('works with a single series (x only)', () => {
		expect(stackedData([[100, 200]])).toEqual([[100, 200]]);
	});

	it('aligns every output row to the x row length, even if the source row is shorter or longer', () => {
		const [xs, shorter, longer] = stackedData([
			[100, 200, 300],
			[1, 1],
			[2, 2, 2, 2]
		]);

		expect(xs).toEqual([100, 200, 300]);
		// The short row runs out into a gap, which holds the running total like any other.
		expect(shorter).toEqual([1, 1, 0]);
		expect(longer).toEqual([3, 3, 2]);
	});

	it('works with empty rows', () => {
		expect(stackedData([[], [], []])).toEqual([[], [], []]);
	});

	it('returns an empty result for empty input, without fabricating a phantom x row', () => {
		expect(stackedData([])).toEqual([]);
	});
});

describe('stackedBands', () => {
	it('pairs each series with the nearest preceding one', () => {
		expect(stackedBands(4)).toEqual([{ series: [2, 1] }, { series: [3, 2] }]);
	});

	it('the first series (idx 1) gets no band — there is no preceding series', () => {
		const bands = stackedBands(3);
		expect(bands.some((b) => b.series[0] === 1)).toBe(false);
	});

	it('skips omitted series both as band recipients and as preceding series', () => {
		// series 2 is hidden: it gets no band itself, and series 3 pairs with series 1 instead
		const bands = stackedBands(4, { omit: (i) => i === 2 });

		expect(bands).toEqual([{ series: [3, 1] }]);
	});

	it('builds no band when all preceding series are hidden', () => {
		const bands = stackedBands(3, { omit: (i) => i === 1 });

		expect(bands).toEqual([]);
	});

	it('returns an empty array when there are no series (x only)', () => {
		expect(stackedBands(1)).toEqual([]);
	});

	it('bands do not include fill — styling is left to the caller', () => {
		const bands = stackedBands(3);
		for (const band of bands) {
			expect(band).not.toHaveProperty('fill');
		}
	});
});
