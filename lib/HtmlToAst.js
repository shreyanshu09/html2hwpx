'use strict';
/**
 * HtmlToAst.js — HTML → Pandoc-compatible JSON AST converter.
 *
 * Converts an HTML string or file into an AST dict whose shape matches
 * the AST dict shape consumed by HtmlToHwpx and HtmlRenderer.
 *
 * Supported HTML features
 * -----------------------
 * Block elements  : p, h1-h6, ul, ol, li, pre/code, blockquote, hr,
 *                   table (thead/tbody/tfoot, colspan/rowspan), div, section,
 *                   article, aside, figure, header, footer, main, nav
 * Inline elements : strong/b, em/i, u, s/del/strike, sup, sub, code, a,
 *                   img, span (with style= forwarded as Span attr), br
 * Text            : whitespace-normalised; newlines → SoftBreak
 */

const { parseDocument } = require('htmlparser2');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Tags whose content we never want
const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript']);

const INLINE_TAGS = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdo', 'big', 'br', 'button',
  'cite', 'code', 'dfn', 'em', 'i', 'img', 'kbd', 'label',
  'mark', 'output', 'q', 's', 'samp', 'select', 'small',
  'span', 'strike', 'strong', 'sub', 'sup', 'textarea', 'time',
  'tt', 'u', 'var', '#text',
]);

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'canvas', 'dd',
  'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'p',
  'pre', 'section', 'summary', 'table', 'ul',
]);

const EMPTY_ATTR = ['', [], []];

// ---------------------------------------------------------------------------
// normalizeHtml — unwrap HTML that was serialized as a JSON string
// ---------------------------------------------------------------------------
//
// Some upstream pipelines (LLM tool calls, REST APIs) hand off HTML as a
// JSON-encoded string — i.e. the whole document is wrapped in double quotes
// and every inner `"` becomes `\"`. Feeding that text to an HTML parser
// produces mangled attributes (e.g. `style=\"text-align: center\"` is read
// as the attribute name `style` with value `\` — and the real style is lost),
// which destroys text alignment, indents, font sizes and table borders in
// the converted HWPX. Detect that wrapping and decode it before parsing.
function normalizeHtml(content) {
  if (typeof content !== 'string') return content;
  const trimmed = content.trim();
  if (trimmed.length < 2) return content;
  if (trimmed[0] !== '"' || trimmed[trimmed.length - 1] !== '"') return content;
  if (!trimmed.includes('\\"') && !trimmed.includes('\\n') && !trimmed.includes('\\\\')) {
    return content;
  }
  try {
    const decoded = JSON.parse(trimmed);
    if (typeof decoded === 'string') return decoded;
  } catch (_) { /* not valid JSON — leave as-is */ }
  return content;
}

// ---------------------------------------------------------------------------
// Inline AST helpers
// ---------------------------------------------------------------------------

function _str(s)  { return { t: 'Str',       c: s }; }
function _space() { return { t: 'Space' }; }
function _soft()  { return { t: 'SoftBreak' }; }
function _lbr()   { return { t: 'LineBreak' }; }

// ---------------------------------------------------------------------------
// safeInt — tolerates malformed attribute values like '"2"', '\\"2\\"'
// ---------------------------------------------------------------------------

function safeInt(val, defaultVal = 1) {
  if (typeof val === 'number') return Math.trunc(val);
  let s = String(val).trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^[\\ "']+|[\\ "']+$/g, '');
  } while (s !== prev);
  const n = parseFloat(s);
  return isNaN(n) ? defaultVal : Math.trunc(n);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Convert raw text to Pandoc Str / Space / SoftBreak inlines.
 */
function textToInlines(raw) {
  if (!raw) return [];
  const tokens = raw.split(/(\s+)/);
  const result = [];
  for (const tok of tokens) {
    if (!tok) continue;
    if (/^\s+$/.test(tok)) {
      result.push(tok.includes('\n') ? _soft() : _space());
    } else {
      result.push(_str(tok));
    }
  }
  return result;
}

/**
 * Recursively collect all raw text under a node (htmlparser2 node).
 */
function collectText(node) {
  if (node.type === 'text') return node.data || '';
  if (!node.children) return '';
  return node.children.map(collectText).join('');
}

/**
 * Remove leading / trailing Space and SoftBreak nodes.
 */
function trim(inlines) {
  while (inlines.length && ['Space', 'SoftBreak'].includes(inlines[0].t)) {
    inlines.shift();
  }
  while (inlines.length && ['Space', 'SoftBreak'].includes(inlines[inlines.length - 1].t)) {
    inlines.pop();
  }
  return inlines;
}

// ---------------------------------------------------------------------------
// Block-hoisting helpers  (for invalid HTML like <p><span><table>…)
// ---------------------------------------------------------------------------

/**
 * Returns true if any descendant of `node` is a block-level element.
 * Used to detect tables/blocks buried inside inline/para wrappers.
 */
function hasBlockDescendant(node) {
  for (const ch of (node.children || [])) {
    const t = (ch.name || '').toLowerCase();
    if (BLOCK_TAGS.has(t)) return true;
    if (hasBlockDescendant(ch)) return true;
  }
  return false;
}

/**
 * Walk `node`'s subtree in an inline context.
 * Whenever a block-level element is encountered it is hoisted out;
 * surrounding inline content is collected normally.
 *
 * Returns an array of tagged entries:
 *   { t: 'inline', c: InlineAST[] }
 *   { t: 'block',  c: BlockAST   }
 *
 * This lets callers reconstruct the correct Para / Table / … sequence.
 * NOTE: forward-declared — actual body assigned after nodeToBlock is defined.
 */
let hoistBlocks; // assigned below

// ---------------------------------------------------------------------------
// Attribute helper
// ---------------------------------------------------------------------------

function nodeAttr(node) {
  if (!node) return EMPTY_ATTR;
  const a = node.attribs || {};
  const nodeId = a.id || '';
  const classes = (a.class || '').split(/\s+/).filter(Boolean);
  const kv = [];
  if (a.style) kv.push(['style', a.style]);
  if (a.width) kv.push(['width', String(a.width)]);  // HTML width="" attribute
  return [nodeId, classes, kv];
}

// ---------------------------------------------------------------------------
// Inline converter
// ---------------------------------------------------------------------------

/**
 * Convert an htmlparser2 node to a list of Pandoc inline AST dicts.
 */
function nodeToInlines(node) {
  // Text node
  if (node.type === 'text') {
    return textToInlines(node.data || '');
  }

  const tag = (node.name || '').toLowerCase();

  // Skip unwanted tags entirely
  if (SKIP_TAGS.has(tag)) return [];

  if (tag === 'br') return [_lbr()];

  if (tag === 'img') {
    const a = node.attribs || {};
    const src   = a.src   || '';
    const alt   = a.alt   || '';
    const title = a.title || '';
    const kv = [];
    if (a.width)  kv.push(['width',  a.width]);
    if (a.height) kv.push(['height', a.height]);
    const imgAttr = [a.id || '', (a.class || '').split(/\s+/).filter(Boolean), kv];
    return [{ t: 'Image', c: [imgAttr, textToInlines(alt), [src, title]] }];
  }

  // Collect children first
  const childrenInlines = [];
  for (const ch of (node.children || [])) {
    childrenInlines.push(...nodeToInlines(ch));
  }

  switch (tag) {
    case 'strong':
    case 'b':      return [{ t: 'Strong',      c: childrenInlines }];
    case 'em':
    case 'i':      return [{ t: 'Emph',        c: childrenInlines }];
    case 'u':      return [{ t: 'Underline',   c: childrenInlines }];
    case 's':
    case 'del':
    case 'strike': return [{ t: 'Strikeout',   c: childrenInlines }];
    case 'sup':    return [{ t: 'Superscript', c: childrenInlines }];
    case 'sub':    return [{ t: 'Subscript',   c: childrenInlines }];
    case 'code':   return [{ t: 'Code', c: [EMPTY_ATTR, collectText(node)] }];
    case 'a': {
      const a = node.attribs || {};
      const href  = a.href  || '';
      const title = a.title || '';
      return [{ t: 'Link', c: [nodeAttr(node), childrenInlines, [href, title]] }];
    }
    case 'span':
      // Forward style= so HtmlToHwpx can read colour / font-size
      return [{ t: 'Span', c: [nodeAttr(node), childrenInlines] }];
    default:
      // Transparent pass-through for everything else
      return childrenInlines;
  }
}

// ---------------------------------------------------------------------------
// Block converter
// ---------------------------------------------------------------------------

/**
 * Return all inline content from a node's children as a flat list.
 */
function inlineChildren(node) {
  const out = [];
  for (const ch of (node.children || [])) {
    out.push(...nodeToInlines(ch));
  }
  return out;
}

/**
 * Convert a list of child nodes to Pandoc block AST dicts.
 * Inline runs sitting between block elements are wrapped in Para.
 */
function childrenToBlocks(children) {
  const blocks = [];
  let inlineRun = [];

  function flush() {
    if (inlineRun.length) {
      const trimmed = trim([...inlineRun]);
      if (trimmed.length) blocks.push({ t: 'Para', c: trimmed });
      inlineRun = [];
    }
  }

  for (const node of (children || [])) {
    if (node.type === 'text') {
      const txt = node.data || '';
      if (txt.trim()) inlineRun.push(...textToInlines(txt));
      continue;
    }

    const tag = (node.name || '').toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;

    if (INLINE_TAGS.has(tag) || !BLOCK_TAGS.has(tag)) {
      // If this inline element hides block descendants (e.g. <span><table>…)
      // hoist the blocks out rather than swallowing the table as inline text.
      if (hasBlockDescendant(node)) {
        flush();
        const entries = hoistBlocks(node);
        let run2 = [];
        for (const e of entries) {
          if (e.t === 'inline') {
            run2.push(...e.c);
          } else {
            const tr = trim([...run2]);
            if (tr.length) blocks.push({ t: 'Para', c: tr });
            run2 = [];
            blocks.push(e.c);
          }
        }
        const tr = trim([...run2]);
        if (tr.length) blocks.push({ t: 'Para', c: tr });
        continue;
      }
      inlineRun.push(...nodeToInlines(node));
      continue;
    }

    flush();
    const result = nodeToBlock(node);
    if (result === null || result === undefined) continue;
    if (Array.isArray(result)) blocks.push(...result);
    else blocks.push(result);
  }

  flush();
  return blocks;
}

/**
 * Convert one block-level node to a Pandoc block AST dict (or array, or null).
 */
function nodeToBlock(node) {
  const tag    = (node.name || '').toLowerCase();
  const attribs = node.attribs || {};

  // ------------------------------------------------------------------ p
  if (tag === 'p') {
    // Fast path: no block descendants — standard para
    if (!hasBlockDescendant(node)) {
      const inlines = trim(inlineChildren(node));
      const block = { t: 'Para', c: inlines };
      const styleStr = (node.attribs || {}).style;
      if (styleStr) block.paraStyle = styleStr;
      return block;
    }
    // Slow path: block element(s) (e.g. <table>) buried inside inline
    // wrappers like <span> or <strong>.  Hoist them into sibling blocks.
    return _paraWithBlocks(node);
  }

  // ------------------------------------------------------------------ h1-h6
  if (/^h[1-6]$/.test(tag)) {
    const level = parseInt(tag[1], 10);
    return { t: 'Header', c: [level, nodeAttr(node), trim(inlineChildren(node))] };
  }

  // ------------------------------------------------------------------ pre
  if (tag === 'pre') {
    const codeCh = (node.children || []).find(c => (c.name || '') === 'code');
    if (codeCh) {
      const rawText = collectText(codeCh);
      const classes = ((codeCh.attribs || {}).class || '').split(/\s+/).filter(Boolean);
      const langs   = classes.map(c => c.startsWith('language-') ? c.slice(9) : c);
      return { t: 'CodeBlock', c: [['', langs, []], rawText] };
    }
    return { t: 'CodeBlock', c: [EMPTY_ATTR, collectText(node)] };
  }

  // ------------------------------------------------------------------ hr
  if (tag === 'hr') return { t: 'HorizontalRule' };

  // ------------------------------------------------------------------ blockquote
  if (tag === 'blockquote') {
    return { t: 'BlockQuote', c: childrenToBlocks(node.children) };
  }

  // ------------------------------------------------------------------ ul
  if (tag === 'ul') {
    return { t: 'BulletList', c: parseListItems(node) };
  }

  // ------------------------------------------------------------------ ol
  if (tag === 'ol') {
    const start    = safeInt(attribs.start, 1);
    const listAttr = [start, { t: 'Decimal' }, { t: 'Period' }];
    return { t: 'OrderedList', c: [listAttr, parseListItems(node)] };
  }

  // ------------------------------------------------------------------ table
  if (tag === 'table') return parseTable(node);

  // ------------------------------------------------------------------ figure
  if (tag === 'figure') {
    const inner = childrenToBlocks(node.children);
    return inner.length ? { t: 'Div', c: [nodeAttr(node), inner] } : null;
  }

  // ------------------------------------------------------------------ li (stray)
  if (tag === 'li') {
    return childrenToBlocks(node.children) || null;
  }

  // ------------------------------------------------------------------ generic containers
  const inner = childrenToBlocks(node.children);
  if (!inner.length) return null;
  const nodeId  = attribs.id    || '';
  const classes = attribs.class || '';
  const style   = attribs.style || '';
  if (!nodeId && !classes && !style) return inner; // unwrap transparent container
  return { t: 'Div', c: [nodeAttr(node), inner] };
}

// ---------------------------------------------------------------------------
// hoistBlocks — implementation (placed after nodeToBlock so it can call it)
// ---------------------------------------------------------------------------

hoistBlocks = function _hoistBlocks(node) {
  const result = [];

  function walk(n) {
    if (n.type === 'text') {
      const inls = textToInlines(n.data || '');
      if (inls.length) result.push({ t: 'inline', c: inls });
      return;
    }
    const tag = (n.name || '').toLowerCase();
    if (SKIP_TAGS.has(tag)) return;

    // Block element encountered inside an inline context — hoist it
    if (BLOCK_TAGS.has(tag)) {
      const blk = nodeToBlock(n);
      if (blk !== null && blk !== undefined) {
        const arr = Array.isArray(blk) ? blk : [blk];
        for (const b of arr) result.push({ t: 'block', c: b });
      }
      return;
    }

    // Inline element that contains no block descendants — safe to convert normally
    if (!hasBlockDescendant(n)) {
      const inls = nodeToInlines(n);
      if (inls.length) result.push({ t: 'inline', c: inls });
      return;
    }

    // Inline element that DOES contain block descendants — strip the wrapper
    // and recurse so the inner block(s) can be hoisted
    for (const ch of (n.children || [])) walk(ch);
  }

  for (const ch of (node.children || [])) walk(ch);
  return result;
};

/**
 * Convert a <p> whose subtree contains block-level elements (e.g. <table>
 * nested inside a <span>) into a flat array of Block AST nodes.
 * Inline runs are wrapped in Para; block elements are emitted as-is.
 * Returns a single block when the result is exactly one block, otherwise
 * returns an array (childrenToBlocks already handles both forms).
 */
function _paraWithBlocks(pNode) {
  const entries = hoistBlocks(pNode);
  const blocks  = [];
  let run = [];

  for (const e of entries) {
    if (e.t === 'inline') {
      run.push(...e.c);
    } else {
      const trimmed = trim([...run]);
      if (trimmed.length) blocks.push({ t: 'Para', c: trimmed });
      run = [];
      blocks.push(e.c);
    }
  }
  const trimmed = trim([...run]);
  if (trimmed.length) blocks.push({ t: 'Para', c: trimmed });

  if (!blocks.length) return null;
  return blocks.length === 1 ? blocks[0] : blocks;
}

// ---------------------------------------------------------------------------
// List items
// ---------------------------------------------------------------------------

function parseListItems(listNode) {
  const items = [];
  for (const ch of (listNode.children || [])) {
    if ((ch.name || '') !== 'li') continue;
    const itemBlocks = childrenToBlocks(ch.children || []);
    items.push(itemBlocks.length ? itemBlocks : [{ t: 'Plain', c: [] }]);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function findFirstChild(node, tag) {
  return (node.children || []).find(c => (c.name || '') === tag) || null;
}

function findAllChildren(node, tag) {
  return (node.children || []).filter(c => (c.name || '') === tag);
}

function parseTableRow(trNode) {
  const cells = [];
  for (const cellNode of (trNode.children || [])) {
    const cellTag = (cellNode.name || '');
    if (cellTag !== 'td' && cellTag !== 'th') continue;
    const a       = cellNode.attribs || {};
    const colspan = safeInt(a.colspan, 1);
    const rowspan = safeInt(a.rowspan, 1);
    const blocks  = childrenToBlocks(cellNode.children || []);
    // Pandoc cell: [attr, alignment, rowspan, colspan, [blocks]]
    // Use nodeAttr(cellNode) instead of EMPTY_ATTR to preserve the cell's
    // style= attribute (border-left/right/top/bottom, etc.) so downstream
    // converters can honour hidden/custom borders.
    cells.push([nodeAttr(cellNode), { t: 'AlignDefault' }, rowspan, colspan,
                blocks.length ? blocks : [{ t: 'Plain', c: [] }]]);
  }
  return [EMPTY_ATTR, cells];
}

/**
 * Extract a raw { value, unit } width from a node's width/style attributes.
 * Returns null if no usable width is found.
 */
function extractNodeWidth(node) {
  const a = node.attribs || {};
  // 1. style="... width: X unit ..."
  const styleStr = a.style || '';
  const sm = styleStr.match(/(?:^|;)\s*width\s*:\s*([\d.]+)\s*(px|pt|%|cm|mm|in)?/i);
  if (sm) {
    const v = parseFloat(sm[1]);
    const u = (sm[2] || 'px').toLowerCase();
    if (!isNaN(v) && v > 0) return { value: v, unit: u };
  }
  // 2. width="Xpx" / width="X%" / width="X" (plain number)
  const wAttr = String(a.width || '').trim();
  if (wAttr) {
    const wm = wAttr.match(/^([\d.]+)\s*(px|pt|%|cm|mm|in)?/i);
    if (wm) {
      const v = parseFloat(wm[1]);
      const u = (wm[2] || 'px').toLowerCase();
      if (!isNaN(v) && v > 0) return { value: v, unit: u };
    }
  }
  return null;
}

/**
 * Convert a { value, unit } width to a comparable numeric value
 * (px-equivalent for absolute units; raw value for %).
 * Since the results are always normalised to fractions via sum-division,
 * the absolute scale does not matter — only the relative ratios do.
 */
function widthToRelative(w) {
  if (!w) return null;
  const { value, unit } = w;
  if (unit === '%')  return value;           // 0–100, normalised later
  if (unit === 'pt') return value * 96 / 72; // → px-equivalent
  if (unit === 'cm') return value * 37.795;
  if (unit === 'mm') return value * 3.7795;
  if (unit === 'in') return value * 96;
  return value;                              // px or unknown
}


/**
 * Return a comparable width value for a <col> node (any unit),
 * or null if no width is specified.
 * Values are later normalised to 0..1 fractions in parseTable.
 */
function parseColWidth(colNode) {
  return widthToRelative(extractNodeWidth(colNode));
}

function parseTable(tableNode) {
  const theadNode  = findFirstChild(tableNode, 'thead');
  const tfootNode  = findFirstChild(tableNode, 'tfoot');
  const tbodyNodes = findAllChildren(tableNode, 'tbody');
  const directTrs  = (tableNode.children || []).filter(c => (c.name || '') === 'tr');

  const headTrs = theadNode ? findAllChildren(theadNode, 'tr') : [];
  const footTrs = tfootNode ? findAllChildren(tfootNode, 'tr') : [];
  let bodyTrs;
  if (tbodyNodes.length) {
    bodyTrs = tbodyNodes.flatMap(tb => findAllChildren(tb, 'tr'));
  } else {
    bodyTrs = directTrs.filter(tr => !headTrs.includes(tr) && !footTrs.includes(tr));
  }

  const allTrs = [...headTrs, ...bodyTrs, ...footTrs];
  const colCnt = Math.max(1, ...allTrs.map(tr =>
    (tr.children || [])
      .filter(c => c.name === 'td' || c.name === 'th')
      .reduce((sum, c) => sum + safeInt((c.attribs || {}).colspan, 1), 0)
  ));

  // ── Priority 1: explicit <colgroup><col> widths ──────────────────────────
  const colgroupNode = findFirstChild(tableNode, 'colgroup');
  const colNodes     = colgroupNode ? findAllChildren(colgroupNode, 'col') : [];
  let   rawWidths    = colNodes.map(parseColWidth);   // comparable numeric values or null
  let   hasWidths    = rawWidths.some(f => f !== null);

  // ── Priority 2: cell width styles/attributes (scans all rows) ───────────
  if (!hasWidths) {
    const colHints = new Array(colCnt).fill(null);

    for (const trNode of allTrs) {
      let col = 0;
      for (const cellNode of (trNode.children || [])) {
        if (cellNode.name !== 'td' && cellNode.name !== 'th') continue;
        if (col >= colCnt) break;
        const colspan = safeInt((cellNode.attribs || {}).colspan, 1);
        const w       = widthToRelative(extractNodeWidth(cellNode));
        if (w !== null) {
          // Distribute the cell's stated width across its spanned columns
          const perCol = w / colspan;
          for (let c = 0; c < colspan && col + c < colCnt; c++) {
            if (colHints[col + c] === null) colHints[col + c] = perCol;
          }
        }
        col += colspan;
      }
      if (colHints.every(h => h !== null)) break;
    }

    if (colHints.some(h => h !== null)) {
      // Fill any remaining gaps with the average of known widths
      const known  = colHints.filter(h => h !== null);
      const avg    = known.reduce((a, b) => a + b, 0) / known.length;
      rawWidths = colHints.map(h => h !== null ? h : avg);
      hasWidths = true;
    }
  }

  // ── Priority 3: Content-length heuristic (no explicit widths found) ──────
  // When the HTML carries no width attributes at all (common when HTML was
  // exported from HWPX without preserving widths), estimate proportional
  // column widths from the maximum character count found in any cell of each
  // column.  Border-less, content-free columns are treated as narrow spacers.
  if (!hasWidths) {
    const colMaxChars  = new Array(colCnt).fill(0);
    const colHasBorder = new Array(colCnt).fill(false);

    // Regex that matches a CSS border-side property with a visible style
    const BORDER_RE = /border(?:-(?:left|right|top|bottom))?\s*:\s*(?!none\b)[^;]+(?:solid|dashed|dotted|double)/i;

    for (const trNode of allTrs) {
      let col = 0;
      for (const cellNode of (trNode.children || [])) {
        if (cellNode.name !== 'td' && cellNode.name !== 'th') continue;
        if (col >= colCnt) break;
        const colspan  = safeInt((cellNode.attribs || {}).colspan, 1);
        const text     = collectText(cellNode).replace(/\s+/g, ' ').trim();
        const charCnt  = text.length;
        const styleStr = (cellNode.attribs || {}).style || '';
        const hasBorder = BORDER_RE.test(styleStr);

        // Each spanned column gets a 1/colspan share of the cell's content
        const perCol = colspan > 0 ? charCnt / colspan : charCnt;
        for (let c = 0; c < colspan && col + c < colCnt; c++) {
          if (perCol > colMaxChars[col + c]) colMaxChars[col + c] = perCol;
          if (hasBorder) colHasBorder[col + c] = true;
        }
        col += colspan;
      }
    }

    const totalContent = colMaxChars.reduce((a, b) => a + b, 0);
    if (totalContent > 0 || colHasBorder.some(Boolean)) {
      // Spacer columns (no visible border, no content) get a small token weight
      // so they render as thin separators rather than taking up equal space.
      const spacerWeight = Math.max(totalContent * 0.025, 1);
      rawWidths = colMaxChars.map((w, i) => {
        if (w === 0 && !colHasBorder[i]) return spacerWeight;  // narrow spacer
        return Math.max(w, spacerWeight);                       // content col
      });
      hasWidths = true;
    }
  }

  // ── Normalise raw widths → 0..1 fractions ───────────────────────────────
  let colFracs = rawWidths;
  if (hasWidths) {
    const total = rawWidths.reduce((s, f) => s + (f !== null ? f : 0), 0);
    if (total > 0) {
      colFracs = rawWidths.map(f => f !== null ? f / total : null);
    } else {
      hasWidths = false;
    }
  }

  // ColWidth.c stores the fraction as a plain number (not wrapped in an array).
  // Wrapping it in [frac] causes HtmlToHwpx to receive an array where it
  // expects a number, silently falling back to equal-width distribution.
  const colspec = Array.from({ length: colCnt }, (_, i) => {
    const frac = hasWidths && i < colFracs.length ? colFracs[i] : null;
    return frac !== null
      ? [{ t: 'AlignDefault' }, { t: 'ColWidth', c: frac }]
      : [{ t: 'AlignDefault' }, { t: 'ColWidthDefault' }];
  });

  const head   = [EMPTY_ATTR, headTrs.map(parseTableRow)];
  const bodies = [[EMPTY_ATTR, 0, [], bodyTrs.map(parseTableRow)]];
  const foot   = [EMPTY_ATTR, footTrs.map(parseTableRow)];
  const caption = [null, []];

  return {
    t: 'Table',
    c: [nodeAttr(tableNode), caption, colspec, head, bodies, foot],
  };
}

// ---------------------------------------------------------------------------
// Document-level helpers
// ---------------------------------------------------------------------------

function findTag(node, tag) {
  if ((node.name || '') === tag) return node;
  for (const ch of (node.children || [])) {
    const found = findTag(ch, tag);
    if (found) return found;
  }
  return null;
}

function extractTitle(root) {
  const titleNode = findTag(root, 'title');
  return titleNode ? collectText(titleNode).trim() : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

class HtmlToAst {
  /**
   * Parse an HTML string and return a Pandoc-compatible AST object.
   * @param {string} htmlContent
   * @returns {object}
   */
  static parse(htmlContent) {
    htmlContent = normalizeHtml(htmlContent);
    const dom  = parseDocument(htmlContent, { decodeEntities: true, lowerCaseTags: true });
    const body  = findTag(dom, 'body') || dom;
    const title = extractTitle(dom);
    const blocks = childrenToBlocks(body.children || []);

    const meta = {};
    if (title) meta.title = { t: 'MetaInlines', c: [_str(title)] };

    return {
      'pandoc-api-version': [1, 23, 1],
      meta,
      blocks,
    };
  }

  /**
   * Read an HTML file and return a Pandoc-compatible AST object.
   * @param {string} filePath
   * @returns {object}
   */
  static parseFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    return HtmlToAst.parse(content);
  }
}

module.exports = { HtmlToAst, safeInt, EMPTY_ATTR, normalizeHtml };