// Minimal ZIP writer for the multi-sheet download.
//
// Entries are STORED, not deflated. The Python uses ZIP_DEFLATED, but every
// member is a PNG, which is already deflate-compressed, so recompressing buys
// essentially nothing. Storing keeps this to ~80 lines and avoids pulling in a
// ZIP library for the PWA to download.
//
// Member names match the Python exactly: "<project>_sheet<N>.png", 1-based.
//
// No ZIP64: a 22x24 sheet PNG is a few MB and the slot cap is 17 sheets, so
// neither the archive nor any member approaches 4 GB.

const ExportZip = (function () {
    'use strict';

    const { crc32Final, concat, be32 } = ExportPNG;

    function le16(v) {
        return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
    }

    function le32(v) {
        return new Uint8Array([v & 0xff, (v >>> 8) & 0xff,
                               (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
    }

    // MS-DOS date/time, which is what the ZIP header carries.
    function dosDateTime(date) {
        const time = ((date.getHours() & 0x1f) << 11)
            | ((date.getMinutes() & 0x3f) << 5)
            | ((date.getSeconds() / 2) & 0x1f);
        const day = (((date.getFullYear() - 1980) & 0x7f) << 9)
            | (((date.getMonth() + 1) & 0x0f) << 5)
            | (date.getDate() & 0x1f);
        return { time, day };
    }

    /**
     * Build a ZIP from in-memory members.
     *
     * @param {Array<{name: string, bytes: Uint8Array}>} files
     * @returns {Blob}
     */
    function build(files) {
        const encoder = new TextEncoder();
        const { time, day } = dosDateTime(new Date());

        const locals = [];
        const centrals = [];
        let offset = 0;

        for (const file of files) {
            const nameBytes = encoder.encode(file.name);
            const crc = crc32Final(file.bytes);
            const size = file.bytes.length;

            const local = concat([
                le32(0x04034b50),   // local file header signature
                le16(10),           // version needed: 1.0 is enough for STORE
                le16(0),            // flags
                le16(0),            // method 0: stored
                le16(time), le16(day),
                le32(crc),
                le32(size),         // compressed size == uncompressed
                le32(size),
                le16(nameBytes.length),
                le16(0),            // extra field length
                nameBytes,
            ]);
            locals.push(local, file.bytes);

            centrals.push(concat([
                le32(0x02014b50),   // central directory header signature
                le16(20),           // version made by
                le16(10),           // version needed
                le16(0),            // flags
                le16(0),            // method
                le16(time), le16(day),
                le32(crc),
                le32(size), le32(size),
                le16(nameBytes.length),
                le16(0),            // extra
                le16(0),            // comment
                le16(0),            // disk number start
                le16(0),            // internal attributes
                le32(0),            // external attributes
                le32(offset),       // offset of local header
                nameBytes,
            ]));

            offset += local.length + size;
        }

        const centralBytes = concat(centrals);
        const eocd = concat([
            le32(0x06054b50),       // end of central directory signature
            le16(0), le16(0),       // this disk, disk with central directory
            le16(files.length), le16(files.length),
            le32(centralBytes.length),
            le32(offset),           // central directory offset
            le16(0),                // comment length
        ]);

        return new Blob([...locals, centralBytes, eocd],
                        { type: 'application/zip' });
    }

    /** Member name for sheet index i (0-based), matching package_as_zip. */
    function sheetName(projectName, index) {
        return `${projectName}_sheet${index + 1}.png`;
    }

    return { build, sheetName, le16, le32 };
})();
