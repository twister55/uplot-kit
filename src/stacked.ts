import type uPlot from 'uplot';

/**
 * Predicate over a series index (1-based — 0 is the x row). What `true` means is defined by the
 * option that takes it — e.g. for {@link StackedDataOptions.omit}, `true` excludes the series
 * from stacking. Typically driven by external series state (legend visibility, focus).
 */
export type SeriesPredicate = (seriesIdx: number) => boolean;

export interface StackedDataOptions {
	/**
	 * Return `true` to exclude series `seriesIdx` from the stack: it keeps its own raw
	 * values (returned as a fresh copy, `null` and `undefined` gaps intact), and — since it
	 * never joins the running total — later series stack as if it weren't there at all.
	 * Typically driven by legend/series visibility state.
	 *
	 * One value is not passed through: `NaN` and `±Infinity` come back as `null`, since uPlot
	 * would read either as a value rather than a gap — see {@link stackedData}.
	 * @default () => false
	 */
	omit?: SeriesPredicate;
}

// The one definition of a gap in this file: a sample's numeric value, or `null` when there is no
// reading — `null`, `undefined`, or anything non-finite. `±Infinity` counts because it is the same
// kind of non-reading as `NaN`, and folded into the running total it would poison that column for
// every series above.
function readingOf(v: number | null | undefined): number | null {
	if (v == null) {
		return null;
	}
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/**
 * Transforms aligned series data for a stacked-area chart: series `i` (1-based —
 * index 0 is the x values) becomes the running sum of series `1..i`, so uPlot can
 * plot each series as the top edge of its own band.
 *
 * A gap — `null`, `undefined` (what `uPlot.join` fills holes with, and what a short row runs out
 * into), or any non-finite number: `NaN` (what typed-array rows use) and `±Infinity` (what a rate
 * divided by zero produces) — counts as 0 toward the running total, so the series above it dip by
 * the missing sample instead of inheriting the gap. The non-finite ones are not gaps to uPlot
 * itself, whose test is `v != null`: left in place, an `Infinity` anywhere in view, or a `NaN` that
 * is the first sample in view, turns the whole scale range into `NaN` and blanks the entire chart —
 * and "first in view" moves with zoom, so the `NaN` case comes and goes. Normalising them here is
 * what keeps that local. A gap's own series holds the running total across it rather than emitting
 * `null`, so every *accumulated* row is dense — a series excluded by {@link
 * StackedDataOptions.omit} keeps its raw gaps and is the one exception.
 *
 * That is the same choice Plotly makes by default for a stacked area (`stackgaps: 'infer zero'`,
 * whose only alternative is `'interpolate'` — there is no "leave a hole" setting), and here it is
 * not a free one: uPlot clips a band's fill by the gaps of the series *below* it, so a hole in one
 * series would erase the filled area of its upper neighbour, which still has data there. Libraries
 * that do show holes in a stack get them by filling every series to the baseline and painting back
 * to front; uPlot fills each band to the previous series' path instead, so that option is closed.
 *
 * The rule is uniform and deliberately does not ask whether a band is actually drawn above a given
 * gap. So a gapped series is drawn as a line lying on its lower neighbour (on the baseline, for the
 * lowest series) instead of breaking, and a column where *no* series has data puts every line on
 * the baseline with its bands collapsed to nothing — both expected, not a failure. For a genuine
 * hole where the topmost *stacked* series has no data — the one place uPlot can render one without
 * erasing anything — write `null` back into that series' own accumulated row wherever its raw row
 * was a gap, which by the definition above is `v == null || !Number.isFinite(v)`, not `null` alone.
 * "Topmost stacked", not "last row": an omitted series sits in the output at its own index without
 * being part of the stack.
 *
 * Two properties of the emitted numbers are worth knowing before reading them back. They are
 * *lossy*: a `0` in an accumulated row means either "the running total here is 0" or "no sample",
 * and nothing distinguishes the two — not for a tooltip, legend or export of yours, and not for
 * uPlot, which treats a gap cell as a sample like any other: it paints a point marker there
 * whenever the series shows points (`points.show`, or on its own once the data is sparse enough),
 * snaps the hover point to it and prints the held total in the legend. Whatever has to tell them
 * apart must read the raw row alongside — the same row, and the same test, the hole recipe above
 * needs. For uPlot's own drawing that is two options: `series.points.filter` returning only the
 * indices whose raw sample is a reading (and `null` when its `show` argument is false), and
 * `cursor.dataIdx` returning `null` for a gap, which hides the hover point and empties that series'
 * legend value.
 *
 * And a gap in the *lowest* series emits a genuine `0`, which uPlot scales like any other value.
 * On a linear y scale the auto-range is therefore pinned to include zero — `[100, 105, null, 102]`
 * ranges 0..105, not 100..105 — which is usually what a stacked area wants anyway, since its areas
 * are read from the baseline. On a log scale (`distr: 3`) the *range* is unaffected, because uPlot
 * ranges log scales over positive values only, but the point still has to be placed: uPlot clamps
 * a non-positive value to one decade below the scale minimum, so the gap plunges off the bottom of
 * the plot area and comes back rather than breaking the path. Give such a scale an explicit
 * `range`, or keep gaps out of the bottom series.
 *
 * Every output row is a fresh array; the input is never mutated.
 *
 * Pair the result with {@link stackedBands} (via `bands` in uPlot options) and each
 * series' own `fill` to render the stacked areas.
 *
 * @param data Aligned data in uPlot's own shape: `[xValues, ...yValues]`.
 * @param options Which series to leave out of the stack; see {@link StackedDataOptions}.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { stackedData, stackedBands } from 'uplot-kit';
 *
 * const raw: uPlot.AlignedData = [
 *   [0, 1, 2],
 *   [1, 2, 3],
 *   [10, 20, 30]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { fill: 'red' }, { fill: 'blue' }],
 *   bands: stackedBands(raw.length)
 * };
 *
 * new uPlot(opts, stackedData(raw), document.body);
 * ```
 */
export function stackedData(
	data: uPlot.AlignedData,
	options: StackedDataOptions = {}
): uPlot.AlignedData {
	const rows: ReadonlyArray<ArrayLike<number | null | undefined>> = data;
	const [xRow, ...yRows] = rows;
	// Only an empty `data` has no x row; there is nothing to stack, so hand it straight back.
	if (xRow === undefined) {
		return data;
	}

	const { omit = () => false } = options;
	const xLen = xRow.length;
	const accum = new Array<number>(xLen).fill(0);

	// Every output row is built to xLen, regardless of the source row's own length, so a
	// row shorter or longer than the x row can never desync the running total or produce
	// a misaligned output row.
	const result = yRows.map((row, i) => {
		const out = new Array<number | null | undefined>(xLen);
		if (omit(i + 1)) {
			// Raw values, with the one translation an excluded series still needs: a non-finite
			// sample becomes `null`. `null` and `undefined` pass through as they are — uPlot already
			// reads both as gaps.
			for (let j = 0; j < xLen; j++) {
				const v = row[j];
				out[j] = v == null ? v : readingOf(v);
			}
			return out;
		}
		// A gap counts as 0, so its cell holds the running total rather than `null` — uPlot would
		// clip the upper neighbour's band by that `null`; the JSDoc says how. Unconditionally so:
		// emitting `null` only where a gap reaches the top of the stack was considered and rejected
		// twice over. No charting library behaves that way, so the result would be unpredictable to
		// everyone who has not read this file; and what counts as the top is decided by which
		// series are banded, so it would silently depend on `stackedBands` getting the same `omit`.
		for (let j = 0; j < xLen; j++) {
			const total = (accum[j] ?? 0) + (readingOf(row[j]) ?? 0);
			accum[j] = total;
			out[j] = total;
		}
		return out;
	});

	return [Array.from(xRow), ...result] as uPlot.AlignedData;
}

export interface StackedBandsOptions {
	/**
	 * Return `true` to exclude series `seriesIdx` from banding: no band is drawn for
	 * it, and it's skipped when looking for the previous series to pair the next
	 * band against — matching the same series {@link stackedData}'s `omit` excluded.
	 * @default () => false
	 */
	omit?: SeriesPredicate;
}

/**
 * Builds the `uPlot.Band[]` for a stacked-area chart: series `i` (1-based) is paired
 * with the nearest preceding, non-omitted series as its lower edge, so uPlot fills
 * the area between each stacked series and the one below it. The bands carry no
 * `fill` of their own — uPlot paints each band from the upper series' own `fill`,
 * clipped to the band, so color stays a per-series choice; set `fill` on a band only
 * to override that.
 *
 * @param seriesCount Total series count, index 0 included (i.e. `data.length` for the
 *   same `uPlot.AlignedData` passed to {@link stackedData}).
 * @param options Which series to leave out of the banding — pass the same `omit` given to
 *   {@link stackedData}; see {@link StackedBandsOptions}.
 * @example
 * ```ts
 * import uPlot from 'uplot';
 * import { stackedData, stackedBands } from 'uplot-kit';
 *
 * const raw: uPlot.AlignedData = [
 *   [0, 1, 2],
 *   [1, 2, 3],
 *   [10, 20, 30]
 * ];
 *
 * const opts: uPlot.Options = {
 *   width: 800,
 *   height: 400,
 *   series: [{}, { fill: 'tomato' }, { fill: 'steelblue' }],
 *   bands: stackedBands(raw.length)
 * };
 *
 * new uPlot(opts, stackedData(raw), document.body);
 * ```
 */
export function stackedBands(seriesCount: number, options: StackedBandsOptions = {}): uPlot.Band[] {
	const { omit = () => false } = options;
	const bands: uPlot.Band[] = [];

	let previousActive = -1;
	for (let seriesIdx = 1; seriesIdx < seriesCount; seriesIdx++) {
		if (omit(seriesIdx)) {
			continue;
		}
		if (previousActive !== -1) {
			bands.push({ series: [seriesIdx, previousActive] });
		}
		previousActive = seriesIdx;
	}

	return bands;
}
