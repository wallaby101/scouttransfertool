// Minimal multi-page PDF writer for the sheet download.
//
// One page per sheet, each holding a single full-bleed image, which is the same
// shape as what package_as_pdf() produces. Two deliberate differences:
//
//   * Pillow's PDF export compresses images with /DCTDecode — JPEG. That is
//     lossy, and 300 DPI line art (dashed registration marks, jig outlines,
//     label text) is the worst case for it: JPEG rings around hard edges. This
//     writer uses /FlateDecode, so the page carries the sheet's exact pixels.
//     The bytes therefore cannot match the old PDFs, but the image does match
//     the sheet, which is what matters for print.
//   * No dependency. pdf-lib would add about a megabyte to a PWA that someone
//     loads over a home connection, and a single-image-per-page PDF is one of
//     the simplest structures in the format.
//
// Page geometry matches Pillow: MediaBox is the pixel size converted at the
// sheet's DPI (6600 px / 300 dpi * 72 = 1584 pt), so the sheet prints at its
// true physical size.
//
// Pixels are composited onto white exactly as _load_sheet_as_rgb does, using
// Pillow's own BLEND rounding, so the embedded image is byte-identical to what
// the Python embeds before encoding.

const ExportPDF = (function () {
    'use strict';

    const { concat } = ExportPNG;
    const encoder = new TextEncoder();

    function bytes(str) {
        return encoder.encode(str);
    }

    // Stream RGB-on-white scanlines so a sheet never needs a second large
    // buffer: 6600x7200 RGB would be 142 MB on top of the 190 MB sheet.
    function rgbOnWhiteStream(px, w, h) {
        const rowRGBA = w * 4;
        const rowRGB = w * 3;
        let y = 0;
        return new ReadableStream({
            pull(controller) {
                if (y >= h) {
                    controller.close();
                    return;
                }
                const out = new Uint8Array(rowRGB);
                let si = y * rowRGBA;
                let di = 0;
                for (let x = 0; x < w; x++) {
                    const a = px[si + 3];
                    if (a === 255) {
                        out[di] = px[si];
                        out[di + 1] = px[si + 1];
                        out[di + 2] = px[si + 2];
                    } else if (a === 0) {
                        out[di] = 255;
                        out[di + 1] = 255;
                        out[di + 2] = 255;
                    } else {
                        // Pillow: white * (255 - a) + c * a, rounded.
                        out[di] = Place.blend(a, 255, px[si]);
                        out[di + 1] = Place.blend(a, 255, px[si + 1]);
                        out[di + 2] = Place.blend(a, 255, px[si + 2]);
                    }
                    si += 4;
                    di += 3;
                }
                controller.enqueue(out);
                y++;
            },
        });
    }

    async function deflateStream(stream) {
        // /FlateDecode expects zlib-wrapped data, which 'deflate' produces.
        const reader = stream.pipeThrough(new CompressionStream('deflate'))
            .getReader();
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
     * Accumulate pages, holding only compressed image data per sheet so the
     * whole job never sits in memory uncompressed.
     */
    function create(options) {
        const dpi = (options && options.dpi) || 300;
        const pages = [];

        /** Composite, compress and queue one sheet as a page. */
        async function addSheet(px, w, h) {
            const data = await deflateStream(rgbOnWhiteStream(px, w, h));
            pages.push({ w, h, data });
            return pages.length;
        }

        function finish() {
            // Object numbering: 1 catalog, 2 pages, then per page
            // (page, contents, image).
            const objects = [];   // index 0 -> object 1
            const pageRefs = [];

            objects.push(null);   // 1: catalog, filled once kids are known
            objects.push(null);   // 2: pages

            pages.forEach((page, i) => {
                const pageObj = 3 + i * 3;
                const contentObj = pageObj + 1;
                const imageObj = pageObj + 2;
                pageRefs.push(`${pageObj} 0 R`);

                const wPt = (page.w / dpi) * 72;
                const hPt = (page.h / dpi) * 72;
                const content = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q\n`;

                objects.push({
                    num: pageObj,
                    body: bytes(
                        `<< /Type /Page /Parent 2 0 R `
                        + `/MediaBox [0 0 ${wPt} ${hPt}] `
                        + `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> `
                        + `/Contents ${contentObj} 0 R >>`),
                });
                objects.push({
                    num: contentObj,
                    body: concat([
                        bytes(`<< /Length ${content.length} >>\nstream\n`),
                        bytes(content),
                        bytes('endstream'),
                    ]),
                });
                objects.push({
                    num: imageObj,
                    body: concat([
                        bytes(`<< /Type /XObject /Subtype /Image `
                            + `/Width ${page.w} /Height ${page.h} `
                            + `/ColorSpace /DeviceRGB /BitsPerComponent 8 `
                            + `/Filter /FlateDecode /Length ${page.data.length} >>\n`
                            + `stream\n`),
                        page.data,
                        bytes('\nendstream'),
                    ]),
                });
            });

            objects[0] = { num: 1, body: bytes('<< /Type /Catalog /Pages 2 0 R >>') };
            objects[1] = {
                num: 2,
                body: bytes(`<< /Type /Pages /Kids [${pageRefs.join(' ')}] `
                    + `/Count ${pages.length} >>`),
            };

            // Serialise, recording each object's byte offset for the xref table.
            const parts = [bytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
            let offset = parts[0].length;
            const offsets = new Map();

            for (const obj of objects) {
                const head = bytes(`${obj.num} 0 obj\n`);
                const tail = bytes('\nendobj\n');
                offsets.set(obj.num, offset);
                parts.push(head, obj.body, tail);
                offset += head.length + obj.body.length + tail.length;
            }

            const count = objects.length + 1; // objects plus the free entry
            let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
            for (let num = 1; num <= objects.length; num++) {
                xref += `${String(offsets.get(num)).padStart(10, '0')} 00000 n \n`;
            }
            xref += `trailer\n<< /Size ${count} /Root 1 0 R >>\n`
                + `startxref\n${offset}\n%%EOF\n`;
            parts.push(bytes(xref));

            return new Blob(parts, { type: 'application/pdf' });
        }

        return { addSheet, finish, get pageCount() { return pages.length; } };
    }

    return { create };
})();
