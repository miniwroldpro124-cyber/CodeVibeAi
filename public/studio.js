/* Picture, edit, video and speech generation. Everything here follows the same two
   rules the chat page does: the key never reaches the browser (the server signs the
   upstream call), and pricing is the server's arithmetic, not a guess in here.
   The chip below is a hint of what the route will report; the number the usage log
   keeps is the one the server answered with. */
(() => {
  'use strict';

  const { $, vnd, initTheme, initNav } = window.Page;

  const POLL_MS = 4000;
  // A clip takes minutes and a picture takes seconds, so the two share one
  // waiting loop with a ceiling that suits the slow one.
  const POLL_MAX_MS = 12 * 60 * 1000;
  // A picture is resized in the browser before it is sent: a vision model reads a
  // 1100-pixel JPEG exactly as well as a 4000-pixel scan, and the route's body
  // ceiling is a chat-sized one, not a camera roll.
  const EDIT_MAX_EDGE = 1100;
  const EDIT_MAX_CHARS = 3.2 * 1024 * 1024;
  // The picture you point a generator at is usually one you took a minute ago, and
  // picking it again after every reload is the tedious part of the workflow. So it
  // is kept — in this browser only, in IndexedDB, under the account that picked it,
  // and for three days. Nothing about it reaches the server or another site.
  const PICTURE_DB = 'devchat.studio';
  const PICTURE_STORE = 'pictures';
  const PICTURE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
  const PICTURE_CACHE_MAX_CHARS = EDIT_MAX_CHARS;

  const els = {
    paneTitle: $('#paneTitle'),
    paneSub: $('#paneSub'),
    imageFields: $('#imageFields'),
    editFields: $('#editFields'),
    videoFields: $('#videoFields'),
    voiceFields: $('#voiceFields'),
    imageModel: $('#imageModel'),
    imageSize: $('#imageSize'),
    imageCount: $('#imageCount'),
    imageUrl: $('#imageUrl'),
    imageFile: $('#imageFile'),
    editModel: $('#editModel'),
    editFile: $('#editFile'),
    editPreview: $('#editPreview'),
    videoModel: $('#videoModel'),
    videoResolution: $('#videoResolution'),
    videoDuration: $('#videoDuration'),
    videoRatio: $('#videoRatio'),
    voiceModel: $('#voiceModel'),
    voiceName: $('#voiceName'),
    promptLabel: $('#promptLabel'),
    prompt: $('#prompt'),
    polishBtn: $('#polishBtn'),
    polishNote: $('#polishNote'),
    goBtn: $('#goBtn'),
    cancelBtn: $('#cancelBtn'),
    priceChip: $('#priceChip'),
    statusChip: $('#statusChip'),
    paneNote: $('#paneNote'),
    confirmBox: $('#confirmBox'),
    confirmText: $('#confirmText'),
    confirmBtn: $('#confirmBtn'),
    confirmNoBtn: $('#confirmNoBtn'),
    errorBox: $('#errorBox'),
    resultsCard: $('#resultsCard'),
    resultsSub: $('#resultsSub'),
    gallery: $('#gallery'),
    clip: $('#clip'),
    audio: $('#audio')
  };

  const state = {
    mode: 'image',
    models: { image: [], edit: [], video: [], voice: [] },
    markupPercent: 0,
    pictureCeiling: 0,
    pictureTotal: 0,
    busy: false,
    controller: null,
    timer: null,
    picture: null,
    confirmed: false,
    clipUrl: null
  };

  // The select each pane fills, and what it says when that pane has nothing to
  // offer — which is a different sentence per pane, because an empty image list is
  // the account's fault and an empty video list is the server's configuration.
  const PANES = {
    image: { select: 'imageModel', empty: 'no image model under the price limit on this account' },
    edit: { select: 'editModel', empty: 'no model on this account can take a picture as input' },
    video: { select: 'videoModel', empty: 'no video model configured on this server' },
    voice: { select: 'voiceModel', empty: 'no speech model listed for this provider' }
  };

  const COPY = {
    image: {
      title: 'Make a picture',
      sub: 'Models are listed because the provider says they answer on the image endpoint — not because'
        + ' the name looks right. Each picture is priced per request and billed to <b>your own</b> key.'
        + ' A reference picture is optional: drop, paste or pick one and it travels with the prompt.'
        + ' Not every picture model reads one — some answer from the words alone, and the price is the same.'
        + ' The reference you add is remembered by <b>this browser</b> for three days, and by no server.',
      button: 'Generate picture',
      promptLabel: 'Prompt',
      placeholder: 'A red fox standing in fresh snow, low afternoon light, 35mm',
      note: 'One picture, one number: the price below is the provider\u2019s per-request rate for the model'
        + ' you picked, and the picture is drawn on your own key. A reference you add is resized here'
        + ' first, so the send is a few hundred KB rather than the file on your disk.',
      polish: true,
      polishNote: 'Rewrites what you typed into a prompt an image model reads well. One small chat request'
        + ' on your key — about 2 \u20ab.'
    },
    edit: {
      title: 'Edit a picture you already have',
      sub: 'Choose a file, paste one (Ctrl+V) or drag one in from the file manager, say what to change, and'
        + ' the model gets the picture and your words together. This runs on the models the provider says can'
        + ' <b>see</b> an image and draw a new one —'
        + ' the <code>images/edits</code> endpoint exists in its price list but refuses every request'
        + ' this server has sent it, so it is not used. The picture you add stays in <b>this browser</b>'
        + ' for three days, and Forget drops it.',
      button: 'Check the price',
      promptLabel: 'What to change',
      placeholder: 'Keep her face and pose exactly as they are; replace the grey wall with a bookshelf'
        + ' lit by a warm lamp, shallow depth of field',
      note: 'Your file never leaves your machine except as the body of this one request, and it is resized'
        + ' here first — a smaller picture costs the same and reads the same to the model.',
      polish: true,
      polishNote: 'Turns a vague wish into an editing instruction with what must stay untouched named.'
        + ' One small chat request on your key.'
    },
    video: {
      title: 'Make a short clip',
      sub: 'The provider does not publish these models in its price list, so DevChat cannot quote a clip'
        + ' before you ask for one. It sends the job, then polls the task until a file comes back.',
      button: 'Start the job',
      promptLabel: 'Prompt',
      placeholder: 'A drone shot over a pine forest at sunrise, mist in the valleys, slow forward motion',
      note: 'A clip is a job, not an answer: the request only returns a task id, then this page asks for it'
        + ' every few seconds until the file is ready. Keep the tab open — closing it does not cancel the'
        + ' job, it only stops you watching it.',
      polish: true,
      polishNote: 'Turns a one-line idea into a shot the model can film: subject, action, camera, light.'
        + ' One small chat request on your key.'
    },
    voice: {
      title: 'Have it read out loud',
      sub: 'Speech is the one media route that answers with the file itself, so the server relays the bytes'
        + ' rather than JSON. The clip is charged per request, on <b>your own</b> key.',
      button: 'Speak it',
      promptLabel: 'Text to speak',
      placeholder: 'DevChat signs every request with your own key, so the bill is always yours to read.',
      note: 'The voice name is the provider\u2019s own vocabulary. alloy is what its examples use; anything'
        + ' else it does not know comes back as a refusal, which costs nothing.',
      polish: false
    }
  };

  function showStatus(text) {
    els.statusChip.textContent = text;
    els.statusChip.hidden = !text;
  }

  function showError(text) {
    els.errorBox.textContent = text;
    els.errorBox.hidden = false;
  }

  function clearError() {
    els.errorBox.hidden = true;
    els.errorBox.textContent = '';
  }

  // A blob: URL outlives the element that played it, so each one is revoked before
  // the next is made — otherwise a long studio session quietly holds every clip.
  function dropClipUrl() {
    if (state.clipUrl) URL.revokeObjectURL(state.clipUrl);
    state.clipUrl = null;
  }

  function clearResults() {
    els.gallery.textContent = '';
    els.clip.textContent = '';
    els.audio.textContent = '';
    dropClipUrl();
    els.resultsCard.hidden = true;
    els.resultsSub.textContent = '';
  }

  function hideConfirm() {
    state.confirmed = false;
    els.confirmBox.hidden = true;
  }

  /* ------------------------------------------------------------- picture cache */

  /* IndexedDB rather than localStorage: the value is a few hundred kilobytes of
     base64 and localStorage is a synchronous, ~5 MB, JSON-only store shared with
     every chat on this origin. Here a full cache refuses one write and the picture
     simply is not remembered, instead of the page losing its transcripts. */
  let dbPromise = null;

  function openDb() {
    if (!window.indexedDB) return Promise.reject(new Error('This browser has no local object store.'));
    if (!dbPromise) {
      dbPromise = new Promise((done, fail) => {
        const req = indexedDB.open(PICTURE_DB, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(PICTURE_STORE)) req.result.createObjectStore(PICTURE_STORE);
        };
        req.onsuccess = () => done(req.result);
        req.onerror = () => fail(req.error || new Error('The picture cache could not be opened.'));
        req.onblocked = () => fail(new Error('The picture cache is held by another tab.'));
      });
      // A rejected open would otherwise poison every later attempt with the same error.
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }

  // Keyed by account, so two people sharing a browser do not inherit each other's
  // reference picture.
  function pictureKey() {
    const id = window.Auth.user?.id;
    return id ? `reference:u${id}` : null;
  }

  function run(db, mode, work) {
    return new Promise((done, fail) => {
      const tx = db.transaction(PICTURE_STORE, mode);
      const req = work(tx.objectStore(PICTURE_STORE));
      tx.oncomplete = () => done(req.result);
      tx.onerror = () => fail(tx.error || new Error('The picture cache call failed.'));
      tx.onabort = () => fail(tx.error || new Error('The picture cache write was refused.'));
    });
  }

  async function cacheWrite(record) {
    const key = pictureKey();
    if (!key || record.dataUrl.length > PICTURE_CACHE_MAX_CHARS) return false;
    try {
      await run(await openDb(), 'readwrite', (store) => store.put(record, key));
      return true;
    } catch {
      return false;
    }
  }

  async function cacheRead() {
    const key = pictureKey();
    if (!key) return null;
    try {
      const db = await openDb();
      const found = await run(db, 'readonly', (store) => store.get(key));
      if (!found?.dataUrl || !found?.label) return null;
      if (Date.now() - Number(found.savedAt || 0) > PICTURE_TTL_MS) {
        await run(db, 'readwrite', (store) => store.delete(key));
        return null;
      }
      return found;
    } catch {
      return null;
    }
  }

  async function cacheClear() {
    const key = pictureKey();
    if (!key) return;
    try {
      await run(await openDb(), 'readwrite', (store) => store.delete(key));
    } catch { /* there is nothing to forget */ }
  }

  // Only textContent and createElement: a model's own words about a picture are
  // provider data, and provider data never becomes markup on this page.
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function selectFor(mode) {
    return els[PANES[mode].select];
  }

  // Only the select for the mode being shown is rebuilt, so switching tabs and
  // back never throws away the model the user had picked in the other pane.
  function fillSelect(mode) {
    const select = selectFor(mode);
    const list = state.models[mode];
    const previous = select.value;
    select.textContent = '';
    for (const model of list) {
      const node = document.createElement('option');
      node.value = model.id;
      node.textContent = model.perRequest ? `${model.id}  ·  ${vnd(model.perRequest)} each` : model.id;
      select.append(node);
    }
    if (!list.length) {
      const node = document.createElement('option');
      node.value = '';
      node.textContent = PANES[mode].empty;
      select.append(node);
      return;
    }
    if (list.some((model) => model.id === previous)) select.value = previous;
  }

  function selectedModel(mode) {
    return state.models[mode].find((m) => m.id === selectFor(mode).value) || null;
  }

  function pictureCount() {
    return Math.min(4, Math.max(1, Number(els.imageCount.value) || 1));
  }

  // What one click on Generate will cost at the provider's own list rate, or null
  // when the answer cannot be known before the request — which is the video case.
  function listPrice(mode) {
    if (mode === 'video') return null;
    const model = selectedModel(mode);
    if (!model || model.perRequest === null) return null;
    return model.perRequest * (mode === 'image' ? pictureCount() : 1);
  }

  function updatePrice() {
    const list = listPrice(state.mode);
    if (list === null) {
      els.priceChip.textContent = state.mode === 'video'
        ? 'a clip is billed by the provider when it finishes'
        : 'price unknown for this model';
      return;
    }
    const billed = list * (1 + (Number(state.markupPercent) || 0) / 100);
    const times = state.mode === 'image' && pictureCount() > 1 ? ` for ${pictureCount()} pictures` : '';
    els.priceChip.textContent = `${vnd(list)} list${times} · ${vnd(billed)} with the ${state.markupPercent}% markup`;
  }

  function updateCeilingNote() {
    // Each pane explains its own money, so the note travels with the tab instead of
    // repeating the picture pane's sentence under Video.
    els.paneNote.textContent = COPY[state.mode].note;
    els.paneNote.hidden = false;
    if (state.mode !== 'image' || !state.pictureCeiling || !state.pictureTotal) return;
    const hidden = state.pictureTotal - state.models.image.length;
    els.paneNote.textContent += hidden > 0
      ? ` ${state.models.image.length} of the ${state.pictureTotal} picture models on this account are`
        + ` offered here: the other ${hidden} cost ${vnd(state.pictureCeiling)} or more for one picture.`
      : ' Every picture model on this account is under the price limit, so all of them are offered.';
  }

  function setMode(mode) {
    state.mode = mode;
    for (const tab of document.querySelectorAll('.sp-tab')) {
      const on = tab.dataset.mode === mode;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', String(on));
    }
    els.imageFields.hidden = mode !== 'image';
    els.editFields.hidden = mode !== 'edit';
    els.videoFields.hidden = mode !== 'video';
    els.voiceFields.hidden = mode !== 'voice';
    const copy = COPY[mode];
    els.paneTitle.textContent = copy.title;
    els.paneSub.innerHTML = copy.sub;
    els.goBtn.textContent = copy.button;
    els.promptLabel.textContent = copy.promptLabel;
    els.prompt.placeholder = copy.placeholder;
    els.polishBtn.hidden = !copy.polish;
    els.polishNote.textContent = copy.polishNote || '';
    if (mode === 'edit' || mode === 'image') showPreview();
    fillSelect(mode);
    updatePrice();
    updateCeilingNote();
    hideConfirm();
    clearError();
    clearResults();
  }

  async function loadCatalogue() {
    const res = await window.Auth.api('/api/studio/models');
    if (!window.Auth.guard(res)) return;
    if (!res.ok) {
      showError(res.data?.error || 'The studio could not read the model list.');
      return;
    }
    for (const mode of Object.keys(state.models)) {
      state.models[mode] = Array.isArray(res.data[mode]) ? res.data[mode] : [];
    }
    state.markupPercent = Number(res.data.markupPercent) || 0;
    state.pictureCeiling = Number(res.data.pictureCeiling) || 0;
    state.pictureTotal = Number(res.data.pictureTotal) || 0;
    fillSelect(state.mode);
    updatePrice();
    updateCeilingNote();
  }

  /* --------------------------------------------------------------- picture input */

  /* Drawing onto a canvas is what makes the send size the browser's choice rather
     than the file's. The result is always JPEG: a photo edit does not need alpha,
     and the transparency that PNG keeps costs several times the bytes.

     The file is read as a data: url rather than a blob: one. img-src allows data: and
     not blob:, and a CSP-blocked image fires no error event at all, so the blob
     version left this promise unsettled forever and the picture never appeared. */
  function resizeToDataUrl(file) {
    return new Promise((done, fail) => {
      const reader = new FileReader();
      reader.onerror = () => fail(reader.error || new Error('That file could not be read.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => fail(new Error('That file is not a picture this browser can read.'));
        img.onload = () => {
          const scale = Math.min(1, EDIT_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          try {
            done({ dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: canvas.width, height: canvas.height });
          } catch (err) {
            fail(new Error(`This browser could not re-encode that picture: ${err.message}`));
          }
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  // A screenshot or a copied picture has no filename worth showing, and Chrome calls
  // one "image.png" while Safari calls one "blob" — neither is what the visitor did.
  function clipboardImage(clipboard) {
    const items = clipboard && clipboard.items ? [...clipboard.items] : [];
    const hit = items.find((item) => item.kind === 'file' && /^image\//.test(item.type));
    if (hit) return hit.getAsFile();
    // Safari leaves the file on `files` and puts nothing usable on `items`.
    return [...(clipboard && clipboard.files ? clipboard.files : [])]
      .find((file) => /^image\//.test(file.type)) || null;
  }

  function previewNote() {
    const picture = state.picture;
    if (!picture.cached) return picture.label;
    if (!picture.savedAt) return `${picture.label} · kept in this browser`;
    const age = Math.floor((Date.now() - picture.savedAt) / 86400000);
    return `${picture.label} · kept in this browser ${age <= 0 ? 'today' : `for ${age} day${age === 1 ? '' : 's'}`}`;
  }

  // Both picture panes take a reference now, so the preview belongs to whichever
  // one is open rather than to Edit alone.
  function showPreview() {
    els.editPreview.textContent = '';
    const pane = state.mode === 'image' || state.mode === 'edit';
    els.editPreview.hidden = !pane || !state.picture;
    if (!pane || !state.picture) return;

    const thumb = element('img');
    thumb.src = state.picture.dataUrl;
    thumb.alt = '';
    const forget = element('button', 'mini-btn', 'Forget');
    forget.type = 'button';
    forget.title = 'Clear the picture and drop it from this browser\u2019s cache';
    forget.addEventListener('click', () => {
      state.picture = null;
      els.editFile.value = '';
      els.imageFile.value = '';
      cacheClear();
      showPreview();
    });
    els.editPreview.append(thumb, element('span', 'preview-meta', previewNote()), forget);
  }

  async function choosePicture(file) {
    if (!file) {
      state.picture = null;
      showPreview();
      return;
    }
    if (!/^image\//.test(file.type)) {
      state.picture = null;
      els.editFile.value = '';
      els.imageFile.value = '';
      showPreview();
      showError('Pick a picture — PNG, JPEG, WebP or GIF.');
      return;
    }
    try {
      const { dataUrl, width, height } = await resizeToDataUrl(file);
      if (dataUrl.length > EDIT_MAX_CHARS) {
        showError('Even resized, that file is too large to send. Crop it down and try again.');
        return;
      }
      const name = file.name && file.name !== 'blob' ? file.name : 'Pasted picture';
      const label = `${name} · ${width} × ${height} · about ${Math.round(dataUrl.length * 0.75 / 1024)} KB sent`;
      const savedAt = Date.now();
      const kept = await cacheWrite({ dataUrl, label, savedAt });
      state.picture = { dataUrl, label, savedAt: kept ? savedAt : 0, cached: kept };
      hideConfirm();
      showPreview();
      clearError();
    } catch (err) {
      state.picture = null;
      showPreview();
      showError(err.message);
    }
  }

  /* ------------------------------------------------------------- price confirm */

  function askConfirm() {
    const list = listPrice('edit');
    const billed = list === null
      ? null
      : list * (1 + (Number(state.markupPercent) || 0) / 100);
    els.confirmText.textContent = list === null
      ? `The provider lists no price for ${selectFor('edit').value}, so this edit cannot be quoted in advance.`
        + ' It is charged to your own key when the model answers. Confirm to send it anyway.'
      : `One edit on ${selectFor('edit').value} is ${vnd(list)} at the provider and ${vnd(billed)} with the`
        + ` ${state.markupPercent}% markup, charged to your own key. Nothing is sent until you confirm.`;
    els.confirmBtn.textContent = list === null ? 'Send it anyway' : `Confirm — ${vnd(billed || 0)}`;
    els.confirmBox.hidden = false;
    els.goBtn.textContent = COPY.edit.button;
  }

  /* ------------------------------------------------------------------ requests */

  function stopWaiting() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  function wait(ms) {
    return new Promise((done) => {
      state.timer = setTimeout(done, ms);
      if (state.controller) {
        state.controller.signal.addEventListener('abort', () => {
          stopWaiting();
          done();
        }, { once: true });
      }
    });
  }

  function setBusy(busy) {
    state.busy = busy;
    els.goBtn.disabled = busy;
    els.prompt.disabled = busy;
    els.polishBtn.disabled = busy;
    els.cancelBtn.hidden = !busy;
    if (!busy) {
      stopWaiting();
      state.controller = null;
    }
  }

  function extensionFor(mime) {
    if (/^data:image\/(png)/.test(mime || '')) return 'png';
    if (/^data:image\/webp/.test(mime || '')) return 'webp';
    if (/^data:image\/gif/.test(mime || '')) return 'gif';
    return 'jpg';
  }

  function pictureFigure(image, index, model, alt) {
    const box = element('figure', 'shot');
    const img = element('img');
    if (image.dataUrl) {
      img.src = image.dataUrl;
    } else {
      img.src = image.url;
      // The provider's CDN has no reason to learn which page embedded its file.
      img.referrerPolicy = 'no-referrer';
    }
    img.alt = `${alt} ${index + 1}`;
    img.loading = 'lazy';
    box.append(img);

    const foot = element('figcaption');
    foot.append(element('span', 'shot-name', model));
    if (image.revisedPrompt) foot.append(element('span', 'shot-revised', image.revisedPrompt));
    const links = element('span', 'shot-actions');
    const save = element('a', 'mini-btn', 'Download');
    save.href = image.dataUrl || image.url;
    save.download = `devchat-${index + 1}.${extensionFor(image.dataUrl || '')}`;
    if (!image.dataUrl) {
      // A cross-origin link cannot be renamed by the browser, so it opens instead.
      save.target = '_blank';
      save.rel = 'noopener';
    }
    links.append(save);
    foot.append(links);
    box.append(foot);
    return box;
  }

  function showPictures(images, model, data, alt) {
    els.resultsCard.hidden = false;
    els.resultsSub.textContent = `${model} · ${images.length} picture${images.length === 1 ? '' : 's'} ·`
      + ` ${vnd(data.baseCost)} at the provider · ${vnd(data.billedCost)} with markup`;
    images.forEach((image, index) => els.gallery.append(pictureFigure(image, index, model, alt)));
  }

  async function runImage(prompt) {
    const body = {
      model: selectFor('image').value,
      prompt,
      n: pictureCount()
    };
    if (els.imageSize.value) body.size = els.imageSize.value;
    // A file the visitor picked or dropped beats a link they typed: it is the thing
    // they are looking at, and sending both would leave the provider to guess.
    if (state.picture) body.picture = state.picture.dataUrl;
    else if (els.imageUrl.value.trim()) body.imageUrl = els.imageUrl.value.trim();

    const res = await window.Auth.api('/api/image', { method: 'POST', body, signal: state.controller.signal });
    if (state.controller.signal.aborted) {
      showStatus('');
      showError('Cancelled. The provider may still have drawn it — a cancelled request is charged once it left this server.');
      return;
    }
    if (!window.Auth.guard(res)) return;
    if (!res.ok || !Array.isArray(res.data.images) || !res.data.images.length) {
      showStatus('');
      showError(res.data?.error || 'The provider did not return a picture.');
      return;
    }
    showStatus(`${res.data.images.length} in ${Math.round((res.data.ms || 0) / 100) / 10}s`);
    clearResults();
    showPictures(res.data.images, res.data.model, res.data, 'Generated picture');
  }

  async function runEdit(prompt) {
    const res = await window.Auth.api('/api/image/edit', {
      method: 'POST',
      signal: state.controller.signal,
      body: { model: selectFor('edit').value, prompt, picture: state.picture.dataUrl }
    });
    if (state.controller.signal.aborted) {
      showStatus('');
      showError('Cancelled. If the request had already left this server, the edit is charged.');
      return;
    }
    if (!window.Auth.guard(res)) return;
    if (!res.ok || !Array.isArray(res.data.images) || !res.data.images.length) {
      showStatus('');
      showError(res.data?.error || 'The model did not send an edited picture back.');
      return;
    }
    showStatus(`done in ${Math.round((res.data.ms || 0) / 100) / 10}s`);
    clearResults();
    showPictures(res.data.images, res.data.model, res.data, 'Edited picture');
  }

  function showClip(url, model) {
    els.clip.textContent = '';
    const video = element('video', 'clip-player');
    video.src = url;
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    els.clip.append(video);
    const row = element('div', 'shot-actions');
    const open = element('a', 'mini-btn', 'Open the file');
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener';
    row.append(open);
    els.clip.append(row);
    els.resultsSub.textContent = `${model} finished. The clip is hosted by the provider, so this link is the file rather than a copy of it.`;
  }

  async function follow(taskId, model) {
    const deadline = Date.now() + POLL_MAX_MS;
    while (!state.controller.signal.aborted && Date.now() < deadline) {
      await wait(POLL_MS);
      if (state.controller.signal.aborted) break;
      const res = await window.Auth.api(`/api/video/${encodeURIComponent(taskId)}`, { signal: state.controller.signal });
      if (state.controller.signal.aborted) break;
      if (!window.Auth.guard(res)) return;
      if (!res.ok) {
        showStatus('');
        showError(res.data?.error || 'DevChat lost track of this job.');
        return;
      }
      const task = res.data.task || {};
      if (task.status === 'succeeded' && task.url) {
        showStatus('ready');
        showClip(task.url, model);
        return;
      }
      if (task.status === 'failed') {
        showStatus('');
        showError(task.error || 'The provider gave up on this job.');
        return;
      }
      showStatus(`rendering${task.progress === null || task.progress === undefined ? '…' : ` ${task.progress}%`}`);
    }
    if (!state.controller.signal.aborted) {
      showStatus('timed out');
      showError('This is taking longer than twelve minutes. The job keeps running upstream — reload this page in a while and ask again, or shorten the clip.');
    }
  }

  async function runVideo(prompt) {
    const res = await window.Auth.api('/api/video', {
      method: 'POST',
      signal: state.controller.signal,
      body: {
        model: selectFor('video').value,
        prompt,
        resolution: els.videoResolution.value,
        // 4–15 seconds is what the two documented MiniMax models accept; the
        // server keeps a wider hard bound in case VIDEO_MODELS names something else.
        duration: Math.min(15, Math.max(4, Number(els.videoDuration.value) || 5)),
        ratio: els.videoRatio.value
      }
    });
    if (state.controller.signal.aborted) {
      showStatus('');
      showError('Cancelled before the job was submitted, so nothing was charged.');
      return;
    }
    if (!window.Auth.guard(res)) return;
    if (!res.ok || !res.data.task || !res.data.task.id) {
      showStatus('');
      showError(res.data?.error || 'The provider did not take the job.');
      return;
    }
    clearResults();
    els.resultsCard.hidden = false;
    showStatus(`queued ${res.data.task.id}`);
    await follow(res.data.task.id, res.data.model);
  }

  // The answer is a file, so there is no JSON to read the charge out of: the chip
  // above already quoted the list price, and the usage log holds the server's own.
  async function runSpeech(text) {
    const res = await window.Auth.apiBinary('/api/audio/speech', {
      signal: state.controller.signal,
      body: { model: selectFor('voice').value, input: text, voice: els.voiceName.value.trim() || 'alloy' }
    });
    if (state.controller.signal.aborted) {
      showStatus('');
      showError('Cancelled. A clip that had already left this server is still charged.');
      return;
    }
    if (!window.Auth.guard(res)) return;
    if (!res.ok || !res.blob || !res.blob.size) {
      showStatus('');
      showError(res.data?.error || 'The provider did not return any audio.');
      return;
    }

    // First, because clearResults() is what revokes the previous blob: URL.
    clearResults();
    const url = URL.createObjectURL(res.blob);
    state.clipUrl = url;
    const player = element('audio');
    player.src = url;
    player.controls = true;
    const save = element('a', 'mini-btn', 'Download');
    save.href = url;
    save.download = `devchat-speech.${/wav/.test(res.blob.type) ? 'wav' : /ogg/.test(res.blob.type) ? 'ogg' : 'mp3'}`;
    const row = element('div', 'shot-actions');
    row.append(save);
    els.audio.append(player, row);
    els.resultsCard.hidden = false;
    els.resultsSub.textContent = `${selectFor('voice').value} spoke ${text.length} characters as`
      + ` "${els.voiceName.value.trim() || 'alloy'}". The file lives in this tab only — nothing is stored on`
      + ' the server, so download it if you want to keep it.';
    showStatus(`${Math.round(res.blob.size / 1024)} KB`);
  }

  /* ------------------------------------------------------------- prompt writing */

  // Each brief is the whole instruction. The model is not asked to explain itself and
  // is never shown a template with blanks, because a filled-in template reads as a
  // prompt written by the template rather than by the person who typed the request.
  const POLISH = {
    image: 'You rewrite requests into prompts for a still-image generator. Return ONE prompt, nothing else.'
      + '\n\nRules:'
      + '\n1. Lead with the subject and what it is doing, concretely: who or what, where, at what moment.'
      + '\n2. Then the medium and style (photo, oil, 3D render, illustration), the camera or lens if photographic,'
      + ' the framing and angle, the lighting and time of day, the palette, and the mood — in that order.'
      + '\n3. Keep every specific the person gave: names, colours, numbers, places, brands, text that must'
      + ' appear. Never swap a specific for a generic word.'
      + '\n4. Where the request is silent, choose the detail that serves the subject best rather than listing'
      + ' alternatives. Do not add a second subject or a second scene.'
      + '\n5. End with the negative: what must not appear (extra limbs, watermark, blur, distorted text).'
      + '\n6. 45 to 110 words, one paragraph, present tense, plain text. No preamble, no quotes, no labels,'
      + ' no bullet points, no explanation. Write it in the language the request was written in.',
    edit: 'You rewrite requests into ONE editing instruction for an image model that has been handed a real'
      + ' photograph. The photograph is already loaded; do not describe it back.\n\nRules:'
      + '\n1. Say what to change, and where in the frame, in concrete visual terms — not the feeling, the pixels.'
      + '\n2. Say what must stay identical: faces and identity, pose, framing, perspective, lighting direction,'
      + ' and any text visible in the picture.'
      + '\n3. Say how the result should look: finish, colour, grain, sharpness, whether it should still read as'
      + ' a photograph.'
      + '\n4. Keep every specific the person gave. Choose a definite value where they left a gap.'
      + '\n5. 30 to 80 words, one paragraph, imperative mood, plain text. No preamble, no quotes, no labels,'
      + ' no list, no explanation of your choices. Same language as the request.',
    video: 'You rewrite requests into prompts for a text-to-video model. Return ONE prompt, nothing else.'
      + '\n\nRules:'
      + '\n1. Open with the shot: subject, action, and setting in one sentence, concrete enough to film.'
      + '\n2. Then camera: shot size, movement (locked off, slow push, tracking, handheld), angle, lens.'
      + '\n3. Then light, palette, mood, and the pace of the action.'
      + '\n4. Describe motion over time — what happens in the first second and what changes by the end.'
      + ' A video prompt is a short scene, not a still.'
      + '\n5. Keep every specific the person gave. Choose one definite outcome rather than alternatives.'
      + '\n6. End with the negative: warped faces, extra fingers, flicker, morphing, watermark.'
      + '\n7. 45 to 110 words, one paragraph, present tense, plain text. No preamble, no quotes, no labels,'
      + ' no list, no explanation. Same language as the request.'
  };

  // A model will wrap its answer in a code fence or a polite sentence. Neither is
  // part of the prompt, and the textarea is where the user has to be able to read it.
  function cleanRewrite(text) {
    return String(text)
      .replace(/^[\s\S]*?```(?:\w*)\n?([\s\S]*?)```[\s\S]*$/, '$1')
      .replace(/^\s*(?:prompt|here(?:\u2019|'s)? the (?:improved|better) prompt)\s*[:\-]\s*/i, '')
      .replace(/^["'\u201c]+|["'\u201d]+$/g, '')
      .replace(/\s*\n\s*/g, ' ')
      .trim()
      .slice(0, 4000);
  }

  async function polish() {
    const prompt = els.prompt.value.trim();
    if (!prompt) {
      showError('Write what you want first — the rewriter needs a starting point.');
      els.prompt.focus();
      return;
    }
    clearError();
    state.controller = new AbortController();
    setBusy(true);
    showStatus('writing…');
    try {
      const res = await window.Auth.api('/api/chat', {
        method: 'POST',
        signal: state.controller.signal,
        body: {
          stream: false,
          messages: [
            { role: 'system', content: POLISH[state.mode] },
            { role: 'user', content: prompt }
          ]
        }
      });
      if (state.controller.signal.aborted) {
        showStatus('');
        return;
      }
      if (!window.Auth.guard(res)) return;
      const text = res.data?.choices?.[0]?.message?.content;
      if (!res.ok || !text) {
        showStatus('');
        showError(res.data?.error || 'No rewrite came back. Write the prompt in your own words — it is allowed.');
        return;
      }
      els.prompt.value = cleanRewrite(text);
      showStatus('rewritten');
      updatePrice();
    } catch (err) {
      showStatus('');
      showError(`Something went wrong in this page: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------------------------------------------- routing */

  // Returns true when the click cannot be honoured, having said why. The empty
  // select is a different story in each pane, so each gets its own sentence rather
  // than one generic "pick a model".
  function blocked(mode) {
    if (mode === 'edit' && !state.picture) {
      showError('Choose the picture you want edited first.');
      els.editFile.focus();
      return true;
    }
    if (selectFor(mode).value) return false;
    showError(mode === 'image'
      ? 'This account has no image model under the price limit to ask. The pricing page lists what the'
        + ' provider offers, and an administrator can raise MAX_PICTURE_DONG.'
      : mode === 'edit'
        ? 'No model on this account can take a picture as input, so there is nothing here to edit with.'
        : mode === 'voice'
          ? 'The provider lists no speech model for this account. DevChat reads that list from the'
            + ' catalogue rather than guessing a name, so an unlisted model is not offered.'
          : 'No video model is configured on this server. Set VIDEO_MODELS to the names your provider gives you.');
    return true;
  }

  async function generate() {
    if (state.busy) return;
    const prompt = els.prompt.value.trim();
    if (!prompt) {
      if (state.mode === 'voice') showError('Write the text you want read aloud first.');
      else showError('Write a prompt first.');
      els.prompt.focus();
      return;
    }
    if (blocked(state.mode)) return;

    // Editing spends on a model the price ceiling does not cover, so the number is
    // put in front of the user and one click is required to spend it.
    if (state.mode === 'edit' && !state.confirmed) {
      askConfirm();
      return;
    }

    clearError();
    if (state.mode !== 'video') clearResults();
    hideConfirm();
    state.controller = new AbortController();
    setBusy(true);
    showStatus(state.mode === 'image' ? 'rendering…'
      : state.mode === 'edit' ? 'editing…'
        : state.mode === 'voice' ? 'speaking…' : 'submitting…');
    try {
      if (state.mode === 'image') await runImage(prompt);
      else if (state.mode === 'edit') await runEdit(prompt);
      else if (state.mode === 'voice') await runSpeech(prompt);
      else await runVideo(prompt);
    } catch (err) {
      showError(`Something went wrong in this page: ${err.message}`);
    } finally {
      setBusy(false);
      els.goBtn.textContent = COPY[state.mode].button;
    }
  }

  async function restorePicture() {
    const found = await cacheRead();
    if (!found) return;
    state.picture = { dataUrl: found.dataUrl, label: found.label, savedAt: Number(found.savedAt), cached: true };
    showPreview();
  }

  /* ------------------------------------------------------- a file from the desk */

  /* Dragging a picture in off the file manager is the shortest path there is: the
     browser hands over the same File object the picker would, so the bytes are read
     straight off the disk — no save-then-reopen detour, no intermediate copy, and
     nothing written anywhere but in memory for this one request. */
  function armDrop() {
    const veil = element('div', 'drop-veil');
    veil.hidden = true;
    veil.append(element('div', 'drop-card',
      'Drop the picture — it is read from your disk as it is, and stays in this tab'));
    document.body.append(veil);

    let depth = 0;
    const wants = () => state.mode === 'image' || state.mode === 'edit';
    const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');

    document.addEventListener('dragenter', (event) => {
      if (!wants() || !hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      veil.hidden = false;
    });
    document.addEventListener('dragover', (event) => {
      if (!wants() || !hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) veil.hidden = true;
    });
    document.addEventListener('drop', (event) => {
      if (!wants() || !hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      veil.hidden = true;
      const file = Array.from(event.dataTransfer.files || [])
        .find((item) => /^image\//.test(item.type));
      if (file) choosePicture(file);
      else showError('That is not a picture this studio can send — PNG, JPEG, WebP or GIF.');
    });
  }

  function bind() {
    for (const tab of document.querySelectorAll('.sp-tab')) tab.addEventListener('click', () => setMode(tab.dataset.mode));
    els.goBtn.addEventListener('click', generate);
    els.cancelBtn.addEventListener('click', () => {
      if (state.controller) state.controller.abort();
      showStatus('');
    });
    els.confirmBtn.addEventListener('click', () => {
      state.confirmed = true;
      els.goBtn.textContent = 'Working…';
      generate();
    });
    els.confirmNoBtn.addEventListener('click', () => {
      hideConfirm();
      els.goBtn.textContent = COPY.edit.button;
      showStatus('');
    });
    els.editFile.addEventListener('change', () => choosePicture(els.editFile.files[0]));
    els.imageFile.addEventListener('change', () => choosePicture(els.imageFile.files[0]));
    armDrop();
    // Pasting is how a picture actually moves around a desktop, so a screenshot that
    // is already on the clipboard should not have to be saved to a file first. The
    // prompt is a plain textarea, so text still pastes into it as normal — taking the
    // image alongside costs nothing, and that is what a copied picture needs.
    document.addEventListener('paste', (event) => {
      if (state.mode !== 'edit' && state.mode !== 'image') return;
      const file = clipboardImage(event.clipboardData);
      if (file) choosePicture(file);
    });
    selectFor('image').addEventListener('change', () => { updatePrice(); hideConfirm(); });
    selectFor('edit').addEventListener('change', () => { updatePrice(); hideConfirm(); });
    selectFor('voice').addEventListener('change', updatePrice);
    els.imageCount.addEventListener('input', updatePrice);
    els.polishBtn.addEventListener('click', polish);
    els.prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        generate();
      }
    });
    initTheme($('#themeBtn'));
  }

  async function start() {
    const user = await window.Auth.boot({ requireKey: true });
    if (!user) return;
    initNav(user);
    bind();
    setMode('image');
    await loadCatalogue();
    await restorePicture();
  }

  start();
})();
