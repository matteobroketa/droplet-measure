# Browser smoke checks

These checks exercise the browser-only path without adding a build dependency. Start the app with `python -m http.server 8000`, launch a Chromium/Edge target with remote debugging on port `9222`, and use `tests/cdp-eval.mjs` to run an expression:

```powershell
$expression = 'JSON.stringify({app: typeof window.DropletMeasure, loader: typeof window.openMicroscopyDataset})'
$env:DM_EXPRESSION_B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($expression))
node tests/cdp-eval.mjs
```

The synthetic fixtures used during validation covered:

- single-page uint8 TIFF with a known raw ROI mean;
- two-channel OME-TIFF with `Brightfield` and `GFP` names and exact uint16 values;
- packed-sample OME planes with non-default C/Z/T order and explicit `TiffData` reordering;
- multipage TIFF without metadata, which showed the mapping prompt and kept detection disabled until confirmation;
- PNG color input, which stayed one labelled color image until the explicit RGB-component action;
- 16-bit RGB TIFF, which preserved raw component values and kept derived luminance outside the 8-bit preview range;
- grayscale multi-sample TIFF and alpha-tagged pages, which did not silently drop or biologically promote samples;
- Float32 TIFF values containing `NaN`/`Infinity`, which were omitted and flagged rather than converted to zero.

Expected invariants are:

1. The loaded canvas has the source dimensions (or a bounded display scale), and the empty dropzone is hidden.
2. Detection uses one selected source channel while all checked channels receive measurements from the original typed planes.
3. Switching the display channel leaves detection IDs and measurements unchanged.
4. Changing a detection setting marks results stale, then replaces them after the debounced recomputation.
5. CSV/JSON exports remain disabled while stale and include excluded candidates after completion.
6. Without a user-supplied ceiling, per-channel results report `saturation_not_assessed`; entering a ceiling enables saturated-pixel counts without changing raw means.
