// Logo placement, as a byte-exact port of _prepare_logo() and the slot
// compositing in generate_transfer_sheet().
//
// Everything here works on plain Uint8Array RGBA buffers rather than canvases.
// That is deliberate: a canvas stores premultiplied pixels, so routing logo
// data through drawImage/getImageData shifts partially transparent pixels and
// destroys parity. Canvas is used only to decode the uploaded file and, at the
// very end, to show or export the finished sheet.
//
// The Pillow behaviours reproduced here were each verified against Pillow
// directly (see the probes in tools/parity/):
//
//   * paste(im, box, im) — passing an RGBA image as its OWN mask, which
//     _prepare_logo does — blends with BLEND(mask, dst, src) per channel
//     INCLUDING alpha. Against a transparent destination that squares the
//     alpha (a=64 becomes 16) and premultiplies the colour. It is lossless for
//     hard-edged logos and fades antialiased edges. It is existing behaviour,
//     so it is reproduced rather than fixed.
//   * paste with an all-255 L mask is a straight overwrite of all four channels.
//   * alpha_composite is source-over with Pillow's own rounded integer maths.
//   * rotate(0|90|180|270, expand=True) takes a lossless transpose fast path
//     even when BICUBIC is requested. Only other angles resample.
//
// Rounding: Python's round() is round-half-to-EVEN, JavaScript's Math.round is
// round-half-up. They disagree on exact .5, which the fit maths can produce, so
// pyRound() below is used wherever the Python uses round().

const Place = (function () {
    'use strict';

    // ---- helpers ----------------------------------------------------------

    // Python's round(): ties go to the even integer.
    function pyRound(v) {
        const f = Math.floor(v);
        const diff = v - f;
        if (diff > 0.5) return f + 1;
        if (diff < 0.5) return f;
        return f % 2 === 0 ? f : f + 1;
    }

    // Pillow's DIV255: a rounded (a / 255).
    function div255(a) {
        const tmp = a + 128;
        return ((tmp >> 8) + tmp) >> 8;
    }

    // Pillow's BLEND macro.
    function blend(mask, in1, in2) {
        return div255(in1 * (255 - mask) + in2 * mask);
    }

    function emptyRGBA(w, h) {
        return new Uint8Array(w * h * 4);
    }

    // ---- exact rotations (Pillow's transpose fast paths) ------------------

    // Transpose.ROTATE_90 is counter-clockwise: input (x, y) lands at
    // output (y, w - 1 - x) in an h-by-w image.
    function rotate90(px, w, h) {
        const out = emptyRGBA(h, w);
        const outW = h;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const si = (y * w + x) * 4;
                const di = ((w - 1 - x) * outW + y) * 4;
                out[di] = px[si];
                out[di + 1] = px[si + 1];
                out[di + 2] = px[si + 2];
                out[di + 3] = px[si + 3];
            }
        }
        return { px: out, w: h, h: w };
    }

    function rotate180(px, w, h) {
        const out = emptyRGBA(w, h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const si = (y * w + x) * 4;
                const di = ((h - 1 - y) * w + (w - 1 - x)) * 4;
                out[di] = px[si];
                out[di + 1] = px[si + 1];
                out[di + 2] = px[si + 2];
                out[di + 3] = px[si + 3];
            }
        }
        return { px: out, w, h };
    }

    function rotate270(px, w, h) {
        const out = emptyRGBA(h, w);
        const outW = h;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const si = (y * w + x) * 4;
                const di = (x * outW + (h - 1 - y)) * 4;
                out[di] = px[si];
                out[di + 1] = px[si + 1];
                out[di + 2] = px[si + 2];
                out[di + 3] = px[si + 3];
            }
        }
        return { px: out, w: h, h: w };
    }

    // Pillow's expand bounding box: ceil(max) - floor(min) over rotated corners.
    function expandedSize(w, h, degrees) {
        const rad = (degrees * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const xs = [];
        const ys = [];
        for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
            xs.push(x * cos + y * sin);
            ys.push(-x * sin + y * cos);
        }
        return {
            w: Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs)),
            h: Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys)),
        };
    }

    // Arbitrary-angle rotation. NOT byte-exact: Pillow uses its own bicubic
    // affine resampler, which is not ported yet, so this falls back to the
    // browser's. Geometry (the expanded bounding box) does match. Cases using
    // it are reported as Tier C by the parity harness.
    function rotateArbitrary(px, w, h, degrees) {
        const size = expandedSize(w, h, degrees);
        const src = document.createElement('canvas');
        src.width = w;
        src.height = h;
        src.getContext('2d').putImageData(
            new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);

        const dst = document.createElement('canvas');
        dst.width = size.w;
        dst.height = size.h;
        const ctx = dst.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.translate(size.w / 2, size.h / 2);
        ctx.rotate((-degrees * Math.PI) / 180);
        ctx.drawImage(src, -w / 2, -h / 2);

        const data = ctx.getImageData(0, 0, size.w, size.h).data;
        src.width = src.height = 0;
        dst.width = dst.height = 0;
        return { px: new Uint8Array(data), w: size.w, h: size.h, inexact: true };
    }

    // Dispatch matching Image.rotate(angle, expand=True): exact for the
    // quarter turns, resampled otherwise.
    function rotateExpand(px, w, h, degrees) {
        const a = ((degrees % 360) + 360) % 360;
        if (a === 0) return { px, w, h };
        if (a === 90) return rotate90(px, w, h);
        if (a === 180) return rotate180(px, w, h);
        if (a === 270) return rotate270(px, w, h);
        return rotateArbitrary(px, w, h, a);
    }

    // ---- compositing ------------------------------------------------------

    // paste(src, (x, y), src): src is its own mask. Clipped to the destination
    // like Pillow's paste.
    function pasteSelfMask(dst, dw, dh, src, sw, sh, x, y) {
        for (let sy = 0; sy < sh; sy++) {
            const dy = y + sy;
            if (dy < 0 || dy >= dh) continue;
            for (let sx = 0; sx < sw; sx++) {
                const dx = x + sx;
                if (dx < 0 || dx >= dw) continue;
                const si = (sy * sw + sx) * 4;
                const di = (dy * dw + dx) * 4;
                const mask = src[si + 3];
                dst[di] = blend(mask, dst[di], src[si]);
                dst[di + 1] = blend(mask, dst[di + 1], src[si + 1]);
                dst[di + 2] = blend(mask, dst[di + 2], src[si + 2]);
                dst[di + 3] = blend(mask, dst[di + 3], src[si + 3]);
            }
        }
    }

    // paste(src, (x, y), all-255 mask): straight overwrite of all channels.
    function pasteOpaqueMask(dst, dw, dh, src, sw, sh, x, y) {
        for (let sy = 0; sy < sh; sy++) {
            const dy = y + sy;
            if (dy < 0 || dy >= dh) continue;
            for (let sx = 0; sx < sw; sx++) {
                const dx = x + sx;
                if (dx < 0 || dx >= dw) continue;
                const si = (sy * sw + sx) * 4;
                const di = (dy * dw + dx) * 4;
                dst[di] = src[si];
                dst[di + 1] = src[si + 1];
                dst[di + 2] = src[si + 2];
                dst[di + 3] = src[si + 3];
            }
        }
    }

    // Image.alpha_composite(src, (x, y)) — Pillow's rounded integer source-over.
    function alphaComposite(dst, dw, dh, src, sw, sh, x, y) {
        for (let sy = 0; sy < sh; sy++) {
            const dy = y + sy;
            if (dy < 0 || dy >= dh) continue;
            for (let sx = 0; sx < sw; sx++) {
                const dx = x + sx;
                if (dx < 0 || dx >= dw) continue;
                const si = (sy * sw + sx) * 4;
                const di = (dy * dw + dx) * 4;

                const sa = src[si + 3];
                if (sa === 0) continue;                 // keep destination
                const da = dst[di + 3];
                if (da === 0 || sa === 255) {           // take source
                    dst[di] = src[si];
                    dst[di + 1] = src[si + 1];
                    dst[di + 2] = src[si + 2];
                    dst[di + 3] = sa;
                    continue;
                }
                const bl = da * (255 - sa);
                const outa = sa * 255 + bl;
                const half = outa >> 1;
                for (let c = 0; c < 3; c++) {
                    const tmp = src[si + c] * sa * 255 + dst[di + c] * bl;
                    dst[di + c] = Math.floor((tmp + half) / outa);
                }
                dst[di + 3] = Math.floor((outa + 127) / 255);
            }
        }
    }

    // ImageDraw.rectangle(fill=...) with inclusive bounds, clipped.
    function fillRect(dst, dw, dh, x0, y0, x1, y1, rgba) {
        const xa = Math.max(0, x0);
        const xb = Math.min(dw - 1, x1);
        const ya = Math.max(0, y0);
        const yb = Math.min(dh - 1, y1);
        for (let y = ya; y <= yb; y++) {
            for (let x = xa; x <= xb; x++) {
                const i = (y * dw + x) * 4;
                dst[i] = rgba[0];
                dst[i + 1] = rgba[1];
                dst[i + 2] = rgba[2];
                dst[i + 3] = rgba[3];
            }
        }
    }

    // ---- the _prepare_logo port -------------------------------------------

    /**
     * Fit one logo into its slot. Mirrors _prepare_logo() at sf = 1.
     *
     * The preview path in the Python ran at sf = 0.25 and carried an odd-pixel
     * adjustment to go with it; the browser renders at full scale and scales
     * for display instead, so that branch has no equivalent here.
     *
     * @returns {{px: Uint8Array, w: number, h: number, inexact: boolean}}
     */
    function prepareLogo(srcPx, srcW, srcH, tmpl, bleedPx, opts) {
        const options = opts || {};
        const logoScale = options.logoScale === undefined ? 1.0 : options.logoScale;
        const offsetX = options.offsetX || 0;
        const offsetY = options.offsetY || 0;
        const rotation = options.rotation || 0;

        const placedW = tmpl.logo_w + 2 * bleedPx;
        const placedH = tmpl.logo_h + 2 * bleedPx;

        let px = srcPx;
        let w = srcW;
        let h = srcH;
        let inexact = false;

        // The Python rotates by -rotation because the editor's convention is
        // clockwise while Pillow's positive angles are counter-clockwise.
        if (rotation % 360 !== 0) {
            const r = rotateExpand(px, w, h, -rotation);
            px = r.px;
            w = r.w;
            h = r.h;
            inexact = Boolean(r.inexact);
        }

        const pw = Math.max(1, pyRound(placedW));
        const ph = Math.max(1, pyRound(placedH));

        // Rotate-then-fit: the rotated bounding box is fitted into the placed
        // area so the whole logo stays visible at any angle.
        const imgAspect = w / h;
        const boxAspect = pw / ph;
        let scaledW;
        let scaledH;
        if (imgAspect > boxAspect) {
            scaledW = pw;
            scaledH = Math.max(1, pyRound(pw / imgAspect));
        } else {
            scaledH = ph;
            scaledW = Math.max(1, pyRound(ph * imgAspect));
        }
        scaledW = Math.max(1, pyRound(scaledW * logoScale));
        scaledH = Math.max(1, pyRound(scaledH * logoScale));

        const resized = Resample.resizeRGBA(px, w, h, scaledW, scaledH);

        const placed = emptyRGBA(pw, ph);
        const pasteX = Math.floor((pw - scaledW) / 2) + pyRound(offsetX);
        const pasteY = Math.floor((ph - scaledH) / 2) + pyRound(offsetY);
        pasteSelfMask(placed, pw, ph, resized, scaledW, scaledH, pasteX, pasteY);

        if (tmpl.rotate) {
            const r = rotateExpand(placed, pw, ph, tmpl.rotate);
            return { px: r.px, w: r.w, h: r.h, inexact };
        }
        return { px: placed, w: pw, h: ph, inexact };
    }

    // ---- canvas interop ---------------------------------------------------

    // Decode an HTMLImageElement to raw RGBA. This is the one unavoidable
    // canvas round-trip, and it matches what the Flask app already receives:
    // main.js normalises every upload through a canvas before sending it.
    function decodeImage(img) {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        const out = { px: new Uint8Array(data), w: c.width, h: c.height };
        c.width = c.height = 0;
        return out;
    }

    function toCanvas(px, w, h) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').putImageData(
            new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
        return c;
    }

    return {
        pyRound,
        div255,
        blend,
        emptyRGBA,
        rotate90,
        rotate180,
        rotate270,
        rotateExpand,
        expandedSize,
        pasteSelfMask,
        pasteOpaqueMask,
        alphaComposite,
        fillRect,
        prepareLogo,
        decodeImage,
        toCanvas,
    };
})();
