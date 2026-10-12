const {test, expect} = require('@playwright/test');
const {readFile} = require('node:fs/promises');

function make16BitTiff(channelId = 'C0', value = 1234) {
  const width = 9, height = 9;
  const tags = [[256, 4, width], [257, 4, height], [258, 3, 16], [259, 3, 1], [262, 3, 1], [273, 4, 0], [277, 3, 1], [278, 4, height], [279, 4, width * height * 2], [284, 3, 1], [339, 3, 1]];
  const dataOffset = 8 + 2 + tags.length * 12 + 4;
  const bytes = new Uint8Array(dataOffset + width * height * 2), view = new DataView(bytes.buffer);
  bytes[0] = 0x49; bytes[1] = 0x49;
  view.setUint16(2, 42, true); view.setUint32(4, 8, true); view.setUint16(8, tags.length, true);
  for (let index = 0; index < tags.length; index++) {
    const [tag, type, value] = tags[index], offset = 10 + index * 12;
    view.setUint16(offset, tag, true); view.setUint16(offset + 2, type, true); view.setUint32(offset + 4, 1, true);
    view.setUint32(offset + 8, tag === 273 ? dataOffset : value, true);
  }
  view.setUint32(10 + tags.length * 12, 0, true);
  for (let index = 0; index < width * height; index++) view.setUint16(dataOffset + index * 2, value, true);
  return {bytes: Array.from(bytes), name: `${channelId}.tif`};
}

function makeOmeTiff({width = 9, height = 9, channelNames = ['Brightfield', 'GFP', 'RFP'], planes = [111, 222, 333]} = {}) {
  const sizeZ = planes.length / channelNames.length;
  const channelXml = channelNames.map((name, index) => `<Channel ID="Channel:0:${index}" Name="${name}"/>`).join('');
  const xml = `<OME><Image ID="Image:0"><Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint16" SizeX="${width}" SizeY="${height}" SizeC="${channelNames.length}" SizeZ="${sizeZ}" SizeT="1">${channelXml}<TiffData IFD="0" FirstC="0" FirstZ="0" FirstT="0" PlaneCount="${planes.length}"/></Pixels></Image></OME>`;
  const tagSets = planes.map((planeValues, index) => {
    const tags = [[256, 4, width], [257, 4, height], [258, 3, 16], [259, 3, 1], [262, 3, 1], [273, 4, 0], [277, 3, 1], [278, 4, height], [279, 4, width * height * 2], [284, 3, 1], [339, 3, 1]];
    if (index === 0) tags.push([270, 2, xml.length + 1]);
    return tags;
  });
  const directorySizes = tagSets.map(tags => 2 + tags.length * 12 + 4);
  const directoryOffsets = [];
  let nextOffset = 8;
  for (const size of directorySizes) { directoryOffsets.push(nextOffset); nextOffset += size; }
  const descriptionOffset = nextOffset, imageDataOffset = descriptionOffset + xml.length + 1;
  const bytes = new Uint8Array(imageDataOffset + planes.length * width * height * 2), view = new DataView(bytes.buffer);
  bytes[0] = 0x49; bytes[1] = 0x49; view.setUint16(2, 42, true); view.setUint32(4, directoryOffsets[0], true);
  for (let page = 0; page < tagSets.length; page++) {
    const tags = tagSets[page], directoryOffset = directoryOffsets[page];
    view.setUint16(directoryOffset, tags.length, true);
    for (let index = 0; index < tags.length; index++) {
      const [tag, type, value] = tags[index], entry = directoryOffset + 2 + index * 12;
      view.setUint16(entry, tag, true); view.setUint16(entry + 2, type, true); view.setUint32(entry + 4, tag === 270 ? xml.length + 1 : 1, true);
      view.setUint32(entry + 8, tag === 270 ? descriptionOffset : tag === 273 ? imageDataOffset + page * width * height * 2 : value, true);
    }
    view.setUint32(directoryOffset + 2 + tags.length * 12, directoryOffsets[page + 1] || 0, true);
    for (let pixel = 0; pixel < width * height; pixel++) view.setUint16(imageDataOffset + (page * width * height + pixel) * 2, Array.isArray(planes[page]) ? planes[page][pixel] : planes[page], true);
  }
  for (let index = 0; index < xml.length; index++) bytes[descriptionOffset + index] = xml.charCodeAt(index);
  return {bytes: Array.from(bytes), name: 'known-three-channel.ome.tif'};
}

async function loadFixture(page, fixture = make16BitTiff()) {
  await page.goto('/');
  await page.evaluate(async source => {
    const file = new File([Uint8Array.from(source.bytes)], source.name, {type: 'image/tiff'});
    await window.DropletMeasure.addFiles([file]);
  }, fixture);
}

test('loads a 16-bit TIFF and measures exact source values', async ({page}) => {
  const pageErrors = [], requestOrigins = new Set();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => requestOrigins.add(new URL(request.url()).origin));
  await loadFixture(page);
  const result = await page.evaluate(() => {
    const api = window.DropletMeasure, session = api.state.images[api.state.index];
    const plane = api.getPlane(session, session.channels[0].id);
    const measurement = api.measurePlane(plane, {x: 4, y: 4, radiusPx: 3});
    return {pixelType: session.dataset.pixelType, value: plane.values[40], mean: measurement.rawMean, samples: measurement.nPixels, saturation: measurement.saturatedFraction};
  });
  expect(result).toEqual({pixelType: 'uint16', value: 1234, mean: 1234, samples: 13, saturation: null});
  expect([...requestOrigins].every(origin => origin === 'http://127.0.0.1:4173')).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('does not publish partial channel measurements after configuration changes', async ({page}) => {
  await loadFixture(page);
  const result = await page.evaluate(async () => {
    const api = window.DropletMeasure, session = api.state.images[api.state.index];
    session.detections = Array.from({length: 16}, (_, index) => ({id: index + 1, x: 4, y: 4, radiusPx: 3, measurements: {sentinel: true}}));
    const previousRows = session.measurementRows, job = api.state.activeJob;
    const pending = api.quantifySession(session, job);
    session.measuredChannelIds = [];
    const completed = await pending;
    return {completed, keptMeasurements: session.detections.every(item => item.measurements.sentinel), keptRows: session.measurementRows === previousRows};
  });
  expect(result).toEqual({completed: false, keptMeasurements: true, keptRows: true});
});

test('keeps zero-candidate analyses exportable', async ({page}) => {
  await loadFixture(page);
  await page.evaluate(() => window.DropletMeasure.detect());
  const mask = await page.evaluate(() => {
    const session = window.DropletMeasure.state.images[0];
    return {length: session.segmentationMask?.length, width: session.segmentationMaskWidth, height: session.segmentationMaskHeight, method: session.detectedMethod};
  });
  expect(mask).toEqual({length: 81, width: 9, height: 9, method: 'global'});
  await page.locator('#overlayMode').selectOption('binary-mask');
  expect(await page.evaluate(() => window.DropletMeasure.state.view.overlayMode)).toBe('binary-mask');
  await expect(page.locator('#resultPill')).toHaveText('0 candidates');
  await expect(page.locator('#csvBtn')).toBeEnabled();
  await expect(page.locator('#jsonBtn')).toBeEnabled();
  await expect(page.locator('#pngBtn')).toBeDisabled();
  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#jsonBtn').click();
  const jsonDownload = await jsonDownloadPromise;
  const report = JSON.parse(await readFile(await jsonDownload.path(), 'utf8'));
  expect(report.droplets).toEqual([]);
  expect(report.software.build_id).toBe('development');
  expect(report.analysis).toMatchObject({status: 'complete', candidate_count: 0, included_count: 0, excluded_count: 0});
  expect(report.detection).toMatchObject({segmentation_method: 'global', mask_dimensions: [9, 9]});
  expect(report.detection.no_candidates_reason).toContain('constant');
  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#csvBtn').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  expect(csv.trim().split(/\r?\n/)).toHaveLength(1);
  expect(csv).toContain('channel_C0_raw_mean');
});

test('batch applies one compatible recipe and reports incompatible datasets', async ({page}) => {
  await loadFixture(page);
  await page.evaluate(async other => {
    await window.DropletMeasure.addFiles([new File([Uint8Array.from(other.bytes)], other.name, {type: 'image/tiff'})]);
    window.DropletMeasure.state.images[1].channels[0].role = 'other';
  }, make16BitTiff('C1', 4321));
  await page.evaluate(() => window.DropletMeasure.batchAnalyze());
  await expect(page.locator('#batchStatus')).toContainText('1 succeeded, 0 failed, 1 skipped');
  await expect(page.locator('#batchReport li')).toHaveCount(2);
  await expect(page.locator('#batchReport')).toContainText('Channel C0 role does not match the batch recipe');
  await expect(page.locator('#batchCsvBtn')).toBeEnabled();
  await expect(page.locator('#batchManifestBtn')).toBeEnabled();
  const manifestDownload = page.waitForEvent('download');
  await page.locator('#batchManifestBtn').click();
  const download = await manifestDownload;
  const manifest = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(manifest.totals).toEqual({succeeded: 1, failed: 0, skipped: 1});
});

test('batch cancellation finishes the active image and marks remaining files skipped', async ({page}) => {
  await loadFixture(page);
  await page.evaluate(async other => {
    await window.DropletMeasure.addFiles([new File([Uint8Array.from(other.bytes)], other.name, {type: 'image/tiff'})]);
  }, make16BitTiff('second', 4321));
  await page.evaluate(() => {
    const pending = window.DropletMeasure.batchAnalyze();
    setTimeout(() => { if (window.DropletMeasure.state.batch) window.DropletMeasure.state.batch.cancelRequested = true; }, 0);
    return pending;
  });
  await expect(page.locator('#batchStatus')).toContainText('Batch cancelled: 1 succeeded, 0 failed, 1 skipped');
  await expect(page.locator('#batchReport')).toContainText('Cancelled before analysis');
});

test('uses one viewer selector and an accessible calibration dialog', async ({page}) => {
  await loadFixture(page);
  await expect(page.getByRole('combobox', {name: 'Display channel'})).toHaveCount(1);
  await page.locator('#pixelSizeBtn').click();
  await expect(page.locator('#calibrationDialog')).toBeVisible();
  await expect(page.locator('#calibrationValueLabel')).toHaveText('Micrometers per pixel');
  await page.locator('#calibrationValue').fill('0.25');
  await page.locator('#saveCalibrationBtn').click();
  await expect(page.locator('#calibrationDialog')).not.toBeVisible();
  await expect(page.locator('#scaleLabel')).toContainText('0.2500');
  await page.locator('#pixelSizeBtn').click();
  await page.locator('#calibrationValue').fill('0.75');
  await page.locator('#cancelCalibrationBtn').click();
  await expect(page.locator('#scaleLabel')).toContainText('0.2500');
});

test('mobile results drawer returns focus when dismissed with Escape', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/');
  const toggle = page.locator('#resultsToggle');
  await toggle.click();
  await expect(page.locator('#resultsPanel')).toHaveClass(/open/);
  await expect(page.locator('#resultStatus')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#resultsPanel')).not.toHaveClass(/open/);
  await expect(toggle).toBeFocused();
});

test('quantifies the same raw ROI across named OME channels independent of display channel', async ({page}) => {
  await loadFixture(page, makeOmeTiff());
  const result = await page.evaluate(async () => {
    const api = window.DropletMeasure, session = api.state.images[api.state.index];
    session.detections = [{id: 1, x: 4, y: 4, radiusPx: 3, excluded: false, measurements: {}}];
    session.measuredChannelIds = session.channels.map(channel => channel.id);
    const quantified = await api.quantifySession(session, api.state.activeJob);
    const before = session.channels.map(channel => session.detections[0].measurements[channel.id].rawMean);
    session.displayChannelId = session.channels[2].id;
    api.renderCurrentImage();
    const after = session.channels.map(channel => session.detections[0].measurements[channel.id].rawMean);
    return {channelNames: session.channels.map(channel => channel.displayName), roles: session.channels.map(channel => channel.role), pixelTypes: session.channels.map(channel => api.getPlane(session, channel.id).values.constructor.name), quantified, before, after};
  });
  expect(result).toEqual({channelNames: ['Brightfield', 'GFP', 'RFP'], roles: ['brightfield', 'fluorescence', 'fluorescence'], pixelTypes: ['Uint16Array', 'Uint16Array', 'Uint16Array'], quantified: true, before: [111, 222, 333], after: [111, 222, 333]});
});

test('keeps manual exclusions isolated by Z frame and restores them when returning', async ({page}) => {
  const width = 41, height = 41;
  const circle = Array.from({length: width * height}, (_, index) => {
    const x = index % width, y = Math.floor(index / width);
    return (x - 20) ** 2 + (y - 20) ** 2 <= 9 ? 1000 : 0;
  });
  await loadFixture(page, makeOmeTiff({width, height, channelNames: ['Brightfield'], planes: [circle, circle]}));
  const result = await page.evaluate(async () => {
    const api = window.DropletMeasure, session = api.state.images[api.state.index];
    session.settings = {minDiameterPx: 4, maxDiameterPx: 12, minCircularity: .2, smoothing: 0, polarity: 'bright', autoThreshold: false, threshold: 128};
    for (const [id, value] of [['minDiameter', '4'], ['maxDiameter', '12'], ['circularity', '.2'], ['smoothing', '0'], ['threshold', '128']]) document.querySelector(`#${id}`).value = value;
    document.querySelector('#autoThreshold').checked = false;
    await api.detect();
    const firstFrame = {count: session.detections.length, z: session.selectedFrame.z, maskPixels: session.segmentationMask.reduce((sum, value) => sum + value, 0), maskSize: [session.segmentationMaskWidth, session.segmentationMaskHeight]};
    if (!session.detections.length) return {firstFrame, reason: session.noDetectionReason};
    session.detections[0].excluded = true;
    session.selectedFrame.z = 1;
    await api.detect();
    const secondFrame = {count: session.detections.length, z: session.selectedFrame.z, excluded: session.detections[0]?.excluded};
    session.selectedFrame.z = 0;
    await api.detect();
    return {firstFrame, secondFrame, returned: {z: session.selectedFrame.z, excluded: session.detections[0]?.excluded}};
  });
  expect(result.firstFrame).toEqual({count: 1, z: 0, maskPixels: expect.any(Number), maskSize: [41, 41]});
  expect(result.firstFrame.maskPixels).toBeGreaterThan(0);
  expect(result.secondFrame).toEqual({count: 1, z: 1, excluded: false});
  expect(result.returned).toEqual({z: 0, excluded: true});
});