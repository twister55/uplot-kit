// uPlot `axis.splits` generators and decorators: a set of factories producing the tick-
// position function shape uPlot's `axis.splits` accepts, plus decorators (`SplitsFn =>
// SplitsFn`) that wrap any of them to inject, filter, or thin ticks. Where `incrs` answers
// "which step sizes are allowed" (uPlot then builds an even grid from one), `splits` answers
// "where exactly do ticks land" — the full override uPlot's own evenly-spaced default can't
// express: calendar-irregular (splitsForTime), logarithmic (splitsForLog), or anchored
// (splitsForStep) tick placement.

import type uPlot from 'uplot';

const SECONDS_PER_DAY = 60 * 60 * 24;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;
const APPROXIMATE_YEAR = 366 * SECONDS_PER_DAY;

// Shared cap for every generator's tick walk — bites only on absurd ranges (one spanning
// millions of years, say), turning unbounded per-redraw work into a bounded walk with one loud
// warning per generator instance. It is not a unit-mismatch guard: a timestamp axis in a finer
// unit than seconds is a supported configuration, declared through splitsForTime's `ms`.
const MAX_TICK_CANDIDATES = 10_000;

// How far an arithmetic grid's spacing may drift from the requested step before stepGrid refuses
// to place it at all. Adjacent doubles at magnitude `m` are `m * EPSILON` apart, so a step near
// that size quantizes onto them and an "even" grid comes out visibly uneven. A thousand-fold
// margin puts the worst-case drift at 0.1% of one step — far under a device pixel on any real
// axis — while still refusing the cases that are wrong by a third.
const MAX_GRID_SPACING_ERROR = 1e-3;

/**
 * The `axis.splits` function shape every generator below returns, and every decorator wraps —
 * narrower than uPlot's `Axis.Splits` union (which also allows a static `number[]`), so callers
 * get a directly callable function back instead of having to narrow the union themselves.
 */
export type SplitsFn = (
	self: uPlot,
	axisIdx: number,
	scaleMin: number,
	scaleMax: number,
	foundIncr: number,
	foundSpace: number
) => number[];

// --- Shared helpers (private) ---

// The part of the degenerate-range guard the generators share: non-finite bounds and an inverted
// range both mean "nothing sensible to tick". It is only the shared part — each generator adds
// its own (splitsForLog rejects scaleMin <= 0, splitsForCategory tests the count-clamped range
// rather than the raw one), so this is a predicate to build on, not the whole policy.
//
// A zero-width range — the one case uPlot itself passes through unpadded (single-point data)
// — is deliberately *not* special-cased. Letting it flow through the generator's own grid means
// the collapsed value ticks only when it is a real grid position (a calendar boundary, a decade,
// a step multiple), instead of becoming the single off-grid tick the generator would never
// otherwise emit. splitsWithEdges is how a caller opts into a tick there regardless.
function isTickable(scaleMin: number, scaleMax: number): boolean {
	return Number.isFinite(scaleMin) && Number.isFinite(scaleMax) && scaleMin <= scaleMax;
}

// The rule two generators independently apply to a length-like option: splitsForTime's `ms` (axis
// units per millisecond) and splitsForStep's `step` (grid spacing) both mean "nothing sensible to
// scale/space by" unless finite and above zero. Only the predicate is shared — the recovery differs
// on purpose (ms falls back to its default, step has none and ticks nothing), which is why this is a
// bare boolean the callers branch on rather than a warn-and-fallback helper.
function isPositiveFinite(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

// One warn-once tracker per generator instance, so a chart that redraws every frame on a
// degenerate range logs once, not per frame. Keyed by the message rather than by a single flag:
// a generator can report structurally unrelated conditions (an unplaceable grid, a capped walk)
// that are fixed by different things, so silencing one must not silence the others.
function makeWarnOnce(source: string): (detail: string) => void {
	const warned = new Set<string>();
	return (detail) => {
		if (!warned.has(detail)) {
			warned.add(detail);
			console.warn(`uplot-kit ${source}: ${detail}`);
		}
	};
}

// Factory-time option check, shared by every generator. The types below are narrow, but a value
// they forbid still arrives from plain JavaScript or from a config object cast into shape — and
// the expensive part is never the bad value itself, it is that guessing silently for it yields a
// plausible-looking axis nobody thinks to distrust (`base: 0` ticking a lone 1, a fractional
// `weekStartsOn` putting every week tick at midday). Each is named, reported once, and replaced
// by the documented default, so the chart still renders and the console says why.
//
// Checked here rather than per redraw because none of these can change afterwards: the option is
// closed over, so a per-call test re-answers a settled question on every frame.
function optionOr<T>(
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
		`${name} must be ${requirement}, got ${JSON.stringify(value)} — ` +
			`falling back to ${JSON.stringify(fallback)}`
	);
	return fallback;
}

const CAP_REACHED =
	`stopped after ${MAX_TICK_CANDIDATES} tick candidates — ` + 'the scale range looks degenerate';

// The one candidate cap every generator shares. `push` reports whether the caller may keep
// going, so the three shapes of tick generation below — the calendar walk, the arithmetic
// grid, the log decade sweep — stop on a single convention rather than three subtly different
// off-by-ones. Values below the eventual scaleMin are not filtered here — normalize() does
// that — so the cap counts every candidate the same way regardless of where the visible
// window starts.
type TickCollector = {
	values: number[];
	push: (value: number) => boolean;
	warn: (detail: string) => void;
};

function makeCollector(warn: (detail: string) => void): TickCollector {
	const values: number[] = [];
	const push = (value: number): boolean => {
		if (values.length >= MAX_TICK_CANDIDATES) {
			warn(CAP_REACHED);
			return false;
		}
		values.push(value);
		return true;
	};
	return { values, push, warn };
}

// Number of digits after the decimal point in `value`'s own shortest decimal form, used to
// round a computed tick back to exactly the precision its inputs carry. Exponential notation
// (`1e-7`, whose string form has no decimal point at all) is handled by folding the exponent
// into the mantissa's own digit count.
function fractionDigits(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	const text = Math.abs(value).toString();
	const exponentAt = text.indexOf('e');
	if (exponentAt >= 0) {
		const exponent = Number(text.slice(exponentAt + 1));
		return Math.max(0, fractionDigits(Number(text.slice(0, exponentAt))) - exponent);
	}
	const dotAt = text.indexOf('.');
	return dotAt < 0 ? 0 : text.length - dotAt - 1;
}

// Rounds a grid value to `digits` decimals, undoing the representation error that even exact
// index math carries for fractional steps (`3 * 0.1 === 0.30000000000000004`). Past 15 digits a
// double has no precision left to round to, so the value passes through untouched rather than
// overflowing the 10**digits factor.
// Every factor roundTo can ask for, resolved once. It runs per tick — a 200-tick axis was paying
// 200 `10 ** digits` per redraw for a value that only ever takes these 16 forms — and each is
// exact, since 1e15 is still under 2**53.
const POW10 = Array.from({ length: 16 }, (_, exponent) => 10 ** exponent);

function roundTo(value: number, digits: number): number {
	if (digits <= 0 || digits > 15 || !Number.isFinite(value)) {
		return value;
	}
	// `digits` is a whole number in 1..15 here, so the fallback is unreachable — it is how the
	// lookup is spelled without a non-null assertion under noUncheckedIndexedAccess.
	const factor = POW10[digits] ?? 10 ** digits;
	return Math.round(value * factor) / factor;
}

// A double carries just under 16 significant decimal digits, so re-reading a value at 15 drops
// the last digit — which is exactly where a product's representation error lives — and leaves
// every value that was exact at that width untouched.
const SIGNIFICANT_DIGITS = 15;

// Rounds to significant precision rather than to a fixed number of decimal places, which is what
// a log axis needs: its ticks span every magnitude at once, so decimals are the wrong unit
// entirely. roundTo() can only see that 3e23 has no fractional part and leaves
// 2.9999999999999997e+23 as it found it, and at the other end it refuses to act at all once a
// value needs more than 15 decimals, leaving 6.999999999999999e-16 for the label formatter.
// Significant digits are scale-free and clean both ends with one rule.
function roundSignificant(value: number): number {
	return Number.isFinite(value) ? Number(value.toPrecision(SIGNIFICANT_DIGITS)) : value;
}

// The rounding stepGrid applies to a raw grid value. Decimal-place rounding (roundTo) is the right
// tool for an ordinary fractional step — it is exact and recovers the decimal the caller wrote
// (`3 * 0.1` back to `0.3`) — but it gives up once `digits` exceeds 15, and a step or anchor whose
// own shortest decimal is longer than that reaches exactly there: `1/3` is "0.3333333333333333"
// (16 digits), `0.1 + 0.2` is "0.30000000000000004" (17), and any step at a magnitude below ~1e-15
// needs more decimals than a double carries. Left to roundTo alone the whole grid then came out in
// float noise (a clean `0.1` step under a noisy anchor emitting `0.6000000000000001`). Past that
// threshold this falls back to significant-digit rounding — the same scale-free rule splitsForLog
// already uses to clean both magnitude ends with one pass. Below the threshold roundTo is unchanged,
// so no ordinary grid rounds differently.
function roundGridValue(value: number, digits: number): number {
	return digits > 15 ? roundSignificant(value) : roundTo(value, digits);
}

// Folds `-0` onto `+0`. Every tick-producing path that can reach zero from below — stepGrid's grid
// phased across the origin, splitsForTime's even-day/week rung starting at Math.ceil(-1/n), an
// injected `-0` in mergeTicks — routes its emitted value through this, because `-0` is a real axis
// zero the caller means but `Intl.NumberFormat().format(-0)` renders it as the string "-0", a stray
// minus on the label. The one shared final path that does NOT need it is normalize(): its `Set`
// canonicalizes `-0` to `+0` on insertion by spec, so a value laundered there is already clean —
// but that is a side effect to rely on knowingly, not to rediscover, hence this is the named
// invariant every other path calls by hand.
function withoutNegativeZero(value: number): number {
	return value === 0 ? 0 : value;
}

// The window, in relative ulps, within which two doubles are treated as the same axis position.
// A single differently-associated product drifts by one ulp, but a scale bound can reach the
// comparison having accumulated several through uPlot's own range padding, and a one-ulp window
// dropped an edge tick that sat that far out. Four ulps still resolves to a sub-pixel distance on
// any real axis while absorbing that drift.
const SAME_TICK_ULPS = 4;

// Whether two doubles denote the same axis position. They routinely do not compare equal while
// meaning the same thing, because the same quantity reached them by different arithmetic: a grid
// point computed as `27 * 0.089` is 2.403, while the bound reached as `7 * 0.089 + 20 * 0.089` is
// 2.4029999999999996 — one ulp apart, one position. Bit equality is the wrong test for anything
// that has to decide whether a tick coincides with something, so both callers use this instead:
// stepGrid to tell a tick sitting *on* a bound from one past it, mergeTicks to keep an injected
// edge from being drawn a sub-pixel away from the tick it duplicates.
//
// The tolerance is relative, so it scales with magnitude and collapses to exact equality at zero —
// which is right, since there is no relative error to allow for around zero.
function isSameTick(a: number, b: number): boolean {
	return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * (SAME_TICK_ULPS * Number.EPSILON);
}

// The arithmetic tick grid `anchor + k * step`, clamped to [lower, upper] — the shared body of
// splitsForStep and splitsForCategory (which differs only in clamping its bounds to the category
// index range first). Every tick is computed from its own index rather than by adding `step` to
// the previous one, so a fractional step accumulates no drift. Same candidate cap as walk().
//
// Deciding whether a grid point is inside [lower, upper] is float comparison at its most
// treacherous, because the point and the bound are two quantities that mean the same thing while
// having reached the comparison by different arithmetic. Both sides of the test therefore get
// tolerance, for two distinct reasons:
//
// On the tick's side, each grid point has two faithful spellings differing by at most an ulp: the
// *raw* `anchor + k * step`, the exact continuation of the caller's own arithmetic, and the
// *rounded* value actually emitted, which recovers the decimal the caller wrote (`3 * 0.1` becomes
// 0.3 again). A bound test takes whichever of the two falls on the permissive side, since a tick
// on the bound must not vanish because rounding carried it across — and it lands on either side
// depending on the case. Step 0.15 over [0, 3 * 0.15]: the top point is raw 0.44999999999999996
// rounding *up* to the 0.45 the caller wrote, so the rounded form fails the upper bound. Step 0.2
// anchored at 1 over [-0.4, 0.4]: the bottom one is raw -0.40000000000000013 rounding *up* to
// -0.4, so the raw form fails the lower bound.
//
// On the bound's side, the bound itself may carry the error instead. A range whose end was
// computed some other way — `7 * 0.089 + 20 * 0.089` is 2.4029999999999996 where the grid's own
// `27 * 0.089` is 2.403 — puts the last point an ulp above a bound that means to include it, and
// no amount of respelling the tick fixes that. So the comparison asks isSameTick() whether the two
// denote the same position at all before calling one past the other.
//
// This grid therefore owns its own bounds: what it returns is already ascending, unique and in
// range, and callers must NOT run it back through normalize(), whose clamp re-tests the rounded
// values against the raw scale bounds and would undo exactly these decisions. An emitted tick can
// sit up to an ulp outside [lower, upper] — the same position, spelled correctly.
function stepGrid(
	anchor: number,
	step: number,
	digits: number,
	lower: number,
	upper: number,
	into: TickCollector
): number[] {
	// Whether a grid is placeable at all is a property of the magnitude its ticks sit at, not of
	// how far the anchor happens to be from the window: at 1.7e18 a 1000-unit step lands on
	// doubles 256 apart and alternates 768/1024 gaps no matter where it is anchored from. Keying
	// on the anchor's phase distance instead judged the same grid differently depending on where
	// the caller anchored it, refusing it loudly from one anchor and silently collapsing it from
	// another. A non-finite anchor or bound lands here too, via a non-finite magnitude.
	const magnitude = Math.max(Math.abs(lower), Math.abs(upper), Math.abs(anchor));
	if (!(magnitude * Number.EPSILON <= step * MAX_GRID_SPACING_ERROR)) {
		into.warn('step is too small to place an exact tick grid at this scale');
		return into.values;
	}

	const gridValue = (index: number): number => anchor + index * step;
	const isAtOrAbove = (index: number): boolean => {
		const raw = gridValue(index);
		const nearest = Math.max(raw, roundGridValue(raw, digits));
		return nearest >= lower || isSameTick(nearest, lower);
	};

	// The quotient is float division and can land a hair either side of the true index —
	// `(0.07 - 0) / 0.01` is 7.000000000000001, which ceils to 8 and skips the tick sitting
	// exactly on `lower`. The grid itself is the authority, so the quotient is corrected against
	// it; one step either way is enough, the guard above having bounded the division's error.
	let firstIndex = Math.ceil((lower - anchor) / step);
	if (isAtOrAbove(firstIndex - 1)) {
		firstIndex--;
	} else if (!isAtOrAbove(firstIndex)) {
		firstIndex++;
	}

	// How long the grid would be is arithmetic, so it is asked rather than discovered. Walking to
	// find out meant pushing MAX_TICK_CANDIDATES values on every redraw — forever, since the
	// warning fires once and the zoom does not change — and then handing back that prefix, which
	// covers the low end of the range and leaves the rest bare. That is the one failure shape
	// that still looks like a legitimate axis, and wrapping it in splitsWithLimit does not save
	// it: thinning a prefix just spreads twelve ticks over the half of the plot it reached.
	// Refusing outright is the same answer this function already gives an unplaceable grid, and
	// it leaves the caller a real choice — a coarser step, or a narrower range.
	//
	// The count is `floor((upper - anchor) / step)` for the last index, but the loop's own upper
	// test uses isSameTick, so it can emit one index *past* that floor when the point sits an ulp
	// above `upper` yet on it — a case this arithmetic can't see. So the estimate is treated as
	// exact-to-within-one and the check is made conservative by that one (`+ 2`, not `+ 1`):
	// without it a grid of exactly MAX_TICK_CANDIDATES + 1 slipped past here, then hit the
	// collector cap and handed back the truncated prefix this refusal exists to avoid. The cost is
	// that a legitimate grid of exactly MAX_TICK_CANDIDATES ticks is also refused — but that many
	// ticks is already past any usable density, so refusing one sooner changes only the message.
	if (Math.floor((upper - anchor) / step) - firstIndex + 2 > MAX_TICK_CANDIDATES) {
		into.warn(
			`the range spans more than ${MAX_TICK_CANDIDATES} ticks at this step — ` +
				'widen the step or narrow the range'
		);
		return into.values;
	}

	for (let k = 0; ; k++) {
		const raw = gridValue(firstIndex + k);
		if (!Number.isFinite(raw)) {
			break;
		}
		const value = roundGridValue(raw, digits);
		const nearest = Math.min(raw, value);
		if (nearest > upper && !isSameTick(nearest, upper)) {
			break;
		}
		// An anchor that phases the grid across zero produces a raw value a hair below it, which
		// rounds to `-0` and formats as "-0". Fold it onto the zero the caller means; the grid owns
		// its output and does not run back through normalize()'s Set.
		if (!into.push(withoutNegativeZero(value))) {
			break;
		}
	}
	return into.values;
}

// Clamp a tick set to the visible range, the load-bearing half of normalize(). The bounds are
// ulp-tolerant, for the same reason stepGrid's own bound test is: a decade boundary and the scale
// bound meaning to include it can reach the comparison an ulp apart. splitsForLog ceils `lastPower`
// precisely to recover a `scaleMax` that Math.log rounds a hair under (999.9999999999999 → decade
// 1000), and a plain `v <= scaleMax` then rejected the very tick the ceil computed. isSameTick lets
// a bound keep the tick it denotes.
//
// Split out from normalize() because a caller whose values are already ascending and unique —
// splitsForLog on its default minor:false path emits exactly one base**power per ascending power —
// needs only this clamp, not the Set and sort normalize() adds for sets that can overlap or arrive
// out of order.
function clampToRange(values: number[], scaleMin: number, scaleMax: number): number[] {
	return values.filter(
		(v) => (v >= scaleMin || isSameTick(v, scaleMin)) && (v <= scaleMax || isSameTick(v, scaleMax))
	);
}

// Final-output normalization for tick sets that are not already well-formed: dedupe, ascending
// sort, clamp to the visible range. splitsForLog's decade sweep with interior mantissas can arrive
// out of order or with duplicates (a caller-supplied mantissa at or past `base` crosses a decade
// boundary), so that path needs the full pass. stepGrid's callers deliberately skip it — see the
// note there.
function normalize(values: number[], scaleMin: number, scaleMax: number): number[] {
	return clampToRange([...new Set(values)], scaleMin, scaleMax).sort((a, b) => a - b);
}

// Whether `value` is isSameTick to any element of an ascending `sorted` array. isSameTick is a
// relative-closeness test, so two values it accepts differ by at most a few ulps and are therefore
// adjacent in sorted order: the only candidates are the elements straddling `value`, found by
// binary search. This bounds mergeTicks's coincidence check at O(log n) per injected value instead
// of a full scan — see the note there.
function nearestIsSameTick(sorted: number[], value: number): boolean {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = lo + ((hi - lo) >> 1);
		const midValue = sorted[mid];
		// mid is always in [lo, hi) ⊂ [0, length), so midValue is never undefined; the guard is how
		// the indexed read is narrowed under noUncheckedIndexedAccess without a non-null assertion.
		if (midValue !== undefined && midValue < value) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	// lo is the first index at or above `value`; the nearest elements are lo and lo - 1.
	const above = sorted[lo];
	if (above !== undefined && isSameTick(above, value)) {
		return true;
	}
	const below = lo > 0 ? sorted[lo - 1] : undefined;
	return below !== undefined && isSameTick(below, value);
}

// A copy of `values` guaranteed ascending — but sorted only when it isn't already. Its callers
// (the injecting decorators) pass a generator's output, which is ascending by construction; a
// single O(n) order check then skips the O(n log n) sort for that common case, and pays for the
// sort only for a custom SplitsFn that returned its ticks out of order.
function ascendingCopy(values: number[]): number[] {
	for (let i = 1; i < values.length; i++) {
		const prev = values[i - 1];
		const cur = values[i];
		if (prev !== undefined && cur !== undefined && prev > cur) {
			return [...values].sort((a, b) => a - b);
		}
	}
	return [...values];
}

// Merge two already-ascending arrays into one ascending array in a single linear pass — used so
// mergeTicks folds the surviving injected values into the sorted inner ticks without a second sort.
function mergeSorted(a: number[], b: number[]): number[] {
	const out: number[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		const av = a[i];
		const bv = b[j];
		if (av === undefined) {
			i++;
		} else if (bv === undefined) {
			j++;
		} else if (av <= bv) {
			out.push(av);
			i++;
		} else {
			out.push(bv);
			j++;
		}
	}
	for (; i < a.length; i++) {
		const av = a[i];
		if (av !== undefined) {
			out.push(av);
		}
	}
	for (; j < b.length; j++) {
		const bv = b[j];
		if (bv !== undefined) {
			out.push(bv);
		}
	}
	return out;
}

// How every injecting decorator folds its own values into an inner function's ticks: the
// injected ones are clamped to [lower, upper], the inner's are taken as given, and the union is
// deduped and sorted.
//
// Only the injected side is clamped, and that asymmetry is the point. The inner function has
// already decided which of its ticks belong, with more information than this has — stepGrid in
// particular emits a boundary tick whose rounded form (`0.45`) sits an ulp outside the raw
// bound it was derived from, deliberately, because that is the value the caller wrote. Running
// that back through normalize()'s clamp deleted the tick under splitsWithInclude and replaced it
// with the raw `0.44999999999999996` under splitsWithEdges — the decorators undoing the
// generator's own correction. A tick set is the inner function's business; the decorator only
// answers for what it adds.
//
// An injected value is dropped when it is isSameTick to any tick already kept — an inner tick OR an
// earlier-accepted injected value — because the final Set dedupes by exact equality only, and two
// values that are isSameTick but not `===` (0.3 and 0.1 + 0.2, or two edges an ulp apart on a
// near-zero-width range) would otherwise both survive as the sub-pixel double-tick isSameTick
// exists to prevent. The inner ticks and the injected values are each sorted so both coincidence
// checks are done against neighbours (binary search into the inner ticks, the previous kept value
// among the injected) rather than by scanning: splitsWithEdges injects only two edges, but
// splitsWithInclude's `values` is caller-supplied and uncapped, and a scan there was O(injected ×
// ticks) — a few hundred thresholds over a densely stepped inner axis. Processing the injected in
// sorted rather than arrival order can change which of two isSameTick values wins, but only by a
// sub-pixel amount neither the grid nor the label can show.
function mergeTicks(ticks: number[], injected: number[], lower: number, upper: number): number[] {
	// The same "nothing sensible to tick" guard the generators apply, made explicit here rather
	// than left to the clamp below being coincidentally unsatisfiable on an inverted range. An
	// injected value cannot fall inside an empty interval, and range edges have no meaning when the
	// range is inverted or non-finite, so nothing is added — but the inner ticks are the inner
	// function's business (a custom one may have ticked anyway), so they pass through sorted rather
	// than being second-guessed.
	if (!isTickable(lower, upper)) {
		return ascendingCopy(ticks);
	}

	const candidates: number[] = [];
	for (const value of injected) {
		if (value >= lower && value <= upper) {
			// An injected or edge value of `-0` (Math.ceil(-1/2), a scaleMin that reached zero from
			// below) formats as "-0" otherwise.
			candidates.push(withoutNegativeZero(value));
		}
	}

	// The inner set is the coincidence-check haystack and the base of an ascending result, so it is
	// ordered here — but ascendingCopy sorts it only if it wasn't already ascending (it is, coming
	// from a generator). With nothing to inject that is the whole job.
	const sortedTicks = ascendingCopy(ticks);
	if (candidates.length === 0) {
		return sortedTicks;
	}

	candidates.sort((a, b) => a - b);
	const kept: number[] = [];
	// isSameTick(NaN, value) is false, so the first candidate always clears the against-injected
	// guard; sorted order makes the previous kept value the nearest kept one below the current.
	let lastKept = NaN;
	for (const value of candidates) {
		if (isSameTick(lastKept, value) || nearestIsSameTick(sortedTicks, value)) {
			continue;
		}
		kept.push(value);
		lastKept = value;
	}
	if (kept.length === 0) {
		return sortedTicks;
	}
	// Both operands are ascending — sortedTicks by construction, kept because candidates were sorted
	// before the dedup pushed onto it in order — so a linear merge yields the result without a
	// second sort.
	return mergeSorted(sortedTicks, kept);
}

// --- splitsForTime ---

// Fixed-offset calendar math: axis values are plain Unix seconds, and Date's UTC
// getters/setters ignore the host's own timezone entirely — so shifting a timestamp
// by `offsetSec` before reading or writing UTC fields places calendar boundaries
// (day/week/month/year starts) at that fixed offset instead of the browser's local
// timezone, and shifting back afterwards returns a value in the original units. This
// mirrors the `offsetSec` convention used by the `timeRegions` plugin, so both agree
// on where a "day" starts for a given offset.
function startOfDay(sec: number, offsetSec: number): number {
	const shifted = sec + offsetSec;
	return Math.floor(shifted / SECONDS_PER_DAY) * SECONDS_PER_DAY - offsetSec;
}

// One scratch Date shared by the helpers below, which allocated two per tick between them — 400
// on a 200-year axis, every redraw — while none of them keeps a reference past its own return.
// This is not module state in the sense invariant #2 forbids: nothing is carried between calls,
// because every use begins with setTime().
//
// The hazard it does introduce is aliasing, and it is a real one: a helper that reads a field off
// the scratch *after* calling another helper would read the callee's date, not its own. Hence the
// shape below — every read is pulled into a local before any nested call. Keep that shape when
// adding to this group.
const scratchDate = new Date(0);

function startOfWeek(sec: number, offsetSec: number, weekStartsOn: number): number {
	const dayStart = startOfDay(sec, offsetSec);
	scratchDate.setTime((dayStart + offsetSec) * 1000);
	const dayOfWeek = scratchDate.getUTCDay(); // 0 = Sunday
	const daysSinceWeekStart = (dayOfWeek - weekStartsOn + 7) % 7;
	return dayStart - daysSinceWeekStart * SECONDS_PER_DAY;
}

// Date.UTC maps years 0-99 to 1900-1999; setUTCFullYear does not, so month/year math stays
// correct across the whole Date range. The month is normalised by hand because setUTCFullYear
// applies the year before the month, so a rolled-over month (e.g. 11 + 3) would otherwise
// land in the wrong year. An out-of-range input propagates NaN, which the tick walk treats
// as "stop". setTime(0) first, so a scratch left invalid by a previous caller is reset.
function utcMonthStart(year: number, month: number): number {
	scratchDate.setTime(0);
	scratchDate.setUTCFullYear(year + Math.floor(month / 12), ((month % 12) + 12) % 12, 1);
	return scratchDate.getTime();
}

function startOfMonth(sec: number, offsetSec: number, monthDelta = 0): number {
	scratchDate.setTime((sec + offsetSec) * 1000);
	// Read out before utcMonthStart overwrites the scratch.
	const year = scratchDate.getUTCFullYear();
	const month = scratchDate.getUTCMonth();
	return utcMonthStart(year, month + monthDelta) / 1000 - offsetSec;
}

function startOfYear(sec: number, offsetSec: number, yearDelta = 0): number {
	scratchDate.setTime((sec + offsetSec) * 1000);
	const year = scratchDate.getUTCFullYear();
	return utcMonthStart(year + yearDelta, 0) / 1000 - offsetSec;
}

/**
 * Finest calendar unit {@link splitsForTime} will tick at — a floor, not a fixed step: finer
 * units are skipped outright, and larger visible ranges still widen to coarser ones up the
 * ladder, so a `'month'` axis zoomed out far enough ticks years.
 */
export type SplitsForTimeGranularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

// The units in coarseness order, so a rung can be compared against the requested floor by index.
// The public granularity option is one of these; the ladder below has several rungs per unit
// (a day-unit rung ticking every day, another every four), and a floor keeps the rungs at or
// above its own unit.
const GRANULARITY_ORDER: readonly SplitsForTimeGranularity[] = [
	'day',
	'week',
	'month',
	'quarter',
	'year'
];

// Per-call context the level walkers need beyond the timestamp — kept as one object so a
// new locale/offset knob (like weekStartsOn) is threaded without widening every closure's
// signature.
type SplitContext = { offsetSec: number; weekStartsOn: number };

type RungStep = {
	getInitialValue: (scaleMin: number, ctx: SplitContext) => number;
	getNextValue: (currentValue: number, ctx: SplitContext) => number;
};

type SplitLevel = RungStep & {
	// Which granularity this rung belongs to, for the floor comparison. Several rungs share a
	// unit (every day / every four days are both 'day'), and a rung is coarser than its unit
	// suggests only within it — the ladder stays globally ordered finest → coarsest.
	unit: SplitsForTimeGranularity;
	rangeLimit: number;
};

// The ladder's rungs are built from four aligned-step generators, one per calendar unit. Every
// step is phased to a fixed origin (the epoch for days, the year for months and years, the week
// boundary for weeks) rather than to scaleMin, so the ticks a given zoom level shows do not
// shift as the user pans — the defining property a "round boundary" axis needs.
//
// everyNDays/everyNWeeks are fixed-step arithmetic grids (`anchor + k * step`), the same shape
// stepGrid computes and splitsForCategory reuses, so it is fair to ask why they aren't routed
// through stepGrid to inherit its cap and tolerances. They deliberately are not: month/year steps
// are calendar-irregular (a month is not a fixed number of seconds) and can only be *walked*, so
// all four rungs share one getInitialValue/getNextValue walk driven by the same loop and bounded by
// the same MAX_TICK_CANDIDATES cap. Splitting day/week out to stepGrid would fragment that single
// mechanism into two for no behavioural gain — the cap already gives the walk stepGrid's bound, and
// these integer-second grids have no fractional drift for stepGrid's ulp tolerance to correct.

// Every `n`-th day, counted from the epoch so a 2- or 4-day rung lands on the same days no matter
// where the window sits. n = 1 is a plain day boundary.
function everyNDays(n: number): RungStep {
	return {
		getInitialValue: (scaleMin, ctx) => {
			const dayIndex = Math.floor((scaleMin + ctx.offsetSec) / SECONDS_PER_DAY);
			return Math.ceil(dayIndex / n) * n * SECONDS_PER_DAY - ctx.offsetSec;
		},
		getNextValue: (currentValue) => currentValue + n * SECONDS_PER_DAY
	};
}

// Every `n`-th week from the week boundary `weekStartsOn` selects, phased to a fixed origin (the
// weekly grid through the epoch) so a 2-week rung lands on the same weeks no matter where the
// window sits — the same fixed-origin property everyNDays gets by counting day indices from the
// epoch. Phasing to `startOfWeek(scaleMin)` instead tied the parity to scaleMin's own week, so a
// one-week pan slid every 2-week tick. n = 1 is a plain week, for which the phase is a no-op.
function everyNWeeks(n: number): RungStep {
	return {
		getInitialValue: (scaleMin, ctx) => {
			const weekStart = startOfWeek(scaleMin, ctx.offsetSec, ctx.weekStartsOn);
			// referenceWeek and weekStart are both boundaries on the same weekly grid, so their
			// difference is an exact multiple of a week; Math.round only clears the division's
			// float dust. Ceiling the index to a multiple of n mirrors everyNDays exactly, and for
			// n = 1 collapses back to weekStart (the boundary at or before scaleMin).
			const referenceWeek = startOfWeek(0, ctx.offsetSec, ctx.weekStartsOn);
			const weekIndex = Math.round((weekStart - referenceWeek) / SECONDS_PER_WEEK);
			const aligned = Math.ceil(weekIndex / n) * n;
			return referenceWeek + aligned * SECONDS_PER_WEEK;
		},
		getNextValue: (currentValue) => currentValue + n * SECONDS_PER_WEEK
	};
}

// Every `n`-th month, counted from the start of a year so the rung lands on round month starts:
// n = 2 gives Jan/Mar/May…, n = 3 (a quarter) Jan/Apr/Jul/Oct, n = 6 Jan/Jul.
function everyNMonths(n: number): RungStep {
	return {
		getInitialValue: (scaleMin, ctx) => {
			scratchDate.setTime((scaleMin + ctx.offsetSec) * 1000);
			const monthIndex = scratchDate.getUTCFullYear() * 12 + scratchDate.getUTCMonth();
			const aligned = Math.ceil(monthIndex / n) * n;
			return utcMonthStart(Math.floor(aligned / 12), aligned % 12) / 1000 - ctx.offsetSec;
		},
		getNextValue: (currentValue, ctx) => startOfMonth(currentValue, ctx.offsetSec, n)
	};
}

// Every `n`-th year, phased so the rung lands on round years: n = 10 gives decades (…2020, 2030),
// n = 100 centuries.
function everyNYears(n: number): RungStep {
	return {
		getInitialValue: (scaleMin, ctx) => {
			scratchDate.setTime((scaleMin + ctx.offsetSec) * 1000);
			const year = Math.ceil(scratchDate.getUTCFullYear() / n) * n;
			return utcMonthStart(year, 0) / 1000 - ctx.offsetSec;
		},
		getNextValue: (currentValue, ctx) => startOfYear(currentValue, ctx.offsetSec, n)
	};
}

// The granularity an omitted or unrecognized option resolves to — the finest, so the default
// axis can tick at any scale.
const DEFAULT_GRANULARITY: SplitsForTimeGranularity = 'day';

// Unix seconds, matching uPlot's own default for the option this mirrors.
const DEFAULT_MS = 1e-3;

// Decimal decades, matching uPlot's own default `log`.
const DEFAULT_BASE = 10;

// The coarsest rung, hoisted so the range lookup below has a total fallback the compiler can see
// is defined — its Infinity limit means the lookup never actually misses.
const COARSEST_RUNG: SplitLevel = { unit: 'year', rangeLimit: Infinity, ...everyNYears(100) };

// The widening ladder, finest → coarsest. The splits function keeps the rungs at or above the
// requested granularity, then picks the first whose rangeLimit covers the visible range — so
// every tick lands on a round calendar boundary and the tick count stays roughly 4–14 across
// every zoom, with no rung more than ~2x sparser than the one before it. The intermediate rungs
// (2- and 4-day, 2-week, 2-month, half-year, and the 2/5/10/25/50/100-year rungs) exist to keep
// those crossovers gradual: a bare day/week/month/quarter/year ladder collapses from a dense axis
// to two or three ticks the moment the range crosses a limit, and stops widening past a few years.
// The limits are in seconds; `rangeLimit` is the largest visible range the rung still handles.
const SPLIT_LEVELS: SplitLevel[] = [
	{ unit: 'day', rangeLimit: SECONDS_PER_DAY * 8, ...everyNDays(1) },
	{ unit: 'day', rangeLimit: SECONDS_PER_DAY * 18, ...everyNDays(2) },
	{ unit: 'day', rangeLimit: SECONDS_PER_DAY * 36, ...everyNDays(4) },
	{ unit: 'week', rangeLimit: SECONDS_PER_DAY * 55, ...everyNWeeks(1) },
	{ unit: 'week', rangeLimit: SECONDS_PER_DAY * 110, ...everyNWeeks(2) },
	{ unit: 'month', rangeLimit: SECONDS_PER_DAY * 200, ...everyNMonths(1) },
	{ unit: 'month', rangeLimit: SECONDS_PER_DAY * 400, ...everyNMonths(2) },
	{ unit: 'quarter', rangeLimit: SECONDS_PER_DAY * 800, ...everyNMonths(3) },
	{ unit: 'quarter', rangeLimit: SECONDS_PER_DAY * 1600, ...everyNMonths(6) },
	{ unit: 'year', rangeLimit: APPROXIMATE_YEAR * 13, ...everyNYears(1) },
	{ unit: 'year', rangeLimit: APPROXIMATE_YEAR * 26, ...everyNYears(2) },
	{ unit: 'year', rangeLimit: APPROXIMATE_YEAR * 65, ...everyNYears(5) },
	{ unit: 'year', rangeLimit: APPROXIMATE_YEAR * 130, ...everyNYears(10) },
	{ unit: 'year', rangeLimit: APPROXIMATE_YEAR * 330, ...everyNYears(25) },
	{ unit: 'year', rangeLimit: APPROXIMATE_YEAR * 650, ...everyNYears(50) },
	COARSEST_RUNG
];

export interface SplitsForTimeOptions {
	/**
	 * Finest granularity the axis's own data resolution justifies — e.g. a chart
	 * aggregated to monthly buckets should pass `'month'` so ticks never land inside a
	 * bucket. Finer levels (day/week) are skipped; coarser ones (year) still kick in
	 * once the visible range grows large enough.
	 *
	 * A value outside the union — reachable from JavaScript, or from a config string
	 * typed through a cast — warns once and falls back to the default rather than
	 * throwing, so a stale value in saved config costs a denser axis, not the chart.
	 * @default 'day'
	 */
	granularity?: SplitsForTimeGranularity;
	/**
	 * Unit the axis's own timestamps are in, with the same meaning and the same two values
	 * as uPlot's top-level `ms` option: `1e-3` for Unix seconds, `1` for milliseconds.
	 * Pass whatever was passed to uPlot — a millisecond axis left at the seconds default
	 * reads every timestamp as ~1000x further from the epoch than it is, putting the ticks
	 * tens of thousands of years out.
	 * @default 1e-3 — Unix seconds, matching uPlot's own default
	 */
	ms?: 1e-3 | 1;
	/**
	 * Fixed UTC offset, in seconds, used only to place calendar boundaries (day/week/
	 * month/year starts) — axis values themselves stay in the unit `ms` declares. Match
	 * this to the `offsetSec` passed to `timeRegions` so both agree on where a day starts.
	 * @default 0
	 */
	offsetSec?: number;
	/**
	 * Day of week a `'week'`-granularity tick starts on, `0` = Sunday … `6` = Saturday.
	 * Set to `1` for ISO-8601 / European Monday-start weeks.
	 * @default 0
	 */
	weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * Builds a uPlot `axis.splits` function that ticks a time axis on round calendar
 * boundaries (day/week/month/quarter/year starts) instead of uPlot's evenly-spaced
 * default, widening to a coarser step as the visible range grows.
 *
 * Axis values are read as Unix seconds by default; a millisecond axis must say so with
 * `ms: 1`, the same value uPlot itself takes, or every boundary lands millennia away.
 *
 * Ticks are exactly the calendar boundaries that fall inside the visible range, with no
 * exceptions — like uPlot's own default splits, no range-edge ticks are injected, so every
 * label is a real boundary. Density is governed entirely by the widening ladder (a
 * day-granularity axis shows daily ticks only up to ~10 days, then weekly, monthly, and so
 * on) — the crossover widths are fixed, and neither `axis.space` nor the `foundIncr` /
 * `foundSpace` uPlot passes in has any effect on the result. Wrap with
 * {@link splitsWithLimit} to cap the label count instead.
 *
 * A range too narrow to contain any boundary of the chosen granularity (e.g. an intraday
 * zoom at day granularity, or a zero-width range from single-point data that doesn't sit on
 * a boundary) therefore yields no ticks at all. Wrap with {@link splitsWithEdges} to fall
 * back to the range edges instead of a blank axis:
 * `splitsWithEdges(splitsForTime({ granularity: 'day' }))`.
 *
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { splitsForTime } from 'uplot-kit';
 *
 * const DAY = 24 * 60 * 60;
 * const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds
 * const data: uPlot.AlignedData = [
 *   [start, start + DAY, start + 2 * DAY, start + 3 * DAY],
 *   [12, 18, 9, 21]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'value' }],
 *   axes: [{ splits: splitsForTime({ granularity: 'day' }) }, {}]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export function splitsForTime(options: SplitsForTimeOptions = {}): SplitsFn {
	const {
		granularity: rawGranularity = DEFAULT_GRANULARITY,
		ms: rawMs = DEFAULT_MS,
		offsetSec: rawOffsetSec = 0,
		weekStartsOn: rawWeekStartsOn = 0
	} = options;
	const warn = makeWarnOnce('splitsForTime');

	// A granularity outside the union has no "nothing to tick" reading the way a non-positive
	// step does, so picking a rung for it is a guess rather than a degenerate answer. Left
	// silent, the guess was the *finest* rung — the opposite of what a caller asking for a
	// coarse granularity wanted, so a typo like 'Month' quietly restored the intra-bucket ticks
	// the option exists to suppress.
	const granularity = optionOr(
		warn,
		'granularity',
		rawGranularity,
		GRANULARITY_ORDER.includes(rawGranularity),
		`one of ${GRANULARITY_ORDER.map((unit) => `'${unit}'`).join(', ')}`,
		DEFAULT_GRANULARITY
	);
	// Keep the rungs at or above the requested unit — the floor. 'day' keeps them all.
	const floorRank = GRANULARITY_ORDER.indexOf(granularity);
	const levels = SPLIT_LEVELS.filter((level) => GRANULARITY_ORDER.indexOf(level.unit) >= floorRank);

	// Sunday-relative day index, so anything but a whole 0..6 describes no week start at all —
	// and a fractional one is the dangerous shape, since it shifts every tick by a fraction of a
	// day and produces a plausible-looking axis of Monday-at-noon boundaries.
	const weekStartsOn = optionOr(
		warn,
		'weekStartsOn',
		rawWeekStartsOn,
		Number.isInteger(rawWeekStartsOn) && rawWeekStartsOn >= 0 && rawWeekStartsOn <= 6,
		'a whole number from 0 (Sunday) to 6 (Saturday)',
		0
	);
	// A non-finite offsetSec is the one option knob that can NaN-poison the whole calendar walk:
	// every getInitialValue divides by or adds it, so a NaN makes the first candidate non-finite,
	// the walk's finiteness guard stops immediately, and the axis goes blank with no word — the
	// silent failure this file guards against everywhere else. Any finite offset is legal (it need
	// not be a whole number of seconds), so only finiteness is checked.
	const offsetSec = optionOr(
		warn,
		'offsetSec',
		rawOffsetSec,
		Number.isFinite(rawOffsetSec),
		'a finite number of seconds',
		0
	);
	const ctx: SplitContext = { offsetSec, weekStartsOn };

	// Axis units per second, derived the same way uPlot derives its own: it reads a timestamp
	// as `new Date(value / ms)` milliseconds, so a second is `1000 * ms` axis units — exactly
	// 1 for the seconds default (`1000 * 1e-3` is exact) and 1000 for a millisecond axis.
	// Every calendar boundary below is computed in seconds, the one unit the helpers and the
	// widening ladder are written in; the axis's own unit enters only here and on the way out.
	//
	// Every bound is divided by this, so a zero or non-finite one would turn the whole range
	// into NaN and every tick into nonsense. What is checked is the arithmetic, not uPlot's
	// two-value enum: any finite positive unit keeps the math well-defined, so a caller ahead
	// of uPlot on units is not blocked for the sake of it.
	const ms = optionOr(
		warn,
		'ms',
		rawMs,
		isPositiveFinite(rawMs),
		'finite and positive',
		DEFAULT_MS
	);
	const unitsPerSec = 1000 * ms;

	return (_self, _axisIdx, scaleMin, scaleMax) => {
		if (!isTickable(scaleMin, scaleMax)) {
			return [];
		}

		const minSec = scaleMin / unitsPerSec;
		const maxSec = scaleMax / unitsPerSec;
		const range = maxSec - minSec;
		// The coarsest rung's rangeLimit is Infinity, so for any finite `range` the lookup
		// matches and the fallback is dead weight the compiler nonetheless needs. `range` is
		// finite for every unit a caller can realistically pass — isTickable has rejected
		// non-finite bounds and the `ms` guard above has rejected a zero or non-finite scale —
		// but a denormal-small unit can still overflow the division, so the fallback stays a
		// real backstop rather than a formality.
		const level = levels.find((candidate) => range <= candidate.rangeLimit) ?? COARSEST_RUNG;

		// Walk the calendar boundaries: start at the rung's boundary at or before minSec and
		// advance by its own irregular step until past maxSec. The arithmetic generators go
		// through stepGrid() instead, whose even step is drift-free; a calendar step is not, so
		// it is walked rather than indexed.
		//
		// The walk shares the same MAX_TICK_CANDIDATES cap as the arithmetic generators. The
		// finiteness guard alone is not enough: it was thought to be, on the reasoning that
		// getNextValue's Date math returns NaN past the ±271821-year edge of Date's range within a
		// few thousand steps — but that only holds for the month/year rungs, which round-trip
		// through Date. everyNDays/everyNWeeks are pure number addition and never touch Date, so a
		// large-but-finite offsetSec can, through catastrophic cancellation in `scaleMin +
		// offsetSec`, decouple the start from maxSec and leave the finiteness guard walking millions
		// of finite day-steps on every redraw. The cap turns that into a bounded walk with one loud
		// warning, exactly as it does for a degenerate arithmetic grid. (A rung finer than a day —
		// an 'hour'/'minute' granularity — would emit 10000 finite candidates over a perfectly valid
		// range and needs the cap for that ordinary reason too.)
		// A non-finite *first* boundary is the one empty result that is not a legitimate "no
		// boundary in this window". It means the rung's Date math produced NaN — which happens
		// when minSec sits past the ±271821-year edge of Date's range, and the overwhelmingly
		// common way to land there is a unit mismatch: nanosecond (or microsecond) timestamps read
		// against the seconds/ms `ms` default sit ~1000x too far from the epoch. Left alone the
		// walk stops at zero iterations and the axis goes blank with no word — the silent failure
		// this file warns against everywhere else. An intraday zoom, by contrast, yields a *finite*
		// first boundary that merely falls outside [minSec, maxSec]; that stays silent, as its
		// documented remedy is splitsWithEdges, not a fix to the input.
		const firstBoundary = level.getInitialValue(minSec, ctx);
		if (!Number.isFinite(firstBoundary)) {
			warn(
				'the visible range maps to no finite calendar boundary — timestamps this far from ' +
					'the epoch usually mean the axis is in a finer unit than ms declares (pass the ' +
					'same ms you passed uPlot, e.g. ms: 1 for millisecond timestamps)'
			);
			return [];
		}

		const collector = makeCollector(warn);
		for (
			let value = firstBoundary;
			Number.isFinite(value) && value <= maxSec;
			value = level.getNextValue(value, ctx)
		) {
			if (!collector.push(value)) {
				break;
			}
		}
		const boundaries = collector.values;

		// Not normalize(): the walk is strictly ascending and unique by construction, so its
		// dedupe and sort are dead work, and the only part that isn't — the lower clamp — is one
		// comparison. The clamp is genuinely needed, and for more than the first value: a rung
		// starts at the boundary at or before scaleMin, and a coarse one can take several steps
		// to reach it (a quarter rung entering a range in November walks Jan, Apr, Jul, Oct
		// first). The upper end needs nothing, the walk having already stopped at maxSec.
		//
		// Scaling by 1 is exact, so the seconds path costs nothing for sharing this loop.
		const result: number[] = [];
		for (const value of boundaries) {
			if (value >= minSec) {
				// An even-day/week rung phased across the epoch starts at `-0` (Math.ceil(-1/n)), which
				// survives the multiply and formats as "-0".
				result.push(withoutNegativeZero(value * unitsPerSec));
			}
		}
		return result;
	};
}

// --- splitsForLog ---

export interface SplitsForLogOptions {
	/**
	 * Log-scale base — `10` for decimal decades (matching uPlot's default `distr: 3` /
	 * `log: 10`), `2` for binary decades (`log: 2`).
	 * @default 10
	 */
	base?: 10 | 2;
	/**
	 * Also emit interior (non-power-of-`base`) ticks within each decade, not just the
	 * decade boundary itself.
	 * @default false
	 */
	minor?: boolean;
	/**
	 * Mantissas multiplied onto each decade to produce interior ticks when `minor` is
	 * set — e.g. `[2, 5]` for a sparser 1-2-5 minor grid instead of every integer. Fractional
	 * values are placed exactly, which `base: 2` requires: no integer lies between 1 and 2.
	 * The array is copied once, so mutating it afterwards leaves a built axis alone.
	 * @default `[2, 3, 4, 5, 6, 7, 8, 9]` for `base: 10`; `[]` (no interior ticks) for `base: 2`
	 */
	minorMantissas?: number[];
}

/**
 * Builds a uPlot `axis.splits` function for a logarithmic axis (`scale.distr: 3`), ticking
 * one point per decade of the configured base, with optional interior (minor) ticks.
 *
 * What this adds over uPlot's built-in log handling is control over which ticks *exist*.
 * uPlot already emits every integer mantissa in every decade and then blanks most of the
 * labels through `axis.filter` — the splits survive, so their gridlines and tick marks
 * render. So the default here (`minor: false`) is *sparser* than uPlot's own axis, not
 * denser: it is how you get a decade-only grid. `minorMantissas` covers the other case a
 * label-only filter cannot express — a thinned interior grid such as `[2, 5]`.
 *
 * Values at or below zero are outside a log scale's domain and produce no ticks (an empty
 * array), since `0` and negative values have no defined position on a log axis. With
 * `minor: false`, a range too narrow to contain a decade (including a zero-width range that
 * isn't itself a power of `base`) likewise yields nothing; wrap with {@link splitsWithEdges}
 * for a range-edge fallback. Minor ticks are placed per decade whether or not the decade
 * boundary itself is in range, so a `minor: true` axis still ticks inside a sub-decade zoom.
 *
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { splitsForLog } from 'uplot-kit';
 *
 * const start = Date.UTC(2026, 0, 1) / 1000;
 * const data: uPlot.AlignedData = [
 *   [start, start + 60, start + 120, start + 180, start + 240],
 *   [1.5, 12, 130, 900, 4200] // strictly positive — a log scale has no place for 0
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'response time' }],
 *   scales: { y: { distr: 3, log: 10 } },
 *   axes: [{}, { splits: splitsForLog({ base: 10, minor: true }) }]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export function splitsForLog(options: SplitsForLogOptions = {}): SplitsFn {
	const { base: rawBase = DEFAULT_BASE, minor = false, minorMantissas } = options;
	const warn = makeWarnOnce('splitsForLog');
	// What is rejected is arithmetic nonsense, not uPlot's `10 | 2`: a base of 1 makes the decade
	// walk divide by log(1) === 0, and 0 or Infinity make `base ** power` collapse to a single
	// bogus tick at 1. A base the type forbids but the sweep handles (3, say) is left alone —
	// it produces a correct base-3 grid, which is at worst mismatched with the scale's own
	// transform, and that is visible at a glance rather than silent.
	const base = optionOr(
		warn,
		'base',
		rawBase,
		Number.isFinite(rawBase) && rawBase > 1,
		'a finite number greater than 1',
		DEFAULT_BASE
	);
	// The minor default keys off the *validated* base, not rawBase: an invalid base falls back to
	// 10, and the 1-2-…-9 default is exactly what a base-10 axis wants, so reading rawBase here
	// (which would be `!== 10` for the bad value) contradicted the fallback and silently produced a
	// decade-only axis. An explicit [] is honoured; only an omitted option takes the base default.
	// Copied, because the array is read on every redraw but supplied once: without this, a caller
	// who keeps their own reference and mutates it later silently rewrites an already-built axis.
	// Built only when minor ticks are actually emitted — the default minor:false path never reads
	// it, so allocating and pinning the default 1-2-…-9 array there is pure waste.
	const mantissas = minor
		? [...(minorMantissas ?? (base === 10 ? [2, 3, 4, 5, 6, 7, 8, 9] : []))]
		: [];
	// base is fixed at factory time, so its log is too — hoisted out of the per-redraw closure
	// below, where it was recomputed on every draw.
	const logBase = Math.log(base);

	return (_self, _axisIdx, scaleMin, scaleMax) => {
		if (!isTickable(scaleMin, scaleMax) || scaleMin <= 0) {
			return [];
		}

		const firstPower = Math.floor(Math.log(scaleMin) / logBase);
		const lastPower = Math.ceil(Math.log(scaleMax) / logBase);

		// How many decades the sweep would visit is arithmetic, so it is asked before walking, the
		// same way stepGrid asks its tick count. A base near 1 (the guard admits any base > 1) makes
		// a decade a hair wide, so an ordinary range spans tens of thousands of them: the walk would
		// then push ~10000 near-identical ticks into a sliver of the axis and fire the candidate cap,
		// handing back a low-end prefix that still looks like a real axis — the failure stepGrid
		// refuses rather than truncates. Refuse on the same rule. A base of 2 or 10 spans at most
		// ~2100 decades across the entire double range, so this only ever bites a pathological base.
		if (lastPower - firstPower + 1 > MAX_TICK_CANDIDATES) {
			warn(
				`the range spans more than ${MAX_TICK_CANDIDATES} decades at base ${base} — ` +
					'use a base further from 1, or narrow the range'
			);
			return [];
		}

		const collector = makeCollector(warn);
		for (let power = firstPower; power <= lastPower; power++) {
			const decade = base ** power;
			const values = [decade];
			if (minor) {
				// Scaling a mantissa into a decade is inexact at both ends of the range — 9 * 0.001
				// is 0.009000000000000001, 3 * 1e23 is 2.9999999999999997e+23 — and the error is
				// always in the last significant digit, never at a fixed decimal place. Rounding by
				// significant digits therefore fixes every decade with one rule, including the two
				// bands where counting decimals cannot help at all: past 1e15 there are no decimals
				// left to round to, and below 1e-15 there are more than a double can carry.
				for (const mantissa of mantissas) {
					values.push(roundSignificant(mantissa * decade));
				}
			}
			// every() short-circuits on the first refusal, so a decade that trips the cap stops
			// mid-batch instead of overshooting it.
			if (!values.every((value) => collector.push(value))) {
				break;
			}
		}

		// minor:false emits one base**power per ascending power — already sorted and unique, so it
		// needs only the clamp, not normalize()'s Set and sort. minor:true can arrive out of order
		// or with duplicates when a caller-supplied mantissa reaches or crosses `base`, so it takes
		// the full pass.
		return minor
			? normalize(collector.values, scaleMin, scaleMax)
			: clampToRange(collector.values, scaleMin, scaleMax);
	};
}

// --- splitsForStep ---

export interface SplitsForStepOptions {
	/**
	 * Fixed spacing between ticks, in axis units. Required and has no default — a grid with
	 * no spacing is not a grid; a value that is not finite and positive warns once and ticks
	 * nothing.
	 */
	step: number;
	/**
	 * Axis value the tick grid is phased against — ticks land at `anchor + k * step`
	 * for integer `k`, so buckets whose origin isn't a round axis value (e.g. hourly
	 * candles from a session opening at 09:30) still tick on-bucket. Only an anchor
	 * that is *not* a whole multiple of `step` shifts the grid: quarter-hour wall-clock
	 * times are already on a 900s grid, so anchoring 15-minute candles to 09:30 is a
	 * no-op.
	 * @default 0
	 */
	anchor?: number;
}

/**
 * Builds a uPlot `axis.splits` function that ticks strictly on multiples of a fixed step
 * from an anchor — the `axis.splits` counterpart to pinning `axis.incrs` to one step, for
 * axes where the tick *position* (not just the allowed step size) must land exactly on
 * bucket boundaries, e.g. candle charts whose session doesn't start on a round wall-clock
 * value.
 *
 * Only real grid positions are emitted, so a range containing none — including a zero-width
 * range whose single value is off-grid — yields no ticks; wrap with {@link splitsWithEdges}
 * for a range-edge fallback.
 *
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { splitsForStep } from 'uplot-kit';
 *
 * const HOUR = 60 * 60;
 * // a session opening at 09:30 — half an hour off the round wall-clock grid
 * const open = Date.UTC(2026, 0, 2, 9, 30) / 1000;
 * const data: uPlot.AlignedData = [
 *   [open, open + HOUR, open + 2 * HOUR, open + 3 * HOUR],
 *   [101.2, 103.8, 102.4, 105.1]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'close' }],
 *   // hourly ticks landing on 09:30, 10:30, 11:30 … instead of on round hours
 *   axes: [{ splits: splitsForStep({ step: HOUR, anchor: open }) }, {}]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export function splitsForStep(options: SplitsForStepOptions): SplitsFn {
	const { step, anchor: rawAnchor = 0 } = options;
	const warn = makeWarnOnce('splitsForStep');

	// The one option here with no default to fall back to — a grid without a spacing is not a
	// grid — so an unusable step gives a function that ticks nothing, said once, rather than a
	// guess. A blank axis with no explanation is the most expensive failure in this file to
	// track down, and it was the one a plain `step: 0` used to produce.
	if (!isPositiveFinite(step)) {
		warn(`step must be a finite number greater than zero, got ${JSON.stringify(step)} — no ticks`);
		return () => [];
	}

	// anchor does have a default (0), so unlike step it falls back rather than blanking the axis.
	// It is validated here so a non-finite anchor is named for what it is: left unchecked it flowed
	// into stepGrid's magnitude guard (magnitude becomes Infinity) and tripped the "step is too
	// small" warning, blaming a perfectly valid step for anchor's fault.
	const anchor = optionOr(
		warn,
		'anchor',
		rawAnchor,
		Number.isFinite(rawAnchor),
		'a finite number',
		0
	);

	// A tick is only ever as precise as the two numbers that define the grid, so rounding to
	// whichever of them carries more decimals removes float noise without moving a tick the
	// caller could have written down themselves.
	const digits = Math.max(fractionDigits(step), fractionDigits(anchor));

	return (_self, _axisIdx, scaleMin, scaleMax) => {
		if (!isTickable(scaleMin, scaleMax)) {
			return [];
		}

		// Not re-normalized: stepGrid already returns an ascending, unique, in-range grid, and
		// normalize()'s clamp would re-test its rounded ticks against the raw bounds.
		return stepGrid(anchor, step, digits, scaleMin, scaleMax, makeCollector(warn));
	};
}

// --- splitsForCategory ---

export interface SplitsForCategoryOptions {
	/**
	 * Total number of categories on the axis. When set, ticks are clamped to the valid
	 * index range `[0, count - 1]`, so a scale wider than the data — an explicit
	 * `scales.x.range`, or an ordinal y scale, which uPlot does pad — gets no ticks in the
	 * region past the last category. A value that is not a whole count warns once and is
	 * ignored.
	 * @default undefined — no clamping beyond the visible scale range
	 */
	count?: number;
	/**
	 * Emit every Nth category index instead of every index, e.g. `2` to label every
	 * other bar on a dense category axis. Must be a positive whole number — category
	 * indices are whole numbers, so a fractional step describes no tick that any category
	 * sits behind; one warns once and falls back to the default.
	 * @default 1
	 */
	step?: number;
}

/**
 * Builds a uPlot `axis.splits` function for a category/ordinal axis (`scale.distr: 2`),
 * ticking on integer indices — every category by default, or every `step`-th one to
 * thin a dense axis. Pass `count` (the number of categories) so ticks never land in the
 * padded region past the last real category.
 *
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { splitsForCategory } from 'uplot-kit';
 *
 * const categories = ['mon', 'tue', 'wed', 'thu', 'fri'];
 * // an ordinal x holds the category values themselves; uPlot's AlignedData is typed
 * // numerically, so the cast is unavoidable here
 * const data = [categories, [12, 18, 9, 21, 15]] as unknown as uPlot.AlignedData;
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'value' }],
 *   // time: false — an ordinal x is not timestamps, and uPlot's default would format
 *   // the legend value as a 1970 date
 *   scales: { x: { distr: 2, time: false } },
 *   axes: [
 *     {
 *       splits: splitsForCategory({ count: categories.length }),
 *       // uPlot maps ordinal splits through data[0] before calling `values`, so `ticks`
 *       // already holds the category values — indexing `categories` again would blank them
 *       values: (_u, ticks) => ticks.map(String)
 *     },
 *     {}
 *   ]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export function splitsForCategory(options: SplitsForCategoryOptions = {}): SplitsFn {
	const { count: rawCount, step: rawStep = 1 } = options;
	const warn = makeWarnOnce('splitsForCategory');
	// Category indices are whole numbers by construction, so a fractional step describes no
	// reachable tick — and the grid never needs the decimal rounding the other generators do.
	const step = optionOr(
		warn,
		'step',
		rawStep,
		Number.isInteger(rawStep) && rawStep > 0,
		'a positive whole number of category indices',
		1
	);
	// `count` is a cardinality, so a fractional or non-finite one describes no set of categories.
	// Unlike the others its fallback is "unset", which is a real setting here — no clamping —
	// rather than a substitute value, so it does not go through optionOr.
	let count = rawCount;
	if (count !== undefined && !(Number.isInteger(count) && count >= 0)) {
		warn(
			`count must be a whole number of categories, got ${JSON.stringify(count)} — ` +
				'ignoring it, so ticks are clamped to the visible range only'
		);
		count = undefined;
	}

	return (_self, _axisIdx, scaleMin, scaleMax) => {
		// `count` clamps the tick range to the real category indices. uPlot does not pad an
		// ordinal x scale, so by default scaleMin/scaleMax are already [0, count - 1] and this is
		// a no-op; it earns its keep only where the scale is wider than the data — an explicit
		// `scales.x.range`, or an ordinal y scale, which uPlot does pad.
		const lowerBound = count === undefined ? scaleMin : Math.max(scaleMin, 0);
		const upperBound = count === undefined ? scaleMax : Math.min(scaleMax, count - 1);
		if (!isTickable(lowerBound, upperBound)) {
			return [];
		}

		// Category indices are the zero-anchored case of splitsForStep's own grid.
		return stepGrid(0, step, 0, lowerBound, upperBound, makeCollector(warn));
	};
}

// --- Decorators (SplitsFn => SplitsFn) ---

/**
 * Wraps a `SplitsFn` so its output always includes the given values — e.g. a zero baseline
 * or an alert threshold — in addition to whatever the inner function ticks. The result is
 * deduplicated and sorted, and the injected values are clamped to the visible range: one outside
 * it is dropped rather than extending the axis, so pin the scale (`scales.y.range`) if a
 * threshold must stay visible while the user zooms. The inner function's own ticks are passed
 * through as it emitted them.
 *
 * The clamp is to the visible range `[scaleMin, scaleMax]` only, not to any narrower domain the
 * inner generator enforces for its *own* ticks. On a `splitsForCategory({ count })` axis whose
 * scale runs wider than the data, an injected value in the padding past the last category (an
 * index `>= count`) is kept as given — `splitsForCategory` clamps only the ticks it generates, not
 * the ones you inject. Pin the scale to the category range (`scales.x.range: [0, count - 1]`), or
 * don't inject out-of-domain indices, if a stray tick beyond the last category would mislead.
 *
 * `values` is read on every redraw but copied once, so mutating the array afterwards does not
 * change an axis already built from it.
 *
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { splitsForStep, splitsWithInclude } from 'uplot-kit';
 *
 * const ERROR_BUDGET = 99.9;
 * const start = Date.UTC(2026, 0, 1) / 1000;
 * const data: uPlot.AlignedData = [
 *   [start, start + 3600, start + 7200, start + 10800],
 *   [99.98, 99.72, 99.94, 100]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'availability' }],
 *   scales: { y: { range: [99, 100] } },
 *   axes: [{}, { splits: splitsWithInclude(splitsForStep({ step: 0.25 }), [ERROR_BUDGET]) }]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export function splitsWithInclude(inner: SplitsFn, values: number[]): SplitsFn {
	// Copied for the same reason splitsForLog copies its mantissas: read every redraw, supplied
	// once, so a caller's later mutation must not reach back into a built axis.
	const injected = [...values];
	return (self, axisIdx, scaleMin, scaleMax, foundIncr, foundSpace) =>
		mergeTicks(
			inner(self, axisIdx, scaleMin, scaleMax, foundIncr, foundSpace),
			injected,
			scaleMin,
			scaleMax
		);
}

/**
 * Wraps a `SplitsFn` so it never returns more than `maxTicks` ticks, thinning evenly (keeping
 * every k-th tick) when the inner function returns more — a guard against overlapping labels
 * on a dense axis. `maxTicks` is a count, not a measured label pixel width; pair with
 * `axis.rotate` or a shorter label formatter for tight spaces.
 *
 * Even spacing is preserved in preference to hitting `maxTicks` exactly: the result keeps every
 * k-th tick for the smallest k that fits under the limit, so a tick set only slightly over it
 * can thin well below (11 ticks with `maxTicks: 10` gives 6, at k = 2). A fractional value is
 * floored, so a measured `plotWidth / labelWidth` needs no rounding at the call site. A value
 * that isn't a usable number — `NaN` from a not-yet-measured label width, or the `undefined` /
 * `null` a JS caller passes for the same reason — means the limit is unknown, not that nothing
 * fits, and passes the inner ticks through, as does an explicit `Infinity`. A value below one —
 * `-Infinity` and zero included — yields no ticks.
 *
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { splitsForTime, splitsWithLimit } from 'uplot-kit';
 *
 * // two decades of yearly samples: the ladder has already widened to year ticks, and the
 * // limit thins those 21 down to every other one
 * const data: uPlot.AlignedData = [
 *   Array.from({ length: 21 }, (_, i) => Date.UTC(2006 + i, 0, 1) / 1000),
 *   Array.from({ length: 21 }, (_, i) => 100 + ((i * 7) % 23))
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'value' }],
 *   axes: [{ splits: splitsWithLimit(splitsForTime({ granularity: 'day' }), 12) }, {}]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export function splitsWithLimit(inner: SplitsFn, maxTicks: number): SplitsFn {
	// maxTicks is closed over, so how it classifies never changes across redraws — resolved once
	// here rather than re-tested on every frame, the same principle the generators follow for their
	// own options.
	//
	// "Not measured yet" is not "show nothing", so an unusable limit passes the ticks through
	// unthinned rather than blanking the axis. It arrives spelled three ways: `NaN` from a division
	// that had a zero label width, and — since the caller doing the measuring is often plain JS —
	// `undefined` or `null` from a width that was never assigned. `Infinity` is an explicit no-limit
	// and lands in the same place. `-Infinity` is deliberately not in this company: it orders below
	// every real limit, so it falls through to the "nothing fits" case.
	const unbounded = typeof maxTicks !== 'number' || Number.isNaN(maxTicks) || maxTicks === Infinity;
	// Floored, because a measurement-derived limit is the fractional `plotWidth / labelWidth` and
	// half a label does not fit. Thinning against the raw fraction would bound the result by
	// ceil(maxTicks) instead of maxTicks — 11 ticks under `maxTicks: 2.5` would return 3.
	const limit = Math.floor(maxTicks);

	return (self, axisIdx, scaleMin, scaleMax, foundIncr, foundSpace) => {
		const ticks = inner(self, axisIdx, scaleMin, scaleMax, foundIncr, foundSpace);
		if (unbounded) {
			return ticks;
		}
		if (limit <= 0) {
			return [];
		}
		if (ticks.length <= limit) {
			return ticks;
		}
		const stride = Math.ceil(ticks.length / limit);
		return ticks.filter((_, index) => index % stride === 0);
	};
}

/**
 * Wraps a `SplitsFn`, keeping only the ticks for which `keep` returns `true` — e.g. hiding
 * weekend ticks on a daily time axis, or ticks outside business hours.
 *
 * Distinct from uPlot's own `axis.filter` option: that one only hides tick *labels* (the
 * splits remain, so their gridlines and tick marks still render), while dropping a tick here
 * removes it entirely — label, gridline, and tick mark.
 *
 * Wrap this *outside* {@link splitsWithEdges}, not inside it —
 * `splitsWithEdges(splitsWithFilter(inner, keep))` re-adds the range edges without passing
 * them through `keep`, so on a window the filter empties (a weekend-only zoom, say) the
 * fallback puts back exactly the ticks the filter removed. Wrapping the other way,
 * `splitsWithFilter(splitsWithEdges(inner), keep)`, filters the edges too.
 *
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { splitsForTime, splitsWithFilter } from 'uplot-kit';
 *
 * const isWeekday = (value: number) => {
 *   const day = new Date(value * 1000).getUTCDay();
 *   return day !== 0 && day !== 6;
 * };
 *
 * const DAY = 24 * 60 * 60;
 * const start = Date.UTC(2026, 0, 5) / 1000; // a Monday
 * const data: uPlot.AlignedData = [
 *   Array.from({ length: 8 }, (_, i) => start + i * DAY),
 *   Array.from({ length: 8 }, (_, i) => 10 + ((i * 3) % 7))
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'value' }],
 *   axes: [{ splits: splitsWithFilter(splitsForTime({ granularity: 'day' }), isWeekday) }, {}]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export function splitsWithFilter(
	inner: SplitsFn,
	keep: (value: number, self: uPlot, axisIdx: number) => boolean
): SplitsFn {
	return (self, axisIdx, scaleMin, scaleMax, foundIncr, foundSpace) =>
		inner(self, axisIdx, scaleMin, scaleMax, foundIncr, foundSpace).filter((value) =>
			keep(value, self, axisIdx)
		);
}

export interface SplitsWithEdgesOptions {
	/**
	 * `'whenEmpty'` adds the edges only as a fallback when the inner function returns no
	 * ticks at all — e.g. an intraday zoom under {@link splitsForTime}, where no calendar
	 * boundary falls inside the range. `'always'` appends both edges unconditionally,
	 * merged with the inner function's own ticks (deduplicated, so an edge that's already a
	 * real tick isn't doubled).
	 * @default 'whenEmpty'
	 */
	mode?: 'always' | 'whenEmpty';
}

/**
 * Wraps a `SplitsFn` so the visible range's edges (`scaleMin`, `scaleMax`) are included in
 * its output, guarding against an axis left blank because no "real" tick fell inside a
 * narrow zoom. This is the only place that fallback lives: the generators emit real ticks
 * and nothing else, so any of them (`splitsForTime`, `splitsForLog`, `splitsForStep`, a
 * custom one) opts in through this decorator rather than baking the behavior in.
 *
 * The edges are the raw `scaleMin` / `scaleMax`, so wrap this on a `splitsForCategory` axis
 * only when the scale spans exactly the category indices (uPlot's default ordinal x scale
 * does) — a scale deliberately wider than the data would put an edge in the padding.
 *
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { splitsForTime, splitsWithEdges } from 'uplot-kit';
 *
 * const HOUR = 60 * 60;
 * const start = Date.UTC(2026, 0, 5, 6, 0) / 1000; // 06:00, mid-day
 * const data: uPlot.AlignedData = [
 *   [start, start + HOUR, start + 2 * HOUR, start + 3 * HOUR],
 *   [12, 18, 9, 21]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { label: 'value' }],
 *   // an intraday zoom contains no midnight; show the range edges instead of a blank axis
 *   axes: [{ splits: splitsWithEdges(splitsForTime({ granularity: 'day' })) }, {}]
 * };
 *
 * new uPlot(opts, data, document.body);
 * ```
 */
export function splitsWithEdges(inner: SplitsFn, options: SplitsWithEdgesOptions = {}): SplitsFn {
	const { mode = 'whenEmpty' } = options;
	return (self, axisIdx, scaleMin, scaleMax, foundIncr, foundSpace) => {
		const ticks = inner(self, axisIdx, scaleMin, scaleMax, foundIncr, foundSpace);
		// Both modes go through the same merge, so the two differ only in *when* the edges are
		// added, never in what the decorator guarantees about the result. The empty-inner case is
		// the same call with nothing to merge into.
		if (mode === 'always' || ticks.length === 0) {
			return mergeTicks(ticks, [scaleMin, scaleMax], scaleMin, scaleMax);
		}
		return ticks;
	};
}
