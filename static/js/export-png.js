// PNG encoder for finished sheets.
//
// Written by hand rather than using canvas.toBlob() for two reasons:
//
//   1. toBlob() does not write a pHYs chunk, so the exported file would carry
//      no resolution. The Python saves with dpi=(300, 300), which Pillow
//      records as pHYs = 11811 pixels/metre (11811 * 0.0254 = 299.9994 dpi).
//      A RIP that sizes by that tag would read the sheet as 96 dpi and scale
//      it wrongly.
//   2. Getting the pixels into a canvas at all means putImageData, and a
//      canvas stores premultiplied alpha. Partially transparent pixels — logo
//      edges, antialiased text — shift by a step on the round-trip. Encoding
//      straight from the Uint8Array keeps them exact.
//
// Output is colour type 6 (RGBA), 8 bits per channel, matching what Pillow
// writes. PNG is lossless, so this decodes to identical pixels even though the
// bytes differ from Pillow's (different filtering and deflate settings).
//
// Rows use the Up filter (2) after the first, which costs a few lines and
// compresses large flat and transparent regions far better than None.

const ExportPNG = (function () {
    'use strict';

    const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // Pillow's value for 300 dpi: round(300 / 0.0254).
    const PPU_300DPI = 11811;

    // ---- CRC32 (PNG chunk checksums; also used by export-zip.js) ----------

    let CRC_TABLE = null;
    function crcTable() {
        if (CRC_TABLE) return CRC_TABLE;
        CRC_TABLE = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            CRC_TABLE[n] = c >>> 0;
        }
        return CRC_TABLE;
    }

    function crc32(bytes, seed) {
        const table = crcTable();
        let c = (seed === undefined ? 0xffffffff : seed) >>> 0;
        for (let i = 0; i < bytes.length; i++) {
            c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        }
        return c >>> 0;
    }

    function crc32Final(bytes) {
        return (crc32(bytes) ^ 0xffffffff) >>> 0;
    }

    // ---- chunk assembly ---------------------------------------------------

    function be32(v) {
        return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff,
                               (v >>> 8) & 0xff, v & 0xff]);
    }

    function concat(parts) {
        let total = 0;
        for (const p of parts) total += p.length;
        const out = new Uint8Array(total);
        let at = 0;
        for (const p of parts) {
            out.set(p, at);
            at += p.length;
        }
        return out;
    }

    function chunk(type, data) {
        const typeBytes = new TextEncoder().encode(type);
        const body = concat([typeBytes, data]);
        return concat([be32(data.length), body, be32(crc32Final(body))]);
    }

    function ihdr(w, h) {
        const d = new Uint8Array(13);
        d.set(be32(w), 0);
        d.set(be32(h), 4);
        d[8] = 8;   // bit depth
        d[9] = 6;   // colour type 6: truecolour with alpha
        d[10] = 0;  // deflate
        d[11] = 0;  // adaptive filtering
        d[12] = 0;  // no interlace
        return d;
    }

    function phys(ppu) {
        const d = new Uint8Array(9);
        d.set(be32(ppu), 0);
        d.set(be32(ppu), 4);
        d[8] = 1;   // unit: metres
        return d;
    }

    // ---- scanline filtering + deflate -------------------------------------

    // Stream filtered scanlines so a 6600x7200 sheet never needs a second
    // 190 MB buffer. Row 0 uses None; the rest use Up.
    function scanlineStream(px, w, h) {
        const rowLen = w * 4;
        let y = 0;
        return new ReadableStream({
            pull(controller) {
                if (y >= h) {
                    controller.close();
                    return;
                }
                const out = new Uint8Array(1 + rowLen);
                const base = y * rowLen;
                if (y === 0) {
                    out[0] = 0;
                    out.set(px.subarray(base, base + rowLen), 1);
                } else {
                    out[0] = 2; // Up
                    const prev = base - rowLen;
                    for (let i = 0; i < rowLen; i++) {
                        out[i + 1] = (px[base + i] - px[prev + i]) & 0xff;
                    }
                }
                controller.enqueue(out);
                y++;
            },
        });
    }

    async function deflate(stream) {
        // CompressionStream('deflate') emits zlib-wrapped data, which is what
        // PNG IDAT requires ('deflate-raw' would not be valid here).
        const compressed = stream.pipeThrough(new CompressionStream('deflate'));
        const reader = compressed.getReader();
        const parts = [];
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const { value, done } = await reader.read();
            if (done) break;
            parts.push(value);
        }
        return concat(parts);
    }

    /**
     * Encode raw RGBA as a PNG tagged at the given resolution.
     *
     * @param {Uint8Array} px raw RGBA, row-major, w*h*4 bytes
     * @param {number} dpi defaults to 300
     * @returns {Promise<Blob>}
     */
    async function encode(px, w, h, dpi) {
        const ppu = dpi === undefined || dpi === 300
            ? PPU_300DPI
            : Math.round(dpi / 0.0254);
        const idat = await deflate(scanlineStream(px, w, h));
        return new Blob([
            SIGNATURE,
            chunk('IHDR', ihdr(w, h)),
            chunk('pHYs', phys(ppu)),
            chunk('IDAT', idat),
            chunk('IEND', new Uint8Array(0)),
        ], { type: 'image/png' });
    }

    return {
        encode,
        crc32,
        crc32Final,
        concat,
        be32,
        PPU_300DPI,
    };
})();
