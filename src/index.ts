// uplot-kit — framework-agnostic plugins & utilities for uPlot.
//
// The public API is assembled here as named re-exports, and this barrel is the
// only entry point — `uplot-kit` is the single public specifier. Consumers
// name-import from the root and rely on tree-shaking to drop what they don't use;
// per-plugin subpaths would only earn their keep for no-bundler/CDN consumption.

export {
	incrsByUnit,
	incrsForBits,
	incrsForBytes,
	incrsForGigabytes,
	incrsForIntegers,
	incrsForKilobytes,
	incrsForMegabytes,
	incrsForMicroseconds,
	incrsForMilliseconds,
	incrsForNanoseconds,
	incrsForPetabytes,
	incrsForSeconds,
	incrsForTerabytes,
	incrsLadder,
	incrsStep,
	type IncrsByUnitKind,
	type IncrsOptions,
	type IncrsStepOptions
} from './incrs';

export {
	// generators: Options => SplitsFn
	splitsForCategory,
	splitsForLog,
	splitsForStep,
	splitsForTime,
	// decorators: SplitsFn => SplitsFn
	splitsWithEdges,
	splitsWithFilter,
	splitsWithInclude,
	splitsWithLimit,
	type SplitsFn,
	type SplitsForCategoryOptions,
	type SplitsForLogOptions,
	type SplitsForStepOptions,
	type SplitsForTimeGranularity,
	type SplitsForTimeOptions,
	type SplitsWithEdgesOptions
} from './splits';

export {
	stackedBands,
	stackedData,
	type SeriesPredicate,
	type StackedBandsOptions,
	type StackedDataOptions
} from './stacked';
