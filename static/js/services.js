// AUTO-GENERATED — DO NOT EDIT BY HAND.
// Source: assets/services.json
// Regenerate: python tools/gen_services.py
//
// Limits published by each print service. Every number traces to that
// service's own guidance; see _sources in the JSON.

const PRINT_SERVICES = {
    "te-ultracolor-max": {
        "name": "Transfer Express — UltraColor MAX (DTF)",
        "source": "te-ucmax",
        "min_dpi": 150,
        "recommended_dpi": 300,
        "min_stroke_in": 0.018,
        "max_sheet_in": {
            "w": 22,
            "h": 22
        },
        "max_sheet_confirmed": true,
        "color_mode": "CMYK",
        "notes": [
            "A file you upload counts as a single image, and their maximum single image is 22 x 22\". Their 24 x 22\" gang sheet exists, but only inside their Easy View Online Designer — you cannot upload one.",
            "Below 150 DPI their printer adds a white jagged line around the artwork. 300 DPI or better is what they recommend.",
            "Lines thinner than 0.018\" print, but they cannot put adhesive there, so those parts may not last. There is no limit on non-printing (show-thru) areas.",
            "Set Remove White to Original. These sheets are already transparent, so the only white it could remove is white inside your logos. They also ask you to say whether white areas should print white or show the garment through.",
            "They print CMYK, which cannot reproduce fluorescent or metallic colours.",
            "Soft edges that fade away to nothing will not print. Avoid drop shadows and feathered edges.",
            "Text must be outlined. Ours already is — every sheet leaves here as pixels, not live text.",
            "Art time is not included for UltraColor MAX, unlike their other products."
        ],
        "prefers_format": {
            "format": "zip",
            "label": "Download PNG(s)",
            "reason": "Their uploader does not read the resolution of an image inside a PDF. The same sheet uploads as 300 DPI from the ZIP, and draws a \"less than 150 dots per inch\" warning as a PDF — even though both are the identical 300 DPI sheet. Send the ZIP."
        }
    },
    "te-ultracolor-pro": {
        "name": "Transfer Express — UltraColor Pro",
        "source": "te-guidelines",
        "min_dpi": 150,
        "recommended_dpi": 300,
        "min_stroke_in": 0.014,
        "max_sheet_in": null,
        "max_sheet_confirmed": false,
        "color_mode": "CMYK",
        "notes": [
            "Sheet size limits for this product are not recorded here — check their product page before a big run.",
            "Art time is included, so flag anything you want them to fix in the order notes."
        ],
        "prefers_format": {
            "format": "zip",
            "label": "Download PNG(s)",
            "reason": "Their uploader does not read the resolution of an image inside a PDF. The same sheet uploads as 300 DPI from the ZIP, and draws a \"less than 150 dots per inch\" warning as a PDF — even though both are the identical 300 DPI sheet. Send the ZIP."
        }
    },
    "te-screen-print": {
        "name": "Transfer Express — Goof Proof / Elasti Prints (screen print)",
        "source": "te-guidelines",
        "min_dpi": null,
        "recommended_dpi": null,
        "min_stroke_in": 0.012,
        "max_sheet_in": null,
        "max_sheet_confirmed": false,
        "color_mode": "spot",
        "notes": [
            "DPI is not critical for screen printing; they enhance low-resolution art.",
            "Show-through thickness minimum is 0.04\".",
            "Art time is included."
        ],
        "prefers_format": {
            "format": "zip",
            "label": "Download PNG(s)",
            "reason": "Their uploader does not read the resolution of an image inside a PDF. The same sheet uploads as 300 DPI from the ZIP, and draws a \"less than 150 dots per inch\" warning as a PDF — even though both are the identical 300 DPI sheet. Send the ZIP."
        }
    },
    "custom": {
        "name": "Custom — no service selected",
        "source": null,
        "min_dpi": 150,
        "recommended_dpi": 300,
        "min_stroke_in": null,
        "max_sheet_in": null,
        "max_sheet_confirmed": false,
        "color_mode": null,
        "notes": [
            "No service picked, so only general print-quality advice applies. Pick your service to check against its real limits."
        ],
        "prefers_format": null
    }
};

const PRINT_SERVICE_SOURCES = {
    "te-guidelines": "https://blog.transferexpress.com/art-guidelines/ (read 2026-10-25)",
    "te-ucmax": "https://www.transferexpress.com/heat-press-transfers/ultracolor-max -- Production Details (read 2026-10-25)",
    "te-pdf-dpi": "Observed on a real order, 2026-10-25: the same 22x22 sheet passed Transfer Express's DPI check as a PNG and failed it as a PDF. Our PDF is a 6600x6600 image on a 1584pt (22in) page = 300 DPI, and Pillow writes the same geometry, so the file is not at fault."
};
