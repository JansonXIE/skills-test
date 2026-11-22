---
name: generate-styled-html
description: Generate a styled single-file HTML document (report / share deck / 复盘 / 分享材料) following the CAPS house style — fixed left sidebar TOC with scroll-spy, in-browser edit mode (Ctrl+S export), auto generation-date, and a catalog of blue-themed content components (卡片/提示条/分级框/表格). Use when asked to "生成HTML", "做一份分享材料/复盘/报告网页", "按这个格式生成", "generate an HTML doc/report", or to render/screenshot such a doc.
---

# generate-styled-html

Generates a **single self-contained `.html`** file (inline CSS+JS, no dependencies)
in the house style of `从经验教训到CAPS...html`: a sticky left **sidebar TOC** with
scroll-spy highlighting, an **edit mode** toggle (`contenteditable` + `Ctrl+S`
downloads the edited file), an **auto-stamped generation date**, and a set of
reusable blue-themed content blocks.

The template is the deliverable; `render.sh` is the harness that screenshots any
generated file with the Playwright-cached Chromium so you can *see* the result
before handing it over.

Paths below are relative to this skill directory
(`.claude/skills/generate-styled-html/`).

## How to generate a document

1. **Copy the template** to your target file:
   ```bash
   cp .claude/skills/generate-styled-html/template.html /tmp/mydoc.html
   ```
2. **Fill the placeholders** — every `{{...}}` must be replaced:
   | Placeholder | Meaning |
   |---|---|
   | `{{TITLE}}` | browser tab title (also used as export filename) |
   | `{{LOGO_WORD}}` / `{{LOGO_SUB}}` | sidebar logo main text / small subtitle |
   | `{{H1_LINE1}}` / `{{H1_LINE2}}` | centered title, two lines (split by `<br>`) |
   | `{{META_LINE}}` | grey line under H1 — 分享材料 \| 依据：… |
   | `{{FOOTER_LINE}}` | footer text before the auto date |
3. **Write the content** inside `#main-content`, and **mirror every `<h2>`/`<h3>`
   into the sidebar `<nav>`.** This is the one rule that must hold:
   - Each section heading needs a unique `id`: `<h2 id="ch2">…`, `<h3 id="ch2-1">…`.
   - Each nav link points at that id: `<a href="#ch2">…</a>` for h2,
     `<a href="#ch2-1" class="toc-h3">…</a>` for h3.
   - The scroll-spy matches `href="#id"` against the heading ids — **anchors must be
     bare `#id`, never full URLs.** (The original saved file had absolute-URL hrefs,
     which silently break scroll-spy; the template fixes this.)
4. **Do NOT touch** the `<style>` block or the three `<script>` blocks (edit toggle,
   date stamp, scroll-spy). Only edit content and the nav.
5. **Render and look at it** (see below). Fix anything blank/broken. Then deliver.

The generation date auto-fills to *today* on first open and is frozen into the file
when the user hits Ctrl+S — no manual date needed.

## Content components (copy from `template.html`)

`template.html` doubles as a live catalog — every block below is already in it:

- `<div class="caps-row">` … `<div class="caps-node">` — N equal columns, circular badge + title + feature lines.
- `<div class="key-section"><div class="key-row">` + `.key-card k1/k2/k3` — highlighted "核心内容" band, 3 comparison cards (旧法删除线 vs 新法加粗).
- `<div class="note|warning|info">` — green/yellow/blue callout bars.
- `<div class="think-box">` — beige box for listing 现象/思考.
- `<div class="level-box emergency|important|routine">` — red/yellow/green graded blocks with a badge.
- `<table>` — auto blue-header striped table (just write plain `<tr><th>/<td>`).
- `<strong>` for emphasis. Keep font sizes as-is (13–14px body).

## Run (agent path) — render & screenshot

```bash
.claude/skills/generate-styled-html/render.sh /tmp/mydoc.html /tmp/shot.png 1280 1600
```
Then Read `/tmp/shot.png` to verify. Args: `<html> [out.png] [width] [height]`.
It auto-finds Chromium at `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`
(falls back to system `chromium`/`google-chrome`).

To verify **edit mode** wiring specifically, auto-trigger it before screenshotting:
```bash
sed 's#</body></html>#<script>addEventListener("load",()=>toggleEdit());</script></body></html>#' \
  /tmp/mydoc.html > /tmp/mydoc_edit.html
.claude/skills/generate-styled-html/render.sh /tmp/mydoc_edit.html /tmp/edit_shot.png 1280 700
```
Expect the toggle button to read "编辑中" and a bottom-right "📝 可编辑模式 · Ctrl+S 保存" banner.

## Run (human path)

Open the `.html` in any browser. Click **编辑模式** (top-left) to edit inline;
press **Ctrl+S** to download the edited copy. Print/PDF hides the sidebar
(`@media print`). No server needed — it's one file.

## Gotchas

- **Sidebar anchors must be `#id`, not full URLs.** Absolute-URL hrefs (as produced
  by "Save page as" on a hosted copy) break scroll-spy — the active section never
  updates. Always use bare `#chX`.
- **Every `<h2>`/`<h3>` needs a matching nav `<a>` and vice-versa** — mismatches leave
  dead links or un-highlighted sections. Add the nav entry when you add the heading.
- **Don't rename the `id`s the scripts depend on:** `main-content`, `editToggle`,
  `editBanner`, `toc-sidebar`, `gen-date` / `gen-date-2`.
- **Headless screenshot only captures the viewport height you pass.** Long docs get
  cut off — that's fine for a spot-check; raise the height arg (e.g. `2400`) to see more.
- **CJK renders fine** with the cached Chromium; no extra fonts needed here.

## Troubleshooting

- `no chromium/chrome found` → the Playwright cache isn't present. Point `render.sh`
  at any Chrome/Chromium, or install one; the script probes several names.
- Screenshot is blank / white → you opened it via `http` or a relative path; use an
  absolute path — `render.sh` converts to `file://` for you.
- Placeholders still show as `{{...}}` in the render → you missed a substitution;
  `grep -c '{{' file.html` should print `0`.
