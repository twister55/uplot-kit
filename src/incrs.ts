// Nice increment ladders for uPlot `axis.incrs`: a low-level generator (incrsLadder), a set of
// built-in ladders exposed through per-unit incrsFor* facades and the runtime incrsByUnit
// dispatcher, and incrsStep for fixed-bucket multiples. Only the facades, the dispatcher,
// incrsStep, and incrsLadder are exported from the package barrel; the ladders and the option
// filter below are private to this module.

import {
	describeValue,
	fractionDigits,
	isPositiveFinite,
	makeWarnOnce,
	MAX_EXACT_DECIMALS,
	optionOr,
	roundDec
} from './utils';

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

// Exponents an incrsLadder call may span. Not a tick budget the way splits.ts's cap is — the loop
// itself is the cost here, since a ladder this long is refused rather than walked.
const MAX_LADDER_EXPONENTS = 10_000;

// Below this, String() writes a number in exponential notation ('1e-7', not '0.0000001'), which is
// where uPlot's decimal-count guess breaks down. See isSteppableIncr.
const EXPONENTIAL_NOTATION_FLOOR = 1e-6;

// uPlot's pre-registered decimal counts for increments below EXPONENTIAL_NOTATION_FLOOR, mirrored
// because nothing in uPlot exposes the map to ask. Built on first need: of the ladders below only
// the seconds one reaches under the floor (it bottoms out at 1ns), so the byte, kilobyte, megabyte,
// bit and integer ladders never pay for it.
let uplotSteppableSmallIncrs: Set<number> | null = null;

// Whether uPlot can actually *step* by this increment, which is not the same question as whether it
// can pick it. numAxisSplits advances its loop variable with `roundDec(val + foundIncr, numDec)`,
// where numDec is what uPlot recorded for that increment in its internal fixedDec map. For a static
// `axis.incrs` array it records `guessDec(incr)` — the length of whatever follows the '.' in
// String(incr) — and below 1e-6, where String() switches to exponential notation, that count is
// never the one the value needs: `3e-7` holds no '.' at all and answers 0, while `1.5e-7` answers 4,
// the length of the string "5e-7". Either way `roundDec(val + incr, numDec)` hands back the `val` it
// was given: an unbounded splits.push that locks the browser tab, not a wrong axis.
//
// The escape is that uPlot pre-registers two families at module load whose decimal count comes from
// genIncrs' own arithmetic instead of from guessDec, and those step correctly. Everything else below
// the floor does not, and there is no way to register one from outside the library — so a rung there
// is dropped and the caller is pointed at axis.splits, which has no such limitation.
function isSteppableIncr(incr: number): boolean {
	if (incr >= EXPONENTIAL_NOTATION_FLOOR) {
		return true;
	}
	uplotSteppableSmallIncrs ??= new Set([
		// uPlot.esm.js:988, `decIncrs` — genIncrs(10, -32, 0, [1, 2, 2.5, 5]); exponents above -7
		// land at or above the floor and need no entry.
		...generateLadder(10, -32, -7, [1, 2, 2.5, 5]),
		// uPlot.esm.js:1187 — a bare genIncrs(2, -53, 53, [1]) whose only purpose is this map. 2^-20
		// is the largest power of two under the floor. These are the values incrsLadder deliberately
		// reproduces drift and all (see its @returns), which is what makes them match as Set keys.
		...generateLadder(2, -53, -20, [1])
	]);
	return uplotSteppableSmallIncrs.has(incr);
}

// Drops what isSteppableIncr rejects, naming the values: they are the actionable part, and the
// remedy is a different uPlot option rather than a different argument.
function steppableIncrs(values: number[], warn: (detail: string) => void): number[] {
	const steppable: number[] = [];
	const dropped: number[] = [];
	for (const incr of values) {
		(isSteppableIncr(incr) ? steppable : dropped).push(incr);
	}
	if (dropped.length > 0) {
		const named = dropped.slice(0, 3).join(', ');
		warn(
			`dropped ${dropped.length} increment(s) below ${EXPONENTIAL_NOTATION_FLOOR} that uPlot ` +
				`cannot step by (${named}${dropped.length > 3 ? ', …' : ''}) — it reads their decimal ` +
				'count off an exponential string form, undercounts it, and would loop forever building ' +
				'splits. To tick at that spacing, set axis.splits to splitsForStep({ step }) instead of ' +
				'driving it through axis.incrs'
		);
	}
	return steppable;
}

// Ascending and duplicate-free, the shape uPlot's findIncr() assumes of `axis.incrs` without its
// type saying so: findIncr seeds its search with closestIdx(), a binary search, and from there only
// ever walks *forward*. A rung sitting before that seed in an unsorted ladder is unreachable — a
// [5, 2, 1] ladder picks 50 where 5 was right, and a wholly descending one picks nothing at all —
// and a duplicate is a wasted step of that same walk.
//
// Sorts in place, so callers must pass an array they own (both do: one filters first, the other
// built it). Kept separate from sanitizeIncrs below because this is the silent half — the engine's
// own exponent-major generation order is not a caller mistake to report.
function ascendingUnique(values: number[]): number[] {
	values.sort((a, b) => a - b);
	// `values[-1]` is undefined, which no number equals, so index 0 always survives.
	return values.filter((incr, index) => incr !== values[index - 1]);
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
 * @param minExp Smallest exponent, inclusive. Must be a safe integer.
 * @param maxExp Largest exponent, inclusive (unlike uPlot's own internal generator, where the
 *   upper bound is exclusive). Must be a safe integer, and within 10000 exponents of `minExp`; a
 *   `maxExp` below `minExp` yields an empty ladder.
 * @param mantissas Multipliers applied at every exponent, e.g. `[1, 2, 5]` for a strict
 *   1-2-5 ladder or `[1, 2, 2.5, 5]` to also land on quarter-decade steps. Must all be finite.
 * @returns A flat array of `mantissa * base^exp` values, sorted ascending and deduplicated.
 *   Generation is exponent-major, which interleaves as soon as a mantissa reaches `base` — base 2
 *   with `[1, 2, 5]` produces 5 before the next exponent's 2 — so the result is sorted rather than
 *   handed back in that order: uPlot's `findIncr` binary-searches `axis.incrs` and then only walks
 *   forward, so a rung before that seed would be unreachable. A `mantissas` set that can coincide
 *   across exponents therefore yields fewer rungs than `mantissas.length * exponents`. Values that
 *   are not finite and above zero are dropped — an exponent that overflowed to `Infinity` or
 *   underflowed to `0`, or a negative mantissa — since `findIncr` divides by the increment.
 *
 *   Rungs below 1e-6 are dropped too, unless they are ones uPlot pre-registers (`1`/`2`/`2.5`/`5`
 *   per decade, and powers of two): below that magnitude `String()` writes a number in exponential
 *   notation, uPlot reads its decimal count as 0, and `numAxisSplits` then never advances its loop
 *   variable — an unbounded push that locks the browser tab rather than mis-ticking an axis. So
 *   `[1, 3]` at exponent -7 keeps `1e-7` and drops `3e-7`, saying so once. To tick at a spacing
 *   uPlot cannot step by, drive `axis.splits` with {@link splitsForStep} instead of `axis.incrs`.
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
 *   rather than throwing: unvalidated, an exponent bound that is `Infinity`, at or above `2 ** 53`
 *   (where `exp++` is a no-op), or merely very far from its partner hangs the UI thread, and a
 *   `NaN` argument silently poisons every rung — but none has an honest substitute to fall back to,
 *   and a
 *   config-driven mistake should not take the whole chart down with it. Note that an empty
 *   `axis.incrs` leaves uPlot's `findIncr` with no increment to pick, so that axis renders no
 *   ticks — the console warning is what points at the cause.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsLadder } from 'uplot-kit';
 *
 * // Quarter-decade ladder: 1, 2.5, 5, 10, 25, 50, 100, ... — the denominations money is
 * // counted in, and a mantissa set none of the incrsFor* facades ships. Spanning cents to
 * // trillions rather than only the decades this data needs: uPlot picks an increment from
 * // `axis.incrs` and nowhere else, so a value past the top rung leaves `findIncr` nothing to
 * // return and that axis draws no ticks and no gridlines, silently. Size a ladder to the
 * // widest value the axis could ever hold, not to the sample in front of you.
 * const priceIncrs = incrsLadder(10, -2, 12, [1, 2.5, 5]);
 *
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [30, 190, 95]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'price ($)' }],
 *   // ticks every $25 — uPlot's own ladder would pick $20 here
 *   axes: [{}, { incrs: priceIncrs }]
 * };
 *
 * new uPlot(opts, data, document.body);
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
	// Safe integers, not merely integers: Number.isInteger admits 2 ** 53 and every magnitude above
	// it, where `exp++` rounds straight back to the value it started from and the loop below cannot
	// terminate at all — a request for five rungs spins until the heap dies, on the UI thread. The
	// Infinity case the sentence in @returns describes is only the loud half of that.
	if (!Number.isSafeInteger(minExp) || !Number.isSafeInteger(maxExp)) {
		warnLadder(
			`minExp and maxExp must be safe integers, got ${minExp} and ${maxExp} — no increments`
		);
		return [];
	}
	// A span the loop *can* finish is still not one anyone can wait for, so it is bounded on the same
	// rule splits.ts applies to a too-dense tick grid: refuse outright rather than spend the frame
	// producing something unusable. Base 2 needs 2098 exponents to cover every magnitude a double can
	// represent, and every larger base needs fewer, so this only bites a base so close to 1 that the
	// ladder would be thousands of near-identical rungs — which findIncr walks linearly.
	if (maxExp - minExp >= MAX_LADDER_EXPONENTS) {
		warnLadder(
			`minExp and maxExp span more than ${MAX_LADDER_EXPONENTS} exponents ` +
				`(${minExp} to ${maxExp}) — use a base further from 1, or a narrower range`
		);
		return [];
	}
	// findIndex, not find: `find` reports "nothing matched" with the same `undefined` that a bad
	// mantissa *is*, so an undefined element — or an array hole, which reads as one — matched the
	// predicate and was then read back as clean. It got no warning and no refusal; downstream the
	// rung evaluated to NaN and was filtered away, leaving a ladder silently missing a step, which
	// is exactly the shape this guard exists to refuse. Untyped JS is where both arrive from.
	const badIndex = mantissas.findIndex((mantissa) => !Number.isFinite(mantissa));
	if (badIndex !== -1) {
		warnLadder(
			`mantissas must be finite numbers, got ${describeValue(mantissas[badIndex])} ` +
				`at index ${badIndex} — no increments`
		);
		return [];
	}

	return ascendingUnique(
		steppableIncrs(
			generateLadder(base, minExp, maxExp, mantissas).filter(isPositiveFinite),
			warnLadder
		)
	);
}

// The raw `mantissa * base^exp` sweep, with none of incrsLadder's argument guards and none of its
// output hygiene. Split out because the safe-increment table in isSteppableIncr is itself built from
// two ladders, and routing those back through incrsLadder would re-enter isSteppableIncr while its
// table is still being built.
function generateLadder(
	base: number,
	minExp: number,
	maxExp: number,
	mantissas: number[]
): number[] {
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

	return incrs;
}

// --- Ladders (private to this module) ---

// Every ladder below is built at module scope so the 12 incrsFor* facades below can stay cheap
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

// The floor is 2^-16 (16 bytes), not the 2^-20 that would spell a single byte — a third thing
// mirrored from uPlot's internals, alongside the two in isSteppableIncr. findIncr refuses any
// increment whose recorded decimal count is longer than the label budget it has left,
// `intDigits + (foundIncr < 5 ? fixedDec.get(foundIncr) : 0) <= 17` (uPlot.esm.js:2885), and uPlot's
// own base-2 registration records `dec = |exp|`. numIntDigits never answers below 1, so a rung at
// 2^-17 or finer fails that test at every zoom level and every scale range there is: findIncr walks
// straight past it to 2^-16, whatever the data. Shipping those four rungs would only lengthen that
// walk, so the ladder stops where uPlot stops being able to use it. Re-check this bound when the
// uplot peer range moves.
/** Power-of-two increments for values measured in megabytes, resolving down to 16 bytes. */
const MEGABYTE_INCRS: readonly number[] = /* @__PURE__ */ incrsLadder(2, -16, 50, [1]);

// Identical to MEGABYTE_INCRS, and by the same rule rather than by coincidence: the label budget
// above caps a base-2 rung at 2^-16 whatever unit the axis is scaled to, and every ladder from
// megabytes up hits that cap before it reaches the rung that would spell a single byte (2^-20 in
// megabytes, 2^-40 in terabytes, 2^-50 in petabytes). So these alias that ladder instead of
// rebuilding it — one uPlot constant sets every one of those floors, and a fresh
// `incrsLadder(2, -16, ...)` per unit would be one more place to keep in step if it ever moves.
// The arrays coincide; the units they are read in do not, which is the whole of what the facades
// add. That also marks where the family ends: a unit above petabytes would be a fourth alias of
// the same numbers, and callers who need one can spell it `incrsLadder(2, -16, 50, [1])`.
/** Power-of-two increments for values measured in gigabytes, resolving down to 16 KiB. */
const GIGABYTE_INCRS: readonly number[] = MEGABYTE_INCRS;

/** Power-of-two increments for values measured in terabytes, resolving down to 16 MiB. */
const TERABYTE_INCRS: readonly number[] = MEGABYTE_INCRS;

/** Power-of-two increments for values measured in petabytes, resolving down to 16 GiB. */
const PETABYTE_INCRS: readonly number[] = MEGABYTE_INCRS;

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
// <Facade>Options type, unlike splits.ts's per-generator options — all twelve facades take the
// same minIncr/maxIncr shape, so a separate interface per facade would just be twelve identical
// copies.
/**
 * Bounds on which rungs of a ladder an axis may pick, accepted by every `incrsFor*` facade, by
 * {@link incrsByUnit} and by {@link incrsStep}.
 *
 * Note the asymmetry, which is why only the floor changes the picture below: uPlot picks the
 * *smallest* rung that leaves room for a label, so raising the floor coarsens ticks that were
 * too fine, while lowering the ceiling can never coarsen anything — it only takes rungs away,
 * and taking away every rung that fits blanks the axis outright.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForSeconds } from 'uplot-kit';
 *
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [0, 240, 120]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'job duration (s)' }],
 *   // These durations are bucketed per minute, so a sub-minute tick would promise precision
 *   // the data has not got: the floor gives 0, 60, 120, 180, 240 where the bare ladder picks
 *   // 30s. The ceiling is a guard for the ranges this axis may hold later, not for this one —
 *   // it drops the day/week/year rungs, and nothing here reaches them.
 *   axes: [{}, { incrs: incrsForSeconds({ minIncr: 60, maxIncr: 3600 }) }]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export interface IncrsOptions {
	/**
	 * Drops every increment below this value, so e.g. an axis for data bucketed no finer than a
	 * minute never offers a sub-minute tick. `NaN` (e.g. from a `Number(userInput)` that didn't
	 * parse) falls back to the default rather than filtering everything out.
	 *
	 * A bound pair that admits nothing — a floor above the top of the ladder, or above `maxIncr` —
	 * yields an empty array, which uPlot does *not* read as "use the default ladder": that axis
	 * renders no ticks and no gridlines while still reserving its gutter. It is warned about once.
	 * @default -Infinity (no floor)
	 */
	minIncr?: number;
	/**
	 * Drops every increment above this value. `NaN` falls back to the default, and a pair admitting
	 * nothing blanks the axis, both as with {@link IncrsOptions.minIncr}.
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

// The reporting half of ascendingUnique, for a ladder that did not come from incrsLadder: the array
// branch of incrsByUnit takes one straight from a chart config, and incrsStep scales one from a
// caller's `mults`. Neither is checked by anything else, and every way of getting it wrong fails as
// a mis-ticked or blank axis rather than as an error, so the fix is announced under the package's
// usual policy — name it, say it once, carry on with the repaired value.
function sanitizeIncrs(ladder: readonly number[]): number[] {
	// filter() copies, so the in-place sort inside ascendingUnique never reorders a caller's array.
	const usable = ladder.filter(isPositiveFinite);
	if (usable.length < ladder.length) {
		warnOptions(
			`dropped ${ladder.length - usable.length} of ${ladder.length} increments that are not ` +
				'finite and above zero — findIncr divides by the increment, so none of those can tick'
		);
	}

	// Applied here as well as inside incrsLadder, because these two entry points are where a rung
	// arrives without having passed through it: a caller's own array, and a caller's `mults` scaled
	// by a step. A ladder that came from incrsLadder has nothing left to drop.
	const steppable = steppableIncrs(usable, warnOptions);

	const outOfOrder = steppable.some((incr, index) => {
		const previous = steppable[index - 1];
		return previous !== undefined && incr < previous;
	});
	if (outOfOrder) {
		warnOptions(
			'increments were not in ascending order and have been sorted — findIncr binary-searches ' +
				'axis.incrs and then only walks forward, so a rung before that seed is unreachable and ' +
				'the axis silently ticks too coarsely, or not at all'
		);
	}

	// Duplicates go quietly, unlike the three above: uPlot only wastes a step of that forward walk on
	// them, so removing one repairs nothing the caller needs to hear about.
	return ascendingUnique(steppable);
}

// Always allocates a new array — even when both bounds are left at their defaults — so every
// incrsFor*/incrsByUnit/incrsStep call returns a caller-owned array. Returning the shared
// module-level ladder directly would let one consumer's mutation corrupt every other chart's ticks.
// Private to this module — both the incrsFor* facades and incrsStep run their ladders through it.
function applyIncrsOptions(ladder: readonly number[], options: IncrsOptions | undefined): number[] {
	const minIncr = incrsBound('minIncr', options?.minIncr, -Infinity);
	const maxIncr = incrsBound('maxIncr', options?.maxIncr, Infinity);
	const usable = sanitizeIncrs(ladder);
	const bounded = usable.filter((incr) => incr >= minIncr && incr <= maxIncr);
	// An empty axis.incrs is not "use uPlot's default": `axis.incrs || defaults` keeps an empty
	// array because it is truthy, findIncr then finds nothing and returns [0, 0], and axesCalc
	// bails before sizing the axis — leaving a blank gutter with no ticks, no gridlines and, until
	// this warning, nothing at all on the console to say why.
	//
	// Which half is at fault decides the message. Naming the bounds is right when they are what
	// admits nothing (minIncr above maxIncr, or a floor past the top of the ladder) — that reads as
	// an ordinary filter right up until the axis disappears. But a ladder that arrived empty, or
	// that lost its last rung upstream, would be reported as `>= -Infinity and <= Infinity` under
	// the same wording, which reads as a bug in this package rather than in the caller's array.
	if (bounded.length === 0) {
		warnOptions(
			usable.length === 0
				? 'no increments to filter — the ladder was empty before minIncr/maxIncr were applied, ' +
						'and an empty axis.incrs renders no ticks at all rather than falling back to the ' +
						'uPlot default'
				: `no increment is both >= minIncr ${minIncr} and <= maxIncr ${maxIncr} — an empty ` +
						'axis.incrs renders no ticks at all rather than falling back to the uPlot default'
		);
	}
	return bounded;
}

/**
 * Power-of-two increments for a Y axis measured in bytes (1 byte to 2^50), so ticks land on
 * values like 1024 or 1MiB instead of the nearest round-looking decimal number.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForBytes } from 'uplot-kit';
 *
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [1024, 8192, 3072]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'bytes sent' }],
 *   axes: [{}, { incrs: incrsForBytes() }]
 * };
 *
 * new uPlot(opts, data, document.body);
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
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [4, 32, 12]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'payload size (KB)' }],
 *   axes: [{}, { incrs: incrsForKilobytes() }]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export function incrsForKilobytes(options?: IncrsOptions): number[] {
	return applyIncrsOptions(KILOBYTE_INCRS, options);
}

/**
 * Power-of-two increments for a Y axis whose values are already scaled to megabytes, resolving
 * down to 16 bytes (2^-16 MB). Not to a single byte, unlike {@link incrsForKilobytes}: uPlot's own
 * increment picker rejects anything finer than that on a megabyte-scaled axis, whatever the data,
 * so those rungs would never be chosen. Plot in kilobytes or bytes if you need to tick below it.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForMegabytes } from 'uplot-kit';
 *
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [12, 96, 40]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'heap size (MB)' }],
 *   axes: [{}, { incrs: incrsForMegabytes() }]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export function incrsForMegabytes(options?: IncrsOptions): number[] {
	return applyIncrsOptions(MEGABYTE_INCRS, options);
}

/**
 * Power-of-two increments for a Y axis whose values are already scaled to gigabytes, resolving
 * down to 16 KiB (2^-16 GB). The floor is the same rung {@link incrsForMegabytes} stops at, for
 * the same reason — uPlot's increment picker rejects anything finer than 2^-16 whatever the unit —
 * so it simply spells a coarser size here. Plot in megabytes or smaller if you need to tick below
 * it.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForGigabytes } from 'uplot-kit';
 *
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [6, 48, 20]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'disk used (GB)' }],
 *   axes: [{}, { incrs: incrsForGigabytes() }]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export function incrsForGigabytes(options?: IncrsOptions): number[] {
	return applyIncrsOptions(GIGABYTE_INCRS, options);
}

/**
 * Power-of-two increments for a Y axis whose values are already scaled to terabytes, resolving
 * down to 16 MiB (2^-16 TB) — the same rung {@link incrsForGigabytes} and
 * {@link incrsForMegabytes} stop at, since uPlot's increment picker rejects anything finer than
 * 2^-16 whatever the unit. Plot in a smaller unit if you need to tick below it.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForTerabytes } from 'uplot-kit';
 *
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [3, 12, 7]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'cluster storage (TB)' }],
 *   axes: [{}, { incrs: incrsForTerabytes() }]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export function incrsForTerabytes(options?: IncrsOptions): number[] {
	return applyIncrsOptions(TERABYTE_INCRS, options);
}

/**
 * Power-of-two increments for a Y axis whose values are already scaled to petabytes, resolving
 * down to 16 GiB (2^-16 PB) — the same rung every ladder from {@link incrsForMegabytes} up stops
 * at, since uPlot's increment picker rejects anything finer than 2^-16 whatever the unit. This is
 * the largest unit the package names: above it the ladder would repeat itself under a new label,
 * so build one with `incrsLadder(2, -16, 50, [1])` instead.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsForPetabytes } from 'uplot-kit';
 *
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [2, 9, 5]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'archive size (PB)' }],
 *   axes: [{}, { incrs: incrsForPetabytes() }]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export function incrsForPetabytes(options?: IncrsOptions): number[] {
	return applyIncrsOptions(PETABYTE_INCRS, options);
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
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [3000, 24000, 9000]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'bitrate' }],
 *   // ticks every 5 kbit — uPlot's own ladder would pick the 2.5 kbit mantissa here
 *   axes: [{}, { incrs: incrsForBits() }]
 * };
 *
 * new uPlot(opts, data, document.body);
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
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [3, 23, 11]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'error count' }],
 *   // ticks 5, 10, 15, ... — uPlot's own ladder would pick 2.5 on this range
 *   axes: [{}, { incrs: incrsForIntegers() }]
 * };
 *
 * new uPlot(opts, data, document.body);
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
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [300, 2700, 900]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'job duration (s)' }],
 *   // ticks every 5 minutes (300, 600, 900, ...) — uPlot's own ladder would pick 500s
 *   axes: [{}, { incrs: incrsForSeconds() }]
 * };
 *
 * new uPlot(opts, data, document.body);
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
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [3000, 150000, 60000]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'task duration (ms)' }],
 *   // ticks every 30s (30000, 60000, 90000, ...) — uPlot's own ladder would pick 20000ms
 *   axes: [{}, { incrs: incrsForMilliseconds() }]
 * };
 *
 * new uPlot(opts, data, document.body);
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
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [3000, 24000, 9000]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'query duration (µs)' }],
 *   // ticks every 5ms — uPlot's own ladder would pick the 2.5ms mantissa here
 *   axes: [{}, { incrs: incrsForMicroseconds() }]
 * };
 *
 * new uPlot(opts, data, document.body);
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
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [3000, 24000, 9000]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'syscall duration (ns)' }],
 *   // ticks every 5µs — uPlot's own ladder would pick the 2.5µs mantissa here
 *   axes: [{}, { incrs: incrsForNanoseconds() }]
 * };
 *
 * new uPlot(opts, data, document.body);
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
	| 'gigabyte'
	| 'terabyte'
	| 'petabyte'
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
	gigabyte: incrsForGigabytes,
	terabyte: incrsForTerabytes,
	petabyte: incrsForPetabytes,
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
 *   `'gigabyte'`, `'terabyte'`, `'petabyte'`, `'bit'`, `'integer'`, `'second'`,
 *   `'millisecond'`, `'microsecond'`, `'nanosecond'`), or a
 *   custom array of increments. A custom array is sorted ascending, de-duplicated, and stripped of
 *   values that are not finite and above zero, rather than trusted: this is the entry point whose
 *   argument arrives unchecked from a chart config, and each of those shapes otherwise fails as a
 *   mis-ticked or blank axis. The repairs that matter are warned about once. The array is copied,
 *   never sorted in place.
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
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120],
 *   [1024, 8192, 3072]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'bytes sent' }],
 *   axes: [{}, { incrs: incrsByUnit('byte') }]
 * };
 *
 * new uPlot(opts, data, document.body);
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
			`unknown unit ${describeValue(kind)} — expected one of ${known}, or an array of ` +
				'increments; no increments'
		);
		return [];
	}
	return INCRS_FACADES[kind](options);
}

// --- incrsStep ---

export interface IncrsStepOptions extends IncrsOptions {
	/**
	 * Whole multiples of `step` to offer as increments. Order does not matter — the scaled products
	 * are sorted ascending and de-duplicated, since uPlot binary-searches `axis.incrs` (see
	 * {@link incrsLadder}) — but a set given out of order is warned about once, because an
	 * unsorted list is far more often a mistake than an intent.
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
 * @returns The `mults` scaled by `step`, sorted ascending and de-duplicated — not in the order
 *   given, since uPlot's `findIncr` binary-searches `axis.incrs` (see {@link incrsLadder}) — with
 *   any product that is not a usable increment (`0`, a negative, or one that overflowed to
 *   `Infinity`) dropped and reported once, the same filter {@link incrsLadder} applies to its own
 *   rungs. A product below 1e-6 is dropped on the same rule and for the sharper reason given
 *   there: uPlot cannot step by one, and would hang building splits rather than mis-tick. A
 *   sub-microsecond bucket size therefore keeps only its wider multiples — tick the narrow ones
 *   through `axis.splits` with {@link splitsForStep}, which has no such limit.
 *
 *   Products are cleaned of float noise (`25 * 1.1` comes back as `27.5`, not
 *   `27.500000000000004`) whenever `step` and the mult together name no more decimals than a
 *   double carries. A `step` that names more — one that is not a short decimal at all, such as
 *   `(1 - 0.3) / 7` or `1 / 3` — is used raw instead, since there is no decimal to recover and
 *   rounding at that width would only add noise of its own. Either way the `1` rung is exactly
 *   `step`.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsStep } from 'uplot-kit';
 *
 * const POLL = 420; // a 7-minute polling interval, in seconds — no round unit divides it
 *
 * // Every increment is a whole number of polls: 420s, 840s, 2100s, 4200s, ... This sets tick
 * // *spacing*, not phase — uPlot anchors a time axis at the viewer's local midnight.
 * const pollIncrs = incrsStep(POLL);
 *
 * const start = Date.UTC(2026, 0, 1, 9, 0) / 1000;
 * const depth = [12, 31, 24, 47, 38, 55, 41, 63];
 * const data: uPlot.AlignedData = [depth.map((_d, i) => start + i * POLL), depth];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'queue depth' }],
 *   // ticks 7 minutes apart — uPlot's own time ladder would pick 5, which no whole number
 *   // of polls divides, so every tick spacing would cut across the cycle
 *   axes: [{ incrs: pollIncrs }, {}]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { incrsStep } from 'uplot-kit';
 *
 * const CANDLE = 900; // a 15-minute candle, in seconds
 *
 * // 900s, 3600s, 14400s, 86400s, 604800s — each one a whole number of candles *and* a round
 * // wall-clock span (1 candle, 1h, 4h, 1d, 1w). The default mults would offer 4500s and
 * // 22500s — 5 and 25 candles — which are whole candles but land nowhere on the clock.
 * const sessionIncrs = incrsStep(CANDLE, { mults: [1, 4, 16, 96, 672] });
 *
 * const start = Date.UTC(2026, 0, 1) / 1000;
 * const close = Array.from({ length: 96 }, (_c, i) => 100 + Math.round(Math.sin(i / 6) * 8));
 * const data: uPlot.AlignedData = [close.map((_c, i) => start + i * CANDLE), close];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'close' }],
 *   // over this one-day window it settles on 14400s — a tick every 4 hours, and since 4h
 *   // divides the day those ticks land on the same six hours in every timezone. Plain
 *   // incrsStep(CANDLE) picks 9000s: 2h30m divides neither the day nor the hour, so the
 *   // grid drifts from day to day and every second tick sits on a half-hour that uPlot's
 *   // labels at that increment then hide.
 *   axes: [{ incrs: sessionIncrs }, {}]
 * };
 *
 * new uPlot(opts, data, document.body);
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
	//
	// That premise fails past MAX_EXACT_DECIMALS, and there the rounding stops cleaning and starts
	// dirtying — see the constant. A step of (1 - 0.3) / 7 claims 17 decimals; rounding its 25x rung
	// to 17 places turned the exact 2.5 that fell out of the multiplication into 2.5000000000000004,
	// which is the precise value this line exists to avoid. Above the budget the raw product is
	// already the nearest double to the true answer, so it is left alone — and the 1x rung then
	// comes back as `step` itself, which "exact multiples of a fixed step" has to mean.
	const scaled = mults.map((mult) => {
		const product = mult * step;
		const decimals = stepDec + fractionDigits(mult);
		return decimals > MAX_EXACT_DECIMALS ? product : roundDec(product, decimals);
	});
	// The same final filter incrsLadder applies to its own rungs, for the same reason: findIncr
	// divides by the increment, so a 0 rung can never satisfy its minimum-space test, a non-finite
	// one poisons the comparison and a negative one spaces backwards. Unlike incrsLadder's, these
	// come straight from a caller's `mults` rather than from an exponent that saturated, so the drop
	// is reported here — and reported in terms of `mults`, which is what the caller can act on,
	// rather than through sanitizeIncrs' generic increment wording downstream.
	const usable = scaled.filter(isPositiveFinite);
	if (usable.length < scaled.length) {
		warnStep(
			`dropped ${scaled.length - usable.length} of ${scaled.length} mults whose product with ` +
				'step is not finite and above zero — those are not usable as increments'
		);
	}
	return applyIncrsOptions(usable, incrsOptions);
}
