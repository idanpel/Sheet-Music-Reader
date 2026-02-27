(() => {
  "use strict";

  // ── PDF.js setup ──────────────────────────────────────────────
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  // ── DOM refs ──────────────────────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const fileInput    = $("#file-input");
  const pdfCanvas    = $("#pdf-canvas");
  const annCanvas    = $("#annotation-canvas");
  const musicCanvas  = $("#music-canvas");
  const pdfCtx       = pdfCanvas.getContext("2d");
  const annCtx       = annCanvas.getContext("2d");
  const musicCtx     = musicCanvas.getContext("2d");
  const wrapper      = $("#canvas-wrapper");
  const dropZone     = $("#drop-zone");
  const pageInfo     = $("#page-info");
  const zoomLabel    = $("#zoom-level");
  const colorPicker  = $("#color-picker");
  const penWidthEl   = $("#pen-width");
  const toolbar      = $("#toolbar");
  const docNameEl    = $("#toolbar-doc-name");
  const eraserCursor = $("#eraser-cursor");
  const statusToast  = $("#status-toast");

  // ── State ─────────────────────────────────────────────────────
  let pdfDoc     = null;
  let pdfBytes   = null; // raw PDF bytes for persistence
  let pdfName    = "";   // filename of current PDF
  let pageNum    = 1;
  let totalPages = 0;
  let scale      = 1.5;
  let tool       = "none";
  let drawing    = false;
  let currentPath = [];
  let immersiveMode = false;
  let toolbarAutoHideTimer = null;

  // Music annotation state
  let selectedMusicSymbol = null;
  let musicAnnotations = {};
  let musicVisible = true;
  let musicUndoStacks = {};

  // Navigation gesture tracking
  let navStartX = 0;
  let navStartY = 0;
  let navStartTime = 0;
  let isNavigating = false;
  const SWIPE_THRESHOLD = 80;
  const SWIPE_TIME_LIMIT = 400;
  const TAP_ZONE_RATIO = 0.25;

  // Page render cache
  const pageCache = {};

  // Per-page annotation layers stored as ImageData
  const annotations = {};
  const undoStacks = {};

  // Wake Lock
  let wakeLock = null;

  // ── IndexedDB for persistence ─────────────────────────────────
  const DB_NAME = "ScorePadDB";
  const DB_VERSION = 2;
  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains("annotations")) {
          d.createObjectStore("annotations");
        }
        if (!d.objectStoreNames.contains("library")) {
          d.createObjectStore("library", { keyPath: "name" });
        }
        if (!d.objectStoreNames.contains("state")) {
          d.createObjectStore("state");
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function dbPut(store, key, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      const s = tx.objectStore(store);
      // If store has a keyPath (like "library"), don't pass an explicit key
      const req = (key !== null && key !== undefined) ? s.put(value, key) : s.put(value);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function dbGet(store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const s = tx.objectStore(store);
      const req = s.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbGetAll(store) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const s = tx.objectStore(store);
      const req = s.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbDelete(store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      const s = tx.objectStore(store);
      const req = s.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ── Wake Lock API ─────────────────────────────────────────────
  async function acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch (_) { /* ignore */ }
  }

  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && pdfDoc) acquireWakeLock();
  });

  // ── Toast ─────────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(msg, duration = 2000) {
    statusToast.textContent = msg;
    statusToast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => statusToast.classList.add("hidden"), duration);
  }

  // ── Helpers ───────────────────────────────────────────────────
  function saveAnnotationState() {
    if (!pdfDoc) return;
    const key = pageNum;
    if (!undoStacks[key]) undoStacks[key] = [];
    undoStacks[key].push(annCtx.getImageData(0, 0, annCanvas.width, annCanvas.height));
    if (undoStacks[key].length > 30) undoStacks[key].shift();
  }

  function storePageAnnotations() {
    if (!pdfDoc) return;
    annotations[pageNum] = annCtx.getImageData(0, 0, annCanvas.width, annCanvas.height);
  }

  function restorePageAnnotations() {
    annCtx.clearRect(0, 0, annCanvas.width, annCanvas.height);
    if (annotations[pageNum]) {
      annCtx.putImageData(annotations[pageNum], 0, 0);
    }
  }

  // ── Persist annotations to IndexedDB ──────────────────────────
  async function persistAnnotations() {
    if (!db || !pdfDoc || !pdfName) return;
    storePageAnnotations();

    // Convert ImageData annotations to serializable format (base64 data URLs)
    const serialized = {};
    for (const [pg, imgData] of Object.entries(annotations)) {
      const c = document.createElement("canvas");
      c.width = imgData.width;
      c.height = imgData.height;
      c.getContext("2d").putImageData(imgData, 0, 0);
      serialized[pg] = c.toDataURL("image/png");
    }

    const data = {
      annotations: serialized,
      musicAnnotations: JSON.parse(JSON.stringify(musicAnnotations)),
      pageNum,
      scale,
    };

    try {
      await dbPut("annotations", pdfName, data);
    } catch (_) { /* ignore */ }
  }

  async function loadPersistedAnnotations() {
    if (!db || !pdfName) return;
    try {
      const data = await dbGet("annotations", pdfName);
      if (!data) return;

      // Restore last viewed page and scale
      if (data.pageNum) pageNum = Math.min(data.pageNum, totalPages);
      if (data.scale) {
        scale = data.scale;
        zoomLabel.textContent = `${Math.round((scale / 1.5) * 100)}%`;
      }

      // Restore music annotations
      if (data.musicAnnotations) {
        Object.assign(musicAnnotations, data.musicAnnotations);
      }

      // Restore drawing annotations (from data URLs back to ImageData)
      if (data.annotations) {
        const promises = Object.entries(data.annotations).map(([pg, dataUrl]) => {
          return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              const c = document.createElement("canvas");
              c.width = img.width;
              c.height = img.height;
              const ctx = c.getContext("2d");
              ctx.drawImage(img, 0, 0);
              annotations[pg] = ctx.getImageData(0, 0, c.width, c.height);
              resolve();
            };
            img.onerror = resolve;
            img.src = dataUrl;
          });
        });
        await Promise.all(promises);
      }
    } catch (_) { /* ignore */ }
  }

  // Auto-save annotations periodically and on page change
  let persistTimer = null;
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => persistAnnotations(), 2000);
  }

  // ── Library management ────────────────────────────────────────
  async function addToLibrary(name, bytes) {
    if (!db) return;
    try {
      await dbPut("library", null, {
        name,
        size: bytes.length,
        lastOpened: Date.now(),
        data: bytes,
      });
    } catch (_) { /* ignore */ }
  }

  async function renderLibrary() {
    const list = $("#library-list");
    if (!db) { list.innerHTML = '<p class="library-empty">Database not ready</p>'; return; }

    try {
      const items = await dbGetAll("library");
      if (items.length === 0) {
        list.innerHTML = '<p class="library-empty">No recent scores.<br>Open a PDF to get started.</p>';
        return;
      }

      items.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
      list.innerHTML = "";

      items.forEach((item) => {
        const div = document.createElement("div");
        div.className = "library-item";
        const dateStr = item.lastOpened
          ? new Date(item.lastOpened).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
          : "";
        const sizeStr = formatBytes(item.size || 0);
        div.innerHTML = `
          <span class="library-item-icon">🎼</span>
          <div class="library-item-info">
            <div class="library-item-name">${escapeHtml(item.name)}</div>
            <div class="library-item-meta">${sizeStr} · ${dateStr}</div>
          </div>
          <button class="library-item-delete" title="Remove">🗑️</button>
        `;

        div.querySelector(".library-item-info").addEventListener("click", async () => {
          $("#library-modal").classList.add("hidden");
          await loadPDF(new Uint8Array(item.data), item.name);
        });

        div.querySelector(".library-item-delete").addEventListener("click", async (e) => {
          e.stopPropagation();
          await dbDelete("library", item.name);
          await dbDelete("annotations", item.name);
          renderLibrary();
        });

        list.appendChild(div);
      });
    } catch (_) {
      list.innerHTML = '<p class="library-empty">Failed to load library</p>';
    }
  }

  // ── Render page ───────────────────────────────────────────────
  async function renderPageToCache(num) {
    if (!pdfDoc || pageCache[num + "_" + scale]) return;
    const page = await pdfDoc.getPage(num);
    const viewport = page.getViewport({ scale });
    const offCanvas = document.createElement("canvas");
    offCanvas.width = viewport.width;
    offCanvas.height = viewport.height;
    const offCtx = offCanvas.getContext("2d");
    await page.render({ canvasContext: offCtx, viewport }).promise;
    pageCache[num + "_" + scale] = offCanvas;
  }

  async function renderPage(num) {
    if (!pdfDoc) return;
    const cacheKey = num + "_" + scale;

    if (!pageCache[cacheKey]) {
      const page = await pdfDoc.getPage(num);
      const viewport = page.getViewport({ scale });
      const offCanvas = document.createElement("canvas");
      offCanvas.width = viewport.width;
      offCanvas.height = viewport.height;
      const offCtx = offCanvas.getContext("2d");
      await page.render({ canvasContext: offCtx, viewport }).promise;
      pageCache[cacheKey] = offCanvas;
    }

    const cached = pageCache[cacheKey];
    pdfCanvas.width  = cached.width;
    pdfCanvas.height = cached.height;
    annCanvas.width  = cached.width;
    annCanvas.height = cached.height;
    musicCanvas.width  = cached.width;
    musicCanvas.height = cached.height;

    pdfCtx.drawImage(cached, 0, 0);
    restorePageAnnotations();
    renderMusicSymbols();
    pageInfo.textContent = `${num} / ${totalPages}`;

    // Pre-cache adjacent pages
    if (num > 1) renderPageToCache(num - 1);
    if (num < totalPages) renderPageToCache(num + 1);
  }

  // ── Load PDF ──────────────────────────────────────────────────
  async function loadPDF(data, name) {
    pdfBytes = data;
    pdfName = name || "untitled.pdf";
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    totalPages = pdfDoc.numPages;
    pageNum = 1;
    Object.keys(annotations).forEach((k) => delete annotations[k]);
    Object.keys(undoStacks).forEach((k) => delete undoStacks[k]);
    Object.keys(musicAnnotations).forEach((k) => delete musicAnnotations[k]);
    Object.keys(musicUndoStacks).forEach((k) => delete musicUndoStacks[k]);
    Object.keys(pageCache).forEach((k) => delete pageCache[k]);

    wrapper.style.display = "block";
    dropZone.classList.add("hidden");
    docNameEl.textContent = pdfName;

    // Load persisted annotations (this may update pageNum/scale)
    await loadPersistedAnnotations();

    updateButtons();
    await renderPage(pageNum);

    // Wake lock
    acquireWakeLock();

    // Save to library
    await addToLibrary(pdfName, data);

    showToast(`Opened: ${pdfName} (${totalPages} pages)`);
  }

  // ── Navigation ────────────────────────────────────────────────
  function prevPage() {
    if (pageNum <= 1 || isNavigating) return;
    isNavigating = true;
    storePageAnnotations();
    pageNum--;
    renderPage(pageNum).then(() => { isNavigating = false; });
    updateButtons();
    schedulePersist();
  }

  function nextPage() {
    if (pageNum >= totalPages || isNavigating) return;
    isNavigating = true;
    storePageAnnotations();
    pageNum++;
    renderPage(pageNum).then(() => { isNavigating = false; });
    updateButtons();
    schedulePersist();
  }

  // ── Zoom ──────────────────────────────────────────────────────
  function clearPageCache() {
    Object.keys(pageCache).forEach((k) => delete pageCache[k]);
  }

  function zoomIn() {
    storePageAnnotations();
    scale = Math.min(+(scale + 0.1).toFixed(2), 5);
    clearPageCache();
    zoomLabel.textContent = `${Math.round((scale / 1.5) * 100)}%`;
    renderPage(pageNum);
  }

  function zoomOut() {
    storePageAnnotations();
    scale = Math.max(+(scale - 0.1).toFixed(2), 0.3);
    clearPageCache();
    zoomLabel.textContent = `${Math.round((scale / 1.5) * 100)}%`;
    renderPage(pageNum);
  }

  // ── Tool selection ────────────────────────────────────────────
  function setTool(name) {
    tool = tool === name ? "none" : name;
    document.querySelectorAll(".tool-btn").forEach((b) => b.classList.remove("active"));
    if (tool !== "none") {
      const map = {
        highlight: "#btn-highlight",
        underline: "#btn-underline",
        draw: "#btn-draw",
        text: "#btn-text",
        eraser: "#btn-eraser",
        music: "#btn-music",
      };
      $(map[tool])?.classList.add("active");
    }
    annCanvas.style.cursor =
      tool === "eraser" ? "none" : tool === "music" ? "copy" : tool === "none" ? "default" : "crosshair";

    // Show/hide music panel
    const panel = $("#music-panel");
    if (tool === "music") {
      panel.classList.remove("hidden");
    } else {
      panel.classList.add("hidden");
    }

    // Show/hide eraser cursor
    if (tool === "eraser") {
      eraserCursor.classList.remove("hidden");
      updateEraserCursorSize();
    } else {
      eraserCursor.classList.add("hidden");
    }
  }

  function updateEraserCursorSize() {
    const size = 20 * (scale / 1.5);
    const rect = annCanvas.getBoundingClientRect();
    const displaySize = size * (rect.width / annCanvas.width);
    eraserCursor.style.width = displaySize + "px";
    eraserCursor.style.height = displaySize + "px";
  }

  function updateButtons() {
    $("#btn-prev").disabled = pageNum <= 1;
    $("#btn-next").disabled = pageNum >= totalPages;
  }

  // ── Immersive Mode (hide toolbar) ─────────────────────────────
  function setImmersiveMode(on) {
    immersiveMode = on;
    if (on) {
      toolbar.classList.add("toolbar-hidden");
      document.body.classList.remove("toolbar-visible");
      $("#btn-immersive").classList.add("active");
      // Show a small floating button to exit immersive mode
      showImmersiveExitHint();
      showToast("Immersive mode — tap ☰ or center of page to show toolbar");
    } else {
      toolbar.classList.remove("toolbar-hidden");
      document.body.classList.add("toolbar-visible");
      $("#btn-immersive").classList.remove("active");
      hideImmersiveExitHint();
      updateToolbarHeight();
    }
  }

  // Floating exit button for immersive mode
  const immersiveExitBtn = document.createElement("button");
  immersiveExitBtn.id = "immersive-exit-btn";
  immersiveExitBtn.textContent = "☰";
  immersiveExitBtn.title = "Show toolbar";
  immersiveExitBtn.style.cssText = `
    position: fixed; top: 8px; right: 8px; z-index: 200;
    background: rgba(0,0,0,0.5); color: #ccc; border: 1px solid #555;
    border-radius: 8px; font-size: 1.2rem; padding: 6px 10px;
    cursor: pointer; display: none; backdrop-filter: blur(4px);
    transition: opacity 0.3s;
  `;
  immersiveExitBtn.addEventListener("click", () => setImmersiveMode(false));
  document.body.appendChild(immersiveExitBtn);

  function showImmersiveExitHint() {
    immersiveExitBtn.style.display = "block";
    // Fade it to subtle after 3 seconds
    setTimeout(() => { immersiveExitBtn.style.opacity = "0.3"; }, 3000);
    immersiveExitBtn.addEventListener("mouseenter", () => { immersiveExitBtn.style.opacity = "1"; });
    immersiveExitBtn.addEventListener("mouseleave", () => { immersiveExitBtn.style.opacity = "0.3"; });
  }

  function hideImmersiveExitHint() {
    immersiveExitBtn.style.display = "none";
    immersiveExitBtn.style.opacity = "1";
  }

  function updateToolbarHeight() {
    requestAnimationFrame(() => {
      const h = toolbar.offsetHeight;
      document.body.style.setProperty("--toolbar-h", h + "px");
    });
  }

  // Auto-hide toolbar after inactivity when in immersive mode
  function resetToolbarAutoHide() {
    clearTimeout(toolbarAutoHideTimer);
    if (immersiveMode && !toolbar.classList.contains("toolbar-hidden")) {
      toolbarAutoHideTimer = setTimeout(() => {
        toolbar.classList.add("toolbar-hidden");
        document.body.classList.remove("toolbar-visible");
      }, 4000);
    }
  }

  // Double-tap detection for showing toolbar in immersive mode
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  function handleDoubleTapCenter(e) {
    if (!immersiveMode || !pdfDoc) return false;
    const touch = e.changedTouches ? e.changedTouches[0] : e;
    const now = Date.now();
    const dx = Math.abs(touch.clientX - lastTapX);
    const dy = Math.abs(touch.clientY - lastTapY);

    if (now - lastTapTime < 350 && dx < 30 && dy < 30) {
      // Double-tap detected — check if it's in the center 50% of the screen
      const rect = annCanvas.getBoundingClientRect();
      const relX = (touch.clientX - rect.left) / rect.width;
      if (relX > 0.25 && relX < 0.75) {
        if (toolbar.classList.contains("toolbar-hidden")) {
          toolbar.classList.remove("toolbar-hidden");
          document.body.classList.add("toolbar-visible");
          updateToolbarHeight();
          resetToolbarAutoHide();
        } else {
          toolbar.classList.add("toolbar-hidden");
          document.body.classList.remove("toolbar-visible");
        }
        lastTapTime = 0;
        return true;
      }
    }

    lastTapTime = now;
    lastTapX = touch.clientX;
    lastTapY = touch.clientY;
    return false;
  }

  // ── Fullscreen ────────────────────────────────────────────────
  const btnFs = $("#btn-fullscreen");
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  }
  btnFs.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", () => {
    btnFs.textContent = document.fullscreenElement ? "⛶" : "⛶";
    btnFs.title = document.fullscreenElement ? "Exit full screen" : "Full screen";
    btnFs.classList.toggle("active-fs", !!document.fullscreenElement);
  });

  // ── Navigation feedback overlay ─────────────────────────────
  const navOverlay = document.createElement("div");
  navOverlay.id = "nav-overlay";
  wrapper.appendChild(navOverlay);

  function showNavFeedback(direction) {
    navOverlay.textContent = direction === "next" ? "▶" : "◀";
    navOverlay.className = "nav-flash nav-" + direction;
    clearTimeout(navOverlay._timer);
    navOverlay._timer = setTimeout(() => { navOverlay.className = ""; }, 350);
  }

  // ── Pointer helpers ───────────────────────────────────────────
  function getPos(e) {
    const rect = annCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (annCanvas.width / rect.width),
      y: (clientY - rect.top) * (annCanvas.height / rect.height),
    };
  }

  // ── Smooth drawing with quadratic curves ──────────────────────
  function smoothLineTo(ctx, points) {
    if (points.length < 2) return;
    if (points.length === 2) {
      ctx.lineTo(points[1].x, points[1].y);
      ctx.stroke();
      return;
    }
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    const midX = (prev.x + last.x) / 2;
    const midY = (prev.y + last.y) / 2;
    ctx.quadraticCurveTo(prev.x, prev.y, midX, midY);
    ctx.stroke();
  }

  // ── Inline text input ─────────────────────────────────────────
  let textInputPos = null;
  const textOverlay = $("#text-input-overlay");
  const textField   = $("#text-input-field");

  function showTextInput(canvasPos, screenX, screenY) {
    textInputPos = canvasPos;
    textField.value = "";
    textOverlay.classList.remove("hidden");
    textOverlay.style.left = Math.min(screenX, window.innerWidth - 220) + "px";
    textOverlay.style.top = Math.min(screenY, window.innerHeight - 100) + "px";
    setTimeout(() => textField.focus(), 50);
  }

  function commitTextInput() {
    if (!textInputPos || !textField.value.trim()) {
      textOverlay.classList.add("hidden");
      return;
    }
    saveAnnotationState();
    const fontSize = 16 * (scale / 1.5);
    annCtx.font = `${fontSize}px sans-serif`;
    annCtx.fillStyle = colorPicker.value;
    const lines = textField.value.split("\n");
    lines.forEach((line, i) => {
      annCtx.fillText(line, textInputPos.x, textInputPos.y + i * (fontSize * 1.3));
    });
    storePageAnnotations();
    schedulePersist();
    textOverlay.classList.add("hidden");
    textInputPos = null;
  }

  $("#text-input-ok").addEventListener("click", commitTextInput);
  $("#text-input-cancel").addEventListener("click", () => {
    textOverlay.classList.add("hidden");
    textInputPos = null;
  });
  textField.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitTextInput(); }
    if (e.key === "Escape") { textOverlay.classList.add("hidden"); textInputPos = null; }
    e.stopPropagation();
  });

  // ── Drawing / annotation logic ────────────────────────────────
  function getPenWidth() {
    return parseInt(penWidthEl.value, 10) || 3;
  }

  function onPointerDown(e) {
    if (!pdfDoc) return;

    // Track start position for navigation gestures
    const touch = e.touches ? e.touches[0] : e;
    navStartX = touch.clientX;
    navStartY = touch.clientY;
    navStartTime = Date.now();

    if (tool === "none") {
      if (e.cancelable) e.preventDefault();
      return;
    }

    // Music symbol placement mode
    if (tool === "music") {
      e.preventDefault();
      if (!selectedMusicSymbol) return;
      const pos = getPos(e);
      const px = pos.x / musicCanvas.width;
      const py = pos.y / musicCanvas.height;
      const color = $("#music-color").value;
      const fontSize = parseInt($("#music-size").value, 10);

      if (!musicAnnotations[pageNum]) musicAnnotations[pageNum] = [];
      if (!musicUndoStacks[pageNum]) musicUndoStacks[pageNum] = [];
      musicUndoStacks[pageNum].push(JSON.parse(JSON.stringify(musicAnnotations[pageNum])));
      if (musicUndoStacks[pageNum].length > 30) musicUndoStacks[pageNum].shift();

      musicAnnotations[pageNum].push({ symbol: selectedMusicSymbol, px, py, color, fontSize });
      renderMusicSymbols();
      schedulePersist();
      return;
    }

    e.preventDefault();
    const pos = getPos(e);

    // Text tool — use inline input instead of prompt()
    if (tool === "text") {
      const screenX = touch.clientX;
      const screenY = touch.clientY;
      showTextInput(pos, screenX, screenY);
      return;
    }

    drawing = true;
    currentPath = [pos];
    saveAnnotationState();

    const pw = getPenWidth();
    annCtx.lineCap = "round";
    annCtx.lineJoin = "round";

    if (tool === "eraser") {
      annCtx.globalCompositeOperation = "destination-out";
      annCtx.strokeStyle = "rgba(0,0,0,1)";
      annCtx.lineWidth = 20 * (scale / 1.5);
    } else if (tool === "highlight") {
      annCtx.globalCompositeOperation = "multiply";
      annCtx.strokeStyle = colorPicker.value;
      annCtx.lineWidth = 18 * (scale / 1.5);
      annCtx.globalAlpha = 0.35;
    } else if (tool === "underline") {
      annCtx.globalCompositeOperation = "source-over";
      annCtx.strokeStyle = colorPicker.value;
      annCtx.lineWidth = pw * (scale / 1.5);
    } else {
      annCtx.globalCompositeOperation = "source-over";
      annCtx.strokeStyle = colorPicker.value;
      annCtx.lineWidth = pw * (scale / 1.5);
    }

    annCtx.beginPath();
    annCtx.moveTo(pos.x, pos.y);
  }

  function onPointerMove(e) {
    // Update eraser cursor position
    if (tool === "eraser") {
      const touch = e.touches ? e.touches[0] : e;
      const size = parseInt(eraserCursor.style.width) || 20;
      eraserCursor.style.left = (touch.clientX - size / 2) + "px";
      eraserCursor.style.top = (touch.clientY - size / 2) + "px";
    }

    if (tool === "none" && e.cancelable) e.preventDefault();
    if (!drawing) return;
    e.preventDefault();
    const pos = getPos(e);
    currentPath.push(pos);

    if (tool === "underline") {
      const start = currentPath[0];
      annCtx.clearRect(0, 0, annCanvas.width, annCanvas.height);
      if (undoStacks[pageNum]?.length) {
        annCtx.putImageData(undoStacks[pageNum][undoStacks[pageNum].length - 1], 0, 0);
      }
      annCtx.globalCompositeOperation = "source-over";
      annCtx.strokeStyle = colorPicker.value;
      annCtx.lineWidth = getPenWidth() * (scale / 1.5);
      annCtx.beginPath();
      annCtx.moveTo(start.x, start.y);
      annCtx.lineTo(pos.x, start.y);
      annCtx.stroke();
    } else {
      // Use quadratic interpolation for smooth curves
      smoothLineTo(annCtx, currentPath);
    }
  }

  function onPointerUp(e) {
    // Handle toolbar toggle in immersive mode — single tap center of page
    if (tool === "none" && immersiveMode && pdfDoc) {
      const touch = e.changedTouches ? e.changedTouches[0] : e;
      const dx = touch.clientX - navStartX;
      const dy = touch.clientY - navStartY;
      const dt = Date.now() - navStartTime;
      const rect = annCanvas.getBoundingClientRect();
      const relX = (touch.clientX - rect.left) / rect.width;

      // Short tap in center 50% → toggle toolbar
      if (Math.abs(dx) < 15 && Math.abs(dy) < 15 && dt < 300 && relX > 0.25 && relX < 0.75) {
        if (toolbar.classList.contains("toolbar-hidden")) {
          toolbar.classList.remove("toolbar-hidden");
          document.body.classList.add("toolbar-visible");
          updateToolbarHeight();
          resetToolbarAutoHide();
        } else {
          toolbar.classList.add("toolbar-hidden");
          document.body.classList.remove("toolbar-visible");
        }
        return;
      }

      // Left/right tap zones and swipes still navigate pages
      if (e.cancelable) e.preventDefault();
      if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < SWIPE_TIME_LIMIT) {
        if (dx < 0) { nextPage(); showNavFeedback("next"); }
        else        { prevPage(); showNavFeedback("prev"); }
        return;
      }
      if (Math.abs(dx) < 15 && Math.abs(dy) < 15 && dt < 300) {
        if (relX >= 1 - TAP_ZONE_RATIO) { nextPage(); showNavFeedback("next"); }
        else if (relX <= TAP_ZONE_RATIO) { prevPage(); showNavFeedback("prev"); }
      }
      return;
    }

    // Handle navigation when no annotation tool is active (non-immersive)
    if (tool === "none" && pdfDoc) {
      if (e.cancelable) e.preventDefault();
      const touch = e.changedTouches ? e.changedTouches[0] : e;
      const dx = touch.clientX - navStartX;
      const dy = touch.clientY - navStartY;
      const dt = Date.now() - navStartTime;

      const rect = annCanvas.getBoundingClientRect();
      const relX = (touch.clientX - rect.left) / rect.width;

      if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < SWIPE_TIME_LIMIT) {
        if (dx < 0) { nextPage(); showNavFeedback("next"); }
        else        { prevPage(); showNavFeedback("prev"); }
        return;
      }

      if (Math.abs(dx) < 15 && Math.abs(dy) < 15 && dt < 300) {
        if (relX >= 1 - TAP_ZONE_RATIO) {
          nextPage(); showNavFeedback("next");
        } else if (relX <= TAP_ZONE_RATIO) {
          prevPage(); showNavFeedback("prev");
        }
      }
      return;
    }

    if (!drawing) return;
    drawing = false;
    annCtx.globalCompositeOperation = "source-over";
    annCtx.globalAlpha = 1;
    storePageAnnotations();
    schedulePersist();
  }

  // ── Undo ──────────────────────────────────────────────────────
  function undo() {
    if (tool === "music") {
      undoMusicSymbol();
      return;
    }
    const stack = undoStacks[pageNum];
    if (!stack || stack.length === 0) return;
    const prev = stack.pop();
    annCtx.putImageData(prev, 0, 0);
    storePageAnnotations();
    schedulePersist();
  }

  // ── Save: composite PDF page + annotations into downloadable image ──
  function saveAnnotated() {
    if (!pdfDoc) return;
    storePageAnnotations();

    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = pdfCanvas.width;
    tmpCanvas.height = pdfCanvas.height;
    const tmpCtx = tmpCanvas.getContext("2d");
    tmpCtx.drawImage(pdfCanvas, 0, 0);
    if (musicVisible) tmpCtx.drawImage(musicCanvas, 0, 0);
    tmpCtx.drawImage(annCanvas, 0, 0);

    const link = document.createElement("a");
    link.download = `annotated_page_${pageNum}.png`;
    link.href = tmpCanvas.toDataURL("image/png");
    link.click();
    showToast("Page saved as PNG");
  }

  // ── Music Symbol Rendering ────────────────────────────────────
  function renderMusicSymbols() {
    musicCtx.clearRect(0, 0, musicCanvas.width, musicCanvas.height);
    if (!musicVisible) return;
    const syms = musicAnnotations[pageNum];
    if (!syms || syms.length === 0) return;

    syms.forEach((s) => {
      const x = s.px * musicCanvas.width;
      const y = s.py * musicCanvas.height;
      const fs = s.fontSize * (scale / 1.5);
      musicCtx.font = `${fs}px "Segoe UI Symbol", "Noto Music", "DejaVu Sans", "Arial Unicode MS", sans-serif`;
      musicCtx.fillStyle = s.color;
      musicCtx.textAlign = "center";
      musicCtx.textBaseline = "middle";
      musicCtx.fillText(s.symbol, x, y);
    });
  }

  function undoMusicSymbol() {
    const stack = musicUndoStacks[pageNum];
    if (!stack || stack.length === 0) return;
    musicAnnotations[pageNum] = stack.pop();
    renderMusicSymbols();
    schedulePersist();
  }

  function toggleMusicVisibility() {
    musicVisible = !musicVisible;
    const btn = $("#btn-toggle-music");
    btn.classList.toggle("music-hidden", !musicVisible);
    btn.title = musicVisible ? "Hide music annotations" : "Show music annotations";
    renderMusicSymbols();
  }

  // ── Music Symbol Definitions ──────────────────────────────────
  const MUSIC_SYMBOLS = [
    { group: "Fingers", items: [
      { label: "1", symbol: "1" },
      { label: "2", symbol: "2" },
      { label: "3", symbol: "3" },
      { label: "4", symbol: "4" },
      { label: "5", symbol: "5" },
    ]},
    { group: "Accidentals", items: [
      { label: "♯", symbol: "♯" },
      { label: "♭", symbol: "♭" },
      { label: "♮", symbol: "♮" },
      { label: "𝄪", symbol: "𝄪" },
      { label: "𝄫", symbol: "𝄫" },
    ]},
    { group: "Dynamics", items: [
      { label: "ppp", symbol: "ppp" },
      { label: "pp", symbol: "pp" },
      { label: "p", symbol: "p" },
      { label: "mp", symbol: "mp" },
      { label: "mf", symbol: "mf" },
      { label: "f", symbol: "f" },
      { label: "ff", symbol: "ff" },
      { label: "fff", symbol: "fff" },
      { label: "sfz", symbol: "sfz" },
      { label: "fp", symbol: "fp" },
      { label: "cresc.", symbol: "cresc." },
      { label: "dim.", symbol: "dim." },
    ]},
    { group: "Tempo & Expression", items: [
      { label: "rit.", symbol: "rit." },
      { label: "accel.", symbol: "accel." },
      { label: "a tempo", symbol: "a tempo" },
      { label: "dolce", symbol: "dolce" },
      { label: "legato", symbol: "legato" },
      { label: "D.C.", symbol: "D.C." },
      { label: "D.S.", symbol: "D.S." },
      { label: "Fine", symbol: "Fine" },
      { label: "Coda 𝄌", symbol: "𝄌" },
      { label: "Segno 𝄋", symbol: "𝄋" },
    ]},
    { group: "Articulations & Ornaments", items: [
      { label: ".", symbol: "•" },
      { label: ">", symbol: ">" },
      { label: "^", symbol: "^" },
      { label: "~", symbol: "~" },
      { label: "𝄐", symbol: "𝄐" },
      { label: "tr", symbol: "tr" },
    ]},
    { group: "Bowing & Breath", items: [
      { label: "∨", symbol: "∨" },
      { label: "∏", symbol: "∏" },
      { label: ",", symbol: "," },
      { label: "//", symbol: "//" },
    ]},
    { group: "Pedal", items: [
      { label: "Ped.", symbol: "Ped." },
      { label: "*", symbol: "✱" },
    ]},
    { group: "Hairpins", items: [
      { label: "<", symbol: "〈" },
      { label: ">", symbol: "〉" },
    ]},
  ];

  // ── Build Music Symbol Picker ─────────────────────────────────
  function initMusicPanel() {
    const grid = $("#music-symbol-grid");
    const selectedLabel = $("#music-selected");
    const sizeSlider = $("#music-size");
    const sizeLabel = $("#music-size-label");

    MUSIC_SYMBOLS.forEach((group) => {
      const header = document.createElement("div");
      header.className = "music-sym-group";
      header.textContent = group.group;
      grid.appendChild(header);

      group.items.forEach((item) => {
        const btn = document.createElement("button");
        btn.className = "music-sym-btn";
        btn.type = "button";
        btn.title = item.label;
        if (item.symbol.length > 2) {
          const span = document.createElement("span");
          span.className = "sym-label";
          span.textContent = item.symbol;
          btn.appendChild(span);
        } else {
          btn.textContent = item.symbol;
        }

        btn.addEventListener("click", () => {
          document.querySelectorAll(".music-sym-btn").forEach((b) => b.classList.remove("selected"));
          btn.classList.add("selected");
          selectedMusicSymbol = item.symbol;
          selectedLabel.textContent = `Selected: ${item.label} — tap on the score to place`;
        });

        grid.appendChild(btn);
      });
    });

    sizeSlider.addEventListener("input", () => {
      sizeLabel.textContent = sizeSlider.value;
    });

    $("#music-panel-close").addEventListener("click", () => {
      setTool("none");
    });
  }

  initMusicPanel();

  // ── File open / drag-drop ─────────────────────────────────────
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => loadPDF(new Uint8Array(ev.target.result), file.name);
    reader.readAsArrayBuffer(file);
  });

  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file?.type === "application/pdf") {
      const reader = new FileReader();
      reader.onload = (ev) => loadPDF(new Uint8Array(ev.target.result), file.name);
      reader.readAsArrayBuffer(file);
    }
  });

  // ── Button wiring ─────────────────────────────────────────────
  $("#btn-open").addEventListener("click", () => fileInput.click());
  $("#btn-prev").addEventListener("click", prevPage);
  $("#btn-next").addEventListener("click", nextPage);
  $("#btn-zoom-in").addEventListener("click", zoomIn);
  $("#btn-zoom-out").addEventListener("click", zoomOut);
  $("#btn-highlight").addEventListener("click", () => setTool("highlight"));
  $("#btn-underline").addEventListener("click", () => setTool("underline"));
  $("#btn-draw").addEventListener("click", () => setTool("draw"));
  $("#btn-text").addEventListener("click", () => setTool("text"));
  $("#btn-eraser").addEventListener("click", () => setTool("eraser"));
  $("#btn-music").addEventListener("click", () => setTool("music"));
  $("#btn-toggle-music").addEventListener("click", toggleMusicVisibility);
  $("#btn-undo").addEventListener("click", undo);
  $("#btn-save").addEventListener("click", saveAnnotated);
  $("#btn-immersive").addEventListener("click", () => setImmersiveMode(!immersiveMode));

  // Library button
  $("#btn-library").addEventListener("click", () => {
    renderLibrary();
    $("#library-modal").classList.remove("hidden");
  });
  $("#library-close").addEventListener("click", () => {
    $("#library-modal").classList.add("hidden");
  });
  $("#library-modal").addEventListener("click", (e) => {
    if (e.target === $("#library-modal")) $("#library-modal").classList.add("hidden");
  });

  // ── Canvas events (mouse + touch) ─────────────────────────────
  annCanvas.addEventListener("mousedown", onPointerDown);
  annCanvas.addEventListener("mousemove", onPointerMove);
  annCanvas.addEventListener("mouseup", onPointerUp);
  annCanvas.addEventListener("mouseleave", onPointerUp);

  annCanvas.addEventListener("touchstart", onPointerDown, { passive: false });
  annCanvas.addEventListener("touchmove", onPointerMove, { passive: false });
  annCanvas.addEventListener("touchend", onPointerUp, { passive: false });
  annCanvas.addEventListener("touchcancel", onPointerUp);

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.target === textField) return; // don't intercept text input
    if (e.ctrlKey && e.key === "z") { undo(); e.preventDefault(); }
    if (e.key === "ArrowLeft") prevPage();
    if (e.key === "ArrowRight") nextPage();
    if (e.key === "Escape" && immersiveMode) setImmersiveMode(false);
    if (e.key === "f" && !e.ctrlKey && !e.altKey) toggleFullscreen();
  });

  // ── Persist on page unload ────────────────────────────────────
  window.addEventListener("beforeunload", () => {
    if (pdfDoc) persistAnnotations();
    releaseWakeLock();
  });

  // ── Google Drive Integration ──────────────────────────────────
  const GDRIVE_CLIENT_ID = "339204074130-vucvvbpvlipuqak9f0h4m7b8876solrg.apps.googleusercontent.com";
  const GDRIVE_SCOPES = "https://www.googleapis.com/auth/drive.readonly";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";

  let gdriveToken = null;
  let gdriveFolderStack = [];

  const gdriveModal  = $("#gdrive-modal");
  const gdriveTitle  = $("#gdrive-title");
  const gdriveStatus = $("#gdrive-status");
  const gdriveBread  = $("#gdrive-breadcrumb");
  const gdriveList   = $("#gdrive-file-list");

  function gdriveAuth() {
    if (typeof google === "undefined" || !google.accounts) {
      gdriveStatus.textContent = "⏳ Google API loading, please wait...";
      gdriveModal.classList.remove("hidden");
      setTimeout(gdriveAuth, 1000);
      return;
    }

    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GDRIVE_CLIENT_ID,
      scope: GDRIVE_SCOPES,
      callback: (response) => {
        if (response.error) {
          gdriveStatus.textContent = "❌ Auth failed: " + response.error;
          return;
        }
        gdriveToken = response.access_token;
        gdriveStatus.textContent = "";
        gdriveTitle.textContent = "Google Drive";
        gdriveFolderStack = [{ id: "root", name: "My Drive" }];
        gdriveListFiles("root");
      },
    });

    gdriveModal.classList.remove("hidden");
    gdriveStatus.textContent = "🔑 Signing in...";
    tokenClient.requestAccessToken();
  }

  async function gdriveListFiles(folderId) {
    gdriveList.innerHTML = '<p class="gdrive-loading">Loading...</p>';
    updateBreadcrumb();

    const query = `'${folderId}' in parents and trashed = false and (mimeType = 'application/pdf' or mimeType = 'application/vnd.google-apps.folder')`;
    const fields = "files(id,name,mimeType,iconLink,modifiedTime,size)";
    const orderBy = "folder,name";

    try {
      const res = await fetch(
        `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&orderBy=${encodeURIComponent(orderBy)}&pageSize=100`,
        { headers: { Authorization: `Bearer ${gdriveToken}` } }
      );

      if (res.status === 401) {
        gdriveToken = null;
        gdriveStatus.textContent = "⚠️ Session expired. Click ☁️ to reconnect.";
        gdriveList.innerHTML = "";
        return;
      }

      const data = await res.json();
      if (data.error) {
        gdriveList.innerHTML = `<p class="gdrive-error">API Error: ${data.error.message} (${data.error.code})</p>`;
        return;
      }

      renderFileList(data.files || []);
    } catch (err) {
      gdriveList.innerHTML = `<p class="gdrive-error">Error: ${err.message}</p>`;
    }
  }

  function renderFileList(files) {
    gdriveList.innerHTML = "";
    if (files.length === 0) {
      gdriveList.innerHTML = '<p class="gdrive-empty">No PDFs or sub-folders here.</p>';
      return;
    }

    files.forEach((file) => {
      const isFolder = file.mimeType === "application/vnd.google-apps.folder";
      const item = document.createElement("div");
      item.className = "gdrive-item" + (isFolder ? " gdrive-folder" : " gdrive-pdf");

      const icon = isFolder ? "📁" : "📄";
      const sizeStr = file.size ? ` (${formatBytes(file.size)})` : "";

      item.innerHTML = `
        <span class="gdrive-icon">${icon}</span>
        <span class="gdrive-name">${escapeHtml(file.name)}${sizeStr}</span>
      `;

      item.addEventListener("click", () => {
        if (isFolder) {
          gdriveFolderStack.push({ id: file.id, name: file.name });
          gdriveListFiles(file.id);
        } else {
          gdriveOpenPdf(file.id, file.name);
        }
      });

      gdriveList.appendChild(item);
    });
  }

  function updateBreadcrumb() {
    gdriveBread.innerHTML = "";
    gdriveFolderStack.forEach((folder, i) => {
      const span = document.createElement("span");
      span.className = "gdrive-crumb";
      span.textContent = folder.name;
      if (i < gdriveFolderStack.length - 1) {
        span.addEventListener("click", () => {
          gdriveFolderStack = gdriveFolderStack.slice(0, i + 1);
          gdriveListFiles(folder.id);
        });
      } else {
        span.classList.add("current");
      }
      gdriveBread.appendChild(span);
      if (i < gdriveFolderStack.length - 1) {
        const sep = document.createElement("span");
        sep.className = "gdrive-crumb-sep";
        sep.textContent = " › ";
        gdriveBread.appendChild(sep);
      }
    });
  }

  async function gdriveOpenPdf(fileId, fileName) {
    gdriveStatus.textContent = `⏳ Loading "${fileName}"...`;

    try {
      const res = await fetch(
        `${DRIVE_API}/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${gdriveToken}` } }
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();

      gdriveModal.classList.add("hidden");
      gdriveStatus.textContent = "";
      await loadPDF(new Uint8Array(buf), fileName);
    } catch (err) {
      gdriveStatus.textContent = `❌ Failed to load: ${err.message}`;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────
  function formatBytes(bytes) {
    bytes = parseInt(bytes, 10);
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // ── Drive UI wiring ──────────────────────────────────────────
  $("#btn-gdrive").addEventListener("click", () => {
    if (gdriveToken) {
      gdriveModal.classList.remove("hidden");
      gdriveFolderStack = [{ id: "root", name: "My Drive" }];
      gdriveListFiles("root");
    } else {
      gdriveAuth();
    }
  });

  $("#gdrive-close").addEventListener("click", () => {
    gdriveModal.classList.add("hidden");
  });

  gdriveModal.addEventListener("click", (e) => {
    if (e.target === gdriveModal) gdriveModal.classList.add("hidden");
  });

  // ── Service Worker Registration (PWA) ─────────────────────────
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // ── Initialization ────────────────────────────────────────────
  async function init() {
    await openDB();
    document.body.classList.add("toolbar-visible");
    updateToolbarHeight();
    window.addEventListener("resize", updateToolbarHeight);
  }

  init();
})();
