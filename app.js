(() => {
  "use strict";

  // ── PDF.js setup ──────────────────────────────────────────────
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  // ── DOM refs ──────────────────────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const fileInput   = $("#file-input");
  const pdfCanvas   = $("#pdf-canvas");
  const annCanvas   = $("#annotation-canvas");
  const musicCanvas = $("#music-canvas");
  const pdfCtx      = pdfCanvas.getContext("2d");
  const annCtx      = annCanvas.getContext("2d");
  const musicCtx    = musicCanvas.getContext("2d");
  const wrapper     = $("#canvas-wrapper");
  const dropZone    = $("#drop-zone");
  const pageInfo    = $("#page-info");
  const zoomLabel   = $("#zoom-level");
  const colorPicker = $("#color-picker");

  // ── State ─────────────────────────────────────────────────────
  let pdfDoc     = null;
  let pageNum    = 1;
  let totalPages = 0;
  let scale      = 1.5;
  let tool       = "none"; // highlight | underline | draw | text | eraser | music | none
  let drawing    = false;
  let currentPath = [];

  // Music annotation state
  let selectedMusicSymbol = null;  // current symbol to place
  let musicAnnotations = {};       // { [pageNum]: [{symbol,px,py,color,fontSize}] }
  let musicVisible = true;         // toggle music layer visibility
  let musicUndoStacks = {};        // undo stacks for music symbols per page

  // Navigation gesture tracking (sheet music mode)
  let navStartX = 0;
  let navStartY = 0;
  let navStartTime = 0;
  let isNavigating = false; // debounce flag to prevent double-flips
  const SWIPE_THRESHOLD = 80;   // min px horizontal movement (raised for tablet)
  const SWIPE_TIME_LIMIT = 400; // max ms for a swipe
  const TAP_ZONE_RATIO = 0.25;  // left/right 25% of page

  // Page render cache for fast navigation
  const pageCache = {};

  // Per-page annotation layers stored as ImageData
  const annotations = {};
  // Undo stacks per page
  const undoStacks = {};

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

  // ── Render page ───────────────────────────────────────────────
  async function renderPageToCache(num) {
    if (!pdfDoc || pageCache[num + '_' + scale]) return;
    const page = await pdfDoc.getPage(num);
    const viewport = page.getViewport({ scale });
    const offCanvas = document.createElement('canvas');
    offCanvas.width = viewport.width;
    offCanvas.height = viewport.height;
    const offCtx = offCanvas.getContext('2d');
    await page.render({ canvasContext: offCtx, viewport }).promise;
    pageCache[num + '_' + scale] = offCanvas;
  }

  async function renderPage(num) {
    if (!pdfDoc) return;
    const cacheKey = num + '_' + scale;

    // Render to cache if not already there
    if (!pageCache[cacheKey]) {
      const page = await pdfDoc.getPage(num);
      const viewport = page.getViewport({ scale });
      const offCanvas = document.createElement('canvas');
      offCanvas.width = viewport.width;
      offCanvas.height = viewport.height;
      const offCtx = offCanvas.getContext('2d');
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

    // Pre-cache adjacent pages in background
    if (num > 1) renderPageToCache(num - 1);
    if (num < totalPages) renderPageToCache(num + 1);
  }

  // ── Load PDF ──────────────────────────────────────────────────
  async function loadPDF(data) {
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    totalPages = pdfDoc.numPages;
    pageNum = 1;
    Object.keys(annotations).forEach((k) => delete annotations[k]);
    Object.keys(undoStacks).forEach((k) => delete undoStacks[k]);
    Object.keys(musicAnnotations).forEach((k) => delete musicAnnotations[k]);
    Object.keys(musicUndoStacks).forEach((k) => delete musicUndoStacks[k]);

    wrapper.style.display = "block";
    dropZone.classList.add("hidden");
    updateButtons();
    await renderPage(pageNum);
  }

  // ── Navigation ────────────────────────────────────────────────
  function prevPage() {
    if (pageNum <= 1 || isNavigating) return;
    isNavigating = true;
    storePageAnnotations();
    pageNum--;
    renderPage(pageNum).then(() => { isNavigating = false; });
    updateButtons();
  }

  function nextPage() {
    if (pageNum >= totalPages || isNavigating) return;
    isNavigating = true;
    storePageAnnotations();
    pageNum++;
    renderPage(pageNum).then(() => { isNavigating = false; });
    updateButtons();
  }

  // ── Zoom ──────────────────────────────────────────────────────
  function clearPageCache() {
    Object.keys(pageCache).forEach(k => delete pageCache[k]);
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
      tool === "eraser" ? "cell" : tool === "music" ? "copy" : tool === "none" ? "default" : "crosshair";

    // Show/hide music panel
    const panel = $("#music-panel");
    if (tool === "music") {
      panel.classList.remove("hidden");
    } else {
      panel.classList.add("hidden");
    }
  }

  function updateButtons() {
    $("#btn-prev").disabled = pageNum <= 1;
    $("#btn-next").disabled = pageNum >= totalPages;
  }

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

  // ── Drawing / annotation logic ────────────────────────────────
  function onPointerDown(e) {
    if (!pdfDoc) return;

    // Track start position for navigation gestures
    const touch = e.touches ? e.touches[0] : e;
    navStartX = touch.clientX;
    navStartY = touch.clientY;
    navStartTime = Date.now();

    if (tool === "none") {
      // Prevent default to stop browser scroll/zoom during navigation
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
      // Save undo state
      musicUndoStacks[pageNum].push(JSON.parse(JSON.stringify(musicAnnotations[pageNum])));
      if (musicUndoStacks[pageNum].length > 30) musicUndoStacks[pageNum].shift();

      musicAnnotations[pageNum].push({ symbol: selectedMusicSymbol, px, py, color, fontSize });
      renderMusicSymbols();
      return;
    }

    e.preventDefault();
    drawing = true;
    const pos = getPos(e);
    currentPath = [pos];

    if (tool === "text") {
      drawing = false;
      const note = prompt("Enter note:");
      if (!note) return;
      saveAnnotationState();
      annCtx.font = `${16 * (scale / 1.5)}px sans-serif`;
      annCtx.fillStyle = colorPicker.value;
      annCtx.fillText(note, pos.x, pos.y);
      storePageAnnotations();
      return;
    }

    saveAnnotationState();

    annCtx.lineWidth = tool === "eraser" ? 20 * (scale / 1.5) : 3 * (scale / 1.5);
    annCtx.lineCap = "round";
    annCtx.lineJoin = "round";

    if (tool === "eraser") {
      annCtx.globalCompositeOperation = "destination-out";
      annCtx.strokeStyle = "rgba(0,0,0,1)";
    } else if (tool === "highlight") {
      annCtx.globalCompositeOperation = "multiply";
      annCtx.strokeStyle = colorPicker.value;
      annCtx.lineWidth = 18 * (scale / 1.5);
      annCtx.globalAlpha = 0.35;
    } else if (tool === "underline") {
      annCtx.globalCompositeOperation = "source-over";
      annCtx.strokeStyle = colorPicker.value;
      annCtx.lineWidth = 2 * (scale / 1.5);
    } else {
      annCtx.globalCompositeOperation = "source-over";
      annCtx.strokeStyle = colorPicker.value;
    }

    annCtx.beginPath();
    annCtx.moveTo(pos.x, pos.y);
  }

  function onPointerMove(e) {
    // Prevent browser scroll/zoom on touch during navigation mode
    if (tool === "none" && e.cancelable) e.preventDefault();
    if (!drawing) return;
    e.preventDefault();
    const pos = getPos(e);
    currentPath.push(pos);

    if (tool === "underline") {
      // draw a straight horizontal line from start
      const start = currentPath[0];
      annCtx.clearRect(0, 0, annCanvas.width, annCanvas.height);
      if (undoStacks[pageNum]?.length) {
        annCtx.putImageData(undoStacks[pageNum][undoStacks[pageNum].length - 1], 0, 0);
      }
      annCtx.globalCompositeOperation = "source-over";
      annCtx.strokeStyle = colorPicker.value;
      annCtx.lineWidth = 2 * (scale / 1.5);
      annCtx.beginPath();
      annCtx.moveTo(start.x, start.y);
      annCtx.lineTo(pos.x, start.y);
      annCtx.stroke();
    } else {
      annCtx.lineTo(pos.x, pos.y);
      annCtx.stroke();
    }
  }

  function onPointerUp(e) {
    // Handle navigation when no annotation tool is active
    if (tool === "none" && pdfDoc) {
      if (e.cancelable) e.preventDefault();
      const touch = e.changedTouches ? e.changedTouches[0] : e;
      const dx = touch.clientX - navStartX;
      const dy = touch.clientY - navStartY;
      const dt = Date.now() - navStartTime;

      const rect = annCanvas.getBoundingClientRect();
      const relX = (touch.clientX - rect.left) / rect.width;

      // Swipe detection (horizontal swipe, must exceed threshold)
      if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < SWIPE_TIME_LIMIT) {
        if (dx < 0) { nextPage(); showNavFeedback("next"); }
        else        { prevPage(); showNavFeedback("prev"); }
        return;
      }

      // Tap zone detection (short tap, minimal movement)
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
        // Use smaller font for text-based symbols
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
    reader.onload = (ev) => loadPDF(new Uint8Array(ev.target.result));
    reader.readAsArrayBuffer(file);
  });

  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file?.type === "application/pdf") {
      const reader = new FileReader();
      reader.onload = (ev) => loadPDF(new Uint8Array(ev.target.result));
      reader.readAsArrayBuffer(file);
    }
  });

  // ── Button wiring ─────────────────────────────────────────────
  $("#btn-open").addEventListener("click", () => fileInput.click());
  $("#btn-prev").addEventListener("click", prevPage);
  $("#btn-next").addEventListener("click", nextPage);
  $("#btn-zoom-in").addEventListener("click", zoomIn);
  $("#btn-zoom-out").addEventListener("click", zoomOut);

  // ── Fullscreen ─────────────────────────────────────────────
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
  $("#btn-highlight").addEventListener("click", () => setTool("highlight"));
  $("#btn-underline").addEventListener("click", () => setTool("underline"));
  $("#btn-draw").addEventListener("click", () => setTool("draw"));
  $("#btn-text").addEventListener("click", () => setTool("text"));
  $("#btn-eraser").addEventListener("click", () => setTool("eraser"));
  $("#btn-music").addEventListener("click", () => setTool("music"));
  $("#btn-toggle-music").addEventListener("click", toggleMusicVisibility);
  $("#btn-undo").addEventListener("click", undo);
  $("#btn-save").addEventListener("click", saveAnnotated);

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
    if (e.ctrlKey && e.key === "z") { undo(); e.preventDefault(); }
    if (e.key === "ArrowLeft")  prevPage();
    if (e.key === "ArrowRight") nextPage();
  });

  // ── Google Drive Integration (read-only, folder browser) ────────
  const GDRIVE_CLIENT_ID = "339204074130-vucvvbpvlipuqak9f0h4m7b8876solrg.apps.googleusercontent.com";
  const GDRIVE_SCOPES = "https://www.googleapis.com/auth/drive.readonly";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";

  let gdriveToken = null;
  let gdriveFolderStack = [];

  const gdriveModal   = $("#gdrive-modal");
  const gdriveTitle   = $("#gdrive-title");
  const gdriveStatus  = $("#gdrive-status");
  const gdriveBread   = $("#gdrive-breadcrumb");
  const gdriveList    = $("#gdrive-file-list");

  // ── OAuth: request token via Google Identity Services ─────────
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

  // ── List files in a folder ────────────────────────────────────
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

  // ── Render file/folder list ───────────────────────────────────
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

  // ── Breadcrumb navigation ─────────────────────────────────────
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

  // ── Download and open a PDF from Drive ────────────────────────
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
      await loadPDF(new Uint8Array(buf));
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
})();
