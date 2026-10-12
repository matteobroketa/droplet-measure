(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const els = {
    fileInput: $('#fileInput'), fluorInput: $('#fluorInput'), workspace: $('#workspace'), dropzone: $('#dropzone'), empty: $('#empty'),
    image: $('#imageCanvas'), overlay: $('#overlayCanvas'), wrap: $('#canvasWrap'), toolbar: $('#canvasToolbar'), queue: $('#queue'), toast: $('#toast'),
    left: document.querySelector('.side.left'), right: document.querySelector('.side.right')
  };
  const ictx = els.image.getContext('2d', {willReadFrequently: true});
  const octx = els.overlay.getContext('2d');
  const MAX_DISPLAY_SIDE = 4096;
  const MAX_DISPLAY_PIXELS = 12000000;
  const ROI_RADIUS_FRACTION = 0.72;
  const state = {
    images: [], index: -1, busy: false, activeJob: 0, detectTimer: null, pendingDetect: false,
    tool: 'pan', drag: null, calibration: null, measure: null, selectedDropletId: null,
    view: {zoom: 1, x: 0, y: 0, overlay: true}, display: {scale: 1, width: 0, height: 0}
  };

  const channelLabels = {brightfield: 'Brightfield', fluorescence: 'Fluorescence', reference: 'Reference', other: 'Other', unknown: 'Unknown', 'color-component': 'Color component'};
  const lutColors = {gray: '#9be0cf', green: '#6bdb9d', red: '#ff8c8c', blue: '#8db7ff', magenta: '#e2a1ff'};
  const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const current = () => state.images[state.index] || null;
  const imageSize = session => ({width: session.dataset.width, height: session.dataset.height});
  const displaySize = session => {
    const {width, height} = imageSize(session), area = width * height;
    const scale = Math.min(1, MAX_DISPLAY_SIDE / Math.max(width, height), Math.sqrt(MAX_DISPLAY_PIXELS / Math.max(1, area)));
    return {scale, width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
  };

  function toast(message, tone = '') {
    els.toast.textContent = message;
    els.toast.dataset.tone = tone;
    els.toast.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.remove('show'), tone === 'error' ? 3600 : 2200);
  }

  function replayClass(element, name) {
    element.classList.remove(name);
    void element.offsetWidth;
    element.classList.add(name);
  }

  function safeName(value) {
    return String(value ?? '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'channel';
  }

  function fmt(value, digits = 1) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
  }

  function byteLabel(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return 'size unknown';
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
    return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  }

  function htmlEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
  }

  function csvValue(value) {
    let text = String(value ?? '');
    if (typeof value === 'string' && /^[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function download(name, blob) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function channelCopy(channel) {
    return {...channel, metadata: channel.metadata ? {...channel.metadata} : {}};
  }

  function finiteCeiling(value) { if (value === null || value === undefined || String(value).trim() === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; }

  function saturationText(channel) { const value = finiteCeiling(channel?.saturationLevel); return value === null ? '' : String(value); }

  function applyChannelSaturation(plane, channel) {
    plane.saturationLevel = finiteCeiling(channel?.saturationLevel);
    return plane;
  }

  function makeSession(dataset, file) {
    const channels = dataset.channels.map(channel => ({...channelCopy(channel), saturationLevel: finiteCeiling(channel.saturationLevel) ?? finiteCeiling(dataset.saturationLevel)}));
    const detection = channels.find(channel => channel.role === 'brightfield')?.id || channels[0]?.id || null;
    return {
      id: dataset.id, file, name: file.name, url: dataset.previewUrl || '', dataset, width: dataset.width, height: dataset.height,
      channels, detectionChannelId: detection, displayChannelId: detection, measuredChannelIds: channels.map(channel => channel.id),
      selectedFrame: {z: 0, t: 0}, mappingResolved: !dataset.ambiguous && dataset.mappingValid !== false, detections: [], measurementRows: {}, analyzed: false,
      stale: false, analysisRevision: 0, lastCompletedRevision: 0, reviewArchive: [], warnings: [...(dataset.provenance?.warnings || [])],
      calibration: dataset.pixelSizeUm?.x && dataset.pixelSizeUm?.y ? {xUmPerPx: dataset.pixelSizeUm.x, yUmPerPx: dataset.pixelSizeUm.y, source: 'metadata'} : null,
      settings: {minDiameterPx: 20, maxDiameterPx: 400, minCircularity: .65, smoothing: 2, polarity: 'auto', autoThreshold: true, threshold: 128},
      displayRanges: {}, externalChannels: [], colorComponents: [], intensityChannelId: detection, selectedDropletId: null
    };
  }

  function installUi() {
    $('#step1 h3').textContent = 'Dataset';
    $('#step1 p').textContent = 'Upload once; inspect channels, axes, and decode status locally.';
    $('#step2 h3').textContent = 'Channels & calibrate';
    $('#step2 p').textContent = 'Choose the detection source, measured channels, and pixel scale.';
    $('#dropzone h1').textContent = 'Drop microscopy image / TIFF dataset here';
    $('#dropzone p').textContent = 'Upload once. Multichannel TIFFs are inspected locally so the same droplets can be measured across registered channels.';
    $('#fluorBtn').textContent = 'Add separate channel (advanced)';
    $('#fluorStatus').textContent = 'Optional only for channels saved in separate files. Multichannel TIFFs do not need re-uploading.';
    $('#detectBtn').textContent = 'Detect droplets';

    const summary = document.createElement('div'); summary.id = 'datasetSummary'; summary.className = 'card dataset-summary'; summary.hidden = true;
    $('#step1').after(summary);

    const detectionCard = $('#polaritySwitch')?.closest('.card');
    const channelCard = document.createElement('div'); channelCard.id = 'channelCard'; channelCard.className = 'card'; channelCard.hidden = true;
    channelCard.innerHTML = '<div class="field" style="margin-top:0"><label><span>Detection source & channel mapping</span><span id="channelSummary" class="mono"></span></label><div id="channelMap" class="channel-map"></div></div><div id="mappingCard" class="mapping-card card" hidden></div><div id="frameControls" class="frame-controls" hidden></div><div id="channelStatus" class="status-line"></div>';
    detectionCard?.before(channelCard);

    const oldChannelField = $('#channelSelect')?.closest('.field');
    if (oldChannelField) {
      oldChannelField.innerHTML = '<label><span>Display channel</span><span id="displayChannelStatus" class="mono">—</span></label><select id="displayChannelSelect" class="viewer-select"></select><div class="help">View selection changes only the preview. Detection and measurements keep their own source channel.</div>';
    }
    const oldHelp = detectionCard?.querySelector('.help:last-child');
    if (oldHelp) oldHelp.textContent = 'Choose the channel with the clearest droplet boundaries. Detection uses this channel only; raw intensity statistics are calculated separately from each selected source plane.';

    const status = document.createElement('div'); status.id = 'resultStatus'; status.className = 'result-status'; status.textContent = 'No dataset loaded';
    $('.side.right .section-title')?.after(status);
    const detail = document.createElement('div'); detail.id = 'dropletDetail'; detail.className = 'card detail-card'; detail.hidden = true; detail.innerHTML = '<h4>Selected droplet</h4><div id="detailGrid" class="detail-grid"></div>'; $('#resultBody')?.closest('.table-wrap')?.after(detail);
    const resultControls = document.createElement('div'); resultControls.id = 'resultChannelControls'; resultControls.className = 'row space'; resultControls.style.margin = '8px 0'; resultControls.innerHTML = '<label class="muted" for="summaryChannel" style="font-size:11px">Channel statistics</label><select id="summaryChannel" class="field-input" style="width:auto;max-width:170px"></select>'; $('#histCanvas')?.before(resultControls);
    const histogramLabel = $('#rangeLabel')?.previousElementSibling; if (histogramLabel) { histogramLabel.id = 'histLabel'; histogramLabel.textContent = 'Intensity distribution'; }
    const recipeTools = document.createElement('div'); recipeTools.className = 'row'; recipeTools.style.cssText = 'gap:6px;margin-top:8px'; recipeTools.innerHTML = '<button class="btn ghost" id="downloadRecipeBtn" type="button">Download recipe</button><button class="btn ghost" id="applyRecipeBtn" type="button">Apply recipe</button><input id="recipeInput" type="file" accept="application/json,.json" hidden>'; $('#copyBtn')?.parentElement?.after(recipeTools);

    const toggle = document.createElement('button'); toggle.id = 'resultsToggle'; toggle.className = 'btn results-toggle'; toggle.textContent = 'Results'; toggle.setAttribute('aria-expanded', 'false'); $('.top-actions')?.prepend(toggle);
    const viewer = document.createElement('select'); viewer.id = 'viewerChannelSelect'; viewer.className = 'viewer-select'; viewer.title = 'Display channel'; viewer.setAttribute('aria-label', 'Display channel'); const viewerLabel = document.createElement('span'); viewerLabel.className = 'zoom-label'; viewerLabel.textContent = 'View'; viewerLabel.style.minWidth = 'auto'; const fit = $('#fitBtn'); fit?.before(viewerLabel, viewer);
    const overlayToggle = document.createElement('button'); overlayToggle.id = 'overlayToggle'; overlayToggle.className = 'toolbtn active'; overlayToggle.textContent = 'Overlay'; overlayToggle.title = 'Toggle droplet overlay'; $('#fitBtn')?.before(overlayToggle);
    const reset = document.createElement('button'); reset.id = 'resetDetectionBtn'; reset.className = 'btn ghost block'; reset.textContent = 'Reset detection'; reset.style.marginTop = '8px'; $('#detectBtn')?.after(reset);
    const restore = document.createElement('button'); restore.id = 'restoreExclusionsBtn'; restore.className = 'btn ghost block'; restore.textContent = 'Restore exclusions'; restore.style.marginTop = '6px'; $('#resetDetectionBtn')?.after(restore);

    const style = document.createElement('style');
    style.textContent = '.field-input{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:10px;padding:6px 8px}.mapping-names{display:grid;gap:5px;margin:7px 0}.mapping-names input{width:100%;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:8px;padding:6px 8px}.channel-meta .fluorophore-input{display:block;width:100%;margin-top:4px;font-size:11px;font-weight:500}.toast[data-tone=error]{border-color:var(--danger);color:#ffdce0}.dataset-summary[hidden],.channelCard[hidden]{display:none!important}';
    document.head.append(style);
  }

  function showPhase(message, tone = '') {
    const status = $('#resultStatus');
    if (status) { status.textContent = message; status.className = `result-status ${tone}`; }
    const step = $('#step3'); if (step) step.classList.toggle('done', Boolean(current()?.analyzed && !current()?.stale));
  }

  function renderSummary(session) {
    const box = $('#datasetSummary'); if (!box) return;
    if (!session) { box.hidden = true; return; }
    const d = session.dataset, axes = d.axes;
    const dtype = d.pixelType || 'unknown pixel type';
    const size = `${d.width.toLocaleString()} × ${d.height.toLocaleString()}`;
    const axis = `C=${axes.sizeC} · Z=${axes.sizeZ} · T=${axes.sizeT}`;
    const warnings = [...new Set(session.warnings || [])];
    box.hidden = false;
    const channelCount = allChannels(session).length;
    const scale = d.pixelSizeUm?.x && d.pixelSizeUm?.y ? `scale ${fmt(d.pixelSizeUm.x, 4)} × ${fmt(d.pixelSizeUm.y, 4)} µm/px` : 'scale not set';
    box.innerHTML = `<strong title="${htmlEscape(session.name)}">${htmlEscape(session.name)}</strong><span>${htmlEscape(size)} · ${htmlEscape(dtype)} · ${htmlEscape(axis)}</span><span>${channelCount} ${channelCount === 1 ? 'channel' : 'channels'} · ${htmlEscape(d.source.format)} · ${htmlEscape(byteLabel(session.file?.size ?? d.source.sizeBytes))}</span><span>${htmlEscape(scale)} · ${d.provenance?.metadataSource === 'OME-XML' ? 'OME metadata' : 'TIFF/raster metadata'}</span>${d.pixelType !== 'uint8' ? '<span class="status-line ready">Raw typed intensities preserved; preview contrast is display-only.</span>' : ''}${warnings.length ? `<span class="warning">${htmlEscape(warnings[0])}</span>` : ''}`;
  }

  function renderQueue() {
    els.queue.replaceChildren();
    state.images.forEach((session, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = `thumb${index === state.index ? ' active' : ''}`; button.disabled = state.busy;
      const image = document.createElement('img'); image.alt = `Preview of ${session.name}`; image.src = session.url || session.dataset.previewUrl || ''; const label = document.createElement('span'); label.title = session.name; label.textContent = session.name;
      button.append(image, label); button.onclick = () => selectImage(index); els.queue.append(button);
    });
    $('#imageCounter').textContent = `${state.images.length} image${state.images.length === 1 ? '' : 's'}`;
    $('#step1').classList.toggle('done', state.images.length > 0);
    $('#batchBtn').disabled = state.images.length < 2 || state.busy;
  }

  function channelById(session, id) {
    return allChannels(session).find(channel => channel.id === id) || session.channels[0] || session.externalChannels[0] || null;
  }

  function externalChannel(session, id) {
    return session.externalChannels.find(channel => channel.id === id) || null;
  }

  function getPlane(session, channelId, frame = session.selectedFrame) {
    const colorComponent = session.colorComponents.find(channel => channel.id === channelId);
    if (colorComponent) return applyChannelSaturation(session.dataset.getColorPlane({component: colorComponent.component, z: frame.z, t: frame.t}), colorComponent);
    const external = externalChannel(session, channelId);
    if (external) {
      const plane = external.dataset.getPlane({c: 0, z: frame.z, t: frame.t});
      if (plane.width !== session.width || plane.height !== session.height) throw new Error(`Channel ${external.displayName} is not aligned to the dataset dimensions.`);
      return applyChannelSaturation(plane, external);
    }
    const channel = session.channels.findIndex(item => item.id === channelId);
    if (channel < 0) throw new Error('The selected channel is unavailable.');
    const plane = session.dataset.getPlane({c: channel, z: frame.z, t: frame.t});
    if (plane.width !== session.width || plane.height !== session.height) throw new Error(`Channel ${channelById(session, channelId)?.displayName || channelId} is not aligned to the dataset dimensions.`);
    return applyChannelSaturation(plane, session.channels[channel]);
  }

  function allChannels(session) { return [...session.channels, ...session.colorComponents, ...session.externalChannels]; }

  function enableColorComponents(session) {
    if (!session?.dataset.colorImage || session.colorComponents.length || typeof session.dataset.getColorPlane !== 'function') return;
    session.colorComponents = [
      {id: 'RGB-R', index: 0, component: 0, sourceName: 'Red component', displayName: 'Red component', role: 'color-component', colorLut: 'red', quantify: false, metadata: {source: 'RGB color image', component: 'R'}},
      {id: 'RGB-G', index: 1, component: 1, sourceName: 'Green component', displayName: 'Green component', role: 'color-component', colorLut: 'green', quantify: false, metadata: {source: 'RGB color image', component: 'G'}},
      {id: 'RGB-B', index: 2, component: 2, sourceName: 'Blue component', displayName: 'Blue component', role: 'color-component', colorLut: 'blue', quantify: false, metadata: {source: 'RGB color image', component: 'B'}}
    ];
    session.measuredChannelIds.push(...session.colorComponents.map(channel => channel.id));
    renderChannelMap(session); renderDisplayOptions(session); renderCurrentImage(); markStale(session, 'RGB components exposed · run detection to quantify them'); toast('RGB components exposed as explicitly labelled color channels');
  }

  function renderDisplayOptions(session) {
    const selects = [$('#displayChannelSelect'), $('#viewerChannelSelect'), $('#summaryChannel')].filter(Boolean);
    const channels = allChannels(session);
    const options = channels.map(channel => `<option value="${htmlEscape(channel.id)}">${htmlEscape(channel.displayName)}${channel.role === 'color-component' ? ' · color' : ''}</option>`).join('');
    const composite = channels.length > 1 ? '<option value="composite">Composite</option>' : '';
    selects.forEach(select => {
      const prior = select.value; select.innerHTML = select.id === 'summaryChannel' ? options : options + composite;
      if ([...select.options].some(option => option.value === (select.id === 'summaryChannel' ? session.intensityChannelId : session.displayChannelId))) select.value = select.id === 'summaryChannel' ? session.intensityChannelId : session.displayChannelId;
      else if ([...select.options].some(option => option.value === prior)) select.value = prior;
    });
    $('#displayChannelSelect').disabled = channels.length <= 1;
    $('#displayChannelStatus').textContent = channels.length <= 1 ? 'Channel 1' : channelById(session, session.displayChannelId)?.displayName || '—';
    $('#channelSummary').textContent = `${channels.length} available`;
  }

  function renderChannelMap(session) {
    const card = $('#channelCard'); if (!card) return;
    card.hidden = !session;
    if (!session) return;
    const channels = allChannels(session), map = $('#channelMap');
    const roles = ['unknown', 'brightfield', 'fluorescence', 'reference', 'other', 'color-component'];
    const roleOptions = channel => roles.map(role => `<option value="${role}" ${channel.role === role ? 'selected' : ''}>${channelLabels[role] || role}</option>`).join('');
    const saturationControl = channel => `<label class="saturation-control" title="Optional known per-channel saturation ceiling">ceiling <input type="number" step="any" data-saturation="${htmlEscape(channel.id)}" value="${htmlEscape(saturationText(channel))}" placeholder="not assessed" aria-label="${htmlEscape(channel.displayName)} saturation ceiling"></label>`;
    const fluorophoreControl = channel => channel.role === 'fluorescence' ? `<input class="fluorophore-input" data-fluorophore="${htmlEscape(channel.id)}" value="${htmlEscape(channel.fluorophore || '')}" placeholder="fluorophore (optional)" aria-label="${htmlEscape(channel.displayName)} fluorophore">` : '';
    map.innerHTML = '';
    if (channels.length === 1 && !session.dataset.ambiguous) {
      const channel = channels[0];
      map.innerHTML = `<div class="help">${session.dataset.colorImage ? 'One color image detected. It is used as a derived luminance view unless RGB components are exposed.' : 'One intensity channel detected. It is locked as the detection source and measured directly.'}</div><div class="channel-row selected"><span class="channel-swatch" style="background:${lutColors[channel.colorLut] || 'var(--accent)'}"></span><div class="channel-meta"><input data-name="${htmlEscape(channel.id)}" value="${htmlEscape(channel.displayName)}" aria-label="Channel name">${fluorophoreControl(channel)}<small>${htmlEscape(channelLabels[channel.role] || 'Intensity channel')} · source ${htmlEscape(channel.sourceName || channel.id)}</small></div><div class="channel-actions"><select data-role="${htmlEscape(channel.id)}" aria-label="Channel role">${roleOptions(channel)}</select>${saturationControl(channel)}<label><input type="checkbox" data-quantify="${htmlEscape(channel.id)}" checked disabled> measure</label></div></div>${session.dataset.colorImage ? '<button type="button" class="btn ghost block" data-color-components>Expose RGB components (advanced)</button>' : ''}`;
      attachChannelHandlers(session);
    } else {
      channels.forEach(channel => {
        const row = document.createElement('div'); row.className = `channel-row${session.detectionChannelId === channel.id ? ' selected' : ''}`; row.dataset.channel = channel.id;
        row.innerHTML = `<span class="channel-swatch" style="background:${lutColors[channel.colorLut] || 'var(--accent)'}"></span><div class="channel-meta"><input data-name="${htmlEscape(channel.id)}" value="${htmlEscape(channel.displayName)}" aria-label="${htmlEscape(channel.id)} channel name">${fluorophoreControl(channel)}<small>${htmlEscape(channel.id)} · ${htmlEscape(channelLabels[channel.role] || 'Channel')}${channel.sourceName && channel.sourceName !== channel.displayName ? ` · source ${htmlEscape(channel.sourceName)}` : ''}</small></div><div class="channel-actions"><select data-role="${htmlEscape(channel.id)}" aria-label="${htmlEscape(channel.displayName)} role">${roleOptions(channel)}</select>${saturationControl(channel)}<label title="Use this channel to find droplets"><input type="radio" name="detection-channel" data-detection="${htmlEscape(channel.id)}" ${session.detectionChannelId === channel.id ? 'checked' : ''}> detect</label><label title="Include this source plane in raw measurements"><input type="checkbox" data-quantify="${htmlEscape(channel.id)}" ${session.measuredChannelIds.includes(channel.id) ? 'checked' : ''}> measure</label><button class="btn ghost" data-view="${htmlEscape(channel.id)}" type="button">View</button></div>`;
        map.append(row);
      });
      attachChannelHandlers(session);
    }
    map.insertAdjacentHTML('beforeend', '<div class="help">Saturation is not assessed unless a known per-channel ceiling is entered; the TIFF container bit depth alone is not treated as a camera ceiling.</div>');
    renderDisplayOptions(session);
    renderMappingCard(session);
    renderFrameControls(session);
    $('#channelStatus').textContent = `Detection: ${channelById(session, session.detectionChannelId)?.displayName || '—'} · ${session.measuredChannelIds.length} channel${session.measuredChannelIds.length === 1 ? '' : 's'} quantified`;
  }

  function attachChannelHandlers(session) {
    $$('[data-name]').forEach(input => input.onchange = () => {
      const channel = channelById(session, input.dataset.name) || externalChannel(session, input.dataset.name); if (!channel) return;
      const name = input.value.trim(); if (!name) return toast('Channel names cannot be empty', 'error'); channel.displayName = name; renderChannelMap(session); updateResults();
    });
    $$('[data-role]').forEach(select => select.onchange = () => { const channel = channelById(session, select.dataset.role); if (channel) { channel.role = select.value; channel.metadata = {...channel.metadata, userRole: select.value}; renderChannelMap(session); renderSummary(session); updateResults(); } });
    $$('[data-fluorophore]').forEach(input => input.onchange = () => { const channel = channelById(session, input.dataset.fluorophore); if (!channel) return; channel.fluorophore = input.value.trim(); channel.metadata = {...channel.metadata, userFluorophore: channel.fluorophore}; renderChannelMap(session); renderSummary(session); updateResults(); });
    $$('[data-detection]').forEach(radio => radio.onchange = () => { if (!radio.checked) return; session.detectionChannelId = radio.dataset.detection; session.intensityChannelId = session.detectionChannelId; markStale(session, 'Detection channel changed · results need recomputation'); renderChannelMap(session); renderCurrentImage(); requestDetect(80); });
    $$('[data-quantify]').forEach(check => check.onchange = () => {
      if (!check.checked && check.dataset.quantify === session.detectionChannelId) { check.checked = true; return toast('The detection channel must remain quantified.'); }
      session.measuredChannelIds = allChannels(session).filter(channel => $(`[data-quantify="${channel.id}"]`)?.checked).map(channel => channel.id);
      if (!session.measuredChannelIds.includes(session.detectionChannelId)) session.measuredChannelIds.push(session.detectionChannelId);
      renderChannelMap(session);
      if (session.analyzed && !session.stale) remeasureCurrent(); else updateResults();
    });
    $$('[data-saturation]').forEach(input => input.onchange = () => {
      const channel = channelById(session, input.dataset.saturation);
      if (!channel) return;
      const text = input.value.trim(), value = text === '' ? null : Number(text);
      if (value !== null && (!Number.isFinite(value) || value < 0)) { input.value = saturationText(channel); return toast('Enter a non-negative saturation ceiling.', 'error'); }
      channel.saturationLevel = value;
      renderChannelMap(session);
      if (session.analyzed && !session.stale) remeasureCurrent(); else updateResults();
    });
    $$('[data-view]').forEach(button => button.onclick = () => { session.displayChannelId = button.dataset.view; renderDisplayOptions(session); renderCurrentImage(); renderOverlay(); });
    $$('[data-color-components]').forEach(button => button.onclick = () => enableColorComponents(session));
  }

  function renderMappingCard(session) {
    const card = $('#mappingCard'); if (!card) return;
    if (!session.dataset.ambiguous) { card.hidden = true; return; }
    card.hidden = false;
    const pages = session.dataset.pageDescriptions || [];
    card.innerHTML = `<h4>How should these pages be interpreted?</h4><div class="help">Found ${pages.length} TIFF pages without reliable C/Z/T metadata. Quantification is blocked until you confirm the mapping.</div><label class="mapping-choice"><input type="radio" name="page-mapping" value="channels" checked> ${pages.length} channels at one frame</label><label class="mapping-choice"><input type="radio" name="page-mapping" value="z"> ${pages.length} Z slices</label><label class="mapping-choice"><input type="radio" name="page-mapping" value="t"> ${pages.length} time points</label><label class="mapping-choice"><input type="radio" name="page-mapping" value="other" disabled> Other / inspect (not available in this browser-only workflow)</label><div class="mapping-names"><div class="help">Optional channel names (used when pages are mapped as channels)</div>${pages.map((page, index) => `<input data-map-name value="Channel ${index + 1}" aria-label="Page ${index + 1} channel name">`).join('')}</div><div class="page-list">${pages.map((page, index) => `<div>Page ${index + 1}: ${page.width}×${page.height} · ${htmlEscape(page.sampleType)}${page.description ? ` · ${htmlEscape(page.description.slice(0, 80))}` : ''}</div>`).join('')}</div><button id="confirmMapping" class="btn primary block" type="button">Confirm mapping</button>`;
    $('#confirmMapping').onclick = () => { const choice = $('input[name="page-mapping"]:checked')?.value, names = $$('#mappingCard [data-map-name]').map(input => input.value.trim()); try { session.dataset.resolvePageMapping(choice, names); session.mappingResolved = true; session.channels = session.dataset.channels.map(channelCopy); session.detectionChannelId = session.channels[0]?.id || null; session.displayChannelId = session.detectionChannelId; session.measuredChannelIds = session.channels.map(channel => channel.id); session.warnings = session.dataset.provenance.warnings; renderChannelMap(session); renderSummary(session); renderCurrentImage(); $('#detectBtn').disabled = false; showPhase('Ready to detect'); toast('Page mapping saved for this dataset'); } catch (error) { toast(error.message, 'error'); } };
  }

  function renderFrameControls(session) {
    const box = $('#frameControls'); if (!box) return;
    const {sizeZ, sizeT} = session.dataset.axes;
    if (sizeZ <= 1 && sizeT <= 1) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false; box.innerHTML = `<div class="field" style="margin-top:0"><label for="zSelect">Z plane</label><select id="zSelect">${Array.from({length: sizeZ}, (_, i) => `<option value="${i}" ${i === session.selectedFrame.z ? 'selected' : ''}>Z${i + 1}</option>`).join('')}</select></div><div class="field" style="margin-top:0"><label for="tSelect">Time point</label><select id="tSelect">${Array.from({length: sizeT}, (_, i) => `<option value="${i}" ${i === session.selectedFrame.t ? 'selected' : ''}>T${i + 1}</option>`).join('')}</select></div>`;
    $('#zSelect').onchange = event => { session.selectedFrame.z = Number(event.target.value); markStale(session, 'Z plane changed · results need recomputation'); renderCurrentImage(); requestDetect(80); };
    $('#tSelect').onchange = event => { session.selectedFrame.t = Number(event.target.value); markStale(session, 'Time point changed · results need recomputation'); renderCurrentImage(); requestDetect(80); };
  }

  function syncSettingsFromUi(session) {
    const previous = session.settings;
    const numberFrom = (id, fallback) => { const value = Number($('#' + id)?.value); return Number.isFinite(value) ? value : fallback; };
    const minDiameterPx = Math.max(1, numberFrom('minDiameter', previous.minDiameterPx || 20));
    const maxDiameterPx = Math.max(minDiameterPx, numberFrom('maxDiameter', previous.maxDiameterPx || 400));
    const minCircularity = Math.max(.2, Math.min(.98, numberFrom('circularity', previous.minCircularity ?? .65)));
    const smoothing = Math.max(0, Math.min(5, Math.round(numberFrom('smoothing', previous.smoothing ?? 2))));
    const threshold = Math.max(0, Math.min(255, numberFrom('threshold', previous.threshold ?? 128)));
    session.settings = {minDiameterPx, maxDiameterPx, minCircularity, smoothing, polarity: previous.polarity || 'auto', autoThreshold: Boolean($('#autoThreshold')?.checked), threshold};
    $('#minDiameter').value = minDiameterPx; $('#maxDiameter').value = maxDiameterPx; $('#circularity').value = minCircularity; $('#smoothing').value = smoothing; $('#threshold').value = threshold;
  }

  function syncUiFromSettings(session) {
    const settings = session.settings;
    $('#minDiameter').value = settings.minDiameterPx; $('#maxDiameter').value = settings.maxDiameterPx; $('#circularity').value = settings.minCircularity; $('#circularity').nextElementSibling;
    $('#circVal').textContent = Number(settings.minCircularity).toFixed(2); $('#smoothing').value = settings.smoothing; $('#smoothVal').textContent = `${settings.smoothing} px`; $('#autoThreshold').checked = settings.autoThreshold; $('#threshold').value = settings.threshold; $('#threshold').disabled = settings.autoThreshold; $('#thresholdVal').textContent = settings.autoThreshold ? 'auto' : settings.threshold;
    $$('#polaritySwitch button').forEach(button => button.classList.toggle('active', button.dataset.v === settings.polarity));
  }

  async function addFiles(files) {
    const candidates = [...files].filter(file => (file.type || '').startsWith('image/') || /\.(?:png|jpe?g|tiff?|bmp|webp)$/i.test(file.name));
    if (!candidates.length) return toast('No supported image files found', 'error');
    let firstAdded = false;
    for (const file of candidates) {
      try {
        showPhase(`Reading metadata → decoding channels: ${file.name}`, 'busy');
        const dataset = await window.openMicroscopyDataset(file), session = makeSession(dataset, file);
        state.images.push(session); firstAdded ||= state.images.length === 1;
      } catch (error) { toast(`${file.name}: ${error?.message || 'Could not decode this image.'}`, 'error'); }
    }
    renderQueue();
    if (firstAdded) await loadCurrent(0); else if (current()) updateQueueOnly(); else showPhase('No dataset loaded · choose another file', 'error');
  }

  function updateQueueOnly() {
    renderQueue();
    const session = current();
    if (!session) return;
    renderSummary(session);
    renderChannelMap(session);
    updateResults();
    showPhase(session.dataset.ambiguous ? 'Page mapping required before detection' : session.dataset.mappingValid === false ? 'Metadata mapping is incomplete · detection blocked' : session.analyzed && !session.stale ? `${session.detections.length} candidates · ${session.measuredChannelIds.length} channel${session.measuredChannelIds.length === 1 ? '' : 's'} quantified` : 'Ready to detect', session.dataset.ambiguous || session.dataset.mappingValid === false ? 'warn' : '');
  }

  async function loadCurrent(index = state.index) {
    if (index < 0 || index >= state.images.length) return;
    if (state.detectTimer) { clearTimeout(state.detectTimer); state.detectTimer = null; }
    state.index = index; const session = current(); state.selectedDropletId = session.selectedDropletId; state.display = displaySize(session);
    state.drag = null; state.calibration = null; state.measure = null; state.tool = 'pan'; els.overlay.style.cursor = 'grab';
    renderQueue(); renderSummary(session); renderChannelMap(session); syncUiFromSettings(session); renderCurrentImage(); fitImage(); updateScaleUi(); updateResults(); renderOverlay();
    els.empty.hidden = true; els.empty.classList.add('has-image'); els.toolbar.hidden = false; $('#detectBtn').disabled = Boolean(session.dataset.ambiguous || session.dataset.mappingValid === false || state.busy); $('#fluorBtn').disabled = false; $('#batchBtn').disabled = state.images.length < 2 || state.busy;
    replayClass(els.workspace, 'image-ready');
    if (session.dataset.ambiguous) showPhase('Page mapping required before detection', 'warn'); else if (session.dataset.mappingValid === false) showPhase('Metadata mapping is incomplete · detection blocked', 'error'); else if (session.analyzed && !session.stale) showPhase(`${session.detections.length} candidates · ${session.measuredChannelIds.length} channel${session.measuredChannelIds.length === 1 ? '' : 's'} quantified`, 'ready'); else showPhase('Ready to detect', '');
  }

  function selectImage(index) { if (index === state.index) return; if (state.busy) return toast('Wait for the current analysis to finish'); loadCurrent(index); }

  function frameKey(session, channelId = session.displayChannelId, frame = session.selectedFrame) {
    return `${channelId}:${frame.z}:${frame.t}`;
  }

  function rawRange(plane, session, channelId) {
    const key = frameKey(session, channelId, {z: plane.z || 0, t: plane.t || 0});
    const cached = session.displayRanges[key];
    if (cached && cached.source === plane.values) return cached;
    const values = plane.values, maxSamples = 200000, stride = Math.max(1, Math.ceil(values.length / maxSamples));
    let min = Infinity, max = -Infinity, count = 0;
    for (let i = 0; i < values.length; i += stride) {
      const value = Number(values[i]);
      if (!Number.isFinite(value)) continue;
      min = Math.min(min, value); max = Math.max(max, value); count++;
    }
    if (!count || !Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
    if (min === max) max = min + 1;
    const range = {min, max, source: values};
    session.displayRanges[key] = range;
    return range;
  }

  function lutColor(level, lut = 'gray') {
    const value = Math.max(0, Math.min(255, level));
    if (lut === 'red') return [value, 0, 0];
    if (lut === 'green') return [0, value, 0];
    if (lut === 'blue') return [0, 0, value];
    if (lut === 'magenta') return [value, 0, value];
    return [value, value, value];
  }

  function paletteColor(plane, value) {
    if (!plane?.palette?.length || !Number.isFinite(value)) return null;
    const entries = Math.floor(plane.palette.length / 3), index = Math.max(0, Math.min(entries - 1, Math.round(value)));
    return [0, 1, 2].map(offset => Math.max(0, Math.min(255, Math.round(Number(plane.palette[offset * entries + index] || 0) * 255 / 65535))));
  }

  function displayLevel(value, range) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(255, Math.round((value - range.min) * 255 / Math.max(1e-12, range.max - range.min))));
  }

  function planeToPreview(plane, channel, session, targetWidth, targetHeight) {
    const output = new ImageData(targetWidth, targetHeight);
    const data = output.data, sx = plane.width / targetWidth, sy = plane.height / targetHeight;
    const range = rawRange(plane, session, channel.id);
    for (let y = 0; y < targetHeight; y++) {
      const sourceY = Math.min(plane.height - 1, Math.floor(y * sy));
      for (let x = 0; x < targetWidth; x++) {
        const sourceX = Math.min(plane.width - 1, Math.floor(x * sx));
        const value = plane.values[sourceY * plane.width + sourceX], palette = paletteColor(plane, Number(value)), level = displayLevel(Number(value), range), display = plane.photometric === 0 ? 255 - level : level;
        const [r, g, b] = palette || lutColor(display, channel.colorLut);
        const index = (y * targetWidth + x) * 4;
        data[index] = r; data[index + 1] = g; data[index + 2] = b; data[index + 3] = 255;
      }
    }
    return output;
  }

  function compositeToPreview(session, targetWidth, targetHeight) {
    const channels = session.colorComponents.length ? [...session.colorComponents, ...session.externalChannels] : allChannels(session).filter(channel => channel.id !== 'composite');
    const planes = channels.map(channel => ({channel, plane: getPlane(session, channel.id)}));
    const output = new ImageData(targetWidth, targetHeight), data = output.data;
    const sx = session.width / targetWidth, sy = session.height / targetHeight;
    const ranges = planes.map(({channel, plane}) => ({channel, plane, range: rawRange(plane, session, channel.id)}));
    for (let y = 0; y < targetHeight; y++) for (let x = 0; x < targetWidth; x++) {
      const sourceX = Math.min(session.width - 1, Math.floor(x * sx)), sourceY = Math.min(session.height - 1, Math.floor(y * sy));
      let r = 0, g = 0, b = 0;
      for (const {channel, plane, range} of ranges) {
        const level = displayLevel(Number(plane.values[sourceY * plane.width + sourceX]), range);
        const color = lutColor(level, channel.colorLut);
        r = Math.min(255, r + color[0]); g = Math.min(255, g + color[1]); b = Math.min(255, b + color[2]);
      }
      const index = (y * targetWidth + x) * 4; data[index] = r; data[index + 1] = g; data[index + 2] = b; data[index + 3] = 255;
    }
    return output;
  }

  function colorImageToPreview(session, targetWidth, targetHeight) {
    const planes = [0, 1, 2].map(component => session.dataset.getColorPlane({component}));
    const ranges = planes.map((plane, index) => rawRange(plane, session, `RGB${index}`)), output = new ImageData(targetWidth, targetHeight), data = output.data, sx = session.width / targetWidth, sy = session.height / targetHeight;
    for (let y = 0; y < targetHeight; y++) for (let x = 0; x < targetWidth; x++) {
      const sourceX = Math.min(session.width - 1, Math.floor(x * sx)), sourceY = Math.min(session.height - 1, Math.floor(y * sy)), offset = (y * targetWidth + x) * 4;
      data[offset] = displayLevel(Number(planes[0].values[sourceY * planes[0].width + sourceX]), ranges[0]); data[offset + 1] = displayLevel(Number(planes[1].values[sourceY * planes[1].width + sourceX]), ranges[1]); data[offset + 2] = displayLevel(Number(planes[2].values[sourceY * planes[2].width + sourceX]), ranges[2]); data[offset + 3] = 255;
    }
    return output;
  }

  function renderCurrentImage() {
    const session = current();
    if (!session || !state.display.width) return;
    const {width, height} = state.display;
    if (els.image.width !== width || els.image.height !== height) {
      els.image.width = els.overlay.width = width; els.image.height = els.overlay.height = height;
    }
    try {
      let imageData;
      if (session.dataset.ambiguous) {
        imageData = session.dataset.previewPlane ? planeToPreview(session.dataset.previewPlane, session.channels[0], session, width, height) : null;
      } else if (session.dataset.colorImage && session.displayChannelId === session.channels[0]?.id) imageData = colorImageToPreview(session, width, height);
      else if (session.displayChannelId === 'composite') imageData = compositeToPreview(session, width, height);
      else imageData = planeToPreview(getPlane(session, session.displayChannelId), channelById(session, session.displayChannelId) || externalChannel(session, session.displayChannelId), session, width, height);
      if (imageData) ictx.putImageData(imageData, 0, 0);
      else ictx.clearRect(0, 0, width, height);
    } catch (error) {
      ictx.clearRect(0, 0, width, height);
      toast(error?.message || 'The selected image plane could not be displayed.', 'error');
    }
    applyTransform(); renderOverlay();
  }

  function applyTransform() {
    const transform = `translate(${state.view.x}px,${state.view.y}px) scale(${state.view.zoom})`;
    els.image.style.transform = els.overlay.style.transform = transform;
    $('#zoomLabel').textContent = `${Math.round(state.view.zoom * 100)}%`;
  }

  function fitImage() {
    const session = current(); if (!session) return;
    const size = state.display.width ? state.display : displaySize(session), rect = els.workspace.getBoundingClientRect();
    state.view.zoom = Math.max(.08, Math.min((rect.width - 28) / size.width, (rect.height - 28) / size.height, 1.8));
    state.view.x = (rect.width - size.width * state.view.zoom) / 2;
    state.view.y = (rect.height - size.height * state.view.zoom) / 2;
    applyTransform(); renderOverlay();
  }

  function canvasPoint(event) {
    const session = current(), rect = els.workspace.getBoundingClientRect();
    if (!session || !state.display.width) return {x: 0, y: 0};
    const sx = state.display.width / session.width, sy = state.display.height / session.height;
    return {x: ((event.clientX - rect.left - state.view.x) / state.view.zoom) / sx, y: ((event.clientY - rect.top - state.view.y) / state.view.zoom) / sy};
  }

  function renderOverlay() {
    const session = current();
    if (!session || !state.display.width) return;
    const sx = state.display.width / session.width, sy = state.display.height / session.height;
    octx.clearRect(0, 0, state.display.width, state.display.height);
    if (!state.view.overlay) return;
    const lineWidth = Math.max(1.25 / state.view.zoom, 1);
    for (const droplet of session.detections) {
      const x = droplet.x * sx, y = droplet.y * sy, radius = droplet.radiusPx * Math.min(sx, sy);
      octx.beginPath(); octx.arc(x, y, radius, 0, Math.PI * 2); octx.lineWidth = lineWidth;
      octx.strokeStyle = droplet.excluded ? 'rgba(255,120,130,.65)' : droplet.id === session.selectedDropletId ? '#ffd37a' : 'rgba(103,208,184,.92)'; octx.stroke();
      if (state.view.zoom > .45) { octx.fillStyle = octx.strokeStyle; octx.font = `${Math.max(10 / state.view.zoom, 7)}px ui-monospace`; octx.fillText(String(droplet.id), x + radius + 3 / state.view.zoom, y); }
    }
    if (state.calibration?.start) {
      const {start, end} = state.calibration; octx.beginPath(); octx.moveTo(start.x * sx, start.y * sy); if (end) octx.lineTo(end.x * sx, end.y * sy); octx.lineWidth = 2 / state.view.zoom; octx.strokeStyle = '#ffd37a'; octx.stroke();
    }
    if (state.measure?.start) {
      const {start, end} = state.measure; octx.beginPath(); octx.moveTo(start.x * sx, start.y * sy); if (end) octx.lineTo(end.x * sx, end.y * sy); octx.lineWidth = 2 / state.view.zoom; octx.strokeStyle = '#d8b4ff'; octx.stroke();
      if (end) { const distance = Math.hypot(end.x - start.x, end.y - start.y), calibration = session.calibration?.xUmPerPx; octx.fillStyle = '#d8b4ff'; octx.font = `${12 / state.view.zoom}px ui-monospace`; octx.fillText(`${fmt(calibration ? distance * calibration : distance, 2)} ${calibration ? 'µm' : 'px'}`, (start.x + end.x) * sx / 2, (start.y + end.y) * sy / 2 - 6 / state.view.zoom); }
    }
  }

  function updateScaleUi() {
    const session = current(), calibration = session?.calibration;
    $('#scaleLabel').textContent = calibration?.xUmPerPx ? `1 px = ${Number(calibration.xUmPerPx).toFixed(4)} µm` : 'not set';
    $('#step2').classList.toggle('done', Boolean(calibration?.xUmPerPx));
    $('#minUnit').textContent = $('#maxUnit').textContent = 'px';
  }

  function promptPixelSize() {
    const session = current(); if (!session) return;
    const value = prompt('Pixel size in µm/pixel:', session.calibration?.xUmPerPx || session.dataset.pixelSizeUm?.x || '');
    if (value === null) return;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return toast('Enter a positive pixel size', 'error');
    session.calibration = {xUmPerPx: number, yUmPerPx: number, source: 'user'}; updateScaleUi(); updateResults(); renderOverlay(); toast('Scale updated');
  }

  function startCalibration() { if (!current()) return; state.calibration = {start: null, end: null}; setTool('calibrate'); toast('Drag over a known distance'); }

  function finishCalibration() {
    const session = current(), calibration = state.calibration;
    if (!session || !calibration?.start || !calibration?.end) return;
    const pixels = Math.hypot(calibration.end.x - calibration.start.x, calibration.end.y - calibration.start.y);
    if (pixels < 2) { state.calibration = null; setTool('pan'); return; }
    const value = prompt(`Line length: ${fmt(pixels, 1)} px. Enter known distance in µm:`);
    if (value !== null) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) { session.calibration = {xUmPerPx: number / pixels, yUmPerPx: number / pixels, source: 'user'}; updateScaleUi(); updateResults(); toast('Calibration saved'); }
      else toast('Enter a positive distance', 'error');
    }
    state.calibration = null; setTool('pan');
  }

  function setTool(tool) {
    if (tool !== 'calibrate') state.calibration = null;
    if (tool !== 'measure') state.measure = null;
    state.tool = tool;
    $$('.toolbtn[data-tool]').forEach(button => button.classList.toggle('active', button.dataset.tool === tool));
    els.overlay.style.cursor = tool === 'pan' ? 'grab' : tool === 'exclude' ? 'pointer' : 'crosshair';
    renderOverlay();
  }

  function rawPlaneToGray(plane, session, channelId, width, height) {
    const range = rawRange(plane, session, channelId), gray = new Uint8Array(width * height);
    const sx = plane.width / width, sy = plane.height / height;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const value = plane.values[Math.min(plane.height - 1, Math.floor(y * sy)) * plane.width + Math.min(plane.width - 1, Math.floor(x * sx))];
      const level = displayLevel(Number(value), range); gray[y * width + x] = plane.photometric === 0 ? 255 - level : level;
    }
    return gray;
  }

  function blur(gray, width, height, passes) {
    if (!passes) return gray;
    let source = gray, target = new Uint8Array(gray.length);
    for (let pass = 0; pass < passes; pass++) {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let sum = 0, count = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) { sum += source[yy * width + xx]; count++; }
        target[y * width + x] = sum / count;
      }
      [source, target] = [target, source];
    }
    return source;
  }

  function otsu(gray) {
    const histogram = new Uint32Array(256); for (const value of gray) histogram[value]++;
    const total = gray.length; let sum = 0;
    for (let index = 0; index < 256; index++) sum += index * histogram[index];
    let sumBackground = 0, weightBackground = 0, best = 0, bestVariance = -1;
    for (let index = 0; index < 256; index++) {
      weightBackground += histogram[index]; if (!weightBackground) continue;
      const weightForeground = total - weightBackground; if (!weightForeground) break;
      sumBackground += index * histogram[index];
      const meanBackground = sumBackground / weightBackground, meanForeground = (sum - sumBackground) / weightForeground;
      const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
      if (variance > bestVariance) { bestVariance = variance; best = index; }
    }
    return best;
  }

  function components(mask, width, height, minArea, maxArea) {
    const seen = new Uint8Array(mask.length), stack = new Int32Array(mask.length), candidates = [];
    for (let seed = 0; seed < mask.length; seed++) {
      if (!mask[seed] || seen[seed]) continue;
      let stackPointer = 0; stack[stackPointer++] = seed; seen[seed] = 1;
      let area = 0, sumX = 0, sumY = 0, minX = width, maxX = 0, minY = height, maxY = 0, perimeter = 0, border = false;
      while (stackPointer) {
        const index = stack[--stackPointer], y = Math.floor(index / width), x = index - y * width;
        area++; sumX += x; sumY += y; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border = true;
        const neighbors = [index - 1, index + 1, index - width, index + width], valid = [x > 0, x < width - 1, y > 0, y < height - 1];
        for (let k = 0; k < 4; k++) {
          if (!valid[k] || !mask[neighbors[k]]) perimeter++;
          else if (!seen[neighbors[k]]) { seen[neighbors[k]] = 1; stack[stackPointer++] = neighbors[k]; }
        }
      }
      if (area >= minArea && area <= maxArea && !border) {
        const circularity = perimeter ? Math.min(1, 4 * Math.PI * area / (perimeter * perimeter) * 1.12) : 0;
        candidates.push({area, circularity, x: sumX / area, y: sumY / area, bbox: [minX, minY, maxX, maxY], diameter: 2 * Math.sqrt(area / Math.PI)});
      }
    }
    return candidates;
  }

  function filterCandidates(candidates, minDiameter, maxDiameter, minCircularity) {
    return candidates.filter(candidate => candidate.circularity >= minCircularity && candidate.diameter >= minDiameter && candidate.diameter <= maxDiameter);
  }

  function analyzePolarity(gray, width, height, threshold, polarity, minDiameter, maxDiameter, minCircularity) {
    const mask = new Uint8Array(gray.length), dark = polarity === 'dark';
    for (let index = 0; index < gray.length; index++) mask[index] = dark ? gray[index] < threshold : gray[index] > threshold;
    const minArea = Math.max(1, Math.PI * (minDiameter / 2) ** 2 * .15), maxArea = Math.PI * (maxDiameter / 2) ** 2 * 2.5;
    return filterCandidates(components(mask, width, height, minArea, maxArea), minDiameter, maxDiameter, minCircularity);
  }

  function analyzeAdaptive(gray, width, height, polarity, minDiameter, maxDiameter, minCircularity) {
    const radius = Math.max(3, Math.min(24, Math.round(Math.max(4, minDiameter * .45)))), stride = width + 1, integral = new Float64Array((height + 1) * stride), contrast = new Uint8Array(gray.length);
    for (let y = 0; y < height; y++) { let row = 0; for (let x = 0; x < width; x++) { row += gray[y * width + x]; integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row; } }
    const localMean = (x, y) => { const x0 = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius), y0 = Math.max(0, y - radius), y1 = Math.min(height - 1, y + radius), area = (x1 - x0 + 1) * (y1 - y0 + 1); return (integral[(y1 + 1) * stride + x1 + 1] - integral[y0 * stride + x1 + 1] - integral[(y1 + 1) * stride + x0] + integral[y0 * stride + x0]) / area; };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) contrast[y * width + x] = Math.abs(gray[y * width + x] - localMean(x, y));
    const delta = Math.max(4, Math.min(24, Math.round(otsu(contrast) * .55))), mask = new Uint8Array(gray.length), dark = polarity === 'dark';
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const index = y * width + x, mean = localMean(x, y); mask[index] = dark ? gray[index] < mean - delta : gray[index] > mean + delta; }
    const minArea = Math.max(1, Math.PI * (minDiameter / 2) ** 2 * .15), maxArea = Math.PI * (maxDiameter / 2) ** 2 * 2.5;
    return filterCandidates(components(mask, width, height, minArea, maxArea), minDiameter, maxDiameter, minCircularity);
  }

  function candidateScore(candidates, minDiameter) {
    const minArea = Math.PI * (minDiameter / 2) ** 2;
    return candidates.reduce((score, candidate) => score + Math.max(0, candidate.circularity - .4) * Math.min(2, Math.max(.25, candidate.area / minArea)), 0);
  }

  function detectCandidates(session, plane, channelId) {
    const maxSide = 1400, scaleX = Math.min(1, maxSide / plane.width), scaleY = Math.min(1, maxSide / plane.height), width = Math.max(1, Math.round(plane.width * scaleX)), height = Math.max(1, Math.round(plane.height * scaleY));
    const gray = blur(rawPlaneToGray(plane, session, channelId, width, height), width, height, session.settings.smoothing);
    const threshold = session.settings.autoThreshold ? otsu(gray) : session.settings.threshold;
    const minDiameter = session.settings.minDiameterPx * Math.sqrt(scaleX * scaleY), maxDiameter = session.settings.maxDiameterPx * Math.sqrt(scaleX * scaleY), minCircularity = session.settings.minCircularity;
    let polarity = session.settings.polarity, candidates;
    if (polarity === 'auto') {
      const choices = ['dark', 'bright'].flatMap(value => [{items: analyzePolarity(gray, width, height, threshold, value, minDiameter, maxDiameter, minCircularity), polarity: value}, {items: analyzeAdaptive(gray, width, height, value, minDiameter, maxDiameter, minCircularity), polarity: value}]);
      const best = choices.reduce((a, b) => candidateScore(b.items, minDiameter) > candidateScore(a.items, minDiameter) ? b : a, choices[0]);
      candidates = best.items; polarity = best.polarity;
    } else {
      candidates = analyzePolarity(gray, width, height, threshold, polarity, minDiameter, maxDiameter, minCircularity);
      if (!candidates.length) candidates = analyzeAdaptive(gray, width, height, polarity, minDiameter, maxDiameter, minCircularity);
    }
    return {candidates, threshold, polarity, source: {width: plane.width, height: plane.height, scaledWidth: width, scaledHeight: height, scaleX, scaleY, channelId}};
  }

  function stableMergeDetections(previous, candidates, source, archive = []) {
    const pool = [...previous, ...archive], used = new Set(), matchedArchiveIds = new Set(), next = [], unmatched = [], nextId = () => Math.max(0, ...pool.map(item => Number(item.id) || 0), ...next.map(item => Number(item.id) || 0)) + 1;
    for (const candidate of candidates) {
      const x = candidate.x / source.scaleX, y = candidate.y / source.scaleY, radiusPx = candidate.diameter / (2 * Math.sqrt(source.scaleX * source.scaleY));
      let best = null, distance = Infinity;
      for (const old of pool) {
        if (used.has(old.id)) continue;
        const allowed = Math.max(5, radiusPx * .8), ratio = radiusPx / Math.max(1, old.radiusPx || old.radius || 1), currentDistance = Math.hypot(x - old.x, y - old.y);
        if (currentDistance <= allowed && ratio > .5 && ratio < 2 && currentDistance < distance) { best = old; distance = currentDistance; }
      }
      if (best) { used.add(best.id); if (archive.includes(best)) matchedArchiveIds.add(best.id); }
      next.push({id: best?.id ?? nextId(), x, y, radiusPx, diameterPx: candidate.diameter / Math.sqrt(source.scaleX * source.scaleY), circularity: Math.min(1, candidate.circularity), excluded: Boolean(best?.excluded), flags: [], roi: {kind: 'inner-circle', radiusFraction: ROI_RADIUS_FRACTION, sourceCoordinateSpace: 'original-pixels'}, measurements: {}});
    }
    for (const old of previous) if (!used.has(old.id)) unmatched.push(old);
    return {detections: next, unmatched, matchedArchiveIds};
  }

  function markStale(session, message = 'Results stale · run detection again') {
    if (!session) return;
    state.activeJob++; session.stale = true; session.analysisRevision++;
    showPhase(message, 'warn'); updateResults();
  }

  function requestDetect(delay = 140) {
    const session = current(); if (!session || !session.mappingResolved) return;
    if (!session.analyzed) return;
    state.activeJob++; session.stale = true; session.analysisRevision++;
    if (state.detectTimer) clearTimeout(state.detectTimer);
    state.detectTimer = setTimeout(() => { state.detectTimer = null; detect(); }, delay);
    showPhase('Results stale · waiting for settings', 'warn'); updateResults();
  }

  async function detect() {
    const session = current();
    if (!session || !session.mappingResolved) return toast(session?.dataset?.mappingValid === false ? 'OME metadata does not map every source plane; measurement is blocked.' : 'Confirm the TIFF page mapping before detection.', 'error');
    if (session.dataset.alignment && !session.dataset.alignment.valid) return toast(session.dataset.alignment.reason || 'The selected planes are not spatially aligned.', 'error');
    if (state.busy) { state.pendingDetect = true; return; }
    syncSettingsFromUi(session);
    const job = ++state.activeJob, revision = session.analysisRevision + 1;
    session.analysisRevision = revision; state.busy = true; session.stale = true; renderQueue();
    $('#detectBtn').disabled = true; $('#detectBtn').textContent = 'Detecting…'; els.workspace.classList.add('is-analyzing'); els.workspace.setAttribute('aria-busy', 'true'); showPhase('Detecting droplets…', 'busy');
    await tick();
    try {
      const plane = getPlane(session, session.detectionChannelId), result = detectCandidates(session, plane, session.detectionChannelId);
      if (job !== state.activeJob || session !== current()) return;
      const archiveKey = `${session.detectionChannelId}:${session.selectedFrame.z}:${session.selectedFrame.t}`, allArchived = session.reviewArchive || [], archive = allArchived.filter(item => !item.archiveKey || item.archiveKey === archiveKey), merged = stableMergeDetections(session.detections, result.candidates, result.source, archive);
      session.detections = merged.detections; session.reviewArchive = merged.unmatched.map(item => ({...item, archiveKey})).concat(allArchived.filter(item => !merged.matchedArchiveIds.has(item.id))).slice(0, 1000); session.detectionSource = result.source; session.detectedPolarity = result.polarity; session.detectedThreshold = result.threshold;
      session.lastCompletedRevision = revision; session.stale = false; session.analyzed = true;
      showPhase('Measuring raw channel planes…', 'busy'); const measured = await quantifySession(session, job);
      if (!measured || job !== state.activeJob || session !== current()) return;
      updateResults(); renderOverlay(); replayClass(els.workspace, 'detection-flash');
      showPhase(`${session.detections.length} candidates · ${session.measuredChannelIds.length} channel${session.measuredChannelIds.length === 1 ? '' : 's'} quantified`, 'ready');
      toast(`${session.detections.length} droplets detected · ${result.polarity} segmentation`);
    } catch (error) {
      console.error(error); session.stale = true; showPhase(error?.message || 'Detection failed', 'error'); toast(error?.message || 'Detection failed. Check the selected channel and image.', 'error');
    } finally {
      state.busy = false; $('#detectBtn').disabled = Boolean(session.dataset.ambiguous || session.dataset.mappingValid === false || (session.dataset.alignment && !session.dataset.alignment.valid)); $('#detectBtn').textContent = 'Detect droplets'; els.workspace.classList.remove('is-analyzing'); els.workspace.removeAttribute('aria-busy'); renderQueue(); updateResults();
      if (state.pendingDetect || session.analysisRevision !== session.lastCompletedRevision) { state.pendingDetect = false; requestDetect(0); }
    }
  }

  function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * fraction, lower = Math.floor(position), upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  }

  function measurePlane(plane, droplet) {
    const radius = Math.max(0, droplet.radiusPx * ROI_RADIUS_FRACTION), radiusSquared = radius * radius;
    const x0 = Math.max(0, Math.floor(droplet.x - radius)), x1 = Math.min(plane.width - 1, Math.ceil(droplet.x + radius)), y0 = Math.max(0, Math.floor(droplet.y - radius)), y1 = Math.min(plane.height - 1, Math.ceil(droplet.y + radius));
    const values = [], invalidMask = plane.invalidMask; let invalidPixels = 0, saturatedPixels = 0, roiPixelCount = 0, clipped = x0 === 0 || y0 === 0 || x1 === plane.width - 1 || y1 === plane.height - 1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if ((x - droplet.x) ** 2 + (y - droplet.y) ** 2 > radiusSquared) continue;
      roiPixelCount++;
      const index = y * plane.width + x, value = Number(plane.values[index]);
      if (invalidMask?.[index] || !Number.isFinite(value)) invalidPixels++; else { values.push(value); if (Number.isFinite(plane.saturationLevel) && value >= plane.saturationLevel) saturatedPixels++; }
    }
    const n = values.length, sum = values.reduce((total, value) => total + value, 0), mean = n ? sum / n : null, sorted = [...values].sort((a, b) => a - b), median = n ? (n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null;
    const min = n ? sorted[0] : null, max = n ? sorted[n - 1] : null, standardDeviation = n > 1 ? Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1)) : null;
    const flags = [];
    if (clipped) flags.push('border_roi_clipped');
    if (radius < 2) flags.push('small_roi');
    if (invalidPixels) flags.push('invalid_pixels');
    if (!n) flags.push('empty_roi');
    const saturationLevel = plane.saturationLevel;
    if (!Number.isFinite(saturationLevel)) flags.push('saturation_not_assessed');
    if (saturatedPixels) flags.push('saturated_pixels');
    return {channelId: plane.channelId, nPixels: n, roiPixelCount, invalidPixels, rawSum: n ? sum : null, rawMean: mean, rawMedian: median, rawMin: min, rawMax: max, rawStdDev: standardDeviation, rawStddev: standardDeviation, saturationLevel: Number.isFinite(saturationLevel) ? saturationLevel : null, saturatedPixels, saturatedFraction: n ? saturatedPixels / n : null, flags, roi: {kind: 'inner-circle', radiusFraction: ROI_RADIUS_FRACTION, centerX: droplet.x, centerY: droplet.y, radiusPx: radius, sourceCoordinateSpace: 'original-pixels'}};
  }

  async function quantifySession(session, expectedJob = state.activeJob) {
    const channels = allChannels(session).filter(channel => session.measuredChannelIds.includes(channel.id)), rows = {};
    for (let index = 0; index < session.detections.length; index++) {
      if (expectedJob !== state.activeJob || session !== current()) return false;
      const droplet = session.detections[index], measurements = {};
      for (const channel of channels) {
        const plane = getPlane(session, channel.id);
        measurements[channel.id] = measurePlane(plane, droplet);
        if (externalChannel(session, channel.id)) measurements[channel.id].flags.push('channel_alignment_unverified');
      }
      droplet.measurements = measurements;
      rows[droplet.id] = {dropletId: droplet.id, frame: {...session.selectedFrame}, perChannel: measurements};
      if ((index & 7) === 0) { showPhase(`Measuring raw channel planes… ${index + 1}/${session.detections.length}`, 'busy'); await tick(); }
    }
    session.measurementRows = rows;
    return true;
  }

  async function remeasureCurrent() {
    const session = current();
    if (!session?.analyzed || state.busy) return;
    const job = ++state.activeJob; session.analysisRevision++; session.stale = true; state.busy = true; renderQueue(); updateResults(); showPhase('Measuring raw channel planes…', 'busy');
    try { const measured = await quantifySession(session, job); if (measured && job === state.activeJob && session === current()) { session.lastCompletedRevision = session.analysisRevision; session.stale = false; updateResults(); showPhase(`${session.detections.length} candidates · ${session.measuredChannelIds.length} channels quantified`, 'ready'); } }
    catch (error) { toast(error?.message || 'Measurement failed', 'error'); showPhase('Measurement failed', 'error'); }
    finally { state.busy = false; renderQueue(); updateResults(); }
  }

  function includedDetections(session) { return (session?.detections || []).filter(droplet => !droplet.excluded); }

  function analysisReady(session) { return Boolean(session?.analyzed && !session.stale && session.mappingResolved && session.dataset.mappingValid !== false && (!session.dataset.alignment || session.dataset.alignment.valid)); }

  function calibrationDiameter(session, pixels) { const calibration = session?.calibration; return calibration?.xUmPerPx ? pixels * Math.sqrt(calibration.xUmPerPx * (calibration.yUmPerPx || calibration.xUmPerPx)) : null; }

  function renderStats(session) {
    const included = includedDetections(session), diameters = included.map(droplet => calibrationDiameter(session, droplet.diameterPx) ?? droplet.diameterPx), mean = diameters.length ? diameters.reduce((a, b) => a + b, 0) / diameters.length : null, med = percentile(diameters, .5), standardDeviation = diameters.length > 1 ? Math.sqrt(diameters.reduce((total, value) => total + (value - mean) ** 2, 0) / (diameters.length - 1)) : null, unit = session?.calibration?.xUmPerPx ? 'µm' : 'px';
    $('#countStat').textContent = String(included.length); $('#meanStat').textContent = mean === null ? '—' : `${fmt(mean, 1)} ${unit}`; $('#medianStat').textContent = med === null ? '—' : `${fmt(med, 1)} ${unit}`; $('#cvStat').textContent = mean !== null && Math.abs(mean) > 0 && standardDeviation !== null ? `${fmt(standardDeviation / Math.abs(mean) * 100, 1)}%` : '—';
  }

  function measurementValue(droplet, channelId, field = 'rawMean') { return droplet.measurements?.[channelId]?.[field] ?? null; }

  function rawUnitLabel(session, channel = null) {
    if (channel?.role === 'color-component') {
      if (session?.dataset?.colorImage && channel.id === session.channels[0]?.id) return 'color luminance';
      const pixelType = session?.dataset?.pixelType || 'raw';
      return `${pixelType === 'uint8' ? '8-bit' : pixelType} color component`;
    }
    if (!channel && session?.dataset?.colorImage) return 'per-channel color/source units';
    return /^float/i.test(session?.dataset?.pixelType || '') ? 'raw' : 'DN';
  }

  function updateSummaryChannel(session) {
    const select = $('#summaryChannel'); if (!select || !session) return;
    const channels = allChannels(session).filter(channel => session.measuredChannelIds.includes(channel.id));
    if (!channels.some(channel => channel.id === session.intensityChannelId)) session.intensityChannelId = channels[0]?.id || session.detectionChannelId;
    select.innerHTML = channels.map(channel => `<option value="${htmlEscape(channel.id)}">${htmlEscape(channel.displayName)}</option>`).join(''); select.value = session.intensityChannelId || channels[0]?.id || '';
    $('#histLabel').textContent = channels.length ? `${channelById(session, select.value)?.displayName || 'Intensity'} distribution` : 'Intensity distribution';
  }

  function drawHistogram(values) {
    const canvas = $('#histCanvas'); if (!canvas) return;
    const rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
    canvas.width = width * dpr; canvas.height = height * dpr; const context = canvas.getContext('2d'); context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
    if (!values.length) { $('#rangeLabel').textContent = ''; return; }
    let min = Math.min(...values), max = Math.max(...values); if (min === max) { min -= .5; max += .5; }
    const bins = Math.min(18, Math.max(6, Math.round(Math.sqrt(values.length)))), counts = new Array(bins).fill(0);
    for (const value of values) counts[Math.min(bins - 1, Math.floor((value - min) / (max - min) * bins))]++;
    const peak = Math.max(...counts), gap = 2, barWidth = (width - 4) / bins, styles = getComputedStyle(document.documentElement); context.strokeStyle = styles.getPropertyValue('--line').trim(); context.beginPath(); context.moveTo(2, height - 1); context.lineTo(width - 2, height - 1); context.stroke(); context.fillStyle = styles.getPropertyValue('--accent').trim(); counts.forEach((count, index) => { const barHeight = (height - 12) * count / peak; context.fillRect(2 + index * barWidth, height - barHeight - 2, Math.max(1, barWidth - gap), barHeight); });
    const session = current(), unit = rawUnitLabel(session, channelById(session, $('#summaryChannel')?.value || session?.intensityChannelId)); $('#rangeLabel').textContent = `${fmt(min, 1)}–${fmt(max, 1)} ${unit}`;
  }

  function renderDetail(session, droplet) {
    const card = $('#dropletDetail'), grid = $('#detailGrid'); if (!card || !grid) return;
    if (!droplet) { card.hidden = true; grid.replaceChildren(); return; }
    card.hidden = false; const channelParts = allChannels(session).filter(channel => droplet.measurements?.[channel.id]).map(channel => { const measurement = droplet.measurements[channel.id], unit = rawUnitLabel(session, channel); return `<div><span>${htmlEscape(channel.displayName)}</span><strong>${measurement.rawMean === null ? '—' : `${measurement.rawMean.toLocaleString(undefined, {maximumFractionDigits: 3})} ${unit}`}</strong><small>median ${measurement.rawMedian === null ? '—' : measurement.rawMedian.toLocaleString(undefined, {maximumFractionDigits: 3})} · n=${measurement.nPixels}</small></div>`; }).join('');
    grid.innerHTML = `<div><span>Droplet</span><strong>#${droplet.id}</strong><small>${droplet.excluded ? 'Excluded from summaries' : 'Included'}</small></div><div><span>Diameter</span><strong>${fmt(droplet.diameterPx, 2)} px</strong><small>circularity ${fmt(droplet.circularity, 3)}</small></div>${channelParts || '<div><span>Measurements</span><strong>Not available</strong></div>'}`;
  }

  function selectDroplet(id) {
    const session = current(); if (!session) return;
    session.selectedDropletId = id; state.selectedDropletId = id; renderDetail(session, session.detections.find(droplet => droplet.id === id)); renderOverlay();
    $$('#resultBody tr[data-id]').forEach(row => row.classList.toggle('result-row-selected', Number(row.dataset.id) === id));
  }

  function updateResults() {
    const session = current();
    if (!session) {
      ['countStat', 'meanStat', 'medianStat', 'cvStat'].forEach(id => { $('#' + id).textContent = '—'; }); $('#resultPill').textContent = 'No analysis'; $('#resultBody').innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;padding:22px">No droplets detected</td></tr>'; $('#resultStatus').textContent = 'No dataset loaded'; ['csvBtn', 'jsonBtn', 'pngBtn', 'copyBtn', 'includeAllBtn'].forEach(id => $('#' + id).disabled = true); drawHistogram([]); return;
    }
    renderStats(session); updateSummaryChannel(session);
    const channels = allChannels(session).filter(channel => session.measuredChannelIds.includes(channel.id)), body = $('#resultBody'), colSpan = 3 + channels.length;
    $('#resultPill').textContent = session.stale ? 'Results stale' : `${session.detections.length} candidate${session.detections.length === 1 ? '' : 's'}`;
    $('#resultStatus').textContent = session.stale ? 'Settings changed · run detection to update measurements' : session.analyzed ? `${session.detections.length} droplets · ${channels.length} raw channel${channels.length === 1 ? '' : 's'} · values in original source units` : 'Ready to detect'; $('#resultStatus').className = `result-status ${session.stale ? 'warn' : session.analyzed ? 'ready' : ''}`;
    const header = $('#resultBody')?.closest('table')?.querySelector('thead tr');
    if (header) header.innerHTML = `<th>#</th><th>Diameter</th><th>Circ.</th>${channels.map(channel => `<th title="Original source samples">${htmlEscape(channel.displayName)} mean (${rawUnitLabel(session, channel)})</th>`).join('')}`;
    if (!session.detections.length) body.innerHTML = `<tr><td colspan="${colSpan}" class="muted" style="text-align:center;padding:22px">No droplets detected</td></tr>`;
    else body.innerHTML = session.detections.map(droplet => `<tr data-id="${droplet.id}" class="${droplet.excluded ? 'excluded' : ''}${droplet.id === session.selectedDropletId ? ' result-row-selected' : ''}"><td><input type="checkbox" ${droplet.excluded ? '' : 'checked'} aria-label="Include droplet ${droplet.id}"> ${droplet.id}</td><td>${fmt(calibrationDiameter(session, droplet.diameterPx) ?? droplet.diameterPx, 2)} ${session.calibration?.xUmPerPx ? 'µm' : 'px'}</td><td>${fmt(droplet.circularity, 2)}</td>${channels.map(channel => `<td>${measurementValue(droplet, channel.id) === null ? '—' : Number(measurementValue(droplet, channel.id)).toLocaleString(undefined, {maximumFractionDigits: 3})}</td>`).join('')}</tr>`).join('');
    $$('#resultBody tr[data-id]').forEach(row => { const id = Number(row.dataset.id), droplet = session.detections.find(item => item.id === id); row.onclick = event => { if (event.target.matches('input')) return; selectDroplet(id); }; row.querySelector('input')?.addEventListener('change', event => { droplet.excluded = !event.target.checked; renderOverlay(); updateResults(); selectDroplet(id); }); });
    const selectedChannel = $('#summaryChannel')?.value || session.intensityChannelId, values = includedDetections(session).map(droplet => measurementValue(droplet, selectedChannel)).filter(Number.isFinite); drawHistogram(values); renderDetail(session, session.detections.find(droplet => droplet.id === session.selectedDropletId));
    const enabled = session.detections.length > 0 && session.analyzed && !session.stale; ['csvBtn', 'jsonBtn', 'pngBtn', 'copyBtn', 'includeAllBtn'].forEach(id => $('#' + id).disabled = !enabled);
  }

  function resetDetection() {
    const session = current(); if (!session || state.busy) return;
    session.detections = []; session.measurementRows = {}; session.reviewArchive = []; session.analyzed = false; session.stale = false; session.analysisRevision++; session.selectedDropletId = null; updateResults(); renderOverlay(); showPhase('Ready to detect', '');
  }

  function restoreExclusions() {
    const session = current(); if (!session) return;
    session.detections.forEach(droplet => droplet.excluded = false); session.reviewArchive?.forEach(droplet => { if (droplet.excluded) droplet.excluded = false; }); updateResults(); renderOverlay(); toast('All candidates included');
  }

  function exportRows(session = current()) {
    if (!analysisReady(session)) return [];
    const channels = allChannels(session).filter(channel => session.measuredChannelIds.includes(channel.id)), rows = [];
    for (const droplet of session.detections) {
      const row = {image: session.name, dataset_id: session.dataset.id, z: session.selectedFrame.z, t: session.selectedFrame.t, droplet_id: droplet.id, included: !droplet.excluded, center_x_px: Number(droplet.x.toFixed(4)), center_y_px: Number(droplet.y.toFixed(4)), diameter_px: Number(droplet.diameterPx.toFixed(4)), diameter_um: calibrationDiameter(session, droplet.diameterPx), circularity: Number(droplet.circularity.toFixed(5)), roi_method: 'inner-circle', roi_radius_fraction: ROI_RADIUS_FRACTION, flags: [...(droplet.flags || [])].join('|')};
      for (const channel of channels) {
        const measurement = droplet.measurements?.[channel.id], prefix = `${safeName(channel.id)}_${safeName(channel.displayName)}`;
        row[`${prefix}_raw_sum`] = measurement?.rawSum ?? null; row[`${prefix}_raw_mean`] = measurement?.rawMean ?? null; row[`${prefix}_raw_median`] = measurement?.rawMedian ?? null; row[`${prefix}_raw_min`] = measurement?.rawMin ?? null; row[`${prefix}_raw_max`] = measurement?.rawMax ?? null; row[`${prefix}_raw_std_dev`] = measurement?.rawStdDev ?? null; row[`${prefix}_n_pixels`] = measurement?.nPixels ?? null; row[`${prefix}_roi_pixel_count`] = measurement?.roiPixelCount ?? null; row[`${prefix}_invalid_pixels`] = measurement?.invalidPixels ?? null; row[`${prefix}_saturated_pixels`] = measurement?.saturatedPixels ?? null; row[`${prefix}_saturated_fraction`] = measurement?.saturatedFraction ?? null; row[`${prefix}_saturation_level`] = measurement?.saturationLevel ?? null; row[`${prefix}_flags`] = measurement?.flags?.join('|') || '';
        if (rawUnitLabel(session, channel) === 'DN') Object.assign(row, {[`${prefix}_raw_sum_dn`]: measurement?.rawSum ?? null, [`${prefix}_raw_mean_dn`]: measurement?.rawMean ?? null, [`${prefix}_raw_median_dn`]: measurement?.rawMedian ?? null, [`${prefix}_raw_min_dn`]: measurement?.rawMin ?? null, [`${prefix}_raw_max_dn`]: measurement?.rawMax ?? null, [`${prefix}_raw_std_dev_dn`]: measurement?.rawStdDev ?? null});
      }
      rows.push(row);
    }
    return rows;
  }

  function exportCsv() {
    const session = current(); if (!analysisReady(session)) return toast('Run detection and measurement before exporting.', 'error');
    const rows = exportRows(session); if (!rows.length) return;
    const headers = [...new Set(rows.flatMap(row => Object.keys(row)))], text = [headers.map(csvValue).join(','), ...rows.map(row => headers.map(header => csvValue(row[header])).join(','))].join('\n');
    download(`${session.name.replace(/\.[^.]+$/, '')}_analysis.csv`, new Blob([text], {type: 'text/csv;charset=utf-8'}));
  }

  function exportJson() {
    const session = current(); if (!analysisReady(session) || !session.detections.length) return toast('Run detection and measurement before exporting.', 'error');
    const channels = allChannels(session).map(channel => ({id: channel.id, index: channel.index, sourceName: channel.sourceName, displayName: channel.displayName, role: channel.role, fluorophore: channel.fluorophore || '', emissionNm: channel.emissionNm ?? null, colorLut: channel.colorLut, quantify: session.measuredChannelIds.includes(channel.id), saturationLevel: finiteCeiling(channel.saturationLevel), metadata: channel.metadata}));
    const data = {schema: 'droplet-measure.analysis/v2', schema_version: '2.0.0', application: 'Droplet Measure', generatedAt: new Date().toISOString(), source: session.dataset.source, dataset: {id: session.dataset.id, width: session.width, height: session.height, pixelType: session.dataset.pixelType, significantBits: session.dataset.significantBits, axes: session.dataset.axes, pixelSizeUm: session.dataset.pixelSizeUm, colorImage: Boolean(session.dataset.colorImage), alignment: session.dataset.alignment, provenance: session.dataset.provenance}, channels, selected_frame: {...session.selectedFrame}, detection: {channel_id: session.detectionChannelId, settings: session.settings, detection_source: session.detectionSource, detected_polarity: session.detectedPolarity, detected_threshold: session.detectedThreshold, roi_method: 'inner_circle', roi_radius_fraction: ROI_RADIUS_FRACTION, coordinate_space: 'original-pixels'}, measurement: {raw_pixel_precision_preserved: true, raw_units: rawUnitLabel(session), channel_units: Object.fromEntries(channels.map(channel => [channel.id, rawUnitLabel(session, channel)])), background_method: 'none', invalid_pixel_policy: 'omit_and_count', saturation_policy: 'not_assessed_without_channel_ceiling'}, calibration: session.calibration ? {x_um_per_px: session.calibration.xUmPerPx, y_um_per_px: session.calibration.yUmPerPx, source: session.calibration.source} : null, provenance: {axis_mapping_source: session.dataset.provenance?.axisMappingSource, metadata_source: session.dataset.provenance?.metadataSource, warnings: session.warnings, selected_frame: session.selectedFrame}, analysis: {measured_channel_ids: session.measuredChannelIds, revision: session.lastCompletedRevision, warnings: session.warnings}, droplets: exportRows(session)};
    download(`${session.name.replace(/\.[^.]+$/, '')}_analysis.json`, new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
  }

  function previewCanvas(session) {
    const {width, height} = state.display, canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); let imageData;
    if (session.dataset.ambiguous) imageData = session.dataset.previewPlane ? planeToPreview(session.dataset.previewPlane, session.channels[0], session, width, height) : null;
    else if (session.dataset.colorImage && session.displayChannelId === session.channels[0]?.id) imageData = colorImageToPreview(session, width, height);
    else if (session.displayChannelId === 'composite') imageData = compositeToPreview(session, width, height);
    else imageData = planeToPreview(getPlane(session, session.displayChannelId), channelById(session, session.displayChannelId) || externalChannel(session, session.displayChannelId), session, width, height);
    if (imageData) context.putImageData(imageData, 0, 0);
    const sx = width / session.width, sy = height / session.height; context.font = `${Math.max(10, 14 / Math.max(.5, state.view.zoom))}px ui-monospace`;
    for (const droplet of session.detections) { const x = droplet.x * sx, y = droplet.y * sy, radius = droplet.radiusPx * Math.min(sx, sy); context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.lineWidth = 2; context.strokeStyle = droplet.excluded ? '#ff7882' : '#67d0b8'; context.stroke(); context.fillStyle = context.strokeStyle; context.fillText(String(droplet.id), x + radius + 3, y); }
    context.fillStyle = 'rgba(0,0,0,.68)'; context.fillRect(8, 8, Math.min(width - 16, 520), 24); context.fillStyle = '#ffffff'; context.font = '11px ui-monospace'; const displayName = session.displayChannelId === 'composite' ? 'Composite' : channelById(session, session.displayChannelId)?.displayName || '—', displayChannel = session.displayChannelId === 'composite' ? null : channelById(session, session.displayChannelId); context.fillText(`Display: ${displayName} · Detect: ${channelById(session, session.detectionChannelId)?.displayName || '—'} · units: ${rawUnitLabel(session, displayChannel)}`, 14, 24);
    return canvas;
  }

  function exportPng() {
    const session = current(); if (!analysisReady(session)) return toast('Run detection and measurement before exporting.', 'error');
    try { const canvas = previewCanvas(session); canvas.toBlob(blob => { if (blob) download(`${session.name.replace(/\.[^.]+$/, '')}_annotated.png`, blob); }, 'image/png'); } catch (error) { toast(error?.message || 'The annotated preview could not be exported.', 'error'); }
  }

  async function copySummary() {
    const session = current(); if (!analysisReady(session)) return toast('Run detection and measurement before copying a summary.', 'error');
    const included = includedDetections(session), diameters = included.map(droplet => calibrationDiameter(session, droplet.diameterPx) ?? droplet.diameterPx), mean = diameters.length ? diameters.reduce((a, b) => a + b, 0) / diameters.length : null, unit = session.calibration?.xUmPerPx ? 'µm' : 'px';
    const text = `${session.name}: ${included.length} included droplets; mean diameter ${mean === null ? '—' : fmt(mean, 2)} ${unit}; median ${percentile(diameters, .5) === null ? '—' : fmt(percentile(diameters, .5), 2)} ${unit}.`;
    try { await navigator.clipboard.writeText(text); toast('Summary copied'); } catch { toast('Clipboard unavailable', 'error'); }
  }

  function recipeFor(session) {
    return {schema: 'droplet-measure.recipe/v1', dataset: {sourceName: session.name, channelIds: allChannels(session).map(channel => channel.id)}, channels: allChannels(session).map(channel => ({id: channel.id, displayName: channel.displayName, role: channel.role, fluorophore: channel.fluorophore || '', saturationLevel: finiteCeiling(channel.saturationLevel)})), detectionChannelId: session.detectionChannelId, measuredChannelIds: session.measuredChannelIds, selectedFrame: session.selectedFrame, settings: session.settings, calibration: session.calibration};
  }

  function downloadRecipe() {
    const session = current(); if (!session) return;
    download(`${session.name.replace(/\.[^.]+$/, '')}_recipe.json`, new Blob([JSON.stringify(recipeFor(session), null, 2)], {type: 'application/json'}));
  }

  async function reapplyRecipe(file) {
    const session = current(); if (!session || !file) return;
    try {
      const recipe = JSON.parse(await file.text()), settings = recipe.settings || {};
      session.settings = {...session.settings, ...settings};
      for (const saved of recipe.channels || []) { const channel = channelById(session, saved.id); if (!channel) continue; if (typeof saved.displayName === 'string' && saved.displayName.trim()) channel.displayName = saved.displayName.trim(); if (typeof saved.role === 'string') channel.role = saved.role; if (typeof saved.fluorophore === 'string') channel.fluorophore = saved.fluorophore.trim(); channel.saturationLevel = finiteCeiling(saved.saturationLevel); }
      session.detectionChannelId = allChannels(session).some(channel => channel.id === recipe.detectionChannelId) ? recipe.detectionChannelId : session.detectionChannelId; session.measuredChannelIds = (recipe.measuredChannelIds || session.measuredChannelIds).filter(id => allChannels(session).some(channel => channel.id === id)); session.selectedFrame = {z: Math.max(0, Math.min(session.dataset.axes.sizeZ - 1, Math.floor(Number(recipe.selectedFrame?.z ?? session.selectedFrame.z) || 0))), t: Math.max(0, Math.min(session.dataset.axes.sizeT - 1, Math.floor(Number(recipe.selectedFrame?.t ?? session.selectedFrame.t) || 0)))}; session.calibration = recipe.calibration || session.calibration; syncUiFromSettings(session); renderChannelMap(session); updateScaleUi(); markStale(session, 'Recipe applied · results need recomputation'); renderCurrentImage(); requestDetect(0); toast('Recipe applied');
    } catch (error) { toast(`Could not apply recipe: ${error.message}`, 'error'); }
  }

  async function attachExternalChannel(file) {
    const session = current(); if (!session || !file) return;
    let dataset = null, attached = false;
    try {
      if (session.dataset.axes.sizeZ !== 1 || session.dataset.axes.sizeT !== 1) throw new Error('Attach separate channels only to a single-frame dataset; multi-frame registration is not inferred.');
      dataset = await window.openMicroscopyDataset(file);
      if (dataset.ambiguous || dataset.axes.sizeC !== 1 || dataset.axes.sizeZ !== 1 || dataset.axes.sizeT !== 1) throw new Error('Choose a single-plane, single-channel file for the advanced attachment.');
      if (dataset.width !== session.width || dataset.height !== session.height) throw new Error('The attached channel dimensions must match the dataset exactly.');
      if (!confirm('Dimensions match, but dimensions alone do not prove spatial registration. Attach this file as an unverified aligned channel?')) return;
      const source = dataset.channels[0], channel = {...channelCopy(source), id: `EXT${session.externalChannels.length}`, index: session.channels.length + session.externalChannels.length, sourceName: file.name, displayName: source.displayName || file.name, metadata: {...source.metadata, registration: 'user-confirmed-unverified'}};
      session.externalChannels.push({id: channel.id, ...channel, dataset}); attached = true; session.measuredChannelIds.push(channel.id); session.warnings.push(`External channel ${file.name} was attached with user-confirmed but unverified registration.`); renderSummary(session); renderChannelMap(session); renderCurrentImage(); markStale(session, 'External channel added · re-run detection to quantify it'); toast('Separate channel attached');
    } catch (error) { toast(error?.message || 'Could not attach the separate channel.', 'error'); }
    finally { if (dataset && !attached) dataset.dispose?.(); }
  }

  async function batchAnalyze() {
    if (state.busy || state.images.length < 2) return;
    const original = state.index;
    for (let index = 0; index < state.images.length; index++) { await loadCurrent(index); await detect(); await tick(); }
    await loadCurrent(original); toast('Batch analysis complete');
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const button = $('#themeBtn'); if (button) { button.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme'; button.setAttribute('aria-pressed', String(theme === 'dark')); }
    try { localStorage.setItem('droplet-measure-theme', theme); } catch { /* private browsing */ }
    if (current()) updateResults();
  }

  function loadTheme() {
    let theme = document.documentElement.dataset.theme || 'dark';
    try { const saved = localStorage.getItem('droplet-measure-theme'); if (saved === 'dark' || saved === 'light') theme = saved; } catch { /* private browsing */ }
    setTheme(theme);
  }

  function wireEvents() {
    $('#openBtn').onclick = () => els.fileInput.click(); $('#emptyOpen').onclick = () => els.fileInput.click();
    els.fileInput.onchange = event => { addFiles(event.target.files); event.target.value = ''; };
    $('#fluorBtn').onclick = () => els.fluorInput.click(); els.fluorInput.onchange = event => { attachExternalChannel(event.target.files[0]); event.target.value = ''; };
    ['dragenter', 'dragover'].forEach(name => els.workspace.addEventListener(name, event => { event.preventDefault(); els.dropzone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(name => els.workspace.addEventListener(name, event => { event.preventDefault(); els.dropzone.classList.remove('drag'); }));
    els.workspace.addEventListener('drop', event => addFiles(event.dataTransfer.files));
    document.addEventListener('paste', event => { const files = [...(event.clipboardData?.files || [])]; if (files.length) addFiles(files); });
    $('#themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    $('#fitBtn').onclick = fitImage; $('#calibrateBtn').onclick = startCalibration; $('#pixelSizeBtn').onclick = promptPixelSize; $('#detectBtn').onclick = detect; $('#batchBtn').onclick = batchAnalyze; $('#resetDetectionBtn').onclick = resetDetection; $('#restoreExclusionsBtn').onclick = restoreExclusions;
    $$('.toolbtn[data-tool]').forEach(button => button.onclick = () => setTool(button.dataset.tool));
    $('#polaritySwitch').querySelectorAll('button').forEach(button => button.onclick = () => { const session = current(); if (!session) return; session.settings.polarity = button.dataset.v; $('#polaritySwitch').querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button)); markStale(session, 'Polarity changed · results need recomputation'); requestDetect(); });
    const settingsChanged = () => { const session = current(); if (!session) return; syncSettingsFromUi(session); $('#thresholdVal').textContent = session.settings.autoThreshold ? 'auto' : session.settings.threshold; $('#threshold').disabled = session.settings.autoThreshold; $('#circVal').textContent = Number(session.settings.minCircularity).toFixed(2); $('#smoothVal').textContent = `${session.settings.smoothing} px`; if (session.analyzed) requestDetect(); };
    ['minDiameter', 'maxDiameter', 'circularity', 'smoothing', 'threshold'].forEach(id => $('#' + id).addEventListener('input', settingsChanged)); $('#autoThreshold').addEventListener('change', settingsChanged);
    [$('#displayChannelSelect'), $('#viewerChannelSelect')].forEach(select => select?.addEventListener('change', event => { const session = current(); if (!session) return; session.displayChannelId = event.target.value; renderDisplayOptions(session); renderCurrentImage(); renderOverlay(); }));
    $('#summaryChannel')?.addEventListener('change', event => { const session = current(); if (!session) return; session.intensityChannelId = event.target.value; updateResults(); });
    $('#overlayToggle').onclick = event => { state.view.overlay = !state.view.overlay; event.currentTarget.classList.toggle('active', state.view.overlay); event.currentTarget.setAttribute('aria-pressed', String(state.view.overlay)); renderOverlay(); };
    $('#resultsToggle').onclick = event => { const open = els.right.classList.toggle('open'); event.currentTarget.setAttribute('aria-expanded', String(open)); };
    $('#includeAllBtn').onclick = () => { const session = current(); if (!session) return; session.detections.forEach(droplet => droplet.excluded = false); updateResults(); renderOverlay(); };
    $('#csvBtn').onclick = exportCsv; $('#jsonBtn').onclick = exportJson; $('#pngBtn').onclick = exportPng; $('#copyBtn').onclick = copySummary; $('#downloadRecipeBtn').onclick = downloadRecipe; $('#applyRecipeBtn').onclick = () => $('#recipeInput').click(); $('#recipeInput').onchange = event => { reapplyRecipe(event.target.files[0]); event.target.value = ''; };
    els.workspace.addEventListener('wheel', event => { if (!current()) return; event.preventDefault(); const rect = els.workspace.getBoundingClientRect(), mouseX = event.clientX - rect.left, mouseY = event.clientY - rect.top, oldZoom = state.view.zoom, newZoom = Math.max(.08, Math.min(8, oldZoom * Math.exp(-event.deltaY * .001))); state.view.x = mouseX - (mouseX - state.view.x) * (newZoom / oldZoom); state.view.y = mouseY - (mouseY - state.view.y) * (newZoom / oldZoom); state.view.zoom = newZoom; applyTransform(); renderOverlay(); }, {passive: false});
    els.overlay.addEventListener('pointerdown', event => { if (!current()) return; els.overlay.setPointerCapture(event.pointerId); const point = canvasPoint(event); if (state.tool === 'pan') { state.drag = {kind: 'pan', sx: event.clientX, sy: event.clientY, x: state.view.x, y: state.view.y}; els.overlay.style.cursor = 'grabbing'; } else if (state.tool === 'calibrate') { state.calibration = {start: point, end: point}; state.drag = {kind: 'calibrate'}; } else if (state.tool === 'measure') { state.measure = {start: point, end: point}; state.drag = {kind: 'measure'}; } else if (state.tool === 'exclude') toggleNearest(point); });
    els.overlay.addEventListener('pointermove', event => { if (!state.drag) return; const point = canvasPoint(event); if (state.drag.kind === 'pan') { state.view.x = state.drag.x + event.clientX - state.drag.sx; state.view.y = state.drag.y + event.clientY - state.drag.sy; applyTransform(); } else if (state.drag.kind === 'calibrate') { state.calibration.end = point; renderOverlay(); } else if (state.drag.kind === 'measure') { state.measure.end = point; renderOverlay(); } });
    const endPointer = () => { if (state.drag?.kind === 'calibrate') finishCalibration(); state.drag = null; if (state.tool === 'pan') els.overlay.style.cursor = 'grab'; }; els.overlay.addEventListener('pointerup', endPointer); els.overlay.addEventListener('pointercancel', endPointer);
    window.addEventListener('resize', () => { if (current()) fitImage(); if (current()) updateResults(); });
    document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); els.fileInput.click(); } if (event.key === 'Escape' && state.tool !== 'pan') { state.calibration = null; state.measure = null; setTool('pan'); } });
  }

  function toggleNearest(point) {
    const session = current(); if (!session) return;
    let best = null, distance = Infinity;
    for (const droplet of session.detections) { const candidateDistance = Math.hypot(point.x - droplet.x, point.y - droplet.y); if (candidateDistance < Math.max(droplet.radiusPx, 12 / (state.view.zoom * (state.display.width / session.width))) && candidateDistance < distance) { best = droplet; distance = candidateDistance; } }
    if (best) { best.excluded = !best.excluded; selectDroplet(best.id); updateResults(); }
  }

  function boot() {
    installUi(); wireEvents(); loadTheme(); renderQueue(); renderSummary(null); renderChannelMap(null); updateScaleUi(); updateResults(); els.empty.hidden = false; els.toolbar.hidden = true;
    window.DropletMeasure = {state, addFiles, loadCurrent, detect, quantifySession, measurePlane, exportRows, getPlane, renderCurrentImage, updateResults};
  }

  boot();
})();
