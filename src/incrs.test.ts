import { describe, expect, it, vi } from 'vitest';

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

	it('stays exact for any base that is a product of 2s and 5s, not just 2/5/10', () => {
		// The decimal budget used to be |exp| places regardless of base, which is only enough when
		// one negative power of the base fits in that many decimals. Anything denser truncated:
		// base 4 gave 0.016 for 4^-3, and base 16 and up collapsed to exactly 0.
		expect(incrsLadder(4, -3, -1, [1])).toStrictEqual([4 ** -3, 4 ** -2, 4 ** -1]);
		expect(incrsLadder(8, -3, -1, [1])).toStrictEqual([8 ** -3, 8 ** -2, 8 ** -1]);
		expect(incrsLadder(16, -3, -1, [1])).toStrictEqual([16 ** -3, 16 ** -2, 16 ** -1]);
		expect(incrsLadder(20, -2, -1, [1])).toStrictEqual([20 ** -2, 20 ** -1]);
	});

	it('gives the "one byte expressed in KiB" rung its real value, not 0', () => {
		expect(incrsLadder(1024, -1, -1, [1])).toStrictEqual([1024 ** -1]);
	});

	it('falls back to the nearest float for a base with no finite decimal form', () => {
		// 3 and 60 (the sexagesimal base a duration ladder would reach for) have a prime factor
		// outside {2, 5}, so 3^-1 is 0.333... with no exact decimal to round onto. The closest
		// representable value is the best available answer — rounding to |exp| places gave 0.3.
		expect(incrsLadder(3, -2, -1, [1])).toStrictEqual([3 ** -2, 3 ** -1]);
		expect(incrsLadder(60, -2, -1, [1])).toStrictEqual([60 ** -2, 60 ** -1]);
	});

	it("keeps the base-2 ladder bit-identical to uPlot's own internal generator", () => {
		// uPlot pre-registers genIncrs(2, -53, 53, [1]) in the fixedDec map it looks a tick's
		// decimal count up in, and its rounding drifts a few ulps below 2^-21. Matching that map
		// matters more than being closer to the mathematical value, so the drift is preserved --
		// these are the drifted values, asserted deliberately.
		expect(incrsLadder(2, -22, -22, [1])).toStrictEqual([2.384185791015627e-7]);
		expect(incrsLadder(2, -30, -30, [1])).toStrictEqual([9.313225746154791e-10]);
	});

	it('handles a mantissa that only has an exponential string form', () => {
		// String(1e-7) is '1e-7', and the base-10 fast path builds its literal by concatenation --
		// '1e-7' + 'e-3' is unparseable, and every such mantissa used to come back NaN.
		// Sorted ascending, not in mantissa order: see the ordering test below.
		expect(incrsLadder(10, -3, -3, [1, 1e-7, 1e21])).toStrictEqual([1e-10, 0.001, 1e18]);
	});

	it('drops exponents that saturate float64 instead of shipping Infinity or 0', () => {
		// Neither is usable as an axis increment: findIncr divides by it.
		expect(incrsLadder(10, 400, 400, [1])).toStrictEqual([]);
		expect(incrsLadder(10, -400, -400, [1])).toStrictEqual([]);
	});

	it('warns and yields nothing for arguments that would hang or poison the ladder', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// maxExp: Infinity is the sharp one -- the loop bound is inclusive (a deliberate
			// divergence from uPlot), so it never terminates rather than returning empty.
			expect(incrsLadder(10, 0, Infinity, [1])).toStrictEqual([]);
			expect(incrsLadder(10, -0.5, 0.5, [1])).toStrictEqual([]);
			expect(incrsLadder(10, NaN, 1, [1])).toStrictEqual([]);
			expect(incrsLadder(0, 0, 1, [1])).toStrictEqual([]);
			expect(incrsLadder(Infinity, 0, 1, [1])).toStrictEqual([]);
			expect(incrsLadder(10, 0, 1, [1, NaN])).toStrictEqual([]);
			expect(incrsLadder(10, 0, 1, [Infinity])).toStrictEqual([]);
			// Every one of the seven names a different bad value, so warn-once dedupes none of them.
			expect(warn).toHaveBeenCalledTimes(7);
			expect(warn.mock.calls[0]?.[0]).toContain('minExp and maxExp must be safe integers');
			expect(warn.mock.calls[3]?.[0]).toContain('base must be a finite positive number');
			expect(warn.mock.calls[5]?.[0]).toContain('mantissas must be finite numbers');
		} finally {
			warn.mockRestore();
		}
	});

	it('catches an undefined mantissa and an array hole, which used to slip the guard', () => {
		// The guard read `find`'s "nothing matched" return -- undefined -- as clean, but undefined is
		// itself a non-finite mantissa, so it matched the predicate and was then waved through. No
		// warning, no refusal: downstream the rung came out NaN and was filtered away, leaving a
		// ladder silently missing a step. Both shapes arrive from plain JS, which is what the guard
		// is for. NaN and null are the control -- those always did refuse.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(incrsLadder(10, 0, 2, [1, undefined as never, 5])).toStrictEqual([]);
			expect(incrsLadder(10, 0, 2, new Array<number>(3))).toStrictEqual([]);
			expect(incrsLadder(10, 0, 2, [1, null as never])).toStrictEqual([]);
			expect(warn.mock.calls[0]?.[0]).toContain('got undefined at index 1');
		} finally {
			warn.mockRestore();
		}
	});

	it('warns once per distinct problem, not once per call', () => {
		// The tracker lives at module scope, not inside a factory the way splits' does: every
		// function here is called afresh per axis, so a per-call tracker would warn every redraw.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(incrsLadder(-1, 0, 1, [1])).toStrictEqual([]);
			expect(incrsLadder(-1, 0, 1, [1])).toStrictEqual([]);
			expect(incrsLadder(-1, 0, 1, [1])).toStrictEqual([]);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});

	it('sorts ascending even when generation order interleaves', () => {
		// Generation is exponent-major, so any mantissa at or above the base produces a rung larger
		// than the next exponent's first one: base 2 with [1, 2, 5] emitted 1,2,5,2,4,10,... uPlot's
		// findIncr seeds with closestIdx (a binary search) and then only walks forward, so on that
		// ladder every rung before the seed was unreachable -- a [5,2,1] ordering picks 50 where 5
		// was right, and a descending one picks nothing at all.
		expect(incrsLadder(2, 0, 4, [1, 2, 5])).toStrictEqual([1, 2, 4, 5, 8, 10, 16, 20, 32, 40, 80]);
		expect(incrsLadder(10, 0, 3, [1, 25])).toStrictEqual([1, 10, 25, 100, 250, 1000, 2500, 25000]);
	});

	it('sorts a base below one, whose exponents descend', () => {
		// "A finite positive number" admits base < 1, where a rising exponent shrinks the rung.
		expect(incrsLadder(0.5, 0, 3, [1])).toStrictEqual([0.125, 0.25, 0.5, 1]);
	});

	it('deduplicates rungs that coincide across exponents', () => {
		// 2 * 2^0 and 1 * 2^1 are the same increment; a duplicate is a wasted step of findIncr's
		// forward walk, and the ladders this feeds are documented as duplicate-free.
		expect(incrsLadder(2, 0, 2, [1, 2])).toStrictEqual([1, 2, 4, 8]);
	});

	it('refuses an exponent bound too large for the loop to advance past', () => {
		// Number.isInteger admits 2 ** 53 and everything above it, where `exp++` rounds straight back
		// to where it started -- so this used to spin pushing NaN rungs until the heap died (measured:
		// ~3.6s to OOM under --max-old-space-size=256, for a request of five rungs). In a browser that
		// is a locked UI thread, not a thrown error, which is why the guard is isSafeInteger.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(incrsLadder(10, 2 ** 53, 2 ** 53 + 4, [1])).toStrictEqual([]);
			expect(incrsLadder(10, 1e21, 1e21, [1])).toStrictEqual([]);
			expect(warn.mock.calls[0]?.[0]).toContain('must be safe integers');
		} finally {
			warn.mockRestore();
		}
	});

	it('refuses an exponent span no one can wait out, even though it would terminate', () => {
		// A base near 1 makes each exponent a hair wide, so an ordinary magnitude range spans tens of
		// thousands of them -- and the rungs would be near-identical, which findIncr walks linearly.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(incrsLadder(1.0001, 0, 20_000, [1])).toStrictEqual([]);
			expect(warn.mock.calls[0]?.[0]).toContain('span more than 10000 exponents');
			// A span just inside the cap is still swept, and the exponents that saturate float64 fall
			// out on the ordinary value filter: 10^0 through 10^308 are the finite ones.
			expect(incrsLadder(10, 0, 9999, [1])).toHaveLength(309);
		} finally {
			warn.mockRestore();
		}
	});

	it('drops a negative mantissa rather than shipping a backwards increment', () => {
		// The argument guard only asks for finiteness, so a negative mantissa reaches the loop --
		// and findIncr divides by the increment, so its rungs would space the axis backwards.
		expect(incrsLadder(10, 0, 1, [-2, 1])).toStrictEqual([1, 10]);
	});
});

// uPlot's own arithmetic for turning an increment into tick positions, transcribed from
// node_modules/uplot/dist/uPlot.esm.js (MIT (c) Leon Sorokin) so the invariant below can be
// asserted in node. None of it is exported, so there is nothing to call instead.
function uplotRoundDec(value: number, decimals: number): number {
	if (Number.isInteger(value)) {
		return value;
	}
	const factor = 10 ** decimals;
	return Math.round(value * factor * (1 + Number.EPSILON)) / factor;
}

// uPlot.esm.js:546. Note what it does NOT do: fold in an exponent. '3e-7' has no '.', so 0.
function uplotGuessDec(value: number): number {
	return (String(value).split('.')[1] ?? '').length;
}

// The fixedDec map as uPlot has it after module load (uPlot.esm.js:988, 991, 1187) -- the decimal
// counts it knows without having to guess. genIncrs is transcribed from uPlot.esm.js:550.
function uplotFixedDec(): Map<number, number> {
	const map = new Map<number, number>();
	const genIncrs = (base: number, minExp: number, maxExp: number, mults: number[]): void => {
		const multDec = mults.map(uplotGuessDec);
		for (let exp = minExp; exp < maxExp; exp++) {
			const expa = Math.abs(exp);
			const mag = uplotRoundDec(base ** exp, expa);
			for (const [i, mult] of mults.entries()) {
				const dec = (exp >= 0 ? 0 : expa) + (exp >= (multDec[i] ?? 0) ? 0 : (multDec[i] ?? 0));
				const raw = base === 10 ? Number(`${mult}e${exp}`) : mult * mag;
				map.set(base === 10 ? raw : uplotRoundDec(raw, dec), dec);
			}
		}
	};
	genIncrs(10, -32, 0, [1, 2, 2.5, 5]);
	genIncrs(10, 0, 32, [1, 2, 2.5, 5]);
	genIncrs(2, -53, 53, [1]);
	return map;
}

const UPLOT_FIXED_DEC = uplotFixedDec();

// Whether numAxisSplits (uPlot.esm.js:1488) can advance its loop variable by this increment. It
// steps with `val = roundDec(val + foundIncr, numDec)`, where numDec is the map above for a rung
// uPlot pre-registered and guessDec(incr) for anything else (uPlot.esm.js:3748) -- so when that
// guess is 0 for a value smaller than 1, the step is a no-op and the for-loop never terminates.
function uplotCanStepBy(incr: number): boolean {
	const numDec = UPLOT_FIXED_DEC.get(incr) ?? uplotGuessDec(incr);
	return uplotRoundDec(incr, numDec) === incr;
}

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

describe('every emitted increment is one uPlot can actually step by', () => {
	// The sharp end of the module. uPlot reads the decimal count of an increment below 1e-6 off its
	// String() form, which is exponential there, and gets 0 -- then numAxisSplits' `val = roundDec(
	// val + incr, 0)` leaves val where it was and the loop pushes forever, locking the browser tab.
	// Nothing about it is visible as a wrong axis; the page simply stops. So this asserts the model
	// above, not just the shape of the output.
	it('holds the model honest: an unregistered sub-1e-6 increment really does hang uPlot', () => {
		expect(uplotCanStepBy(3e-7)).toBe(false);
		expect(uplotCanStepBy(1.5e-7)).toBe(false);
		// The two escapes, both of which the ladders here rely on: a mantissa uPlot pre-registers
		// per decade, and a power of two from the map it builds for exactly this purpose.
		expect(uplotCanStepBy(1e-7)).toBe(true);
		expect(uplotCanStepBy(2 ** -20)).toBe(true);
		// At and above 1e-6 the string form carries the decimals, so the guess is right.
		expect(uplotCanStepBy(3e-6)).toBe(true);
	});

	it.each(ALL_KINDS)('holds for every increment of the %s facade', (kind) => {
		expect(FACADES[kind]().filter((incr) => !uplotCanStepBy(incr))).toStrictEqual([]);
	});

	it('holds after the generic entry points drop what they cannot ship', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(incrsStep(3e-7).filter((incr) => !uplotCanStepBy(incr))).toStrictEqual([]);
			expect(incrsLadder(10, -9, 1, [1, 3]).filter((incr) => !uplotCanStepBy(incr))).toStrictEqual(
				[]
			);
		} finally {
			warn.mockRestore();
		}
	});

	it('keeps the wider multiples of a sub-microsecond step, and names what it dropped', () => {
		// A step of its own, not 3e-7 above: the warn-once tracker is module-scoped and keyed by
		// message text, so a test that asserts a message must be the only one to produce it.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// Only 7e-7 itself is unsteppable; every wider multiple is an ordinary increment.
			expect(incrsStep(7e-7).slice(0, 3)).toStrictEqual([1.4e-6, 3.5e-6, 7e-6]);
			expect(warn.mock.calls[0]?.[0]).toContain('1 increment(s) below 0.000001');
			expect(warn.mock.calls[0]?.[0]).toContain('(7e-7)');
			expect(warn.mock.calls[0]?.[0]).toContain('splitsForStep');
		} finally {
			warn.mockRestore();
		}
	});

	it('keeps the pre-registered mantissas of a custom ladder and drops only the rest', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// 1e-9/1e-8/1e-7 survive (mantissa 1 per decade); 3e-9/3e-8/3e-7 do not; everything from
			// 1e-6 up is unaffected.
			expect(incrsLadder(10, -9, -6, [1, 3])).toStrictEqual([1e-9, 1e-8, 1e-7, 1e-6, 3e-6]);
		} finally {
			warn.mockRestore();
		}
	});
});

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

		it('returns an empty array (not a throw) when the bounds admit nothing, and says so', () => {
			// uPlot does not read an empty axis.incrs as "use the default ladder" -- `axis.incrs ||
			// defaults` keeps it, because an empty array is truthy -- so findIncr returns [0, 0] and
			// axesCalc bails before sizing the axis: a blank gutter with no ticks and no gridlines.
			// The bounds are the realistic cause and nothing else on the console names them.
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				expect(incrsForSeconds({ minIncr: 1, maxIncr: 0 })).toStrictEqual([]);
				expect(warn).toHaveBeenCalledOnce();
				expect(warn.mock.calls[0]?.[0]).toContain('no increment is both >= minIncr 1');
			} finally {
				warn.mockRestore();
			}
		});

		it('warns about a NaN bound and ignores it instead of emptying the ladder', () => {
			// `incr >= NaN` is false for every rung, so an unparsed Number(userInput) used to drop
			// every increment -- and an empty axis.incrs makes uPlot render no ticks at all, which
			// looks identical to the deliberate empty case above. The fallback is announced rather
			// than silent: the caller's bound is being ignored, and nothing else would say so.
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const all = incrsForSeconds().length;
				expect(incrsForSeconds({ minIncr: NaN })).toHaveLength(all);
				expect(incrsForSeconds({ maxIncr: NaN })).toHaveLength(all);
				expect(incrsForSeconds({ minIncr: Number('1h') })).toHaveLength(all);
				// Two distinct messages (minIncr, maxIncr); the third call repeats the first.
				expect(warn).toHaveBeenCalledTimes(2);
				expect(warn.mock.calls[0]?.[0]).toContain('minIncr must be a number, got NaN');
				expect(warn.mock.calls[1]?.[0]).toContain('maxIncr must be a number, got NaN');
			} finally {
				warn.mockRestore();
			}
		});

		it('still honours a deliberate 0 bound', () => {
			expect(incrsForSeconds({ minIncr: 0 })).toHaveLength(incrsForSeconds().length);
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

	// This branch takes its ladder straight from a chart config, where nothing has checked it --
	// and every bad shape below fails as a mis-ticked or blank axis rather than as an error.
	describe('custom array hygiene', () => {
		it('sorts an out-of-order array and says so, without touching the caller ', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const custom = [5, 2, 1];
				expect(incrsByUnit(custom)).toStrictEqual([1, 2, 5]);
				expect(custom).toStrictEqual([5, 2, 1]);
				expect(warn).toHaveBeenCalledOnce();
				expect(warn.mock.calls[0]?.[0]).toContain('not in ascending order');
			} finally {
				warn.mockRestore();
			}
		});

		it('drops values that cannot be increments and says how many', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				// Three bad values that used to have three different outcomes: Infinity and 0 passed
				// straight through to axis.incrs, NaN was deleted only incidentally (`NaN >= -Infinity`
				// is false), and a negative spaced the axis backwards.
				expect(incrsByUnit([Infinity, 0, NaN, -5, 5, 1])).toStrictEqual([1, 5]);
				expect(warn.mock.calls[0]?.[0]).toContain('dropped 4 of 6 increments');
			} finally {
				warn.mockRestore();
			}
		});

		it('deduplicates quietly, since a duplicate misticks nothing', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				expect(incrsByUnit([1, 1, 2, 2])).toStrictEqual([1, 2]);
				expect(warn).not.toHaveBeenCalled();
			} finally {
				warn.mockRestore();
			}
		});
	});

	// This is the module's runtime-dispatch entry point, so its argument is exactly the one that
	// can arrive unvalidated from a chart config -- and TypeScript can't help there.
	it.each(['gigabyte', 'valueOf', 'toString', 'constructor', '__proto__'])(
		'warns and yields no increments for the unrecognised kind %s',
		(kind) => {
			// Not a throw: this is the entry point whose argument arrives from a chart config, so a
			// typo there costs an axis its ticks and prints a name, rather than taking the page down.
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				expect(incrsByUnit(kind as IncrsByUnitKind)).toStrictEqual([]);
				expect(warn).toHaveBeenCalledOnce();
				expect(warn.mock.calls[0]?.[0]).toContain('unknown unit');
			} finally {
				warn.mockRestore();
			}
		}
	);

	it('never leaks the shared facade map through an inherited key', () => {
		// A bare lookup resolved Object.prototype.valueOf and invoked it, returning the private
		// facade singleton typed as number[] -- one delete on it would have broken every chart in
		// the process. The own-property check turns it into the same refusal any unknown unit gets.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(incrsByUnit('valueOf' as IncrsByUnitKind)).toStrictEqual([]);
		} finally {
			warn.mockRestore();
		}
	});
});

describe('incrsStep', () => {
	it('scales the default whole-number ladder by step', () => {
		const values = incrsStep(900);
		expect(values).toContain(900); // 900 * 1
		expect(values).toContain(1800); // 900 * 2
		expect(values).toContain(4500); // 900 * 5
		expect(values).toContain(9000); // 900 * 10
		expect(values).toContain(22500); // 900 * 25
	});

	it('does not offer a value that is not a multiple of step', () => {
		expect(incrsStep(900)).not.toContain(1350); // 900 * 1.5
	});

	it('emits exact multiples for a fractional step, not raw float products', () => {
		// 25 * 1.1 is 27.500000000000004 in float64. uPlot steps its splits by the increment and
		// derives the label's decimal count from it, so the dirt surfaces verbatim through any
		// custom axis.values formatter (`${v}s`) -- the byte/duration case this module exists for.
		expect(incrsStep(1.1).slice(0, 8)).toStrictEqual([1.1, 2.2, 5.5, 11, 22, 27.5, 55, 110]);
		expect(incrsStep(2.3).slice(0, 8)).toStrictEqual([2.3, 4.6, 11.5, 23, 46, 57.5, 115, 230]);
	});

	it('keeps the product exact when the mults carry decimals too', () => {
		// The decimal budget is step's places plus the mult's own, not just step's.
		expect(incrsStep(1.1, { mults: [1, 2.5, 25] })).toStrictEqual([1.1, 2.75, 27.5]);
	});

	describe('a step with more decimals than a double carries', () => {
		// roundDec's (1 + EPSILON) nudge is relative, so once |value * 10 ** decimals| passes 2^51 it
		// exceeds half a unit and the rounding degenerates into unconditional round-away-from-zero.
		// A step that is not a short decimal claims 16-17 places and lands squarely in that band,
		// where the cleanup dirties exact values instead of recovering approximate ones.
		it('leaves an already-exact product alone instead of pushing it off', () => {
			// (1 - 0.3) / 7 is 0.09999999999999999, which fractionDigits reads as 17 places. Its 25x
			// product is the clean double 2.5 -- rounding to 17 places returned 2.5000000000000004,
			// the exact class of value this module exists to keep out of a tick label.
			const values = incrsStep((1.0 - 0.3) / 7, { mults: [1, 2, 5, 10, 25] });
			expect(values).toContain(2.5);
			expect(values).not.toContain(2.5000000000000004);
		});

		it('gives back step itself on the 1x rung', () => {
			// "Exact multiples of a fixed step" has to mean this one at minimum, and it was the rung
			// the rounding broke first: incrsStep(1/3)[0] came back as 0.3333333333333334.
			for (const step of [1 / 3, (1.0 - 0.3) / 7, 0.1 + 0.2, 2 / 7]) {
				expect(incrsStep(step)).toContain(step);
			}
		});

		it('still cleans a step that does name a real decimal', () => {
			// The guard is on the decimal budget, not on "is this awkward" -- 1.1 and 2.3 claim one
			// place each and keep the cleanup that makes 25 * 1.1 come back as 27.5.
			expect(incrsStep(1.1).slice(0, 8)).toStrictEqual([1.1, 2.2, 5.5, 11, 22, 27.5, 55, 110]);
		});
	});

	it('handles a step small enough that String() writes it in exponential form', () => {
		expect(incrsStep(1e-7).slice(0, 5)).toStrictEqual([1e-7, 2e-7, 5e-7, 1e-6, 2e-6]);
	});

	it('returns a sorted, duplicate-free ladder', () => {
		const values = incrsStep(7);
		expect(values.length).toBe(new Set(values).size);
		values.reduce((previous, current) => {
			expect(current).toBeGreaterThan(previous);
			return current;
		});
	});

	it('uses custom mults scaled by step', () => {
		expect(incrsStep(900, { mults: [1, 4, 16, 96] })).toStrictEqual([900, 3600, 14400, 86400]);
	});

	it('sorts out-of-order mults rather than handing uPlot an unsearchable ladder', () => {
		// findIncr binary-searches axis.incrs and then only walks forward, so [5, 2, 1] used to make
		// the two smaller rungs unreachable. Sorting is announced by the shared `incrs` warn-once
		// tracker, which is module-scoped -- another test may already have spent that message, so
		// this asserts the repair, not the warning.
		expect(incrsStep(900, { mults: [5, 2, 1] })).toStrictEqual([900, 1800, 4500]);
	});

	it('applies IncrsOptions on top of the scaled ladder', () => {
		const values = incrsStep(900, { minIncr: 1800, maxIncr: 9000 });
		expect(Math.min(...values)).toBe(1800);
		expect(Math.max(...values)).toBe(9000);
	});

	it('returns a fresh array on every call', () => {
		expect(incrsStep(900)).not.toBe(incrsStep(900));
	});

	it('warns and yields nothing for a step that is not finite and positive', () => {
		// The same answer splitsForStep gives its own unusable step: `step` has no default to fall
		// back to, and a ladder of zeroes or NaNs reaches uPlot looking like a real one.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(incrsStep(0)).toStrictEqual([]);
			expect(incrsStep(-900)).toStrictEqual([]);
			expect(incrsStep(NaN)).toStrictEqual([]);
			expect(incrsStep(Infinity)).toStrictEqual([]);
			expect(warn).toHaveBeenCalledTimes(4);
			expect(warn.mock.calls[0]?.[0]).toContain('step must be a finite number greater than zero');
		} finally {
			warn.mockRestore();
		}
	});

	it('drops mults whose product with step is not a usable increment, and says so', () => {
		// findIncr divides by the increment, so a 0 rung is dead weight and a non-finite one poisons
		// the comparison -- the same filter incrsLadder applies to its own rungs.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(incrsStep(900, { mults: [0, 1, NaN, 2, 1e308] })).toStrictEqual([900, 1800]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.[0]).toContain('dropped 3 of 5 mults');
		} finally {
			warn.mockRestore();
		}
	});
});
