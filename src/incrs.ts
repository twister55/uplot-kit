// Nice increment ladders for uPlot `axis.incrs`: a low-level generator (incrsLadder), a set of
// built-in ladders exposed through per-unit incrsFor* facades and the runtime incrsByUnit
// dispatcher, and incrsStep for fixed-bucket multiples. Only the facades, the dispatcher,
// incrsStep, and incrsLadder are exported from the package barrel; the ladders and the option
// filter below are private to this module.

import { fractionDigits, isPositiveFinite, makeWarnOnce, optionOr, roundDec } from './utils';

// One warn-once tracker per entry point, matching the source names splits reports under. These sit
// at module scope rather than inside a factory because — unlike a splits generator, which closes
// over its options once — every function here is called afresh per axis, so a per-call tracker
// would warn on every redraw. The trade is that two charts making the same mistake are told once
// between them, which is the right economy for a console message naming a config error.
//
// The `/* @__PURE__ */` annotations are the same load-bearing kind as the ladders below: a bare
// top-level call is a side effect a bundler must keep, which would pin this module (and with it
// every ladder) into a bundle that imports nothing from it.
const warnLadder = /* @__PURE__ */ makeWarnOnce('incrsLadder');
const warnByUnit = /* @__PURE__ */ makeWarnOnce('incrsByUnit');
const warnStep = /* @__PURE__ */ makeWarnOnce('incrsStep');
// The min/maxIncr filter is shared by all eleven entry points, so its warnings are sourced to the
// module rather than to whichever facade happened to be called.
const warnOptions = /* @__PURE__ */ makeWarnOnce('incrs');

// --- Engine: incrsLadder ---

// Float hygiene comes from the shared `roundDec`/`fractionDigits` in ./utils, which mirror uPlot's
// own internal `genIncrs`/`roundDec`. Without that rounding, ladders collect values like
// 2.5000000000000004e-7, and uPlot derives a tick label's decimal-place count from the increment
// itself — a dirty increment produces a dirty label.

// Decimal places one negative power of `base` needs to stay exact, or null when `base` has a prime
// factor other than 2 or 5 (3, 7, 60, ...) and its negative powers have no finite decimal form at
// all. Only 2^a * 5^b bases divide a power of ten, so only they can be cleaned up by rounding to a
// decimal place count: 2^-n needs n places, 4^-n needs 2n, 1024^-n needs 10n. Rounding any other
// base to |exp| places (what uPlot's own generator does, since it only ever runs on bases 2 and 10)
// truncates the magnitude instead — 16^-3 collapses to 0 — so those bases skip rounding entirely
// and keep the raw float product, which is already the closest representable value.
function decsPerNegExp(base: number): number | null {
	if (!Number.isInteger(base) || base < 1) {
		return null;
	}
	let rest = base;
	let twos = 0;
	let fives = 0;
	while (rest % 2 === 0) {
		rest /= 2;
		twos++;
	}
	while (rest % 5 === 0) {
		rest /= 5;
		fives++;
	}
	return rest === 1 ? Math.max(twos, fives) : null;
}

/**
 * Generates a "nice" increment ladder as `mantissa * base^exp` for every exponent in
 * `[minExp, maxExp]` and every mantissa in `mantissas`, with the same float-precision
 * cleanup uPlot's own (internal, unexported) increment generator uses — so results are
 * exact round numbers (2.5, not 2.5000000000000004) instead of raw floating-point products.
 *
 * This is the low-level engine behind this package's built-in increment ladders
 * ({@link incrsForBytes}, {@link incrsForSeconds}, etc.) — reach for it directly only when
 * building a custom ladder those don't cover.
 *
 * @param base The exponent base — `10` for decimal ladders, `2` for binary (byte-multiple)
 *   ladders, etc. Must be a finite positive number.
 * @param minExp Smallest exponent, inclusive. Must be an integer.
 * @param maxExp Largest exponent, inclusive (unlike uPlot's own internal generator, where the
 *   upper bound is exclusive). Must be an integer; a `maxExp` below `minExp` yields an empty
 *   ladder.
 * @param mantissas Multipliers applied at every exponent, e.g. `[1, 2, 5]` for a strict
 *   1-2-5 ladder or `[1, 2, 2.5, 5]` to also land on quarter-decade steps. Must all be finite.
 * @returns A flat, ascending array of `mantissa * base^exp` values, ordered by exponent then
 *   by the order `mantissas` were given in. Not deduplicated — callers whose `mantissas`
 *   can coincide across exponents (rare) should dedupe themselves. Exponents that overflow to
 *   `Infinity` or underflow to `0` are dropped, since neither is usable as an axis increment.
 *
 *   Values are exact round decimals when `base` is a product of 2s and 5s (2, 4, 5, 8, 10, 1024,
 *   ...) — the ladders this package ships all are. Two limits are worth knowing before relying on
 *   bit-exactness: any other base (3, 60, ...) has no finite decimal form at negative exponents,
 *   so its rungs are the nearest representable float rather than an exact decimal; and the
 *   rounding, which is uPlot's own, drifts a few ulps for binary magnitudes below 2^-21 (`2 ** -22`
 *   comes back as `2.384185791015627e-7`). The drift is deliberately preserved rather than fixed:
 *   uPlot pre-registers `genIncrs(2, -53, 53, [1])` in the internal `fixedDec` map it looks tick
 *   decimals up in, so a "more correct" value here would simply miss that map.
 *   An argument outside the ranges above warns once on the console and yields an empty ladder,
 *   rather than throwing: unvalidated, `maxExp: Infinity` spins forever and a `NaN` argument
 *   silently poisons every rung, but neither has an honest substitute to fall back to, and a
 *   config-driven mistake should not take the whole chart down with it. Note that an empty
 *   `axis.incrs` leaves uPlot's `findIncr` with no increment to pick, so that axis renders no
 *   ticks — the console warning is what points at the cause.
 * @example
 * ```ts
 * import { incrsLadder } from 'uplot-kit';
 *
 * // Decimal SI-style ladder in bits: 1, 2, 5, 10, 20, 50, 100, ...
 * const bitIncrs = incrsLadder(10, 0, 32, [1, 2, 5]);
 * ```
 */
export function incrsLadder(
	base: number,
	minExp: number,
	maxExp: number,
	mantissas: number[]
): number[] {
	// None of these has a documented default to fall back to — a ladder with no base is not a
	// ladder — so this is the other half of the package's option policy (see optionOr in ./utils):
	// name the bad argument, say it once, and produce the inert result rather than guess. Nothing
	// here throws, so one bad value in a chart config costs an axis its ticks, not the page.
	if (!isPositiveFinite(base)) {
		warnLadder(`base must be a finite positive number, got ${base} — no increments`);
		return [];
	}
	if (!Number.isInteger(minExp) || !Number.isInteger(maxExp)) {
		warnLadder(`minExp and maxExp must be integers, got ${minExp} and ${maxExp} — no increments`);
		return [];
	}
	const badMantissa = mantissas.find((mantissa) => !Number.isFinite(mantissa));
	if (badMantissa !== undefined) {
		warnLadder(`mantissas must be finite numbers, got ${badMantissa} — no increments`);
		return [];
	}

	const incrs: number[] = [];
	const mantissaDecs = mantissas.map(fractionDigits);
	// String() switches to exponential notation outside [1e-6, 1e21), which the base-10
	// string-concatenation path below cannot splice a second exponent into ('1e-7' + 'e-3').
	const isPlainNotation = mantissas.map((mantissa) => !String(mantissa).includes('e'));
	const negExpDecs = decsPerNegExp(base);

	for (let exp = minExp; exp <= maxExp; exp++) {
		// Decimal places the magnitude needs: none for a non-negative exponent (an integer base
		// raised to one is whole), |exp| per-exponent places for a negative one. null means this
		// base has no exact decimal form to round onto (see decsPerNegExp) — then nothing in this
		// iteration is rounded, and the raw products stand.
		const magnitudeDec = negExpDecs === null ? null : Math.max(0, -exp) * negExpDecs;
		const magnitude = magnitudeDec === null ? base ** exp : roundDec(base ** exp, magnitudeDec);

		for (const [i, mantissa] of mantissas.entries()) {
			const mantissaDec = mantissaDecs[i] ?? 0;
			if (base === 10 && isPlainNotation[i]) {
				// Exact decimal literal via string concatenation: Number('2.5e-7') parses to the
				// float nearest that decimal number directly, whereas 2.5 * 10 ** -7 accumulates
				// two separate roundings (the power, then the product).
				incrs.push(Number(`${mantissa}e${exp}`));
			} else if (magnitudeDec === null) {
				incrs.push(mantissa * magnitude);
			} else {
				// The exact product has at most (magnitude's places + mantissa's own places)
				// decimals — 2.5 * 2^-3 is 0.3125, four places — so rounding there only sheds
				// float noise.
				incrs.push(roundDec(mantissa * magnitude, magnitudeDec + mantissaDec));
			}
		}
	}

	// An increment of 0 or ±Infinity is never usable: uPlot's findIncr divides by the increment to
	// derive tick spacing, so a 0 rung can never satisfy its minimum-space test (dead weight
	// pushing the axis toward its no-ticks path) and a non-finite one poisons the comparison
	// outright. Exponents far enough out to saturate float64 drop here instead of shipping.
	return incrs.filter((incr) => Number.isFinite(incr) && incr !== 0);
}

// --- Ladders (private to this module) ---

// Every ladder below is built at module scope so the 9 incrsFor* facades below can stay cheap
// wrappers (ladder lookup + optional min/maxIncr filter). The `/* @__PURE__ */` annotations are
// load-bearing, not decorative: without them a bundler must conservatively assume
// incrsLadder()/`.filter()` calls could have side effects, and keeps every ladder (bytes, bits,
// integers, ...) in the bundle even when a consumer only imports e.g. incrsForSeconds.
//
// Every non-trivial derivation is wrapped in its own top-level `buildXxx()` function, called
// once with a leading `/* @__PURE__ */` — verified empirically (esbuild --bundle
// --tree-shaking=true, two-pass: build this package, then bundle a consumer that imports a
// single unrelated export) to be the one pattern that reliably sheds unused ladders. Two
// patterns that look equally safe do NOT get pruned even when annotated and provably
// side-effect-free: an array literal spreading other identifiers (`[...a, ...b]` — evaluating a
// spread isn't treated as inherently pure, unlike a spread-free literal) and a member-call chain
// whose argument is a bare builtin reference (`x.filter(Number.isInteger)`, unlike
// `x.filter((v) => ...)`). A single wrapped function call sidesteps both.

/** Power-of-two increments for values measured in bytes (1 byte to 2^50). */
const BYTE_INCRS: readonly number[] = /* @__PURE__ */ incrsLadder(2, 0, 50, [1]);

/** Power-of-two increments for values measured in kilobytes, resolving down to 1 byte. */
const KILOBYTE_INCRS: readonly number[] = /* @__PURE__ */ incrsLadder(2, -10, 50, [1]);

/** Power-of-two increments for values measured in megabytes, resolving down to 1 byte. */
const MEGABYTE_INCRS: readonly number[] = /* @__PURE__ */ incrsLadder(2, -20, 50, [1]);

// uPlot's own default numeric ladder mixes in a 2.5 mantissa (…, 2, 2.5, 5, …), which produces
// fractional ticks like 2.5 or 0.5 on an axis that only ever holds whole numbers. uPlot has an
// internal `wholeIncrs` that filters exactly this out, but only applies it to ordinal scales
// (distr: 2) and doesn't export it — this mirrors that filter for general use.
function buildIntegerIncrs(): number[] {
	return incrsLadder(10, 0, 32, [1, 2, 2.5, 5]).filter(Number.isInteger);
}

/** Whole-number increments (1, 2, 5, 10, 20, 25, 50, ...) for count-based axes. */
const INTEGER_INCRS: readonly number[] = /* @__PURE__ */ buildIntegerIncrs();

// Network throughput is conventionally measured in bits with SI (decimal) multiples, not the
// binary powers of two the byte ladders above use — and unlike the integer ladder, a 25 mantissa
// (25 kbit, 25 Mbit) is a normal round value here, so this keeps mantissa 5 but not the 2.5/25
// quarter-decade step (kept out for the same reason as the integer ladder: it isn't a round bit
// count until scaled up, and bit axes skew toward wanting fewer, rounder candidates).

/** Decimal (SI) increments in bits — 1-2-5 per decade, from 1 bit up. */
const BIT_INCRS: readonly number[] = /* @__PURE__ */ incrsLadder(10, 0, 32, [1, 2, 5]);

// Sub-second steps run in decade mantissas (1/2/5 x 10^exp) down to 1e-9s (1ns) so the finest
// available increment covers the native resolution of the smallest supported unit. Without steps
// this fine, a chart in microsecond/nanosecond units whose values don't span a full millisecond
// has no small-enough increment to tick on, and uPlot renders no Y axis at all.
const SUB_SECOND_EXP_MIN = -9;
const SUB_SECOND_EXP_MAX = -1;

// Whole seconds and up: real (sexagesimal) calendar steps through a week, then approximate
// calendar steps (30-day months, 365-day years) out to a century so a duration axis spanning
// months or years still has something to tick on — findIncr() returns no increment at all once
// the visible range exceeds every entry in the ladder, and the axis silently stops rendering.
// These are approximations (a "month" here is always 30 days); exact calendar boundaries are
// what `timeSplits` is for, not this ladder. A plain literal, unlike the derived ladders around
// it — safe to leave unwrapped, and confirmed pruned correctly on its own when unreferenced.
const WHOLE_SECOND_INCRS: number[] = [
	1,
	2,
	5,
	10,
	15,
	30, // seconds
	60,
	120,
	300,
	600,
	900,
	1800, // minutes
	3600,
	7200,
	10800,
	21600,
	43200, // hours
	86400,
	172800,
	604800, // day / week
	1209600,
	2592000,
	7776000,
	15552000, // 14d, 30d, 90d, 180d
	31536000,
	63072000,
	157680000,
	315360000,
	630720000,
	1576800000,
	3153600000 // 1y..100y
];

// Regenerates the sub-second portion for a given native unit via an exponent shift (e.g. +3 to
// go from seconds to milliseconds) instead of multiplying the seconds-native values by 1e3/1e6/1e9:
// that multiplication measurably drifts for several entries (1e-9 * 1000 = 0.0000010000000000002,
// not 0.000001), because it compounds two independent float approximations instead of parsing one
// exact decimal literal. The whole-second-and-up ladder above doesn't have this problem — its
// entries are exact integers, and integer * 1e3/1e6/1e9 stays exact in float64 at these
// magnitudes — so only this part needs regenerating per unit.
function subSecondIncrs(exponentShift: number): number[] {
	return incrsLadder(
		10,
		SUB_SECOND_EXP_MIN + exponentShift,
		SUB_SECOND_EXP_MAX + exponentShift,
		[1, 2, 5]
	);
}

function buildSecondIncrs(): number[] {
	return [...subSecondIncrs(0), ...WHOLE_SECOND_INCRS];
}

/** Round time increments, in seconds, from 1ns up to 100 years. */
const SECOND_INCRS: readonly number[] = /* @__PURE__ */ buildSecondIncrs();

function buildMillisecondIncrs(): number[] {
	return [...subSecondIncrs(3), ...WHOLE_SECOND_INCRS.map((s) => s * 1e3)];
}

/** Round time increments, in milliseconds, from 1ns up to 100 years. */
const MILLISECOND_INCRS: readonly number[] = /* @__PURE__ */ buildMillisecondIncrs();

function buildMicrosecondIncrs(): number[] {
	return [...subSecondIncrs(6), ...WHOLE_SECOND_INCRS.map((s) => s * 1e6)];
}

/** Round time increments, in microseconds, from 1ns up to 100 years. */
const MICROSECOND_INCRS: readonly number[] = /* @__PURE__ */ buildMicrosecondIncrs();

function buildNanosecondIncrs(): number[] {
	return [...subSecondIncrs(9), ...WHOLE_SECOND_INCRS.map((s) => s * 1e9)];
}

/** Round time increments, in nanoseconds, from 1ns up to 100 years. */
const NANOSECOND_INCRS: readonly number[] = /* @__PURE__ */ buildNanosecondIncrs();

// --- Options + per-unit facades + dispatcher ---

// Shared by every incrsFor* facade (and incrsByUnit, incrsStep) rather than given each its own
// <Facade>Options type, unlike splits.ts's per-generator options — all nine facades take the same
// minIncr/maxIncr shape, so a separate interface per facade would just be nine identical copies.
export interface IncrsOptions {
	/**
	 * Drops every increment below this value, so e.g. an axis for data bucketed no finer than a
	 * minute never offers a sub-minute tick. `NaN` (e.g. from a `Number(userInput)` that didn't
	 * parse) falls back to the default rather than filtering everything out.
	 * @default -Infinity (no floor)
	 */
	minIncr?: number;
	/**
	 * Drops every increment above this value. `NaN` falls back to the default, as with
	 * {@link IncrsOptions.minIncr}.
	 * @default Infinity (no ceiling)
	 */
	maxIncr?: number;
}

// `incr >= NaN` and `incr <= NaN` are both false for every rung, so an unguarded NaN bound wouldn't
// merely be ignored — it would empty the ladder, and an empty axis.incrs makes uPlot's findIncr
// return no increment at all and the axis render no ticks whatsoever. A bound that isn't a number
// therefore reverts to the documented default. `?? ` (not `||`) keeps a deliberate 0 bound.
//
// Routed through the shared optionOr so the fallback is *announced*: this used to be a silent
// swallow, which is the one shape the rest of the package is written against — a
// `Number(userInput)` that didn't parse produced a full, plausible ladder with the caller's bound
// quietly ignored, and nothing said so.
function incrsBound(name: string, value: number | undefined, fallback: number): number {
	const bound = value ?? fallback;
	return optionOr(warnOptions, name, bound, !Number.isNaN(bound), 'a number', fallback);
}

// Always allocates a new array via filter — even when both bounds are left at their defaults —
// so every incrsFor*/incrsByUnit/incrsStep call returns a caller-owned array. Returning the
// shared module-level ladder directly would let one consumer's mutation corrupt every other
// chart's ticks. Private to this module — both the incrsFor* facades and incrsStep run their
// ladders through it.
function applyIncrsOptions(ladder: readonly number[], options: IncrsOptions | undefined): number[] {
	const minIncr = incrsBound('minIncr', options?.minIncr, -Infinity);
	const maxIncr = incrsBound('maxIncr', options?.maxIncr, Infinity);
	return ladder.filter((incr) => incr >= minIncr && incr <= maxIncr);
}

/**
 * Power-of-two increments for a Y axis measured in bytes (1 byte to 2^50), so ticks land on
 * values like 1024 or 1MiB instead of the nearest round-looking decimal number.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForBytes } from 'uplot-kit';
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'bytes sent' }],
 *   axes: [{}, { incrs: incrsForBytes() }]
 * };
 * ```
 */
export function incrsForBytes(options?: IncrsOptions): number[] {
	return applyIncrsOptions(BYTE_INCRS, options);
}

/**
 * Power-of-two increments for a Y axis whose values are already scaled to kilobytes, resolving
 * down to a single byte (2^-10 KB).
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForKilobytes } from 'uplot-kit';
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'payload size (KB)' }],
 *   axes: [{}, { incrs: incrsForKilobytes() }]
 * };
 * ```
 */
export function incrsForKilobytes(options?: IncrsOptions): number[] {
	return applyIncrsOptions(KILOBYTE_INCRS, options);
}

/**
 * Power-of-two increments for a Y axis whose values are already scaled to megabytes, resolving
 * down to a single byte (2^-20 MB).
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForMegabytes } from 'uplot-kit';
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'heap size (MB)' }],
 *   axes: [{}, { incrs: incrsForMegabytes() }]
 * };
 * ```
 */
export function incrsForMegabytes(options?: IncrsOptions): number[] {
	return applyIncrsOptions(MEGABYTE_INCRS, options);
}

/**
 * Decimal (SI) increments in bits — 1-2-5 per decade, not powers of two — for a network-
 * throughput axis, where round values are conventionally decimal (1 kbit, 2 kbit, 5 kbit, ...)
 * rather than binary.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForBits } from 'uplot-kit';
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'bitrate' }],
 *   axes: [{}, { incrs: incrsForBits() }]
 * };
 * ```
 */
export function incrsForBits(options?: IncrsOptions): number[] {
	return applyIncrsOptions(BIT_INCRS, options);
}

/**
 * Whole-number increments (1, 2, 5, 10, 20, 25, 50, ...) for a count-based Y axis (requests,
 * users, errors) that should never tick on a fractional value like 2.5 or 0.5.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForIntegers } from 'uplot-kit';
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'error count' }],
 *   axes: [{}, { incrs: incrsForIntegers() }]
 * };
 * ```
 */
export function incrsForIntegers(options?: IncrsOptions): number[] {
	return applyIncrsOptions(INTEGER_INCRS, options);
}

/**
 * Round time increments, in seconds, from 1ns up to 100 years, so tick values land on boundaries
 * like 5m/15m/1h/1d rather than uPlot's generic decimal default.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForSeconds } from 'uplot-kit';
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'request duration (s)' }],
 *   axes: [{}, { incrs: incrsForSeconds() }]
 * };
 * ```
 */
export function incrsForSeconds(options?: IncrsOptions): number[] {
	return applyIncrsOptions(SECOND_INCRS, options);
}

/**
 * Round time increments, in milliseconds, from 1ns up to 100 years — the same ladder as
 * {@link incrsForSeconds}, scaled to a millisecond-native value.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForMilliseconds } from 'uplot-kit';
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'request duration (ms)' }],
 *   axes: [{}, { incrs: incrsForMilliseconds() }]
 * };
 * ```
 */
export function incrsForMilliseconds(options?: IncrsOptions): number[] {
	return applyIncrsOptions(MILLISECOND_INCRS, options);
}

/**
 * Round time increments, in microseconds, from 1ns up to 100 years — the same ladder as
 * {@link incrsForSeconds}, scaled to a microsecond-native value.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForMicroseconds } from 'uplot-kit';
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'query duration (µs)' }],
 *   axes: [{}, { incrs: incrsForMicroseconds() }]
 * };
 * ```
 */
export function incrsForMicroseconds(options?: IncrsOptions): number[] {
	return applyIncrsOptions(MICROSECOND_INCRS, options);
}

/**
 * Round time increments, in nanoseconds, from 1ns up to 100 years — the same ladder as
 * {@link incrsForSeconds}, scaled to a nanosecond-native value.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForNanoseconds } from 'uplot-kit';
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'syscall duration (ns)' }],
 *   axes: [{}, { incrs: incrsForNanoseconds() }]
 * };
 * ```
 */
export function incrsForNanoseconds(options?: IncrsOptions): number[] {
	return applyIncrsOptions(NANOSECOND_INCRS, options);
}

/** A named family of round increments recognised by {@link incrsByUnit}. */
export type IncrsByUnitKind =
	| 'byte'
	| 'kilobyte'
	| 'megabyte'
	| 'bit'
	| 'integer'
	| 'second'
	| 'millisecond'
	| 'microsecond'
	| 'nanosecond';

const INCRS_FACADES: Record<IncrsByUnitKind, (options?: IncrsOptions) => number[]> = {
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

/**
 * Returns a "nice" (round-looking) increment ladder for a uPlot `axis.incrs` option, so tick
 * values land on human-friendly boundaries (e.g. 15m/1h instead of 16.67m, or 1KB instead of
 * 1023 bytes) rather than uPlot's generic decimal default.
 *
 * This is a dispatcher over the package's `incrsFor*` functions (`incrsForBytes`,
 * `incrsForSeconds`, ...), for the common case where the unit is only known at runtime (e.g. it
 * comes from a chart config or the data itself). When the unit is known statically, call the
 * matching `incrsFor*` function directly instead — it tree-shakes independently of the others,
 * where a call to `incrsByUnit` keeps every built-in ladder reachable in the bundle.
 *
 * @param kind Either one of the built-in families (`'byte'`, `'kilobyte'`, `'megabyte'`,
 *   `'bit'`, `'integer'`, `'second'`, `'millisecond'`, `'microsecond'`, `'nanosecond'`), or a
 *   custom ascending, duplicate-free array of increments.
 * @param options Applied to both built-in and custom ladders alike.
 * @returns The named family's ladder, or an empty array for a `kind` that names no built-in
 *   family — warned about once on the console rather than thrown, since this is precisely the
 *   entry point whose argument arrives unvalidated from a chart config, and a typo there should
 *   not take the page down. An empty `axis.incrs` leaves that axis with no ticks, so the warning
 *   is what points at the typo.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsByUnit } from 'uplot-kit';
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'bytes sent' }],
 *   axes: [{}, { incrs: incrsByUnit('byte') }]
 * };
 * ```
 */
export function incrsByUnit(kind: IncrsByUnitKind | number[], options?: IncrsOptions): number[] {
	if (Array.isArray(kind)) {
		return applyIncrsOptions(kind, options);
	}
	// An own-property check, not a bare lookup: this is the one function in the module built to
	// take a string that is only known at runtime, so `kind` may well be unvalidated. A bare lookup
	// resolves inherited Object.prototype members too — incrsByUnit('valueOf') would call
	// Object.prototype.valueOf on the facade map and hand the caller the shared, mutable singleton
	// itself (typed as number[]), from which a single delete breaks every chart in the process.
	if (!Object.hasOwn(INCRS_FACADES, kind)) {
		const known = Object.keys(INCRS_FACADES).join(', ');
		warnByUnit(
			`unknown unit ${JSON.stringify(kind)} — expected one of ${known}, or an array of ` +
				'increments; no increments'
		);
		return [];
	}
	return INCRS_FACADES[kind](options);
}

// --- incrsStep ---

export interface IncrsStepOptions extends IncrsOptions {
	/**
	 * Whole multiples of `step` to offer as increments, in ascending order.
	 * @default The built-in whole-number ladder (1, 2, 5, 10, 20, 25, 50, ...) — see
	 *   {@link incrsForIntegers}.
	 */
	mults?: number[];
}

/**
 * Increments that are exact multiples of a fixed step, for ticking strictly on bucket
 * boundaries when the bucket size doesn't divide evenly into the round wall-clock/byte values
 * {@link incrsForSeconds} or {@link incrsForBytes} offer — e.g. 15-minute candles snapped to a
 * session that doesn't start on the hour, or a 7-minute polling interval. For a bucket size that
 * *is* already a round wall-clock unit (a whole minute, hour, day, ...), prefer
 * `incrsForSeconds({ minIncr: step })` instead — it still ticks on calendar-round values, just
 * never finer than `step`.
 *
 * @param step The fixed step every increment is a multiple of, e.g. `900` for 15-minute
 *   buckets expressed in seconds. Required and has no default — a bucket ladder with no bucket
 *   size is not a ladder — so a value that is not finite and above zero warns once and yields no
 *   increments, the same answer `splitsForStep` gives an unusable `step`.
 * @returns The `mults` scaled by `step`, in the order given, with any product that is not a usable
 *   increment (`0`, or one that overflowed to `Infinity`) dropped and reported once — the same
 *   filter {@link incrsLadder} applies to its own rungs, since uPlot's `findIncr` divides by the
 *   increment.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsStep } from 'uplot-kit';
 *
 * // Ticks only on 15-minute-candle boundaries: 900s, 1800s, 4500s, 9000s, ...
 * const candleIncrs = incrsStep(900);
 *
 * // Non-round multiples for an irregular bucket, e.g. a 15-minute candle where the only
 * // sensible wider ticks are 1h/4h/1d/1w boundaries (4, 16, 96, 672 buckets).
 * const sessionIncrs = incrsStep(900, { mults: [1, 4, 16, 96, 672] });
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'close' }],
 *   axes: [{ incrs: candleIncrs }, {}]
 * };
 * ```
 */
export function incrsStep(step: number, options: IncrsStepOptions = {}): number[] {
	// The one argument here with no default to fall back to, handled exactly as splitsForStep
	// handles its own `step`: an unusable spacing produces nothing, said once, rather than a
	// ladder of zeroes or NaNs that reaches uPlot looking like a real one.
	if (!isPositiveFinite(step)) {
		warnStep(`step must be a finite number greater than zero, got ${step} — no increments`);
		return [];
	}

	const { mults = INTEGER_INCRS, ...incrsOptions } = options;
	const stepDec = fractionDigits(step);
	// Rounded like every other ladder in this module, not the raw product: 25 * 1.1 is
	// 27.500000000000004, and uPlot both derives a label's decimal count from the increment
	// and steps splits by it, so a dirty increment prints verbatim through any custom
	// axis.values (the byte/duration formatters this package exists for). The exact product
	// has at most (step's decimals + mult's decimals) places, so this only sheds float noise.
	const scaled = mults.map((mult) => roundDec(mult * step, stepDec + fractionDigits(mult)));
	// The same final filter incrsLadder applies to its own rungs, for the same reason: findIncr
	// divides by the increment, so a 0 rung can never satisfy its minimum-space test and a
	// non-finite one poisons the comparison. Unlike incrsLadder's, these come straight from a
	// caller's `mults` rather than from an exponent that saturated, so the drop is reported.
	const usable = scaled.filter((incr) => Number.isFinite(incr) && incr !== 0);
	if (usable.length < scaled.length) {
		warnStep(
			`dropped ${scaled.length - usable.length} of ${scaled.length} mults whose product with ` +
				'step is zero or not finite — those are not usable as increments'
		);
	}
	return applyIncrsOptions(usable, incrsOptions);
}
