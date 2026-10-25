// ---- DOM refs ----
const form = document.getElementById("upload-form");
const logoInput = document.getElementById("logo");
const logoLabel = document.getElementById("logo-label");
const logoSizeSelect = document.getElementById("logo_size");
const uploadArea = document.getElementById("upload-area");
const uploadContent = document.getElementById("upload-content");
const logoQueueEl = document.getElementById("logo-queue");
const slotCounterEl = document.getElementById("slot-counter");
const downloadZipBtn = document.getElementById("download-zip-btn");
const downloadPdfBtn = document.getElementById("download-pdf-btn");
const projectNameInput = document.getElementById("project_name");
const status = document.getElementById("status");
const outputSize = document.getElementById("output_size");
const bleedSelect = document.getElementById("bleed");
const layoutMode = document.getElementById("layout_mode");
const gapInput = document.getElementById("gap");
const gapGroup = document.getElementById("gap-group");
const gapFit = document.getElementById("gap-fit");
const bleedGroup = document.getElementById("bleed-group");
const bleedNote = document.getElementById("bleed-note");
const serviceSelect = document.getElementById("print_service");
const serviceFindings = document.getElementById("service-findings");
const serviceSummary = document.getElementById("service-summary");
const serviceFormat = document.getElementById("service-format");
const serviceNotes = document.getElementById("service-notes");
const outlineToggles = document.getElementById("outline-toggles");
const viewport = document.getElementById("preview-viewport");
const previewTransform = document.getElementById("preview-transform");
const showLogoOutline = document.getElementById("show-logo-outline");
const showBleedOutline = document.getElementById("show-bleed-outline");
const zoomInBtn = document.getElementById("zoom-in");
const zoomOutBtn = document.getElementById("zoom-out");
const zoomFitBtn = document.getElementById("zoom-fit");
const zoomLevel = document.getElementById("zoom-level");

// ---- Logo size labels ----
const SIZE_LABELS = {
    "3x3": 'Logos (3x3" PNG or JPEG)',
    "3.25x1.75": 'Logos (3.25x1.75" PNG or JPEG)',
};

// ---- Template dimensions ----
// Geometry lives in templates.js, generated from assets/templates.json and
// shared with core/generator.py, so the two renderers cannot drift apart.
// Aliased here so the editor keeps using its original short name.
const EDITOR_TEMPLATES = SHEET_TEMPLATES;

// ---- Logo queue state ----
let nextLogoId = 0;
let logoQueue = [];
// Each entry: { id, file, objectUrl, editorState: {scale, offsetX, offsetY, textOverlay},
//               quantity, validation, cachedMeta, variableData }

// The selected bleed in whole pixels, the unit the renderer works in.
function currentBleedPx() {
    return Place.pyRound(parseFloat(bleedSelect.value) * SHEET_CANVAS.dpi);
}

function isPacked() {
    return layoutMode.value === "packed";
}

function gapInches() {
    const v = parseFloat(gapInput.value);
    return Number.isFinite(v) && v >= 0 ? v : 0;
}

// The packed grid for the current settings, or null when nothing fits.
function currentPackedGrid() {
    const gapPx = Place.pyRound(gapInches() * SHEET_CANVAS.dpi);
    return SheetRender.packedGrid(SHEET_TEMPLATES[logoSizeSelect.value], gapPx);
}

function getMaxSlots() {
    if (isPacked()) {
        const grid = currentPackedGrid();
        return grid ? grid.per_sheet : 0;
    }
    return EDITOR_TEMPLATES[logoSizeSelect.value].max_slots;
}

// Swap the bleed and gap controls, and show how many fit per sheet.
function syncLayoutControls() {
    const packed = isPacked();
    // Gap takes bleed's place in the row rather than sitting beside it: three
    // controls do not fit, and bleed means nothing in this layout anyway.
    gapGroup.hidden = !packed;
    gapFit.hidden = !packed;
    bleedNote.hidden = !packed;
    bleedGroup.hidden = packed;
    bleedSelect.disabled = packed;
    // Those outlines mark jig slots, so they do nothing in the packed layout.
    outlineToggles.hidden = packed;

    // The per-sheet counts baked into the Logo Size labels are the jig's. In
    // packed mode they are wrong, and would contradict the fit readout below.
    for (const opt of logoSizeSelect.options) {
        const tmpl = SHEET_TEMPLATES[opt.value];
        // Strip any trailing "(... per sheet)" so this is safe to re-run.
        const base = opt.textContent.replace(/\s*\([^)]*\)\s*$/, "");
        if (packed) {
            const gapPx = Place.pyRound(gapInches() * SHEET_CANVAS.dpi);
            const g = SheetRender.packedGrid(tmpl, gapPx);
            opt.textContent = g
                ? `${base} (${g.per_sheet} per sheet)`
                : `${base} (does not fit)`;
        } else {
            opt.textContent = `${base} (${tmpl.max_slots} per sheet)`;
        }
    }

    if (!packed) return;

    const grid = currentPackedGrid();
    if (!grid) {
        gapFit.textContent =
            `A ${gapInches()}" gap leaves no room for a logo this size.`;
        gapFit.classList.add("warn");
        return;
    }
    gapFit.classList.remove("warn");
    gapFit.textContent =
        `${grid.per_sheet} per sheet — ${grid.cols} x ${grid.rows} per jig half`
        + (grid.turned ? ", turned sideways to fit more" : "");
}

function getTotalQuantity() {
    return logoQueue.reduce((sum, e) => sum + e.quantity, 0);
}

function getRemainingSlots() {
    return getMaxSlots() - getTotalQuantity();
}

function getSheetCount() {
    const total = getTotalQuantity();
    const perSheet = getMaxSlots();
    return Math.max(1, Math.ceil(total / perSheet));
}

function canGenerate() {
    if (logoQueue.length === 0) return false;
    if (getTotalQuantity() < 1) return false;
    if (logoQueue.some(e => e.validation?.hasErrors)) return false;
    // Variable data validation
    if (logoQueue.some(e => {
        if (e.editorState.textOverlay?.enabled) {
            if (!e.variableData || e.variableData.length !== e.quantity) return true;
        }
        return false;
    })) return false;
    if (typeof Precheck !== "undefined" && currentPrecheck().blocked) return false;
    return true;
}

function getEntry(id) {
    return logoQueue.find(e => e.id === id);
}

// ---- Image normalization / background compositing ----
// Decode a blob/object URL into an <img>. Rejects if the browser can't render it.
function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("decode failed"));
        img.src = url;
    });
}

// Render a decoded image to a fresh PNG blob at its native size, optionally
// compositing over a solid background color (null = keep transparency).
// Re-encoding through the canvas guarantees a PNG the server (Pillow) can open,
// even if the original was a WebP/AVIF/exotic format the browser accepted.
function rasterizeToPngBlob(img, background) {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0);
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("canvas export failed"))),
            "image/png"
        );
    });
}

// Normalize entry.file to a clean transparent PNG from its decoded original.
// The background color is NOT baked in here — it's applied server-side as a full
// slot fill at placement time, so the logo image itself stays transparent.
// Keeps entry.objectUrl in sync (revokes the old one) so thumbnails/preview update.
async function composeLogoFile(entry) {
    if (!entry.originalImage) return;
    const blob = await rasterizeToPngBlob(entry.originalImage, null);
    const baseName = (entry.file.name || "logo").replace(/\.[^.]+$/, "") || "logo";
    const newFile = new File([blob], baseName + ".png", { type: "image/png" });
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    entry.file = newFile;
    entry.objectUrl = URL.createObjectURL(newFile);
}

// ---- Queue manipulation ----
async function addLogo(file) {
    const entry = {
        id: nextLogoId++,
        file: file,
        objectUrl: URL.createObjectURL(file),
        editorState: { scale: 1.0, offsetX: 0, offsetY: 0, rotation: 0, textOverlay: null, background: null },
        quantity: 1,
        validation: null,
        cachedMeta: null,
        variableData: null,
        // "Same text on every label" mode: sameTextValue holds the one value the
        // user typed, and variableData is kept filled with copies of it, so the
        // rest of the app needs no special case for it.
        sameTextForAll: false,
        sameTextValue: "",
        originalImage: null,
    };
    logoQueue.push(entry);
    renderQueue();
    updateSlotCounter();
    updateDownloadBtn();

    // Decode + normalize to a clean PNG so the server can always read it, and so
    // per-logo background compositing has a lossless source to work from.
    let decodeFailed = false;
    try {
        entry.originalImage = await loadImageFromUrl(entry.objectUrl);
        await composeLogoFile(entry);
    } catch (e) {
        decodeFailed = true;
    }

    // Validate asynchronously (against the normalized file)
    const tmpl = EDITOR_TEMPLATES[logoSizeSelect.value];
    const { result, meta } = await validateLogoStateless(entry.file, { w: tmpl.logo_w, h: tmpl.logo_h });
    if (decodeFailed) {
        result.fileType = { status: "red", msg: "Can't read this image — re-export as PNG or JPEG" };
        result.hasErrors = true;
    }
    entry.validation = result;
    entry.cachedMeta = meta;
    renderQueue();
    updateDownloadBtn();

    if (!result.hasErrors) {
        schedulePreview();
    }
}

function removeLogo(id) {
    const idx = logoQueue.findIndex(e => e.id === id);
    if (idx === -1) return;
    URL.revokeObjectURL(logoQueue[idx].objectUrl);
    logoQueue.splice(idx, 1);
    renderQueue();
    updateSlotCounter();
    updateDownloadBtn();
    renderVariableDataSection();
    if (logoQueue.length > 0) {
        schedulePreview();
    } else {
        loadTemplate();
    }
}

function updateQuantity(id, qty) {
    const entry = getEntry(id);
    if (!entry) return;
    qty = Math.max(1, qty);
    entry.quantity = qty;
    if (entry.sameTextForAll) applySameText(entry);
    renderQueue();
    updateSlotCounter();
    updateDownloadBtn();
    renderVariableDataSection();
    schedulePreview();
}

// ---- Queue rendering ----
function renderQueue() {
    if (logoQueue.length === 0) {
        logoQueueEl.innerHTML = "";
        return;
    }

    logoQueueEl.innerHTML = logoQueue.map(entry => {
        const hasError = entry.validation?.hasErrors;
        const errorClass = hasError ? " has-error" : "";
        const validationSummary = getValidationSummary(entry);

        return `<div class="queue-row${errorClass}" data-id="${entry.id}">
            <img class="queue-thumb" src="${entry.objectUrl}" alt="">
            <span class="queue-filename" title="${entry.file.name}">${entry.file.name}</span>
            <div class="queue-qty">
                <button type="button" class="btn-icon qty-minus" title="Decrease">-</button>
                <input type="number" class="qty-input" value="${entry.quantity}" min="1">
                <button type="button" class="btn-icon qty-plus" title="Increase">+</button>
            </div>
            <button type="button" class="btn-icon queue-edit" title="Edit placement">&#9998;</button>
            <button type="button" class="btn-icon queue-delete" title="Remove">&times;</button>
            ${validationSummary ? `<div class="queue-validation">${validationSummary}</div>` : ""}
        </div>`;
    }).join("");
}

// How sharp this logo will actually print.
//
// The old check compared the file's pixel dimensions against the nominal label
// size and stopped there, which was wrong in both directions: a logo scaled to
// 150% in the editor stayed "green" while printing at 200 DPI, and a logo whose
// shape simply differed from the label was flagged even when it would print at
// 325 DPI.
//
// What matters is the resolution it is actually printed at, which depends on
// the fit — bleed, scale, rotation and aspect ratio all move it. Place.fitMetrics
// is the same maths the renderer uses, so this cannot drift from reality.
const RES_SHARP = 270;   // at or above this, say nothing
const RES_SOFT = 200;    // between: a little soft; below: visibly fuzzy

function logoPrintResolution(entry) {
    const meta = entry.cachedMeta;
    if (!meta || !meta.width || !meta.height) return null;

    const tmpl = SHEET_TEMPLATES[logoSizeSelect.value];
    const bleedPx = isPacked()
        ? 0
        : Place.pyRound(parseFloat(bleedSelect.value) * SHEET_CANVAS.dpi);
    const st = entry.editorState;

    // prepareLogo rotates by -rotation before fitting, so measure the same box.
    const rot = Place.rotatedSize(meta.width, meta.height, -(st.rotation || 0));
    const fit = Place.fitMetrics(rot.w, rot.h, tmpl, bleedPx, { logoScale: st.scale });

    // Drawn at 300 DPI, so the ratio of source to drawn pixels is the real
    // resolution. The tighter of the two axes governs.
    const dpi = Math.round(SHEET_CANVAS.dpi
        * Math.min(rot.w / fit.scaledW, rot.h / fit.scaledH));

    return { dpi, neededW: fit.scaledW, neededH: fit.scaledH };
}

function resolutionBadge(entry) {
    const res = logoPrintResolution(entry);
    if (!res || res.dpi >= RES_SHARP) return null;
    const status = res.dpi >= RES_SOFT ? "yellow" : "red";
    const verdict = res.dpi >= RES_SOFT ? "slightly soft" : "will print fuzzy";
    return `<span class="val-badge ${status}">${res.dpi} DPI — ${verdict}.`
        + ` Supply ${res.neededW}×${res.neededH}</span>`;
}

function getValidationSummary(entry) {
    const issues = [];
    if (entry.validation) {
        // dimensions is deliberately not here: resolutionBadge() below judges
        // the same thing by what actually gets printed.
        const checks = [entry.validation.fileType, entry.validation.fileSize];
        for (const c of checks) {
            if (c && (c.status === "red" || c.status === "yellow")) {
                issues.push(`<span class="val-badge ${c.status}">${c.msg}</span>`);
            }
        }
    }
    const res = resolutionBadge(entry);
    if (res) issues.push(res);

    // Variable data mismatch warning
    if (entry.editorState.textOverlay?.enabled) {
        const have = entry.variableData ? entry.variableData.length : 0;
        const need = entry.quantity;
        if (have !== need) {
            issues.push(`<span class="val-badge red">Need ${need} values, have ${have}</span>`);
        }
    }
    return issues.join(" ");
}

// ---- Print-service check ----
//
// The sheet is checked against the chosen service's published limits before it
// can be downloaded. This exists because of a real order: a 22 x 24" sheet was
// uploaded to Transfer Express, silently scaled to 91.7% to fit their 22 x 22"
// maximum, and every 3" label printed at 2.75". Nothing in either tool said so.

const SERVICE_PREF_KEY = "heatpress.printService";

function loadServicePref() {
    try { return localStorage.getItem(SERVICE_PREF_KEY); } catch (e) { return null; }
}

function saveServicePref(id) {
    try { localStorage.setItem(SERVICE_PREF_KEY, id); } catch (e) { /* private mode */ }
}

function populateServices() {
    serviceSelect.innerHTML = Object.entries(PRINT_SERVICES)
        .map(([id, p]) => `<option value="${id}">${p.name}</option>`).join("");
    const saved = loadServicePref();
    serviceSelect.value = (saved && PRINT_SERVICES[saved]) ? saved : "custom";
}

function currentProfile() {
    return PRINT_SERVICES[serviceSelect.value] || null;
}

// The job as the checker wants it: sheet size in inches, label size in inches,
// and the real print resolution of every logo in the queue.
function precheckJob() {
    const tmpl = SHEET_TEMPLATES[logoSizeSelect.value];
    return {
        outputSize: outputSize.value,
        logoInches: tmpl
            ? { w: tmpl.logo_w / SHEET_CANVAS.dpi, h: tmpl.logo_h / SHEET_CANVAS.dpi }
            : null,
        logos: logoQueue.map(entry => {
            const res = logoPrintResolution(entry);
            return {
                name: entry.file.name,
                dpi: res ? res.dpi : null,
                neededW: res ? res.neededW : null,
                neededH: res ? res.neededH : null,
            };
        }),
    };
}

function currentPrecheck() {
    return Precheck.run(currentProfile(), precheckJob());
}

function renderServicePanel() {
    const profile = currentProfile();
    const result = currentPrecheck();

    const chips = result.summary.map(c =>
        `<span class="chk ${c.state}">${c.label}</span>`).join("");
    // Shown whenever there is something to report on, so a clean sheet reads as
    // "checked and fine" rather than as nothing having happened.
    serviceSummary.innerHTML = chips;
    serviceSummary.hidden = result.summary.length === 0;

    serviceFindings.innerHTML = result.findings.map(f => `
        <div class="finding ${f.level}">
            <div class="finding-title">${f.title}</div>
            <div class="finding-detail">${f.detail}</div>
            ${f.fix ? `<button type="button" class="btn-fix"
                data-setting="${f.fix.setting}" data-value="${f.fix.value}"
                >${f.fix.label}</button>` : ""}
        </div>`).join("");
    serviceFindings.hidden = result.findings.length === 0;

    const pref = result.prefersFormat;
    serviceFormat.innerHTML = pref ? `<strong>${pref.label}</strong> ${pref.reason}` : "";
    serviceFormat.hidden = !pref;
    downloadZipBtn.classList.toggle("preferred", !!pref && pref.format === "zip");
    downloadPdfBtn.classList.toggle("preferred", !!pref && pref.format === "pdf");

    const notes = (profile && profile.notes) || [];
    serviceNotes.querySelector("ul").innerHTML =
        notes.map(n => `<li>${n}</li>`).join("");
    serviceNotes.hidden = notes.length === 0;

    return result;
}

function updateSlotCounter() {
    const total = getTotalQuantity();
    const perSheet = getMaxSlots();
    if (!perSheet) {
        slotCounterEl.textContent = "No logos fit at this gap";
        slotCounterEl.classList.remove("at-capacity");
        return;
    }
    const sheets = Math.ceil(total / perSheet) || 0;
    if (sheets <= 1) {
        slotCounterEl.textContent = `${total} / ${perSheet} slots used`;
    } else {
        const totalSlots = sheets * perSheet;
        slotCounterEl.textContent = `${total} / ${totalSlots} slots (${sheets} sheets)`;
    }
    slotCounterEl.classList.remove("over-capacity");
    slotCounterEl.classList.toggle("at-capacity", total > 0);
}

function sheetCount() {
    const perSheet = getMaxSlots();
    if (!perSheet) return 0;
    return Math.ceil(getTotalQuantity() / perSheet);
}

function updateDownloadBtn() {
    renderServicePanel();
    downloadZipBtn.textContent = sheetCount() > 1
        ? "Download PNGs (ZIP)"
        : "Download PNG";
    const ok = canGenerate();
    downloadZipBtn.disabled = !ok;
    downloadPdfBtn.disabled = !ok;
}

// ---- Event delegation for queue ----
logoQueueEl.addEventListener("click", (e) => {
    const row = e.target.closest(".queue-row");
    if (!row) return;
    const id = parseInt(row.dataset.id);

    if (e.target.closest(".queue-delete")) {
        removeLogo(id);
    } else if (e.target.closest(".queue-edit")) {
        openEditorFor(id);
    } else if (e.target.closest(".qty-minus")) {
        const entry = getEntry(id);
        if (entry) updateQuantity(id, entry.quantity - 1);
    } else if (e.target.closest(".qty-plus")) {
        const entry = getEntry(id);
        if (entry) updateQuantity(id, entry.quantity + 1);
    }
});

logoQueueEl.addEventListener("change", (e) => {
    if (e.target.classList.contains("qty-input")) {
        const row = e.target.closest(".queue-row");
        if (!row) return;
        const id = parseInt(row.dataset.id);
        updateQuantity(id, parseInt(e.target.value) || 1);
    }
});

// ---- Preview state ----
let scale = 1;
let panX = 0;
let panY = 0;
let imgW = 0;  // total width of all sheets side by side
let imgH = 0;
let singleSheetW = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panOriginX = 0;
let panOriginY = 0;
let currentSheetCount = 1;
const SHEET_GAP = 20;  // px gap between sheets in preview

// ---- Debounced auto-preview ----
let previewDebounceTimer = null;
let previewToken = 0;

function schedulePreview() {
    if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(generatePreview, 500);
}

// Snapshot the queue and settings for the renderer. Replaces the old
// buildFormData(): nothing is uploaded any more, the sheets are rendered here.
function currentRenderOptions() {
    return AppRender.buildOptions(logoQueue, {
        logoSize: logoSizeSelect.value,
        bleed: bleedSelect.value,
        outputSize: outputSize.value,
        projectName: projectNameInput.value,
        layout: layoutMode.value,
        gap: gapInches(),
    });
}

// Object URLs for the bitmaps currently on screen, released when replaced.
let currentSheetUrls = [];

function releaseSheetUrls() {
    for (const url of currentSheetUrls) URL.revokeObjectURL(url);
    currentSheetUrls = [];
}

function renderPreviewSheets(sheetUrls, overlaySrcLogo, overlaySrcBleed) {
    const sheetCount = sheetUrls.length;
    currentSheetCount = sheetCount;

    releaseSheetUrls();
    currentSheetUrls = sheetUrls.slice();
    previewTransform.innerHTML = "";

    for (let i = 0; i < sheetCount; i++) {
        const wrapper = document.createElement("div");
        wrapper.className = "sheet-wrapper";

        if (sheetCount > 1) {
            const label = document.createElement("div");
            label.className = "sheet-label";
            label.textContent = `Sheet ${i + 1} of ${sheetCount}`;
            wrapper.appendChild(label);
        }

        const imagesDiv = document.createElement("div");
        imagesDiv.className = "sheet-images";

        const img = document.createElement("img");
        img.className = "preview-img";
        img.src = sheetUrls[i];
        img.draggable = false;
        if (i === 0) {
            img.addEventListener("load", () => {
                singleSheetW = img.naturalWidth;
                imgW = singleSheetW * sheetCount + SHEET_GAP * (sheetCount - 1);
                imgH = img.naturalHeight;
                fitToView();
            });
        }
        imagesDiv.appendChild(img);

        if (overlaySrcLogo) {
            const oLogo = document.createElement("img");
            oLogo.className = "overlay-logo";
            oLogo.src = overlaySrcLogo;
            oLogo.draggable = false;
            if (!showLogoOutline.checked) oLogo.style.display = "none";
            imagesDiv.appendChild(oLogo);
        }

        if (overlaySrcBleed) {
            const oBleed = document.createElement("img");
            oBleed.className = "overlay-bleed";
            oBleed.src = overlaySrcBleed;
            oBleed.draggable = false;
            if (!showBleedOutline.checked) oBleed.style.display = "none";
            imagesDiv.appendChild(oBleed);
        }

        wrapper.appendChild(imagesDiv);
        previewTransform.appendChild(wrapper);
    }
}

async function generatePreview() {
    if (logoQueue.length === 0) return;

    // Rendering is local and cannot be aborted mid-flight, so a token is used
    // to discard the result of a run that a newer edit has superseded.
    const token = ++previewToken;

    downloadZipBtn.disabled = true;
    downloadPdfBtn.disabled = true;
    status.hidden = true;

    try {
        const options = currentRenderOptions();
        const urls = await AppRender.renderPreview(options);
        if (token !== previewToken) {
            for (const u of urls) URL.revokeObjectURL(u);
            return;
        }

        const ls = logoSizeSelect.value;
        const size = outputSize.value;
        // Those outlines mark jig slots; the packed layout has none, and its
        // cut lines already show where every logo sits.
        const [oLogo, oBleed] = isPacked()
            ? [null, null]
            : await Promise.all([
                AppRender.overlayURL(ls, size, "logo", currentBleedPx()),
                AppRender.overlayURL(ls, size, "bleed", currentBleedPx()),
            ]);
        if (token !== previewToken) {
            for (const u of urls) URL.revokeObjectURL(u);
            return;
        }

        renderPreviewSheets(urls, oLogo, oBleed);
        updateDownloadBtn();
    } catch (err) {
        showStatus(err.message || "Preview failed", "error");
    }
}

// ---- Upload handling ----
logoInput.addEventListener("change", () => {
    const files = Array.from(logoInput.files);
    for (const file of files) {
        addLogo(file);
    }
    // Reset input so same file can be re-added
    logoInput.value = "";
});

// Drag-over styling
uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("dragover");
});
uploadArea.addEventListener("dragleave", () => {
    uploadArea.classList.remove("dragover");
});
uploadArea.addEventListener("drop", () => {
    uploadArea.classList.remove("dragover");
});

// ---- Load empty template and overlay ----
async function loadTemplate() {
    const size = outputSize.value;
    const ls = logoSizeSelect.value;
    const token = ++previewToken;

    currentSheetCount = 1;

    const packed = isPacked();
    const [tplUrl, oLogoUrl, oBleedUrl] = packed
        ? [await AppRender.templateURL(ls, size, "packed", gapInches()), null, null]
        : await Promise.all([
            AppRender.templateURL(ls, size, "jig"),
            AppRender.overlayURL(ls, size, "logo", currentBleedPx()),
            AppRender.overlayURL(ls, size, "bleed", currentBleedPx()),
        ]);
    if (!tplUrl) return;
    if (token !== previewToken) {
        URL.revokeObjectURL(tplUrl);
        return;
    }

    releaseSheetUrls();
    currentSheetUrls = [tplUrl];
    previewTransform.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "sheet-wrapper";
    const imagesDiv = document.createElement("div");
    imagesDiv.className = "sheet-images";

    const img = document.createElement("img");
    img.className = "preview-img";
    img.src = tplUrl;
    img.draggable = false;
    img.addEventListener("load", () => {
        singleSheetW = img.naturalWidth;
        imgW = singleSheetW;
        imgH = img.naturalHeight;
        fitToView();
    });
    imagesDiv.appendChild(img);

    if (oLogoUrl) {
        const oLogo = document.createElement("img");
        oLogo.className = "overlay-logo";
        oLogo.src = oLogoUrl;
        oLogo.draggable = false;
        if (!showLogoOutline.checked) oLogo.style.display = "none";
        imagesDiv.appendChild(oLogo);
    }

    if (oBleedUrl) {
        const oBleed = document.createElement("img");
        oBleed.className = "overlay-bleed";
        oBleed.src = oBleedUrl;
        oBleed.draggable = false;
        if (!showBleedOutline.checked) oBleed.style.display = "none";
        imagesDiv.appendChild(oBleed);
    }

    wrapper.appendChild(imagesDiv);
    previewTransform.appendChild(wrapper);
}

// ---- Setting changes trigger auto-preview ----
outputSize.addEventListener("change", () => {
    updateDownloadBtn();
    if (logoQueue.length > 0) {
        schedulePreview();
    } else {
        loadTemplate();
    }
});

bleedSelect.addEventListener("change", () => {
    // Bleed enlarges the placed area, so it changes the print resolution.
    renderQueue();
    updateDownloadBtn();
    if (logoQueue.length > 0) schedulePreview();
    else loadTemplate();
});

layoutMode.addEventListener("change", () => {
    syncLayoutControls();
    updateSlotCounter();
    updateDownloadBtn();
    renderQueue();
    if (logoQueue.length > 0) schedulePreview();
    else loadTemplate();
});

gapInput.addEventListener("input", () => {
    // The fit readout updates on every keystroke; the sheet redraw is debounced.
    syncLayoutControls();
    updateSlotCounter();
    updateDownloadBtn();
    renderQueue();
    if (logoQueue.length > 0) schedulePreview();
    else loadTemplate();
});

projectNameInput.addEventListener("input", () => {
    if (logoQueue.length > 0) schedulePreview();
});

// ---- Logo size change — update label and reload ----
logoSizeSelect.addEventListener("change", () => {
    logoLabel.textContent = SIZE_LABELS[logoSizeSelect.value] || SIZE_LABELS["3x3"];
    syncLayoutControls();

    // Reset placement/text state, but keep the per-logo background (an image property).
    for (const entry of logoQueue) {
        entry.editorState = {
            scale: 1.0, offsetX: 0, offsetY: 0, rotation: 0, textOverlay: null,
            background: entry.editorState.background || null,
        };
        entry.variableData = null;
    }

    // Re-validate all logos for new dimensions
    const tmpl = EDITOR_TEMPLATES[logoSizeSelect.value];
    for (const entry of logoQueue) {
        if (entry.cachedMeta) {
            entry.validation = revalidateDimensionsStateless(
                entry.cachedMeta, entry.validation, { w: tmpl.logo_w, h: tmpl.logo_h }
            );
        }
    }

    renderQueue();
    updateSlotCounter();
    updateDownloadBtn();
    renderVariableDataSection();

    if (logoQueue.length > 0 && canGenerate()) {
        schedulePreview();
    } else if (logoQueue.length === 0) {
        loadTemplate();
    }
});

serviceSelect.addEventListener("change", () => {
    saveServicePref(serviceSelect.value);
    updateDownloadBtn();
});

// A fix button changes the one setting named in the finding -- never silently,
// and never more than the one thing the message said was wrong.
serviceFindings.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-fix");
    if (!btn) return;
    if (btn.dataset.setting === "outputSize") {
        outputSize.value = btn.dataset.value;
        outputSize.dispatchEvent(new Event("change"));
    }
});

populateServices();
syncLayoutControls();
loadTemplate();
updateDownloadBtn();

// ---- Slot outline toggles ----
showLogoOutline.addEventListener("change", () => {
    document.querySelectorAll(".overlay-logo").forEach(el => {
        el.style.display = showLogoOutline.checked ? "" : "none";
    });
});
showBleedOutline.addEventListener("change", () => {
    document.querySelectorAll(".overlay-bleed").forEach(el => {
        el.style.display = showBleedOutline.checked ? "" : "none";
    });
});

// ---- Prevent form submission ----
form.addEventListener("submit", (e) => {
    e.preventDefault();
});

// ---- Download helpers ----
// Render at full 300 DPI and package for download, entirely in the page.
async function runExport(btn, kind) {
    if (!canGenerate()) return;

    const name = projectNameInput.value.trim();
    if (!name) {
        showStatus("Project name is required.", "error");
        projectNameInput.focus();
        return;
    }

    const originalLabel = btn.textContent;
    downloadZipBtn.disabled = true;
    downloadPdfBtn.disabled = true;
    status.hidden = true;

    try {
        const options = currentRenderOptions();
        const { blob, filename } = await AppRender.exportSheets(
            options, kind, name,
            (index, total) => {
                btn.textContent = total > 1
                    ? `Rendering sheet ${index + 1} of ${total}...`
                    : "Rendering 300 DPI...";
            });

        AppRender.downloadBlob(blob, filename);
        showStatus(`Downloaded ${filename}`, "success");
    } catch (err) {
        showStatus(err.message || "Generation failed", "error");
    } finally {
        btn.textContent = originalLabel;
        updateDownloadBtn();
    }
}

downloadZipBtn.addEventListener("click", () => runExport(downloadZipBtn, "zip"));
downloadPdfBtn.addEventListener("click", () => runExport(downloadPdfBtn, "pdf"));

// ---- Status helper ----
function showStatus(msg, type) {
    status.textContent = msg;
    status.className = type;
    status.hidden = false;
}

// ---- Zoom & pan ----
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;

function applyTransform() {
    previewTransform.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    if (scale < 1.05 && Math.abs(panX - (viewport.clientWidth - imgW * scale) / 2) < 2) {
        zoomLevel.textContent = "Fit";
    } else {
        zoomLevel.textContent = Math.round(scale * 100) + "%";
    }
}

function fitToView() {
    if (!imgW || !imgH) return;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    scale = Math.min(vw / imgW, vh / imgH, 1);
    panX = (vw - imgW * scale) / 2;
    panY = (vh - imgH * scale) / 2;
    applyTransform();
}

function zoomAt(cx, cy, factor) {
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    const ratio = newScale / scale;
    panX = cx - (cx - panX) * ratio;
    panY = cy - (cy - panY) * ratio;
    scale = newScale;
    applyTransform();
}

zoomInBtn.addEventListener("click", () => {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    zoomAt(vw / 2, vh / 2, ZOOM_STEP);
});

zoomOutBtn.addEventListener("click", () => {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    zoomAt(vw / 2, vh / 2, 1 / ZOOM_STEP);
});

zoomFitBtn.addEventListener("click", fitToView);

viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoomAt(cx, cy, factor);
}, { passive: false });

viewport.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panOriginX = panX;
    panOriginY = panY;
    viewport.classList.add("grabbing");
});

window.addEventListener("mousemove", (e) => {
    if (!isPanning) return;
    panX = panOriginX + (e.clientX - panStartX);
    panY = panOriginY + (e.clientY - panStartY);
    applyTransform();
});

window.addEventListener("mouseup", () => {
    if (!isPanning) return;
    isPanning = false;
    viewport.classList.remove("grabbing");
});

window.addEventListener("resize", fitToView);

// ================================================================
// Logo Editor Modal
// ================================================================

const editorOverlay = document.getElementById("logo-editor-overlay");
const editorCanvas = document.getElementById("editor-canvas");
const editorCtx = editorCanvas.getContext("2d");
const editorScaleSlider = document.getElementById("editor-scale");
const editorScaleLabel = document.getElementById("editor-scale-label");
const editorRotateSlider = document.getElementById("editor-rotate");
const editorRotateLabel = document.getElementById("editor-rotate-label");
const rotateStepBtns = document.querySelectorAll(".rotate-step");
const editorSaveBtn = document.getElementById("editor-save");
const editorCancelBtn = document.getElementById("editor-cancel");
const editorResetBtn = document.getElementById("editor-reset");
const editorCloseBtn = document.getElementById("editor-close");

let editorWork = { scale: 1.0, offsetX: 0, offsetY: 0, rotation: 0, textOverlay: null, background: null };
let editorLogoImg = null;
let editorTargetId = null;  // which queue entry is being edited
let editorDragging = false;
let editorDraggingText = false;
let editorDragStartX = 0;
let editorDragStartY = 0;
let editorDragOriginX = 0;
let editorDragOriginY = 0;

// Text editor DOM refs
const editorAddTextBtn = document.getElementById("editor-add-text");
const editorTextControls = document.getElementById("editor-text-controls");
const editorRemoveTextBtn = document.getElementById("editor-remove-text");
const editorFontFamily = document.getElementById("editor-font-family");
const editorFontSize = document.getElementById("editor-font-size");
const editorFontWeight = document.getElementById("editor-font-weight");
const editorTextColor = document.getElementById("editor-text-color");
const textAlignBtns = document.querySelectorAll(".text-align-btn");

// Background control refs
const bgBtns = document.querySelectorAll(".bg-btn");
const editorBgColor = document.getElementById("editor-bg-color");

const EDITOR_DISPLAY_W = 480;
let editorDisplayScale = 1;

function getEditorDims() {
    const tmpl = EDITOR_TEMPLATES[logoSizeSelect.value];
    const bleed_px = Math.round(parseFloat(bleedSelect.value) * 300);
    const placed_w = tmpl.logo_w + 2 * bleed_px;
    const placed_h = tmpl.logo_h + 2 * bleed_px;
    return {
        slot_w: tmpl.slot_w, slot_h: tmpl.slot_h,
        logo_w: tmpl.logo_w, logo_h: tmpl.logo_h,
        placed_w, placed_h, bleed_px,
    };
}

function setupEditorCanvas() {
    const dims = getEditorDims();
    const dpr = window.devicePixelRatio || 1;
    editorDisplayScale = EDITOR_DISPLAY_W / dims.slot_w;
    const displayH = Math.round(dims.slot_h * editorDisplayScale);

    editorCanvas.style.width = EDITOR_DISPLAY_W + "px";
    editorCanvas.style.height = displayH + "px";
    editorCanvas.width = Math.round(EDITOR_DISPLAY_W * dpr);
    editorCanvas.height = Math.round(displayH * dpr);
    editorCtx.setTransform(dpr * editorDisplayScale, 0, 0, dpr * editorDisplayScale, 0, 0);
}

// Compute the logo's drawn size and rotated bounding box in the editor.
// "Rotate then fit": the rotated logo's bounding box is fitted into the placed
// area so the whole logo stays visible at any angle. Mirrors the server.
function getLogoDrawMetrics() {
    if (!editorLogoImg) return null;
    const dims = getEditorDims();
    const iw = editorLogoImg.naturalWidth;
    const ih = editorLogoImg.naturalHeight;
    const th = (editorWork.rotation || 0) * Math.PI / 180;
    const ac = Math.abs(Math.cos(th));
    const as = Math.abs(Math.sin(th));
    const fitBBoxW = iw * ac + ih * as;
    const fitBBoxH = iw * as + ih * ac;
    const k = Math.min(dims.placed_w / fitBBoxW, dims.placed_h / fitBBoxH);
    const drawW = iw * k * editorWork.scale;
    const drawH = ih * k * editorWork.scale;
    // Bounding box of the drawn (scaled) logo after rotation — used for edge alignment.
    const bboxW = drawW * ac + drawH * as;
    const bboxH = drawW * as + drawH * ac;
    return { th, drawW, drawH, bboxW, bboxH };
}

function drawEditor() {
    const dims = getEditorDims();
    const ctx = editorCtx;
    const { slot_w, slot_h, logo_w, logo_h, placed_w, placed_h } = dims;

    ctx.clearRect(0, 0, slot_w, slot_h);

    const checkSize = 20;
    for (let y = 0; y < slot_h; y += checkSize) {
        for (let x = 0; x < slot_w; x += checkSize) {
            const isLight = ((x / checkSize | 0) + (y / checkSize | 0)) % 2 === 0;
            ctx.fillStyle = isLight ? "#ffffff" : "#cccccc";
            ctx.fillRect(x, y, checkSize, checkSize);
        }
    }

    // Background fills the full slot (matches the server-side slot fill), drawn
    // behind the logo. Opaque, so it covers the transparency checkerboard.
    if (editorWork.background) {
        ctx.fillStyle = editorWork.background;
        ctx.fillRect(0, 0, slot_w, slot_h);
    }

    if (editorLogoImg) {
        const m = getLogoDrawMetrics();
        const placedX = (slot_w - placed_w) / 2;
        const placedY = (slot_h - placed_h) / 2;
        const centerX = slot_w / 2 + editorWork.offsetX;
        const centerY = slot_h / 2 + editorWork.offsetY;

        ctx.save();
        ctx.beginPath();
        ctx.rect(placedX, placedY, placed_w, placed_h);
        ctx.clip();
        ctx.translate(centerX, centerY);
        ctx.rotate(m.th);
        ctx.drawImage(editorLogoImg, -m.drawW / 2, -m.drawH / 2, m.drawW, m.drawH);
        ctx.restore();
    }

    ctx.lineWidth = 2 / editorDisplayScale;

    ctx.strokeStyle = "rgba(180, 180, 180, 0.7)";
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(0, 0, slot_w, slot_h);

    const placedX = (slot_w - placed_w) / 2;
    const placedY = (slot_h - placed_h) / 2;
    ctx.strokeStyle = "rgba(255, 60, 60, 0.8)";
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(placedX, placedY, placed_w, placed_h);

    const logoAreaX = (slot_w - logo_w) / 2;
    const logoAreaY = (slot_h - logo_h) / 2;
    ctx.strokeStyle = "rgba(0, 200, 0, 0.8)";
    ctx.setLineDash([]);
    ctx.strokeRect(logoAreaX, logoAreaY, logo_w, logo_h);

    ctx.setLineDash([]);

    // Draw text overlay placeholder
    if (editorWork.textOverlay?.enabled) {
        const t = editorWork.textOverlay;
        const weightStr = t.fontWeight === "bold" ? "bold " : "";
        ctx.font = `${weightStr}${t.fontSize}px "${t.fontFamily}", sans-serif`;
        ctx.fillStyle = t.color;
        ctx.textAlign = t.alignment;
        ctx.textBaseline = "top";
        ctx.fillText("{{name}}", t.x, t.y);
        // Reset
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
    }
}

// ---- Open editor for a specific queue entry ----
function openEditorFor(id) {
    const entry = getEntry(id);
    if (!entry) return;

    editorTargetId = id;
    const url = entry.objectUrl;
    const img = new Image();
    img.onload = () => {
        editorLogoImg = img;
        editorWork = {
            scale: entry.editorState.scale,
            offsetX: entry.editorState.offsetX,
            offsetY: entry.editorState.offsetY,
            rotation: entry.editorState.rotation || 0,
            textOverlay: entry.editorState.textOverlay
                ? { ...entry.editorState.textOverlay }
                : null,
            background: entry.editorState.background || null,
        };
        editorScaleSlider.value = Math.round(editorWork.scale * 100);
        editorScaleLabel.textContent = Math.round(editorWork.scale * 100) + "%";
        syncTextControlsToState();
        syncBgControlsToState();
        syncRotateControlsToState();
        setupEditorCanvas();
        drawEditor();
        editorOverlay.classList.add("visible");
    };
    img.src = url;
}

function syncTextControlsToState() {
    const t = editorWork.textOverlay;
    if (t?.enabled) {
        editorAddTextBtn.hidden = true;
        editorTextControls.hidden = false;
        editorFontFamily.value = t.fontFamily;
        editorFontSize.value = t.fontSize;
        editorFontWeight.value = t.fontWeight;
        editorTextColor.value = t.color;
        textAlignBtns.forEach(b => b.classList.toggle("active", b.dataset.textAlign === t.alignment));
    } else {
        editorAddTextBtn.hidden = false;
        editorTextControls.hidden = true;
    }
}

// ---- Background controls ----
// editorWork.background is null (transparent) or a CSS color string (e.g. "#ffffff").
function syncBgControlsToState() {
    const isColor = !!editorWork.background;
    bgBtns.forEach((b) => {
        const on = b.dataset.bg === (isColor ? "color" : "transparent");
        b.classList.toggle("active", on);
    });
    if (isColor) editorBgColor.value = editorWork.background;
}

bgBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
        editorWork.background = btn.dataset.bg === "color" ? editorBgColor.value : null;
        syncBgControlsToState();
        drawEditor();
    });
});

editorBgColor.addEventListener("input", () => {
    // Picking a color implies the "color" background mode.
    editorWork.background = editorBgColor.value;
    syncBgControlsToState();
    drawEditor();
});

// ---- Close helpers ----
function closeEditor() {
    editorOverlay.classList.remove("visible");
    editorDragging = false;
    editorDraggingText = false;
}

editorCancelBtn.addEventListener("click", closeEditor);
editorCloseBtn.addEventListener("click", closeEditor);

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && editorOverlay.classList.contains("visible")) {
        closeEditor();
    }
});

// ---- Save (commits editor state to targeted queue entry) ----
editorSaveBtn.addEventListener("click", () => {
    const entry = getEntry(editorTargetId);
    if (entry) {
        entry.editorState = {
            scale: editorWork.scale,
            offsetX: editorWork.offsetX,
            offsetY: editorWork.offsetY,
            rotation: editorWork.rotation || 0,
            textOverlay: editorWork.textOverlay ? { ...editorWork.textOverlay } : null,
            background: editorWork.background || null,
        };
        // Clear variable data if text was removed
        if (!editorWork.textOverlay?.enabled) {
            entry.variableData = null;
        }
    }
    closeEditor();
    renderQueue();
    updateDownloadBtn();
    renderVariableDataSection();
    schedulePreview();
});

// ---- Reset ----
editorResetBtn.addEventListener("click", () => {
    editorWork = { scale: 1.0, offsetX: 0, offsetY: 0, rotation: 0, textOverlay: null, background: null };
    editorScaleSlider.value = 100;
    editorScaleLabel.textContent = "100%";
    syncTextControlsToState();
    syncBgControlsToState();
    syncRotateControlsToState();
    drawEditor();
});

// ---- Scale slider ----
editorScaleSlider.addEventListener("input", () => {
    editorWork.scale = parseInt(editorScaleSlider.value) / 100;
    editorScaleLabel.textContent = editorScaleSlider.value + "%";
    drawEditor();
});

// ---- Rotation controls ----
function syncRotateControlsToState() {
    const r = Math.round(editorWork.rotation || 0);
    editorRotateSlider.value = r;
    editorRotateLabel.textContent = r + "°";
}

editorRotateSlider.addEventListener("input", () => {
    editorWork.rotation = parseInt(editorRotateSlider.value, 10) || 0;
    editorRotateLabel.textContent = editorRotateSlider.value + "°";
    drawEditor();
});

rotateStepBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
        const step = parseInt(btn.dataset.rotate, 10) || 0;
        // Add the step and normalize into [-180, 180).
        let r = (editorWork.rotation || 0) + step;
        r = (((r + 180) % 360) + 360) % 360 - 180;
        editorWork.rotation = r;
        syncRotateControlsToState();
        drawEditor();
    });
});

// ---- Alignment buttons ----
document.querySelectorAll(".align-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const dims = getEditorDims();
        const { slot_w, slot_h, logo_w, logo_h, placed_w, placed_h } = dims;
        // Use the logo's actual rotated bounding box so edges snap correctly.
        const m = getLogoDrawMetrics();
        const scaledW = m ? m.bboxW : placed_w * editorWork.scale;
        const scaledH = m ? m.bboxH : placed_h * editorWork.scale;
        const align = btn.dataset.align;

        switch (align) {
            case "left":
                editorWork.offsetX = (scaledW - logo_w) / 2;
                break;
            case "center-h":
                editorWork.offsetX = 0;
                break;
            case "right":
                editorWork.offsetX = -(scaledW - logo_w) / 2;
                break;
            case "top":
                editorWork.offsetY = (scaledH - logo_h) / 2;
                break;
            case "center-v":
                editorWork.offsetY = 0;
                break;
            case "bottom":
                editorWork.offsetY = -(scaledH - logo_h) / 2;
                break;
        }
        drawEditor();
    });
});

// ---- Drag on canvas (logo or text) ----
editorCanvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const rect = editorCanvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / editorDisplayScale;
    const my = (e.clientY - rect.top) / editorDisplayScale;

    // Check if click is near text element
    if (editorWork.textOverlay?.enabled) {
        const t = editorWork.textOverlay;
        const ctx = editorCtx;
        const weightStr = t.fontWeight === "bold" ? "bold " : "";
        ctx.font = `${weightStr}${t.fontSize}px "${t.fontFamily}", sans-serif`;
        const metrics = ctx.measureText("{{name}}");
        const tw = metrics.width;
        const th = t.fontSize * 1.2;
        let tx = t.x;
        if (t.alignment === "center") tx -= tw / 2;
        else if (t.alignment === "right") tx -= tw;

        if (mx >= tx - 10 && mx <= tx + tw + 10 && my >= t.y - 10 && my <= t.y + th + 10) {
            editorDraggingText = true;
            editorDragging = false;
            editorDragStartX = e.clientX;
            editorDragStartY = e.clientY;
            editorDragOriginX = t.x;
            editorDragOriginY = t.y;
            editorCanvas.classList.add("grabbing");
            return;
        }
    }

    editorDragging = true;
    editorDraggingText = false;
    editorDragStartX = e.clientX;
    editorDragStartY = e.clientY;
    editorDragOriginX = editorWork.offsetX;
    editorDragOriginY = editorWork.offsetY;
    editorCanvas.classList.add("grabbing");
});

window.addEventListener("mousemove", (e) => {
    if (editorDraggingText && editorWork.textOverlay) {
        const dx = (e.clientX - editorDragStartX) / editorDisplayScale;
        const dy = (e.clientY - editorDragStartY) / editorDisplayScale;
        editorWork.textOverlay.x = editorDragOriginX + dx;
        editorWork.textOverlay.y = editorDragOriginY + dy;
        drawEditor();
        return;
    }
    if (!editorDragging) return;
    const dx = (e.clientX - editorDragStartX) / editorDisplayScale;
    const dy = (e.clientY - editorDragStartY) / editorDisplayScale;
    editorWork.offsetX = editorDragOriginX + dx;
    editorWork.offsetY = editorDragOriginY + dy;
    drawEditor();
});

window.addEventListener("mouseup", () => {
    if (editorDraggingText) {
        editorDraggingText = false;
        editorCanvas.classList.remove("grabbing");
        return;
    }
    if (!editorDragging) return;
    editorDragging = false;
    editorCanvas.classList.remove("grabbing");
});

editorOverlay.addEventListener("click", (e) => {
    if (e.target === editorOverlay) closeEditor();
});

// ================================================================
// Text Overlay Controls
// ================================================================

editorAddTextBtn.addEventListener("click", () => {
    const dims = getEditorDims();
    editorWork.textOverlay = {
        enabled: true,
        x: dims.slot_w / 2,
        y: dims.slot_h * 0.8,
        fontSize: 60,
        fontFamily: "Helvetica",
        fontWeight: "regular",
        color: "#FFFFFF",
        alignment: "center",
    };
    syncTextControlsToState();
    drawEditor();
});

editorRemoveTextBtn.addEventListener("click", () => {
    editorWork.textOverlay = null;
    syncTextControlsToState();
    drawEditor();
});

editorFontFamily.addEventListener("change", () => {
    if (editorWork.textOverlay) {
        editorWork.textOverlay.fontFamily = editorFontFamily.value;
        drawEditor();
    }
});

editorFontSize.addEventListener("input", () => {
    if (editorWork.textOverlay) {
        editorWork.textOverlay.fontSize = Math.max(12, parseInt(editorFontSize.value) || 60);
        drawEditor();
    }
});

editorFontWeight.addEventListener("change", () => {
    if (editorWork.textOverlay) {
        editorWork.textOverlay.fontWeight = editorFontWeight.value;
        drawEditor();
    }
});

editorTextColor.addEventListener("input", () => {
    if (editorWork.textOverlay) {
        editorWork.textOverlay.color = editorTextColor.value;
        drawEditor();
    }
});

textAlignBtns.forEach(btn => {
    btn.addEventListener("click", () => {
        if (editorWork.textOverlay) {
            editorWork.textOverlay.alignment = btn.dataset.textAlign;
            textAlignBtns.forEach(b => b.classList.toggle("active", b === btn));
            drawEditor();
        }
    });
});

// ---- Text position buttons (snap text box to edges/center of logo area) ----
document.querySelectorAll(".text-pos-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        if (!editorWork.textOverlay?.enabled) return;
        const dims = getEditorDims();
        const t = editorWork.textOverlay;
        const { slot_w, slot_h, logo_w, logo_h } = dims;
        // Logo area bounds within the slot
        const logoX0 = (slot_w - logo_w) / 2;
        const logoY0 = (slot_h - logo_h) / 2;
        const logoX1 = logoX0 + logo_w;
        const logoY1 = logoY0 + logo_h;
        const textH = t.fontSize * 1.2;

        switch (btn.dataset.textPos) {
            case "left":
                t.x = logoX0;
                t.alignment = "left";
                break;
            case "center-h":
                t.x = slot_w / 2;
                t.alignment = "center";
                break;
            case "right":
                t.x = logoX1;
                t.alignment = "right";
                break;
            case "top":
                t.y = logoY0;
                break;
            case "center-v":
                t.y = (slot_h - textH) / 2;
                break;
            case "bottom":
                t.y = logoY1 - textH;
                break;
        }
        // Sync the text alignment buttons to match
        textAlignBtns.forEach(b => b.classList.toggle("active", b.dataset.textAlign === t.alignment));
        drawEditor();
    });
});

// ================================================================
// Variable Data Section
// ================================================================

const variableDataSection = document.getElementById("variable-data-section");
const variableDataEntries = document.getElementById("variable-data-entries");

function parseVariableInput(text) {
    // Support quoted values: "Smith, Jr.", "Jones & Co."
    const values = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            const trimmed = current.trim();
            if (trimmed) values.push(trimmed);
            current = "";
        } else {
            current += ch;
        }
    }
    const trimmed = current.trim();
    if (trimmed) values.push(trimmed);
    return values;
}

// Escape text going into innerHTML. Without this a value containing
// "</textarea>" or an angle bracket breaks the panel's markup.
function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Fill every slot with the single value, so the count always equals the
// quantity and nothing downstream needs to know about this mode.
function applySameText(entry) {
    const value = (entry.sameTextValue || "").trim();
    entry.variableData = value ? Array(entry.quantity).fill(value) : null;
}

// One source of truth for the status line, used by the initial render and by
// the live update while typing.
function varDataStatus(entry) {
    const need = entry.quantity;
    if (entry.sameTextForAll) {
        const has = Boolean((entry.sameTextValue || "").trim());
        return {
            ok: has,
            msg: has ? `Printed on all ${need} label${need === 1 ? "" : "s"}`
                     : "Type the text above",
        };
    }
    const have = entry.variableData ? entry.variableData.length : 0;
    if (have === need) return { ok: true, msg: `${have}/${need} values` };
    const fix = need - have > 0 ? `need ${need - have} more` : `remove ${have - need}`;
    return { ok: false, msg: `${have}/${need} values — ${fix}` };
}

function getVarDataStatusHTML(entry) {
    const { ok, msg } = varDataStatus(entry);
    return `<span class="var-data-status ${ok ? "green" : "red"}">${escapeHTML(msg)}</span>`;
}

function updateVarDataStatus(entry) {
    const statusEl = variableDataEntries.querySelector(`.var-data-actions[data-id="${entry.id}"] .var-data-status`);
    if (statusEl) {
        const { ok, msg } = varDataStatus(entry);
        statusEl.className = `var-data-status ${ok ? "green" : "red"}`;
        statusEl.textContent = msg;
    }
}

function renderVariableDataSection() {
    const entriesWithText = logoQueue.filter(e => e.editorState.textOverlay?.enabled);
    if (entriesWithText.length === 0) {
        variableDataSection.hidden = true;
        variableDataEntries.innerHTML = "";
        return;
    }
    variableDataSection.hidden = false;

    variableDataEntries.innerHTML = entriesWithText.map(entry => {
        const need = entry.quantity;
        const same = Boolean(entry.sameTextForAll);
        const textVal = same
            ? (entry.sameTextValue || "")
            : (entry.variableData ? entry.variableData.join(", ") : "");
        const note = same ? `(same text on all ${need})` : `(${need} values needed)`;

        return `<div class="var-data-entry" data-id="${entry.id}">
            <div class="var-data-header">
                <img class="queue-thumb" src="${entry.objectUrl}" alt="">
                <span class="var-data-label">${escapeHTML(entry.file.name)} ${note}</span>
            </div>
            <label class="var-data-same">
                <input type="checkbox" class="same-text-toggle" data-id="${entry.id}" ${same ? "checked" : ""}>
                Same text on every label
            </label>
            <textarea class="var-data-input" rows="${same ? 2 : 3}"
                placeholder="${same ? "Medium" : "Acme Corp, Smith &amp; Sons, Johnson LLC"}"
                data-id="${entry.id}">${escapeHTML(textVal)}</textarea>
            <div class="var-data-actions" data-id="${entry.id}">
                <div class="var-data-buttons">
                    <label class="btn btn-secondary btn-csv-upload">
                        Upload CSV
                        <input type="file" class="csv-input" accept=".csv,.txt" data-id="${entry.id}" hidden>
                    </label>
                    <button type="button" class="btn btn-primary btn-apply-data" data-id="${entry.id}">Apply</button>
                </div>
                ${getVarDataStatusHTML(entry)}
            </div>
        </div>`;
    }).join("");
}

// Typing in textarea: update data + status only (no re-render, no preview)
variableDataEntries.addEventListener("input", (e) => {
    if (e.target.classList.contains("var-data-input")) {
        const id = parseInt(e.target.dataset.id);
        const entry = getEntry(id);
        if (entry) {
            if (entry.sameTextForAll) {
                // Taken literally, so the value may contain commas ("Smith, Jr.").
                entry.sameTextValue = e.target.value;
                applySameText(entry);
            } else {
                entry.variableData = parseVariableInput(e.target.value);
            }
            updateVarDataStatus(entry);
            updateDownloadBtn();
        }
    }
});

// Apply button: auto-adjust quantity to match value count, then preview
variableDataEntries.addEventListener("click", (e) => {
    const applyBtn = e.target.closest(".btn-apply-data");
    if (applyBtn) {
        const id = parseInt(applyBtn.dataset.id);
        const entry = getEntry(id);
        if (!entry || !entry.variableData) return;

        // In same-text mode the quantity drives the value count, not the other
        // way round, so Apply must leave the quantity alone.
        const count = entry.variableData.length;
        if (!entry.sameTextForAll && count > 0 && count !== entry.quantity) {
            entry.quantity = Math.max(1, count);
            updateSlotCounter();
        }

        renderVariableDataSection();
        renderQueue();
        updateDownloadBtn();
        if (canGenerate()) schedulePreview();
    }
});

// "Same text on every label" toggle
variableDataEntries.addEventListener("change", (e) => {
    if (!e.target.classList.contains("same-text-toggle")) return;
    const entry = getEntry(parseInt(e.target.dataset.id));
    if (!entry) return;

    entry.sameTextForAll = e.target.checked;
    if (entry.sameTextForAll) {
        // Carry whatever is already typed over as the single value.
        if (!entry.sameTextValue && entry.variableData && entry.variableData.length) {
            entry.sameTextValue = entry.variableData[0];
        }
        applySameText(entry);
    } else {
        // Going back to per-label values, seeded with the one they had.
        entry.variableData = entry.sameTextValue ? [entry.sameTextValue] : null;
    }

    renderVariableDataSection();
    updateDownloadBtn();
    if (canGenerate()) schedulePreview();
});

// CSV upload
variableDataEntries.addEventListener("change", (e) => {
    if (e.target.classList.contains("csv-input")) {
        const id = parseInt(e.target.dataset.id);
        const entry = getEntry(id);
        const file = e.target.files[0];
        if (!entry || !file) return;

        const reader = new FileReader();
        reader.onload = () => {
            const text = reader.result;
            const lines = text.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
            // A CSV is per-label data, so it takes the entry out of same-text mode.
            entry.sameTextForAll = false;
            entry.variableData = lines;
            // Auto-adjust quantity to match CSV row count
            if (lines.length > 0 && lines.length !== entry.quantity) {
                entry.quantity = Math.max(1, lines.length);
                updateSlotCounter();
            }
            renderVariableDataSection();
            updateDownloadBtn();
            renderQueue();
            if (canGenerate()) schedulePreview();
        };
        reader.readAsText(file);
        e.target.value = "";
    }
});
