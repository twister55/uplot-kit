# uplot-kit

> ⚠️ Work in progress — scaffolding stage. v0.1 is not published yet.

Framework-agnostic, typed and tested plugins & utilities for
[uPlot](https://github.com/leeoniya/uPlot). Plugins compose through the standard
`options.plugins`; there are **zero runtime dependencies** and `uplot` is the
only peer dependency.

No framework code lives here. Wrappers (Svelte/React/Vue) are separate,
independent projects that do **not** depend on uplot-kit — compatibility comes
from uPlot itself via the shared `uPlot.Plugin` contract.

## Development

Node 20.19+ / 22.13+ / 24+ — a floor set by the lint and test tooling, not
enforced by the package itself. The published package is browser-targeted ES2022
and has no Node requirement.

```sh
pnpm i
pnpm build      # tsup → ESM + d.ts (single entry: the root barrel)
pnpm test       # vitest
pnpm check      # tsc --noEmit (strict)
pnpm lint       # prettier + eslint
pnpm lint:pkg   # publint + attw
```

## License

MIT
