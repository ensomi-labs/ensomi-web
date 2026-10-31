# ensomi-web

Static site for https://ensomi.app: the ensomi R2 page with an in-browser chart generator, deployed as Cloudflare Workers static assets (`wrangler.jsonc`).

- `public/`: the page in English (`index.html`), Japanese (`ja/index.html`, served at `/ja/`) and Simplified Chinese (`zh/index.html`, at `/zh/`), with `styles.css` and images; the header links the three and, in its top right corner, the model on Hugging Face and ensomi-labs on GitHub. The build adds `app.js`, `worker.js`, the runtime's `ensomi-runtime.wasm` and its resampler tables (`resampler/`), which are not committed. `data-provenance/index.html`, with `ja/` and `zh/` translations and linked from each home page's R2 section and footer, is a reading page, without scripts, that summarises the data provenance of R2 1.0 and 1.0.1; its counts, dates, policy and statement on mapper and artist style restate ensomi-model's [R2 data provenance report](https://github.com/ensomi-labs/ensomi-model/blob/main/docs/research/r2_data_provenance.md), which owns them, and change when it does.
- `site/`: the page's TypeScript. `app.ts` drives the form, progress, downloads and inspector; `audio.ts` decodes the song at its own sample rate for the Exact timing option, so that the runtime converts the rate as the Python release does; `worker.ts` loads the model in a Web Worker, runs a song's audio stages (BeatThis and the beat grid) there as soon as the model and the song are both ready, and generates from them when Generate is pressed; `player.ts` is the live inspector; `star.ts` computes the generated chart's osu!mania star rating as osu! and ensomi-model's calculator do, which the result shows beside the star requested; `i18n.ts` holds the generator's messages in the three languages and picks them by the page's `lang`; `serve.mjs` serves the page locally. Each language's page carries its own static text: a change to one page's text or structure goes into all three, and `npm run check:pages` fails when a translated page's element ids differ from its English page (`index.html` or `data-provenance/index.html`) or a home page's statement lines are not the same.
- `package.json`: the site's one dependency, [`@ensomi/runtime`](https://www.npmjs.com/package/@ensomi/runtime) at exactly 0.3.2, the WebAssembly build of ensomi's Rust runtime with its JavaScript API over ONNX Runtime Web, and the build, test and deploy tools.
- `packages/runtime/`: the runtime's checks in this site, the browser tests and their report ([README](packages/runtime/README.md)).
- `docs/brand.md`: name, principles, palette and voice.

The generator runs in desktop browsers; on screens narrower than 60rem the page shows the explanation and hides the tool. It loads the model from the release tag, `https://huggingface.co/sed-i/ensomi-r2/resolve/r2-1.0.1/onnx/` (about 120 MB, kept in the Cache API), or from a folder the user picks, and ONNX Runtime's `.wasm` files from jsDelivr (`onnxruntime-web@1.23.2`), because Cloudflare static assets are capped at 25 MiB each. BeatThis runs on WebGPU when the browser offers an adapter; the per-row rows and R2 graphs, and BeatThis without WebGPU, run on WebAssembly. If WebGPU fails while loading, the page loads everything on WebAssembly instead. `public/_headers` makes the page cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless`), which WebAssembly threads need: two next to WebGPU, four without it. Browsers that do not support `credentialless` (Safari) run WebAssembly on one thread. `site/serve.mjs` sends the same two headers.

## Build and run locally

Node is needed; install the dependencies with `npm ci` in the repository root.

```sh
npm ci
npm run typecheck:site
npm run build:site            # writes public/app.js, worker.js, ensomi-runtime.wasm and resampler/
npm run serve:site -- 8080    # http://127.0.0.1:8080/, model from Hugging Face
# or with a local copy of the model repository, served at /model/:
npm run serve:site -- 8080 ../ensomi-model/artifacts/release-r2/bulk/hf/ensomi-r2
#   then open http://127.0.0.1:8080/?model=/model/onnx/
```

`?model=<url>` points the page at any folder that holds `runtime.json` and the ONNX files; `?backend=wasm` skips WebGPU. Model files are cached by URL under the cache name in `site/worker.ts`; change that name when the model URL in `site/app.ts` or the files behind a URL change. Loading deletes the caches of other names.

## Checks and dependency updates

`.github/workflows/ci.yml` runs on every pull request, on pushes to `main` and by hand (Run workflow), on Node 24: `npm ci`, `typecheck:site`, `typecheck`, `build:site`, `check:pages` and `test:site` (the `site/*.test.mjs` unit tests). The browser tests in `packages/runtime/tests/browser/` need Chrome, the model and the dataset songs, and are run by hand.

Dependabot (`.github/dependabot.yml`) opens pull requests for npm security updates, with version updates off, and monthly for the workflow's actions. The `dependabot` job in `ci.yml` merges a patch or minor npm security update of one package once its checks pass, and only the commit they ran on; a major version, a grouped update or a later push waits for a person. GitHub starts no workflow for the job's own merges, so `main` after them is checked only by the next run: run CI by hand on `main` before deploying. Security updates run only while Dependabot security updates are on in the repository's settings (Code security). A merged update reaches ensomi.app with the next deploy.

Dependabot never updates `@ensomi/runtime`, whose exact pin moves with a runtime release, or `onnxruntime-web`, whose version must match the ONNX Runtime URL in `site/worker.ts`. A vulnerable package that `@ensomi/runtime` pins exactly is fixed only by a runtime release: Dependabot's bump of the same package here leaves the runtime's own copy in the lockfile.

## Deploy

`npx wrangler deploy` from the repository root, logged in to the Cloudflare account that holds `ensomi.app`. Wrangler runs `npm run build:site` first (`build.command` in `wrangler.jsonc`).

## Previews

`.github/workflows/preview.yml` deploys each commit of a pull request to a [Worker Preview](https://developers.cloudflare.com/workers/previews/) of `ensomi-app` named `pr-<number>`, and keeps one comment on the pull request with two URLs: the Preview's, which follows the latest commit, and that commit's own. Closing or merging the pull request deletes the Preview and its URLs. Forks and Dependabot get no Actions secrets, so their pull requests have no Preview. `npx wrangler preview --name <name>` makes one by hand and `npx wrangler preview delete --name <name>` removes it.

The URLs are on `workers.dev`, public to anyone who has them, and served with `X-Robots-Tag: noindex`. Each hostname is its own origin, so the generator downloads the model again on each one.

The workflow needs two repository secrets: `CLOUDFLARE_API_TOKEN`, a token with Workers Scripts Edit on the account and nothing else, and `CLOUDFLARE_ACCOUNT_ID`. Same-repository pull requests can read the token, because the build runs their code. `preview_urls` in `wrangler.jsonc` takes effect with `npx wrangler deploy` or `npx wrangler triggers deploy`, which applies the routes and URL settings without publishing code; `wrangler preview` does not apply it.

## Licences

The site's code and content are MIT (`LICENSE`, copyright Ensomi Labs). `@ensomi/runtime` is Apache-2.0 under its own licence, shipped in its npm package, and so are the runtime's checks and browser tests in `packages/runtime/` (`packages/runtime/LICENSE`). ONNX Runtime Web is MIT. The model's licence is on its [Hugging Face card](https://huggingface.co/sed-i/ensomi-r2).
