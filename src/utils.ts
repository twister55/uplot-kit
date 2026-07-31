// Helpers shared by more than one unit in this package — float hygiene and the option-validation
// policy. Deliberately NOT re-exported from src/index.ts: none of it is useful to a consumer on
// its own, and the public API stays the narrow list of factories the barrel names.
//
// The bar for landing here is that two units need the *same behaviour*, not that two units happen
// to contain similar-looking code. Anything only one unit needs stays in that unit's file, next to
// the reasoning for it: `roundSignificant` and the tick-coincidence tolerances are splits-only,
// the increment ladders are incrs-only, and they should stay that way. Each function below states
// the general contract; each call site keeps a line on why it needs it.

// --- Float hygiene ---

/**
 * The largest decimal-place count worth rounding a double to. Past it {@link roundDec} stops
 * cleaning and starts dirtying: its `(1 + EPSILON)` nudge is a *relative* one, so once
 * `|value * 10 ** decimals|` passes 2^51 the nudge exceeds half a unit and the rounding degenerates
 * into unconditional round-away-from-zero — it moves values that were already exact (2.5 comes back
 * as 2.5000000000000004) instead of recovering ones that are an ulp off.
 *
 * Both units that count decimals are written against this, with different recoveries: splits
 * switches to significant-digit rounding past it, incrs stops rounding and keeps the raw product,
 * which above the budget is already the nearest double to the true answer. What neither may do is
 * act on a {@link fractionDigits} count above it as though it named real decimals.
 *
 * The one deliberate exception is the base-2 path in `incrsLadder`, which rounds to |exp| places up
 * to 53 *because* of the degeneracy: uPlot's own generator does the same and registers the drifted
 * results in the map it looks tick decimals up in, so matching it matters more than being right.
 */
export const MAX_EXACT_DECIMALS = 15;

/**
 * Decimal places in a number's own shortest decimal form. Unlike uPlot's internal `guessDec` this
 * also folds in an exponent, because `String()` switches to exponential notation below 1e-6 and
 * at/above 1e21 (`1e-7` -> 7, `2.5e-7` -> 8) — a range both callers reach, and where undercounting
 * to 0 would round a value away to nothing.
 *
 * Above ~16 the answer stops being meaningful (a double has no digits left there, and the shortest
 * round-trip form of the mantissa read on its own is shorter than the digits inside the exponential
 * form), so callers must not act on the exact count in that band — see {@link MAX_EXACT_DECIMALS},
 * which both callers bound themselves by.
 *
 * Non-finite input has no decimal form at all and answers 0, which is also what the string path
 * would produce for it ('NaN' and 'Infinity' hold no decimal point) — the guard is the statement,
 * not a behaviour change.
 */
export function fractionDigits(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	const [mantissa = '', exponent] = String(value).split('e');
	const fractionLen = (mantissa.split('.')[1] ?? '').length;
	return Math.max(0, fractionLen - (exponent === undefined ? 0 : Number(exponent)));
}

// Every factor roundDec can ask for without computing one, resolved once. It runs per tick on a
// splits axis — a 200-tick axis was paying 200 `10 ** decimals` per redraw for a value that only
// ever takes these 16 forms — and each is exact, since 1e15 is still under 2**53.
//
// `/* @__PURE__ */` because an unannotated top-level call is a side effect a bundler must keep:
// without it this table landed in every bundle that imports *anything* from this module, including
// one that only ever reaches optionOr. Same reasoning as the ladders in src/incrs.ts and src/splits.ts.
const POW10 = /* @__PURE__ */ Array.from({ length: 16 }, (_, exponent) => 10 ** exponent);

/**
 * Half-away-from-zero rounding to `decimals` decimal places, mirroring uPlot's own internal
 * `roundDec` (MIT © Leon Sorokin, `node_modules/uplot/dist/uPlot.esm.js`, around line 550) — it
 * isn't exported, so this is a reimplementation of the algorithm, not a wrapper around it.
 *
 * The `(1 + EPSILON)` factor nudges a binary approximation that is "really" a round decimal
 * (2.4999999999999996 for 2.5) back onto it. It is uPlot's, and matching it is load-bearing for
 * incrs: uPlot pre-registers `genIncrs(2, -53, 53, [1])` in the internal `fixedDec` map it looks a
 * tick's decimal count up in, so a "more correct" value here would simply miss that map.
 *
 * A value with nothing to round, and a `decimals` too large for the scale factor to survive
 * (past 308 it overflows, and `val * Infinity / Infinity` is NaN), are returned untouched rather
 * than destroyed.
 */
export function roundDec(value: number, decimals: number): number {
	if (Number.isInteger(value) || decimals <= 0) {
		return value;
	}
	const factor = POW10[decimals] ?? 10 ** decimals;
	if (!Number.isFinite(factor)) {
		return value;
	}
	return Math.round(value * factor * (1 + Number.EPSILON)) / factor;
}

// --- Option validation ---

/**
 * The rule three options independently apply to a length-like value — splitsForTime's `ms` (axis
 * units per millisecond), splitsForStep's `step` (grid spacing) and incrsStep's `step` (bucket
 * size) all mean "nothing sensible to scale or space by" unless finite and above zero. Only the
 * predicate is shared: the recovery differs on purpose (`ms` falls back to its default, a `step`
 * has none and produces nothing), which is why this is a bare boolean the callers branch on rather
 * than a warn-and-fallback helper.
 */
export function isPositiveFinite(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

/**
 * One warn-once tracker per source (a factory instance, or a module-level entry point), so a chart
 * that redraws every frame on a degenerate input logs once, not per frame. Keyed by the message
 * rather than by a single flag: one source can report structurally unrelated conditions (an
 * unplaceable grid, a capped walk) that are fixed by different things, so silencing one must not
 * silence the others.
 */
export function makeWarnOnce(source: string): (detail: string) => void {
	const warned = new Set<string>();
	return (detail) => {
		if (!warned.has(detail)) {
			warned.add(detail);
			console.warn(`uplot-kit ${source}: ${detail}`);
		}
	};
}

/**
 * The package's policy for an option that has a documented default: name the bad value, say it
 * once, and carry on with the default. The types are narrow, but a value they forbid still arrives
 * from plain JavaScript or from a config object cast into shape — and the expensive part is never
 * the bad value itself, it is that guessing silently for it yields a plausible-looking result
 * nobody thinks to distrust (`base: 0` ticking a lone 1, a fractional `weekStartsOn` putting every
 * week tick at midday, a `NaN` bound quietly emptying an increment ladder).
 *
 * The companion policy, for a *required* value with no honest substitute (a grid with no spacing
 * is not a grid), is not this function: the callers warn once and return an inert result — no
 * ticks, no increments — rather than guess. Neither policy throws.
 *
 * Call this where the option is read, not per use, when the value cannot change afterwards: a
 * closed-over option re-tested on every frame re-answers a settled question.
 */
export function optionOr<T>(
	warn: (detail: string) => void,
	name: string,
	value: T,
	isValid: boolean,
	requirement: string,
	fallback: T
): T {
	if (isValid) {
		return value;
	}
	warn(
		`${name} must be ${requirement}, got ${describeValue(value)} — ` +
			`falling back to ${describeValue(fallback)}`
	);
	return fallback;
}

/**
 * How this package spells a bad option value in a warning. `JSON.stringify` renders `NaN`,
 * `Infinity` and `-Infinity` all as `null`, which turns the most common bad-option message into no
 * information at all ("got null — falling back to null") and makes the three indistinguishable in
 * the log — for values that arrive from an unparsed `Number(userInput)` more often than any other.
 * Numbers are therefore spelled by `String()`; everything else keeps JSON's quoting, so a bad
 * string option is visibly a string ('Month' rather than Month).
 *
 * Exported because {@link optionOr} is not the only place that names a value: an option with no
 * default warns and returns an inert result instead of falling back, and those call sites have to
 * spell the value the same way.
 */
export function describeValue(value: unknown): string {
	return typeof value === 'number' ? String(value) : JSON.stringify(value);
}
