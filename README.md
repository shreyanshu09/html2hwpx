# html2hwpx — HTML to HWPX Conversion Engine

> Convert HTML documents to **HWPX** (Hangul Word Processor XML format) — pure JavaScript, no native dependencies.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14-brightgreen)](https://nodejs.org)

---

## Table of Contents

- [Overview](#overview)
- [Project Structure](#project-structure)
- [Installation](#installation)
- [Usage](#usage)
  - [Standalone Script](#standalone-script)
  - [CLI Command](#cli-command)
  - [JavaScript API](#javascript-api)
- [Custom HWPX Template](#custom-hwpx-template)
- [Supported HTML Features](#supported-html-features)
- [How It Works](#how-it-works)
- [Dependencies](#dependencies)
- [Known Limitations](#known-limitations)

---

## Overview

**html2hwpx** is a lightweight, fully JavaScript-based conversion engine that transforms HTML documents into the HWPX format used by Hangul Word Processor (HWP). It requires no native binaries or external tools — just Node.js.

---

## Project Structure

```
html2hwpx/
├── convert.js               ← Standalone script (run directly with Node.js)
├── package.json
├── README.md
├── bin/
│   └── html2hwpx.js         ← CLI entry point (html2hwpx command)
├── lib/
│   ├── index.js             ← Package entry point
│   ├── HtmlToAst.js         ← HTML → internal AST
│   ├── HtmlToHwpx.js        ← AST → HWPX XML / ZIP archive
│   └── HtmlRenderer.js      ← AST → clean HTML (round-trip)
└── template/                ← Pre-extracted blank HWPX template
    ├── Contents/
    │   ├── header.xml
    │   ├── section0.xml
    │   └── content.hpf
    ├── META-INF/
    ├── Preview/
    ├── mimetype
    ├── settings.xml
    └── version.xml
```

---

## Installation

### Option A — Standalone script

Clone the repository and run directly with Node.js:

```bash
git clone <repo-url>
cd html2hwpx
npm install
node convert.js input.html output.hwpx
```

### Option B — Global CLI command

Install once and use the `html2hwpx` command from anywhere:

```bash
cd html2hwpx
npm install -g .
```

### Option C — Library (programmatic use)

```bash
npm install html2hwpx
```

---

## Usage

### Standalone Script

```bash
# HTML → HWPX (uses built-in template)
node convert.js document.html output.hwpx

# HTML → HWPX (custom template directory)
node convert.js document.html output.hwpx ./my_template/

# HTML → cleaned HTML (round-trip via AST)
node convert.js document.html output_clean.html

# HTML → JSON AST (for debugging or inspection)
node convert.js document.html ast.json
```

### CLI Command

After installing globally with `npm install -g .`:

```bash
# Basic conversion
html2hwpx document.html -o output.hwpx

# With a custom template
html2hwpx document.html -o output.hwpx --template ./my_template/

# Round-trip to clean HTML
html2hwpx document.html -o output.html

# Export the internal AST
html2hwpx document.html -o ast.json
```

### JavaScript API

```javascript
const { HtmlToHwpx, HtmlRenderer, HtmlToAst } = require('html2hwpx');

// HTML → HWPX (async)
await HtmlToHwpx.convertToHwpx('document.html', 'output.hwpx');

// HTML → HWPX with a custom template directory
await HtmlToHwpx.convertToHwpx('document.html', 'output.hwpx', './my_template/');

// HTML → clean HTML
HtmlRenderer.convertToHtml('document.html', 'output.html');

// HTML → AST (from file or string)
const astFromFile   = HtmlToAst.parseFile('document.html');
const astFromString = HtmlToAst.parse('<h1>Hello</h1><p>World</p>');
```

---

## Custom HWPX Template

html2hwpx is driven by a **pre-extracted HWPX template directory**. The built-in template lives at `html2hwpx/template/`. You can substitute your own to carry over custom styles, fonts, or page settings.

**Steps to create a custom template:**

1. Rename your `.hwpx` file to `.zip`
2. Extract it into a directory, e.g. `my_template/`
3. Pass the directory path to the converter:

```bash
# CLI
html2hwpx input.html -o output.hwpx --template ./my_template/

# Script
node convert.js input.html output.hwpx ./my_template/
```

```javascript
// API
await HtmlToHwpx.convertToHwpx('input.html', 'output.hwpx', './my_template/');
```

---

## Supported HTML Features

| Feature | Status | Notes |
|---|---|---|
| Headings `<h1>`–`<h6>` | ✅ | Maps to HWPX heading styles 1–6 |
| Paragraphs `<p>` | ✅ | Supports `padding-left`, `margin-left`, `text-indent` |
| Bold `<strong>` / `<b>` | ✅ | |
| Italic `<em>` / `<i>` | ✅ | |
| Underline `<u>` | ✅ | |
| Strikethrough `<s>` / `<del>` | ✅ | |
| Superscript `<sup>` | ✅ | |
| Subscript `<sub>` | ✅ | |
| Inline code `<code>` | ✅ | |
| Code blocks `<pre><code>` | ✅ | Language class detection included |
| Hyperlinks `<a>` | ✅ | Link text preserved |
| Images `<img>` | ✅ | Auto-sizing via `image-size` |
| Colour / font-size `<span style="…">` | ✅ | Inline styles only |
| Unordered lists `<ul>` | ✅ | Nested, bullet `•` |
| Ordered lists `<ol>` | ✅ | Nested, numeric prefix |
| Tables | ✅ | `thead` / `tbody` / `tfoot`, `colspan`, `rowspan` |
| Horizontal rule `<hr>` | ✅ | Rendered as bottom-border paragraph |
| Blockquote `<blockquote>` | ✅ | Indented paragraphs |
| `<div>` / `<section>` | ✅ | Transparent pass-through |

---

## How It Works

```
HTML file
    │
    ▼
HtmlToAst.js      Parses HTML (htmlparser2) into an internal AST
    │
    ├──▶ HtmlToHwpx.js     Walks the AST, generates HWPX XML,
    │         │             merges with template directory,
    │         ▼             and writes the result as a ZIP archive
    │     output.hwpx
    │
    └──▶ HtmlRenderer.js   Walks the AST and serialises back to HTML
              ▼
          output.html
```

---

## Dependencies

| Package | Purpose |
|---|---|
| [`htmlparser2`](https://github.com/fb55/htmlparser2) | Fast, permissive HTML parsing |
| [`@xmldom/xmldom`](https://github.com/xmldom/xmldom) | XML DOM creation and manipulation |
| [`jszip`](https://stuk.github.io/jszip/) | ZIP archive creation (HWPX is a ZIP) |
| [`image-size`](https://github.com/image-size/image-size) | Reading image dimensions |

---

## Known Limitations

- **Input format:** HTML only (`.html` / `.htm`). Other formats (Markdown, DOCX, etc.) are not supported.
- **CSS support:** Only inline `style=` attributes are processed. Complex selectors, external stylesheets, and layout properties (flexbox, grid, etc.) are ignored.
