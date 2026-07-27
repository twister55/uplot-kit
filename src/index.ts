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
