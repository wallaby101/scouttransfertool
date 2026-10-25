// Transfer sheet renderer — a port of the drawing and assembly code in
// core/generator.py.
//
// Everything here works on plain Uint8Array RGBA buffers. Canvas is used only
// to decode uploads, rasterise glyphs, and present or export a finished sheet.
// That is deliberate: a canvas stores premultiplied pixels, so routing sheet
// data through putImageData/getImageData shifts partially transparent pixels
// (logo edges, antialiased text) and breaks parity with Pillow.
//
// Pillow's ImageDraw does not antialias — every pixel it touches is fully
// opaque — and its geometry conventions differ from Canvas's. These were
// measured against Pillow, not assumed:
//
//   * line endpoints are INCLUSIVE: x0..x1 covers x1 - x0 + 1 pixels
//   * a width-w line covers w rows starting at coord - floor((w - 1) / 2)
//       verified: y=15 w=2 -> rows 15,16;  w=3 -> rows 14,15,16
//   * rectangle(outline=, width=w) draws INWARD from inclusive bounds
//       verified: [5,5,30,20] w=3 -> rows 5-7 and 18-20 full width,
//                 cols 5-7 and 28-30 full height
//
// Any change in here must be re-validated with tools/parity.

const SheetRender = (function () {
    'use strict';

    const pyRound = (v) => Place.pyRound(v);

    // ---- raw-surface primitives ------------------------------------------

    function emptySheet(w, h) {
        return new Uint8Array(w * h * 4);
    }

    // Axis-aligned opaque fill, clipped. x/y/bw/bh are in pixels, bw/bh counts.
    function fillBand(px, w, h, x, y, bw, bh, rgba) {
        const x0 = Math.max(0, x);
        const y0 = Math.max(0, y);
        const x1 = Math.min(w, x + bw);
        const y1 = Math.min(h, y + bh);
        for (let yy = y0; yy < y1; yy++) {
            let i = (yy * w + x0) * 4;
            for (let xx = x0; xx < x1; xx++) {
                px[i] = rgba[0];
                px[i + 1] = rgba[1];
                px[i + 2] = rgba[2];
                px[i + 3] = rgba[3];
                i += 4;
            }
        }
    }

    function bandStart(coord, width) {
        return coord - Math.floor((width - 1) / 2);
    }

    function hLine(px, w, h, y, x0, x1, width, rgba) {
        fillBand(px, w, h, x0, bandStart(y, width), (x1 - x0) + 1, width, rgba);
    }

    function vLine(px, w, h, x, y0, y1, width, rgba) {
        fillBand(px, w, h, bandStart(x, width), y0, width, (y1 - y0) + 1, rgba);
    }

    function rectOutline(px, w, h, x0, y0, x1, y1, width, rgba) {
        const bw = (x1 - x0) + 1;
        const bh = (y1 - y0) + 1;
        fillBand(px, w, h, x0, y0, bw, width, rgba);                  // top
        fillBand(px, w, h, x0, y1 - width + 1, bw, width, rgba);      // bottom
        fillBand(px, w, h, x0, y0, width, bh, rgba);                  // left
        fillBand(px, w, h, x1 - width + 1, y0, width, bh, rgba);      // right
    }

    // Mirrors _draw_dashed_line(): walk the line alternating dash and gap,
    // clamping the final segment. dash/gap are deliberately NOT scaled by sf,
    // matching the Python defaults.
    function dashedLine(px, w, h, x0, y0, x1, y1, width, dash, gap, rgba) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length === 0) return;

        const ndx = dx / length;
        const ndy = dy / length;
        let pos = 0;
        let drawing = true;

        while (pos < length) {
            const seg = drawing ? dash : gap;
            const endPos = Math.min(pos + seg, length);
            if (drawing) {
                const ax = Math.round(x0 + ndx * pos);
                const ay = Math.round(y0 + ndy * pos);
                const bx = Math.round(x0 + ndx * endPos);
                const by = Math.round(y0 + ndy * endPos);
                if (ay === by) {
                    hLine(px, w, h, ay, Math.min(ax, bx), Math.max(ax, bx), width, rgba);
                } else if (ax === bx) {
                    vLine(px, w, h, ax, Math.min(ay, by), Math.max(ay, by), width, rgba);
                }
            }
            pos = endPos;
            drawing = !drawing;
        }
    }

    // ---- overlays ---------------------------------------------------------

    const BLUE = [0, 0, 255, 255];
    const CYAN = [0, 255, 255, 255];
    const RED = [255, 0, 0, 255];

    // Port of _draw_overlays(). Every colour is fully opaque in the Python.
    function drawOverlays(px, w, h, tmpl, sf) {
        const s = (v) => pyRound(v * sf);
        const lw = Math.max(1, pyRound(3 * sf));
        const lw2 = Math.max(1, pyRound(2 * sf));

        for (const [x0, y0, x1, y1] of tmpl.jig_outlines) {
            rectOutline(px, w, h, s(x0), s(y0), s(x1), s(y1), lw, BLUE);
        }

        // The Python draws to x = CANVAS_W, one past the last pixel; both
        // Pillow and this clip, so the result is the same.
        hLine(px, w, h, s(tmpl.separator_y), 0, s(SHEET_CANVAS.width), lw2, CYAN);

        for (const [y, xStart, xEnd] of tmpl.h_reg_lines) {
            dashedLine(px, w, h, s(xStart), s(y), s(xEnd), s(y), lw2, 15, 10, RED);
        }
        for (const [x, segments] of tmpl.v_reg_lines) {
            for (const [yStart, yEnd] of segments) {
                dashedLine(px, w, h, s(x), s(yStart), s(x), s(yEnd), lw2, 15, 10, RED);
            }
        }
    }

    // ---- sheet shaping ----------------------------------------------------

    // Port of the 22x22 crop: remove 1" from the top and bottom of the 22x24
    // layout. A straight row copy, so exact.
    function cropVertical(px, w, h, cropPx) {
        const outH = h - 2 * cropPx;
        const stride = w * 4;
        return {
            px: px.slice(cropPx * stride, (cropPx + outH) * stride),
            w,
            h: outH,
        };
    }

    function sheetHeight(outputSize) {
        return outputSize === '22x22'
            ? SHEET_CANVAS.height_22x22
            : SHEET_CANVAS.height_22x24;
    }

    // Port of generate_empty_template(): overlays only, no logos.
    function renderEmptyTemplate(logoSize, outputSize) {
        const tmpl = SHEET_TEMPLATES[logoSize];
        const w = SHEET_CANVAS.width;
        const h = SHEET_CANVAS.height_22x24;
        const px = emptySheet(w, h);
        drawOverlays(px, w, h, tmpl, 1.0);
        return outputSize === '22x22'
            ? cropVertical(px, w, h, SHEET_CANVAS.crop_px)
            : { px, w, h };
    }

    // Port of generate_slot_overlay(). These are drawn at alpha 200, which is
    // written straight into the buffer rather than going through compositing.
    function renderSlotOverlay(logoSize, outputSize, layer) {
        const tmpl = SHEET_TEMPLATES[logoSize];
        const w = SHEET_CANVAS.width;
        const h = SHEET_CANVAS.height_22x24;
        const px = emptySheet(w, h);
        const lw = 2;
        const red = [255, 0, 0, 200];
        const green = [0, 200, 0, 200];

        if (layer === 'bleed' || layer === 'both') {
            for (const [cx, cy] of tmpl.slot_centers) {
                const x0 = cx - Math.floor(tmpl.slot_w / 2);
                const y0 = cy - Math.floor(tmpl.slot_h / 2);
                rectOutline(px, w, h, x0, y0,
                            x0 + tmpl.slot_w - 1, y0 + tmpl.slot_h - 1, lw, red);
            }
        }
        if (layer === 'logo' || layer === 'both') {
            for (const [cx, cy] of tmpl.slot_centers) {
                const x0 = cx - Math.floor(tmpl.logo_w / 2);
                const y0 = cy - Math.floor(tmpl.logo_h / 2);
                rectOutline(px, w, h, x0, y0,
                            x0 + tmpl.logo_w - 1, y0 + tmpl.logo_h - 1, lw, green);
            }
        }

        return outputSize === '22x22'
            ? cropVertical(px, w, h, SHEET_CANVAS.crop_px)
            : { px, w, h };
    }

    // ---- assembly ---------------------------------------------------------

    // Pillow's _hex_to_rgba: null when there is no background, opaque white on
    // a malformed value.
    function hexToRgba(hex) {
        if (!hex) return null;
        let s = String(hex).replace(/^#/, '');
        if (s.length === 3) s = s.split('').map((c) => c + c).join('');
        if (!/^[0-9a-fA-F]{6}$/.test(s)) return [255, 255, 255, 255];
        return [parseInt(s.slice(0, 2), 16),
                parseInt(s.slice(2, 4), 16),
                parseInt(s.slice(4, 6), 16), 255];
    }

    /**
     * Flatten the queue into one entry per slot, carrying its variable-data
     * value. Mirrors the flat_slots list in generate_transfer_sheet().
     */
    function planSlots(logoEntries, logoSize) {
        const tmpl = SHEET_TEMPLATES[logoSize];
        const slotsPerSheet = tmpl.slot_centers.length;
        const flatSlots = [];

        logoEntries.forEach((entry, entryIdx) => {
            const overlay = entry.textOverlay;
            const vd = entry.variableData;
            const qty = entry.quantity === undefined ? 1 : entry.quantity;
            for (let i = 0; i < qty; i++) {
                const value = (overlay && vd && i < vd.length) ? vd[i] : null;
                flatSlots.push([entryIdx, value]);
            }
        });

        return {
            flatSlots,
            slotsPerSheet,
            numSheets: Math.max(1, Math.ceil(flatSlots.length / slotsPerSheet)),
        };
    }

    /**
     * Prepare each logo once, as the Python caches them per entry. Small
     * relative to a sheet (a slot bitmap is a few MB), so holding them all is
     * fine; the sheets themselves are what must be streamed.
     */
    function prepareEntries(logoEntries, logoSize, bleedPx) {
        const tmpl = SHEET_TEMPLATES[logoSize];
        return logoEntries.map((entry) => Place.prepareLogo(
            entry.px, entry.w, entry.h, tmpl, bleedPx, {
                logoScale: entry.logoScale,
                offsetX: entry.offsetX,
                offsetY: entry.offsetY,
                rotation: entry.rotation,
            }));
    }

    function sheetLabel(projectName, sheetNum, numSheets) {
        // The em dash matters: it is what the Python emits.
        if (numSheets > 1 && projectName) {
            return `${projectName} — Sheet ${sheetNum + 1} of ${numSheets}`;
        }
        if (numSheets > 1) {
            return `Sheet ${sheetNum + 1} of ${numSheets}`;
        }
        return projectName;
    }

    /**
     * Render one sheet. Order matters and matches the Python exactly: logos,
     * then overlays, then the project label, then the 22x22 crop.
     */
    function renderSheet(opts, sheetNum, plan, prepared) {
        const { logoEntries, logoSize, outputSize, projectName } = opts;
        const tmpl = SHEET_TEMPLATES[logoSize];
        const w = SHEET_CANVAS.width;
        const h = SHEET_CANVAS.height_22x24;
        const px = emptySheet(w, h);

        const slotW = tmpl.slot_w;
        const slotH = tmpl.slot_h;

        const start = sheetNum * plan.slotsPerSheet;
        const end = Math.min(start + plan.slotsPerSheet, plan.flatSlots.length);

        for (let slotIdx = 0; slotIdx < end - start; slotIdx++) {
            const [entryIdx, vdValue] = plan.flatSlots[start + slotIdx];
            const slot = prepared[entryIdx];
            const entry = logoEntries[entryIdx];
            const overlay = entry.textOverlay;

            let img = slot;
            if (overlay && vdValue !== null && vdValue !== undefined) {
                img = SheetText.drawTextOnSlot(slot.px, slot.w, slot.h,
                                               overlay, vdValue, tmpl);
            }

            const [cx, cy] = tmpl.slot_centers[slotIdx];
            const dx = cx - Math.floor(slot.w / 2);
            const dy = cy - Math.floor(slot.h / 2);

            const bg = hexToRgba(entry.background);
            if (bg) {
                // Fill the whole slot opening behind the logo, so the label is
                // a solid colour rather than a transparent cutout.
                const bx = cx - Math.floor(slotW / 2);
                const by = cy - Math.floor(slotH / 2);
                Place.fillRect(px, w, h, bx, by, bx + slotW - 1, by + slotH - 1, bg);
                // Composite over the fill using the logo's own alpha; an opaque
                // mask paste would punch transparent holes through it.
                Place.alphaComposite(px, w, h, img.px, img.w, img.h, dx, dy);
            } else {
                // The Python pastes with an all-255 mask, which overwrites.
                Place.pasteOpaqueMask(px, w, h, img.px, img.w, img.h, dx, dy);
            }
        }

        drawOverlays(px, w, h, tmpl, 1.0);
        SheetText.drawProjectName(px, w, h,
            sheetLabel(projectName || '', sheetNum, plan.numSheets));

        return outputSize === '22x22'
            ? cropVertical(px, w, h, SHEET_CANVAS.crop_px)
            : { px, w, h };
    }

    /**
     * Render every sheet, handing each to onSheet() and dropping it before
     * starting the next.
     *
     * A 22x24 sheet is 6600 x 7200 RGBA, about 190 MB. At the 500-slot cap that
     * is 17 sheets, so holding them all would need over 3 GB. onSheet() should
     * export or encode and not retain the buffer.
     *
     * @param {Function} onSheet async (sheet, index, total) => void
     */
    async function renderSheets(opts, onSheet) {
        const bleedPx = pyRound(parseFloat(opts.bleed) * SHEET_CANVAS.dpi);
        const plan = planSlots(opts.logoEntries, opts.logoSize);
        const prepared = prepareEntries(opts.logoEntries, opts.logoSize, bleedPx);

        for (let n = 0; n < plan.numSheets; n++) {
            const sheet = renderSheet(opts, n, plan, prepared);
            // eslint-disable-next-line no-await-in-loop
            await onSheet(sheet, n, plan.numSheets);
            sheet.px = null; // let the buffer go before the next allocation
        }
        return plan.numSheets;
    }

    // ---- presentation / harness ------------------------------------------

    // Composite onto white, as _save_preview does for previews and PDF pages.
    function compositeOnWhite(px, w, h) {
        const out = new Uint8Array(w * h * 4);
        for (let i = 0; i < px.length; i += 4) {
            const a = px[i + 3];
            if (a === 255) {
                out[i] = px[i];
                out[i + 1] = px[i + 1];
                out[i + 2] = px[i + 2];
            } else if (a === 0) {
                out[i] = 255;
                out[i + 1] = 255;
                out[i + 2] = 255;
            } else {
                // Pillow's paste with an alpha mask: white * (255-a) + c * a.
                out[i] = Place.blend(a, 255, px[i]);
                out[i + 1] = Place.blend(a, 255, px[i + 1]);
                out[i + 2] = Place.blend(a, 255, px[i + 2]);
            }
            out[i + 3] = 255;
        }
        return out;
    }

    function toCanvas(sheet) {
        return Place.toCanvas(sheet.px, sheet.w, sheet.h);
    }

    // SHA-256 over raw RGBA, for tools/parity.
    async function digestBytes(px) {
        const digest = await crypto.subtle.digest('SHA-256', px);
        return Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    }

    return {
        emptySheet,
        fillBand,
        bandStart,
        hLine,
        vLine,
        rectOutline,
        dashedLine,
        drawOverlays,
        cropVertical,
        sheetHeight,
        renderEmptyTemplate,
        renderSlotOverlay,
        hexToRgba,
        planSlots,
        prepareEntries,
        sheetLabel,
        renderSheet,
        renderSheets,
        compositeOnWhite,
        toCanvas,
        digestBytes,
    };
})();
