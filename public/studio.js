/* Picture and video generation. Everything here goes through the same two rules
   the chat page follows: the key never reaches the browser (the server signs the
   upstream call), and pricing is the server's arithmetic, not a guess in here.
   The chip below is a hint of what /api/image will report, and the number the
   usage log keeps is the one the server answered with. */
(() => {
  'use strict';

  const { $, vnd, initTheme, initNav } = window.Page;

  const POLL_MS = 4000;
  // A clip takes minutes and a picture takes seconds, so the two share one
  // waiting loop with a ceiling that suits the slow one.
  const POLL_MAX_MS = 12 * 60 * 1000;

  const els = {
    paneTitle: $('#paneTitle'),
    paneSub: $('#paneSub'),
    imageFields: $('#imageFields'),
    videoFields: $('#videoFields'),
    imageModel: $('#imageModel'),
    imageSize: $('#imageSize'),
    imageCount: $('#imageCount'),
    imageUrl: $('#imageUrl'),
    videoModel: $('#videoModel'),
    videoResolution: $('#videoResolution'),
    videoDuration: $('#videoDuration'),
    videoRatio: $('#videoRatio'),
    prompt: $('#prompt'),
    goBtn: $('#goBtn'),
    cancelBtn: $('#cancelBtn'),
    priceChip: $('#priceChip'),
    statusChip: $('#statusChip'),
    videoNote: $('#videoNote'),
    errorBox: $('#errorBox'),
    resultsCard: $('#resultsCard'),
    resultsSub: $('#resultsSub'),
    gallery: $('#gallery'),
    clip: $('#clip')
  };

  const state = {
    mode: 'image',
    image: [],
    video: [],
    markupPercent: 0,
    busy: false,
    controller: null,
    timer: null
  };

  const COPY = {
    image: {
      title: 'Make a picture',
      sub: 'Models are listed because the provider says they answer on the image endpoint — not because'
        + ' the name looks right. Each picture is priced per request and billed to <b>your own</b> key.',
      button: 'Generate picture'
    },
    video: {
      title: 'Make a short clip',
      sub: 'The provider does not publish these models in its price list, so DevChat cannot quote a clip'
        + ' before you ask for one. It sends the job, then polls the task until a file comes back.',
      button: 'Start the job'
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

  function clearResults() {
    els.gallery.textContent = '';
    els.clip.textContent = '';
    els.resultsCard.hidden = true;
    els.resultsSub.textContent = '';
  }

  // Only textContent and createElement: a model's own words about a picture are
  // provider data, and provider data never becomes markup on this page.
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Only the select for the mode being shown is rebuilt, so switching tabs and
  // back never throws away the model the user had picked in the other pane.
  function fillSelects() {
    const select = state.mode === 'image' ? els.imageModel : els.videoModel;
    const list = state.mode === 'image' ? state.image : state.video;
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
      node.textContent = state.mode === 'image' ? 'no image model on this account' : 'no video model configured';
      select.append(node);
    }
  }

  function pricedModel() {
    return state.image.find((m) => m.id === els.imageModel.value) || null;
  }

  function updatePrice() {
    if (state.mode !== 'image') {
      els.priceChip.textContent = 'a clip is billed by the provider when it finishes';
      return;
    }
    const model = pricedModel();
    const count = Math.min(4, Math.max(1, Number(els.imageCount.value) || 1));
    if (!model || model.perRequest === null) {
      els.priceChip.textContent = 'price unknown for this model';
      return;
    }
    const list = model.perRequest * count;
    const billed = list * (1 + (Number(state.markupPercent) || 0) / 100);
    els.priceChip.textContent = `${vnd(list)} list · ${vnd(billed)} with the ${state.markupPercent}% markup`;
  }

  function setMode(mode) {
    state.mode = mode;
    for (const tab of document.querySelectorAll('.sp-tab')) {
      const on = tab.dataset.mode === mode;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', String(on));
    }
    els.imageFields.hidden = mode !== 'image';
    els.videoFields.hidden = mode !== 'video';
    els.videoNote.hidden = mode !== 'video';
    els.paneTitle.textContent = COPY[mode].title;
    els.paneSub.innerHTML = COPY[mode].sub;
    els.goBtn.textContent = COPY[mode].button;
    fillSelects();
    updatePrice();
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
    state.image = Array.isArray(res.data.image) ? res.data.image : [];
    state.video = Array.isArray(res.data.video) ? res.data.video : [];
    state.markupPercent = Number(res.data.markupPercent) || 0;
    fillSelects();
    updatePrice();
  }

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
    els.cancelBtn.hidden = !busy;
    if (!busy) {
      stopWaiting();
      state.controller = null;
    }
  }

  function pictureFigure(image, index, model) {
    const box = element('figure', 'shot');
    const img = element('img');
    if (image.dataUrl) {
      img.src = image.dataUrl;
    } else {
      img.src = image.url;
      // The provider's CDN has no reason to learn which page embedded its file.
      img.referrerPolicy = 'no-referrer';
    }
    img.alt = `Generated picture ${index + 1}`;
    img.loading = 'lazy';
    box.append(img);

    const foot = element('figcaption');
    foot.append(element('span', 'shot-name', model));
    if (image.revisedPrompt) foot.append(element('span', 'shot-revised', image.revisedPrompt));
    const links = element('span', 'shot-actions');
    const save = element('a', 'mini-btn', 'Download');
    save.href = image.dataUrl || image.url;
    save.download = `devchat-${index + 1}.png`;
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

  async function runImage(prompt) {
    const body = {
      model: els.imageModel.value,
      prompt,
      n: Math.min(4, Math.max(1, Number(els.imageCount.value) || 1))
    };
    if (els.imageSize.value) body.size = els.imageSize.value;
    if (els.imageUrl.value.trim()) body.imageUrl = els.imageUrl.value.trim();

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
    els.resultsCard.hidden = false;
    els.resultsSub.textContent = `${res.data.model} · ${res.data.images.length} picture`
      + `${res.data.images.length === 1 ? '' : 's'} · ${vnd(res.data.baseCost)} at the provider `
      + `· ${vnd(res.data.billedCost)} with markup`;
    res.data.images.forEach((image, index) => els.gallery.append(pictureFigure(image, index, res.data.model)));
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
        model: els.videoModel.value,
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

  async function generate() {
    if (state.busy) return;
    const prompt = els.prompt.value.trim();
    if (!prompt) {
      showError('Write a prompt first.');
      els.prompt.focus();
      return;
    }
    if (!els.imageModel.value && state.mode === 'image') {
      showError('This account has no image model to ask. See the pricing page for what the provider lists.');
      return;
    }
    if (!els.videoModel.value && state.mode === 'video') {
      showError('No video model is configured on this server. Set VIDEO_MODELS to the names your provider gives you.');
      return;
    }

    clearError();
    clearResults();
    state.controller = new AbortController();
    setBusy(true);
    showStatus(state.mode === 'image' ? 'rendering…' : 'submitting…');
    try {
      if (state.mode === 'image') await runImage(prompt);
      else await runVideo(prompt);
    } catch (err) {
      showError(`Something went wrong in this page: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function bind() {
    for (const tab of document.querySelectorAll('.sp-tab')) tab.addEventListener('click', () => setMode(tab.dataset.mode));
    els.goBtn.addEventListener('click', generate);
    els.cancelBtn.addEventListener('click', () => {
      if (state.controller) state.controller.abort();
      showStatus('');
    });
    els.imageModel.addEventListener('change', updatePrice);
    els.imageCount.addEventListener('input', updatePrice);
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
  }

  start();
})();
