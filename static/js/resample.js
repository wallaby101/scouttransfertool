// Byte-exact port of Pillow's LANCZOS resize.
//
// The browser's own drawImage() downscaling is bilinear and differs visibly
// from Pillow's Lanczos, so logos resized in the browser would not match the
// sheets this app has been printing. This file reproduces Pillow's resampler
// instead, so placed logos come out byte-identical.
//
// Three details are load-bearing; see tools/parity/pillow_lanczos.py, which is
// the same algorithm in Python and is checked against Pillow directly:
//
//   1. Image.resize() returns a plain copy when the target size equals the
//      source size, BEFORE any colour conversion. The premultiply round-trip in
//      (2) is lossy for partial alpha, so skipping this makes same-size
//      resizes wrong.
//   2. For RGBA, Pillow converts to premultiplied "RGBa", resamples, then
//      converts back. Resampling straight RGBA gives different edge pixels.
//   3. The convolution is 22-bit fixed point: weights round half-away-from-
//      zero, each accumulator starts at a rounding bias of 1 << 21, and clip8
//      inspects the UNSHIFTED accumulator.
//
// Everything works on plain Uint8Array RGBA buffers rather than canvases on
// purpose: a canvas stores premultiplied pixels, so a getImageData/putImageData
// round-trip can shift partially transparent pixels by a step and destroy the
// parity this file exists to provide.

const Resample = (function () {
    'use strict';

    const PRECISION_BITS = 32 - 8 - 2; // 22
    const BIAS = 1 << (PRECISION_BITS - 1);
    const CLIP_CEIL = 1 << (PRECISION_BITS + 8);

    function sinc(x) {
        if (x === 0.0) return 1.0;
        const t = x * Math.PI;
        return Math.sin(t) / t;
    }

    // Pillow's lanczos_filter: sinc(x) * sinc(x / 3), support 3.
    function lanczos(x) {
        if (x < 0.0) x = -x;
        return x < 3.0 ? sinc(x) * sinc(x / 3.0) : 0.0;
    }

    // normalize_coeffs_8bpc: (int)(+/-0.5 + v * 2**22), truncating toward zero.
    function normCoeff(v) {
        const scaled = v * (1 << PRECISION_BITS);
        return v >= 0 ? Math.trunc(0.5 + scaled) : Math.trunc(-0.5 + scaled);
    }

    // Pillow's clip8 macro, which takes the accumulator BEFORE the shift.
    function clip8(ss) {
        if (ss >= CLIP_CEIL) return 255;
        if (ss <= 0) return 0;
        return ss >> PRECISION_BITS;
    }

    // Pillow's MULDIV255.
    function muldiv255(a, b) {
        const tmp = a * b + 128;
        return ((tmp >> 8) + tmp) >> 8;
    }

    // RGBA -> RGBa, matching rgba2rgbA.
    function premultiply(px) {
        const out = new Uint8Array(px.length);
        for (let i = 0; i < px.length; i += 4) {
            const a = px[i + 3];
            out[i] = muldiv255(px[i], a);
            out[i + 1] = muldiv255(px[i + 1], a);
            out[i + 2] = muldiv255(px[i + 2], a);
            out[i + 3] = a;
        }
        return out;
    }

    // RGBa -> RGBA, matching rgbA2rgba. The 0/255 fast path is not an
    // optimisation: it is what keeps opaque pixels lossless.
    function unpremultiply(px) {
        const out = new Uint8Array(px.length);
        for (let i = 0; i < px.length; i += 4) {
            const a = px[i + 3];
            if (a === 255 || a === 0) {
                out[i] = px[i];
                out[i + 1] = px[i + 1];
                out[i + 2] = px[i + 2];
            } else {
                for (let c = 0; c < 3; c++) {
                    const v = Math.floor((255 * px[i + c]) / a);
                    out[i + c] = v < 0 ? 0 : (v > 255 ? 255 : v);
                }
            }
            out[i + 3] = a;
        }
        return out;
    }

    // Port of precompute_coeffs. Returns, per output pixel, the first input
    // index and its fixed-point weights.
    function precomputeCoeffs(inSize, outSize) {
        const scale = inSize / outSize;
        const filterscale = Math.max(1.0, scale);
        const support = 3.0 * filterscale;
        const inv = 1.0 / filterscale;

        const result = [];
        for (let xx = 0; xx < outSize; xx++) {
            const center = (xx + 0.5) * scale;

            let xmin = Math.trunc(center - support + 0.5);
            if (xmin < 0) xmin = 0;
            let xmax = Math.trunc(center + support + 0.5);
            if (xmax > inSize) xmax = inSize;
            xmax -= xmin;

            const k = new Float64Array(xmax);
            let ww = 0.0;
            for (let x = 0; x < xmax; x++) {
                const w = lanczos((x + xmin - center + 0.5) * inv);
                k[x] = w;
                ww += w;
            }

            const kk = new Int32Array(xmax);
            for (let x = 0; x < xmax; x++) {
                kk[x] = normCoeff(ww !== 0.0 ? k[x] / ww : k[x]);
            }
            result.push({ min: xmin, kk });
        }
        return result;
    }

    // Two-pass convolution over premultiplied data.
    function resamplePremultiplied(px, inW, inH, outW, outH) {
        const hc = precomputeCoeffs(inW, outW);
        const tmp = new Uint8Array(outW * inH * 4);

        for (let yy = 0; yy < inH; yy++) {
            const row = yy * inW * 4;
            const trow = yy * outW * 4;
            for (let xx = 0; xx < outW; xx++) {
                const { min, kk } = hc[xx];
                const base = row + min * 4;
                for (let c = 0; c < 4; c++) {
                    let ss = BIAS;
                    for (let i = 0; i < kk.length; i++) {
                        ss += px[base + i * 4 + c] * kk[i];
                    }
                    tmp[trow + xx * 4 + c] = clip8(ss);
                }
            }
        }

        const vc = precomputeCoeffs(inH, outH);
        const dst = new Uint8Array(outW * outH * 4);
        const stride = outW * 4;

        for (let yy = 0; yy < outH; yy++) {
            const { min, kk } = vc[yy];
            const drow = yy * stride;
            for (let xx = 0; xx < outW; xx++) {
                const base = min * stride + xx * 4;
                for (let c = 0; c < 4; c++) {
                    let ss = BIAS;
                    for (let i = 0; i < kk.length; i++) {
                        ss += tmp[base + i * stride + c] * kk[i];
                    }
                    dst[drow + xx * 4 + c] = clip8(ss);
                }
            }
        }
        return dst;
    }

    /**
     * Resize raw RGBA bytes exactly as Pillow's Image.resize(LANCZOS) would.
     * Returns a new Uint8Array; the input is not modified.
     */
    function resizeRGBA(px, inW, inH, outW, outH) {
        if (inW === outW && inH === outH) {
            return new Uint8Array(px); // Pillow's early copy
        }
        return unpremultiply(
            resamplePremultiplied(premultiply(px), inW, inH, outW, outH));
    }

    return {
        resizeRGBA,
        premultiply,
        unpremultiply,
        precomputeCoeffs,
        muldiv255,
        clip8,
        PRECISION_BITS,
    };
})();
