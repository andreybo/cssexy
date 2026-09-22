# cssexy

An interactive terminal tool for indexing, reviewing and optimizing CSS and SCSS. Requires Node.js 22+.

## Install

After the npm release is published:

```sh
npm install --global cssexy
cd /path/to/project
cssexy
```

Or run without a global installation:

```sh
npx cssexy ui
```

Download the [source](https://github.com/andreybo/cssexy) and run it locally:

```sh
npm ci
npm start -- ui --root /path/to/project
```

You can also run `node /path/to/cssexy/bin/cssexy.mjs` from any project directory. No build step is required.

## Terminal interface

Run `cssexy` or `cssexy ui`. Choose a project, stylesheet types, files, removals and export options. Enter an option and press Enter; use `1,3-5` to select multiple files, `all` for all and `0` for none.

The full workflow scans styles, analyzes duplicates, checks class references, lets you select removals and shows a diff before applying changes. Removal and apply confirmations default to no. Every operation ends with statistics and returns to the menu.

## Commands

```sh
cssexy init
cssexy scan --all
cssexy analyze
cssexy usage
cssexy plan
cssexy diff
cssexy apply

cssexy find card
cssexy build --syntax scss --nesting nested
cssexy build --syntax css --style mini
cssexy build --skeleton
cssexy restore <backup-id>

cssexy --help
cssexy --version
```

Run `scan` again after applying changes. To include reviewed unused rules in a plan, pass their IDs with repeated `--approve-id <id>` options, or select them in the terminal interface.

## Configuration and output

`cssexy init` creates `.cssexy` and adds `/cssexy/` to the target project's `.gitignore`. Indexes, reports, plans, generated styles and backups stay inside `cssexy/`.

`.cssexy` accepts `types`, `ignore`, `content`, `safelist` and `format`. Format options:

| Option | Values |
| --- | --- |
| syntax | css, scss, sass |
| style | pretty, mini |
| nesting | preserve, flat, nested |
| properties | multiline, inline |
| blankLines | true, false |
| indent | 1–8 |

Indented Sass requires pretty/multiline output. Skeletons require SCSS pretty output with preserve/nested. Each source gets a separate output file. Statistics go to stderr, keeping JSON and diff output usable in pipes.

## Scope

Automatic cleanup merges adjacent identical selectors and removes consecutive identical declarations. Nonadjacent cascade conflicts remain for review. Unused detection searches source text; dynamic classes, CMS content and CSS Modules need review and a safelist. Only eligible simple top-level class rules can be selected for removal.

SCSS evaluation constructs are indexed but excluded from automatic optimization. Export compilation requires resolvable Sass imports. Input indexing supports CSS and SCSS; Sass is an output format. Source hashes prevent applying stale plans, and backups support restoration.

## Publishing

From this source directory, with an authorized npm account:

```sh
npm login
npm publish --dry-run
npm publish --access public
```

The package includes only runtime code, this README and the MIT license. For later releases, update the version before publishing.

## License

[MIT](LICENSE) © 2026 andreybo.
