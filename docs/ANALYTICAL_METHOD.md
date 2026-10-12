# Analytical method and validation notes

## Scope

Droplet Measure estimates the size of approximately circular droplets in microscopy images. It is designed as an interactive analysis aid: automatic detections are always shown as an overlay and can be excluded manually before export.

## Calibration

A calibrated measurement requires either:

- a user-drawn line over a feature of known physical length, or
- a directly entered pixel size in micrometers per pixel.

Calibration is applied linearly to equivalent-circle diameter. Calibration values should come from the relevant objective, camera, binning, and acquisition configuration. A scale bar embedded by image-processing software should only be used when its provenance is known.

## Segmentation

1. The source image is reduced only for segmentation performance, with a maximum analysis dimension of 1400 px. Coordinates and sizes are mapped back to original pixels.
2. RGB values are converted to luminance using Rec. 709 coefficients.
3. Zero to five 3×3 smoothing passes can be applied.
4. The default threshold uses Otsu's between-class variance criterion. A manual 8-bit threshold is available.
5. The foreground can be dark, bright, or automatically selected. Auto evaluates both polarity masks and selects the set with the larger summed circularity score.
6. Four-connected components are extracted. Objects touching the analysis border are excluded.
7. Candidate objects are filtered by equivalent-circle diameter and circularity.

Circularity is calculated as `4πA/P²`, where `A` is component area and `P` is the four-neighbor boundary perimeter estimate. Because perimeter is pixel-grid dependent, circularity should be treated as a segmentation filter rather than a high-precision shape descriptor.

Equivalent-circle diameter is `2√(A/π)`.

## Fluorescence sampling

When a fluorescence image is attached, it must have exactly the same pixel dimensions as the brightfield image. The app assumes the images are already registered. For each detected droplet, mean RGB intensity is sampled inside a circle with radius 72% of the detected droplet radius. This inset reduces contamination from the boundary but does not perform background subtraction, flat-field correction, spectral unmixing, or registration.

## Known limitations

- Touching or overlapping droplets can merge into one connected component.
- Strong illumination gradients can reduce global-threshold performance.
- Ring-like droplets with interiors similar to background can be poorly represented by filled-component segmentation.
- Very small objects are sensitive to downsampling and pixel-grid perimeter effects.
- Auto polarity is heuristic and should be verified visually.
- Common classic TIFF variants are decoded by the bundled local fallback; BigTIFF and some specialized compressed variants may still need to be exported as PNG or JPEG.
- Fluorescence statistics assume registered images and are raw intensity summaries, not calibrated concentrations.

## Recommended validation

Before using measurements in a production or publication workflow:

1. Use a representative image set spanning illumination, droplet sizes, and image quality.
2. Compare automated diameter measurements with manual measurements or a validated reference tool.
3. Report detection recall/precision separately from diameter error.
4. Lock and record analysis settings for comparisons across conditions.
5. Revalidate after changes to optics, magnification, camera binning, preprocessing, or droplet morphology.
