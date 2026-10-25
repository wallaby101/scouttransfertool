# Bundled fonts

These faces replace the absolute macOS font paths the generator used to read
(`/System/Library/Fonts/...`). Those paths exist only on macOS, so on any other
machine every text overlay silently fell back to Pillow's default bitmap font —
unreadable at 300 DPI. Bundling the fonts also means Python and the browser
rasterize the same outlines, which is what makes text comparable between the
two renderers.

The UI keeps its original family names. Each maps to an open-licensed
substitute of the same design class:

| UI name | Bundled face | Metric-compatible | License | Source |
|---|---|---|---|---|
| Helvetica | Arimo | yes | OFL 1.1 | google/fonts `ofl/arimo` |
| Arial | Arimo | yes | OFL 1.1 | google/fonts `ofl/arimo` |
| Times New Roman | Tinos | yes | OFL 1.1 | google/fonts `ofl/tinos` |
| Courier | Cousine | yes (Courier New) | OFL 1.1 | google/fonts `ofl/cousine` |
| Georgia | Gelasio | yes | OFL 1.1 | google/fonts `ofl/gelasio` |
| Verdana | Lato | **no** | OFL 1.1 | google/fonts `ofl/lato` |

Arimo and Gelasio are variable fonts; the weight axis instance is named in
`fonts.json` and selected explicitly, so "bold" is never synthesised.

Tinos ships no `OFL.txt` in google/fonts; its `METADATA.pb` declares OFL, and
the OFL 1.1 text in `licenses/` applies.

Proprietary faces (the real Helvetica, Arial, Times New Roman, Georgia,
Verdana) are deliberately **not** bundled — redistributing them through a
public site is not permitted.

## Possible optimisation

The bundled set is ~3.7 MB. Subsetting to Latin-1 with `fonttools` would cut
that by roughly 90%. Not done here because it would silently drop glyphs for
any non-Latin-1 label text; revisit if the download size becomes a problem.
