import { describe, expect, it } from 'vitest';

import {
	incrsByUnit,
	incrsForBits,
	incrsForBytes,
	incrsForIntegers,
	incrsForKilobytes,
	incrsForMegabytes,
	incrsForMicroseconds,
	incrsForMilliseconds,
	incrsForNanoseconds,
	incrsForSeconds,
	incrsLadder,
	incrsStep,
	type IncrsByUnitKind
} from './incrs';

describe('incrsLadder', () => {
	it('generates an exact decimal ladder for base 10, including negative exponents', () => {
		const incrs = incrsLadder(10, -1, 1, [1, 2, 5]);
		// Strict equality, not toBeCloseTo: the whole point of the float-precision cleanup is
		// that these come out as exact round numbers, not raw floating-point products.
		expect(incrs).toStrictEqual([0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50]);
	});

	it("produces the exact value uPlot's own internal ladder relies on (no float drift)", () => {
		// 2.5e-7 is the kind of value that (2.5 * 10 ** -7) mangles into
		// 2.5000000000000004e-7 without the string-literal construction.
		const incrs = incrsLadder(10, -7, -7, [2.5]);
		expect(incrs).toStrictEqual([2.5e-7]);
	});

	it('rounds non-decimal bases (e.g. binary) to clean values instead of raw products', () => {
		const incrs = incrsLadder(2, -20, -18, [1]);
		expect(incrs).toStrictEqual([2 ** -20, 2 ** -19, 2 ** -18]);
	});

	it('keeps a fractional mantissa exact across the exponent that turns it whole (base 10)', () => {
		// 2.5 * 10^0 = 2.5 (one decimal place), 2.5 * 10^1 = 25 (whole) — both must be exact.
		const incrs = incrsLadder(10, 0, 1, [2.5]);
		expect(incrs).toStrictEqual([2.5, 25]);
	});

	it("treats maxExp as inclusive, unlike uPlot's own internal generator", () => {
		const incrs = incrsLadder(10, 0, 0, [1]);
		expect(incrs).toStrictEqual([1]);
	});

	it('returns an empty array when mantissas is empty', () => {
		expect(incrsLadder(10, 0, 5, [])).toStrictEqual([]);
	});

	it('orders results by exponent then by mantissa order, ascending for positive mantissas', () => {
		const incrs = incrsLadder(10, 0, 2, [1, 2, 5]);
		incrs.reduce((previous, current) => {
			expect(current).toBeGreaterThan(previous);
			return current;
		});
	});
});

const FACADES: Record<IncrsByUnitKind, () => number[]> = {
	byte: incrsForBytes,
	kilobyte: incrsForKilobytes,
	megabyte: incrsForMegabytes,
	bit: incrsForBits,
	integer: incrsForIntegers,
	second: incrsForSeconds,
	millisecond: incrsForMilliseconds,
	microsecond: incrsForMicroseconds,
	nanosecond: incrsForNanoseconds
};

const ALL_KINDS = Object.keys(FACADES) as IncrsByUnitKind[];

// uPlot's tick-increment selection assumes the incrs list is sorted ascending with no
// duplicates; an unsorted or duplicate-laden list can make it pick a wrong or no increment
// (the same class of bug behind the sub-millisecond regression tested below).
function expectSortedAndUnique(values: number[]): void {
	expect(values.length).toBe(new Set(values).size);
	values.reduce((previous, current) => {
		expect(current).toBeGreaterThan(previous);
		return current;
	});
}

describe('incrsFor* facades', () => {
	it.each(ALL_KINDS)('returns a sorted, duplicate-free ladder for %s', (kind) => {
		expectSortedAndUnique(FACADES[kind]());
	});

	it.each(ALL_KINDS)('returns a fresh array on every call for %s', (kind) => {
		expect(FACADES[kind]()).not.toBe(FACADES[kind]());
	});

	describe('incrsForBytes', () => {
		it('contains 1024 and bottoms out at 1 byte', () => {
			const values = incrsForBytes();
			expect(values).toContain(1024);
			expect(Math.min(...values)).toBe(1);
		});
	});

	describe('incrsForKilobytes / incrsForMegabytes', () => {
		it('resolve down to a single byte, same as incrsForBytes', () => {
			expect(Math.min(...incrsForKilobytes())).toBe(2 ** -10);
			expect(Math.min(...incrsForMegabytes())).toBe(2 ** -20);
			expect(incrsForKilobytes()).toContain(1024);
			expect(incrsForMegabytes()).toContain(1024);
		});
	});

	describe('incrsForBits', () => {
		it('uses decimal (SI) steps and excludes the quarter-decade mantissa', () => {
			const values = incrsForBits();
			expect(values).toContain(1);
			expect(values).toContain(2);
			expect(values).toContain(5);
			expect(values).toContain(10);
			expect(values).not.toContain(2.5);
			expect(values).not.toContain(25);
		});
	});

	describe('incrsForIntegers', () => {
		it('contains only whole numbers, including the quarter-decade mantissa once it scales whole', () => {
			const values = incrsForIntegers();
			expect(values.every((v) => Number.isInteger(v))).toBe(true);
			expect(values).toContain(25); // 2.5 * 10 — whole once scaled up a decade
			expect(values).not.toContain(2.5);
		});
	});

	describe('incrsForSeconds', () => {
		it('contains round time increments up to a week', () => {
			const values = incrsForSeconds();
			expect(values).toContain(60);
			expect(values).toContain(900);
			expect(values).toContain(1800);
			expect(values).toContain(3600);
			expect(values).toContain(86400);
			expect(values).toContain(604800);
		});

		it('extends beyond a week up to 100 years so long-range duration axes still tick', () => {
			// Without this, a duration axis with a multi-month/year range exceeds every entry in
			// the old (week-capped) ladder, uPlot's findIncr() returns no increment at all, and
			// the axis silently renders no ticks.
			const values = incrsForSeconds();
			expect(values).toContain(2592000); // 30d
			expect(values).toContain(31536000); // 1y
			expect(Math.max(...values)).toBe(3153600000); // 100y
		});
	});

	describe('sub-millisecond resolution (regression)', () => {
		// Microsecond/nanosecond used to only have increments down to 1000/1e6 (the seconds
		// ladder's 1ms floor scaled up), so a chart whose values span less than 1ms in that unit
		// had no small-enough increment to tick on and uPlot rendered no Y axis at all.
		it('has a fine enough minimum increment for microseconds and nanoseconds', () => {
			expect(Math.min(...incrsForMicroseconds())).toBeLessThan(1);
			expect(Math.min(...incrsForNanoseconds())).toBeLessThanOrEqual(1);
		});
	});

	describe('ms/µs/ns scaling', () => {
		it('matches the seconds ladder length exactly across all four duration units', () => {
			const length = incrsForSeconds().length;
			expect(incrsForMilliseconds().length).toBe(length);
			expect(incrsForMicroseconds().length).toBe(length);
			expect(incrsForNanoseconds().length).toBe(length);
		});

		it('scales the whole-second-and-up tail by an exact integer factor', () => {
			// 1800s (30m) sits well within the range where integer * 1e3/1e6/1e9 stays exact in
			// float64, so this is a strict toContain, not toBeCloseTo — the ladder is built
			// specifically to avoid the drift the next test guards against.
			expect(incrsForMilliseconds()).toContain(1800 * 1000);
			expect(incrsForMicroseconds()).toContain(1800 * 1000 ** 2);
			expect(incrsForNanoseconds()).toContain(1800 * 1000 ** 3);
		});

		it('regenerates the sub-second part via exponent shift, not drifting float multiplication', () => {
			// 1e-9 * 1000 !== 1e-6 in float64 (it drifts to 0.0000010000000000000002) — these
			// assert the clean value is present, not whatever a naive multiplication would give.
			expect(incrsForMilliseconds()).toContain(1e-6);
			expect(incrsForMicroseconds()).toContain(1e-3);
			expect(incrsForNanoseconds()).toContain(1);
		});
	});

	describe('IncrsOptions filtering', () => {
		it('drops increments below minIncr', () => {
			expect(Math.min(...incrsForSeconds({ minIncr: 3600 }))).toBe(3600);
		});

		it('drops increments above maxIncr', () => {
			expect(Math.max(...incrsForSeconds({ maxIncr: 3600 }))).toBe(3600);
		});

		it('returns an empty array (not a throw) when the bounds admit nothing', () => {
			expect(incrsForSeconds({ minIncr: 1, maxIncr: 0 })).toStrictEqual([]);
		});
	});
});

describe('incrsByUnit', () => {
	it.each(ALL_KINDS)('matches the equivalent incrsFor* facade for %s', (kind) => {
		expect(incrsByUnit(kind)).toStrictEqual(FACADES[kind]());
	});

	it('passes a custom increment array through as a fresh copy, not the same reference', () => {
		const custom = [1, 2, 4, 8];
		const result = incrsByUnit(custom);
		expect(result).toStrictEqual(custom);
		expect(result).not.toBe(custom);
	});

	it('applies IncrsOptions to a custom array too', () => {
		const custom = [1, 2, 4, 8, 16];
		expect(incrsByUnit(custom, { minIncr: 4, maxIncr: 8 })).toStrictEqual([4, 8]);
	});
});

describe('incrsStep', () => {
	it('scales the default whole-number ladder by base', () => {
		const values = incrsStep(900);
		expect(values).toContain(900); // 900 * 1
		expect(values).toContain(1800); // 900 * 2
		expect(values).toContain(4500); // 900 * 5
		expect(values).toContain(9000); // 900 * 10
		expect(values).toContain(22500); // 900 * 25
	});

	it('does not offer a value that is not a multiple of base', () => {
		expect(incrsStep(900)).not.toContain(1350); // 900 * 1.5
	});

	it('returns a sorted, duplicate-free ladder', () => {
		const values = incrsStep(7);
		expect(values.length).toBe(new Set(values).size);
		values.reduce((previous, current) => {
			expect(current).toBeGreaterThan(previous);
			return current;
		});
	});

	it('uses custom mults verbatim, in the given order, scaled by base', () => {
		expect(incrsStep(900, { mults: [1, 4, 16, 96] })).toStrictEqual([900, 3600, 14400, 86400]);
	});

	it('applies IncrsOptions on top of the scaled ladder', () => {
		const values = incrsStep(900, { minIncr: 1800, maxIncr: 9000 });
		expect(Math.min(...values)).toBe(1800);
		expect(Math.max(...values)).toBe(9000);
	});

	it('returns a fresh array on every call', () => {
		expect(incrsStep(900)).not.toBe(incrsStep(900));
	});
});
