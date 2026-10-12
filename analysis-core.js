(() => {
  'use strict';

  const ROI_RADIUS_FRACTION = 0.72;

  function detectionSize(sourceWidth, sourceHeight, maxSide = 1400) {
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    return {width, height, scaleX: width / sourceWidth, scaleY: height / sourceHeight};
  }

  function circularity(area, perimeter) {
    return perimeter > 0 ? Math.min(1, 4 * Math.PI * area / (perimeter * perimeter)) : 0;
  }

  function measurePlane(plane, droplet) {
    const radius = Math.max(0, droplet.radiusPx * ROI_RADIUS_FRACTION), radiusSquared = radius * radius;
    const x0 = Math.max(0, Math.floor(droplet.x - radius)), x1 = Math.min(plane.width - 1, Math.ceil(droplet.x + radius));
    const y0 = Math.max(0, Math.floor(droplet.y - radius)), y1 = Math.min(plane.height - 1, Math.ceil(droplet.y + radius));
    const values = [], invalidMask = plane.invalidMask;
    let invalidPixels = 0, saturatedPixels = 0, roiPixelCount = 0;
    const clipped = x0 === 0 || y0 === 0 || x1 === plane.width - 1 || y1 === plane.height - 1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if ((x - droplet.x) ** 2 + (y - droplet.y) ** 2 > radiusSquared) continue;
      roiPixelCount++;
      const index = y * plane.width + x, value = Number(plane.values[index]);
      if (invalidMask?.[index] || !Number.isFinite(value)) invalidPixels++;
      else {
        values.push(value);
        if (Number.isFinite(plane.saturationLevel) && value >= plane.saturationLevel) saturatedPixels++;
      }
    }
    const n = values.length, sum = values.reduce((total, value) => total + value, 0), mean = n ? sum / n : null;
    const sorted = [...values].sort((a, b) => a - b);
    const median = n ? (n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null;
    const min = n ? sorted[0] : null, max = n ? sorted[n - 1] : null;
    const standardDeviation = n > 1 ? Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1)) : null;
    const saturationKnown = Number.isFinite(plane.saturationLevel), flags = [];
    if (clipped) flags.push('border_roi_clipped');
    if (radius < 2) flags.push('small_roi');
    if (invalidPixels) flags.push('invalid_pixels');
    if (!n) flags.push('empty_roi');
    if (!saturationKnown) flags.push('saturation_not_assessed');
    if (saturatedPixels) flags.push('saturated_pixels');
    return {
      channelId: plane.channelId, nPixels: n, roiPixelCount, invalidPixels,
      rawSum: n ? sum : null, rawMean: mean, rawMedian: median, rawMin: min, rawMax: max,
      rawStdDev: standardDeviation, rawStddev: standardDeviation,
      saturationLevel: saturationKnown ? plane.saturationLevel : null,
      saturatedPixels: saturationKnown && n ? saturatedPixels : null,
      saturatedFraction: saturationKnown && n ? saturatedPixels / n : null,
      flags,
      roi: {kind: 'inner-circle', radiusFraction: ROI_RADIUS_FRACTION, centerX: droplet.x, centerY: droplet.y, radiusPx: radius, sourceCoordinateSpace: 'original-pixels'}
    };
  }

  const api = {ROI_RADIUS_FRACTION, detectionSize, circularity, measurePlane};
  globalThis.DropletMeasureCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();