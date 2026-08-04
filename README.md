# uplot-kit

**Typed, tested, zero-dependency plugins & utilities for [uPlot](https://github.com/leeoniya/uPlot).**

Nice axis ticks, calendar-aware time splits, log/step/category axes and stacked areas — small
composable functions you drop straight into uPlot's own options.

[![status](https://img.shields.io/badge/status-v0.1%20in%20progress-f59e0b?style=flat-square)](#status)
[![npm](https://img.shields.io/npm/v/uplot-kit?style=flat-square&logo=npm&color=cb3837)](https://www.npmjs.com/package/uplot-kit)
[![license](https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square)](./LICENSE)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-22c55e?style=flat-square)](#design-rules-non-negotiable)
[![types](https://img.shields.io/badge/types-TypeScript%20strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](#design-rules-non-negotiable)
[![tests](https://img.shields.io/badge/tests-266%20passing-22c55e?style=flat-square&logo=vitest&logoColor=white)](#status)
[![bundle](https://img.shields.io/badge/whole%20barrel-5.4%20kB%20min%2Bgzip-8b5cf6?style=flat-square)](#size)
[![peer](https://img.shields.io/badge/peer-uPlot%20%5E1.6-ff6b6b?style=flat-square)](https://github.com/leeoniya/uPlot)
[![module](https://img.shields.io/badge/module-ESM%20only-eab308?style=flat-square)](#compatibility)
[![framework](https://img.shields.io/badge/framework-agnostic-64748b?style=flat-square)](#no-framework-code-ever)

## Why

uPlot is fast and tiny, and it deliberately leaves the _judgement calls_ to you: which tick values
count as "round", where a day starts, how a stacked area is assembled. So every uPlot app ends up
re-writing the same handful of `axis.incrs` ladders and `axis.splits` callbacks — usually with a
subtle bug in them.

`uplot-kit` is that layer, extracted from a production charting codebase, stripped of its domain
coupling, documented per option and pinned down by **327 tests**.

```ts
import type uPlot from 'uplot';
import { incrsForBytes, splitsForTime } from 'uplot-kit';

// before — a hand-rolled ladder, an off-by-one on month lengths, and a hung tab waiting
// to happen the day someone passes a sub-microsecond increment
declare const sixtyLinesOfCalendarMath: uPlot.Axis.Splits;

const before: uPlot.Axis[] = [{ splits: sixtyLinesOfCalendarMath }, { incrs: [1, 2, 5, 10] }];

// after
const after: uPlot.Axis[] = [
	{ splits: splitsForTime({ granularity: 'day' }) },
	{ incrs: incrsForBytes() }
];
```

Nothing here is a framework, a wrapper, or a theme. It is uPlot's own option values — built
correctly.

## Status

**v0.1 is in progress and nothing is published to npm yet.** What already exists is not a sketch,
though: three utility modules are implemented, exported from the barrel, and covered by the suite.

| Area                                                                                                            | State                                                |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 🧮 `incrs` — nice increment ladders                                                                             | ✅ **Done** — 12 exports, incl. 9 unit facades       |
| 📐 `splits` — axis tick generators                                                                              | ✅ **Done** — 4 generators + 4 composable decorators |
| 🧱 `stacked` — stacked-area helpers                                                                             | ✅ **Done** — `stackedData` + `stackedBands`         |
| 🔌 Plugins (`autosize`, `axisSync`, `timeRegions`, `verticalMarker`, `timeSelection`, `boxZoom`, `seriesFocus`) | 🚧 Next wave — see [Roadmap](#roadmap)               |
| 🌐 Demo site + screenshots                                                                                      | 🚧 Planned                                           |
| 📦 npm release pipeline                                                                                         | 🚧 Planned — publication is gated                    |

```
Test Files  6 passed (6)
     Tests  327 passed (327)
```

## Install

Not on npm yet — until the release gate clears, take it from git:

```bash
pnpm add uplot github:twister55/uplot-kit
```

`uplot` is the **only** peer dependency, and there is no `dependencies` field at all.

## Quick start

```ts
import uPlot from 'uplot';
import { incrsForBytes, splitsForTime, splitsWithEdges, splitsWithLimit } from 'uplot-kit';

const DAY = 24 * 60 * 60;
const start = Date.UTC(2026, 0, 1) / 1000; // axis values are Unix seconds

const data: uPlot.AlignedData = [
	[start, start + DAY, start + 2 * DAY, start + 3 * DAY],
	[1024, 4096, 2048, 16384]
];

const opts: uPlot.Options = {
	width: 800,
	height: 400,
	series: [{}, { label: 'bytes sent', stroke: 'steelblue' }],
	axes: [
		{
			// tick on real calendar day starts, cap the label count, and never blank the
			// axis when a zoom happens to contain no boundary at all
			splits: splitsWithEdges(splitsWithLimit(splitsForTime({ granularity: 'day' }), 8), {
				mode: 'whenEmpty'
			})
		},
		{
			// 1 KiB, 4 KiB, 16 KiB … instead of round-looking decimal ticks
			incrs: incrsForBytes()
		}
	]
};

new uPlot(opts, data, document.body);
```

## What's inside

### 🧮 `incrs` — round increments for `axis.incrs`

Ladders of "nice" increments, so uPlot picks `15m` / `1h` / `1 KiB` rather than `16.67m` or `1023`.

| Export                                                                                              | What it gives you                                               |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `incrsForBytes()` · `incrsForKilobytes()` · `incrsForMegabytes()`                                   | Power-of-two ladders — ticks land on 1 KiB / 1 MiB, not 1000    |
| `incrsForBits()`                                                                                    | Decimal SI 1-2-5 ladder, the convention for throughput          |
| `incrsForIntegers()`                                                                                | Whole numbers only (1, 2, 5, 10, 20, 25, 50 …) — never a `2.5`  |
| `incrsForSeconds()` · `incrsForMilliseconds()` · `incrsForMicroseconds()` · `incrsForNanoseconds()` | Wall-clock ladders from 1 ns to 100 years: 5m, 15m, 1h, 1d, …   |
| `incrsByUnit(kind, opts?)`                                                                          | Runtime dispatcher over all nine, or a custom (sanitized) array |
| `incrsStep(step, opts?)`                                                                            | Exact multiples of a fixed bucket — 15-minute candles, 7m polls |
| `incrsLadder(base, minExp, maxExp, mantissas)`                                                      | The engine: build your own `mantissa × base^exp` ladder         |

Every ladder takes `{ minIncr, maxIncr }`, to clamp it to the resolution your data actually has:

```ts
import type uPlot from 'uplot';
import { incrsForSeconds } from 'uplot-kit';

// data is bucketed to 5-minute intervals — never offer a finer tick
const axes: uPlot.Axis[] = [{}, { scale: 'y', incrs: incrsForSeconds({ minIncr: 300 }) }];
```

> **Why this isn't a one-liner you write yourself.** uPlot reads a tick's decimal count from an
> internal `fixedDec` map, and below `1e-6` `String()` flips to exponential notation, the decimal
> count reads as `0`, and uPlot's split loop **never advances — a hung browser tab, not a wrong
> axis**. `incrs` knows exactly which sub-microsecond rungs uPlot pre-registers, keeps those and
> drops the rest with a one-time console warning. That behaviour is pinned by a test that
> transcribes uPlot's own `guessDec` / `roundDec` / `genIncrs` and asserts the loop would advance.

### 📐 `splits` — tick generators & decorators for `axis.splits`

Generators build a `SplitsFn`; decorators wrap one and return another, so they compose freely.

**Generators**

| Export                                                        | For                                                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `splitsForTime({ granularity, ms, offsetSec, weekStartsOn })` | Real calendar boundaries — day / week / month / quarter / year — widening as you zoom out. Monday-start weeks and fixed UTC offsets included |
| `splitsForLog({ base, minor, minorMantissas })`               | Log axes (`distr: 3`) with control over which minor ticks exist                                                                              |
| `splitsForStep({ step, anchor })`                             | Strict multiples of a fixed step, optionally anchored off-grid                                                                               |
| `splitsForCategory({ count, step })`                          | Ordinal / category axes (`distr: 2`) — integer positions only                                                                                |

**Decorators**

| Export                             | Effect                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `splitsWithInclude(inner, values)` | Always include given values (a zero baseline, an SLO line) when they're in range      |
| `splitsWithLimit(inner, maxTicks)` | Thin evenly to at most `maxTicks`, keeping the spacing regular                        |
| `splitsWithFilter(inner, keep)`    | Drop ticks by predicate — _removes_ them, unlike uPlot's label-only `axis.filter`     |
| `splitsWithEdges(inner, { mode })` | Add the visible range's edges — `'always'`, or `'whenEmpty'` as a blank-axis fallback |

```ts
import type uPlot from 'uplot';
import { splitsForTime, splitsWithEdges, splitsWithFilter, splitsWithLimit } from 'uplot-kit';

// order matters: filter innermost, edges outermost, so an edge tick is never filtered away
const axes: uPlot.Axis[] = [
	{
		splits: splitsWithEdges(
			splitsWithLimit(
				splitsWithFilter(
					splitsForTime({ granularity: 'day', weekStartsOn: 1 }),
					(t) => t % 2 === 0
				),
				10
			)
		)
	}
];
```

### 🧱 `stacked` — stacked areas without the bookkeeping

```ts
import uPlot from 'uplot';
import { stackedBands, stackedData } from 'uplot-kit';

const raw: uPlot.AlignedData = [
	[0, 1, 2],
	[1, 2, 3],
	[10, 20, 30]
];

const opts: uPlot.Options = {
	width: 800,
	height: 400,
	series: [{}, { fill: 'tomato' }, { fill: 'steelblue' }],
	bands: stackedBands(raw.length)
};

new uPlot(opts, stackedData(raw), document.body);
```

`stackedData` turns each series into the running sum of the ones below it — gaps count as `0`
whatever their encoding (`null`, `undefined` or `NaN`), so one missing sample never corrupts the
series stacked above it, and the input is never mutated. `stackedBands` pairs each series with the
one beneath it, carrying no `fill` of its own so color stays a per-series choice.

Both take the same `omit` predicate, so a series hidden in your legend drops out of the stack and
the rest re-stack as if it were never there:

```ts
import uPlot from 'uplot';
import { stackedData } from 'uplot-kit';

const raw: uPlot.AlignedData = [
	[0, 1, 2],
	[1, 2, 3],
	[10, 20, 30]
];

const u = new uPlot(
	{
		width: 800,
		height: 400,
		series: [{}, { fill: 'tomato' }, { fill: 'steelblue' }]
	},
	stackedData(raw),
	document.body
);

const hidden = (seriesIdx: number): boolean => u.series[seriesIdx]?.show !== true;

u.setData(stackedData(raw, { omit: hidden }));
```

## Design rules (non-negotiable)

These aren't aspirations — they're the constraints every unit in the package is built under.

- **🪶 Zero runtime dependencies.** `uplot` is the only peer. `throttle`/`clamp`-sized helpers get
  inlined at the point of use; ESLint fails the build on an extraneous import.
- **🌲 Tree-shakeable by construction.** ESM, `sideEffects: false`, named exports only. Import
  `incrsForBytes` and the other eight ladders never reach your bundle.
- **🧯 Nothing in `src/` throws.** A bad option that has a documented default is named, warned about
  **once** on the console, and replaced by the default. A bad _required_ value produces the inert
  result — no ticks, no increments. A chart-config typo costs an axis, not the page.
- **🎨 No styling on your behalf.** Colors, fonts and line widths are options. External state (which
  series is focused or hidden) enters through predicates, never by the code reaching into your app
  state.
- **📖 Every export is documented.** JSDoc on the factory _and_ on every option field, with
  `@default` stated in prose and complete, copy-pasteable `@example` snippets — because the emitted
  `.d.ts` is what your IDE, and your coding agent, actually read.
- **🧪 TypeScript strict, tests per unit.** Pure utilities test in node; DOM plugins will test in
  vitest browser mode.

### No framework code, ever

Not in `src`, not in devDependencies, not in the demos (those are vanilla Vite). Wrappers such as
`svelte-uplot` are separate, independent projects that do **not** depend on uplot-kit — the only
contract between them is uPlot's own `options.plugins` / `uPlot.Plugin`.

### Size

The whole barrel is ~5.4 kB min+gzip (~13 kB minified). Realistically you ship a fraction of that:
every unit tree-shakes independently.

## Compatibility

|                   |                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------- |
| **uPlot**         | `^1.6` — verified against 1.6.32                                                              |
| **Module format** | ESM only, ES2022, browser-targeted                                                            |
| **Entry point**   | Exactly one: `uplot-kit`. No subpaths — tree-shaking is the granularity                       |
| **Node**          | Not required by the package. Node 20.19+ / 22.13+ / 24+ is a _tooling_ floor for contributors |

## Roadmap

The plugin wave, in the order it's queued:

| Plugin           | What it does                                           |
| ---------------- | ------------------------------------------------------ |
| `autosize`       | Resize the chart to its container                      |
| `axisSync`       | Align axis gutters across charts so plot areas line up |
| `timeRegions`    | Shaded regions — weekends, deploys, incidents          |
| `verticalMarker` | A moving "now" line                                    |
| `timeSelection`  | Drag-to-select a time range                            |
| `boxZoom`        | Rectangular zoom                                       |
| `seriesFocus`    | Hover/legend focus without touching your state         |

Behind them: `seriesBars` (grouped/stacked bars), `tzDate` (timezone & DST via `Intl`), `dataLabels`
— plus a vanilla demo site with a page per plugin.

## Development

```bash
pnpm i
pnpm build      # tsup → ESM + d.ts (single entry: the root barrel)
pnpm test       # vitest
pnpm check      # tsc --noEmit (strict, both project refs)
pnpm lint       # prettier + eslint
pnpm lint:pkg   # publint + attw
```

Run one file with `pnpm vitest run src/splits.test.ts`, one case with `pnpm vitest run -t 'name'`.
Use pnpm — the lockfile and `pnpm-workspace.yaml` assume it.

## License

[MIT](./LICENSE) © Vadim Yelisseyev
