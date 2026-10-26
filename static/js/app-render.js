// Bridge between the queue UI in main.js and the client-side renderer.
//
// This replaces the server round-trips. Previously every preview posted the
// whole queue — up to 64 MB of logo files — to /preview-generate and waited for
// a PNG to come back, which was fine on localhost and painful anywhere else.
// Now the sheets are rendered in the page from pixels that are already there.
//
// The rendering itself lives in render.js / place.js / resample.js / text.js and
// is verified byte-for-byte against the Python generator (see tools/parity).
// Nothing in this file should do image maths; it only marshals UI state and
// hands results back to the DOM.

const AppRender = (function () {
    'use strict';

    // Matches the old server-side preview scale: 75 DPI is plenty on screen and
    // keeps the displayed bitmaps small.
    const PREVIEW_SCALE = 0.25;

    // Static per template/size, so render once and keep the object URL.
    const overlayCache = new Map();

    let fontsReady = null;
    function ensureFonts() {
        if (!fontsReady) fontsReady = SheetText.ensureFonts();
        return fontsReady;
    }

    // ---- UI state -> renderer options -------------------------------------

    /**
     * Decode an entry's image to raw RGBA, once, and cache it on the entry.
     *
     * This is the same canvas decode main.js already performed when it
     * normalised uploads, so the pixels match what the Flask app used to
     * receive.
     */
    function entryPixels(entry) {
        if (!entry.pixels && entry.originalImage) {
            entry.pixels = Place.decodeImage(entry.originalImage);
        }
        return entry.pixels;
    }

    /** Drop cached pixels when an entry's image changes. */
    function invalidatePixels(entry) {
        entry.pixels = null;
    }

    /**
     * Build renderer options from the queue. The field mapping mirrors the old
     * buildFormData() exactly, including the rounding, so behaviour does not
     * drift from the Python.
     */
    function buildOptions(queue, ui) {
        const logoEntries = queue.map((entry) => {
            const pixels = entryPixels(entry);
            const st = entry.editorState;
            const t = st.textOverlay;

            const overlay = (t && t.enabled && entry.variableData) ? {
                x: Math.round(t.x),
                y: Math.round(t.y),
                font_size: t.fontSize,
                font_family: t.fontFamily,
                font_weight: t.fontWeight,
                color: t.color,
                alignment: t.alignment,
            } : null;

            return {
                px: pixels.px,
                w: pixels.w,
                h: pixels.h,
                quantity: entry.quantity,
                logoScale: st.scale,
                offsetX: Math.round(st.offsetX),
                offsetY: Math.round(st.offsetY),
                rotation: st.rotation || 0,
                background: st.background || null,
                textOverlay: overlay,
                variableData: overlay ? entry.variableData : null,
            };
        });

        return {
            logoEntries,
            logoSize: ui.logoSize,
            // Bleed fills the jig's slot opening, so the packed layout forces
            // it to zero rather than letting a stale value shrink the gap.
            bleed: ui.layout === 'packed' ? '0.00' : ui.bleed,
            outputSize: ui.outputSize,
            projectName: ui.projectName || '',
            layout: ui.layout || 'jig',
            gap: ui.gap === undefined ? 0.25 : ui.gap,
        };
    }

    // Mirrors the server's _sanitize_name, since the filename is built here now.
    function sanitizeName(name) {
        const cleaned = String(name || '').replace(/[^a-zA-Z0-9 _-]/g, '').trim();
        return cleaned || 'transfer';
    }

    // ---- display helpers --------------------------------------------------

    /** Raw RGBA straight to a blob URL, at its own size. */
    function rawToURL(px, w, h) {
        const canvas = Place.toCanvas(px, w, h);
        return new Promise((resolve) => {
            canvas.toBlob((blob) => {
                canvas.width = canvas.height = 0;
                resolve(URL.createObjectURL(blob));
            }, 'image/png');
        });
    }

    function downscaleToURL(px, w, h, onWhite) {
        const full = Place.toCanvas(px, w, h);
        const pw = Math.max(1, Math.round(w * PREVIEW_SCALE));
        const ph = Math.max(1, Math.round(h * PREVIEW_SCALE));

        const small = document.createElement('canvas');
        small.width = pw;
        small.height = ph;
        const ctx = small.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        if (onWhite) {
            // The old server preview composited onto white before saving.
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, pw, ph);
        }
        ctx.drawImage(full, 0, 0, pw, ph);
        full.width = full.height = 0;

        return new Promise((resolve) => {
            small.toBlob((blob) => {
                small.width = small.height = 0;
                resolve(URL.createObjectURL(blob));
            }, 'image/png');
        });
    }

    // Both layouts expose the same (options, onSheet) shape, so everything
    // downstream — preview, export, multi-sheet — is identical.
    function sheetRenderer(options) {
        return options.layout === 'packed'
            ? SheetRender.renderPackedSheets
            : SheetRender.renderSheets;
    }

    /** Slot outline overlay, cached per template/size/layer. */
    async function overlayURL(logoSize, outputSize, layer, bleedPx) {
        const key = `${logoSize}|${outputSize}|${layer}|${bleedPx}`;
        if (overlayCache.has(key)) return overlayCache.get(key);

        // Drawn straight at preview scale. Rendering full size and shrinking
        // afterwards threw away most of a 2 px line; this keeps every edge.
        const o = SheetRender.renderSlotOverlay(logoSize, outputSize, layer,
                                                bleedPx, PREVIEW_SCALE);
        const url = await rawToURL(o.px, o.w, o.h);
        overlayCache.set(key, url);
        return url;
    }

    /**
     * Empty template (guides only), for the initial view.
     *
     * The packed layout has no fixed slots, so its empty sheet is simply a
     * packed render with nothing in it — which draws the jig outlines, the
     * separator and the cut-line grid.
     */
    async function templateURL(logoSize, outputSize, layout, gap) {
        if (layout === 'packed') {
            let url = null;
            await SheetRender.renderPackedSheets(
                { logoEntries: [], logoSize, outputSize, gap, projectName: '' },
                async (sheet) => {
                    url = await downscaleToURL(sheet.px, sheet.w, sheet.h, true);
                });
            return url;
        }
        const t = SheetRender.renderEmptyTemplate(logoSize, outputSize);
        return downscaleToURL(t.px, t.w, t.h, true);
    }

    /**
     * Render every sheet and hand back a display-sized object URL for each.
     * Full-resolution buffers are released as soon as each preview is made.
     */
    async function renderPreview(options) {
        await ensureFonts();
        const urls = [];
        await sheetRenderer(options)(options, async (sheet) => {
            urls.push(await downscaleToURL(sheet.px, sheet.w, sheet.h, true));
        });
        return urls;
    }

    // ---- exports ----------------------------------------------------------

    /**
     * Render at full resolution and package for download.
     *
     * Sheets are encoded and released one at a time: a 22x24 sheet is ~190 MB
     * of RGBA, so holding 17 of them would need over 3 GB.
     *
     * @param {'zip'|'pdf'} kind
     * @param {Function} onProgress (index, total) => void
     */
    async function exportSheets(options, kind, projectName, onProgress) {
        await ensureFonts();
        const safe = sanitizeName(projectName);

        const render = sheetRenderer(options);

        if (kind === 'zip' || kind === 'files') {
            const files = [];
            await render(options, async (sheet, index, total) => {
                if (onProgress) onProgress(index, total);
                files.push({
                    name: ExportZip.sheetName(safe, index),
                    blob: await ExportPNG.encode(sheet.px, sheet.w, sheet.h,
                                                 SHEET_CANVAS.dpi),
                });
            });

            if (kind === 'files') return { files };

            // A single sheet needs no container. Handing over the PNG itself
            // saves the user unzipping it, and it is the file the print service
            // wants anyway.
            if (files.length === 1) {
                return { blob: files[0].blob, filename: files[0].name };
            }

            const entries = [];
            for (const f of files) {
                entries.push({ name: f.name,
                               bytes: new Uint8Array(await f.blob.arrayBuffer()) });
            }
            return { blob: ExportZip.build(entries), filename: `${safe}_sheets.zip` };
        }

        const pdf = ExportPDF.create({ dpi: SHEET_CANVAS.dpi });
        await render(options, async (sheet, index, total) => {
            if (onProgress) onProgress(index, total);
            await pdf.addSheet(sheet.px, sheet.w, sheet.h);
        });
        return { blob: pdf.finish(), filename: `${safe}_sheets.pdf` };
    }

    /** Hand a blob to the browser as a download, then release the URL. */
    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Give the download a moment to start before revoking.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    return {
        PREVIEW_SCALE,
        ensureFonts,
        entryPixels,
        invalidatePixels,
        buildOptions,
        sanitizeName,
        overlayURL,
        templateURL,
        sheetRenderer,
        renderPreview,
        exportSheets,
        downloadBlob,
    };
})();
