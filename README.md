# Droplet Measure

A local-first browser application for calibrating, detecting, reviewing, and exporting microfluidic droplet measurements from microscopy images.

The app is intentionally static: there is no backend, no upload service, and no build step. Images are decoded and analyzed in browser memory, including common TIFF variants through the bundled local fallback decoder. This makes the repository suitable for GitHub Pages and for sensitive experimental images that should remain on the user's machine.

## Live workflow

1. Open, drag/drop, or paste one or more microscopy images.
2. Calibrate using a known line length or direct µm/pixel value.
3. Choose the analysis channel (**To Gray**, **Red**, **Green**, **Blue**, or **RGB composite**) and configure detection settings.
4. Detect droplets, then adjust settings live while the overlay and measurements update automatically.
5. Inspect the overlay and exclude false positives by clicking them in **Review** mode.
6. Optionally attach a registered fluorescence image of the same dimensions to sample mean intensity per droplet.
7. Export CSV, JSON, or an annotated PNG.

## Design goals

- Browser-only processing; no experimental data leaves the device.
- Fast static deployment with no dependency chain.
- Explicit calibration and review rather than silently producing measurements.
- Reversible inclusion/exclusion instead of destructive deletion.
- Keyboard-aware, reduced-motion-aware, responsive UI.
- Analysis settings included in JSON exports for reproducibility.
- Batch support for applying the same settings across queued images.

## Detection model

The detector creates a performance-scaled analysis copy (maximum side 1400 px), applies the selected channel, optionally smooths it, and calculates an Otsu threshold by default. Connected components are extracted from dark or bright foreground masks, filtered by diameter and circularity, and mapped back to original-image coordinates. Auto mode evaluates global and local-contrast masks so ordinary brightfield gradients do not silently produce an empty result. In Auto polarity mode, the candidate set with the stronger circular-object score is selected.

Equivalent-circle diameter is calculated as:

`d = 2 × sqrt(area / π)`

This model is well suited to separated, approximately circular droplets with useful foreground/background contrast. It is deliberately transparent and dependency-free; it is not a replacement for a validated segmentation model when droplets overlap, touch strongly, or have highly nonuniform illumination.

See [docs/ANALYTICAL_METHOD.md](docs/ANALYTICAL_METHOD.md) for limitations and validation guidance.

## Run locally

No installation is required. Open `index.html` in a modern browser.

For development with a local server:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## GitHub Pages

The included workflow deploys the repository root to GitHub Pages on pushes to `main`. In GitHub, set **Settings → Pages → Source** to **GitHub Actions** if it is not already selected.

## Repository structure

```text
.
├── index.html
├── tiff.js
├── docs/
│   └── ANALYTICAL_METHOD.md
├── .github/workflows/
│   ├── pages.yml
│   └── validate.yml
├── .nojekyll
├── LICENSE
└── README.md
```

## Privacy

All images are handled with browser APIs and remain local. The app contains no analytics, remote JavaScript libraries, tracking pixels, or upload endpoints.

## License

MIT.
