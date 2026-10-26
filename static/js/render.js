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
    //
    // bleedPx is how far the print reaches beyond the label. Left undefined it
    // falls back to the slot opening, which is the maximum bleed -- the old
    // behaviour, kept so existing parity fixtures still compare.
    //
    // sf renders the overlay AT the wanted scale rather than full size, exactly
    // as the Python does. This matters: the preview is a quarter scale, and a
    // 2 px line shrunk by four afterwards mostly vanishes -- it was losing about
    // 70% of the outline, which is why edges went missing. Scaling here keeps
    // the line at max(1, round(2 * sf)), so it never falls below a whole pixel.
    function renderSlotOverlay(logoSize, outputSize, layer, bleedPx, sf) {
        const s = (sf === undefined || sf === null) ? 1.0 : sf;
        const tmpl = SHEET_TEMPLATES[logoSize];
        const w = Place.pyRound(SHEET_CANVAS.width * s);
        const h = Place.pyRound(SHEET_CANVAS.height_22x24 * s);
        const px = emptySheet(w, h);

        const sw = Place.pyRound(tmpl.slot_w * s);
        const sh = Place.pyRound(tmpl.slot_h * s);
        const logoW = Place.pyRound(tmpl.logo_w * s);
        const logoH = Place.pyRound(tmpl.logo_h * s);
        const lw = Math.max(1, Place.pyRound(2 * s));
        const red = [255, 0, 0, 200];
        const green = [0, 200, 0, 200];

        // The printed area is the label plus the bleed on every side, so at
        // 0.00" this lands exactly on the green logo outline.
        let bleedW, bleedH;
        if (bleedPx === undefined || bleedPx === null) {
            bleedW = sw;
            bleedH = sh;
        } else {
            const bp = Place.pyRound(bleedPx * s);
            bleedW = logoW + bp * 2;
            bleedH = logoH + bp * 2;
        }

        for (const [cx, cy] of tmpl.slot_centers) {
            const scx = Place.pyRound(cx * s);
            const scy = Place.pyRound(cy * s);
            if (layer === 'bleed' || layer === 'both') {
                const x0 = scx - Math.floor(bleedW / 2);
                const y0 = scy - Math.floor(bleedH / 2);
                rectOutline(px, w, h, x0, y0,
                            x0 + bleedW - 1, y0 + bleedH - 1, lw, red);
            }
            if (layer === 'logo' || layer === 'both') {
                const x0 = scx - Math.floor(logoW / 2);
                const y0 = scy - Math.floor(logoH / 2);
                rectOutline(px, w, h, x0, y0,
                            x0 + logoW - 1, y0 + logoH - 1, lw, green);
            }
        }

        return outputSize === '22x22'
            ? cropVertical(px, w, h, Place.pyRound(SHEET_CANVAS.crop_px * s))
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

    // ---- packed layout ----------------------------------------------------

    // An alternative to the jig slots: pack logos as tightly as the size allows
    // inside each jig half, with a chosen gap, and print a dotted cut line in
    // every gap so the sheet can be cut up by hand.
    //
    // Mirrors packed_grid() / packed_slot_centers() / _draw_packed_overlays()
    // and generate_packed_sheet() in core/generator.py; see
    // PLAN_packed_layout.md for the decisions behind it.

    const CUT_LINE = [255, 0, 0, 255];
    const CUT_DASH = 6;   // finer than the registration dashes, so it reads dotted
    const CUT_GAP = 6;

    /**
     * The grid for one jig half. Tries the logo both ways round and keeps
     * whichever fits more, preferring upright on a tie. Null when none fit.
     */
    function packedGrid(tmpl, gapPx) {
        const [x0, y0, x1, y1] = tmpl.jig_outlines[0];
        const areaW = x1 - x0;
        const areaH = y1 - y0;

        let best = null;
        for (const turned of [false, true]) {
            const lw = turned ? tmpl.logo_h : tmpl.logo_w;
            const lh = turned ? tmpl.logo_w : tmpl.logo_h;

            const usableW = areaW - 2 * gapPx;
            const usableH = areaH - 2 * gapPx;
            if (usableW < lw || usableH < lh) continue;

            const cols = Math.floor((usableW + gapPx) / (lw + gapPx));
            const rows = Math.floor((usableH + gapPx) / (lh + gapPx));
            if (cols < 1 || rows < 1) continue;

            const perHalf = cols * rows;
            // Strictly greater, so upright wins a tie.
            if (best === null || perHalf > best.per_half) {
                const gridW = cols * lw + (cols - 1) * gapPx;
                const gridH = rows * lh + (rows - 1) * gapPx;
                best = {
                    turned, logo_w: lw, logo_h: lh, cols, rows,
                    per_half: perHalf,
                    per_sheet: perHalf * tmpl.jig_outlines.length,
                    grid_w: gridW, grid_h: gridH,
                    // Centred, so the leftover is split rather than all landing
                    // on the right and bottom edges.
                    pad_x: Math.floor((areaW - gridW) / 2),
                    pad_y: Math.floor((areaH - gridH) / 2),
                    gap: gapPx,
                };
            }
        }
        return best;
    }

    /** Every logo position on a sheet, first half then second. */
    function packedSlotCenters(tmpl, grid) {
        const centers = [];
        for (const [x0, y0] of tmpl.jig_outlines) {
            const ox = x0 + grid.pad_x;
            const oy = y0 + grid.pad_y;
            for (let r = 0; r < grid.rows; r++) {
                for (let c = 0; c < grid.cols; c++) {
                    centers.push([
                        ox + c * (grid.logo_w + grid.gap) + Math.floor(grid.logo_w / 2),
                        oy + r * (grid.logo_h + grid.gap) + Math.floor(grid.logo_h / 2),
                    ]);
                }
            }
        }
        return centers;
    }

    // Jig outlines, separator and cut lines. No registration marks: those mark
    // slot positions, which mean nothing in this layout.
    function drawPackedOverlays(px, w, h, tmpl, grid, sf) {
        const s = (v) => pyRound(v * sf);
        const lw = Math.max(1, pyRound(3 * sf));
        const lw2 = Math.max(1, pyRound(2 * sf));

        for (const [x0, y0, x1, y1] of tmpl.jig_outlines) {
            rectOutline(px, w, h, s(x0), s(y0), s(x1), s(y1), lw, BLUE);
        }
        hLine(px, w, h, s(tmpl.separator_y), 0, s(SHEET_CANVAS.width), lw2, CYAN);

        const halfGap = Math.floor(grid.gap / 2);
        for (const [x0, y0] of tmpl.jig_outlines) {
            const ox = x0 + grid.pad_x;
            const oy = y0 + grid.pad_y;
            const top = oy - halfGap;
            const bottom = oy + grid.grid_h + halfGap;
            const left = ox - halfGap;
            const right = ox + grid.grid_w + halfGap;

            // cols + 1 verticals and rows + 1 horizontals, so every logo is boxed.
            for (let c = 0; c <= grid.cols; c++) {
                const x = ox - halfGap + c * (grid.logo_w + grid.gap);
                dashedLine(px, w, h, s(x), s(top), s(x), s(bottom),
                           lw2, CUT_DASH, CUT_GAP, CUT_LINE);
            }
            for (let r = 0; r <= grid.rows; r++) {
                const y = oy - halfGap + r * (grid.logo_h + grid.gap);
                dashedLine(px, w, h, s(left), s(y), s(right), s(y),
                           lw2, CUT_DASH, CUT_GAP, CUT_LINE);
            }
        }
    }

    function planPackedSlots(logoEntries, logoSize, gapPx) {
        const tmpl = SHEET_TEMPLATES[logoSize];
        const grid = packedGrid(tmpl, gapPx);
        if (!grid) return null;

        const centers = packedSlotCenters(tmpl, grid);
        const flatSlots = [];
        logoEntries.forEach((entry, entryIdx) => {
            const overlay = entry.textOverlay;
            const vd = entry.variableData;
            const qty = entry.quantity === undefined ? 1 : entry.quantity;
            for (let i = 0; i < qty; i++) {
                flatSlots.push([entryIdx, (overlay && vd && i < vd.length) ? vd[i] : null]);
            }
        });

        return {
            grid, centers, flatSlots,
            slotsPerSheet: centers.length,
            numSheets: Math.max(1, Math.ceil(flatSlots.length / centers.length)),
        };
    }

    // No bleed here: there is no slot opening for it to fill.
    function preparePackedEntries(logoEntries, logoSize, grid) {
        const tmpl = SHEET_TEMPLATES[logoSize];
        return logoEntries.map((entry) => {
            const prepared = Place.prepareLogo(entry.px, entry.w, entry.h, tmpl, 0, {
                logoScale: entry.logoScale,
                offsetX: entry.offsetX,
                offsetY: entry.offsetY,
                rotation: entry.rotation,
                applyTemplateRotation: false,
            });
            if (!grid.turned) return prepared;
            const r = Place.rotateExpand(prepared.px, prepared.w, prepared.h, 90);
            return { px: r.px, w: r.w, h: r.h, inexact: prepared.inexact };
        });
    }

    function renderPackedSheet(opts, sheetNum, plan, prepared) {
        const { logoEntries, logoSize, outputSize, projectName } = opts;
        const tmpl = SHEET_TEMPLATES[logoSize];
        const w = SHEET_CANVAS.width;
        const h = SHEET_CANVAS.height_22x24;
        const px = emptySheet(w, h);

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

            const [cx, cy] = plan.centers[slotIdx];
            const dx = cx - Math.floor(slot.w / 2);
            const dy = cy - Math.floor(slot.h / 2);

            const bg = hexToRgba(entry.background);
            if (bg) {
                Place.fillRect(px, w, h, dx, dy, dx + slot.w - 1, dy + slot.h - 1, bg);
                Place.alphaComposite(px, w, h, img.px, img.w, img.h, dx, dy);
            } else {
                Place.pasteOpaqueMask(px, w, h, img.px, img.w, img.h, dx, dy);
            }
        }

        drawPackedOverlays(px, w, h, tmpl, plan.grid, 1.0);
        SheetText.drawProjectName(px, w, h,
            sheetLabel(projectName || '', sheetNum, plan.numSheets));

        return outputSize === '22x22'
            ? cropVertical(px, w, h, SHEET_CANVAS.crop_px)
            : { px, w, h };
    }

    /**
     * Render every packed sheet, handing each to onSheet() and dropping it
     * before the next, exactly as renderSheets() does.
     *
     * @param {number} opts.gap space between logos, in inches
     */
    async function renderPackedSheets(opts, onSheet) {
        const gapPx = pyRound(parseFloat(opts.gap) * SHEET_CANVAS.dpi);
        const plan = planPackedSlots(opts.logoEntries, opts.logoSize, gapPx);
        if (!plan) {
            throw new Error(
                `A gap of ${opts.gap}" leaves no room for a logo this size.`);
        }
        const prepared = preparePackedEntries(opts.logoEntries, opts.logoSize, plan.grid);

        for (let n = 0; n < plan.numSheets; n++) {
            const sheet = renderPackedSheet(opts, n, plan, prepared);
            // eslint-disable-next-line no-await-in-loop
            await onSheet(sheet, n, plan.numSheets);
            sheet.px = null;
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
        packedGrid,
        packedSlotCenters,
        drawPackedOverlays,
        planPackedSlots,
        renderPackedSheet,
        renderPackedSheets,
        compositeOnWhite,
        toCanvas,
        digestBytes,
    };
})();
