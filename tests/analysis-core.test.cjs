const test = require('node:test');
const assert = require('node:assert/strict');
const {circularity, detectionSize, measurePlane} = require('../analysis-core.js');

test('segmentation downsampling preserves wide and tall aspect ratios', () => {
  const wide = detectionSize(4000, 1000);
  const tall = detectionSize(1000, 4000);
  assert.deepEqual([wide.width, wide.height], [1400, 350]);
  assert.deepEqual([tall.width, tall.height], [350, 1400]);
  assert.equal(wide.scaleX, wide.scaleY);
  assert.equal(tall.scaleX, tall.scaleY);
});

test('circularity uses the documented unadjusted formula', () => {
  assert.equal(circularity(Math.PI * 25, Math.PI * 10), 1);
  assert.equal(circularity(12, 0), 0);
});

test('unknown saturation is null rather than a measured zero', () => {
  const plane = {channelId: 'C1', width: 9, height: 9, values: new Uint16Array(81).fill(17)};
  const result = measurePlane(plane, {x: 4, y: 4, radiusPx: 3});
  assert.equal(result.rawMean, 17);
  assert.equal(result.saturatedPixels, null);
  assert.equal(result.saturatedFraction, null);
  assert.ok(result.flags.includes('saturation_not_assessed'));
});

test('known saturation ceiling counts valid raw ROI pixels exactly', () => {
  const plane = {channelId: 'C1', width: 9, height: 9, values: new Uint16Array(81).fill(17), saturationLevel: 17};
  const result = measurePlane(plane, {x: 4, y: 4, radiusPx: 3});
  assert.equal(result.roiPixelCount, 13);
  assert.equal(result.saturatedPixels, 13);
  assert.equal(result.saturatedFraction, 1);
});

test('invalid samples are omitted and counted', () => {
  const values = new Float32Array(81).fill(5);
  values[40] = NaN;
  const result = measurePlane({channelId: 'C1', width: 9, height: 9, values}, {x: 4, y: 4, radiusPx: 3});
  assert.equal(result.roiPixelCount, 13);
  assert.equal(result.invalidPixels, 1);
  assert.equal(result.nPixels, 12);
  assert.equal(result.rawMean, 5);
});

test('empty ROI returns null numerical statistics', () => {
  const plane = {channelId: 'C1', width: 9, height: 9, values: new Uint16Array(81).fill(17), invalidMask: new Uint8Array(81).fill(1)};
  const result = measurePlane(plane, {x: 4, y: 4, radiusPx: 3});
  assert.equal(result.nPixels, 0);
  assert.equal(result.rawSum, null);
  assert.equal(result.rawMean, null);
  assert.equal(result.rawMedian, null);
  assert.equal(result.rawStdDev, null);
  assert.ok(result.flags.includes('empty_roi'));
});

test('one valid sample has null sample standard deviation', () => {
  const result = measurePlane({channelId: 'C1', width: 1, height: 1, values: new Uint16Array([41]), saturationLevel: 100}, {x: 0, y: 0, radiusPx: .5});
  assert.equal(result.nPixels, 1);
  assert.equal(result.rawMean, 41);
  assert.equal(result.rawStdDev, null);
});