// Pre-download check: does this sheet meet the chosen print service's limits?
//
// Pure logic over numbers the app already has -- no DOM, no rendering. Every
// limit comes from assets/services.json, and every finding names the setting
// that would fix it.
//
// A deliberate rule runs through this file: a limit the service has not
// actually published can warn but never block. Blocking a valid download on a
// number we inferred would be worse than having no check -- see
// `max_sheet_confirmed` in services.json.

const Precheck = (function () {

    const SHEET_INCHES = {
        "22x24": { w: 22, h: 24 },
        "22x22": { w: 22, h: 22 },
        "22x12": { w: 22, h: 12 },
        "22x11": { w: 22, h: 11 },
    };

    // Sheet sizes offered as the one-click fix for a sheet the service will not
    // take, smallest first. Full sheets only, deliberately: a half sheet holds
    // half the labels, and halving someone's order is not a size fix.
    const SHEET_ORDER = ["22x22", "22x24"];

    function fitsIn(sheet, max) {
        return sheet.w <= max.w + 1e-9 && sheet.h <= max.h + 1e-9;
    }

    // What the service would scale our sheet by to make it fit. Keeps aspect,
    // which is what Transfer Express was observed to do: a 22 x 24 sheet came
    // back as 20.17 x 22, i.e. 22/24 = 91.7%.
    function shrinkFactor(sheet, max) {
        return Math.min(1, max.w / sheet.w, max.h / sheet.h);
    }

    function pct(x) {
        return (x * 100).toFixed(1).replace(/\.0$/, "") + "%";
    }

    function inches(x) {
        return (Math.round(x * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
    }

    // Smallest sheet size we offer that fits the service.
    function suggestSheetSize(max) {
        for (const id of SHEET_ORDER) {
            if (fitsIn(SHEET_INCHES[id], max)) return id;
        }
        return null;
    }

    function sheetSizeFinding(profile, job) {
        const max = profile.max_sheet_in;
        if (!max) return null;
        const sheet = SHEET_INCHES[job.outputSize];
        if (!sheet || fitsIn(sheet, max)) return null;

        const k = shrinkFactor(sheet, max);
        const fix = suggestSheetSize(max);
        const label = job.logoInches;

        let detail = `They cap sheets at ${inches(max.w)} x ${inches(max.h)}".`
            + ` Yours is ${inches(sheet.w)} x ${inches(sheet.h)}", so it will be`
            + ` scaled to ${pct(k)} — printing at`
            + ` ${inches(sheet.w * k)} x ${inches(sheet.h * k)}".`;

        if (label) {
            detail += ` Every ${inches(label.w)} x ${inches(label.h)}" label would`
                + ` come out ${inches(label.w * k)} x ${inches(label.h * k)}",`
                + ` and the jig will not line up.`;
        }

        if (!profile.max_sheet_confirmed) {
            detail += ` (This limit is from what their upload page did to a real`
                + ` order, not from their published guidelines — worth confirming`
                + ` with them.)`;
        }

        return {
            id: "sheet-size",
            // An unpublished limit warns; it does not block a valid download.
            level: profile.max_sheet_confirmed ? "block" : "warn",
            title: "Sheet is too big for this service",
            detail: detail,
            fix: fix ? { setting: "outputSize", value: fix,
                         label: `Switch to ${fix.replace("x", " x ")}"` } : null,
        };
    }

    function dpiFindings(profile, job) {
        const min = profile.min_dpi;
        const rec = profile.recommended_dpi;
        if (!min && !rec) return [];      // DPI not critical for this service

        const below = [];
        const soft = [];
        for (const logo of job.logos || []) {
            if (logo.dpi == null) continue;
            if (min && logo.dpi < min) below.push(logo);
            else if (rec && logo.dpi < rec) soft.push(logo);
        }

        const out = [];
        const list = (ls) => ls.map(l => `${l.name} (${l.dpi} DPI`
            + (l.neededW ? `, needs ${l.neededW}x${l.neededH}` : "") + ")").join(", ");

        if (below.length) {
            out.push({
                id: "dpi-below-min",
                level: "warn",
                title: `${below.length} logo${below.length > 1 ? "s" : ""} below`
                     + ` their ${min} DPI minimum`,
                detail: `${list(below)}. Below ${min} DPI their printer adds a`
                      + ` white jagged line around the artwork. Replace these with`
                      + ` higher-resolution files, or scale them down in the editor.`,
                fix: null,
            });
        }
        if (soft.length && rec) {
            out.push({
                id: "dpi-below-recommended",
                level: "info",
                title: `${soft.length} logo${soft.length > 1 ? "s" : ""} under the`
                     + ` recommended ${rec} DPI`,
                detail: `${list(soft)}. Above their ${min} DPI minimum, so it will`
                      + ` print, but ${rec} DPI is what they recommend for a clean edge.`,
                fix: null,
            });
        }
        return out;
    }

    // What was measured, pass or fail. Rendered as chips above any findings so
    // the numbers are visible even when there is nothing wrong.
    function summarize(profile, job) {
        const chips = [];

        const sheet = SHEET_INCHES[job.outputSize];
        if (sheet) {
            const max = profile.max_sheet_in;
            chips.push({
                label: `Sheet ${inches(sheet.w)} x ${inches(sheet.h)}"`,
                state: !max ? "none" : (fitsIn(sheet, max) ? "ok" : "bad"),
            });
        }

        const dpis = (job.logos || []).map(l => l.dpi).filter(d => d != null);
        if (dpis.length) {
            const min = Math.min(...dpis);
            const floor = profile.min_dpi;
            const rec = profile.recommended_dpi;
            let state = "none";
            if (floor || rec) {
                state = (floor && min < floor) ? "bad"
                      : (rec && min < rec) ? "warn" : "ok";
            }
            chips.push({
                label: dpis.length > 1
                    ? `Lowest logo ${min} DPI`
                    : `Logo ${min} DPI`,
                state: state,
            });
        }

        return chips;
    }

    // profile: one entry from PRINT_SERVICES
    // job: { outputSize, logoInches: {w,h}, logos: [{name, dpi, neededW, neededH}] }
    function run(profile, job) {
        if (!profile) {
            return { findings: [], summary: [], prefersFormat: null,
                     blocked: false, notes: [] };
        }

        const findings = [
            sheetSizeFinding(profile, job),
            ...dpiFindings(profile, job),
        ].filter(Boolean);

        const rank = { block: 0, warn: 1, info: 2 };
        findings.sort((a, b) => rank[a.level] - rank[b.level]);

        return {
            findings: findings,
            summary: summarize(profile, job),
            prefersFormat: profile.prefers_format || null,
            blocked: findings.some(f => f.level === "block"),
            notes: profile.notes || [],
        };
    }

    return { run, SHEET_INCHES, shrinkFactor, suggestSheetSize };
})();
