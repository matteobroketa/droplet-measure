# Analytical method and validation notes

## Scope

Droplet Measure is an interactive analysis aid for approximately circular droplets. Automatic candidates are drawn on the source-coordinate overlay and remain reviewable; they are not a validated biological segmentation model.

## Source data and coordinates

TIFF metadata and all reachable primary image directories are inspected before the browser raster fallback. The decoder preserves source samples as typed arrays. Segmentation may use a performance-scaled copy (maximum side 1400 px), but it records the scaled dimensions and separate `scaleX`/`scaleY`. Centers and equivalent radii are mapped back to original pixel coordinates. Quantification always reads the original plane.

The display canvas is only a visualization. It may use min/max contrast stretching and pseudocolor; neither is used for scientific measurements.

## Calibration

Calibration is optional and separate from the canonical pixel-based detection limits. It can come from OME/TIFF physical pixel metadata, a user-entered micrometers-per-pixel value, or a drawn line over a known distance. Physical diameter uses the geometric mean of X/Y pixel scale for an equivalent-circle size. Raw intensity values are not changed by calibration.

## Detection

1. Select one raw intensity plane. For a multichannel dataset this is the explicit detection channel; the app never silently averages channels.
2. Convert that plane to a temporary 8-bit segmentation representation using sampled display-range normalization. This conversion is segmentation-only.
3. Apply zero to five 3×3 smoothing passes.
4. Use Otsu thresholding by default, or a user threshold. `Auto`, `Dark`, and `Bright` polarity are available; adaptive local-contrast masks are a fallback when a fixed mask has no candidates.
5. Extract four-connected components, reject border-touching components, and filter by equivalent-circle diameter and circularity.
6. Report `d = 2 × sqrt(area / π)` and `circularity = 4πA/P²`, with the caveat that the pixel-grid perimeter is an approximate filter statistic.

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

Changing display channel, composite view, zoom, or overlay visibility does not rerun analysis. Changing detection channel, frame, polarity, threshold, smoothing, size, or circularity invalidates results and debounces a new run. A monotonically increasing analysis job ID prevents a slower old run from replacing a newer selection. One-to-one center/radius matching transfers exclusion state where unambiguous; unmatched candidates are kept in an archive for recovery. Excluded candidates remain in CSV/JSON with `included=false`, while summary statistics use included candidates only.

## Validation guidance

Before production or publication use:

1. Test representative images with known droplet sizes, illumination gradients, border cases, saturated pixels, and invalid floating-point values.
2. Compare recall/precision and diameter error with manual labels or a validated reference tool.
3. Check that channel registration, acquisition gain/exposure, binning, and pixel size are documented before comparing channels or experiments.
4. Review overlays and QC flags, especially for touching droplets, low-contrast brightfield images, and candidates near the source border.
5. Export the JSON provenance and analysis recipe with the results.
