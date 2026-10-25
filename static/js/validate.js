// ============================================================
// Image validation — binary header parsing + UI card
// ============================================================

// ---- PNG parser ----
function _parsePng(buf) {
    const view = new DataView(buf);
    const magic = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (let i = 0; i < 8; i++) {
        if (view.getUint8(i) !== magic[i]) return null;
    }

    const width = view.getUint32(16);
    const height = view.getUint32(20);
    const bitDepth = view.getUint8(24);
    const colorType = view.getUint8(25);

    const colorNames = { 0: "Grayscale", 2: "RGB", 3: "Indexed", 4: "Grayscale+Alpha", 6: "RGBA" };
    const colorMode = colorNames[colorType] || `Unknown (${colorType})`;
    const hasAlpha = colorType === 4 || colorType === 6;

    let dpi = null;
    let offset = 8;
    const maxOffset = Math.min(buf.byteLength - 12, 65536);
    while (offset < maxOffset) {
        const chunkLen = view.getUint32(offset);
        const chunkType =
            String.fromCharCode(view.getUint8(offset + 4)) +
            String.fromCharCode(view.getUint8(offset + 5)) +
            String.fromCharCode(view.getUint8(offset + 6)) +
            String.fromCharCode(view.getUint8(offset + 7));

        if (chunkType === "pHYs" && chunkLen === 9) {
            const ppuX = view.getUint32(offset + 8);
            const unit = view.getUint8(offset + 16);
            if (unit === 1) {
                dpi = Math.round(ppuX / 39.3701);
            }
            break;
        }
        if (chunkType === "IDAT" || chunkType === "IEND") break;
        offset += 12 + chunkLen;
    }

    return { format: "PNG", width, height, colorMode, hasAlpha, dpi, bitDepth };
}

// ---- JPEG parser ----
function _parseJpeg(buf) {
    const view = new DataView(buf);
    if (view.getUint8(0) !== 0xFF || view.getUint8(1) !== 0xD8) return null;

    let width = 0, height = 0, components = 0, dpi = null, colorMode = "";
    let offset = 2;
    const maxOffset = Math.min(buf.byteLength - 2, 65536);

    while (offset < maxOffset) {
        if (view.getUint8(offset) !== 0xFF) { offset++; continue; }
        while (offset < maxOffset && view.getUint8(offset) === 0xFF) offset++;
        if (offset >= maxOffset) break;

        const marker = view.getUint8(offset);
        offset++;

        if ((marker >= 0xD0 && marker <= 0xD9) || marker === 0x01) continue;

        if (offset + 2 > buf.byteLength) break;
        const segLen = view.getUint16(offset);
        const segStart = offset + 2;

        if ((marker === 0xC0 || marker === 0xC2) && segLen >= 8) {
            height = view.getUint16(segStart + 1);
            width = view.getUint16(segStart + 3);
            components = view.getUint8(segStart + 5);
            const compNames = { 1: "Grayscale", 3: "RGB", 4: "CMYK" };
            colorMode = compNames[components] || `Unknown (${components} channels)`;
        }

        if (marker === 0xE0 && segLen >= 14) {
            const isJfif =
                view.getUint8(segStart) === 0x4A &&
                view.getUint8(segStart + 1) === 0x46 &&
                view.getUint8(segStart + 2) === 0x49 &&
                view.getUint8(segStart + 3) === 0x46 &&
                view.getUint8(segStart + 4) === 0x00;
            if (isJfif) {
                const units = view.getUint8(segStart + 7);
                const xDensity = view.getUint16(segStart + 8);
                if (units === 1) dpi = xDensity;
                else if (units === 2) dpi = Math.round(xDensity * 2.54);
            }
        }

        if (marker === 0xE1 && segLen >= 14 && dpi === null) {
            const isExif =
                view.getUint8(segStart) === 0x45 &&
                view.getUint8(segStart + 1) === 0x78 &&
                view.getUint8(segStart + 2) === 0x69 &&
                view.getUint8(segStart + 3) === 0x66 &&
                view.getUint8(segStart + 4) === 0x00 &&
                view.getUint8(segStart + 5) === 0x00;
            if (isExif) {
                dpi = _parseExifDpi(view, segStart + 6, segLen - 6);
            }
        }

        if (marker === 0xDA) break;

        offset += segLen;
    }

    return { format: "JPEG", width, height, colorMode, hasAlpha: false, dpi, bitDepth: 8 };
}

// ---- EXIF DPI extraction ----
function _parseExifDpi(view, tiffStart, maxLen) {
    if (tiffStart + 8 > view.byteLength) return null;
    const bo0 = view.getUint8(tiffStart);
    const bo1 = view.getUint8(tiffStart + 1);
    const le = bo0 === 0x49 && bo1 === 0x49;
    if (!le && !(bo0 === 0x4D && bo1 === 0x4D)) return null;

    const g16 = (off) => le ? view.getUint16(tiffStart + off, true) : view.getUint16(tiffStart + off);
    const g32 = (off) => le ? view.getUint32(tiffStart + off, true) : view.getUint32(tiffStart + off);

    const ifdOffset = g32(4);
    if (ifdOffset + 2 > maxLen) return null;
    const entries = g16(ifdOffset);

    for (let i = 0; i < entries; i++) {
        const entryOff = ifdOffset + 2 + i * 12;
        if (entryOff + 12 > maxLen) break;
        const tag = g16(entryOff);
        if (tag === 0x011A) {
            const type = g16(entryOff + 2);
            if (type === 5) {
                const valOff = g32(entryOff + 8);
                if (valOff + 8 <= maxLen) {
                    const num = g32(valOff);
                    const den = g32(valOff + 4);
                    if (den > 0) return Math.round(num / den);
                }
            }
        }
    }
    return null;
}

// ---- Transparency detection (canvas sampling) ----
async function _detectTransparency(file) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            const w = img.naturalWidth;
            const h = img.naturalHeight;
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);

            let usesTransparency = false;
            try {
                const data = ctx.getImageData(0, 0, w, h).data;
                const totalPixels = w * h;
                const step = Math.max(1, Math.floor(totalPixels / 10000)) * 4;
                for (let i = 3; i < data.length; i += step) {
                    if (data[i] < 255) {
                        usesTransparency = true;
                        break;
                    }
                }
            } catch (e) {
                // Canvas tainted or other error
            }
            URL.revokeObjectURL(img.src);
            resolve(usesTransparency);
        };
        img.onerror = () => {
            URL.revokeObjectURL(img.src);
            resolve(false);
        };
        img.src = URL.createObjectURL(file);
    });
}

// ---- Dimension classification (never blocks — low-res is a warning, not an error) ----
// Low-resolution logos are accepted and upscaled at generation time; we flag them
// so the user knows print quality may suffer, but we never reject them.
function _classifyDimensions(meta, ew, eh) {
    if (meta.width === ew && meta.height === eh) {
        return { status: "green", msg: `${meta.width}×${meta.height}` };
    }
    // Severely under-resolution (below half the target on either axis) gets a clearer note.
    const lowRes = meta.width < ew * 0.5 || meta.height < eh * 0.5;
    const note = lowRes ? "low-res — may look soft" : `expected ${ew}×${eh}`;
    return { status: "yellow", msg: `${meta.width}×${meta.height} (${note})` };
}

// ---- Stateless validation function (returns {result, meta}) ----
async function validateLogoStateless(file, expected) {
    const slice = file.slice(0, 65536);
    const buf = await slice.arrayBuffer();

    let meta = _parsePng(buf) || _parseJpeg(buf);

    const result = {
        fileType: null,
        dimensions: null,
        dpi: null,
        colorMode: null,
        transparency: null,
        fileSize: null,
        hasErrors: false,
    };

    if (!meta) {
        result.fileType = { status: "red", msg: "Not a valid PNG or JPEG" };
        result.hasErrors = true;
        result.dimensions = { status: "gray", msg: "Unknown" };
        result.dpi = { status: "gray", msg: "Unknown" };
        result.colorMode = { status: "gray", msg: "Unknown" };
        result.transparency = { status: "gray", msg: "Unknown" };
    } else {
        result.fileType = { status: "green", msg: meta.format };

        const ew = expected.w;
        const eh = expected.h;
        result.dimensions = _classifyDimensions(meta, ew, eh);

        if (meta.dpi === null) {
            result.dpi = { status: "gray", msg: "No DPI metadata" };
        } else if (meta.dpi === 300) {
            result.dpi = { status: "green", msg: "300" };
        } else {
            result.dpi = { status: "yellow", msg: `${meta.dpi} (300 recommended)` };
        }

        const greenModes = ["RGB", "RGBA"];
        if (greenModes.includes(meta.colorMode)) {
            result.colorMode = { status: "green", msg: meta.colorMode };
        } else {
            result.colorMode = { status: "yellow", msg: meta.colorMode };
        }

        if (meta.hasAlpha) {
            const usesIt = await _detectTransparency(file);
            result.transparency = {
                status: "info",
                msg: usesIt ? "Has transparency" : "Alpha channel (unused)",
            };
        } else {
            result.transparency = { status: "info", msg: "No alpha channel" };
        }
    }

    const sizeBytes = file.size;
    if (sizeBytes < 1024) {
        result.fileSize = { status: "red", msg: `${sizeBytes} B (too small)` };
        result.hasErrors = true;
    } else if (sizeBytes > 50 * 1024 * 1024) {
        const mb = (sizeBytes / (1024 * 1024)).toFixed(1);
        result.fileSize = { status: "red", msg: `${mb} MB (too large)` };
        result.hasErrors = true;
    } else if (sizeBytes >= 1024 * 1024) {
        result.fileSize = { status: "green", msg: `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` };
    } else {
        result.fileSize = { status: "green", msg: `${(sizeBytes / 1024).toFixed(0)} KB` };
    }

    return { result, meta };
}

// ---- Re-validate dimensions only (stateless) ----
function revalidateDimensionsStateless(meta, prevResult, expected) {
    if (!prevResult || !meta) return prevResult;
    const result = { ...prevResult };
    const ew = expected.w;
    const eh = expected.h;

    result.dimensions = _classifyDimensions(meta, ew, eh);

    const checks = [result.fileType, result.dimensions, result.fileSize];
    result.hasErrors = checks.some((c) => c && c.status === "red");
    return result;
}
