// Text overlays and the rotated project label.
//
// Port of _draw_text_on_slot() and _draw_project_name(). Unlike the geometry
// and logo paths this one cannot be byte-exact: Pillow rasterises glyphs with
// FreeType and the browser uses its own rasteriser, so antialiased edges always
// differ slightly. The parity harness treats text as Tier C — it checks
// placement and extent within a tolerance and leaves rasterisation to a one-off
// visual review.
//
// Layout, however, is matched closely, and that took measuring Pillow to get
// right:
//
//   * Pillow has no HarfBuzz/Raqm here (features.check("raqm") is False), so it
//     lays text out with NO KERNING and its whole-string advance is exactly the
//     sum of the per-glyph advances. Canvas kerns by default, which made long
//     strings ~3% narrower than the Python. So text is laid out glyph by glyph
//     at integer advances, with fontKerning disabled, which reproduces Pillow's
//     model instead of the browser's.
//   * Every Pillow per-glyph advance is an integer, because FreeType grid-fits
//     each glyph. Rounding the browser's fractional advance per glyph gets
//     within about a pixel per glyph but not always exactly: FreeType's hinted
//     advance is not a plain rounding of the linear one. The residual is a few
//     pixels over a whole string — about 0.01" at 300 DPI — and is the
//     irreducible part of the Tier C tolerance.
//   * Vertical anchor 't' aligns the INK TOP to y, not the ascender line, and
//     horizontal l/m/r align the pen origin on the advance width. Both measured
//     against Pillow.
//   * The rotated branch builds a bitmap 4px larger than the ink box with the
//     ink at (2, 2), then pastes it with ITSELF as the mask, which squares edge
//     alpha. Reproduced, quirk included.
//
// Fonts must be loaded before anything is measured or metrics come back for a
// fallback face: await ensureFonts() first.

const SheetText = (function () {
    'use strict';

    const WEIGHT_CSS = { regular: '400', bold: '700' };

    // Families declared in static/css/fonts.css (generated from fonts.json).
    const FAMILIES = ['Helvetica', 'Arial', 'Times New Roman', 'Courier',
                      'Georgia', 'Verdana'];

    function fontSpec(size, family, weight) {
        const w = WEIGHT_CSS[weight] || WEIGHT_CSS.regular;
        return `${w} ${size}px "${family}"`;
    }

    async function ensureFonts() {
        if (!document.fonts) return;
        const jobs = [];
        for (const family of FAMILIES) {
            for (const weight of Object.keys(WEIGHT_CSS)) {
                jobs.push(document.fonts.load(fontSpec(64, family, weight))
                    .catch(() => {}));
            }
        }
        await Promise.all(jobs);
        await document.fonts.ready;
    }

    function makeCtx(w, h) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        // Pillow does not kern; neither do we.
        ctx.fontKerning = 'none';
        return ctx;
    }

    let _measureCtx = null;
    function measureCtx() {
        if (!_measureCtx) _measureCtx = makeCtx(1, 1);
        return _measureCtx;
    }

    /**
     * Lay out one string the way Pillow does: glyph by glyph, no kerning, each
     * advance rounded to an integer.
     *
     * @returns {{glyphs: Array, advance: number, inkLeft: number,
     *            inkRight: number, ascent: number, descent: number}}
     */
    function layout(text, size, family, weight) {
        const ctx = measureCtx();
        ctx.font = fontSpec(size, family, weight);
        ctx.fontKerning = 'none';

        const glyphs = [];
        let pen = 0;
        let inkLeft = Infinity;
        let inkRight = -Infinity;
        let ascent = 0;
        let descent = 0;

        for (const ch of text) {
            const m = ctx.measureText(ch);
            glyphs.push({ ch, x: pen });
            // A glyph drawn at pen spans [pen - left, pen + right].
            if (m.actualBoundingBoxRight !== undefined) {
                inkLeft = Math.min(inkLeft, pen - m.actualBoundingBoxLeft);
                inkRight = Math.max(inkRight, pen + m.actualBoundingBoxRight);
                ascent = Math.max(ascent, m.actualBoundingBoxAscent);
                descent = Math.max(descent, m.actualBoundingBoxDescent);
            }
            pen += Math.round(m.width);
        }

        if (!glyphs.length || inkLeft === Infinity) {
            inkLeft = 0;
            inkRight = 0;
        }
        return { glyphs, advance: pen, inkLeft, inkRight, ascent, descent };
    }

    /**
     * Metrics in the terms Pillow reports them.
     *
     * Careful: Pillow's textbbox() is NOT the ink box horizontally. Measured
     * against Pillow, its x-extent is [0, advance] — the ADVANCE box — while
     * its y-extent is ink-based. So the temp bitmap is advance-wide with the
     * pen at x = 2, and the glyph ink sits further right by its own left side
     * bearing (5px for "P" at 42px, which textbbox reports as 0). Sizing the
     * bitmap to the tight ink box instead shifts text by a few pixels.
     */
    function measureInk(text, size, family, weight) {
        const L = layout(text, size, family, weight);
        return {
            left: -L.inkLeft,          // positive when ink starts left of the pen
            right: L.inkRight,
            ascent: L.ascent,
            descent: L.descent,
            advance: L.advance,
            boxW: Math.ceil(L.advance),              // Pillow's textbbox width
            inkH: Math.ceil(L.ascent + L.descent),   // Pillow's textbbox height
            layout: L,
        };
    }

    /**
     * Render text into its own RGBA bitmap laid out like the temp image
     * _draw_text_on_slot builds: 4px larger than Pillow's textbbox on each
     * axis, with the PEN ORIGIN at x = 2 and the ink top at y = 2.
     */
    function renderTextBitmap(text, size, family, weight, rgba) {
        const m = measureInk(text, size, family, weight);
        const w = Math.max(1, m.boxW + 4);
        const h = Math.max(1, m.inkH + 4);

        const ctx = makeCtx(w, h);
        ctx.font = fontSpec(size, family, weight);
        ctx.fontKerning = 'none';
        ctx.fillStyle = `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3] / 255})`;

        // Pen origin at x = 2, baseline placed so the ink top lands on y = 2.
        const originX = 2;
        const originY = 2 + m.ascent;
        for (const g of m.layout.glyphs) {
            ctx.fillText(g.ch, originX + g.x, originY);
        }

        const data = ctx.getImageData(0, 0, w, h).data;
        ctx.canvas.width = ctx.canvas.height = 0;
        return { px: new Uint8Array(data), w, h, metrics: m };
    }

    // Pillow's _parse_hex_color: strict #RRGGBB, otherwise opaque white.
    function parseHexColor(value) {
        if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())) {
            const v = value.trim();
            return [parseInt(v.slice(1, 3), 16),
                    parseInt(v.slice(3, 5), 16),
                    parseInt(v.slice(5, 7), 16), 255];
        }
        return [255, 255, 255, 255];
    }

    /**
     * Port of _draw_text_on_slot(). Returns a NEW pixel buffer, matching the
     * Python's slot_img.copy(); the input is not modified.
     *
     * Text coordinates are in pre-rotation (editor) space, so for a rotated
     * template they are transformed exactly as the Python transforms them.
     */
    function drawTextOnSlot(slotPx, slotW, slotH, overlay, value, tmpl) {
        if (!value) return { px: slotPx, w: slotW, h: slotH };

        const size = Math.max(4, Place.pyRound(overlay.font_size));
        const family = overlay.font_family || 'Helvetica';
        const weight = overlay.font_weight || 'regular';
        const color = parseHexColor(overlay.color);
        const alignment = overlay.alignment || 'center';

        const tx = Place.pyRound(overlay.x);
        const ty = Place.pyRound(overlay.y);

        const out = new Uint8Array(slotPx);
        const bmp = renderTextBitmap(value, size, family, weight, color);

        if (tmpl.rotate) {
            const rot = Place.rotateExpand(bmp.px, bmp.w, bmp.h, tmpl.rotate);

            // Pre-rotation (tx, ty) -> post-rotation coordinates.
            const pwPre = slotH;
            const rx = ty;
            const ry = pwPre - tx;

            let pasteX;
            if (alignment === 'center') pasteX = rx - Math.floor(rot.w / 2);
            else if (alignment === 'right') pasteX = rx - rot.w;
            else pasteX = rx;
            const pasteY = ry - Math.floor(rot.h / 2);

            Place.alphaComposite(out, slotW, slotH, rot.px, rot.w, rot.h,
                                pasteX, pasteY);
            return { px: out, w: slotW, h: slotH };
        }

        // Unrotated: the Python draws onto the slot with an anchor, which
        // composites source-over rather than self-mask pasting.
        const m = bmp.metrics;
        let penX;
        if (alignment === 'center') penX = tx - m.advance / 2;
        else if (alignment === 'right') penX = tx - m.advance;
        else penX = tx;

        // The bitmap carries its pen origin at x = 2 and its ink top at y = 2;
        // anchor 't' puts the ink top at ty.
        const destX = Math.round(penX) - 2;
        const destY = ty - 2;
        Place.alphaComposite(out, slotW, slotH, bmp.px, bmp.w, bmp.h,
                             destX, destY);
        return { px: out, w: slotW, h: slotH };
    }

    /**
     * Port of _draw_project_name(). Draws the label rotated 90 degrees CCW in
     * the ~1" left margin of each jig half, so each half stays identified once
     * the sheet is cut and the label survives the 22x22 crop.
     *
     * Mutates sheetPx in place, as the Python mutates its canvas.
     */
    function drawProjectName(sheetPx, sheetW, sheetH, name) {
        if (!name) return;

        const size = Math.max(8, Place.pyRound(42));
        const bmp = renderTextBitmap(name, size, 'Helvetica', 'regular',
                                     [0, 0, 0, 255]);
        const rot = Place.rotateExpand(bmp.px, bmp.w, bmp.h, 90);

        const marginW = 300;
        const pasteX = Math.floor((marginW - rot.w) / 2);

        for (const [yTop, yBot] of [[300, 3600], [3600, 6900]]) {
            const halfH = yBot - yTop;
            const pasteY = yTop + Math.floor((halfH - rot.h) / 2);
            Place.alphaComposite(sheetPx, sheetW, sheetH, rot.px, rot.w, rot.h,
                                pasteX, pasteY);
        }
    }

    return {
        ensureFonts,
        fontSpec,
        layout,
        measureInk,
        renderTextBitmap,
        parseHexColor,
        drawTextOnSlot,
        drawProjectName,
        FAMILIES,
    };
})();
