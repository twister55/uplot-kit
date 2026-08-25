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
	 * values (returned as a fresh copy, `null` gaps intact), and — since it never joins
	 * the running total — later series stack as if it weren't there at all. Typically
	 * driven by legend/series visibility state.
	 * @default () => false
	 */
	omit?: SeriesPredicate;
}

/**
 * Transforms aligned series data for a stacked-area chart: series `i` (1-based —
 * index 0 is the x values) becomes the running sum of series `1..i`, so uPlot can
 * plot each series as the top edge of its own band.
 *
 * A gap — `null`, `undefined` (what `uPlot.join` fills holes with, and what a short
 * row runs out into) or `NaN` (what typed-array rows use) — stays a gap in its own
 * series, emitted as `null` so uPlot draws a hole rather than a line along the top
 * edge of the stack below. It counts as 0 toward the running total, so the series
 * above dip by the missing sample instead of inheriting the gap.
 *
 * A `seriesIdx` excluded via {@link StackedDataOptions.omit} keeps its raw values and is
 * left out of the running total for every series above it.
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
		const seriesIdx = i + 1;
		if (omit(seriesIdx)) {
			return Array.from({ length: xLen }, (_, j) => row[j]);
		}
		return Array.from({ length: xLen }, (_, j) => {
			const v = row[j];
			const n = Number(v);
			// Emitting the running total here would draw the series across the hole, along the
			// top edge of the stack below. `Number(null)` is 0, hence the separate null test.
			if (v == null || Number.isNaN(n)) {
				return null;
			}
			const next = (accum[j] ?? 0) + n;
			accum[j] = next;
			return next;
		});
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
