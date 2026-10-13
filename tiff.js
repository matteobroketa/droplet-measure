/*
 * Small, dependency-free TIFF fallback for the static app.
 *
 * Browsers do not consistently decode TIFF through <img> or createImageBitmap,
 * even though the file picker advertises image/* and many microscopes export
 * TIFF. This decoder intentionally covers the common microscopy cases locally:
 * classic TIFF, strips or tiles, 8/16/32-bit grayscale/RGB, palette images,
 * PackBits, LZW, and Deflate. Unsupported variants fail with a useful message.
 */
(() => {
  'use strict';

  const TAG = {
    width: 256,
    height: 257,
    bitsPerSample: 258,
    compression: 259,
    photometric: 262,
    stripOffsets: 273,
    samplesPerPixel: 277,
    rowsPerStrip: 278,
    stripByteCounts: 279,
    planarConfiguration: 284,
    predictor: 317,
    colorMap: 320,
    tileWidth: 322,
    tileLength: 323,
    tileOffsets: 324,
    tileByteCounts: 325,
    sampleFormat: 339,
    orientation: 274,
    imageDescription: 270,
    documentName: 269,
    xResolution: 282,
    yResolution: 283,
    resolutionUnit: 296,
    software: 305,
    newSubfileType: 254,
    extraSamples: 338,
    subIfd: 330
  };

  const TYPE_SIZE = {
    1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1,
    7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8
  };

  function fail(message) {
    throw new Error(message);
  }

  function isTiff(file) {
    return /image\/(?:x-)?tiff?/i.test(file.type || '') || /\.(?:tif|tiff)$/i.test(file.name || '');
  }

  async function looksLikeTiff(file) {
    if (isTiff(file)) return true;
    try {
      const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (header.length < 4) return false;
      const little = header[0] === 0x49 && header[1] === 0x49;
      const big = header[0] === 0x4d && header[1] === 0x4d;
      const magic = little ? header[2] | (header[3] << 8) : big ? (header[2] << 8) | header[3] : 0;
      return (little || big) && (magic === 42 || magic === 43);
    } catch {
      return false;
    }
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('The browser could not decode this image.'));
      img.src = url;
    });
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The browser could not create a decoded image.')), 'image/png');
    });
  }

  async function canvasImage(canvas) {
    const blob = await canvasBlob(canvas);
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      return {img, url, width: img.naturalWidth, height: img.naturalHeight};
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  async function bitmapFallback(file) {
    if (typeof createImageBitmap !== 'function') fail('This browser has no image decoder for this format.');
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) fail('The browser could not create a drawing surface.');
      context.drawImage(bitmap, 0, 0);
      return await canvasImage(canvas);
    } finally {
      bitmap.close?.();
    }
  }

  function readType(view, offset, type, little) {
    switch (type) {
      case 1:
      case 7: return view.getUint8(offset);
      case 2: return view.getUint8(offset);
      case 3: return view.getUint16(offset, little);
      case 4: return view.getUint32(offset, little);
      case 5: return view.getUint32(offset, little) / view.getUint32(offset + 4, little);
      case 6: return view.getInt8(offset);
      case 8: return view.getInt16(offset, little);
      case 9: return view.getInt32(offset, little);
      case 10: return view.getInt32(offset, little) / view.getInt32(offset + 4, little);
      case 11: return view.getFloat32(offset, little);
      case 12: return view.getFloat64(offset, little);
      default: fail(`Unsupported TIFF field type ${type}.`);
    }
  }

  function readField(view, entryOffset, little, bufferLength) {
    const type = view.getUint16(entryOffset + 2, little);
    const count = view.getUint32(entryOffset + 4, little);
    const size = TYPE_SIZE[type];
    if (!size || count > Number.MAX_SAFE_INTEGER / size) fail('The TIFF contains an invalid field.');
    const byteLength = size * count;
    const valueOffset = byteLength <= 4 ? entryOffset + 8 : view.getUint32(entryOffset + 8, little);
    if (valueOffset < 0 || valueOffset + byteLength > bufferLength) fail('The TIFF contains an out-of-bounds field.');
    const values = [];
    for (let i = 0; i < count; i++) values.push(readType(view, valueOffset + i * size, type, little));
    return values;
  }

  function readIfd(view, offset, little) {
    if (!offset || offset + 2 > view.byteLength) fail('The TIFF has an invalid image directory.');
    const count = view.getUint16(offset, little);
    const end = offset + 2 + count * 12 + 4;
    if (end > view.byteLength) fail('The TIFF image directory is truncated.');
    const fields = new Map();
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      fields.set(view.getUint16(entry, little), readField(view, entry, little, view.byteLength));
    }
    return {fields, next: view.getUint32(end - 4, little)};
  }

  function one(fields, tag, fallback) {
    const value = fields.get(tag);
    return value?.[0] ?? fallback;
  }

  function values(fields, tag, fallback = []) {
    return fields.get(tag) || fallback;
  }

  function asPositiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) fail(`Invalid TIFF ${label}.`);
    return value;
  }

  function parseTiff(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 8) fail('The TIFF header is truncated.');
    const marker = view.getUint16(0, false);
    if (marker !== 0x4949 && marker !== 0x4d4d) fail('This file is not a TIFF image.');
    const little = marker === 0x4949;
    const magic = view.getUint16(2, little);
    if (magic === 43) fail('BigTIFF is not supported yet. Re-export as classic TIFF or OME-TIFF in a supported sample format, preserving bit depth with lossless compression.');
    if (magic !== 42) fail('The TIFF header has an unsupported format.');

    let ifdOffset = view.getUint32(4, little);
    let fields = null;
    for (let page = 0; page < 32 && ifdOffset; page++) {
      const ifd = readIfd(view, ifdOffset, little);
      if (ifd.fields.has(TAG.width) && ifd.fields.has(TAG.height)) {
        fields = ifd.fields;
        break;
      }
      ifdOffset = ifd.next;
    }
    if (!fields) fail('The TIFF does not contain a readable image page.');

    const width = asPositiveInteger(one(fields, TAG.width, 0), 'width');
    const height = asPositiveInteger(one(fields, TAG.height, 0), 'height');
    const samples = asPositiveInteger(one(fields, TAG.samplesPerPixel, 1), 'samples per pixel');
    const bitsRaw = values(fields, TAG.bitsPerSample, [1]);
    const bits = bitsRaw.length === 1 ? Array(samples).fill(bitsRaw[0]) : bitsRaw;
    if (bits.length !== samples || bits.some(value => ![8, 16, 32].includes(value)) || bits.some(value => value !== bits[0])) {
      fail('This TIFF uses an unsupported sample bit depth. Re-export as a lossless 8-bit or 16-bit classic TIFF/OME-TIFF.');
    }
    const formatsRaw = values(fields, TAG.sampleFormat, [1]);
    const formats = formatsRaw.length === 1 ? Array(samples).fill(formatsRaw[0]) : formatsRaw;
    if (formats.length !== samples || formats.some(value => ![1, 2, 3].includes(value)) || formats.some(value => value !== formats[0])) {
      fail('This TIFF uses an unsupported sample format. Re-export as a lossless integer or Float32 classic TIFF/OME-TIFF supported by this app.');
    }
    const compression = one(fields, TAG.compression, 1);
    const photometric = one(fields, TAG.photometric, 1);
    const planar = one(fields, TAG.planarConfiguration, 1);
    const predictor = one(fields, TAG.predictor, 1);
    const orientation = one(fields, TAG.orientation, 1);

    if (![1, 2].includes(planar)) fail('This TIFF uses an unsupported planar layout.');
    if (![0, 1, 2, 3].includes(photometric)) fail('This TIFF uses an unsupported color model.');
    if (photometric === 2 && samples < 3) fail('This RGB TIFF is missing color channels.');
    if (photometric === 3 && samples !== 1) fail('This palette TIFF has an unsupported channel layout.');
    if (![1, 2, 3, 4, 5, 6, 7, 8].includes(orientation)) fail('This TIFF uses an unsupported orientation.');
    if (![1, 2].includes(predictor)) fail('This TIFF uses an unsupported predictor.');

    const stripOffsets = values(fields, TAG.stripOffsets);
    const stripCounts = values(fields, TAG.stripByteCounts);
    const tileOffsets = values(fields, TAG.tileOffsets);
    const tileCounts = values(fields, TAG.tileByteCounts);
    const tiled = tileOffsets.length > 0 && tileCounts.length > 0;
    if (!tiled && (!stripOffsets.length || stripOffsets.length !== stripCounts.length)) fail('The TIFF has no readable strips or tiles.');
    if (tiled && tileOffsets.length !== tileCounts.length) fail('The TIFF tile tables are inconsistent.');

    const bytesPerSample = bits[0] / 8;
    const tileWidth = tiled ? asPositiveInteger(one(fields, TAG.tileWidth, 0), 'tile width') : width;
    const tileLength = tiled ? asPositiveInteger(one(fields, TAG.tileLength, 0), 'tile length') : asPositiveInteger(one(fields, TAG.rowsPerStrip, height), 'rows per strip');
    const palette = photometric === 3 ? values(fields, TAG.colorMap) : null;
    if (palette && palette.length < (1 << Math.min(bits[0], 16)) * 3) fail('The TIFF palette is incomplete.');

    return {
      buffer,
      view,
      little,
      width,
      height,
      samples,
      bits: bits[0],
      sampleFormat: formats[0],
      compression,
      photometric,
      planar,
      predictor,
      orientation,
      bytesPerSample,
      palette,
      tiled,
      tileWidth,
      tileLength,
      offsets: tiled ? tileOffsets : stripOffsets,
      counts: tiled ? tileCounts : stripCounts
    };
  }

  function packBits(input, expected) {
    const output = new Uint8Array(expected);
    let source = 0;
    let target = 0;
    while (source < input.length && target < expected) {
      const header = input[source++];
      if (header <= 127) {
        const length = header + 1;
        if (source + length > input.length || target + length > expected) fail('The TIFF PackBits stream is invalid.');
        output.set(input.subarray(source, source + length), target);
        source += length;
        target += length;
      } else if (header >= 129) {
        const length = 257 - header;
        if (source >= input.length || target + length > expected) fail('The TIFF PackBits stream is invalid.');
        output.fill(input[source++], target, target + length);
        target += length;
      }
    }
    if (target !== expected) fail('The TIFF PackBits stream is truncated.');
    return output;
  }

  function decodeLzwVariant(input, expected, earlyChange) {
    const CLEAR = 256;
    const EOI = 257;
    const dictionary = [];
    const reset = () => {
      dictionary.length = 0;
      for (let i = 0; i < 256; i++) dictionary[i] = new Uint8Array([i]);
    };
    reset();
    let bit = 0;
    let codeSize = 9;
    let nextCode = 258;
    let previous = null;
    let sawEnd = false;
    const output = new Uint8Array(expected);
    let outputLength = 0;
    const readCode = () => {
      if (bit + codeSize > input.length * 8) return null;
      let code = 0;
      for (let i = 0; i < codeSize; i++) code = (code << 1) | ((input[(bit + i) >> 3] >> (7 - ((bit + i) & 7))) & 1);
      bit += codeSize;
      return code;
    };
    while (true) {
      const code = readCode();
      if (code === null) break;
      if (code === EOI) { sawEnd = true; break; }
      if (code === CLEAR) {
        reset();
        codeSize = 9;
        nextCode = 258;
        previous = null;
        continue;
      }
      let entry = dictionary[code];
      if (!entry && code === nextCode && previous) {
        entry = new Uint8Array(previous.length + 1);
        entry.set(previous);
        entry[entry.length - 1] = previous[0];
      }
      if (!entry) fail('The TIFF LZW stream is invalid.');
      if (outputLength + entry.length > expected) fail('The TIFF LZW stream expands beyond the image.');
      output.set(entry, outputLength);
      outputLength += entry.length;
      if (previous) {
        const added = new Uint8Array(previous.length + 1);
        added.set(previous);
        added[added.length - 1] = entry[0];
        dictionary[nextCode++] = added;
        const boundary = earlyChange ? (1 << codeSize) - 1 : (1 << codeSize);
        if (nextCode === boundary && codeSize < 12) codeSize++;
      }
      previous = entry;
    }
    if (outputLength !== expected || !sawEnd) fail('The TIFF LZW stream is truncated.');
    return output;
  }

  function lzw(input, expected) {
    let lastError;
    for (const earlyChange of [true, false]) {
      try {
        return decodeLzwVariant(input, expected, earlyChange);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('The TIFF LZW stream is invalid.');
  }

  async function inflate(input, expected) {
    if (typeof DecompressionStream !== 'function') fail('This browser cannot decompress this TIFF. Re-export using uncompressed, PackBits, LZW, or Deflate TIFF compression.');
    const formats = ['deflate', 'deflate-raw'];
    let lastError;
    for (const format of formats) {
      try {
        const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream(format));
        const reader = stream.getReader(), chunks = [];
        let length = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > expected) { await reader.cancel(); fail('The TIFF compressed stream expands beyond the declared image segment.'); }
          chunks.push(part.value);
        }
        if (length < expected) fail('The TIFF compressed stream is truncated.');
        const result = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('The TIFF compressed stream is invalid.');
  }

  async function decodeSegment(meta, offset, count, expected) {
    const {view, compression} = meta;
    if (offset < 0 || count < 0 || offset + count > view.byteLength) fail('The TIFF image data is out of bounds.');
    const input = new Uint8Array(meta.buffer, offset, count);
    if (compression === 1) {
      if (input.length < expected) fail('The TIFF image data is truncated.');
      return input;
    }
    if (compression === 32773) return packBits(input, expected);
    if (compression === 5) return lzw(input, expected);
    if (compression === 8 || compression === 32946) return inflate(input, expected);
    fail(`This TIFF uses unsupported compression (${compression}). Re-export using uncompressed, PackBits, LZW, or Deflate TIFF compression.`);
  }

  function segments(meta) {
    const list = [];
    const planeCount = meta.planar === 2 ? meta.samples : 1;
    const rowSegments = meta.tiled ? Math.ceil(meta.height / meta.tileLength) : meta.offsets.length / planeCount;
    if (!Number.isInteger(rowSegments) || rowSegments <= 0) fail('The TIFF segment layout is invalid.');
    let index = 0;
    for (let plane = 0; plane < planeCount; plane++) {
      for (let row = 0; row < rowSegments; row++) {
        if (index >= meta.offsets.length) fail('The TIFF segment table is truncated.');
        const rowStart = meta.tiled ? row * meta.tileLength : (row * meta.tileLength);
        const colStart = meta.tiled ? 0 : 0;
        list.push({
          offset: meta.offsets[index],
          count: meta.counts[index],
          rowStart,
          colStart,
          rowCount: Math.min(meta.tileLength, meta.height - rowStart),
          storageWidth: meta.tileWidth,
          storageRows: meta.tileLength,
          plane: meta.planar === 2 ? plane : 0,
          index
        });
        index++;
      }
    }
    if (meta.tiled) {
      const across = Math.ceil(meta.width / meta.tileWidth);
      const down = Math.ceil(meta.height / meta.tileLength);
      const expectedSegments = across * down * planeCount;
      if (meta.offsets.length !== expectedSegments) fail('The TIFF tile layout is not supported.');
      list.length = 0;
      index = 0;
      for (let plane = 0; plane < planeCount; plane++) {
        for (let ty = 0; ty < down; ty++) for (let tx = 0; tx < across; tx++) {
          const rowStart = ty * meta.tileLength;
          list.push({
            offset: meta.offsets[index],
            count: meta.counts[index],
            rowStart,
            colStart: tx * meta.tileWidth,
            rowCount: Math.min(meta.tileLength, meta.height - rowStart),
            storageWidth: meta.tileWidth,
            storageRows: meta.tileLength,
            plane: meta.planar === 2 ? plane : 0,
            index
          });
          index++;
        }
      }
    }
    return list;
  }

  function sample(view, offset, meta) {
    if (meta.sampleFormat === 1) {
      if (meta.bits === 8) return view.getUint8(offset);
      if (meta.bits === 16) return view.getUint16(offset, meta.little);
      return view.getUint32(offset, meta.little);
    }
    if (meta.sampleFormat === 2) {
      if (meta.bits === 8) return view.getInt8(offset);
      if (meta.bits === 16) return view.getInt16(offset, meta.little);
      return view.getInt32(offset, meta.little);
    }
    if (meta.bits === 32) return view.getFloat32(offset, meta.little);
    fail('This TIFF uses an unsupported floating-point sample depth.');
  }

  function writeSample(view, offset, meta, value) {
    if (meta.sampleFormat === 1) {
      if (meta.bits === 8) return view.setUint8(offset, value);
      if (meta.bits === 16) return view.setUint16(offset, value, meta.little);
      return view.setUint32(offset, value, meta.little);
    }
    if (meta.sampleFormat === 2) {
      if (meta.bits === 8) return view.setInt8(offset, value);
      if (meta.bits === 16) return view.setInt16(offset, value, meta.little);
      return view.setInt32(offset, value, meta.little);
    }
    fail('This TIFF uses an unsupported predictor for floating-point samples.');
  }

  function applyPredictor(meta, segment, bytes) {
    if (meta.predictor !== 2) return;
    if (meta.sampleFormat === 3) fail('This TIFF uses an unsupported predictor for floating-point samples.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const channels = meta.planar === 2 ? 1 : meta.samples;
    const stride = meta.planar === 2 ? 1 : meta.samples;
    const modulus = 2 ** meta.bits;
    for (let row = 0; row < segment.rowCount; row++) for (let column = 1; column < segment.storageWidth; column++) {
      for (let channel = 0; channel < channels; channel++) {
        const position = (row * segment.storageWidth + column) * stride + channel;
        const previousPosition = (row * segment.storageWidth + column - 1) * stride + channel;
        const offset = position * meta.bytesPerSample;
        const previousOffset = previousPosition * meta.bytesPerSample;
        let value = sample(view, offset, meta);
        const previous = sample(view, previousOffset, meta);
        value = meta.sampleFormat === 1 ? (value + previous) % modulus : value + previous;
        writeSample(view, offset, meta, value);
      }
    }
  }

  function applyOrientation(x, y, width, height, orientation) {
    switch (orientation) {
      case 2: return [width - 1 - x, y];
      case 3: return [width - 1 - x, height - 1 - y];
      case 4: return [x, height - 1 - y];
      case 5: return [y, x];
      case 6: return [height - 1 - y, x];
      case 7: return [height - 1 - y, width - 1 - x];
      case 8: return [y, width - 1 - x];
      default: return [x, y];
    }
  }

  function orientedSize(meta) {
    return [meta.orientation >= 5 ? meta.height : meta.width, meta.orientation >= 5 ? meta.width : meta.height];
  }

  function normalized(value, min, max) {
    if (!Number.isFinite(value)) return 0;
    if (max <= min) return 0;
    return Math.max(0, Math.min(255, Math.round((value - min) * 255 / (max - min))));
  }

  async function decodeTiff(buffer) {
    const meta = parseTiff(buffer);
    const list = segments(meta);
    const expectedSegmentBytes = segment => segment.storageWidth * (meta.tiled ? segment.storageRows : segment.rowCount) * meta.samples * meta.bytesPerSample / (meta.planar === 2 ? meta.samples : 1);
    const decoded = [];
    for (const segment of list) {
      const expected = expectedSegmentBytes(segment);
      const bytes = await decodeSegment(meta, segment.offset, segment.count, expected);
      applyPredictor(meta, segment, bytes);
      decoded.push(bytes);
    }
    const decodedViews = decoded.map(bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));

    const sampleAt = (segment, view, row, column, channel) => {
      const planeChannel = meta.planar === 2 ? 0 : channel;
      const position = (row * segment.storageWidth + column) * (meta.planar === 2 ? 1 : meta.samples) + planeChannel;
      const valueOffset = position * meta.bytesPerSample;
      return sample(view, valueOffset, meta);
    };

    let min = Infinity;
    let max = -Infinity;
    if (meta.photometric === 3) {
      min = 0;
      max = (1 << Math.min(meta.bits, 16)) - 1;
    } else {
      for (let i = 0; i < list.length; i++) {
        const segment = list[i];
        const view = decodedViews[i];
        const channels = meta.planar === 2 ? [segment.plane] : Array.from({length: meta.samples}, (_, channel) => channel);
        for (let row = 0; row < segment.rowCount; row++) for (let column = 0; column < segment.storageWidth; column++) {
          for (const channel of channels) {
            const value = sampleAt(segment, view, row, column, channel);
            if (Number.isFinite(value) && (meta.photometric !== 2 || channel < 3)) {
              min = Math.min(min, value);
              max = Math.max(max, value);
            }
          }
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) fail('The TIFF contains no finite pixel values.');
    if (max <= min) {
      min = meta.sampleFormat === 3 ? min - 1 : 0;
      max = meta.sampleFormat === 3 ? max + 1 : (2 ** meta.bits) - 1;
    }

    const [outputWidth, outputHeight] = orientedSize(meta);
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext('2d');
    if (!context) fail('The browser could not create a drawing surface.');
    const output = context.createImageData(outputWidth, outputHeight);
    const put = (x, y, r, g, b, a = 255) => {
      const [ox, oy] = applyOrientation(x, y, meta.width, meta.height, meta.orientation);
      const index = (oy * outputWidth + ox) * 4;
      output.data[index] = r;
      output.data[index + 1] = g;
      output.data[index + 2] = b;
      output.data[index + 3] = a;
    };

    const stripCount = meta.tiled ? 0 : meta.offsets.length / (meta.planar === 2 ? meta.samples : 1);
    const across = meta.tiled ? Math.ceil(meta.width / meta.tileWidth) : 1;
    const down = meta.tiled ? Math.ceil(meta.height / meta.tileLength) : stripCount;
    const pixelRef = (x, y, channel) => {
      const plane = meta.planar === 2 ? channel : 0;
      let index;
      let row;
      let column;
      if (meta.tiled) {
        const tx = Math.floor(x / meta.tileWidth);
        const ty = Math.floor(y / meta.tileLength);
        index = plane * across * down + ty * across + tx;
        row = y - ty * meta.tileLength;
        column = x - tx * meta.tileWidth;
      } else {
        const strip = Math.floor(y / meta.tileLength);
        index = plane * stripCount + strip;
        row = y - strip * meta.tileLength;
        column = x;
      }
      const segment = list[index];
      if (!segment) fail('The TIFF pixel layout is inconsistent.');
      return sampleAt(segment, decodedViews[index], row, column, channel);
    };

    for (let y = 0; y < meta.height; y++) for (let x = 0; x < meta.width; x++) {
      const valuesAtPixel = Array.from({length: meta.samples}, (_, channel) => pixelRef(x, y, channel));
      let r;
      let g;
      let b;
      if (meta.photometric === 3) {
        const index = Math.max(0, Math.min((1 << Math.min(meta.bits, 16)) - 1, Math.round(valuesAtPixel[0] || 0)));
        const entries = (1 << Math.min(meta.bits, 16));
        r = normalized(meta.palette[index], 0, 65535);
        g = normalized(meta.palette[entries + index], 0, 65535);
        b = normalized(meta.palette[entries * 2 + index], 0, 65535);
      } else if (meta.photometric === 2) {
        r = normalized(valuesAtPixel[0], min, max);
        g = normalized(valuesAtPixel[1], min, max);
        b = normalized(valuesAtPixel[2], min, max);
      } else {
        const value = normalized(valuesAtPixel[0], min, max);
        r = g = b = meta.photometric === 0 ? 255 - value : value;
      }
      const alpha = meta.samples >= 4 ? normalized(valuesAtPixel[3], 0, 2 ** meta.bits - 1) : 255;
      put(x, y, r, g, b, alpha);
    }
    context.putImageData(output, 0, 0);
    return await canvasImage(canvas);
  }

  // Scientific dataset loader -------------------------------------------------
  // The legacy decoder above remains available for compatibility, but the app
  // uses the dataset API below.  Raw typed planes never pass through a canvas.
  function scientificTextField(view, entryOffset, little, bufferLength) {
    const type = view.getUint16(entryOffset + 2, little);
    const count = view.getUint32(entryOffset + 4, little);
    if (type !== 2) return '';
    const byteLength = count;
    const valueOffset = byteLength <= 4 ? entryOffset + 8 : view.getUint32(entryOffset + 8, little);
    if (valueOffset < 0 || valueOffset + byteLength > bufferLength) fail('The TIFF image description is out of bounds.');
    const bytes = new Uint8Array(view.buffer, view.byteOffset + valueOffset, byteLength);
    let text;
    try { text = new TextDecoder('utf-8', {fatal: false}).decode(bytes); }
    catch { text = String.fromCharCode(...bytes); }
    return text.replace(/\0+$/, '');
  }

  function scientificReadIfd(view, offset, little) {
    if (!offset || offset + 2 > view.byteLength) fail('The TIFF has an invalid image directory.');
    const count = view.getUint16(offset, little);
    const end = offset + 2 + count * 12 + 4;
    if (end > view.byteLength) fail('The TIFF image directory is truncated.');
    const fields = new Map();
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      const tag = view.getUint16(entry, little);
      const type = view.getUint16(entry + 2, little);
      fields.set(tag, type === 2 ? scientificTextField(view, entry, little, view.byteLength) : readField(view, entry, little, view.byteLength));
    }
    return {fields, next: view.getUint32(end - 4, little)};
  }

  function scientificArray(fields, tag, fallback = []) {
    const value = fields.get(tag);
    return Array.isArray(value) ? value : fallback;
  }

  function scientificPage(buffer, view, little, fields, pageIndex, ifdOffset, next) {
    const width = asPositiveInteger(one(fields, TAG.width, 0), 'width');
    const height = asPositiveInteger(one(fields, TAG.height, 0), 'height');
    const samples = asPositiveInteger(one(fields, TAG.samplesPerPixel, 1), 'samples per pixel');
    if (samples > 16) fail('This TIFF has too many samples per pixel for safe local analysis.');
    const bitsRaw = scientificArray(fields, TAG.bitsPerSample, [1]);
    const bits = bitsRaw.length === 1 ? Array(samples).fill(bitsRaw[0]) : bitsRaw;
    const formatsRaw = scientificArray(fields, TAG.sampleFormat, [1]);
    const formats = formatsRaw.length === 1 ? Array(samples).fill(formatsRaw[0]) : formatsRaw;
    if (bits.length !== samples || bits.some(value => ![8, 16, 32].includes(value)) || bits.some(value => value !== bits[0])) {
      fail('This TIFF uses an unsupported sample bit depth. Re-export as a lossless 8-bit or 16-bit classic TIFF/OME-TIFF.');
    }
    if (formats.length !== samples || formats.some(value => ![1, 2, 3].includes(value)) || formats.some(value => value !== formats[0])) {
      fail('This TIFF uses an unsupported sample format. Re-export as a lossless integer or Float32 classic TIFF/OME-TIFF supported by this app.');
    }
    const compression = one(fields, TAG.compression, 1);
    const photometric = one(fields, TAG.photometric, 1);
    const planar = one(fields, TAG.planarConfiguration, 1);
    const predictor = one(fields, TAG.predictor, 1);
    const orientation = one(fields, TAG.orientation, 1);
    if (![1, 2].includes(planar)) fail('This TIFF uses an unsupported planar layout.');
    if (![0, 1, 2, 3].includes(photometric)) fail('This TIFF uses an unsupported color model.');
    if (photometric === 2 && samples < 3) fail('This RGB TIFF is missing color channels.');
    if (photometric === 3 && samples !== 1) fail('This palette TIFF has an unsupported channel layout.');
    if (![1, 2, 3, 4, 5, 6, 7, 8].includes(orientation)) fail('This TIFF uses an unsupported orientation.');
    if (![1, 2].includes(predictor)) fail('This TIFF uses an unsupported predictor.');
    const stripOffsets = scientificArray(fields, TAG.stripOffsets);
    const stripCounts = scientificArray(fields, TAG.stripByteCounts);
    const tileOffsets = scientificArray(fields, TAG.tileOffsets);
    const tileCounts = scientificArray(fields, TAG.tileByteCounts);
    const tiled = tileOffsets.length > 0 && tileCounts.length > 0;
    if (!tiled && (!stripOffsets.length || stripOffsets.length !== stripCounts.length)) fail('The TIFF has no readable strips or tiles.');
    if (tiled && tileOffsets.length !== tileCounts.length) fail('The TIFF tile tables are inconsistent.');
    const bytesPerSample = bits[0] / 8;
    const tileWidth = tiled ? asPositiveInteger(one(fields, TAG.tileWidth, 0), 'tile width') : width;
    const tileLength = tiled ? asPositiveInteger(one(fields, TAG.tileLength, 0), 'tile length') : asPositiveInteger(one(fields, TAG.rowsPerStrip, height), 'rows per strip');
    const palette = photometric === 3 ? scientificArray(fields, TAG.colorMap) : null;
    if (palette && palette.length < (1 << Math.min(bits[0], 16)) * 3) fail('The TIFF palette is incomplete.');
    const [outputWidth, outputHeight] = orientedSize({width, height, orientation});
    const xResolution = one(fields, TAG.xResolution, null);
    const yResolution = one(fields, TAG.yResolution, null);
    const resolutionUnit = one(fields, TAG.resolutionUnit, 1);
    const toMicrometers = value => {
      if (!Number.isFinite(value) || value <= 0) return null;
      if (resolutionUnit === 2) return 25400 / value;
      if (resolutionUnit === 3) return 10000 / value;
      return null;
    };
    return {
      buffer, view, little, fields, pageIndex, ifdOffset, next,
      width, height, outputWidth, outputHeight, samples, bits: bits[0], sampleFormat: formats[0],
      compression, photometric, planar, predictor, orientation, bytesPerSample, palette,
      tiled, tileWidth, tileLength, offsets: tiled ? tileOffsets : stripOffsets,
      counts: tiled ? tileCounts : stripCounts, description: fields.get(TAG.imageDescription) || '',
      xPixelSizeUm: toMicrometers(xResolution), yPixelSizeUm: toMicrometers(yResolution),
      extraSamples: scientificArray(fields, TAG.extraSamples),
      subIfd: scientificArray(fields, TAG.subIfd),
      reduced: Boolean(one(fields, TAG.newSubfileType, 0) & 1), raw: null
    };
  }

  function scientificPages(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 8) fail('The TIFF header is truncated.');
    const marker = view.getUint16(0, false);
    if (marker !== 0x4949 && marker !== 0x4d4d) fail('This file is not a TIFF image.');
    const little = marker === 0x4949;
    const magic = view.getUint16(2, little);
    if (magic === 43) fail('BigTIFF is not supported yet. Re-export as classic TIFF or OME-TIFF in a supported sample format, preserving bit depth with lossless compression.');
    if (magic !== 42) fail('The TIFF header has an unsupported format.');
    let offset = view.getUint32(4, little);
    const seen = new Set();
    const pages = [];
    for (let i = 0; i < 512 && offset; i++) {
      if (seen.has(offset)) fail('The TIFF image-directory chain is cyclic.');
      seen.add(offset);
      const ifd = scientificReadIfd(view, offset, little);
      if (ifd.fields.has(TAG.width) && ifd.fields.has(TAG.height)) { const page = scientificPage(buffer, view, little, ifd.fields, pages.length, offset, ifd.next); page.ifdIndex = i; pages.push(page); }
      offset = ifd.next;
    }
    if (offset) fail('The TIFF contains too many image directories.');
    if (!pages.length) fail('The TIFF does not contain a readable image page.');
    const usable = pages.filter(page => !page.reduced || pages.every(other => other.reduced));
    return {buffer, view, little, pages: usable, excludedReducedPages: pages.length - usable.length};
  }

  function scientificTypedArray(meta, length) {
    if (meta.sampleFormat === 1) return meta.bits === 8 ? new Uint8Array(length) : meta.bits === 16 ? new Uint16Array(length) : new Uint32Array(length);
    if (meta.sampleFormat === 2) return meta.bits === 8 ? new Int8Array(length) : meta.bits === 16 ? new Int16Array(length) : new Int32Array(length);
    if (meta.bits === 32) return new Float32Array(length);
    fail('This TIFF uses an unsupported floating-point sample depth.');
  }

  async function scientificDecodePage(meta) {
    if (meta.raw) return meta.raw;
    const planeCount = meta.samples, length = meta.outputWidth * meta.outputHeight;
    if (!Number.isSafeInteger(length) || length <= 0 || length > 80000000) fail('This TIFF is too large to decode safely in this browser.');
    if (!Number.isSafeInteger(length * planeCount * meta.bytesPerSample) || length * planeCount * meta.bytesPerSample > 512 * 1024 * 1024) fail('This TIFF exceeds the local raw-memory safety limit.');
    const list = segments(meta);
    const expectedSegmentBytes = segment => segment.storageWidth * (meta.tiled ? segment.storageRows : segment.rowCount) * meta.samples * meta.bytesPerSample / (meta.planar === 2 ? meta.samples : 1);
    const decoded = [];
    for (const segment of list) {
      const expected = expectedSegmentBytes(segment);
      if (!Number.isSafeInteger(expected) || expected <= 0 || expected > 512 * 1024 * 1024) fail('This TIFF segment exceeds the local raw-memory safety limit.');
      const bytes = await decodeSegment(meta, segment.offset, segment.count, expected);
      applyPredictor(meta, segment, bytes);
      decoded.push(bytes);
    }
    const decodedViews = decoded.map(bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const planes = Array.from({length: planeCount}, () => scientificTypedArray(meta, length));
    const sampleAt = (segment, view, row, column, channel) => {
      const planeChannel = meta.planar === 2 ? 0 : channel;
      const position = (row * segment.storageWidth + column) * (meta.planar === 2 ? 1 : meta.samples) + planeChannel;
      return sample(view, position * meta.bytesPerSample, meta);
    };
    const across = meta.tiled ? Math.ceil(meta.width / meta.tileWidth) : 1;
    const down = meta.tiled ? Math.ceil(meta.height / meta.tileLength) : list.length / (meta.planar === 2 ? meta.samples : 1);
    const pixelRef = (x, y, channel) => {
      const plane = meta.planar === 2 ? channel : 0;
      let index, row, column;
      if (meta.tiled) {
        const tx = Math.floor(x / meta.tileWidth), ty = Math.floor(y / meta.tileLength);
        index = plane * across * down + ty * across + tx;
        row = y - ty * meta.tileLength; column = x - tx * meta.tileWidth;
      } else {
        const strip = Math.floor(y / meta.tileLength);
        index = plane * (list.length / (meta.planar === 2 ? meta.samples : 1)) + strip;
        row = y - strip * meta.tileLength; column = x;
      }
      const segment = list[index];
      if (!segment) fail('The TIFF pixel layout is inconsistent.');
      return sampleAt(segment, decodedViews[index], row, column, channel);
    };
    for (let y = 0; y < meta.height; y++) for (let x = 0; x < meta.width; x++) {
      const [ox, oy] = applyOrientation(x, y, meta.width, meta.height, meta.orientation);
      const target = oy * meta.outputWidth + ox;
      for (let channel = 0; channel < planeCount; channel++) planes[channel][target] = pixelRef(x, y, channel);
    }
    meta.raw = {width: meta.outputWidth, height: meta.outputHeight, planes, sampleTypes: planes.map(values => values.constructor.name), photometric: meta.photometric, hasAlpha: meta.samples > (meta.photometric === 2 ? 3 : 1)};
    return meta.raw;
  }

  function xmlNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function scientificToMicrometers(value, unit = 'µm') {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null;
    const normalized = String(unit || 'µm').trim().toLowerCase().replace('μ', 'µ');
    const multiplier = normalized === 'nm' || normalized === 'nanometer' || normalized === 'nanometers' ? .001 : normalized === 'mm' || normalized === 'millimeter' || normalized === 'millimeters' ? 1000 : normalized === 'cm' || normalized === 'centimeter' || normalized === 'centimeters' ? 10000 : normalized === 'm' || normalized === 'meter' || normalized === 'meters' ? 1000000 : normalized === 'µm' || normalized === 'um' || normalized === 'micrometer' || normalized === 'micrometers' ? 1 : null;
    return multiplier === null ? null : Number(value) * multiplier;
  }

  function scientificPixelSize(ome, first, warnings) {
    const x = ome ? scientificToMicrometers(ome.physicalSizeX, ome.physicalSizeXUnit) ?? first.xPixelSizeUm : first.xPixelSizeUm;
    const y = ome ? scientificToMicrometers(ome.physicalSizeY, ome.physicalSizeYUnit) ?? first.yPixelSizeUm : first.yPixelSizeUm;
    const width = first.outputWidth, height = first.outputHeight;
    const aspect = x && y ? x / y : null, imageAspect = width / height;
    // Some microscope exports put the full field-of-view length in OME
    // PhysicalSizeX/Y even though the OME schema defines those fields per
    // pixel. When both values are larger than the image grid and preserve its
    // aspect ratio, use the implied per-pixel scale and retain a provenance
    // warning instead of reporting metre-scale droplets.
    if (ome && x > 10 && y > 10 && Number.isFinite(aspect) && Math.abs(Math.log(aspect / imageAspect)) < .03) {
      warnings.push('OME PhysicalSizeX/Y match the full image field of view rather than one pixel; values were divided by the decoded image dimensions for calibration. Verify the vendor metadata before comparing physical sizes.');
      return {x: x / width, y: y / height, source: 'metadata-field-of-view'};
    }
    return {x, y, source: x || y ? 'metadata' : null};
  }

  function xmlAttributes(element) {
    const result = {};
    if (!element) return result;
    for (const attribute of Array.from(element.attributes || [])) result[attribute.name] = attribute.value;
    return result;
  }

  function scientificParseOme(text) {
    if (!text || !/<(?:[^:>]+:)?(?:OME|Pixels)\b/i.test(text)) return null;
    let pixels = null;
    let channels = [];
    let tiffData = [];
    try {
      if (typeof DOMParser === 'function') {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        if (!doc.querySelector('parsererror')) {
          const all = name => Array.from(doc.getElementsByTagName('*')).filter(node => node.localName === name || node.nodeName === name);
          pixels = all('Pixels')[0] || null;
          channels = pixels ? all('Channel').filter(node => node.parentNode === pixels) : [];
          tiffData = pixels ? all('TiffData').filter(node => node.parentNode === pixels) : [];
        }
      }
    } catch { pixels = null; }
    if (pixels) {
      const attrs = xmlAttributes(pixels);
      return {
        sizeX: xmlNumber(attrs.SizeX, 0), sizeY: xmlNumber(attrs.SizeY, 0), sizeC: xmlNumber(attrs.SizeC, 1),
        sizeZ: xmlNumber(attrs.SizeZ, 1), sizeT: xmlNumber(attrs.SizeT, 1), dimensionOrder: attrs.DimensionOrder || 'XYCZT',
        type: attrs.Type || '', significantBits: xmlNumber(attrs.SignificantBits, null), physicalSizeX: xmlNumber(attrs.PhysicalSizeX, null), physicalSizeY: xmlNumber(attrs.PhysicalSizeY, null),
        physicalSizeXUnit: attrs.PhysicalSizeXUnit || 'µm', physicalSizeYUnit: attrs.PhysicalSizeYUnit || 'µm',
        channels: channels.map(node => xmlAttributes(node)),
        tiffData: tiffData.map(node => xmlAttributes(node)),
        source: 'OME-XML'
      };
    }
    const pixelsMatch = text.match(/<(?:[\w.-]+:)?Pixels\b([^>]*)>/i);
    if (!pixelsMatch) return null;
    const attrs = {};
    for (const match of pixelsMatch[1].matchAll(/([A-Za-z][\w:-]*)\s*=\s*["']([^"']*)["']/g)) attrs[match[1]] = match[2];
    const body = text.slice(pixelsMatch.index + pixelsMatch[0].length, text.search(/<\/(?:[\w.-]+:)?Pixels\s*>/i) < 0 ? text.length : text.search(/<\/(?:[\w.-]+:)?Pixels\s*>/i));
    const channelAttrs = Array.from(body.matchAll(/<(?:[\w.-]+:)?Channel\b([^>]*)>/gi)).map(match => {
      const values = {}; for (const item of match[1].matchAll(/([A-Za-z][\w:-]*)\s*=\s*["']([^"']*)["']/g)) values[item[1]] = item[2]; return values;
    });
    const tdAttrs = Array.from(body.matchAll(/<(?:[\w.-]+:)?TiffData\b([^>]*)>/gi)).map(match => {
      const values = {}; for (const item of match[1].matchAll(/([A-Za-z][\w:-]*)\s*=\s*["']([^"']*)["']/g)) values[item[1]] = item[2]; return values;
    });
    return {
      sizeX: xmlNumber(attrs.SizeX, 0), sizeY: xmlNumber(attrs.SizeY, 0), sizeC: xmlNumber(attrs.SizeC, 1), sizeZ: xmlNumber(attrs.SizeZ, 1), sizeT: xmlNumber(attrs.SizeT, 1),
      dimensionOrder: attrs.DimensionOrder || 'XYCZT', type: attrs.Type || '', significantBits: xmlNumber(attrs.SignificantBits, null), physicalSizeX: xmlNumber(attrs.PhysicalSizeX, null), physicalSizeY: xmlNumber(attrs.PhysicalSizeY, null),
      physicalSizeXUnit: attrs.PhysicalSizeXUnit || 'µm', physicalSizeYUnit: attrs.PhysicalSizeYUnit || 'µm', channels: channelAttrs, tiffData: tdAttrs, source: 'OME-XML'
    };
  }

  function scientificRole(name, fluor) {
    const value = `${name || ''} ${fluor || ''}`.toLowerCase();
    if (/brightfield|\bbf\b|phase|transmit|transmitted|\btrans\b|transmission/.test(value)) return 'brightfield';
    if (fluor || /fluor|gfp|rfp|fitc|tritc|cy\d|dapi|mcherry|mko/.test(value)) return 'fluorescence';
    return 'unknown';
  }

  function scientificLut(name, index) {
    const value = String(name || '').toLowerCase();
    if (/gfp|green|fitc/.test(value)) return 'green';
    if (/rfp|red|tritc|mcherry/.test(value)) return 'magenta';
    if (/cy5|far.?red|blue|dapi/.test(value)) return /blue|dapi/.test(value) ? 'blue' : 'red';
    return index === 1 ? 'green' : index === 2 ? 'magenta' : 'gray';
  }

  function scientificPixelType(page) {
    if (page.sampleFormat === 1) return `uint${page.bits}`;
    if (page.sampleFormat === 2) return `int${page.bits}`;
    return `float${page.bits}`;
  }

  function scientificCoordinateOrder(ome) {
    const order = String(ome?.dimensionOrder || 'XYCZT').toUpperCase().slice(2).split('').filter(axis => ['C', 'Z', 'T'].includes(axis));
    return order.length === 3 ? order : ['C', 'Z', 'T'];
  }

  function scientificCoordsFromLinear(linear, axes, order) {
    const result = {c: 0, z: 0, t: 0};
    let value = linear;
    for (const axis of order) {
      const key = axis.toLowerCase();
      const size = Math.max(1, axes[`size${axis}`]);
      result[key] = value % size;
      value = Math.floor(value / size);
    }
    return result;
  }

  function scientificLinearFromCoords(coords, axes, order) {
    let value = 0, multiplier = 1;
    for (const axis of order) {
      const key = axis.toLowerCase();
      value += (coords[key] || 0) * multiplier;
      multiplier *= Math.max(1, axes[`size${axis}`]);
    }
    return value;
  }

  function scientificChannelList(count, omeChannels, color = false) {
    return Array.from({length: count}, (_, index) => {
      const metadata = omeChannels[index] || {};
      const sourceName = metadata.Name || metadata.name || (color ? 'Color image' : `Channel ${index + 1}`);
      const fluorophore = metadata.Fluor || metadata.Fluorophore || metadata.EmissionWavelength || '';
      return {
        id: `C${index}`,
        index,
        sourceName,
        displayName: sourceName,
        role: color ? 'color-component' : scientificRole(sourceName, fluorophore),
        fluorophore: metadata.Fluor || metadata.Fluorophore || '',
        emissionNm: Number.isFinite(Number(metadata.EmissionWavelength)) ? Number(metadata.EmissionWavelength) : null,
        colorLut: color ? (count === 1 ? 'gray' : index === 0 ? 'red' : index === 1 ? 'green' : 'blue') : scientificLut(sourceName, index),
        quantify: true,
        metadata: metadata
      };
    });
  }

  function scientificMakePlane(typed, page, channelId, z, t) {
    return {width: page.outputWidth, height: page.outputHeight, values: typed, sampleType: typed.constructor.name, channelId, z, t, invalidMask: null, saturationLevel: null, palette: page.palette || null, photometric: page.photometric};
  }

  function scientificMakeColorPlane(page, raw, channelId, z, t) {
    const source = raw.planes.slice(0, Math.min(3, raw.planes.length));
    // This is a derived luminance plane for the default colour-image channel.
    // Keep the source numeric scale instead of clipping 16/32-bit RGB samples
    // into an 8-bit preview range. Component planes remain available through
    // getColorPlane() for explicit R/G/B measurements.
    if (!raw.luminance) {
      raw.luminance = new Float32Array(source[0].length);
      for (let i = 0; i < raw.luminance.length; i++) {
        const r = Number(source[0][i] || 0), g = Number(source[1]?.[i] ?? r), b = Number(source[2]?.[i] ?? r);
        raw.luminance[i] = .2126 * r + .7152 * g + .0722 * b;
      }
    }
    return scientificMakePlane(raw.luminance, page, channelId, z, t);
  }

  function scientificPreviewUrl(plane, channel, maxSide = 640) {
    if (typeof document === 'undefined') return '';
    const scale = Math.min(1, maxSide / Math.max(plane.width, plane.height));
    const width = Math.max(1, Math.round(plane.width * scale)), height = Math.max(1, Math.round(plane.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) return '';
    let min = Infinity, max = -Infinity;
    const values = plane.values;
    for (let i = 0; i < values.length; i += Math.max(1, Math.floor(values.length / 200000))) { const value = Number(values[i]); if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); } }
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
    if (max <= min) max = min + 1;
    const image = context.createImageData(width, height), lut = channel?.colorLut || 'gray', paletteEntries = plane.palette?.length ? Math.floor(plane.palette.length / 3) : 0;
    const color = (value, target, index) => {
      const level = Math.max(0, Math.min(255, Math.round((value - min) * 255 / (max - min))));
      if (lut === 'green') { target[index] = 0; target[index + 1] = level; target[index + 2] = 0; }
      else if (lut === 'red') { target[index] = level; target[index + 1] = 0; target[index + 2] = 0; }
      else if (lut === 'blue') { target[index] = 0; target[index + 1] = 0; target[index + 2] = level; }
      else if (lut === 'magenta') { target[index] = level; target[index + 1] = 0; target[index + 2] = level; }
      else target[index] = target[index + 1] = target[index + 2] = level;
    };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sourceX = Math.min(plane.width - 1, Math.floor(x / scale)), sourceY = Math.min(plane.height - 1, Math.floor(y / scale));
      const value = Number(values[sourceY * plane.width + sourceX]);
      const index = (y * width + x) * 4;
      if (paletteEntries && Number.isFinite(value)) {
        const paletteIndex = Math.max(0, Math.min(paletteEntries - 1, Math.round(value)));
        image.data[index] = Math.round(Number(plane.palette[paletteIndex] || 0) * 255 / 65535);
        image.data[index + 1] = Math.round(Number(plane.palette[paletteEntries + paletteIndex] || 0) * 255 / 65535);
        image.data[index + 2] = Math.round(Number(plane.palette[paletteEntries * 2 + paletteIndex] || 0) * 255 / 65535);
      } else {
        const displayValue = Number.isFinite(value) ? (plane.photometric === 0 ? min + max - value : value) : min;
        color(displayValue, image.data, index);
      }
      image.data[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  }

  function scientificDatasetFromPages(file, inventory, ome) {
    const pages = inventory.pages;
    const warnings = [];
    const first = pages[0];
    if (inventory.excludedReducedPages) warnings.push(`${inventory.excludedReducedPages} reduced/pyramid TIFF page${inventory.excludedReducedPages === 1 ? '' : 's'} were excluded from channel and frame mapping.`);
    const matching = pages.every(page => page.width === first.width && page.height === first.height && page.orientation === first.orientation);
    if (!matching) warnings.push('Image pages do not share the same dimensions or orientation.');
    if (pages.some(page => page.subIfd?.length)) warnings.push('Pyramid sub-IFDs were detected and excluded from channel/frame mapping.');
    const omeGridMatches = !ome || (!ome.sizeX || ome.sizeX === first.width) && (!ome.sizeY || ome.sizeY === first.height);
    if (!omeGridMatches) warnings.push('OME SizeX/SizeY does not match the decoded TIFF plane dimensions.');
    let axes = {sizeC: 1, sizeZ: 1, sizeT: 1};
    let channels = [];
    let mapping = new Map();
    let ambiguous = false;
    let mappingValid = true;
    let mappingSource = ome ? 'OME-XML' : 'single-page TIFF';
    let colorImage = false;
    const key = (c, z, t) => `${c}/${z}/${t}`;
    const pageIndexForIfd = ifdIndex => pages.findIndex(page => page.ifdIndex === ifdIndex);
    const configure = (nextAxes, nextChannels, nextMapping, source, unresolved = false) => {
      axes = nextAxes; channels = nextChannels; mapping = nextMapping; mappingSource = source; ambiguous = unresolved;
    };
    if (ome) {
      axes = {sizeC: Math.max(1, Math.round(ome.sizeC)), sizeZ: Math.max(1, Math.round(ome.sizeZ)), sizeT: Math.max(1, Math.round(ome.sizeT))};
      const order = scientificCoordinateOrder(ome), expected = axes.sizeC * axes.sizeZ * axes.sizeT;
      const packedPageCount = axes.sizeZ * axes.sizeT;
      const packedSamples = pages.length === packedPageCount && first.samples >= axes.sizeC;
      const packedPageCoordinates = pageIndex => {
        const coordinate = {c: 0, z: 0, t: 0};
        let value = pageIndex;
        for (const axis of order) {
          if (axis === 'C') continue;
          const size = Math.max(1, axes[`size${axis}`]);
          coordinate[axis.toLowerCase()] = value % size;
          value = Math.floor(value / size);
        }
        return coordinate;
      };
      const mapPackedPages = () => {
        for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
          const coordinate = packedPageCoordinates(pageIndex);
          for (let c = 0; c < axes.sizeC; c++) mapping.set(key(c, coordinate.z, coordinate.t), {pageIndex, sampleIndex: c});
        }
      };
      const addMapping = (linear, pageIndex, explicitSample = null) => {
        if (linear < 0 || linear >= expected) { warnings.push(`OME metadata referenced an out-of-range plane index ${linear}.`); mappingValid = false; return; }
        if (pageIndex < 0 || pageIndex >= pages.length) { warnings.push(`OME metadata referenced an unavailable IFD/page (${pageIndex}).`); mappingValid = false; return; }
        const coord = scientificCoordsFromLinear(linear, axes, order), page = pages[pageIndex];
        const sampleIndex = explicitSample ?? (packedSamples ? coord.c : 0);
        if (sampleIndex >= page.samples) { warnings.push(`OME channel ${coord.c + 1} is missing from IFD ${pageIndex}.`); mappingValid = false; return; }
        const coordinateKey = key(coord.c, coord.z, coord.t);
        if (mapping.has(coordinateKey)) { warnings.push(`OME metadata mapped plane C${coord.c + 1}, Z${coord.z + 1}, T${coord.t + 1} more than once.`); mappingValid = false; }
        else mapping.set(coordinateKey, {pageIndex, sampleIndex});
      };
      if (ome.tiffData.length) {
        const implicit = ome.tiffData.length === 1 && !['IFD', 'FirstC', 'FirstZ', 'FirstT', 'PlaneCount'].some(name => ome.tiffData[0][name] !== undefined);
        if (implicit && packedSamples) mapPackedPages();
        else if (implicit) for (let linear = 0; linear < Math.min(expected, pages.length); linear++) addMapping(linear, linear);
        else for (const descriptor of ome.tiffData) {
          const firstCoord = {c: xmlNumber(descriptor.FirstC, 0), z: xmlNumber(descriptor.FirstZ, 0), t: xmlNumber(descriptor.FirstT, 0)};
          const start = scientificLinearFromCoords(firstCoord, axes, order), count = Math.max(1, xmlNumber(descriptor.PlaneCount, 1)), ifd = xmlNumber(descriptor.IFD, 0);
          for (let n = 0; n < count; n++) addMapping(start + n, pageIndexForIfd(ifd + n));
        }
      } else if (packedSamples) {
        mapPackedPages();
      } else {
        for (let linear = 0; linear < Math.min(expected, pages.length); linear++) addMapping(linear, linear);
      }
      for (let linear = 0; linear < expected; linear++) { const coordinate = scientificCoordsFromLinear(linear, axes, order); if (!mapping.has(key(coordinate.c, coordinate.z, coordinate.t))) { warnings.push(`OME metadata did not map plane ${linear + 1}.`); mappingValid = false; } }
      const referencedPages = new Set([...mapping.values()].map(descriptor => descriptor.pageIndex));
      const unreferencedPages = pages.map((_, index) => index).filter(index => !referencedPages.has(index));
      if (unreferencedPages.length) { warnings.push(`${unreferencedPages.length} non-reduced TIFF page${unreferencedPages.length === 1 ? '' : 's'} was not referenced by the OME mapping.`); mappingValid = false; }
      channels = scientificChannelList(axes.sizeC, ome.channels, false);
    } else if (pages.length === 1) {
      if (first.photometric === 2 && first.samples >= 3) {
        colorImage = true; channels = scientificChannelList(1, [{Name: 'Color image'}], true); mapping.set(key(0, 0, 0), {pageIndex: 0, sampleIndex: -1});
        if (first.extraSamples.length) warnings.push(`${first.extraSamples.length} alpha/extra TIFF sample${first.extraSamples.length === 1 ? '' : 's'} was excluded from the Color image channel.`);
      } else {
        const extraSamples = Math.min(first.extraSamples.length, Math.max(0, first.samples - 1));
        const intensitySamples = Math.max(1, first.samples - extraSamples);
        axes = {sizeC: intensitySamples, sizeZ: 1, sizeT: 1};
        channels = scientificChannelList(intensitySamples, [], false);
        for (let c = 0; c < intensitySamples; c++) mapping.set(key(c, 0, 0), {pageIndex: 0, sampleIndex: c});
        mappingSource = intensitySamples > 1 ? 'single-page TIFF samples' : 'single-page TIFF';
        if (extraSamples) warnings.push(`${extraSamples} alpha/extra TIFF sample${extraSamples === 1 ? '' : 's'} was excluded from channel mapping.`);
        if (first.photometric === 3) { channels[0].displayName = channels[0].sourceName = 'Palette image'; channels[0].metadata = {...channels[0].metadata, storage: 'TIFF palette index'}; warnings.push('This TIFF uses a display palette; raw measurements are palette indices, not calibrated color intensities.'); }
      }
    } else {
      ambiguous = true; mappingSource = 'unresolved multi-page TIFF'; channels = scientificChannelList(1, [], false);
      warnings.push(`Found ${pages.length} TIFF pages without trustworthy C/Z/T metadata. Page roles require confirmation.`);
    }
    const rawPage = page => page.raw || null;
    const pixelSizeUm = scientificPixelSize(ome, first, warnings);
    const dataset = {
      id: `dataset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: {name: file.name || 'image', sizeBytes: file.size || inventory.buffer.byteLength, format: 'TIFF'},
      width: first.outputWidth, height: first.outputHeight, axes, pixelType: scientificPixelType(first), significantBits: Math.max(1, Math.min(first.bits, ome?.significantBits || first.bits)),
      pixelSizeUm,
      saturationLevel: null,
      channels, planeIndex: [], pages, ambiguous, mappingValid, mappingResolved: !ambiguous && mappingValid, colorImage, alignment: {valid: matching && omeGridMatches, reason: matching && omeGridMatches ? null : 'All mapped source planes must share dimensions and orientation.'},
      provenance: {metadataSource: ome ? 'OME-XML' : 'TIFF IFD', axisMappingSource: mappingSource, warnings},
      pageDescriptions: pages.map((page, index) => ({index, width: page.outputWidth, height: page.outputHeight, bits: page.bits, sampleType: scientificPixelType(page), description: page.description || ''})),
      getPlane({c = 0, z = 0, t = 0} = {}) {
        if (this.ambiguous || !this.mappingResolved) fail('Confirm the TIFF page mapping before measuring.');
        if (!this.mappingValid) fail('OME metadata does not map every requested source plane; measurement is blocked.');
        const descriptor = mapping.get(key(c, z, t)); if (!descriptor) fail(`The requested frame C${c + 1}, Z${z + 1}, T${t + 1} is unavailable.`);
        const page = pages[descriptor.pageIndex], raw = rawPage(page); if (!raw) fail('The TIFF raw page has not been decoded.');
        if (descriptor.sampleIndex === -1) { const plane = scientificMakeColorPlane(page, raw, channels[c]?.id || `C${c}`, z, t); plane.saturationLevel = null; return plane; }
        const sampleIndex = descriptor.sampleIndex || 0;
        if (!raw.planes[sampleIndex]) fail('The requested TIFF channel sample is unavailable.');
        const plane = scientificMakePlane(raw.planes[sampleIndex], page, channels[c]?.id || `C${c}`, z, t); plane.saturationLevel = this.saturationLevel; return plane;
      },
      getColorPlane({component = 0, z = 0, t = 0} = {}) {
        if (!this.colorImage) fail('This dataset does not expose RGB component planes.');
        const page = pages[0], raw = rawPage(page); if (!raw?.planes[component]) fail('The requested RGB component is unavailable.');
        const plane = scientificMakePlane(raw.planes[component], page, `RGB${component}`, z, t); plane.saturationLevel = this.saturationLevel; return plane;
      },
      resolvePageMapping(choice, names = []) {
        if (!this.ambiguous) return;
        if (!['channels', 'z', 't'].includes(choice)) fail('Choose how the TIFF pages should be interpreted.');
        if (pages.some(page => page.samples !== 1)) fail('This multi-page TIFF has multiple samples per page but no trustworthy channel metadata. Export an OME-TIFF or choose a file with one sample per page before mapping it.');
        const pageCount = pages.length;
        const nextAxes = {sizeC: choice === 'channels' ? pageCount : 1, sizeZ: choice === 'z' ? pageCount : 1, sizeT: choice === 't' ? pageCount : 1};
        const nextChannels = scientificChannelList(nextAxes.sizeC, [], false);
        for (let index = 0; index < nextChannels.length; index++) if (names[index]) nextChannels[index].displayName = names[index];
        const nextMapping = new Map();
        for (let index = 0; index < pageCount; index++) {
          const c = choice === 'channels' ? index : 0, z = choice === 'z' ? index : 0, t = choice === 't' ? index : 0;
          nextMapping.set(key(c, z, t), {pageIndex: index, sampleIndex: 0});
        }
        configure(nextAxes, nextChannels, nextMapping, 'user-assigned page mapping', false);
        this.axes = axes; this.channels = channels; this.mappingResolved = true; this.mappingValid = true; this.ambiguous = false;
        this.provenance.axisMappingSource = mappingSource;
        this.provenance.warnings = warnings;
        this.planeIndex = [];
        for (let t = 0; t < axes.sizeT; t++) for (let z = 0; z < axes.sizeZ; z++) for (let c = 0; c < axes.sizeC; c++) {
          const descriptor = mapping.get(key(c, z, t)); if (descriptor) this.planeIndex.push({c, z, t, ...descriptor});
        }
        return this;
      },
      refreshPreview() {
        try {
          let plane;
          if (this.ambiguous) {
            const page = pages[0], raw = rawPage(page);
            plane = page.photometric === 2 && page.samples >= 3 ? scientificMakeColorPlane(page, raw, 'C0', 0, 0) : scientificMakePlane(raw.planes[0], page, 'C0', 0, 0);
            this.previewPlane = plane;
          } else plane = this.getPlane({c: 0, z: 0, t: 0});
          this.previewUrl = scientificPreviewUrl(plane, this.channels[0]);
        } catch { this.previewUrl = ''; }
        return this.previewUrl;
      },
      dispose() { for (const page of pages) page.raw = null; if (this.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(this.previewUrl); }
    };
    for (let t = 0; t < axes.sizeT; t++) for (let z = 0; z < axes.sizeZ; z++) for (let c = 0; c < axes.sizeC; c++) {
      const descriptor = mapping.get(key(c, z, t)); if (descriptor) dataset.planeIndex.push({c, z, t, ...descriptor});
    }
    return dataset;
  }

  async function scientificOpenTiff(file) {
    const buffer = await file.arrayBuffer();
    const inventory = scientificPages(buffer);
    const omeText = inventory.pages.map(page => page.description).find(text => /<(?:[\w.-]+:)?(?:OME|Pixels)\b/i.test(text || '')) || '';
    const ome = scientificParseOme(omeText);
    const dataset = scientificDatasetFromPages(file, inventory, ome);
    const uniquePages = new Set(dataset.pages);
    let estimatedBytes = 0;
    for (const page of uniquePages) {
      const pageBytes = page.outputWidth * page.outputHeight * page.samples * page.bytesPerSample;
      if (!Number.isSafeInteger(pageBytes) || pageBytes < 0 || estimatedBytes + pageBytes > 768 * 1024 * 1024) fail('This TIFF dataset exceeds the browser raw-memory safety limit. Open a smaller crop or export selected channels.');
      estimatedBytes += pageBytes; await scientificDecodePage(page);
    }
    dataset.refreshPreview();
    return dataset;
  }

  async function scientificOpenRaster(file) {
    const sourceUrl = URL.createObjectURL(file);
    try {
      const img = await loadImage(sourceUrl);
      if (img.naturalWidth * img.naturalHeight > 80000000) fail('This raster image is too large to decode safely in this browser.');
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d', {willReadFrequently: true}); if (!context) fail('The browser could not create a drawing surface.');
      context.drawImage(img, 0, 0);
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data, values = new Uint8Array(canvas.width * canvas.height), components = [new Uint8Array(canvas.width * canvas.height), new Uint8Array(canvas.width * canvas.height), new Uint8Array(canvas.width * canvas.height)];
      let color = false;
      for (let i = 0, p = 0; i < rgba.length; i += 4, p++) { const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]; color ||= r !== g || g !== b; components[0][p] = r; components[1][p] = g; components[2][p] = b; values[p] = Math.max(0, Math.min(255, Math.round(.2126 * r + .7152 * g + .0722 * b))); }
      const channel = {id: 'C0', index: 0, sourceName: color ? 'Color image' : 'Channel 1', displayName: color ? 'Color image' : 'Channel 1', role: color ? 'color-component' : 'unknown', colorLut: 'gray', quantify: true, metadata: {source: 'browser raster decoder'}};
      const plane = {width: canvas.width, height: canvas.height, values, sampleType: 'Uint8Array', channelId: 'C0', z: 0, t: 0, invalidMask: null, saturationLevel: null};
      return {
        id: `dataset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, source: {name: file.name || 'image', sizeBytes: file.size || 0, format: file.type || 'raster'}, previewUrl: sourceUrl, width: canvas.width, height: canvas.height,
        axes: {sizeC: 1, sizeZ: 1, sizeT: 1}, pixelType: 'uint8', significantBits: 8, saturationLevel: null, pixelSizeUm: {x: null, y: null, source: null}, channels: [channel], planeIndex: [{c: 0, z: 0, t: 0, pageIndex: 0, sampleIndex: 0}], provenance: {metadataSource: 'browser raster decoder', axisMappingSource: 'single raster image', warnings: color ? ['RGB samples are treated as one color image, not independent scientific fluorescence channels.'] : []}, pageDescriptions: [], pages: [], alignment: {valid: true, reason: null}, ambiguous: false, mappingResolved: true, colorImage: color,
        getPlane() { return plane; }, getColorPlane({component = 0} = {}) { if (!color || !components[component]) fail('Color components are unavailable for this image.'); return {width: canvas.width, height: canvas.height, values: components[component], sampleType: 'Uint8Array', channelId: `RGB${component}`, z: 0, t: 0, invalidMask: null, saturationLevel: null}; }, refreshPreview() { this.previewUrl = sourceUrl; return sourceUrl; }, dispose() { URL.revokeObjectURL(sourceUrl); }
      };
    } catch (error) { URL.revokeObjectURL(sourceUrl); throw error; }
  }

  window.openMicroscopyDataset = async function(file) {
    if (await looksLikeTiff(file)) return scientificOpenTiff(file);
    try { return await scientificOpenRaster(file); }
    catch (imageError) { throw new Error(imageError?.message || 'The browser could not decode this image.'); }
  };

  window.decodeRasterFile = async function(file) {
    const dataset = await window.openMicroscopyDataset(file);
    const previewUrl = dataset.previewUrl || dataset.refreshPreview();
    const img = await loadImage(previewUrl);
    return {img, url: previewUrl, width: dataset.width, height: dataset.height, dataset};
  };
})();
