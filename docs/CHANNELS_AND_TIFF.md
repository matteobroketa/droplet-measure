# Channels, axes, and TIFF handling

## Vocabulary

- **Dataset**: one uploaded file and its channel/frame metadata.
- **Channel**: a source acquisition plane, not an RGB preview component.
- **View**: a display choice used only for inspection.
- **Detection channel**: the one source plane used to find droplet candidates.
- **Frame**: the selected common `(Z,T)` coordinate. Z slices and time points are not channels.

## Upload contract

The app imports a file once. For TIFF, it first reads the classic TIFF header and the reachable primary IFD chain, records dimensions, samples, bits, sample format, compression, planar layout, orientation, descriptions, and resolution tags, then parses OME-XML locally when present. It does not send files to a server.

The loader builds an IFD/sample → `(C,Z,T)` map. OME `DimensionOrder`, `TiffData` (`IFD`, `FirstC`, `FirstZ`, `FirstT`, `PlaneCount`), channel names, role hints, physical pixel sizes, and effective significant bits are retained in provenance. Missing, duplicated, or out-of-range mappings are warned about instead of being silently invented.

A TIFF with multiple pages but no reliable axis metadata is intentionally ambiguous. The UI identifies the pages and blocks detection until the user confirms `channels`, `Z slices`, or `time points`. This prevents page count from being silently interpreted as channel count.

## Channel behavior

Single-channel files use their only source channel directly. The obsolete `To Gray / Red / Green / Blue` analysis selector is not used for scientific files. Multichannel datasets show names, source IDs, role mapping, a detection radio button, measurement checkboxes, and independent display controls. All valid source channels are selected for measurement by default.

Brightfield/phase/transmitted names suggest the detection channel but do not force it. GFP/RFP/fluorophore metadata suggests role and display LUT only. A detection channel is measured as a raw channel too, without automatically calling it fluorescence. Fluorescence channels expose an editable fluorophore label for provenance; the label is metadata, not spectral unmixing.

RGB PNG/JPEG and standard RGB TIFF are represented as one explicitly labelled **Color image**. Luminance is available as that color image's detection plane and is reported as derived color-luminance units; RGB samples are not silently presented as three independent fluorescence acquisitions. The optional R/G/B component planes retain the source TIFF/raster numeric type and are explicitly labelled color components (for example, `uint16 color component`). Alpha/extra samples are not biological channels by default.

A single grayscale TIFF page with multiple non-alpha samples exposes those samples as unnamed channels. A grayscale+alpha page excludes the tagged alpha sample and records that decision. A multipage file whose pages themselves contain multiple samples remains blocked when metadata is absent, because the page/sample relationship cannot be safely guessed.

The advanced **Add separate channel** action is only for files saved separately. It requires a single-plane, dimension-matched file and an explicit user confirmation that the coordinate systems are believed aligned. Equal dimensions alone do not prove registration; the warning is recorded in results provenance.

## Raw measurements

The detector may operate on a temporary 8-bit, performance-scaled representation. Quantification never does. For each selected channel, original typed samples inside the documented `0.72 × radius` inner-circle ROI produce `N`, sum, mean, median, min, max, sample standard deviation, invalid-pixel count, saturation information when the user enters a known per-channel ceiling, and QC flags. TIFF container bit depth is not silently used as a camera saturation ceiling. CSV fields are channel-qualified and JSON includes the source pixel type, frame, channel metadata, ROI method, settings, mapping provenance, and warnings.

Results are invalidated when the detection source, frame, or detection settings change. Display channel, composite view, contrast cache, zoom, and overlay visibility do not alter measurements. CSV/JSON exports include excluded candidates but are disabled while the displayed result set is stale.

## Supported local TIFF scope

The bundled dependency-free decoder supports classic little- and big-endian TIFF with common 8/16/32-bit unsigned, signed, and Float32 samples; strips or tiles; PackBits, LZW, and Deflate; horizontal predictors for integer samples; orientations; palette images; planar or interleaved storage; and ordinary RGB layouts. OME-TIFF channel/frame mapping is metadata-aware. Pyramidal/reduced primary pages are not counted as scientific channels; previews may use a first usable page.

BigTIFF, JPEG-compressed TIFF, malformed metadata, unsupported predictors, missing external OME planes, and uncommon vendor encodings fail with a visible error. The app does not fall back to an 8-bit browser decode for a TIFF that the scientific decoder cannot interpret.

## Provenance limitations

No background subtraction, flat-field correction, spectral correction, registration transform, tracking, or 3-D reconstruction is implied. Channel intensities from different exposure, gain, filter, binning, or detector settings must not be compared as if they were directly calibrated concentrations.
