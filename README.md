# Droplet Measure

Droplet Measure is a browser-only microscopy analysis tool for detecting approximately circular droplets, reviewing candidates, measuring raw channel intensity, and exporting reproducible results. Files stay in the browser; the app has no backend, analytics, or upload endpoint.

## Workflow

1. Open one PNG, JPEG, classic TIFF, or OME-TIFF dataset. A TIFF is inspected locally before any browser image fallback.
2. Review the dataset summary: dimensions, typed pixel format, C/Z/T axes, channel names, and warnings.
3. Use the suggested detection channel or choose another source. The display channel is independent from detection.
4. For a multipage TIFF without trustworthy metadata, confirm whether pages are channels, Z slices, or time points before detection.
5. Choose the frame, detection settings, and channels to quantify. Changing detection settings reruns the analysis after a short debounce and keeps defensible manual exclusions where possible.
6. Review the selected threshold mask, equivalent-circle outline, and inner-circle measurement ROI. Results use the same droplet ROIs on every selected raw channel.
7. Export CSV, JSON, an annotated preview PNG, or the analysis recipe.

## Scientific data model

The loader keeps the original typed pixel planes (`Uint8Array`, `Uint16Array`, signed integer arrays, or `Float32Array`) separate from display previews. Display contrast and pseudocolor are view-only. Raw measurements are sampled from the original source coordinates, not from a downscaled canvas. RGB color files remain explicitly labelled color data; their derived luminance and optional components are not silently called fluorescence.

The default ROI is an inner circle with radius `0.72 ×` the detected equivalent-circle radius. The viewer can display the selected binary segmentation mask, equivalent-circle outline, or actual measurement ROI. Each channel reports `N`, sum, mean, median, minimum, maximum, sample standard deviation, invalid-pixel count, optional saturation information only after a known per-channel ceiling is entered, and QC flags. Excluded candidates remain in exports with `included=false`.

Batch analysis freezes the active dataset recipe, checks channel IDs and roles before each file, skips incompatible inputs with a reason, and exports tidy channel rows plus a run manifest.

See [docs/CHANNELS_AND_TIFF.md](docs/CHANNELS_AND_TIFF.md) for the dataset contract, TIFF mapping rules, supported formats, and limitations. See [docs/ANALYTICAL_METHOD.md](docs/ANALYTICAL_METHOD.md) for the detection and quantification method.

## Development

The production app has no build step or runtime package dependency. For a local preview:

```bash
python -m http.server 8000
```

Open <http://localhost:8000>. A local HTTP server is recommended because browser file and module policies differ when opening HTML directly from disk.

The repository is static and remains suitable for GitHub Pages. `index.html` loads the local `tiff.js` decoder, `analysis-core.js`, `build-info.js`, and `app.js`; no remote scripts are required.

## Validation

Syntax checks:

```bash
node --check app.js
node --check tiff.js
node --check analysis-core.js
```

Run the deterministic numerical and Chromium browser regression tests with `npm ci`, `npx playwright install chromium`, and `npm test`. The browser smoke harness in `tests/cdp-eval.mjs` remains a small local helper for exercising a running Chromium/Edge target; it is not part of the production app. GitHub Pages deployment runs only after the `Validate static app` workflow succeeds and exports the validated commit SHA in result provenance.

## Privacy and license

Images, decoded planes, detections, and exports are handled locally. The project is MIT licensed.
