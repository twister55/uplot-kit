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
	splitsWithLimit
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
		for (const value of result) {
			expect(new Date(value * 1000).getUTCDay()).toBe(0);
		}
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
		const scaleMin = unixSec('2026-01-01T00:00:00Z');
		const scaleMax = unixSec('2026-12-01T00:00:00Z');

		// uPlot's ladder can hand a ~30-day foundIncr for a monthly range; the tick set must
		// not depend on it (a 28-day Feb->Mar step must never be thinned away)
		const withoutIncr = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);
		const withMonthIncr = splits(fakeSelf(), 0, scaleMin, scaleMax, 30 * 86400, 60);

		expect(withoutIncr).toEqual(withMonthIncr);
		const months = withoutIncr.map((value) => new Date(value * 1000).getUTCMonth());
		expect(months).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
	});

	it('returns ticks that are all within [scaleMin, scaleMax]', () => {
		const splits = splitsForTime({ granularity: 'day' });
		const scaleMin = unixSec('2026-03-01T00:00:00Z');
		const scaleMax = unixSec('2026-03-10T00:00:00Z');

		const result = splits(fakeSelf(), 0, scaleMin, scaleMax, 0, 0);

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

	it('caps the walk on degenerate ranges instead of hanging or truncating silently', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const splits = splitsForTime({ granularity: 'year' });

			// e.g. millisecond/nanosecond epoch values mistakenly fed to a seconds axis.
			// The cap's exact value is the implementation's business — what matters is that
			// the walk terminates far short of the ~31 million year ticks this range spans,
			// and says so once.
			const result = splits(fakeSelf(), 0, 0, 1e15, 0, 0);

			expect(result.length).toBeLessThan(1e15 / (366 * 86400));
			for (const value of result) {
				expect(Number.isFinite(value)).toBe(true);
			}
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
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

		result.reduce((previous, current) => {
			expect(current).toBeGreaterThan(previous);
			return current;
		});
	});

	it('emits exact minor ticks inside sub-1 decades', () => {
		const splits = splitsForLog({ minor: true });

		const result = splits(fakeSelf(), 0, 0.001, 0.01, 0, 0);

		// 9 * 0.001 is 0.009000000000000001 unrounded, which a default value formatter shows
		expect(result).toEqual([0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.01]);
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

	it('returns an empty array for a non-positive step', () => {
		const splits = splitsForStep({ step: 0 });

		expect(splits(fakeSelf(), 0, 0, 100, 0, 0)).toEqual([]);
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

	it('refuses a grid whose index is past exact integer precision instead of collapsing it', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// a nanosecond step phased against a Unix-seconds origin puts the first tick at
			// index ~1.7e18, where `index + 1 === index` — every "tick" would be the same value
			const splits = splitsForStep({ step: 1e-9 });

			expect(splits(fakeSelf(), 0, 1.7e9, 1.7e9 + 1, 0, 0)).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});

	it('refuses a non-finite anchor rather than emitting NaN ticks', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const splits = splitsForStep({ step: 10, anchor: Infinity });

			expect(splits(fakeSelf(), 0, 0, 100, 0, 0)).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});

	it('caps the walk on degenerate ranges instead of hanging or truncating silently', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const splits = splitsForStep({ step: 1e-9 });

			const result = splits(fakeSelf(), 0, 0, 1, 0, 0);

			// the range holds 1e9 steps; the walk bails far short of that, once, loudly
			expect(result.length).toBeLessThan(1e9);
			expect(warn).toHaveBeenCalledOnce();
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

	it('clamps injected values to the inner domain, not just the raw range', () => {
		const wrapped = splitsWithInclude(splitsForCategory({ count: 5 }), [-0.5, 4, 5.5]);

		// -0.5 and 5.5 sit in uPlot's ordinal padding, which `count` exists to exclude — the
		// decorator must not put back what the generator refused
		expect(wrapped(fakeSelf(), 0, -0.5, 5.5, 0, 0)).toEqual([0, 1, 2, 3, 4]);
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

	it('treats -Infinity as a non-positive max, not as no limit', () => {
		// -Infinity orders below every real limit, so it means "nothing fits", the same as 0
		expect(
			splitsWithLimit(splitsForStep({ step: 10 }), -Infinity)(fakeSelf(), 0, 0, 30, 0, 0)
		).toEqual([]);
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
});

describe('splitsForCategory', () => {
	it('ticks every integer index by default', () => {
		const splits = splitsForCategory();

		const result = splits(fakeSelf(), 0, 0, 4, 0, 0);

		expect(result).toEqual([0, 1, 2, 3, 4]);
	});

	it('thins to every Nth index when step is set', () => {
		const splits = splitsForCategory({ step: 2 });

		const result = splits(fakeSelf(), 0, 0, 9, 0, 0);

		expect(result).toEqual([0, 2, 4, 6, 8]);
	});

	it('clamps ticks to [0, count - 1] on a padded ordinal range', () => {
		const splits = splitsForCategory({ count: 5 });

		// uPlot pads ordinal scales, so scaleMin/scaleMax can extend past real categories
		const result = splits(fakeSelf(), 0, -0.5, 5.5, 0, 0);

		expect(result).toEqual([0, 1, 2, 3, 4]);
	});

	it('returns an empty array when count clamps the range to nothing', () => {
		const splits = splitsForCategory({ count: 5 });

		// visible window entirely past the last category
		expect(splits(fakeSelf(), 0, 10, 20, 0, 0)).toEqual([]);
	});

	it('returns an empty array for a non-positive step', () => {
		const splits = splitsForCategory({ step: 0 });

		expect(splits(fakeSelf(), 0, 0, 10, 0, 0)).toEqual([]);
	});

	it('returns an empty array for a fractional step rather than half-index ticks', () => {
		// a half index has no category behind it, so `values: (_u, t) => t.map(i => cats[i])`
		// would render a gridline with a blank label
		expect(splitsForCategory({ step: 0.5 })(fakeSelf(), 0, 0, 4, 0, 0)).toEqual([]);
		expect(splitsForCategory({ step: 1.5, count: 9 })(fakeSelf(), 0, 0, 8, 0, 0)).toEqual([]);
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

	it('uses the first and last real category as edges, not the ordinal padding', () => {
		const wrapped = splitsWithEdges(splitsForCategory({ count: 5 }), { mode: 'always' });

		// uPlot pads an ordinal scale, so scaleMin/scaleMax straddle the real categories;
		// injecting the raw edges would undo exactly what `count` is for
		expect(wrapped(fakeSelf(), 0, -0.5, 5.5, 0, 0)).toEqual([0, 1, 2, 3, 4]);
	});

	it('adds no edges at all when the window is entirely past the last category', () => {
		const wrapped = splitsWithEdges(splitsForCategory({ count: 5 }));

		// the domain is empty here, so there is no meaningful edge to fall back to — two ticks
		// with no category behind them would be worse than a blank axis
		expect(wrapped(fakeSelf(), 0, 10, 20, 0, 0)).toEqual([]);
	});

	it('still falls back to the domain edges when the window is inside the categories', () => {
		// step 3 skips over indices 1 and 2, so the inner function has nothing to return here
		const wrapped = splitsWithEdges(splitsForCategory({ count: 5, step: 3 }));

		expect(wrapped(fakeSelf(), 0, 1, 2, 0, 0)).toEqual([1, 2]);
	});

	it('carries the inner domain through a chain of decorators', () => {
		const wrapped = splitsWithEdges(
			splitsWithLimit(
				splitsWithFilter(splitsForCategory({ count: 5 }), () => true),
				10
			),
			{ mode: 'always' }
		);

		// each decorator re-publishes the domain, so the narrowing survives every wrap
		expect(wrapped(fakeSelf(), 0, -0.5, 5.5, 0, 0)).toEqual([0, 1, 2, 3, 4]);
	});

	it('falls back to the raw range for a generator that declares no domain', () => {
		const wrapped = splitsWithEdges(splitsForStep({ step: 10 }), { mode: 'always' });

		expect(wrapped(fakeSelf(), 0, 5, 25, 0, 0)).toEqual([5, 10, 20, 25]);
	});
});
