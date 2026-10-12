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
    orientation: 274
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
    if (magic === 43) fail('BigTIFF is not supported yet. Export this image as PNG or JPEG and try again.');
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
      fail('This TIFF uses unsupported sample bit depths. Export it as an 8-bit PNG or JPEG and try again.');
    }
    const formatsRaw = values(fields, TAG.sampleFormat, [1]);
    const formats = formatsRaw.length === 1 ? Array(samples).fill(formatsRaw[0]) : formatsRaw;
    if (formats.length !== samples || formats.some(value => ![1, 2, 3].includes(value)) || formats.some(value => value !== formats[0])) {
      fail('This TIFF uses an unsupported sample format. Export it as PNG or JPEG and try again.');
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
    if (typeof DecompressionStream !== 'function') fail('This browser cannot decompress this TIFF. Export it as PNG or JPEG and try again.');
    const formats = ['deflate', 'deflate-raw'];
    let lastError;
    for (const format of formats) {
      try {
        const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream(format));
        const result = new Uint8Array(await new Response(stream).arrayBuffer());
        if (result.length < expected) fail('The TIFF compressed stream is truncated.');
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
    fail(`This TIFF uses unsupported compression (${compression}). Export it as PNG or JPEG and try again.`);
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

  window.decodeRasterFile = async function(file) {
    const sourceUrl = URL.createObjectURL(file);
    try {
      const img = await loadImage(sourceUrl);
      return {img, url: sourceUrl, width: img.naturalWidth, height: img.naturalHeight};
    } catch (imageError) {
      URL.revokeObjectURL(sourceUrl);
      try {
        return await bitmapFallback(file);
      } catch (bitmapError) {
        if (!(await looksLikeTiff(file))) throw new Error(bitmapError?.message || imageError?.message || 'The browser could not decode this image.');
        try {
          return await decodeTiff(await file.arrayBuffer());
        } catch (tiffError) {
          throw new Error(tiffError?.message || 'This TIFF could not be decoded.');
        }
      }
    }
  };
})();
