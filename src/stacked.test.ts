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

	it('preserves null gaps in an omitted series: raw values are not rewritten', () => {
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

	it('keeps a null gap as a gap, and counts it as zero toward the series above', () => {
		const [, first, second] = stackedData([
			[100, 200],
			[1, null],
			[10, 20]
		]);

		expect(first).toEqual([1, null]);
		expect(second).toEqual([11, 20]);
	});

	it('keeps an undefined gap as a gap — holes from uPlot.join do not poison series above', () => {
		const [, first, second] = stackedData([
			[100, 200],
			[1, undefined],
			[10, 20]
		]);

		expect(first).toEqual([1, null]);
		expect(second).toEqual([11, 20]);
	});

	it('keeps a NaN gap as a gap — the output marker is null, since output rows are plain arrays', () => {
		const [, first, second] = stackedData([
			new Float64Array([100, 200]),
			new Float64Array([1, NaN]),
			new Float64Array([5, 5])
		]);

		expect(first).toEqual([1, null]);
		expect(second).toEqual([6, 5]);
	});

	it('does not continue a top series across its gap along the stack below it', () => {
		const [, bottom, top] = stackedData([
			[0, 1],
			[10, 10],
			[5, null]
		]);

		expect(bottom).toEqual([10, 10]);
		expect(top).toEqual([15, null]);
	});

	it('resumes a series with the correct running total after a gap in its middle', () => {
		const [, bottom, top] = stackedData([
			[0, 1, 2, 3],
			[1, 1, 1, 1],
			[2, null, 2, 2]
		]);

		expect(bottom).toEqual([1, 1, 1, 1]);
		expect(top).toEqual([3, null, 3, 3]);
	});

	it('dips the series above a gap in a lower series, rather than breaking it', () => {
		const [, bottom, top] = stackedData([
			[0, 1],
			[5, null],
			[10, 10]
		]);

		expect(bottom).toEqual([5, null]);
		expect(top).toEqual([15, 10]);
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
		// The short row runs out into a gap, not a repeat of the running total.
		expect(shorter).toEqual([1, 1, null]);
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
