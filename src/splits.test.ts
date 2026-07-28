import type uPlot from 'uplot';
import { describe, expect, it, vi } from 'vitest';

import {
	splitsForCategory,
	splitsForLog,
	splitsForStep,
	splitsForTime,
	splitsWithEdges,
	splitsWithFilter,
	splitsWithInclude,
	splitsWithLimit,
	type SplitsFn,
	type SplitsForTimeGranularity
} from './splits';

// splitsForTime reads nothing off the uPlot instance, so an empty stub stands in for it.
function fakeSelf(): uPlot {
	return {} as uPlot;
}

function unixSec(iso: string): number {
	return Date.parse(iso) / 1000;
}

describe('splitsForTime', () => {
	it('ticks daily boundaries at midnight UTC for a multi-day range', () => {
		const splits = splitsForTime({ granularity: 'day' });
		const scaleMin = unixSec('2026-01-01T06:00:00Z');
		const scaleMax = unixSec('2026-01-04T18:00:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		// every tick is a real midnight boundary inside the range — no injected range edges
		expect(result.length).toBeGreaterThan(0);
		for (const value of result) {
			expect(value % 86400).toBe(0);
			expect(value).toBeGreaterThanOrEqual(scaleMin);
			expect(value).toBeLessThanOrEqual(scaleMax);
		}
	});

	it('shifts day boundaries by offsetSec', () => {
		const offsetSec = 3 * 3600; // UTC+3
		const splits = splitsForTime({ granularity: 'day', offsetSec });
		const scaleMin = unixSec('2026-01-01T00:30:00Z');
		const scaleMax = unixSec('2026-01-03T00:30:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		for (const value of result) {
			// midnight in UTC+3 is 21:00 UTC the day before, i.e. (value + offsetSec) % 86400 === 0
			expect((value + offsetSec) % 86400).toBe(0);
		}
	});

	it('does not emit ticks finer than the requested granularity', () => {
		const splits = splitsForTime({ granularity: 'week' });
		const scaleMin = unixSec('2026-01-01T00:00:00Z');
		const scaleMax = unixSec('2026-01-15T00:00:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		// week starts are Sundays (day-of-week 0)
		expect(result.length).toBe(2);
		for (const value of result) {
			expect(new Date(value * 1000).getUTCDay()).toBe(0);
		}
	});

	it('honours the granularity floor on a range the finer levels would still cover', () => {
		// 5 days is inside the day level's own ~10-day limit, so the ladder would tick daily
		// unless the requested floor actually removes the finer levels — the one range shape
		// that tells the two apart
		const scaleMin = unixSec('2026-01-01T00:00:00Z');
		const scaleMax = unixSec('2026-01-06T00:00:00Z');

		expect(splitsForTime({ granularity: 'day' })(fakeSelf(), 0, scaleMin, scaleMax, 0, 0)).toEqual([
			unixSec('2026-01-01T00:00:00Z'),
			unixSec('2026-01-02T00:00:00Z'),
			unixSec('2026-01-03T00:00:00Z'),
			unixSec('2026-01-04T00:00:00Z'),
			unixSec('2026-01-05T00:00:00Z'),
			unixSec('2026-01-06T00:00:00Z')
		]);
		// a week floor keeps only the Sunday, a month floor nothing at all
		expect(splitsForTime({ granularity: 'week' })(fakeSelf(), 0, scaleMin, scaleMax, 0, 0)).toEqual(
			[unixSec('2026-01-04T00:00:00Z')]
		);
		expect(
			splitsForTime({ granularity: 'month' })(fakeSelf(), 0, scaleMin, scaleMax, 0, 0)
		).toEqual([unixSec('2026-01-01T00:00:00Z')]);
	});

	it('warns once and falls back to the default for an unrecognized granularity', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// only reachable from JS or a cast config string; silently picking a rung would be a
			// guess, and the guess used to be the finest one — the opposite of what a caller
			// asking for a coarse granularity wanted
			const splits = splitsForTime({ granularity: 'Month' as SplitsForTimeGranularity });
			const scaleMin = unixSec('2026-01-01T00:00:00Z');
			const scaleMax = unixSec('2026-01-06T00:00:00Z');

			expect(splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0)).toEqual(
				splitsForTime({ granularity: 'day' })(fakeSelf(), 0, scaleMin, scaleMax, 0, 0)
			);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.[0]).toContain('granularity must be one of');
			expect(warn.mock.calls[0]?.[0]).toContain('"Month"');

			// diagnosed at factory time, so redraws stay quiet
			splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});

	it('warns and falls back to Sunday for a weekStartsOn that is not a whole day', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const scaleMin = unixSec('2026-01-01T00:00:00Z');
			const scaleMax = unixSec('2026-01-31T00:00:00Z');
			const sundays = splitsForTime({ granularity: 'week' })(
				fakeSelf(),
				0,
				scaleMin,
				scaleMax,
				0,
				0
			);

			// 1.5 is the dangerous one: it used to shift every tick half a day and produce a
			// plausible-looking axis of Monday-at-noon "week starts"
			for (const weekStartsOn of [1.5, 7, -1, NaN]) {
				expect(
					splitsForTime({ granularity: 'week', weekStartsOn: weekStartsOn as 0 })(
						fakeSelf(),
						0,
						scaleMin,
						scaleMax,
						0,
						0
					)
				).toEqual(sundays);
			}
			expect(warn).toHaveBeenCalledTimes(4);
			expect(warn.mock.calls[0]?.[0]).toContain('weekStartsOn must be a whole number');
		} finally {
			warn.mockRestore();
		}
	});

	it('warns once and falls back to seconds for a degenerate ms', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const scaleMin = unixSec('2026-01-01T00:00:00Z');
			const scaleMax = unixSec('2026-01-06T00:00:00Z');
			const seconds = splitsForTime({ granularity: 'day' })(
				fakeSelf(),
				0,
				scaleMin,
				scaleMax,
				0,
				0
			);

			// every bound is divided by 1000 * ms, so a zero or non-finite unit turns the range
			// into NaN and pushes the ladder lookup past its last rung
			for (const ms of [0, -1, NaN, Infinity]) {
				expect(
					splitsForTime({ granularity: 'day', ms: ms as 1e-3 })(
						fakeSelf(),
						0,
						scaleMin,
						scaleMax,
						0,
						0
					)
				).toEqual(seconds);
			}
			expect(warn).toHaveBeenCalledTimes(4); // one per factory, not per redraw
			expect(warn.mock.calls[0]?.[0]).toContain('ms must be finite and positive');
		} finally {
			warn.mockRestore();
		}
	});

	it('warns once and falls back to a zero offset for a non-finite offsetSec', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const scaleMin = unixSec('2026-01-01T00:00:00Z');
			const scaleMax = unixSec('2026-01-06T00:00:00Z');
			const zeroOffset = splitsForTime({ granularity: 'day' })(
				fakeSelf(),
				0,
				scaleMin,
				scaleMax,
				0,
				0
			);

			// a non-finite offset is added into every getInitialValue, so left unchecked it makes
			// the first candidate NaN, the walk stops on its finiteness guard, and the axis blanks
			// silently — the failure the other option guards exist to prevent
			for (const offsetSec of [NaN, Infinity, -Infinity]) {
				expect(
					splitsForTime({ granularity: 'day', offsetSec })(fakeSelf(), 0, scaleMin, scaleMax, 0, 0)
				).toEqual(zeroOffset);
			}
			expect(warn).toHaveBeenCalledTimes(3); // one per factory, not per redraw
			expect(warn.mock.calls[0]?.[0]).toContain('offsetSec must be a finite number of seconds');
		} finally {
			warn.mockRestore();
		}
	});

	it('places coarse boundaries at midnight when the range starts mid-day', () => {
		// the month/quarter/year rungs build their boundary from a shared scratch Date, so a
		// range whose start carries a time of day is the case that catches it being reused
		// without a reset — the boundary would inherit 00:00:37 from the range instead of
		// starting the month. Every other test here starts exactly on midnight and cannot see it.
		const odd = unixSec('2026-01-01T00:00:37Z');

		for (const granularity of ['month', 'quarter', 'year'] as const) {
			const result = splitsForTime({ granularity })(fakeSelf(), 0, odd, odd + 400 * 86400, 0, 0);

			expect(result.length).toBeGreaterThan(0);
			for (const value of result) {
				expect(value % 86400).toBe(0);
			}
		}
	});

	it('ticks quarter starts, not arbitrary three-month offsets', () => {
		const splits = splitsForTime({ granularity: 'quarter' });
		// starts mid-quarter, so a rung that stepped from scaleMin instead of the year start
		// would tick Feb/May/Aug/Nov
		const scaleMin = unixSec('2026-02-14T00:00:00Z');
		const scaleMax = unixSec('2027-03-01T00:00:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		expect(result).toEqual([
			unixSec('2026-04-01T00:00:00Z'),
			unixSec('2026-07-01T00:00:00Z'),
			unixSec('2026-10-01T00:00:00Z'),
			unixSec('2027-01-01T00:00:00Z')
		]);
	});

	it('ticks month starts on a BCE (negative-timestamp) axis', () => {
		// everyNMonths.getInitialValue decomposes a whole month-index back into (year, month). A
		// BCE timestamp makes that index negative, where `aligned % 12` would go negative and
		// double-count the year — the self-correcting walk hides it in the emitted output, so this
		// pins the correct months as a guard for any future rung whose phase the walk would not fix.
		const splits = splitsForTime({ granularity: 'month' });
		const scaleMin = unixSec('-000100-02-15T00:00:00Z');
		const scaleMax = unixSec('-000100-06-05T00:00:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		expect(result).toEqual([
			unixSec('-000100-03-01T00:00:00Z'),
			unixSec('-000100-04-01T00:00:00Z'),
			unixSec('-000100-05-01T00:00:00Z'),
			unixSec('-000100-06-01T00:00:00Z')
		]);
	});

	it('widens gradually across a crossover instead of collapsing to one tick', () => {
		const splits = splitsForTime({ granularity: 'day' });
		const start = unixSec('2026-01-05T00:00:00Z');
		const DAY = 86400;

		// the bare day -> week ladder used to drop from 11 ticks to 1 the moment the range
		// crossed ten days; the intermediate rungs keep every crossover gradual
		const at = (days: number) => splits(fakeSelf(), 0, start, start + days * DAY, 0, 0).length;
		for (const days of [8, 11, 15, 20, 30, 45, 70, 120, 250, 400]) {
			expect(at(days)).toBeGreaterThanOrEqual(4);
			expect(at(days)).toBeLessThanOrEqual(14);
		}
	});

	it('ticks round intermediate steps, phased to a fixed origin so a pan does not shift them', () => {
		const splits = splitsForTime({ granularity: 'day' });

		// a ~12-day range lands on the every-2-days rung, counted from the epoch, so it ticks odd
		// days of a month with 31 days regardless of where the window opens
		const twoDay = splits(
			fakeSelf(),
			0,
			unixSec('2026-01-01T00:00:00Z'),
			unixSec('2026-01-13T00:00:00Z'),
			0,
			0
		);
		expect(twoDay.map((v) => new Date(v * 1000).getUTCDate())).toEqual([1, 3, 5, 7, 9, 11, 13]);

		// the same rung on a window shifted by one day still ticks the same calendar days — the
		// ticks are phased to the epoch, not to scaleMin, so panning does not slide them
		const shifted = splits(
			fakeSelf(),
			0,
			unixSec('2026-01-02T00:00:00Z'),
			unixSec('2026-01-14T00:00:00Z'),
			0,
			0
		);
		expect(shifted.map((v) => new Date(v * 1000).getUTCDate())).toEqual([3, 5, 7, 9, 11, 13]);
	});

	it('phases the 2-week rung to a fixed origin so a one-week pan does not slide it', () => {
		const splits = splitsForTime({ granularity: 'week' });
		const DAY = 86400;
		// 70 days lands on the every-2-weeks rung (55 < days <= 110); the parity of which weeks
		// tick must come from a fixed origin, not from whichever week scaleMin happens to fall in
		const span = 70 * DAY;
		const aStart = unixSec('2026-01-04T00:00:00Z'); // a Sunday
		const bStart = unixSec('2026-01-11T00:00:00Z'); // panned exactly one week

		const a = splits(fakeSelf(), 0, aStart, aStart + span, 0, 0);
		const b = splits(fakeSelf(), 0, bStart, bStart + span, 0, 0);

		// both windows must agree on every tick in their overlap — the defining property of a
		// fixed-origin grid. Before the fix the 2-week parity was tied to scaleMin's own week, so
		// the two windows interleaved (Jan 4/18/Feb 1 … vs Jan 11/25/Feb 8 …) instead of coinciding
		const overlap = (ticks: number[]) => ticks.filter((v) => v >= bStart && v <= aStart + span);
		expect(overlap(a).length).toBeGreaterThan(0);
		expect(overlap(b)).toEqual(overlap(a));

		// every tick is a Sunday, exactly two weeks apart (reduce, not indexing, to stay within
		// noUncheckedIndexedAccess — and a is non-empty since its overlap is)
		expect(a.every((v) => new Date(v * 1000).getUTCDay() === 0)).toBe(true);
		a.reduce((previous, current) => {
			expect(current - previous).toBe(14 * DAY);
			return current;
		});
	});

	it('keeps widening past a few years into decades and centuries', () => {
		const splits = splitsForTime({ granularity: 'year' });

		// the old ladder capped at a one-year step, so two centuries meant ~200 labels; now it
		// widens to decades and beyond, staying readable
		const twoCenturies = splits(
			fakeSelf(),
			0,
			unixSec('1900-01-01T00:00:00Z'),
			unixSec('2000-01-01T00:00:00Z'),
			0,
			0
		);
		expect(twoCenturies.map((v) => new Date(v * 1000).getUTCFullYear())).toEqual([
			1900, 1910, 1920, 1930, 1940, 1950, 1960, 1970, 1980, 1990, 2000
		]);
		expect(twoCenturies.every((v) => new Date(v * 1000).getUTCFullYear() % 10 === 0)).toBe(true);
	});

	it('starts weeks on the configured day when weekStartsOn is set', () => {
		const splits = splitsForTime({ granularity: 'week', weekStartsOn: 1 }); // ISO Monday
		const scaleMin = unixSec('2026-01-01T00:00:00Z');
		const scaleMax = unixSec('2026-01-31T00:00:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		expect(result.length).toBeGreaterThan(0);
		for (const value of result) {
			expect(new Date(value * 1000).getUTCDay()).toBe(1);
		}
	});

	it('widens to month-aligned ticks once the range grows past the day/week limits', () => {
		const splits = splitsForTime({ granularity: 'day' });
		const scaleMin = unixSec('2026-01-01T00:00:00Z');
		const scaleMax = unixSec('2026-06-01T00:00:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		for (const value of result) {
			const d = new Date(value * 1000);
			expect(d.getUTCDate()).toBe(1);
			expect(d.getUTCHours()).toBe(0);
		}
	});

	it('widens to year-aligned ticks for multi-year ranges', () => {
		const splits = splitsForTime({ granularity: 'year' });
		const scaleMin = unixSec('2020-01-01T00:00:00Z');
		const scaleMax = unixSec('2030-01-01T00:00:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		for (const value of result) {
			const d = new Date(value * 1000);
			expect(d.getUTCMonth()).toBe(0);
			expect(d.getUTCDate()).toBe(1);
		}
	});

	it('emits every month boundary, including short months, regardless of the foundIncr uPlot passes', () => {
		const splits = splitsForTime({ granularity: 'month' });
		// six months keeps the monthly rung (the two-month rung takes over past ~200 days), so
		// every boundary shows — the point is that the 28-day Feb->Mar step is never thinned away
		const scaleMin = unixSec('2026-01-01T00:00:00Z');
		const scaleMax = unixSec('2026-06-01T00:00:00Z');

		// uPlot's ladder can hand a ~30-day foundIncr for a monthly range; the tick set must
		// not depend on it
		const withoutIncr = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);
		const withMonthIncr = splits(fakeSelf(), 0, scaleMin, scaleMax, 30 * 86400, 60);

		expect(withoutIncr).toEqual(withMonthIncr);
		const months = withoutIncr.map((value) => new Date(value * 1000).getUTCMonth());
		expect(months).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it('returns ticks that are all within [scaleMin, scaleMax]', () => {
		const splits = splitsForTime({ granularity: 'day' });
		const scaleMin = unixSec('2026-03-01T00:00:00Z');
		const scaleMax = unixSec('2026-03-10T00:00:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		// guard first: a per-element loop over an empty array is vacuously green, so this would
		// pass even if the generator regressed to returning nothing. A 9-day range is past the
		// daily rung's 8-day limit, so it ticks the 2-day rung (Mar 2/4/6/8/10 = 5)
		expect(result.length).toBe(5);
		for (const value of result) {
			expect(value).toBeGreaterThanOrEqual(scaleMin);
			expect(value).toBeLessThanOrEqual(scaleMax);
		}
	});

	it('produces a strictly ascending, duplicate-free tick list', () => {
		const splits = splitsForTime({ granularity: 'day' });
		const scaleMin = unixSec('2026-01-01T00:00:00Z');
		const scaleMax = unixSec('2027-06-01T00:00:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		// asserted before the walk: reduce without a seed never invokes its callback on a
		// one-element array and throws on an empty one, so the ordering check below is only
		// meaningful once there is a run of ticks to check
		expect(result.length).toBeGreaterThan(2);
		result.reduce((previous, current) => {
			expect(current).toBeGreaterThan(previous);
			return current;
		});
	});

	it('emits no ticks when no calendar boundary falls inside the range', () => {
		const splits = splitsForTime({ granularity: 'day' });
		const scaleMin = unixSec('2026-01-05T06:00:00Z');
		const scaleMax = unixSec('2026-01-05T18:00:00Z');

		// an intraday zoom contains no midnight, and the generator never invents one —
		// splitsWithEdges is what turns that into range-edge ticks (covered in its suite)
		expect(splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0)).toEqual([]);
	});

	it('returns pure boundary ticks (no injected non-boundary range edges)', () => {
		const splits = splitsForTime({ granularity: 'day' });
		const scaleMin = unixSec('2026-01-01T06:00:00Z'); // not a midnight
		const scaleMax = unixSec('2026-01-05T18:00:00Z'); // not a midnight

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 86400, 60);

		// guard first: without it the two not.toContain / the loop are all vacuously green on an
		// empty result (four midnights, Jan 2..5, fall inside)
		expect(result.length).toBe(4);
		// the raw edges must NOT appear as ticks; only clean midnights do
		expect(result).not.toContain(scaleMin);
		expect(result).not.toContain(scaleMax);
		for (const value of result) {
			expect(value % 86400).toBe(0);
		}
	});

	it('returns a single tick for a zero-width range and nothing degenerate for bad bounds', () => {
		const splits = splitsForTime({ granularity: 'day' });
		const onBoundary = unixSec('2026-01-05T00:00:00Z');

		// uPlot's snapTimeX passes dataMin === dataMax through unpadded (single-point data)
		expect(splits(fakeSelf(), 0, onBoundary, onBoundary, 0, 0)).toEqual([onBoundary]);
		// non-finite and inverted bounds never produce NaN, Infinity, or descending ticks
		expect(splits(fakeSelf(), 0, NaN, onBoundary, 0, 0)).toEqual([]);
		expect(splits(fakeSelf(), 0, 0, Infinity, 0, 0)).toEqual([]);
		expect(splits(fakeSelf(), 0, onBoundary + 3600, onBoundary, 0, 0)).toEqual([]);
	});

	it('emits nothing for a zero-width range that is not itself a calendar boundary', () => {
		const splits = splitsForTime({ granularity: 'day' });
		const offBoundary = unixSec('2026-01-05T13:37:00Z');

		// single-point data at an arbitrary timestamp: the zero-width case is not a licence to
		// invent a tick the generator would refuse at any other width
		expect(splits(fakeSelf(), 0, offBoundary, offBoundary, 0, 0)).toEqual([]);
	});

	it('ticks year boundaries correctly in years 0-99 (no Date.UTC two-digit-year remap)', () => {
		const from = new Date(0);
		from.setUTCFullYear(50, 0, 1);
		const to = new Date(0);
		to.setUTCFullYear(60, 0, 1);
		const splits = splitsForTime({ granularity: 'year' });

		const result = splits(fakeSelf(), 0, from.getTime() / 1000, to.getTime() / 1000, 0, 0);

		// eleven year starts, 50 AD through 60 AD inclusive — not an empty axis
		expect(result.length).toBe(11);
		expect(result[0]).toBe(from.getTime() / 1000);
		expect(result.at(-1)).toBe(to.getTime() / 1000);
	});

	it('terminates on an absurd range instead of hanging, and never emits NaN', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// e.g. millisecond/nanosecond epoch values mistakenly fed to a seconds axis: 1e15
			// seconds is ~31 million years. The coarsest rung steps a century at a time, so the
			// walk runs out of representable Date values (getUTCFullYear goes NaN past ±271821)
			// long before the candidate cap, and stops there — a bounded walk either way.
			const result = splits('year', 0, 1e15);

			// far short of the millions of ticks the range nominally spans, and clean
			expect(result.length).toBeLessThan(10_000);
			expect(result.length).toBeGreaterThan(0);
			for (const value of result) {
				expect(Number.isFinite(value)).toBe(true);
			}
			expect(result).toEqual([...result].sort((a, b) => a - b));
		} finally {
			warn.mockRestore();
		}

		function splits(granularity: SplitsForTimeGranularity, min: number, max: number): number[] {
			return splitsForTime({ granularity })(fakeSelf(), 0, min, max, 0, 0);
		}
	});

	it('is stable across a DST-observing local boundary (offset math is pure UTC, no host-tz dependence)', () => {
		// 2026-03-08 is a US DST transition day; a plain browser-local Date-based
		// implementation would produce a 23h "day" here. Since splitsForTime works
		// entirely in UTC + a fixed offsetSec, every day tick is exactly 86400s apart
		// regardless of the host's own timezone rules.
		const splits = splitsForTime({ granularity: 'day' });
		const scaleMin = unixSec('2026-03-06T00:00:00Z');
		const scaleMax = unixSec('2026-03-10T00:00:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		// pinned exactly: a ladder regression that widened this range to one weekly tick would
		// leave the spacing assertion below running zero times
		expect(result.length).toBe(5);
		result.reduce((previous, current) => {
			expect(current - previous).toBe(86400);
			return current;
		});
	});

	it('defaults to day granularity, seconds, and zero offset', () => {
		const withDefaults = splitsForTime();
		const explicit = splitsForTime({
			granularity: 'day',
			ms: 1e-3,
			offsetSec: 0,
			weekStartsOn: 0
		});
		const scaleMin = unixSec('2026-01-01T00:00:00Z');
		const scaleMax = unixSec('2026-01-05T00:00:00Z');

		expect(withDefaults(fakeSelf(), 0, scaleMin, scaleMax, 0, 0)).toEqual(
			explicit(fakeSelf(), 0, scaleMin, scaleMax, 0, 0)
		);
	});

	it('ticks midnight boundaries on a millisecond axis when ms is 1', () => {
		const splits = splitsForTime({ granularity: 'day', ms: 1 });
		const scaleMin = Date.parse('2026-01-01T06:00:00Z');
		const scaleMax = Date.parse('2026-01-05T18:00:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		// left at the seconds default these bounds read as ~50,000 years from the epoch and
		// the ladder widens all the way to yearly ticks; ms: 1 keeps them four days apart
		expect(result).toEqual([
			Date.parse('2026-01-02T00:00:00Z'),
			Date.parse('2026-01-03T00:00:00Z'),
			Date.parse('2026-01-04T00:00:00Z'),
			Date.parse('2026-01-05T00:00:00Z')
		]);
	});

	it('picks the same instants on a millisecond axis as on a seconds one', () => {
		const iso = ['2025-11-20T13:37:00Z', '2027-02-04T09:15:00Z'] as const;

		for (const granularity of ['day', 'week', 'month', 'quarter', 'year'] as const) {
			const inSeconds = splitsForTime({ granularity });
			const inMillis = splitsForTime({ granularity, ms: 1 });

			const seconds = inSeconds(fakeSelf(), 0, unixSec(iso[0]), unixSec(iso[1]), 0, 0);
			const millis = inMillis(fakeSelf(), 0, Date.parse(iso[0]), Date.parse(iso[1]), 0, 0);

			// the unit changes the numbers, never which moments in time get a tick
			expect(millis.length).toBeGreaterThan(0);
			expect(millis).toEqual(seconds.map((value) => value * 1000));
		}
	});

	it('keeps offsetSec in seconds on a millisecond axis', () => {
		const offsetSec = 3 * 3600; // UTC+3
		const splits = splitsForTime({ granularity: 'day', ms: 1, offsetSec });
		const scaleMin = Date.parse('2026-01-01T00:30:00Z');
		const scaleMax = Date.parse('2026-01-04T00:30:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		// offsetSec stays in seconds while the axis values are milliseconds
		expect(result.length).toBe(3);
		for (const value of result) {
			expect((value + offsetSec * 1000) % 86_400_000).toBe(0);
		}
	});

	it('never emits negative zero on an even-day rung phased across the epoch', () => {
		// the every-2-day rung starts at Math.ceil(-1/2) === -0 for the day before 1970-01-01
		const result = splitsForTime({ granularity: 'day' })(fakeSelf(), 0, -1, 10 * 86400, 0, 0);

		expect(result[0]).toBe(0);
		expect(result.some((value) => Object.is(value, -0))).toBe(false);
	});

	it('warns instead of silently blanking on a unit-mismatched (e.g. nanosecond) axis', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// nanosecond-scale timestamps read against the seconds default sit ~1e21 ms from the
			// epoch, past Date's range: the calendar math NaNs and the walk stops at zero iterations
			const result = splitsForTime({ granularity: 'day' })(
				fakeSelf(),
				0,
				1.77e18,
				1.77e18 + 1e9,
				0,
				0
			);

			expect(result).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.[0]).toContain('ms');
		} finally {
			warn.mockRestore();
		}
	});

	it('stays silent on a legitimately empty window (intraday zoom, not a unit mismatch)', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const start = Date.UTC(2026, 0, 5, 6, 0) / 1000; // 06:00 — no midnight in a 3h zoom
			const result = splitsForTime({ granularity: 'day' })(
				fakeSelf(),
				0,
				start,
				start + 3 * 3600,
				0,
				0
			);

			expect(result).toEqual([]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('caps the day/week calendar walk instead of hanging on a pathological offsetSec', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// everyNDays is pure number addition (never touches Date, so no NaN-overflow bound):
			// a huge finite offsetSec decouples the walk start from maxSec via catastrophic
			// cancellation in `scaleMin + offsetSec`, and only MAX_TICK_CANDIDATES bounds it.
			const splits = splitsForTime({ granularity: 'day', offsetSec: 1e28 });

			const result = splits(fakeSelf(), 0, 1e12, 1e12 + 30 * 86400, 0, 0);

			expect(result.length).toBeLessThanOrEqual(10_000);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.[0]).toContain('tick candidates');
		} finally {
			warn.mockRestore();
		}
	});
});

describe('splitsForLog', () => {
	it('ticks decade boundaries for base 10 by default', () => {
		const splits = splitsForLog();

		const result = splits(fakeSelf(), 0, 1, 10_000, 0, 0);

		expect(result).toEqual([1, 10, 100, 1000, 10_000]);
	});

	it('includes minor ticks within each decade when minor is true', () => {
		const splits = splitsForLog({ minor: true });

		const result = splits(fakeSelf(), 0, 1, 10, 0, 0);

		expect(result).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it('supports binary (base 2) decades with no minor ticks by default', () => {
		const splits = splitsForLog({ base: 2 });

		const result = splits(fakeSelf(), 0, 1, 16, 0, 0);

		expect(result).toEqual([1, 2, 4, 8, 16]);
	});

	it('returns no ticks for a range at or below zero', () => {
		const splits = splitsForLog();

		expect(splits(fakeSelf(), 0, 0, 10, 0, 0)).toEqual([]);
		expect(splits(fakeSelf(), 0, -5, 5, 0, 0)).toEqual([]);
	});

	it('returns a single tick for equal positive bounds', () => {
		const splits = splitsForLog();

		expect(splits(fakeSelf(), 0, 100, 100, 0, 0)).toEqual([100]);
	});

	it('emits nothing for a zero-width range that is not a power of the base', () => {
		// the zero-width shortcut must not hand back an off-decade value like 55 on an axis
		// documented as ticking one point per decade
		expect(splitsForLog()(fakeSelf(), 0, 55, 55, 0, 0)).toEqual([]);
		expect(splitsForLog({ base: 2 })(fakeSelf(), 0, 12, 12, 0, 0)).toEqual([]);
		// a zero-width range that *is* a power still ticks
		expect(splitsForLog({ base: 2 })(fakeSelf(), 0, 16, 16, 0, 0)).toEqual([16]);
	});

	it('places sub-1 decades exactly on the major-only path too', () => {
		// regression guard for the decade-precision handling being scoped to the minor branch
		const splits = splitsForLog();

		expect(splits(fakeSelf(), 0, 0.001, 0.1, 0, 0)).toEqual([0.001, 0.01, 0.1]);
	});

	it('returns nothing degenerate for non-finite or inverted bounds', () => {
		const splits = splitsForLog();

		expect(splits(fakeSelf(), 0, NaN, 10, 0, 0)).toEqual([]);
		expect(splits(fakeSelf(), 0, 10, 1, 0, 0)).toEqual([]);
	});

	it('produces a strictly ascending, duplicate-free tick list', () => {
		const splits = splitsForLog({ minor: true });

		const result = splits(fakeSelf(), 0, 1, 1000, 0, 0);

		expect(result.length).toBeGreaterThan(2);
		result.reduce((previous, current) => {
			expect(current).toBeGreaterThan(previous);
			return current;
		});
	});

	it('places fractional minor mantissas exactly, not on the decade grid', () => {
		// base 2 has no integer mantissa to offer — none exists between 1 and 2 — so a
		// fractional one is the only way to get a minor tick at all
		expect(
			splitsForLog({ base: 2, minor: true, minorMantissas: [1.5] })(fakeSelf(), 0, 0.25, 1, 0, 0)
		).toEqual([0.25, 0.375, 0.5, 0.75, 1]);

		// rounding to the decade's own precision would snap 0.0015 onto 0.002, where it
		// collides with the real 2-mantissa tick and is deduped away entirely
		expect(
			splitsForLog({ minor: true, minorMantissas: [1.5, 2] })(fakeSelf(), 0, 0.001, 0.01, 0, 0)
		).toEqual([0.001, 0.0015, 0.002, 0.01]);
	});

	it('emits exact minor ticks inside sub-1 decades', () => {
		const splits = splitsForLog({ minor: true });

		const result = splits(fakeSelf(), 0, 0.001, 0.01, 0, 0);

		// 9 * 0.001 is 0.009000000000000001 unrounded, which a default value formatter shows
		expect(result).toEqual([0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.01]);
	});

	it('places minor ticks exactly at magnitudes where decimal places cannot help', () => {
		// past 1e15 a double has no decimals left to round to, and below 1e-15 it has more than
		// it can carry — both bands defeat decimal rounding, and the error lands in the last
		// significant digit either way
		const splits = splitsForLog({ minor: true });

		expect(splits(fakeSelf(), 0, 1e23, 1e24, 0, 0)).toEqual([
			1e23, 2e23, 3e23, 4e23, 5e23, 6e23, 7e23, 8e23, 9e23, 1e24
		]);
		expect(splits(fakeSelf(), 0, 1e-16, 1e-15, 0, 0)).toEqual([
			1e-16, 2e-16, 3e-16, 4e-16, 5e-16, 6e-16, 7e-16, 8e-16, 9e-16, 1e-15
		]);
	});

	it('warns and falls back to base 10 for a base the decade walk cannot use', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// base 1 divides by log(1) === 0; base 0 and Infinity collapse `base ** power` onto a
			// single bogus tick at 1 — all three used to return that or [] with no explanation
			const decades = [1, 10, 100, 1000];
			for (const base of [1, 0, -10, Infinity, NaN]) {
				expect(splitsForLog({ base: base as 10 })(fakeSelf(), 0, 1, 1000, 0, 0)).toEqual(decades);
			}
			expect(warn).toHaveBeenCalledTimes(5); // one per factory
			expect(warn.mock.calls[0]?.[0]).toContain('base must be a finite number greater than 1');

			// a base the type forbids but the sweep handles is left alone — it is a correct
			// base-3 grid, not nonsense
			warn.mockClear();
			expect(splitsForLog({ base: 3 as 10 })(fakeSelf(), 0, 1, 100, 0, 0)).toEqual([
				1, 3, 9, 27, 81
			]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('applies the base-10 minor default after an invalid base falls back to 10', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// the minor default keys off the validated base, not the raw one: base 1 falls back to
			// 10, so an omitted minorMantissas must still get the 1-2-…-9 grid a base-10 axis wants,
			// not the empty [] that reading rawBase (!== 10) would have produced
			expect(splitsForLog({ base: 1 as 10, minor: true })(fakeSelf(), 0, 1, 10, 0, 0)).toEqual([
				1, 2, 3, 4, 5, 6, 7, 8, 9, 10
			]);
		} finally {
			warn.mockRestore();
		}
	});

	it('refuses cleanly for a base so close to 1 the range spans too many decades', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// base 1.0001 passes the > 1 guard but makes [1, 10] span ~23000 decades; the sweep must
			// refuse outright with a clear message, not walk to the candidate cap and hand back a
			// dense low-end prefix that still looks like a real axis
			expect(splitsForLog({ base: 1.0001 as 10 })(fakeSelf(), 0, 1, 10, 0, 0)).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.[0]).toContain('spans 23029 decades at base 1.0001');
		} finally {
			warn.mockRestore();
		}
	});

	it('counts candidates, not decades, so minor mantissas cannot overflow the cap', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// The loop pushes the decade plus one value per minor mantissa, so a decade count well
			// inside the cap still overflowed it by the mantissa factor -- and then truncated at the
			// collector instead, returning the low-end prefix this guard exists to refuse. Measured
			// before the fix: 10000 ticks whose largest was 20938 on a range reaching 1e6, i.e. the
			// bottom 2% of the axis ticked and the rest bare, reported as a degenerate range.
			const minorMantissas = [1.001, 1.002, 1.003, 1.004, 1.005, 1.006, 1.007, 1.008, 1.009];
			const dense = splitsForLog({ base: 1.01 as 10, minor: true, minorMantissas });
			expect(dense(fakeSelf(), 0, 1, 1e6, 0, 0)).toEqual([]);
			expect(warn.mock.calls[0]?.[0]).toContain('9 minor mantissas');
			expect(warn.mock.calls[0]?.[0]).toContain('fewer minorMantissas');
		} finally {
			warn.mockRestore();
		}
	});

	it('still admits the default mantissa count across the whole double range', () => {
		// The guard multiplies by (1 + mantissas.length), so it must not start refusing ordinary
		// base-10 log axes: 601 decades x 9 candidates is comfortably inside the cap.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(
				splitsForLog({ minor: true })(fakeSelf(), 0, 1e-300, 1e300, 0, 0).length
			).toBeGreaterThan(5000);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('does not let a caller mutate minorMantissas after the fact', () => {
		const mantissas = [5];
		const splits = splitsForLog({ minor: true, minorMantissas: mantissas });

		expect(splits(fakeSelf(), 0, 1, 10, 0, 0)).toEqual([1, 5, 10]);

		mantissas.push(2, 3);
		mantissas[0] = 9;

		expect(splits(fakeSelf(), 0, 1, 10, 0, 0)).toEqual([1, 5, 10]);
	});

	it('caps the decade walk on an absurd range instead of allocating unbounded', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// the whole double range is ~634 decades, so 21 mantissas apiece is what it takes
			// to push a log axis past the candidate cap at all
			const mantissas = Array.from({ length: 21 }, (_, i) => i + 2);
			const splits = splitsForLog({ minor: true, minorMantissas: mantissas });

			const result = splits(fakeSelf(), 0, Number.MIN_VALUE, Number.MAX_VALUE, 0, 0);

			expect(result.length).toBeLessThan(634 * mantissas.length);
			for (const value of result) {
				expect(Number.isFinite(value)).toBe(true);
			}
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});

	it('emits no infinite tick when scaleMax overflows the next decade', () => {
		// lastPower ceils to 309 and 10 ** 309 is Infinity; the clamp cannot catch it on its own,
		// since isSameTick(Infinity, scaleMax) degenerates to Infinity <= Infinity
		const major = splitsForLog()(fakeSelf(), 0, 1, Number.MAX_VALUE, 0, 0);

		expect(major.every(Number.isFinite)).toBe(true);
		expect(major.at(-1)).toBe(1e308);

		// the top decade is finite, but its mantissas are not: 9 * 1e308 overflows too
		const minor = splitsForLog({ minor: true })(fakeSelf(), 0, 1, Number.MAX_VALUE, 0, 0);

		expect(minor.every(Number.isFinite)).toBe(true);
		expect(minor.at(-1)).toBe(1e308);
	});

	it('keeps the decade at scaleMax when it sits a ulp below a power of base', () => {
		// lastPower ceils to 3 and computes 1000; the clamp must not reject it for being an ulp
		// above a scaleMax that Math.log rounded a hair under
		const result = splitsForLog()(fakeSelf(), 0, 1, 999.9999999999999, 0, 0);

		expect(result).toEqual([1, 10, 100, 1000]);
	});
});

describe('splitsForStep', () => {
	it('ticks on multiples of step from the default zero anchor', () => {
		const splits = splitsForStep({ step: 900 });

		const result = splits(fakeSelf(), 0, 0, 3600, 0, 0);

		expect(result).toEqual([0, 900, 1800, 2700, 3600]);
	});

	it('phases ticks against a nonzero anchor', () => {
		const anchor = 300;
		const splits = splitsForStep({ step: 900, anchor });

		const result = splits(fakeSelf(), 0, 0, 3600, 0, 0);

		expect(result.length).toBeGreaterThan(0);
		for (const value of result) {
			expect((value - anchor) % 900).toBe(0);
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThanOrEqual(3600);
		}
	});

	it('says so once and ticks nothing for an unusable step', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// `step` is the one option with no default to fall back to, so this is the only
			// generator whose bad-option answer is a blank axis — which is exactly why it has to
			// say why, once, instead of leaving a silent empty axis to be tracked down
			for (const step of [0, -10, NaN, Infinity]) {
				expect(splitsForStep({ step })(fakeSelf(), 0, 0, 100, 0, 0)).toEqual([]);
			}
			expect(warn).toHaveBeenCalledTimes(4); // one per factory
			expect(warn.mock.calls[0]?.[0]).toContain('step must be a finite number greater than zero');
		} finally {
			warn.mockRestore();
		}
	});

	it('returns a single tick for equal bounds and nothing degenerate for bad bounds', () => {
		const splits = splitsForStep({ step: 10 });

		expect(splits(fakeSelf(), 0, 50, 50, 0, 0)).toEqual([50]);
		expect(splits(fakeSelf(), 0, NaN, 100, 0, 0)).toEqual([]);
		expect(splits(fakeSelf(), 0, 100, 0, 0, 0)).toEqual([]);
	});

	it('emits nothing for a zero-width range that is off the grid', () => {
		const splits = splitsForStep({ step: 10 });

		// 55 is not a multiple of 10; a zero-width range is no reason to emit it as if it were
		expect(splits(fakeSelf(), 0, 55, 55, 0, 0)).toEqual([]);
		// and the anchor phases that judgement, same as at any other width
		expect(splitsForStep({ step: 10, anchor: 5 })(fakeSelf(), 0, 55, 55, 0, 0)).toEqual([55]);
	});

	it('refuses a grid too fine to resolve at the range magnitude, from any anchor', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// a nanosecond step on a Unix-seconds range: doubles there are ~2.4e-7 apart, so the
			// "grid" would collapse onto a handful of positions. Whether that is detected must
			// depend on the magnitude the ticks sit at, not on how far the anchor happens to be
			// from the window — anchoring inside the window used to make the same grid pass
			// silently and come back with 5 ticks spaced 240x the requested step
			for (const anchor of [0, 1.7e9, 1.7e9 + 5e-7, -1e6]) {
				expect(
					splitsForStep({ step: 1e-9, anchor })(fakeSelf(), 0, 1.7e9, 1.7e9 + 1, 0, 0)
				).toEqual([]);
			}
			expect(warn).toHaveBeenCalled();

			// a microsecond step on a nanosecond epoch is the same failure one unit up: it used
			// to return 21 ticks with gaps alternating 768 and 1024
			expect(splitsForStep({ step: 1000 })(fakeSelf(), 0, 1.7e18, 1.7e18 + 20_000, 0, 0)).toEqual(
				[]
			);

			// but a millisecond step at that same magnitude resolves fine and is left alone
			expect(splitsForStep({ step: 1e6 })(fakeSelf(), 0, 1.7e18, 1.7e18 + 2e7, 0, 0).length).toBe(
				21
			);
		} finally {
			warn.mockRestore();
		}
	});

	it('ticks the grid points sitting exactly on scaleMin and scaleMax', () => {
		// both bounds are real grid positions, and each is lost by a different rounding
		// direction: 0.07 / 0.01 is 7.000000000000001 so the quotient ceils past the first
		// tick, while the top point of a 0.15 grid is raw 0.44999999999999996 and only becomes
		// 0.45 — the value a caller would write down — after rounding
		expect(splitsForStep({ step: 0.01 })(fakeSelf(), 0, 0.07, 0.11, 0, 0)).toEqual([
			0.07, 0.08, 0.09, 0.1, 0.11
		]);
		expect(splitsForStep({ step: 0.15 })(fakeSelf(), 0, 0, 3 * 0.15, 0, 0)).toEqual([
			0, 0.15, 0.3, 0.45
		]);
		// the same at the lower bound with the opposite rounding direction: the grid point at
		// -0.4 is raw -0.40000000000000013, a hair below the bound, and rounds up onto it
		expect(splitsForStep({ step: 0.2, anchor: 1 })(fakeSelf(), 0, -0.4, 0.4, 0, 0)).toEqual([
			-0.4, -0.2, 0, 0.2, 0.4
		]);
		expect(splitsForStep({ step: 0.3 })(fakeSelf(), 0, 2.1, 3.3, 0, 0)).toEqual([
			2.1, 2.4, 2.7, 3, 3.3
		]);
		expect(splitsForStep({ step: 0.1 })(fakeSelf(), 0, -5.8, -5.3, 0, 0)).toEqual([
			-5.8, -5.7, -5.6, -5.5, -5.4, -5.3
		]);
	});

	it('ticks a grid point whose bound was computed by different arithmetic', () => {
		// the tick and the bound mean the same thing but reached the comparison different ways:
		// the grid's own `27 * 0.089` is 2.403, while a range end built as `7 * st + 20 * st` is
		// 2.4029999999999996 — one ulp lower, and respelling the tick cannot bridge that
		const step = 0.089;
		const scaleMin = 7 * step;
		const scaleMax = scaleMin + 20 * step;

		const result = splitsForStep({ step })(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		expect(result.length).toBe(21);
		expect(result.at(-1)).toBe(27 * step);

		// the same thing at the other end, where the bound lands an ulp *above* the point it
		// means to include: 11 * 0.007 + 20 * 0.007 is 0.21700000000000003, the grid's 31 * 0.007
		// is 0.217
		const fine = 0.007;
		const composed = 11 * fine + 20 * fine;
		const fromBelow = splitsForStep({ step: fine })(
			fakeSelf(),
			0,
			composed,
			composed + 5 * fine,
			0,
			0
		);

		expect(fromBelow.length).toBe(6);
		expect(fromBelow[0]).toBe(31 * fine);

		// and a point genuinely past the end is still refused, ulp tolerance or not
		expect(splitsForStep({ step: 0.1 })(fakeSelf(), 0, 0, 0.95, 0, 0).at(-1)).toBe(0.9);
	});

	it('keeps an edge tick whose bound drifted a few ulps, not just one', () => {
		// a padded scaleMax can reach the comparison more than one ulp off the grid point it means
		// to include. 27 * 0.089 is 2.403; a bound ~2 ulps below (2.402999999999999) dropped that
		// tick under a one-ulp window. The four-ulp window keeps it — still sub-pixel.
		const step = 0.089;
		expect(splitsForStep({ step })(fakeSelf(), 0, 2.4, 2.402999999999999, 0, 0)).toEqual([
			27 * step
		]);

		// but a bound genuinely further out (~5 ulps) is still past the end, so the window is not a
		// blank cheque
		expect(splitsForStep({ step })(fakeSelf(), 0, 2.4, 2.402999999999998, 0, 0)).toEqual([]);
	});

	it('never emits negative zero for a grid phased across the origin', () => {
		// 0.3 + (-3) * 0.1 is -5.55e-17, which rounds to `-0` and formats as "-0" through
		// Intl — the tick the caller means is 0
		const result = splitsForStep({ step: 0.1, anchor: 0.3 })(fakeSelf(), 0, -0.2, 0.2, 0, 0);

		expect(result).toEqual([-0.2, -0.1, 0, 0.1, 0.2]);
		expect(result.some((value) => Object.is(value, -0))).toBe(false);
	});

	it('falls back to a zero anchor on a non-finite anchor, blaming anchor not step', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const splits = splitsForStep({ step: 10, anchor: Infinity });

			// anchor has a default, so a bad one falls back to 0 and the (valid) step-10 grid
			// still ticks — rather than blanking the axis under a "step is too small" warning
			// that names the wrong option.
			expect(splits(fakeSelf(), 0, 0, 100, 0, 0)).toEqual([
				0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
			]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.[0]).toContain('anchor');
		} finally {
			warn.mockRestore();
		}
	});

	it('caps the walk on degenerate ranges instead of hanging or truncating silently', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const splits = splitsForStep({ step: 1e-9 });

			// the range holds 1e9 steps. It is refused outright rather than truncated to the
			// cap's worth: a prefix covers the low end and leaves the rest of the axis bare,
			// which reads as a legitimate result, and no amount of splitsWithLimit on top
			// recovers the part that was never generated
			expect(splits(fakeSelf(), 0, 0, 1, 0, 0)).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.[0]).toContain('Widen `step`, or narrow the scale range.');

			// and the count is arithmetic, so this costs the same whether the range wants
			// ten thousand ticks or a billion
			expect(splits(fakeSelf(), 0, 0, 1e6, 0, 0)).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	it('refuses at the tick ceiling, conservative by one for the isSameTick boundary', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// the count is derived arithmetically rather than by walking, and the walk can emit one
			// index past the arithmetic floor when a point sits an ulp above `upper` yet on it — so
			// the refusal is made conservative by that one: a grid of 9999 ticks still renders, and
			// one of exactly MAX_TICK_CANDIDATES (10000) refuses rather than risk the bypass
			const splits = splitsForStep({ step: 1 });

			expect(splits(fakeSelf(), 0, 0, 9997, 0, 0).length).toBe(9998);
			expect(splits(fakeSelf(), 0, 0, 9998, 0, 0).length).toBe(9999);
			expect(warn).not.toHaveBeenCalled();

			expect(splits(fakeSelf(), 0, 0, 9999, 0, 0)).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});

	it('reports a capped walk even after an unrelated diagnostic already fired', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const splits = splitsForStep({ step: 1e-9 });

			// the two conditions are unrelated — an unplaceable grid is fixed by changing the
			// options, a range too dense for the step by changing the range — so silencing one
			// must not silence the other on the same factory instance. Both refuse, so the
			// return value cannot tell them apart; only the message can
			expect(splits(fakeSelf(), 0, 1.7e9, 1.7e9 + 1, 0, 0)).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.[0]).toContain('too small to place an exact tick grid');

			expect(splits(fakeSelf(), 0, 0, 1, 0, 0)).toEqual([]);
			expect(warn).toHaveBeenCalledTimes(2);
			expect(warn.mock.calls[1]?.[0]).toContain('Widen `step`, or narrow the scale range.');

			// but a repeat of either condition still stays quiet, per redraw
			splits(fakeSelf(), 0, 0, 1, 0, 0);
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			warn.mockRestore();
		}
	});

	it('places fractional-step ticks exactly, with no accumulated drift', () => {
		const splits = splitsForStep({ step: 0.1 });

		const result = splits(fakeSelf(), 0, 0, 1, 0, 0);

		// repeated addition would yield 0.30000000000000004 here and lose the tick at 1.0
		expect(result).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
	});

	it('keeps a fractional anchor exact too', () => {
		const splits = splitsForStep({ step: 0.1, anchor: 0.05 });

		const result = splits(fakeSelf(), 0, 0, 0.5, 0, 0);

		expect(result).toEqual([0.05, 0.15, 0.25, 0.35, 0.45]);
	});

	it('does not drift over a long walk far from the origin', () => {
		const anchor = 9.5 * 3600;
		const splits = splitsForStep({ step: 900, anchor });

		const result = splits(fakeSelf(), 0, 1.7e9, 1.7e9 + 86400, 0, 0);

		expect(result.length).toBeGreaterThan(90);
		for (const value of result) {
			expect((value - anchor) % 900).toBe(0);
		}
	});

	it('cleans float noise when the anchor carries more than 15 fractional digits', () => {
		// a clean 0.1 step under a noisy anchor — 0.1 + 0.2 is 0.30000000000000004, 17 fractional
		// digits — used to push the grid's rounding past its 15-digit ceiling and disable it for
		// every tick, so a plain 0.6 came out as 0.6000000000000001. Significant-digit rounding
		// recovers the decimals the caller wrote.
		const splits = splitsForStep({ step: 0.1, anchor: 0.1 + 0.2 });

		expect(splits(fakeSelf(), 0, 0.25, 0.75, 0, 0)).toEqual([0.3, 0.4, 0.5, 0.6, 0.7]);
	});

	it('cleans float noise on a sub-1e-15-magnitude grid decimals cannot round', () => {
		// below 1e-15 a double has more decimals than it can carry, so decimal rounding cannot help
		// at all; significant-digit rounding is scale-free and cleans it. 3 * 7e-16 is
		// 2.1000000000000002e-15 raw — the tick decimal rounding would leave noisy
		const splits = splitsForStep({ step: 7e-16 });

		expect(splits(fakeSelf(), 0, 0, 3.5e-15, 0, 0)).toEqual([
			0, 7e-16, 1.4e-15, 2.1e-15, 2.8e-15, 3.5e-15
		]);
	});
});

describe('splitsWithInclude', () => {
	it('merges base ticks with the given values, deduped and sorted', () => {
		const wrapped = splitsWithInclude(splitsForStep({ step: 10 }), [0, 25]);

		const result = wrapped(fakeSelf(), 0, 0, 30, 0, 0);

		expect(result).toEqual([0, 10, 20, 25, 30]);
	});

	it('clamps injected values outside the visible range', () => {
		const wrapped = splitsWithInclude(splitsForStep({ step: 10 }), [-100, 1000]);

		const result = wrapped(fakeSelf(), 0, 0, 30, 0, 0);

		expect(result).toEqual([0, 10, 20, 30]);
	});

	it('never emits negative zero for an injected -0', () => {
		const result = splitsWithInclude(() => [5], [-0])(fakeSelf(), 0, -50, 50, 0, 0);

		expect(result[0]).toBe(0);
		expect(result.some((value) => Object.is(value, -0))).toBe(false);
	});

	it('clamps injected values to the visible range', () => {
		// a threshold outside the current zoom is dropped rather than extending the axis
		const inner: SplitsFn = (_self, _axisIdx, min, max) =>
			[0, 25, 50, 75, 100].filter((value) => value >= min && value <= max);

		expect(splitsWithInclude(inner, [0, 50, 100])(fakeSelf(), 0, 40, 60, 0, 0)).toEqual([50]);
		expect(splitsWithEdges(inner, { mode: 'always' })(fakeSelf(), 0, 40, 60, 0, 0)).toEqual([
			40, 50, 60
		]);
	});

	it('does not emit two injected values that are the same tick a sub-pixel apart', () => {
		// 0.1 + 0.2 is 0.30000000000000004 — isSameTick to 0.3 but not === it, and near no grid
		// tick. Deduping injected values only against the base ticks (not against each other) let
		// both survive the final exact-equality Set, drawing two gridlines a sub-pixel apart.
		const wrapped = splitsWithInclude(splitsForStep({ step: 10 }), [0.3, 0.1 + 0.2]);

		const result = wrapped(fakeSelf(), 0, 0, 30, 0, 0);

		expect(result.filter((v) => v > 0 && v < 10)).toEqual([0.3]);
		expect(result).toEqual([0, 0.3, 10, 20, 30]);
	});

	it('sorts and dedupes a large injected set against an unsorted inner tick set', () => {
		// exercises the bounded merge path (binary search into the inner ticks, sorted-order dedup
		// among the injected): the inner deliberately returns ticks out of order, and the injected
		// values include a one-ulp-noisy duplicate of an inner tick (20 and 20 + 4e-15) and of
		// another injected value (25 and 25 + 4e-15) — neither may produce a doubled sub-pixel tick.
		const inner: SplitsFn = () => [30, 10, 20, 50, 40];
		const injected = [20 + 4e-15, 25, 25 + 4e-15, ...Array.from({ length: 37 }, (_, i) => 100 + i)];

		const result = splitsWithInclude(inner, injected)(fakeSelf(), 0, 0, 60, 0, 0);

		// ascending, and the inner tick 20 absorbed its noisy injected twin; 25 kept once; the
		// 100+ values are all out of the [0, 60] range and dropped
		expect(result).toEqual([10, 20, 25, 30, 40, 50]);
	});

	it('injects nothing on an inverted range, passing the inner ticks through', () => {
		// isTickable rejects scaleMin > scaleMax the same way the generators do — an injected value
		// cannot fall inside an empty interval — so the inner ticks pass through unchanged
		const result = splitsWithInclude(() => [1, 2, 3], [1.5, 100])(fakeSelf(), 0, 10, 5, 0, 0);

		expect(result).toEqual([1, 2, 3]);
	});

	it('does not let a caller mutate the injected values after the fact', () => {
		const thresholds = [25];
		const wrapped = splitsWithInclude(splitsForStep({ step: 10 }), thresholds);

		expect(wrapped(fakeSelf(), 0, 0, 30, 0, 0)).toEqual([0, 10, 20, 25, 30]);

		thresholds.length = 0;
		thresholds.push(5, 15);

		// the array is read every redraw but copied once, so an axis already built is untouched
		expect(wrapped(fakeSelf(), 0, 0, 30, 0, 0)).toEqual([0, 10, 20, 25, 30]);
	});

	it('includes valid category indices on a default ordinal axis', () => {
		// uPlot's default ordinal x range is exactly [0, count - 1], so the injected values are
		// clamped to that without any category-specific machinery
		const wrapped = splitsWithInclude(splitsForCategory({ count: 5 }), [2, 4]);

		expect(wrapped(fakeSelf(), 0, 0, 4, 0, 0)).toEqual([0, 1, 2, 3, 4]);
	});
});

describe('splitsWithLimit', () => {
	it('returns the base ticks unchanged when within the limit', () => {
		const wrapped = splitsWithLimit(splitsForStep({ step: 10 }), 10);

		expect(wrapped(fakeSelf(), 0, 0, 30, 0, 0)).toEqual([0, 10, 20, 30]);
	});

	it('thins evenly to at most max ticks, keeping the first', () => {
		const wrapped = splitsWithLimit(splitsForStep({ step: 10 }), 2);

		// base ticks are [0, 10, ..., 90] (10 ticks) -> stride = ceil(10 / 2) = 5 -> indices 0, 5
		const result = wrapped(fakeSelf(), 0, 0, 90, 0, 0);

		expect(result).toEqual([0, 50]);
		expect(result.length).toBeLessThanOrEqual(2);
	});

	it('returns an empty array for a non-positive max', () => {
		const wrapped = splitsWithLimit(splitsForStep({ step: 10 }), 0);

		expect(wrapped(fakeSelf(), 0, 0, 30, 0, 0)).toEqual([]);
	});

	it('treats NaN and Infinity as no limit rather than blanking the axis', () => {
		const base = [0, 10, 20, 30];

		// e.g. max derived as Math.floor(plotWidth / labelWidth) before the label is measured
		expect(splitsWithLimit(splitsForStep({ step: 10 }), NaN)(fakeSelf(), 0, 0, 30, 0, 0)).toEqual(
			base
		);
		expect(
			splitsWithLimit(splitsForStep({ step: 10 }), Infinity)(fakeSelf(), 0, 0, 30, 0, 0)
		).toEqual(base);
	});

	it('treats an unmeasured max as no limit rather than blanking the axis', () => {
		const base = [0, 10, 20, 30];
		const inner = splitsForStep({ step: 10 });

		// a JS caller spells "the label width is not measured yet" as undefined or null just as
		// readily as NaN, and none of the three means "nothing fits"
		for (const max of [undefined, null]) {
			expect(splitsWithLimit(inner, max as unknown as number)(fakeSelf(), 0, 0, 30, 0, 0)).toEqual(
				base
			);
		}
	});

	it('treats -Infinity as a non-positive max, not as no limit', () => {
		// -Infinity orders below every real limit, so it means "nothing fits", the same as 0
		expect(
			splitsWithLimit(splitsForStep({ step: 10 }), -Infinity)(fakeSelf(), 0, 0, 30, 0, 0)
		).toEqual([]);
	});

	it('floors a fractional max rather than exceeding it', () => {
		// the natural measurement `plotWidth / labelWidth` is fractional; thinning against the
		// raw value would bound the result by ceil(max), i.e. hand back 3 ticks for max 2.5
		const base = splitsForStep({ step: 1 }); // 11 ticks over [0, 10]

		expect(splitsWithLimit(base, 2.5)(fakeSelf(), 0, 0, 10, 0, 0)).toEqual([0, 6]);
		expect(splitsWithLimit(base, 1.2)(fakeSelf(), 0, 0, 10, 0, 0)).toEqual([0]);
		// below one label fits, so the axis blanks rather than showing a lone tick
		expect(splitsWithLimit(base, 0.5)(fakeSelf(), 0, 0, 10, 0, 0)).toEqual([]);
	});

	it('favours even spacing over hitting max exactly', () => {
		const wrapped = splitsWithLimit(splitsForStep({ step: 1 }), 10);

		// 11 base ticks; the smallest stride that fits under 10 is 2, so 6 ticks come back
		// rather than 10 unevenly spaced ones
		expect(wrapped(fakeSelf(), 0, 0, 10, 0, 0)).toEqual([0, 2, 4, 6, 8, 10]);
	});
});

describe('splitsWithFilter', () => {
	it('keeps only ticks for which the predicate returns true', () => {
		const isMultipleOf20 = (value: number) => value % 20 === 0;
		const wrapped = splitsWithFilter(splitsForStep({ step: 10 }), isMultipleOf20);

		const result = wrapped(fakeSelf(), 0, 0, 30, 0, 0);

		expect(result).toEqual([0, 20]);
	});

	it('passes self and axisIdx through to the predicate', () => {
		const self = fakeSelf();
		const seen: Array<{ self: uPlot; axisIdx: number }> = [];
		const wrapped = splitsWithFilter(splitsForStep({ step: 10 }), (_value, s, axisIdx) => {
			seen.push({ self: s, axisIdx });
			return true;
		});

		wrapped(self, 2, 0, 10, 0, 0);

		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((entry) => entry.self === self && entry.axisIdx === 2)).toBe(true);
	});

	it('filters the edges too when wrapped outside splitsWithEdges', () => {
		const isWeekday = (value: number) => {
			const day = new Date(value * 1000).getUTCDay();
			return day !== 0 && day !== 6;
		};
		const sat = Date.UTC(2026, 0, 3) / 1000;
		const sunNoon = Date.UTC(2026, 0, 4, 12) / 1000;
		const inner = splitsForTime({ granularity: 'day' });

		// filter INSIDE: the whenEmpty fallback re-adds the weekend edges the filter removed,
		// so a weekend-hiding axis shows two weekend ticks — the documented wrong order
		expect(
			splitsWithEdges(splitsWithFilter(inner, isWeekday))(fakeSelf(), 0, sat, sunNoon, 0, 0)
		).toEqual([sat, sunNoon]);

		// filter OUTSIDE: the edges pass through the predicate, so the weekend window stays empty
		expect(
			splitsWithFilter(splitsWithEdges(inner), isWeekday)(fakeSelf(), 0, sat, sunNoon, 0, 0)
		).toEqual([]);
	});
});

describe('splitsForCategory', () => {
	it('ticks every integer index by default', () => {
		const splits = splitsForCategory();

		const result = splits(fakeSelf(), 0, 0, 4, 0, 0);

		expect(result).toEqual([0, 1, 2, 3, 4]);
	});

	it('offers a remedy its own caller can act on at the density ceiling', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// The shared grid used to hand this caller splitsForStep's remedy verbatim -- "widen the
			// step or narrow the range" -- naming two things a category axis does not have: the range
			// is the categories, and `step` defaults to 1 and is most likely unset.
			expect(splitsForCategory({ count: 10_000 })(fakeSelf(), 0, -0.5, 9999.5, 0, 0)).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.[0]).toContain('Raise `step` to label every Nth category.');

			// and that remedy works: the same axis at step 2 is back under the ceiling
			expect(
				splitsForCategory({ count: 10_000, step: 2 })(fakeSelf(), 0, -0.5, 9999.5, 0, 0)
			).toHaveLength(5000);
		} finally {
			warn.mockRestore();
		}
	});

	it('ticks right up to the ceiling before refusing', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// 9999 is the real ceiling, not MAX_TICK_CANDIDATES -- the refusal is conservative by one
			// for the isSameTick boundary. Documented on SplitsForCategoryOptions.count.
			expect(splitsForCategory({ count: 9999 })(fakeSelf(), 0, -0.5, 9998.5, 0, 0)).toHaveLength(
				9999
			);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('thins to every Nth index when step is set', () => {
		const splits = splitsForCategory({ step: 2 });

		const result = splits(fakeSelf(), 0, 0, 9, 0, 0);

		expect(result).toEqual([0, 2, 4, 6, 8]);
	});

	it('clamps ticks to [0, count - 1] on a scale wider than the data', () => {
		const splits = splitsForCategory({ count: 5 });

		// an explicit scales.x.range, or an ordinal y scale (which uPlot pads), can extend the
		// scale past the real categories; count keeps ticks off the region with no category
		const result = splits(fakeSelf(), 0, -0.5, 5.5, 0, 0);

		expect(result).toEqual([0, 1, 2, 3, 4]);
	});

	it('returns an empty array when count clamps the range to nothing', () => {
		const splits = splitsForCategory({ count: 5 });

		// visible window entirely past the last category
		expect(splits(fakeSelf(), 0, 10, 20, 0, 0)).toEqual([]);
	});

	it('warns and falls back to every index for a step that is not a whole count', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// a half index has no category behind it, so it must never be ticked — but unlike
			// splitsForStep this option has a default to fall back to, and a dense readable axis
			// beats a blank one once the console says what happened
			expect(splitsForCategory({ step: 0.5 })(fakeSelf(), 0, 0, 4, 0, 0)).toEqual([0, 1, 2, 3, 4]);
			expect(splitsForCategory({ step: 0 })(fakeSelf(), 0, 0, 3, 0, 0)).toEqual([0, 1, 2, 3]);
			expect(warn).toHaveBeenCalledTimes(2);
			expect(warn.mock.calls[0]?.[0]).toContain('step must be a positive whole number');
		} finally {
			warn.mockRestore();
		}
	});

	it('warns and ignores a count that is not a whole number of categories', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// falling back to "unset" means no clamping — the documented default — rather than
			// clamping to a fractional index, which silently dropped the last category
			expect(splitsForCategory({ count: 2.5 })(fakeSelf(), 0, 0, 4, 0, 0)).toEqual([0, 1, 2, 3, 4]);
			expect(splitsForCategory({ count: Infinity })(fakeSelf(), 0, 0, 3, 0, 0)).toEqual([
				0, 1, 2, 3
			]);
			expect(warn).toHaveBeenCalledTimes(2);
			expect(warn.mock.calls[0]?.[0]).toContain('count must be a whole number of categories');

			// a real count of zero is a legitimate answer, not a bad option: no categories, no ticks
			warn.mockClear();
			expect(splitsForCategory({ count: 0 })(fakeSelf(), 0, 0, 4, 0, 0)).toEqual([]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('returns a single tick for equal bounds and nothing degenerate for bad bounds', () => {
		const splits = splitsForCategory();

		expect(splits(fakeSelf(), 0, 3, 3, 0, 0)).toEqual([3]);
		expect(splits(fakeSelf(), 0, NaN, 10, 0, 0)).toEqual([]);
		expect(splits(fakeSelf(), 0, 10, 0, 0, 0)).toEqual([]);
	});

	it('emits nothing for a zero-width range that lands between two categories', () => {
		// uPlot can hand a fractional zero-width range on a zoomed ordinal scale; 2.5 is not a
		// category index and must not be ticked as if it were
		expect(splitsForCategory({ count: 5 })(fakeSelf(), 0, 2.5, 2.5, 0, 0)).toEqual([]);
		expect(splitsForCategory({ count: 5 })(fakeSelf(), 0, 2, 2, 0, 0)).toEqual([2]);
	});

	it('skips indices that step passes over even at zero width', () => {
		const splits = splitsForCategory({ step: 2, count: 10 });

		expect(splits(fakeSelf(), 0, 4, 4, 0, 0)).toEqual([4]);
		expect(splits(fakeSelf(), 0, 5, 5, 0, 0)).toEqual([]);
	});
});

describe('splitsWithEdges', () => {
	it('does not alter ticks the base function already returns, in whenEmpty mode (default)', () => {
		const wrapped = splitsWithEdges(splitsForStep({ step: 10 }));

		const result = wrapped(fakeSelf(), 0, 0, 30, 0, 0);

		expect(result).toEqual([0, 10, 20, 30]);
	});

	it('falls back to the range edges when the base function returns nothing, in whenEmpty mode', () => {
		const wrapped = splitsWithEdges(splitsForLog());

		// scaleMin <= 0 is outside splitsForLog's domain, so the base returns []
		const result = wrapped(fakeSelf(), 0, -5, 5, 0, 0);

		expect(result).toEqual([-5, 5]);
	});

	it('always merges the range edges with the base ticks in always mode', () => {
		const wrapped = splitsWithEdges(splitsForStep({ step: 10 }), { mode: 'always' });

		const result = wrapped(fakeSelf(), 0, 5, 25, 0, 0);

		// base ticks are [10, 20]; edges 5 and 25 are merged in, deduped, sorted
		expect(result).toEqual([5, 10, 20, 25]);
	});

	it('does not duplicate an edge that is already a real tick in always mode', () => {
		const wrapped = splitsWithEdges(splitsForStep({ step: 10 }), { mode: 'always' });

		const result = wrapped(fakeSelf(), 0, 0, 30, 0, 0);

		expect(result).toEqual([0, 10, 20, 30]);
	});

	it('supplies the intraday fallback splitsForTime no longer bakes in', () => {
		const wrapped = splitsWithEdges(splitsForTime({ granularity: 'day' }));
		const scaleMin = unixSec('2026-01-05T06:00:00Z');
		const scaleMax = unixSec('2026-01-05T18:00:00Z');

		expect(wrapped(fakeSelf(), 0, scaleMin, scaleMax, 0, 0)).toEqual([scaleMin, scaleMax]);
	});

	it('leaves real calendar ticks alone when the range does contain boundaries', () => {
		const wrapped = splitsWithEdges(splitsForTime({ granularity: 'day' }));
		const scaleMin = unixSec('2026-01-01T06:00:00Z');
		const scaleMax = unixSec('2026-01-04T18:00:00Z');

		const result = wrapped(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

		expect(result).not.toContain(scaleMin);
		for (const value of result) {
			expect(value % 86400).toBe(0);
		}
	});

	it('adds the category-index edges on a default ordinal axis', () => {
		// uPlot's default ordinal x range is exactly [0, count - 1], so the raw edges the
		// decorator injects are already the first and last real category
		const wrapped = splitsWithEdges(splitsForCategory({ count: 5, step: 3 }), { mode: 'always' });

		// step 3 ticks only 0 and 3; the edges fill in 0 (already there) and 4
		expect(wrapped(fakeSelf(), 0, 0, 4, 0, 0)).toEqual([0, 3, 4]);
	});

	it('falls back to the range edges when the inner function is empty inside the categories', () => {
		// step 3 skips over indices 1 and 2, so the inner function has nothing to return here
		const wrapped = splitsWithEdges(splitsForCategory({ count: 5, step: 3 }));

		expect(wrapped(fakeSelf(), 0, 1, 2, 0, 0)).toEqual([1, 2]);
	});

	it('adds no edges on an inverted range, even in always mode', () => {
		// an inverted range has no meaningful edges to add — isTickable rejects it — so the inner
		// ticks pass through and neither scaleMin nor scaleMax is injected
		const wrapped = splitsWithEdges(() => [1, 2, 3], { mode: 'always' });

		expect(wrapped(fakeSelf(), 0, 10, 5, 0, 0)).toEqual([1, 2, 3]);
	});

	it('does not re-clamp the inner ticks, nor double the edge it already covers', () => {
		// stepGrid emits the boundary tick as 0.45 — the value the caller wrote — while the raw
		// bound it came from stays 0.44999999999999996. Re-clamping the inner's output against
		// that bound deleted the tick; injecting the bound beside it drew a second gridline a
		// sub-pixel away with both labels stacked. Neither may happen.
		const inner = splitsForStep({ step: 0.15 });
		const scaleMax = 3 * 0.15;

		expect(inner(fakeSelf(), 0, 0, scaleMax, 0, 0)).toEqual([0, 0.15, 0.3, 0.45]);
		expect(splitsWithEdges(inner, { mode: 'always' })(fakeSelf(), 0, 0, scaleMax, 0, 0)).toEqual([
			0, 0.15, 0.3, 0.45
		]);
		expect(splitsWithInclude(inner, [])(fakeSelf(), 0, 0, scaleMax, 0, 0)).toEqual([
			0, 0.15, 0.3, 0.45
		]);
	});

	it('composes through a chain of decorators', () => {
		const wrapped = splitsWithEdges(
			splitsWithLimit(
				splitsWithFilter(splitsForCategory({ count: 5 }), () => true),
				10
			),
			{ mode: 'always' }
		);

		expect(wrapped(fakeSelf(), 0, 0, 4, 0, 0)).toEqual([0, 1, 2, 3, 4]);
	});

	it('falls back to the raw range for a generator that declares no domain', () => {
		const wrapped = splitsWithEdges(splitsForStep({ step: 10 }), { mode: 'always' });

		expect(wrapped(fakeSelf(), 0, 5, 25, 0, 0)).toEqual([5, 10, 20, 25]);
	});

	it('warns once and falls back to whenEmpty for an unrecognized mode', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// a typo that TypeScript would reject, arriving from plain JS or a cast config
			const wrapped = splitsWithEdges(splitsForStep({ step: 10 }), {
				mode: 'Always' as 'always'
			});

			// whenEmpty behavior: base ticks are non-empty, so no edges are appended
			expect(wrapped(fakeSelf(), 0, 5, 25, 0, 0)).toEqual([10, 20]);
			// invalid on a second redraw too, but reported only once (checked at factory time)
			expect(wrapped(fakeSelf(), 0, 5, 25, 0, 0)).toEqual([10, 20]);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});
});
