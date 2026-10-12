# Analytical method and validation notes

## Scope

Droplet Measure is an interactive analysis aid for approximately circular droplets. Automatic candidates are drawn on the source-coordinate overlay and remain reviewable; they are not a validated biological segmentation model.

## Source data and coordinates

TIFF metadata and all reachable primary image directories are inspected before the browser raster fallback. The decoder preserves source samples as typed arrays. Segmentation may use an isotropically scaled copy (maximum side 1400 px); the rounded output dimensions and actual `scaleX`/`scaleY` are recorded. Centers and equivalent radii are mapped back to original pixel coordinates. Quantification always reads the original plane.

The display canvas is only a visualization. It may use min/max contrast stretching and pseudocolor; neither is used for scientific measurements.

## Calibration

Calibration is optional and separate from the canonical pixel-based detection limits. It can come from OME/TIFF physical pixel metadata, a user-entered micrometers-per-pixel value, or a drawn line over a known distance. Physical diameter uses the geometric mean of X/Y pixel scale for an equivalent-circle size. Raw intensity values are not changed by calibration.

## Detection

1. Select one raw intensity plane. For a multichannel dataset this is the explicit detection channel; the app never silently averages channels.
2. Convert that plane to a temporary 8-bit segmentation representation using sampled display-range normalization. This conversion is segmentation-only.
3. Apply zero to five 3×3 smoothing passes.
4. Use Otsu thresholding by default, or a user threshold. `Auto`, `Dark`, and `Bright` polarity are available; adaptive local-contrast masks are a fallback when a fixed mask has no candidates.
5. Extract four-connected components, reject border-touching components, and filter by equivalent-circle diameter and circularity.
6. Report `d = 2 × sqrt(area / π)` and `circularity = min(1, 4πA/P²)`, with the caveat that the pixel-grid perimeter is an approximate filter statistic. No empirical multiplier is applied.

Auto polarity is deliberately heuristic. A brightfield, phase, fluorescence, or reference channel can be used when it has droplet contrast, but the role label does not turn a channel into fluorescence and does not override visual review.

## Quantification

For every detected candidate and selected channel at the selected common `(Z,T)` frame, the app constructs a deterministic inner-circle ROI in original source pixels:

```text
ROI radius = 0.72 × detected equivalent-circle radius
```

Pixel centers inside the circle are visited without downsampling. Pixels outside the source bounds are clipped. NaN, infinity, and explicitly masked values are omitted and counted. With valid values `I₁ … Iₙ`:

```text
raw_sum      = Σ Iᵢ
raw_mean     = raw_sum / n
raw_median   = median(Iᵢ)
raw_std_dev  = sqrt(Σ(Iᵢ - raw_mean)² / (n - 1))  [n > 1]
```

For `n=0`, numerical fields are `null` and `empty_roi` is reported. For `n=1`, sample standard deviation is `null`. Min/max, valid pixel count, ROI pixel count, invalid count, saturation level/fraction information where a user supplies a known per-channel ceiling, and QC flags are retained per channel. Until then, `saturation_not_assessed` is recorded rather than inferred from the TIFF container bit depth. No background subtraction, flat-field correction, registration correction, spectral unmixing, or concentration conversion is performed in V1.

OME/TIFF effective bit-depth metadata is retained as provenance, but it is not silently converted into a camera ceiling. Saturation is assessed only after the user enters a known per-channel ceiling. Integer container limits are not evidence of fluorophore concentration or cross-channel comparability.

## Review and revision safety

Changing display channel, composite view, zoom, or overlay visibility does not rerun analysis. Changing detection channel, frame, polarity, threshold, smoothing, size, circularity, measured channels, or saturation ceilings invalidates results. Each job snapshots its channel, frame, settings, and saturation configuration; it commits measurements only if the job and configuration are still current. Review decisions are archived by dataset, detection channel, Z, and T; center/radius matching only occurs within that frame. Excluded candidates remain in CSV/JSON with `included=false`, while summary statistics use included candidates only. A valid zero-candidate analysis can be exported as a run JSON and header-only per-droplet CSV.

## Validation guidance

The automated regression suite covers isotropic wide/tall scaling, the documented circularity formula, exact synthetic ROI statistics, invalid samples, and unknown/known saturation semantics. Headless Chromium tests import synthetic 16-bit TIFF and named three-channel OME-TIFF files, verify exact known channel means and display independence, exercise frame-local exclusions, configuration invalidation, zero-result exports, and batch preflight. These deterministic fixtures do not validate automatic segmentation against representative laboratory images or an independent image-analysis tool.

Before production or publication use:

1. Test representative images with known droplet sizes, illumination gradients, border cases, saturated pixels, and invalid floating-point values.
2. Compare recall/precision and diameter error with manual labels or a validated reference tool.
3. Check that channel registration, acquisition gain/exposure, binning, and pixel size are documented before comparing channels or experiments.
4. Review overlays and QC flags, especially for touching droplets, low-contrast brightfield images, and candidates near the source border.
5. Export the JSON provenance and analysis recipe with the results.
