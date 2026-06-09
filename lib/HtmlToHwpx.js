'use strict';
/**
 * HtmlToHwpx.js — AST → HWPX XML / zip converter.
 *
 * Direct JavaScript translation of HtmlToHwpx.py.
 * Uses:
 *   @xmldom/xmldom  — XML DOM (replaces xml.etree.ElementTree)
 *   jszip           — ZIP creation (replaces zipfile)
 *   htmlparser2     — HTML parsing (replaces html.parser)
 *   image-size      — Image dimensions (replaces Pillow)
 */

const fs          = require('fs');
const path        = require('path');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const JSZip       = require('jszip');
const { Parser }  = require('htmlparser2');
const { HtmlToAst, normalizeHtml } = require('./HtmlToAst');

// ---------------------------------------------------------------------------
// Namespace URIs
// ---------------------------------------------------------------------------

const HH_NS = 'http://www.hancom.co.kr/hwpml/2011/head';
const HP_NS = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const HC_NS = 'http://www.hancom.co.kr/hwpml/2011/core';
const HS_NS = 'http://www.hancom.co.kr/hwpml/2011/section';

const NS_MAP = { hh: HH_NS, hp: HP_NS, hc: HC_NS, hs: HS_NS };

// ---------------------------------------------------------------------------
// XML DOM helpers (replace xml.etree.ElementTree operations)
// ---------------------------------------------------------------------------

/** Find first direct child with given namespace + localName. */
function findDirectChild(parent, ns, localName) {
  for (let ch = parent.firstChild; ch; ch = ch.nextSibling) {
    if (ch.nodeType === 1 && ch.namespaceURI === ns && ch.localName === localName) return ch;
  }
  return null;
}

/** Find first descendant (any depth) with given namespace + localName. */
function findDescendant(root, ns, localName) {
  const els = root.getElementsByTagNameNS(ns, localName);
  return els.length > 0 ? els[0] : null;
}

/** Find first descendant with given ns+localName matching an attribute value. */
function findDescendantByAttr(root, ns, localName, attr, val) {
  const els = root.getElementsByTagNameNS(ns, localName);
  for (let i = 0; i < els.length; i++) {
    if (els[i].getAttribute(attr) === val) return els[i];
  }
  return null;
}

/** Get all descendants with given ns+localName. */
function getAllDescendants(root, ns, localName) {
  return Array.from(root.getElementsByTagNameNS(ns, localName));
}

/**
 * Follow a slash-separated path of direct children.
 * e.g. findByPath(node, 'hp:switch/hp:default/hh:margin/hc:left')
 */
function findByPath(node, pathStr) {
  const parts = pathStr.split('/');
  let current = node;
  for (const part of parts) {
    const [prefix, localName] = part.split(':');
    const ns = NS_MAP[prefix];
    if (!ns) return null;
    const found = findDirectChild(current, ns, localName);
    if (!found) return null;
    current = found;
  }
  return current;
}

/**
 * Create an element with the given namespace and append it to parent.
 * Replaces ET.SubElement(parent, '{ns}tag').
 */
function createElement(parent, ns, prefix, localName) {
  const doc = parent.ownerDocument;
  const el  = doc.createElementNS(ns, `${prefix}:${localName}`);
  parent.appendChild(el);
  return el;
}

/** Count direct children with given ns+localName. */
function countDirectChildren(parent, ns, localName) {
  let n = 0;
  for (let ch = parent.firstChild; ch; ch = ch.nextSibling) {
    if (ch.nodeType === 1 && ch.namespaceURI === ns && ch.localName === localName) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// XML escape (replaces saxutils.escape)
// ---------------------------------------------------------------------------

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// HTMLStyleExtractor — replaces HTMLStyleExtractor in Python
// ---------------------------------------------------------------------------

class HTMLStyleExtractor {
  constructor() {
    this.styleStack    = [];
    this.textSegments  = [];
    this.paraStyles    = [];
  }

  feed(html) {
    const self = this;
    const parser = new Parser({
      onopentag(tag, attrs) {
        const styleDict = {};
        const styleStr  = attrs.style || '';
        for (const part of styleStr.split(';')) {
          if (!part.includes(':')) continue;
          const idx = part.indexOf(':');
          const key = part.slice(0, idx).trim().toLowerCase();
          const val = part.slice(idx + 1).trim();
          styleDict[key] = val;
        }
        if (tag === 'p') self.paraStyles.push({ ...styleDict });
        if (tag === 'strong' || tag === 'b')  styleDict['font-weight'] = 'bold';
        else if (tag === 'em' || tag === 'i') styleDict['font-style']  = 'italic';
        else if (tag === 'u')                 styleDict['text-decoration'] = 'underline';
        self.styleStack.push([tag, styleDict]);
      },
      onclosetag(tag) {
        if (self.styleStack.length && self.styleStack[self.styleStack.length - 1][0] === tag) {
          self.styleStack.pop();
        }
      },
      ontext(data) {
        if (data.trim()) {
          const combined = {};
          for (const [, style] of self.styleStack) Object.assign(combined, style);
          self.textSegments.push([data, { ...combined }]);
        }
      },
    }, { decodeEntities: true });
    parser.write(html);
    parser.end();
  }
}

// ---------------------------------------------------------------------------
// HTMLParagraphStyleExtractor — replaces HTMLParagraphStyleExtractor in Python
// ---------------------------------------------------------------------------

function extractHtmlParaStyles(htmlContent) {
  const paraStyles = {};
  let inParagraph        = false;
  let currentParaContent = [];
  let currentParaStyles  = {};

  const parser = new Parser({
    onopentag(tag, attrs) {
      if (tag === 'p') {
        inParagraph        = true;
        currentParaContent = [];
        currentParaStyles  = {};
        const styleStr = attrs.style || '';
        for (const part of styleStr.split(';')) {
          if (!part.includes(':')) continue;
          const idx = part.indexOf(':');
          const key = part.slice(0, idx).trim().toLowerCase();
          const val = part.slice(idx + 1).trim();
          if (key === 'padding-left') currentParaStyles['padding-left'] = val;
          else if (key === 'margin-left') currentParaStyles['margin-left'] = val;
          else if (key === 'text-indent') currentParaStyles['text-indent'] = val;
          else if (key === 'text-align') currentParaStyles['text-align'] = val;
          else if (key === 'margin-right') currentParaStyles['margin-right'] = val;
          else if (key === 'margin-bottom') currentParaStyles['margin-bottom'] = val;
          else if (key === 'margin-top') currentParaStyles['margin-top'] = val;
        }
      }
    },
    onclosetag(tag) {
      if (tag === 'p' && inParagraph) {
        const contentText = currentParaContent.join('').trim();
        if (contentText && Object.keys(currentParaStyles).length > 0) {
          paraStyles[contentText.slice(0, 100)] = { ...currentParaStyles };
        }
        inParagraph        = false;
        currentParaContent = [];
        currentParaStyles  = {};
      }
    },
    ontext(data) {
      if (inParagraph) currentParaContent.push(data);
    },
  }, { decodeEntities: true });

  try {
    parser.write(htmlContent);
    parser.end();
  } catch (e) {
    process.stderr.write(`[Warn] Failed to extract HTML paragraph styles: ${e}\n`);
  }
  return paraStyles;
}

// ---------------------------------------------------------------------------
// Main converter class
// ---------------------------------------------------------------------------

class HtmlToHwpx {
  constructor({ jsonAst = null, headerXmlContent = null, htmlContent = null, basePath = null } = {}) {
    this.ast               = jsonAst;
    this.output            = [];
    this.headerXmlContent  = headerXmlContent;
    this.htmlContent       = htmlContent;

    this.htmlParaStyles = {};
    if (htmlContent) {
      this.htmlContent    = normalizeHtml(htmlContent);
      this.htmlParaStyles = extractHtmlParaStyles(this.htmlContent);
    }

    this.STYLE_MAP = { Normal: 0, Header1: 1, Header2: 2, Header3: 3,
                       Header4: 4, Header5: 5, Header6: 6 };
    this.dynamicStyleMap = {};
    this.normalStyleId   = 0;
    this.normalParaPrId  = 1;

    this.headerDoc  = null;
    this.headerRoot = null;

    this.charPrCache          = new Map();
    this.maxCharPrId          = 0;
    this.maxParaPrId          = 0;
    this.maxBorderFillId      = 0;
    this.paraPrCache          = new Map();
    this.images               = [];
    this._imageCounter        = 0;
    this._basePath            = basePath || null;
    this.tableBorderFillId    = null;
    this._hrBorderFillId      = null;
    this._cellBorderFillCache = new Map();   // cache for per-cell border fills
    this._paraBorderFillCache = new Map();   // cache for paragraph background borderFills

    this.title = null;
    this._extractMetadata();

    if (headerXmlContent) {
      this._parseStylesAndInitXml(headerXmlContent);
    }
  }

  // ------------------------------------------------------------------ helpers

  _extractMetadata() {
    if (!this.ast) return;
    const meta = this.ast.meta || {};
    if (meta.title) {
      const tObj = meta.title;
      if (tObj.t === 'MetaInlines') this.title = this._getPlainText(tObj.c || []);
      else if (tObj.t === 'MetaString') this.title = tObj.c || '';
    }
  }

  _getPlainText(inlines) {
    if (!Array.isArray(inlines)) return '';
    const text = [];
    for (const item of inlines) {
      const t = item.t;
      const c = item.c;
      if (t === 'Str')   text.push(c);
      else if (t === 'Space') text.push(' ');
      else if (['Strong','Emph','Underline','Strikeout','Superscript','Subscript','SmallCaps'].includes(t))
        text.push(this._getPlainText(c));
      else if (t === 'Span') text.push(this._getPlainText(c[1]));
      else if (t === 'Link') text.push(this._getPlainText(c[1]));
      else if (t === 'Image') text.push(this._getPlainText(c[1]));
      else if (t === 'Code') text.push(c[1]);
      else if (t === 'Quoted') text.push('"' + this._getPlainText(c[1]) + '"');
      else if (t === 'LineBreak' || t === 'SoftBreak') text.push('\n');
    }
    return text.join('');
  }

  _convertColorToHwp(color) {
    if (!color) return '#000000';
    const colorMap = {
      red: '#FF0000', green: '#008000', blue: '#0000FF',
      black: '#000000', white: '#FFFFFF', yellow: '#FFFF00',
      cyan: '#00FFFF', magenta: '#FF00FF', orange: '#FFA500',
      purple: '#800080', pink: '#FFC0CB', brown: '#A52A2A',
      gray: '#808080', grey: '#808080', lime: '#00FF00',
      navy: '#000080', teal: '#008080', silver: '#C0C0C0',
      maroon: '#800000', olive: '#808000',
    };
    color = color.toLowerCase().trim();
    if (colorMap[color]) return colorMap[color];
    if (color.startsWith('#')) {
      if (color.length === 7) return color.toUpperCase();
      if (color.length === 4) {
        const [, r, g, b] = color;
        return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
      }
    }
    const rgbMatch = color.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (rgbMatch) {
      const [, r, g, b] = rgbMatch.map(Number);
      return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`.toUpperCase();
    }
    return '#000000';
  }

  _convertSizeToHwp(sizeStr) {
    if (!sizeStr) return null;
    const s = sizeStr.toLowerCase().trim();
    if (s.endsWith('pt')) {
      const v = parseFloat(s);
      return isNaN(v) ? null : Math.trunc(v);
    }
    if (s.endsWith('px')) {
      const v = parseFloat(s);
      return isNaN(v) ? null : Math.trunc(v * 72 / 96);
    }
    const v = parseFloat(s);
    return isNaN(v) ? null : Math.trunc(v);
  }

  _parseParaStyleStr(styleStr) {
    const result = {};
    if (!styleStr) return result;
    for (const part of styleStr.split(';')) {
      const colonIdx = part.indexOf(':');
      if (colonIdx < 0) continue;
      const key = part.slice(0, colonIdx).trim().toLowerCase();
      const val = part.slice(colonIdx + 1).trim();
      switch (key) {
        case 'text-align': {
          const a = val.toLowerCase();
          if      (a === 'center')  result.align = 'CENTER';
          else if (a === 'right')   result.align = 'RIGHT';
          else if (a === 'left')    result.align = 'LEFT';
          else if (a === 'justify') result.align = 'JUSTIFY';
          break;
        }
        case 'padding-left':
        case 'margin-left': {
          const v = this._convertSizeToHwp(val);
          if (v !== null) result.paddingLeft = v;
          break;
        }
        case 'text-indent': {
          const v = this._convertSizeToHwp(val);
          if (v !== null) result.textIndent = v;
          break;
        }
        case 'margin-right':
        case 'padding-right': {
          const v = this._convertSizeToHwp(val);
          if (v !== null) result.marginRight = v;
          break;
        }
        case 'margin-bottom': {
          const v = this._convertSizeToHwp(val);
          if (v !== null) result.spaceAfter = v;
          break;
        }
        case 'margin-top': {
          const v = this._convertSizeToHwp(val);
          if (v !== null) result.spaceBefore = v;
          break;
        }
        case 'background-color':
        case 'background': {
          const v = val.toLowerCase().trim();
          if (v !== 'transparent' && v !== 'none' && v !== 'inherit' && v !== 'initial' && v !== 'unset') {
            const c = this._convertColorToHwp(val);
            if (c) result.bgColor = c;
          }
          break;
        }
      }
    }
    return result;
  }

  _extractStyleFromAttr(attr) {
    const styles = {};
    if (!attr || attr.length < 3) return styles;
    for (const cls of attr[1]) {
      const cl = cls.toLowerCase();
      if (cl.includes('bold')   || cl.includes('strong')) styles.bold      = true;
      if (cl.includes('italic') || cl.includes('emph'))   styles.italic    = true;
      if (cl.includes('underline'))                        styles.underline = true;
    }
    for (const [key, val] of attr[2]) {
      if (key.toLowerCase() === 'style') {
        for (const part of val.split(';')) {
          if (!part.includes(':')) continue;
          const idx = part.indexOf(':');
          const sk  = part.slice(0, idx).trim().toLowerCase();
          const sv  = part.slice(idx + 1).trim();
          if (sk === 'color')                                    styles.color        = this._convertColorToHwp(sv);
          else if (sk === 'font-size')                           styles['font-size'] = this._convertSizeToHwp(sv);
          else if (sk === 'font-weight') {
            const fw = sv.toLowerCase().trim();
            const fwNum = parseInt(fw, 10);
            if (fw.includes('bold') || fw === 'bolder' || (!isNaN(fwNum) && fwNum >= 600))
              styles.bold = true;
          }
          else if (sk === 'font-style' && sv.toLowerCase().includes('italic'))
            styles.italic = true;
          else if (sk === 'text-decoration') {
            if (sv.toLowerCase().includes('underline'))    styles.underline = true;
            if (sv.toLowerCase().includes('line-through')) styles.strikeout = true;
          }
          else if (sk === 'padding-left') styles['padding-left'] = this._convertSizeToHwp(sv);
          else if (sk === 'margin-left')  styles['margin-left']  = this._convertSizeToHwp(sv);
          else if (sk === 'text-indent')  styles['text-indent']  = this._convertSizeToHwp(sv);
        }
      }
    }
    return styles;
  }

  _parseStylesAndInitXml(headerXmlContent) {
    try {
      const domParser  = new DOMParser();
      this.headerDoc   = domParser.parseFromString(headerXmlContent, 'text/xml');
      this.headerRoot  = this.headerDoc.documentElement;

      for (const cp of getAllDescendants(this.headerRoot, HH_NS, 'charPr')) {
        const cid = parseInt(cp.getAttribute('id') || '0', 10);
        if (cid > this.maxCharPrId) this.maxCharPrId = cid;
      }
      for (const pp of getAllDescendants(this.headerRoot, HH_NS, 'paraPr')) {
        const pid = parseInt(pp.getAttribute('id') || '0', 10);
        if (pid > this.maxParaPrId) this.maxParaPrId = pid;
      }
      for (const bf of getAllDescendants(this.headerRoot, HH_NS, 'borderFill')) {
        const bid = parseInt(bf.getAttribute('id') || '0', 10);
        if (bid > this.maxBorderFillId) this.maxBorderFillId = bid;
      }

      for (const style of getAllDescendants(this.headerRoot, HH_NS, 'style')) {
        const name = style.getAttribute('name') || '';
        const sid  = parseInt(style.getAttribute('id') || '0', 10);
        if (name === 'Normal' || name === '바탕글') {
          this.normalStyleId  = sid;
          this.normalParaPrId = parseInt(style.getAttribute('paraPrIDRef') || '1', 10);
        }
        this.dynamicStyleMap[name] = sid;
      }
    } catch (e) {
      process.stderr.write(`[Warn] Failed to parse header.xml: ${e}\n`);
    }
  }

  // ------------------------------------------------------------------ charPr

  _getOrCreateCharPr(baseCharPrId = 0, activeFormats = new Set(), color = null, fontSize = null) {
    const baseIdStr  = String(baseCharPrId);
    const fmtKey     = [...activeFormats].sort().join(',');
    const cacheKey   = `${baseIdStr}|${fmtKey}|${color}|${fontSize}`;
    if (this.charPrCache.has(cacheKey)) return this.charPrCache.get(cacheKey);
    if (activeFormats.size === 0 && !color && !fontSize) return baseIdStr;
    if (!this.headerRoot) return baseIdStr;

    let baseNode = findDescendantByAttr(this.headerRoot, HH_NS, 'charPr', 'id', baseIdStr);
    if (!baseNode) baseNode = findDescendantByAttr(this.headerRoot, HH_NS, 'charPr', 'id', '0');
    if (!baseNode) return baseIdStr;

    const newNode = baseNode.cloneNode(true);
    this.maxCharPrId++;
    const newId = String(this.maxCharPrId);
    newNode.setAttribute('id', newId);

    if (color) {
      newNode.setAttribute('textColor', color);
      const ul = findDirectChild(newNode, HH_NS, 'underline');
      if (ul) ul.setAttribute('color', color);
    }
    if (fontSize) {
      newNode.setAttribute('height', String(fontSize * 100));
    }
    if (activeFormats.has('BOLD')) {
      if (!findDirectChild(newNode, HH_NS, 'bold'))
        createElement(newNode, HH_NS, 'hh', 'bold');
    }
    if (activeFormats.has('ITALIC')) {
      if (!findDirectChild(newNode, HH_NS, 'italic'))
        createElement(newNode, HH_NS, 'hh', 'italic');
    }
    if (activeFormats.has('UNDERLINE')) {
      let ul = findDirectChild(newNode, HH_NS, 'underline');
      if (!ul) ul = createElement(newNode, HH_NS, 'hh', 'underline');
      ul.setAttribute('type', 'BOTTOM');
      ul.setAttribute('shape', 'SOLID');
      ul.setAttribute('color', color || '#000000');
    }
    if (activeFormats.has('STRIKEOUT')) {
      let st = findDirectChild(newNode, HH_NS, 'strikeout');
      if (!st) st = createElement(newNode, HH_NS, 'hh', 'strikeout');
      st.setAttribute('shape', 'CONTINUOUS');
      st.setAttribute('color', color || '#000000');
    }
    if (activeFormats.has('SUPERSCRIPT')) {
      const sub = findDirectChild(newNode, HH_NS, 'subscript');
      if (sub) newNode.removeChild(sub);
      if (!findDirectChild(newNode, HH_NS, 'supscript'))
        createElement(newNode, HH_NS, 'hh', 'supscript');
    } else if (activeFormats.has('SUBSCRIPT')) {
      const sup = findDirectChild(newNode, HH_NS, 'supscript');
      if (sup) newNode.removeChild(sup);
      if (!findDirectChild(newNode, HH_NS, 'subscript'))
        createElement(newNode, HH_NS, 'hh', 'subscript');
    }

    const charProps = findDescendant(this.headerRoot, HH_NS, 'charProperties');
    if (charProps) charProps.appendChild(newNode);
    this.charPrCache.set(cacheKey, newId);
    return newId;
  }

  // ------------------------------------------------------------------ paraPr

  _getOrCreateParaPr(paddingLeft = 0, textIndent = 0, align = null, marginRight = 0, spaceBefore = 0, spaceAfter = 0, bgColor = null) {
    const leftMargin  = paddingLeft  ? Math.trunc(paddingLeft  * 100) : 0;
    const indentVal   = textIndent   ? Math.trunc(textIndent   * 100) : 0;
    const rightVal    = marginRight  ? Math.trunc(marginRight  * 100) : 0;
    const prevVal     = spaceBefore  ? Math.trunc(spaceBefore  * 100) : 0;
    const nextVal     = spaceAfter   ? Math.trunc(spaceAfter   * 100) : 0;
    const alignKey    = align || '';
    const cacheKey    = `${leftMargin},${indentVal},${alignKey},${rightVal},${prevVal},${nextVal},${bgColor || ''}`;
    if (this.paraPrCache.has(cacheKey)) return this.paraPrCache.get(cacheKey);
    if (leftMargin === 0 && indentVal === 0 && !align && rightVal === 0 && prevVal === 0 && nextVal === 0 && !bgColor) return String(this.normalParaPrId);
    if (!this.headerRoot) return String(this.normalParaPrId);

    let baseNode = findDescendantByAttr(this.headerRoot, HH_NS, 'paraPr', 'id', String(this.normalParaPrId));
    if (!baseNode) baseNode = findDescendantByAttr(this.headerRoot, HH_NS, 'paraPr', 'id', '0');
    if (!baseNode) return String(this.normalParaPrId);

    const newNode = baseNode.cloneNode(true);
    this.maxParaPrId++;
    const newId = String(this.maxParaPrId);
    newNode.setAttribute('id', newId);

    // Alignment lives on the top-level hh:align horizontal= of the paraPr,
    // not inside hp:switch/hp:case/hp:default.
    if (align) {
      let alignElem = findDirectChild(newNode, HH_NS, 'align');
      if (!alignElem) {
        const doc = newNode.ownerDocument;
        alignElem = doc.createElementNS(HH_NS, 'hh:align');
        const switchRef = findDirectChild(newNode, HP_NS, 'switch');
        if (switchRef) newNode.insertBefore(alignElem, switchRef);
        else newNode.appendChild(alignElem);
        alignElem.setAttribute('vertical', 'BASELINE');
      }
      alignElem.setAttribute('horizontal', align);
    }

    const setMargin = (parentElem) => {
      let margin = findDirectChild(parentElem, HH_NS, 'margin');
      if (!margin) margin = createElement(parentElem, HH_NS, 'hh', 'margin');
      const marginFields = [['intent', indentVal], ['left', leftMargin]];
      if (rightVal !== 0) marginFields.push(['right', rightVal]);
      if (prevVal !== 0)  marginFields.push(['prev', prevVal]);
      if (nextVal !== 0)  marginFields.push(['next', nextVal]);
      for (const [localName, val] of marginFields) {
        let elem = findDirectChild(margin, HC_NS, localName);
        if (!elem) elem = createElement(margin, HC_NS, 'hc', localName);
        elem.setAttribute('value', String(val));
        elem.setAttribute('unit', 'HWPUNIT');
      }
    };

    let switchElem = findDirectChild(newNode, HP_NS, 'switch');
    if (!switchElem) switchElem = createElement(newNode, HP_NS, 'hp', 'switch');

    let caseElem = findDirectChild(switchElem, HP_NS, 'case');
    if (!caseElem) {
      caseElem = createElement(switchElem, HP_NS, 'hp', 'case');
      caseElem.setAttribute(`${HP_NS}:required-namespace`, 'http://www.hancom.co.kr/hwpml/2016/HwpUnitChar');
    }
    setMargin(caseElem);

    let defaultElem = findDirectChild(switchElem, HP_NS, 'default');
    if (!defaultElem) defaultElem = createElement(switchElem, HP_NS, 'hp', 'default');
    setMargin(defaultElem);

    if (bgColor) {
      const bfId = this._getOrCreateParaBorderFill(bgColor);
      if (bfId !== null) {
        let borderElem = findDirectChild(newNode, HH_NS, 'border');
        if (!borderElem) {
          borderElem = newNode.ownerDocument.createElementNS(HH_NS, 'hh:border');
          borderElem.setAttribute('offsetLeft', '0');
          borderElem.setAttribute('offsetRight', '0');
          borderElem.setAttribute('offsetTop', '0');
          borderElem.setAttribute('offsetBottom', '0');
          borderElem.setAttribute('connect', '0');
          borderElem.setAttribute('ignoreMargin', '0');
          newNode.appendChild(borderElem);
        }
        borderElem.setAttribute('borderFillIDRef', String(bfId));
      }
    }

    const paraProps = findDescendant(this.headerRoot, HH_NS, 'paraProperties');
    if (paraProps) paraProps.appendChild(newNode);
    this.paraPrCache.set(cacheKey, newId);
    return newId;
  }

  // 1 HWPUNIT ≈ 1/7200 inch; 3600 ≈ 0.5 inch / ~1.27 cm
  static get LIST_INDENT_HWPUNIT() { return 3600; }

  _getParaPrForListDepth(depth) {
    const leftMargin = (depth + 1) * HtmlToHwpx.LIST_INDENT_HWPUNIT;
    const cacheKey   = `${leftMargin},0`;
    if (this.paraPrCache.has(cacheKey)) return this.paraPrCache.get(cacheKey);
    const newId = this._createParaPrWithMargin(leftMargin);
    this.paraPrCache.set(cacheKey, newId);
    return newId;
  }

  _getLeftMarginFromParaPr(paraPrId) {
    // Fast path via cache
    for (const [key, pid] of this.paraPrCache.entries()) {
      if (pid === String(paraPrId)) {
        const parts = key.split(',');
        if (parts.length === 2) return parseInt(parts[0], 10);
      }
    }
    // Slow path via XML
    if (!this.headerRoot) return 0;
    const node = findDescendantByAttr(this.headerRoot, HH_NS, 'paraPr', 'id', String(paraPrId));
    if (!node) return 0;
    for (const pathStr of [
      'hp:switch/hp:default/hh:margin/hc:left',
      'hp:switch/hp:case/hh:margin/hc:left',
      'hh:margin/hc:left',
    ]) {
      const elem = findByPath(node, pathStr);
      if (elem) {
        const v = parseInt(elem.getAttribute('value') || '0', 10);
        if (!isNaN(v)) return v;
      }
    }
    return 0;
  }

  _createParaPrWithMargin(leftMarginHwpunit) {
    if (!this.headerRoot) return String(this.normalParaPrId);

    let baseNode = findDescendantByAttr(this.headerRoot, HH_NS, 'paraPr', 'id', String(this.normalParaPrId));
    if (!baseNode) baseNode = findDescendantByAttr(this.headerRoot, HH_NS, 'paraPr', 'id', '0');
    if (!baseNode) return String(this.normalParaPrId);

    const newNode = baseNode.cloneNode(true);
    this.maxParaPrId++;
    const newId = String(this.maxParaPrId);
    newNode.setAttribute('id', newId);

    const setMargin = (parentElem) => {
      let margin = findDirectChild(parentElem, HH_NS, 'margin');
      if (!margin) margin = createElement(parentElem, HH_NS, 'hh', 'margin');

      let left = findDirectChild(margin, HC_NS, 'left');
      if (!left) left = createElement(margin, HC_NS, 'hc', 'left');
      left.setAttribute('value', String(leftMarginHwpunit));
      left.setAttribute('unit', 'HWPUNIT');

      let indent = findDirectChild(margin, HC_NS, 'intent');
      if (!indent) indent = createElement(margin, HC_NS, 'hc', 'intent');
      indent.setAttribute('value', '0');
      indent.setAttribute('unit', 'HWPUNIT');
    };

    let switchElem = findDirectChild(newNode, HP_NS, 'switch');
    if (!switchElem) switchElem = createElement(newNode, HP_NS, 'hp', 'switch');

    let defaultElem = findDirectChild(switchElem, HP_NS, 'default');
    if (!defaultElem) defaultElem = createElement(switchElem, HP_NS, 'hp', 'default');
    setMargin(defaultElem);

    let caseElem = findDirectChild(switchElem, HP_NS, 'case');
    if (!caseElem) {
      caseElem = createElement(switchElem, HP_NS, 'hp', 'case');
      caseElem.setAttributeNS(HP_NS, 'hp:required-namespace', 'http://www.hancom.co.kr/hwpml/2016/HwpUnitChar');
    }
    setMargin(caseElem);

    const paraProps = findDescendant(this.headerRoot, HH_NS, 'paraProperties');
    if (paraProps) paraProps.appendChild(newNode);
    return newId;
  }

  // ------------------------------------------------------------------ utils

  _escapeText(text) { return escapeXml(text); }

  _createParaStart(styleId = 0, paraPrId = 1, columnBreak = 0, merged = 0) {
    return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="${styleId}" pageBreak="0" columnBreak="${columnBreak}" merged="${merged}">`;
  }

  _createRunStart(charPrId = 0) {
    return `<hp:run charPrIDRef="${charPrId}">`;
  }

  _createTextRun(text, charPrId = 0) {
    return `${this._createRunStart(charPrId)}<hp:t>${this._escapeText(text)}</hp:t></hp:run>`;
  }

  // ------------------------------------------------------------------ image helpers

  _mimeToExt(mimeType) {
    const map = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
      'image/gif': 'gif', 'image/bmp': 'bmp', 'image/x-bmp': 'bmp',
      'image/x-ms-bmp': 'bmp', 'image/tiff': 'tiff', 'image/tif': 'tiff',
      'image/webp': 'webp',
    };
    return map[(mimeType || '').toLowerCase()] || null;
  }

  _extToMime(ext) {
    const map = {
      'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
      'gif': 'image/gif', 'bmp': 'image/bmp', 'tiff': 'image/tiff',
      'tif': 'image/tiff', 'webp': 'image/webp',
    };
    return map[(ext || '').toLowerCase()] || 'application/octet-stream';
  }

  _isSupportedImageExt(ext) {
    return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'tif', 'webp'].includes((ext || '').toLowerCase());
  }

  _resolveImage(src) {
    if (!src) return null;
    try {
      // Data URI: data:image/png;base64,...
      const duMatch = src.match(/^data:([^;,]+)(?:;[^,]*)?,(.+)$/si);
      if (duMatch) {
        const mimeType = duMatch[1].trim().toLowerCase();
        const payload  = duMatch[2];
        const ext      = this._mimeToExt(mimeType);
        if (!ext) return null;
        const isB64 = /;base64,/i.test(src);
        const data  = isB64
          ? Buffer.from(payload, 'base64')
          : Buffer.from(decodeURIComponent(payload));
        if (!data || data.length === 0) return null;
        return { data, ext };
      }

      // Skip remote URLs
      if (/^https?:\/\//i.test(src)) return null;

      // File path (absolute or relative to basePath)
      let filePath = src;
      if (!path.isAbsolute(filePath) && this._basePath) {
        filePath = path.join(this._basePath, filePath);
      }
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        let ext    = path.extname(filePath).slice(1).toLowerCase();
        if (ext === 'jpeg') ext = 'jpg';
        if (!this._isSupportedImageExt(ext)) return null;
        return { data, ext };
      }
    } catch (e) {
      const preview = src.length > 80 ? src.slice(0, 80) + '...' : src;
      process.stderr.write(`[Warn] Image not resolved (${preview}): ${e.message}\n`);
    }
    return null;
  }

  _parsePxOrPt(val) {
    if (!val) return null;
    const s = String(val).trim();
    if (s.endsWith('%')) return null;
    const m = s.match(/^([\d.]+)(px|pt|em|rem)?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (isNaN(n)) return null;
    return (m[2] || '').toLowerCase() === 'pt' ? n * 96 / 72 : n;
  }

  _getImageDimensions(data, imgAttr) {
    const PX_TO_HWP = 75;     // 1 px @ 96 dpi = 75 HWPUNIT
    const DEF_W     = 30000;  // ~400 px fallback
    const DEF_H     = 22500;  // ~300 px fallback
    const MAX_W     = 44128;  // approx page text-area width in HWPUNIT

    let origWpx = 0, origHpx = 0;
    try {
      const { imageSize } = require('image-size');
      let dims;
      try {
        dims = imageSize(data);
      } catch (bufErr) {
        // Some formats (TIFF) don't support Buffer input — fall back to temp file
        const os     = require('os');
        const crypto = require('crypto');
        const tmp    = path.join(os.tmpdir(), `hwpx_img_${crypto.randomBytes(8).toString('hex')}.tmp`);
        try {
          fs.writeFileSync(tmp, data);
          dims = imageSize(tmp);
        } finally {
          try { fs.unlinkSync(tmp); } catch (_) {}
        }
      }
      origWpx = dims.width  || 0;
      origHpx = dims.height || 0;
    } catch (_) { /* use fallback */ }

    const origW = origWpx > 0 ? Math.trunc(origWpx * PX_TO_HWP) : DEF_W;
    const origH = origHpx > 0 ? Math.trunc(origHpx * PX_TO_HWP) : DEF_H;

    let attrW = null, attrH = null;
    if (imgAttr && imgAttr.length >= 3) {
      for (const [k, v] of (imgAttr[2] || [])) {
        if (k === 'width')  attrW = this._parsePxOrPt(v);
        if (k === 'height') attrH = this._parsePxOrPt(v);
      }
    }

    let curW = origW, curH = origH;
    if (attrW !== null && attrH !== null) {
      curW = Math.trunc(attrW * PX_TO_HWP);
      curH = Math.trunc(attrH * PX_TO_HWP);
    } else if (attrW !== null) {
      curW = Math.trunc(attrW * PX_TO_HWP);
      curH = (origW > 0 && origH > 0) ? Math.trunc(curW * origH / origW) : DEF_H;
    } else if (attrH !== null) {
      curH = Math.trunc(attrH * PX_TO_HWP);
      curW = (origW > 0 && origH > 0) ? Math.trunc(curH * origW / origH) : DEF_W;
    }

    if (curW > MAX_W) {
      curH = Math.trunc(curH * MAX_W / curW);
      curW = MAX_W;
    }

    return {
      origW: Math.max(1, origW),
      origH: Math.max(1, origH),
      curW:  Math.max(1, curW),
      curH:  Math.max(1, curH),
    };
  }

  _handleImageInline(ic) {
    if (!Array.isArray(ic) || ic.length < 3) return '';
    const [imgAttr, , target] = ic;
    const src = Array.isArray(target) ? (target[0] || '') : '';
    if (!src) return '';

    const resolved = this._resolveImage(src);
    if (!resolved) return '';

    const { data, ext }             = resolved;
    const { origW, origH, curW, curH } = this._getImageDimensions(data, imgAttr);

    this._imageCounter++;
    const imgId = `image${this._imageCounter}`;
    this.images.push({ name: imgId, ext, data, mime: this._extToMime(ext) });

    const picId  = String(Date.now() % 100000000 + Math.trunc(Math.random() * 100000));
    const scaleX = (curW / origW).toFixed(6);
    const scaleY = (curH / origH).toFixed(6);
    const cx     = Math.trunc(curW / 2);
    const cy     = Math.trunc(curH / 2);

    return (
      `<hp:run charPrIDRef="0">` +
      `<hp:pic id="${picId}" zOrder="0" numberingType="PICTURE" ` +
      `textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" ` +
      `dropcapstyle="None" href="" groupLevel="0" reverse="0">` +
      `<hp:offset x="0" y="0"/>` +
      `<hp:orgSz width="${origW}" height="${origH}"/>` +
      `<hp:curSz width="${curW}" height="${curH}"/>` +
      `<hp:flip horizontal="0" vertical="0"/>` +
      `<hp:rotationInfo angle="0" centerX="${cx}" centerY="${cy}" rotateimage="1"/>` +
      `<hp:renderingInfo>` +
      `<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
      `<hc:scaMatrix e1="${scaleX}" e2="0" e3="0" e4="0" e5="${scaleY}" e6="0"/>` +
      `<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
      `</hp:renderingInfo>` +
      `<hp:imgRect>` +
      `<hc:pt0 x="0" y="0"/>` +
      `<hc:pt1 x="${origW}" y="0"/>` +
      `<hc:pt2 x="${origW}" y="${origH}"/>` +
      `<hc:pt3 x="0" y="${origH}"/>` +
      `</hp:imgRect>` +
      `<hp:imgClip left="0" right="${origW}" top="0" bottom="${origH}"/>` +
      `<hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
      `<hc:img binaryItemIDRef="${imgId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
      `<hp:effects/>` +
      `<hp:sz width="${curW}" widthRelTo="ABSOLUTE" height="${curH}" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" ` +
      `holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" ` +
      `horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      `<hp:outMargin left="0" right="0" top="0" bottom="0"/>` +
      `<hp:shapeComment>Image</hp:shapeComment>` +
      `</hp:pic>` +
      `<hp:t/>` +
      `</hp:run>`
    );
  }

  // ------------------------------------------------------------------ table

  _handleTable(content, paraPrId = null) {
    const tableHead   = content[3];
    const tableBodies = content[4];
    const tableFoot   = content[5];

    const allRows = [];
    for (const row of tableHead[1])     allRows.push(row);
    for (const body of tableBodies) {
      for (const row of body[2]) allRows.push(row);
      for (const row of body[3]) allRows.push(row);
    }
    for (const row of tableFoot[1]) allRows.push(row);

    if (!allRows.length) return '';

    const cellGrid = new Map();
    let maxRow = 0, maxCol = 0;
    for (let rowIdx = 0; rowIdx < allRows.length; rowIdx++) {
      let currCol = 0;
      for (const cell of allRows[rowIdx][1]) {
        while (cellGrid.has(`${rowIdx},${currCol}`)) currCol++;
        const rowspan = cell[2];
        const colspan = cell[3];
        for (let r = 0; r < rowspan; r++) {
          for (let c = 0; c < colspan; c++) {
            cellGrid.set(`${rowIdx + r},${currCol + c}`, {
              originRow: rowIdx, originCol: currCol,
              rowspan, colspan, blocks: cell[4],
              attr: cell[0],   // preserve cell style/border attributes
            });
          }
        }
        maxRow = Math.max(maxRow, rowIdx + rowspan - 1);
        maxCol = Math.max(maxCol, currCol + colspan - 1);
        currCol += colspan;
      }
    }

    const rowCnt = maxRow + 1;
    const colCnt = maxCol + 1;
    const TOTAL_TABLE_WIDTH = 45000;
    const tblId = String(Date.now() % 100000000 + Math.trunc(Math.random() * 10000));

    const effectiveParaPrId = paraPrId !== null ? paraPrId : this.normalParaPrId;

    const xmlParts = [];
    xmlParts.push(this._createParaStart(this.normalStyleId, effectiveParaPrId));
    xmlParts.push(this._createRunStart(0));

    if (this.tableBorderFillId === null) this._ensureTableBorderFill();

    const paraLeftMargin = this._getLeftMarginFromParaPr(effectiveParaPrId);
    const effectiveWidth = TOTAL_TABLE_WIDTH - paraLeftMargin;

    // Compute per-column widths: use colspec fractions when available, else equal distribution.
    // ColWidth.c is a plain number (0..1 fraction). Guard against legacy data that wrapped it
    // in an array (c: [frac]) — without this guard the reduce below produces a string via JS
    // coercion and totalFrac > 0 is never true, causing silent equal-width fallback.
    const colspec     = content[2] || [];
    const specFracs   = colspec.map(cs => {
      if (cs && cs[1] && cs[1].t === 'ColWidth') {
        const v = cs[1].c;
        return Array.isArray(v) ? v[0] : v;   // unwrap legacy [frac] or accept plain frac
      }
      return null;
    });
    const hasSpecWidths = specFracs.some(f => f !== null && typeof f === 'number' && f > 0);
    let colWidths;
    if (hasSpecWidths) {
      const totalFrac  = specFracs.reduce((s, f) => s + (f !== null ? f : 0), 0);
      const nullCount  = specFracs.filter(f => f === null).length;
      // When some columns have explicit fracs and others are unknown (null),
      // reserve an equal share for each unknown column and scale explicit columns
      // into the remaining space — this prevents the total from exceeding effectiveWidth.
      if (nullCount > 0) {
        const nullShare   = Math.trunc(effectiveWidth / colCnt);
        const specBudget  = effectiveWidth - nullCount * nullShare;
        const scale       = totalFrac > 0 && specBudget > 0 ? specBudget / totalFrac : effectiveWidth / colCnt;
        colWidths = Array.from({ length: colCnt }, (_, i) => {
          const frac = (i < specFracs.length && specFracs[i] !== null) ? specFracs[i] : 0;
          return Math.trunc(frac > 0 ? frac * scale : nullShare);
        });
      } else {
        const scale = totalFrac > 0 ? effectiveWidth / totalFrac : effectiveWidth / colCnt;
        colWidths = Array.from({ length: colCnt }, (_, i) => {
          const frac = (i < specFracs.length && specFracs[i] !== null) ? specFracs[i] : 0;
          return Math.trunc(frac > 0 ? frac * scale : effectiveWidth / colCnt);
        });
      }
    } else {
      colWidths = Array.from({ length: colCnt }, () => Math.trunc(effectiveWidth / colCnt));
    }

    // Compute per-row minimum heights from HTML height attributes/styles.
    // HWPX uses 1/7200-inch units; 1px → 75 HUnits, 1pt → 100, 1cm → 2835.
    const DEFAULT_ROW_HEIGHT = 1000;
    const rowHeights = Array.from({ length: rowCnt }, (_, rowIdx) => {
      const row = allRows[rowIdx];
      if (!row) return DEFAULT_ROW_HEIGHT;  // phantom row created by a rowspan

      // Prefer the <tr> height over individual cell heights
      const rowH = this._extractHeightHwpx(row[0]);
      if (rowH !== null) return rowH;

      // Fall back to the maximum height declared on any cell in this row
      let maxCellH = null;
      for (const cell of (row[1] || [])) {
        const cellH = this._extractHeightHwpx(cell[0]);
        if (cellH !== null) maxCellH = maxCellH === null ? cellH : Math.max(maxCellH, cellH);
      }
      return maxCellH !== null ? maxCellH : DEFAULT_ROW_HEIGHT;
    });

    xmlParts.push(
      `<hp:tbl id="${tblId}" zOrder="0" numberingType="TABLE" ` +
      `textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" ` +
      `dropcapstyle="None" pageBreak="CELL" repeatHeader="1" ` +
      `rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" ` +
      `borderFillIDRef="${this.tableBorderFillId}" noAdjust="0">`
    );
    const totalTableHeight = rowHeights.reduce((a, b) => a + b, 0);
    xmlParts.push(
      `<hp:sz width="${effectiveWidth}" widthRelTo="ABSOLUTE" ` +
      `height="${totalTableHeight}" heightRelTo="ABSOLUTE" protect="0"/>`
    );
    xmlParts.push(
      '<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" ' +
      'allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" ' +
      'horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" ' +
      'vertOffset="0" horzOffset="0"/>'
    );
    xmlParts.push('<hp:outMargin left="0" right="0" top="0" bottom="1417"/>');
    xmlParts.push('<hp:inMargin left="510" right="510" top="141" bottom="141"/>');

    const processedCells = new Set();
    for (let rowIdx = 0; rowIdx < rowCnt; rowIdx++) {
      xmlParts.push('<hp:tr>');
      for (let colIdx = 0; colIdx < colCnt; colIdx++) {
        const key = `${rowIdx},${colIdx}`;
        const ci  = cellGrid.get(key);

        // Phantom cell only for genuinely missing positions (no entry in the grid).
        // HWPX requires every grid position to have an <hp:tc> so borders render correctly,
        // but span-covered positions must NOT get a phantom — the spanning cell's rowSpan/colSpan
        // already claims that space, and a duplicate <hp:tc> there breaks the layout.
        if (!ci) {
          const phantomId = String(Date.now() % 1000000000 + Math.trunc(Math.random() * 100000));
          xmlParts.push(
            `<hp:tc name="" header="0" hasMargin="0" protect="0" ` +
            `editable="0" dirty="0" borderFillIDRef="${this.tableBorderFillId}">`
          );
          xmlParts.push(
            `<hp:subList id="${phantomId}" textDirection="HORIZONTAL" ` +
            `lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" ` +
            `linkListNextIDRef="0" textWidth="0" textHeight="0" ` +
            `hasTextRef="0" hasNumRef="0">`
          );
          xmlParts.push(
            this._createParaStart(this.normalStyleId, this.normalParaPrId) +
            '<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>'
          );
          xmlParts.push('</hp:subList>');
          xmlParts.push(`<hp:cellAddr colAddr="${colIdx}" rowAddr="${rowIdx}"/>`);
          xmlParts.push(`<hp:cellSpan colSpan="1" rowSpan="1"/>`);
          xmlParts.push(`<hp:cellSz width="${colWidths[colIdx]}" height="${rowHeights[rowIdx]}"/>`);
          xmlParts.push('<hp:cellMargin left="510" right="510" top="141" bottom="141"/>');
          xmlParts.push('</hp:tc>');
          continue;
        }

        // Span-covered position — the real origin cell handles this via rowSpan/colSpan.
        if (ci.originRow !== rowIdx || ci.originCol !== colIdx) continue;

        if (processedCells.has(key)) continue;
        processedCells.add(key);

        const { rowspan, colspan, blocks, attr } = ci;
        const cellWidth  = colWidths.slice(colIdx, colIdx + colspan).reduce((a, b) => a + b, 0);
        const cellHeight = rowHeights.slice(rowIdx, rowIdx + rowspan).reduce((a, b) => a + b, 0);
        const sublistId = String(Date.now() % 1000000000 + Math.trunc(Math.random() * 100000));

        // Resolve a borderFill that matches this cell's CSS border styles and background color
        const cellBorders  = this._parseCellBorderStyle(attr);
        const cellBfId     = this._getOrCreateCellBorderFill(cellBorders, cellBorders.bgColor);

        let cellXml = this._processBlocksForTableCell(blocks);
        if (!cellXml.trim()) {
          cellXml = (
            this._createParaStart(this.normalStyleId, this.normalParaPrId) +
            '<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>'
          );
        }

        xmlParts.push(
          `<hp:tc name="" header="0" hasMargin="0" protect="0" ` +
          `editable="0" dirty="0" borderFillIDRef="${cellBfId}">`
        );
        xmlParts.push(
          `<hp:subList id="${sublistId}" textDirection="HORIZONTAL" ` +
          `lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" ` +
          `linkListNextIDRef="0" textWidth="0" textHeight="0" ` +
          `hasTextRef="0" hasNumRef="0">`
        );
        xmlParts.push(cellXml);
        xmlParts.push('</hp:subList>');
        xmlParts.push(`<hp:cellAddr colAddr="${colIdx}" rowAddr="${rowIdx}"/>`);
        xmlParts.push(`<hp:cellSpan colSpan="${colspan}" rowSpan="${rowspan}"/>`);
        xmlParts.push(`<hp:cellSz width="${cellWidth}" height="${cellHeight}"/>`);
        xmlParts.push('<hp:cellMargin left="510" right="510" top="141" bottom="141"/>');
        xmlParts.push('</hp:tc>');
      }
      xmlParts.push('</hp:tr>');
    }

    xmlParts.push('</hp:tbl>');
    xmlParts.push('</hp:run>');
    xmlParts.push('</hp:p>');
    return xmlParts.join('');
  }

  _ensureTableBorderFill() {
    if (this.tableBorderFillId !== null) return this.tableBorderFillId;
    this.maxBorderFillId++;
    this.tableBorderFillId = this.maxBorderFillId;
    if (!this.headerRoot) return this.tableBorderFillId;

    const bfXml = (
      `<hh:borderFill xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" ` +
      `xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" ` +
      `id="${this.tableBorderFillId}" threeD="0" shadow="0" slash="NONE" ` +
      `backSlash="NONE" crookedSlash="0" counterstrike="0">` +
      `<hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/>` +
      `<hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/>` +
      `<hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/>` +
      `<hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/>` +
      `<hh:diagonal type="NONE" crooked="0"/>` +
      `<hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#000000" alpha="0"/>` +
      `</hc:fillBrush></hh:borderFill>`
    );
    const bfDoc  = new DOMParser().parseFromString(bfXml, 'text/xml');
    const bfElem = this.headerDoc.importNode(bfDoc.documentElement, true);
    let bfc = findDescendant(this.headerRoot, HH_NS, 'borderFills');
    if (!bfc) bfc = createElement(this.headerRoot, HH_NS, 'hh', 'borderFills');
    bfc.appendChild(bfElem);
    return this.tableBorderFillId;
  }

  // ------------------------------------------------------------------ cell border helpers

  /**
   * Parse a single CSS border shorthand value such as:
   *   "none"  |  "1px solid #003366"  |  "0.5pt solid red"
   * Returns { type, width, color } in HWPX terms.
   */
  _parseBorderValue(val) {
    if (!val) return null;
    const s = val.trim().toLowerCase();
    if (s === 'none' || s === '0' || s === '0px') {
      return { type: 'NONE', width: '0.12 mm', color: '#000000' };
    }
    let bType  = 'SOLID';
    let bWidth = '0.12 mm';
    let bColor = '#000000';
    for (const part of s.split(/\s+/)) {
      if (part === 'none')   return { type: 'NONE', width: '0.12 mm', color: '#000000' };
      if (part === 'solid')  { bType = 'SOLID';  continue; }
      if (part === 'dashed') { bType = 'DASHED'; continue; }
      if (part === 'dotted') { bType = 'DOT';    continue; }
      if (part === 'double') { bType = 'DOUBLE'; continue; }
      if (part.startsWith('#')) { bColor = this._convertColorToHwp(part); continue; }
      // width value
      const wm = part.match(/^([\d.]+)(px|pt|mm|cm)?$/);
      if (wm) {
        const v = parseFloat(wm[1]);
        const u = wm[2] || 'px';
        let mm;
        if      (u === 'px') mm = v * 0.264583;
        else if (u === 'pt') mm = v * 0.352778;
        else if (u === 'mm') mm = v;
        else if (u === 'cm') mm = v * 10;
        if (mm != null) bWidth = mm.toFixed(2) + ' mm';
      }
    }
    return { type: bType, width: bWidth, color: bColor };
  }

  /**
   * Extract per-side border styles from a Pandoc cell attr
   * (format: [id, classes, [[key, val], ...]]).
   * Returns { left, right, top, bottom } — each side is either a
   * { type, width, color } object or null (meaning "use table default").
   */
  /**
   * Extract a height (in HWPX units, 1/7200 inch) from a nodeAttr object.
   * Checks style="height:X" and the legacy height="" attribute.
   * Returns null if no usable height is found.
   */
  _extractHeightHwpx(attr) {
    if (!attr || !attr[2]) return null;
    const kvPairs = attr[2];
    let rawValue = null, rawUnit = 'px';

    for (const [k, v] of kvPairs) {
      if (k === 'style') {
        const m = v.match(/(?:^|;)\s*height\s*:\s*([\d.]+)\s*(px|pt|%|cm|mm|in)?/i);
        if (m) { rawValue = parseFloat(m[1]); rawUnit = (m[2] || 'px').toLowerCase(); break; }
      } else if (k === 'height') {
        const m = v.match(/^([\d.]+)\s*(px|pt|%|cm|mm|in)?/i);
        if (m) { rawValue = parseFloat(m[1]); rawUnit = (m[2] || 'px').toLowerCase(); }
      }
    }

    if (rawValue === null || isNaN(rawValue) || rawValue <= 0 || rawUnit === '%') return null;
    if (rawUnit === 'pt') return Math.trunc(rawValue * 100);
    if (rawUnit === 'cm') return Math.trunc(rawValue * 2835);
    if (rawUnit === 'mm') return Math.trunc(rawValue * 283.5);
    if (rawUnit === 'in') return Math.trunc(rawValue * 7200);
    return Math.trunc(rawValue * 75);  // px (at 96 dpi → 1px = 7200/96 HUnits)
  }

  _parseCellBorderStyle(attr) {
    const result = { left: null, right: null, top: null, bottom: null, bgColor: null };
    if (!attr || attr.length < 3) return result;
    const kvPairs = attr[2] || [];
    const styleEntry = kvPairs.find(([k]) => k === 'style');
    if (!styleEntry) return result;
    const styleStr = styleEntry[1] || '';
    for (const part of styleStr.split(';')) {
      if (!part.includes(':')) continue;
      const idx = part.indexOf(':');
      const key = part.slice(0, idx).trim().toLowerCase();
      const val = part.slice(idx + 1).trim();
      if      (key === 'border-left')       result.left    = this._parseBorderValue(val);
      else if (key === 'border-right')      result.right   = this._parseBorderValue(val);
      else if (key === 'border-top')        result.top     = this._parseBorderValue(val);
      else if (key === 'border-bottom')     result.bottom  = this._parseBorderValue(val);
      else if (key === 'border') {
        const b = this._parseBorderValue(val);
        result.left = result.right = result.top = result.bottom = b;
      }
      else if (key === 'background-color' || key === 'background') {
        const v = val.toLowerCase().trim();
        if (v !== 'transparent' && v !== 'none' && v !== 'inherit' && v !== 'initial' && v !== 'unset') {
          const c = this._convertColorToHwp(val);
          if (c) result.bgColor = c;
        }
      }
    }
    return result;
  }

  /**
   * Return the borderFill ID for a given cell border spec, creating a new
   * <hh:borderFill> entry in header.xml if this combination hasn't been seen
   * before.  Falls back to the shared table borderFill when all sides are
   * the default solid black 0.12mm.
   */
  _getOrCreateCellBorderFill(borders, bgColor = null) {
    if (this.tableBorderFillId === null) this._ensureTableBorderFill();

    const DEFAULT = { type: 'SOLID', width: '0.12 mm', color: '#000000' };
    const left   = borders.left   || DEFAULT;
    const right  = borders.right  || DEFAULT;
    const top    = borders.top    || DEFAULT;
    const bottom = borders.bottom || DEFAULT;

    const isDefault = (b) =>
      b.type === DEFAULT.type && b.width === DEFAULT.width && b.color === DEFAULT.color;

    // Reuse the shared table borderFill only when all borders are default AND no background color
    if (!bgColor && isDefault(left) && isDefault(right) && isDefault(top) && isDefault(bottom)) {
      return this.tableBorderFillId;
    }

    const cacheKey =
      `${left.type}:${left.width}:${left.color}|` +
      `${right.type}:${right.width}:${right.color}|` +
      `${top.type}:${top.width}:${top.color}|` +
      `${bottom.type}:${bottom.width}:${bottom.color}|bg:${bgColor || 'none'}`;

    if (this._cellBorderFillCache.has(cacheKey)) {
      return this._cellBorderFillCache.get(cacheKey);
    }

    this.maxBorderFillId++;
    const newId = this.maxBorderFillId;

    if (this.headerRoot) {
      const fillXml = bgColor
        ? `<hc:fillBrush><hc:winBrush faceColor="${bgColor}" hatchColor="${bgColor}" alpha="0"/></hc:fillBrush>`
        : `<hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#000000" alpha="0"/></hc:fillBrush>`;
      const bfXml =
        `<hh:borderFill xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" ` +
        `xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" ` +
        `id="${newId}" threeD="0" shadow="0" slash="NONE" ` +
        `backSlash="NONE" crookedSlash="0" counterstrike="0">` +
        `<hh:leftBorder   type="${left.type}"   width="${left.width}"   color="${left.color}"/>` +
        `<hh:rightBorder  type="${right.type}"  width="${right.width}"  color="${right.color}"/>` +
        `<hh:topBorder    type="${top.type}"    width="${top.width}"    color="${top.color}"/>` +
        `<hh:bottomBorder type="${bottom.type}" width="${bottom.width}" color="${bottom.color}"/>` +
        `<hh:diagonal type="NONE" crooked="0"/>` +
        fillXml + `</hh:borderFill>`;
      const bfDoc  = new DOMParser().parseFromString(bfXml, 'text/xml');
      const bfElem = this.headerDoc.importNode(bfDoc.documentElement, true);
      let bfc = findDescendant(this.headerRoot, HH_NS, 'borderFills');
      if (!bfc) bfc = createElement(this.headerRoot, HH_NS, 'hh', 'borderFills');
      bfc.appendChild(bfElem);
    }

    this._cellBorderFillCache.set(cacheKey, newId);
    return newId;
  }

  _getOrCreateParaBorderFill(bgColor) {
    if (!bgColor) return null;
    if (this._paraBorderFillCache.has(bgColor)) return this._paraBorderFillCache.get(bgColor);
    this.maxBorderFillId++;
    const bfId  = this.maxBorderFillId;
    if (this.headerRoot) {
      const bfXml =
        `<hh:borderFill xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" ` +
        `xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" ` +
        `id="${bfId}" threeD="0" shadow="0" slash="NONE" backSlash="NONE" ` +
        `crookedSlash="0" counterstrike="0">` +
        `<hh:leftBorder type="NONE" width="0.12 mm" color="#000000"/>` +
        `<hh:rightBorder type="NONE" width="0.12 mm" color="#000000"/>` +
        `<hh:topBorder type="NONE" width="0.12 mm" color="#000000"/>` +
        `<hh:bottomBorder type="NONE" width="0.12 mm" color="#000000"/>` +
        `<hh:diagonal type="NONE" crooked="0"/>` +
        `<hc:fillBrush><hc:winBrush faceColor="${bgColor}" hatchColor="${bgColor}" alpha="0"/></hc:fillBrush>` +
        `</hh:borderFill>`;
      const bfDoc  = new DOMParser().parseFromString(bfXml, 'text/xml');
      const bfElem = this.headerDoc.importNode(bfDoc.documentElement, true);
      let bfc = findDescendant(this.headerRoot, HH_NS, 'borderFills');
      if (!bfc) bfc = createElement(this.headerRoot, HH_NS, 'hh', 'borderFills');
      bfc.appendChild(bfElem);
    }
    this._paraBorderFillCache.set(bgColor, bfId);
    return bfId;
  }

  // ------------------------------------------------------------------ hwpx-shape helpers

  _toPt(val) {
    if (!val) return null;
    const m = String(val).trim().match(/^([\d.]+)\s*(pt|px|cm|mm|in)?$/i);
    if (!m) return null;
    const v = parseFloat(m[1]);
    if (isNaN(v)) return null;
    const u = (m[2] || 'px').toLowerCase();
    if (u === 'pt') return v;
    if (u === 'px') return v * 72 / 96;
    if (u === 'cm') return v * 28.3465;
    if (u === 'mm') return v * 2.83465;
    if (u === 'in') return v * 72;
    return v;
  }

  _parseShapeStyle(styleStr) {
    const result = {
      widthPt: null, minHeightPt: null,
      leftPt: null, topPt: null,
      borderLeft: null, borderRight: null, borderTop: null, borderBottom: null,
      bgColor: null,
      padTopPt: 0, padRightPt: 0, padBottomPt: 0, padLeftPt: 0,
    };
    if (!styleStr) return result;

    for (const part of styleStr.split(';')) {
      const colonIdx = part.indexOf(':');
      if (colonIdx < 0) continue;
      const key = part.slice(0, colonIdx).trim().toLowerCase();
      const val = part.slice(colonIdx + 1).trim();

      if (key === 'left') {
        const v = this._toPt(val);
        if (v !== null) result.leftPt = v;
      } else if (key === 'top') {
        const v = this._toPt(val);
        if (v !== null) result.topPt = v;
      } else if (key === 'width') {
        const v = this._toPt(val);
        if (v !== null) result.widthPt = v;
      } else if (key === 'min-height' || key === 'height') {
        const v = this._toPt(val);
        if (v !== null && (result.minHeightPt === null || v > result.minHeightPt))
          result.minHeightPt = v;
      } else if (key === 'border') {
        const b = this._parseBorderValue(val);
        result.borderLeft = result.borderRight = result.borderTop = result.borderBottom = b;
      } else if (key === 'border-left') {
        result.borderLeft = this._parseBorderValue(val);
      } else if (key === 'border-right') {
        result.borderRight = this._parseBorderValue(val);
      } else if (key === 'border-top') {
        result.borderTop = this._parseBorderValue(val);
      } else if (key === 'border-bottom') {
        result.borderBottom = this._parseBorderValue(val);
      } else if (key === 'background-color' || key === 'background') {
        const v = val.toLowerCase().trim();
        if (v !== 'transparent' && v !== 'none' && v !== 'inherit' && v !== 'initial' && v !== 'unset') {
          result.bgColor = this._convertColorToHwp(val);
        }
      } else if (key === 'padding') {
        const tokens = val.split(/\s+/);
        const values = tokens.map(t => { const p = this._toPt(t); return p !== null ? p : 0; });
        if (values.length === 1) {
          result.padTopPt = result.padRightPt = result.padBottomPt = result.padLeftPt = values[0];
        } else if (values.length === 2) {
          result.padTopPt = result.padBottomPt = values[0];
          result.padRightPt = result.padLeftPt = values[1];
        } else if (values.length >= 4) {
          result.padTopPt = values[0]; result.padRightPt = values[1];
          result.padBottomPt = values[2]; result.padLeftPt = values[3];
        }
      } else if (key === 'padding-top')    { const v = this._toPt(val); if (v !== null) result.padTopPt    = v; }
      else if   (key === 'padding-right')  { const v = this._toPt(val); if (v !== null) result.padRightPt  = v; }
      else if   (key === 'padding-bottom') { const v = this._toPt(val); if (v !== null) result.padBottomPt = v; }
      else if   (key === 'padding-left')   { const v = this._toPt(val); if (v !== null) result.padLeftPt   = v; }
    }
    return result;
  }

  /** Read the inline `style` string out of a Pandoc Attr tuple's k/v pairs. */
  _getStyleStr(divContent) {
    const attr = Array.isArray(divContent) ? divContent[0] : null;
    const kvPairs = (attr && attr[2]) ? attr[2] : [];
    const styleEntry = kvPairs.find(([k]) => k === 'style');
    return styleEntry ? styleEntry[1] : '';
  }

  /**
   * Parse a hwpx-container div's style → { widthPt, heightPt }.
   * The container is emitted by neoali as
   *   position:relative;width:100%;max-width:<W>pt;height:<H>pt;...
   * so the real pixel/point size lives on max-width (width is just 100%).
   */
  _parseContainerStyle(styleStr) {
    const result = { widthPt: null, heightPt: null };
    if (!styleStr) return result;
    for (const part of styleStr.split(';')) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      const key = part.slice(0, idx).trim().toLowerCase();
      const val = part.slice(idx + 1).trim();
      if (key === 'max-width') { const v = this._toPt(val); if (v !== null) result.widthPt = v; }
      else if (key === 'width' && result.widthPt === null) { const v = this._toPt(val); if (v !== null) result.widthPt = v; }
      else if (key === 'height') { const v = this._toPt(val); if (v !== null) result.heightPt = v; }
    }
    return result;
  }

  /**
   * Build the <hp:tbl>…</hp:tbl> that renders a single hwpx-shape text box.
   * opts.floating positions the box absolutely (treatAsChar=0, flowWithText=0,
   * allowOverlap=1) at opts.leftHwp/opts.topHwp — used when the shape sits inside
   * a hwpx-container and must overlay the background at its original coordinates.
   * Without opts.floating it keeps the legacy inline behaviour (offset 0,0).
   */
  _buildShapeTable(divContent, opts = {}) {
    const { floating = false, leftHwp = 0, topHwp = 0, zOrder = 0 } = opts;
    const innerBlocks = Array.isArray(divContent) && divContent.length > 1 ? divContent[1] : [];
    const shape = this._parseShapeStyle(this._getStyleStr(divContent));

    const HWPUNIT_PER_PT = 100;
    const TOTAL_WIDTH = 45000;
    // Borders that are not specified in CSS default to NONE (invisible), not SOLID
    const NONE_BORDER = { type: 'NONE', width: '0.12 mm', color: '#000000' };

    const widthHwp = shape.widthPt !== null
      ? Math.min(Math.trunc(shape.widthPt * HWPUNIT_PER_PT), TOTAL_WIDTH)
      : TOTAL_WIDTH;
    const heightHwp = shape.minHeightPt !== null
      ? Math.max(Math.trunc(shape.minHeightPt * HWPUNIT_PER_PT), 1000)
      : 1000;

    const padLeft   = Math.trunc((shape.padLeftPt   || 0) * HWPUNIT_PER_PT);
    const padRight  = Math.trunc((shape.padRightPt  || 0) * HWPUNIT_PER_PT);
    const padTop    = Math.trunc((shape.padTopPt    || 0) * HWPUNIT_PER_PT);
    const padBottom = Math.trunc((shape.padBottomPt || 0) * HWPUNIT_PER_PT);

    if (this.tableBorderFillId === null) this._ensureTableBorderFill();

    const borders = {
      left:   shape.borderLeft   || NONE_BORDER,
      right:  shape.borderRight  || NONE_BORDER,
      top:    shape.borderTop    || NONE_BORDER,
      bottom: shape.borderBottom || NONE_BORDER,
    };
    const bfId = this._getOrCreateCellBorderFill(borders, shape.bgColor);

    const tblId     = String(Date.now() % 100000000 + Math.trunc(Math.random() * 10000));
    const sublistId = String(Date.now() % 1000000000 + Math.trunc(Math.random() * 100000));

    let cellXml = this._processBlocksForTableCell(innerBlocks);
    if (!cellXml.trim()) {
      cellXml = (
        this._createParaStart(this.normalStyleId, this.normalParaPrId) +
        '<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>'
      );
    }

    const pos = floating
      ? `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="0" ` +
        `allowOverlap="1" holdAnchorAndSO="0" vertRelTo="PARA" ` +
        `horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" ` +
        `vertOffset="${topHwp}" horzOffset="${leftHwp}"/>`
      : `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" ` +
        `allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" ` +
        `horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" ` +
        `vertOffset="0" horzOffset="0"/>`;
    const outMarginBottom = floating ? '0' : '1417';

    const xmlParts = [];
    xmlParts.push(
      `<hp:tbl id="${tblId}" zOrder="${zOrder}" numberingType="TABLE" ` +
      `textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" ` +
      `dropcapstyle="None" pageBreak="CELL" repeatHeader="1" ` +
      `rowCnt="1" colCnt="1" cellSpacing="0" ` +
      `borderFillIDRef="${bfId}" noAdjust="0">`
    );
    xmlParts.push(
      `<hp:sz width="${widthHwp}" widthRelTo="ABSOLUTE" ` +
      `height="${heightHwp}" heightRelTo="ABSOLUTE" protect="0"/>`
    );
    xmlParts.push(pos);
    xmlParts.push(`<hp:outMargin left="0" right="0" top="0" bottom="${outMarginBottom}"/>`);
    xmlParts.push(`<hp:inMargin left="${padLeft}" right="${padRight}" top="${padTop}" bottom="${padBottom}"/>`);
    xmlParts.push('<hp:tr>');
    xmlParts.push(
      `<hp:tc name="" header="0" hasMargin="0" protect="0" ` +
      `editable="0" dirty="0" borderFillIDRef="${bfId}">`
    );
    xmlParts.push(
      `<hp:subList id="${sublistId}" textDirection="HORIZONTAL" ` +
      `lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" ` +
      `linkListNextIDRef="0" textWidth="0" textHeight="0" ` +
      `hasTextRef="0" hasNumRef="0">`
    );
    xmlParts.push(cellXml);
    xmlParts.push('</hp:subList>');
    xmlParts.push('<hp:cellAddr colAddr="0" rowAddr="0"/>');
    xmlParts.push('<hp:cellSpan colSpan="1" rowSpan="1"/>');
    xmlParts.push(`<hp:cellSz width="${widthHwp}" height="${heightHwp}"/>`);
    xmlParts.push(`<hp:cellMargin left="${padLeft}" right="${padRight}" top="${padTop}" bottom="${padBottom}"/>`);
    xmlParts.push('</hp:tc>');
    xmlParts.push('</hp:tr>');
    xmlParts.push('</hp:tbl>');

    return xmlParts.join('');
  }

  _handleShape(divContent, paraPrId = null) {
    const effectiveParaPrId = paraPrId !== null ? paraPrId : this.normalParaPrId;
    return (
      this._createParaStart(this.normalStyleId, effectiveParaPrId) +
      this._createRunStart(0) +
      this._buildShapeTable(divContent, { floating: false, zOrder: 0 }) +
      '</hp:run></hp:p>'
    );
  }

  // ------------------------------------------------------------------ hwpx-container

  /** Find the background image src inside a Para/Plain's inline list (if any). */
  _extractContainerBgImageSrc(inlines) {
    if (!Array.isArray(inlines)) return null;
    for (const it of inlines) {
      if (it && it.t === 'Image' && Array.isArray(it.c) && it.c.length >= 3) {
        const target = it.c[2];
        const src = Array.isArray(target) ? (target[0] || '') : '';
        if (src) return src;
      }
    }
    return null;
  }

  /** Monotonic instance id for drawing objects (container/pic/rect). */
  _nextInstId() {
    if (this._instIdSeq === undefined) this._instIdSeq = 538900000 + Math.trunc(Math.random() * 1000000);
    return ++this._instIdSeq;
  }

  /**
   * Build a background <hp:pic> as a CONTAINER GROUP CHILD (groupLevel="1").
   * Unlike a top-level inline picture it carries no hp:sz/hp:pos — its position
   * and size come from the group transform: offset (0,0) + a scale matrix that
   * maps the intrinsic image (orgSz) onto the full container (curSz = CW × CH).
   * Registers the image binary; returns '' if the src cannot be resolved.
   */
  _buildContainerPicChild(src, containerW, containerH, zOrder = 0) {
    const resolved = this._resolveImage(src);
    if (!resolved) return '';
    const { data, ext } = resolved;

    let origW = containerW, origH = containerH;
    try {
      const { imageSize } = require('image-size');
      let dims;
      try {
        dims = imageSize(data);
      } catch (bufErr) {
        const os     = require('os');
        const crypto = require('crypto');
        const tmp    = path.join(os.tmpdir(), `hwpx_img_${crypto.randomBytes(8).toString('hex')}.tmp`);
        try { fs.writeFileSync(tmp, data); dims = imageSize(tmp); }
        finally { try { fs.unlinkSync(tmp); } catch (_) {} }
      }
      const PX_TO_HWP = 75;
      if (dims && dims.width)  origW = Math.max(1, Math.trunc(dims.width  * PX_TO_HWP));
      if (dims && dims.height) origH = Math.max(1, Math.trunc(dims.height * PX_TO_HWP));
    } catch (_) { /* keep container size */ }

    this._imageCounter++;
    const imgId = `image${this._imageCounter}`;
    this.images.push({ name: imgId, ext, data, mime: this._extToMime(ext) });

    const picId  = String(Date.now() % 100000000 + Math.trunc(Math.random() * 100000));
    const scaleX = (containerW / origW).toFixed(6);
    const scaleY = (containerH / origH).toFixed(6);
    const cx     = Math.trunc(containerW / 2);
    const cy     = Math.trunc(containerH / 2);

    return (
      `<hp:pic id="${picId}" zOrder="${zOrder}" numberingType="NONE" ` +
      `textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" ` +
      `dropcapstyle="None" href="" groupLevel="1" instid="${this._nextInstId()}" reverse="0">` +
      `<hp:offset x="0" y="0"/>` +
      `<hp:orgSz width="${origW}" height="${origH}"/>` +
      `<hp:curSz width="${containerW}" height="${containerH}"/>` +
      `<hp:flip horizontal="0" vertical="0"/>` +
      `<hp:rotationInfo angle="0" centerX="${cx}" centerY="${cy}" rotateimage="0"/>` +
      `<hp:renderingInfo>` +
      `<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
      `<hc:scaMatrix e1="${scaleX}" e2="0" e3="0" e4="0" e5="${scaleY}" e6="0"/>` +
      `<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
      `</hp:renderingInfo>` +
      `<hp:imgRect>` +
      `<hc:pt0 x="0" y="0"/>` +
      `<hc:pt1 x="${origW}" y="0"/>` +
      `<hc:pt2 x="${origW}" y="${origH}"/>` +
      `<hc:pt3 x="0" y="${origH}"/>` +
      `</hp:imgRect>` +
      `<hp:imgClip left="0" right="${origW}" top="0" bottom="${origH}"/>` +
      `<hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
      `<hc:img binaryItemIDRef="${imgId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
      `<hp:effects/>` +
      `</hp:pic>`
    );
  }

  /**
   * Render a hwpx-container — a positioned group that neoali emits as
   *   <div class="hwpx-container">              (position:relative, page-sized)
   *     <img class="hwpx-container-bg">          (fills the container)
   *     <div class="hwpx-shape" left/top/…>      (text boxes overlaid on it)
   *
   * Reproduced with the SAME structure the source HWPX uses: a single
   * treatAsChar <hp:container> group (so it reserves a full page) holding the
   * background <hp:pic> plus one <hp:rect>+<hp:drawText> per shape. Each child's
   * position comes from its group transform (transMatrix translation = left/top
   * in HWPUNIT, identity scale) — so the text lives INSIDE the shape at its
   * original coordinates instead of flowing as a separate inline object.
   */
  _handleContainer(divContent, paraPrId = null, pageBreak = 0) {
    const innerBlocks = Array.isArray(divContent) && divContent.length > 1 ? divContent[1] : [];
    const cont = this._parseContainerStyle(this._getStyleStr(divContent));

    const HWPUNIT_PER_PT = 100;
    const DEFAULT_W = 45000;
    // A container is a page-region group, not an inline table — use its real
    // size (from max-width / height) so children keep the source geometry.
    const containerW = cont.widthPt !== null
      ? Math.trunc(cont.widthPt * HWPUNIT_PER_PT)
      : DEFAULT_W;
    const containerH = cont.heightPt !== null
      ? Math.max(Math.trunc(cont.heightPt * HWPUNIT_PER_PT), 1000)
      : 1000;

    // Split children into background image(s), shape boxes and anything else.
    let bgSrc = null;
    const shapeDivs   = [];
    const otherBlocks = [];
    for (const block of innerBlocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.t === 'Div') {
        const classes = block.c && block.c[0] && block.c[0][1] ? block.c[0][1] : [];
        if (classes.includes('hwpx-shape'))     { shapeDivs.push(block.c); continue; }
        otherBlocks.push(block);
        continue;
      }
      if (block.t === 'Para' || block.t === 'Plain') {
        const src = this._extractContainerBgImageSrc(block.c);
        if (src) { if (!bgSrc) bgSrc = src; continue; }
      }
      otherBlocks.push(block);
    }

    // Build the group children: background picture first, then each text box.
    const children = [];
    let z = 0;
    if (bgSrc) {
      const pic = this._buildContainerPicChild(bgSrc, containerW, containerH, z++);
      if (pic) children.push(pic);
    }
    for (const sc of shapeDivs) {
      const shape = this._parseShapeStyle(this._getStyleStr(sc));
      const leftHwp = shape.leftPt !== null ? Math.trunc(shape.leftPt * HWPUNIT_PER_PT) : 0;
      const topHwp  = shape.topPt  !== null ? Math.trunc(shape.topPt  * HWPUNIT_PER_PT) : 0;
      children.push(this._buildRectChild(sc, leftHwp, topHwp, z++));
    }

    const effectiveParaPrId = paraPrId !== null ? paraPrId : this.normalParaPrId;
    let trailing = '';
    if (otherBlocks.length) trailing = this._processBlocks(otherBlocks);

    // No drawable children — fall back to inline processing rather than emit an
    // empty container.
    if (!children.length) {
      const inline = this._processBlocks(innerBlocks);
      return inline;
    }

    const cx = Math.trunc(containerW / 2);
    const cy = Math.trunc(containerH / 2);
    const containerId = String(Date.now() % 100000000 + Math.trunc(Math.random() * 100000));

    const containerXml =
      `<hp:container id="${containerId}" zOrder="0" numberingType="PICTURE" ` +
      `textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" ` +
      `href="" groupLevel="0" instid="${this._nextInstId()}">` +
      `<hp:offset x="0" y="0"/>` +
      `<hp:orgSz width="${containerW}" height="${containerH}"/>` +
      `<hp:curSz width="${containerW}" height="${containerH}"/>` +
      `<hp:flip horizontal="0" vertical="0"/>` +
      `<hp:rotationInfo angle="0" centerX="${cx}" centerY="${cy}" rotateimage="0"/>` +
      `<hp:renderingInfo>` +
      `<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
      `<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
      `<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
      `</hp:renderingInfo>` +
      children.join('') +
      `<hp:sz width="${containerW}" widthRelTo="ABSOLUTE" height="${containerH}" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="1" ` +
      `holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" ` +
      `vertOffset="0" horzOffset="0"/>` +
      `<hp:outMargin left="0" right="0" top="0" bottom="0"/>` +
      `</hp:container>`;

    const pb = pageBreak ? 1 : 0;
    const para =
      `<hp:p paraPrIDRef="${effectiveParaPrId}" styleIDRef="${this.normalStyleId}" ` +
      `pageBreak="${pb}" columnBreak="0" merged="0">` +
      `<hp:run charPrIDRef="0">${containerXml}</hp:run>` +
      `<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>` +
      `</hp:p>`;

    return trailing ? para + '\n' + trailing : para;
  }

  /**
   * Build one <hp:rect> + <hp:drawText> group child (groupLevel="1") for a
   * hwpx-shape text box. Position is encoded in the group transform: the
   * transMatrix translation (e3,e6) = (leftHwp, topHwp) with an identity scale,
   * which places the box's top-left at (left, top) within the container.
   */
  _buildRectChild(divContent, leftHwp, topHwp, zOrder = 0) {
    const innerBlocks = Array.isArray(divContent) && divContent.length > 1 ? divContent[1] : [];
    const shape = this._parseShapeStyle(this._getStyleStr(divContent));
    const HWPUNIT_PER_PT = 100;

    const w = shape.widthPt     !== null ? Math.max(Math.trunc(shape.widthPt     * HWPUNIT_PER_PT), 1) : 10000;
    const declaredH = shape.minHeightPt !== null ? Math.max(Math.trunc(shape.minHeightPt * HWPUNIT_PER_PT), 1) : 1000;

    const padLeft   = Math.trunc((shape.padLeftPt   || 0) * HWPUNIT_PER_PT);
    const padRight  = Math.trunc((shape.padRightPt  || 0) * HWPUNIT_PER_PT);
    const padTop    = Math.trunc((shape.padTopPt    || 0) * HWPUNIT_PER_PT);
    const padBottom = Math.trunc((shape.padBottomPt || 0) * HWPUNIT_PER_PT);

    // A rect carries a single outline (hp:lineShape). Use the first specified
    // border; default to an invisible (NONE) outline like the source document.
    const b = shape.borderTop || shape.borderLeft || shape.borderRight || shape.borderBottom;
    let lineStyle = 'NONE', lineColor = '#000000', lineWidth = '0';
    if (b && b.type && b.type !== 'NONE') {
      lineStyle = b.type;                       // SOLID / DASHED / DOT / DOUBLE
      lineColor = b.color || '#000000';
      const mm  = parseFloat(b.width) || 0.12;  // b.width is like "0.50 mm"
      lineWidth = String(Math.max(1, Math.trunc(mm * 7200 / 25.4))); // mm → HWPUNIT
    }

    const fillXml = shape.bgColor
      ? `<hp:fillBrush><hc:winBrush faceColor="${shape.bgColor}" hatchColor="${shape.bgColor}" alpha="0"/></hp:fillBrush>`
      : '';

    let cellXml = this._processBlocksForTableCell(innerBlocks);
    if (!cellXml.trim()) {
      cellXml = this._createParaStart(this.normalStyleId, this.normalParaPrId) +
                '<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>';
    }
    // Re-point the drawText paragraphs at tight paraPr variants (130% line
    // spacing, no paragraph spacing) so the dense text stays compact like the
    // source HTML and fits the page instead of overflowing/clipping. Skipped for
    // nested tables (their cell paragraphs must keep their own paraPr).
    if (!cellXml.includes('<hp:tbl')) {
      cellXml = cellXml.replace(/paraPrIDRef="(\d+)"/g,
        (m, id) => `paraPrIDRef="${this._getTightDrawTextParaPr(id)}"`);
    }
    // A drawing-object text box needs explicit line segments — unlike body text
    // and table cells, Hancom does not re-layout drawText paragraphs that lack
    // <hp:linesegarray>, so without them the lines collapse and text is lost.
    const innerWidth = Math.max(w - padLeft - padRight, 1000);
    const seg = this._injectLineSegs(cellXml, innerWidth);
    cellXml = seg.xml;
    // Hancom CLIPS a drawText box to its own height, but the source HTML used
    // overflow:visible (the declared height is smaller than the real text).
    // Grow the box to the laid-out content height so no lines are cut off; the
    // 1.25x headroom covers Hancom laying lines out slightly taller than the
    // charPr-height estimate (it still fits the page for this content).
    const h = Math.max(declaredH, padTop + Math.round(seg.contentHeight * 1.25) + padBottom);

    const rectId = String(Date.now() % 100000000 + Math.trunc(Math.random() * 100000));
    const cx = Math.trunc(w / 2);
    const cy = Math.trunc(h / 2);

    return (
      `<hp:rect id="${rectId}" zOrder="${zOrder}" numberingType="NONE" ` +
      `textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" ` +
      `href="" groupLevel="1" instid="${this._nextInstId()}" ratio="0">` +
      `<hp:offset x="${leftHwp}" y="${topHwp}"/>` +
      `<hp:orgSz width="${w}" height="${h}"/>` +
      `<hp:curSz width="${w}" height="${h}"/>` +
      `<hp:flip horizontal="0" vertical="0"/>` +
      `<hp:rotationInfo angle="0" centerX="${cx}" centerY="${cy}" rotateimage="0"/>` +
      `<hp:renderingInfo>` +
      `<hc:transMatrix e1="1" e2="0" e3="${leftHwp}" e4="0" e5="1" e6="${topHwp}"/>` +
      `<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
      `<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
      `</hp:renderingInfo>` +
      `<hp:lineShape color="${lineColor}" width="${lineWidth}" style="${lineStyle}" ` +
      `endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" headfill="1" tailfill="1" ` +
      `headSz="MEDIUM_MEDIUM" tailSz="MEDIUM_MEDIUM" outlineStyle="NORMAL" alpha="0"/>` +
      fillXml +
      `<hp:shadow type="NONE" color="#000000" offsetX="0" offsetY="0" alpha="0"/>` +
      `<hp:drawText lastWidth="${w}" name="" editable="0">` +
      `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" ` +
      `linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
      cellXml +
      `</hp:subList>` +
      `<hp:textMargin left="${padLeft}" right="${padRight}" top="${padTop}" bottom="${padBottom}"/>` +
      `</hp:drawText>` +
      `<hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/>` +
      `</hp:rect>`
    );
  }

  /**
   * Clone a paraPr into a "tight" variant for use inside a drawText box:
   * line spacing 130% (vs the template's loose 180%) and zero paragraph
   * before/after spacing. The source HTML paragraphs are margin:0 and the box is
   * space-constrained, so the inherited 180% + 20pt-after blows the text far past
   * the page and gets clipped. Cached per base id.
   */
  _getTightDrawTextParaPr(baseId) {
    if (this._tightParaPrCache === undefined) this._tightParaPrCache = new Map();
    if (this._tightParaPrCache.has(baseId)) return this._tightParaPrCache.get(baseId);
    if (!this.headerRoot) return baseId;
    const base = findDescendantByAttr(this.headerRoot, HH_NS, 'paraPr', 'id', String(baseId));
    if (!base) { this._tightParaPrCache.set(baseId, baseId); return baseId; }

    const node = base.cloneNode(true);
    this.maxParaPrId++;
    const newId = String(this.maxParaPrId);
    node.setAttribute('id', newId);

    for (const ls of getAllDescendants(node, HH_NS, 'lineSpacing')) {
      ls.setAttribute('type', 'PERCENT');
      ls.setAttribute('value', '130');
      ls.setAttribute('unit', 'HWPUNIT');
    }
    for (const name of ['prev', 'next']) {
      for (const el of getAllDescendants(node, HC_NS, name)) el.setAttribute('value', '0');
    }

    const paraProps = findDescendant(this.headerRoot, HH_NS, 'paraProperties');
    if (paraProps) paraProps.appendChild(node);
    this._tightParaPrCache.set(baseId, newId);
    return newId;
  }

  /** Look up a charPr's font height (HWPUNIT) from the header; cached. */
  _charPrHeightHwp(charPrId) {
    if (this._charPrHeightCache === undefined) this._charPrHeightCache = new Map();
    if (this._charPrHeightCache.has(charPrId)) return this._charPrHeightCache.get(charPrId);
    let h = 1000;
    if (this.headerRoot) {
      const node = findDescendantByAttr(this.headerRoot, HH_NS, 'charPr', 'id', String(charPrId));
      if (node) {
        const hv = parseInt(node.getAttribute('height') || '1000', 10);
        if (!isNaN(hv) && hv > 0) h = hv;
      }
    }
    this._charPrHeightCache.set(charPrId, h);
    return h;
  }

  /**
   * Add one <hp:linesegarray> (single <hp:lineseg>) to every top-level <hp:p> in
   * a drawText body, stacking the lines vertically. Mirrors the source HWPX,
   * which stores one line segment per paragraph in its text boxes. The line
   * height comes from the largest font (charPr) used in the paragraph; vertpos
   * accumulates so paragraphs don't overlap. A ~1.3x pitch (HTML-like single
   * spacing) keeps the laid-out content compact enough to stay within the page.
   * Skipped when the body contains a nested table (its inner <hp:p>s must not be
   * touched); then contentHeight is 0 and the caller keeps the declared size.
   * @returns {{xml:string, contentHeight:number}} contentHeight = bottom of the
   *          last line in HWPUNIT (relative to the text area top).
   */
  _injectLineSegs(parasXml, innerWidth) {
    if (parasXml.includes('<hp:tbl')) return { xml: parasXml, contentHeight: 0 };
    let cumY = 0;
    let contentHeight = 0;
    const xml = parasXml.replace(/<hp:p\b[^>]*>[\s\S]*?<\/hp:p>/g, (para) => {
      const ids = [...para.matchAll(/charPrIDRef="(\d+)"/g)].map(m => parseInt(m[1], 10));
      let vertsize = 1000;
      for (const id of ids) vertsize = Math.max(vertsize, this._charPrHeightHwp(id));
      const baseline = Math.round(vertsize * 0.85);
      const spacing  = Math.round(vertsize * 0.3);
      const vertpos  = cumY;
      contentHeight  = Math.max(contentHeight, vertpos + vertsize);
      cumY += vertsize + spacing;
      const segXml =
        `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${vertpos}" ` +
        `vertsize="${vertsize}" textheight="${vertsize}" baseline="${baseline}" ` +
        `spacing="${spacing}" horzpos="0" horzsize="${innerWidth}" flags="393216"/></hp:linesegarray>`;
      return para.replace(/<\/hp:p>$/, segXml + '</hp:p>');
    });
    return { xml, contentHeight };
  }

  // ------------------------------------------------------------------ table cell

  _processBlocksForTableCell(blocks) {
    const result = [];
    for (const block of blocks) {
      if (typeof block !== 'object' || !block) continue;
      const bt = block.t;
      const bc = block.c;
      if      (bt === 'Para')          result.push(this._handleParaInTable(bc, block.paraStyle));
      else if (bt === 'Plain')         result.push(this._handlePlainInTable(bc, block.paraStyle));
      else if (bt === 'Header')        result.push(this._handleHeader(bc));
      else if (bt === 'BulletList')    result.push(this._handleBulletList(bc));
      else if (bt === 'OrderedList')   result.push(this._handleOrderedList(bc));
      else if (bt === 'Table')         { const x = this._handleTable(bc); if (x) result.push(x); }
      else if (bt === 'HorizontalRule') result.push(this._handleHorizontalRule());
      else if (bt === 'BlockQuote')    result.push(this._handleBlockQuote(bc));
      else if (bt === 'Div') {
        const classes = bc && bc[0] && bc[0][1] ? bc[0][1] : [];
        if (classes.includes('hwpx-container')) result.push(this._handleContainer(bc, null, 0));
        else if (classes.includes('hwpx-shape')) result.push(this._handleShape(bc));
        else result.push(this._processBlocksForTableCell(bc && bc.length > 1 ? bc[1] : []));
      }
    }
    return result.join('\n');
  }

  _handleParaInTable(content, paraStyleStr = null) {
    let paraPrId = this.normalParaPrId;
    if (paraStyleStr) {
      const ps = this._parseParaStyleStr(paraStyleStr);
      if (ps.align || ps.paddingLeft || ps.textIndent || ps.marginRight || ps.spaceBefore || ps.spaceAfter || ps.bgColor) {
        paraPrId = this._getOrCreateParaPr(
          ps.paddingLeft || 0, ps.textIndent || 0, ps.align || null,
          ps.marginRight || 0, ps.spaceBefore || 0, ps.spaceAfter || 0, ps.bgColor || null
        );
      }
    }
    const segments = this._splitByLinebreak(content);
    const result   = [];
    for (const seg of segments) {
      if (seg.length) {
        const xml = (
          this._createParaStart(this.normalStyleId, paraPrId) +
          this._processInlines(seg) + '</hp:p>'
        );
        result.push(xml);
      }
    }
    if (!result.length) {
      result.push(
        this._createParaStart(this.normalStyleId, paraPrId) +
        '<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>'
      );
    }
    return result.join('\n');
  }

  _handlePlainInTable(content, paraStyleStr = null) { return this._handleParaInTable(content, paraStyleStr); }

  _splitByLinebreak(inlines) {
    const segments = [];
    let current    = [];
    for (const inline of inlines) {
      if (inline.t === 'LineBreak') { segments.push(current); current = []; }
      else current.push(inline);
    }
    if (current.length) segments.push(current);
    return segments;
  }

  // ------------------------------------------------------------------ paragraphs

  _handlePara(content, paraStyles = null, paraStyleStr = null) {
    let paddingLeft = 0, textIndent = 0, align = null, marginRight = 0, spaceBefore = 0, spaceAfter = 0, bgColor = null;

    if (paraStyleStr) {
      const ps = this._parseParaStyleStr(paraStyleStr);
      paddingLeft = ps.paddingLeft || 0;
      textIndent  = ps.textIndent  || 0;
      align       = ps.align       || null;
      marginRight = ps.marginRight || 0;
      spaceBefore = ps.spaceBefore || 0;
      spaceAfter  = ps.spaceAfter  || 0;
      bgColor     = ps.bgColor     || null;
    } else if (paraStyles !== null) {
      paddingLeft = paraStyles['padding-left'] || paraStyles['margin-left'] || 0;
      textIndent  = paraStyles['text-indent'] || 0;
    } else if (Object.keys(this.htmlParaStyles).length) {
      const paraText = this._getPlainText(content).slice(0, 100);
      if (this.htmlParaStyles[paraText]) {
        const hs = this.htmlParaStyles[paraText];
        const cv = {};
        for (const [k, v] of Object.entries(hs)) cv[k] = this._convertSizeToHwp(v);
        paddingLeft = cv['padding-left'] || cv['margin-left'] || 0;
        textIndent  = cv['text-indent'] || 0;
        if (hs['text-align']) {
          const a = hs['text-align'].toLowerCase();
          if      (a === 'center')  align = 'CENTER';
          else if (a === 'right')   align = 'RIGHT';
          else if (a === 'left')    align = 'LEFT';
          else if (a === 'justify') align = 'JUSTIFY';
        }
        marginRight = cv['margin-right'] || 0;
        spaceAfter  = cv['margin-bottom'] || 0;
        spaceBefore = cv['margin-top']    || 0;
      }
    }

    const paraPrId = this._getOrCreateParaPr(paddingLeft, textIndent, align, marginRight, spaceBefore, spaceAfter, bgColor);
    return (
      this._createParaStart(this.normalStyleId, paraPrId) +
      this._processInlines(content) + '</hp:p>'
    );
  }

  _handlePlain(content, paraStyles = null, paraStyleStr = null) { return this._handlePara(content, paraStyles, paraStyleStr); }

  _handleHeader(content) {
    const level   = content[0];
    const inlines = content[2];
    const style   = Math.min(level, 6);
    return (
      this._createParaStart(style) +
      this._processInlines(inlines) + '</hp:p>'
    );
  }

  // ------------------------------------------------------------------ lists

  _handleBulletList(listData, depth = 0) {
    const items    = Array.isArray(listData) ? listData : [];
    const result   = [];
    const paraPrId = this._getParaPrForListDepth(depth);

    for (const item of items) {
      if (!Array.isArray(item)) continue;
      let hasTextBlock = false;
      for (const block of item) {
        const bt = block.t;
        const bc = block.c;
        if (bt === 'Plain' || bt === 'Para') {
          result.push(this._createParaStart(this.normalStyleId, paraPrId));
          if (!hasTextBlock) {
            result.push('<hp:run charPrIDRef="0"><hp:t>• </hp:t></hp:run>');
            hasTextBlock = true;
          }
          result.push(this._processInlines(bc));
          result.push('</hp:p>');
        }
        else if (bt === 'BulletList')  result.push(this._handleBulletList(bc, depth + 1));
        else if (bt === 'OrderedList') result.push(this._handleOrderedList(bc, depth + 1));
        else if (bt === 'Header')      result.push(this._handleHeader(bc));
        else if (bt === 'HorizontalRule') result.push(this._handleHorizontalRule());
        else if (bt === 'BlockQuote')  result.push(this._handleBlockQuote(bc, paraPrId));
        else if (bt === 'Table')       { const x = this._handleTable(bc, paraPrId); if (x) result.push(x); }
        else if (bt === 'Div') {
          const classes = bc && bc[0] && bc[0][1] ? bc[0][1] : [];
          if (classes.includes('hwpx-container')) result.push(this._handleContainer(bc, paraPrId, 0));
          else if (classes.includes('hwpx-shape')) result.push(this._handleShape(bc, paraPrId));
          else result.push(this._processBlocksInList(bc && bc.length > 1 ? bc[1] : [], depth));
        }
        else if (bt === 'RawBlock')    { const x = this._handleRawBlockInList(bc, paraPrId); if (x) result.push(x); }
        else if (bt === 'CodeBlock')   result.push(this._handleCodeBlock(bc));
      }
    }
    return result.join('\n');
  }

  _handleOrderedList(listData, depth = 0) {
    const items    = listData.length > 1 ? listData[1] : [];
    const result   = [];
    const paraPrId = this._getParaPrForListDepth(depth);

    let idx = 1;
    for (const item of items) {
      if (!Array.isArray(item)) { idx++; continue; }
      let hasTextBlock = false;
      for (const block of item) {
        const bt = block.t;
        const bc = block.c;
        if (bt === 'Plain' || bt === 'Para') {
          result.push(this._createParaStart(this.normalStyleId, paraPrId));
          if (!hasTextBlock) {
            result.push(`<hp:run charPrIDRef="0"><hp:t>${idx}. </hp:t></hp:run>`);
            hasTextBlock = true;
          }
          result.push(this._processInlines(bc));
          result.push('</hp:p>');
        }
        else if (bt === 'BulletList')  result.push(this._handleBulletList(bc, depth + 1));
        else if (bt === 'OrderedList') result.push(this._handleOrderedList(bc, depth + 1));
        else if (bt === 'Header')      result.push(this._handleHeader(bc));
        else if (bt === 'HorizontalRule') result.push(this._handleHorizontalRule());
        else if (bt === 'BlockQuote')  result.push(this._handleBlockQuote(bc, paraPrId));
        else if (bt === 'Table')       { const x = this._handleTable(bc, paraPrId); if (x) result.push(x); }
        else if (bt === 'Div') {
          const classes = bc && bc[0] && bc[0][1] ? bc[0][1] : [];
          if (classes.includes('hwpx-container')) result.push(this._handleContainer(bc, paraPrId, 0));
          else if (classes.includes('hwpx-shape')) result.push(this._handleShape(bc, paraPrId));
          else result.push(this._processBlocksInList(bc && bc.length > 1 ? bc[1] : [], depth));
        }
        else if (bt === 'RawBlock')    { const x = this._handleRawBlockInList(bc, paraPrId); if (x) result.push(x); }
        else if (bt === 'CodeBlock')   result.push(this._handleCodeBlock(bc));
      }
      idx++;
    }
    return result.join('\n');
  }

  _processBlocksInList(blocks, depth = 0) {
    const result   = [];
    const paraPrId = this._getParaPrForListDepth(depth);

    for (const block of blocks) {
      if (typeof block !== 'object' || !block) continue;
      const bt = block.t;
      const bc = block.c;
      if (bt === 'Para' || bt === 'Plain') {
        result.push(
          this._createParaStart(this.normalStyleId, paraPrId) +
          this._processInlines(bc) + '</hp:p>'
        );
      }
      else if (bt === 'Header')      result.push(this._handleHeader(bc));
      else if (bt === 'HorizontalRule') result.push(this._handleHorizontalRule());
      else if (bt === 'BlockQuote')  result.push(this._handleBlockQuote(bc, paraPrId));
      else if (bt === 'Table')       { const x = this._handleTable(bc, paraPrId); if (x) result.push(x); }
      else if (bt === 'BulletList')  result.push(this._handleBulletList(bc, depth + 1));
      else if (bt === 'OrderedList') result.push(this._handleOrderedList(bc, depth + 1));
      else if (bt === 'Div') {
        const classes = bc && bc[0] && bc[0][1] ? bc[0][1] : [];
        if (classes.includes('hwpx-container')) result.push(this._handleContainer(bc, paraPrId, 0));
        else if (classes.includes('hwpx-shape')) result.push(this._handleShape(bc, paraPrId));
        else result.push(this._processBlocksInList(bc && bc.length > 1 ? bc[1] : [], depth));
      }
      else if (bt === 'RawBlock')    { const x = this._handleRawBlockInList(bc, paraPrId); if (x) result.push(x); }
      else if (bt === 'CodeBlock')   result.push(this._handleCodeBlock(bc));
    }
    return result.join('\n');
  }

  // ------------------------------------------------------------------ raw / code

  _handleRawBlockInList(content, paraPrId = null) {
    if (!content || content.length < 2) return '';
    const [rawFormat, rawHtml] = content;
    if (!['html', 'HTML'].includes(rawFormat)) return '';
    if (!rawHtml.toLowerCase().includes('<table')) return '';
    try {
      return this._convertRawHtmlTable(rawHtml, paraPrId);
    } catch (e) {
      process.stderr.write(`[Warn] Failed to convert raw HTML table: ${e}\n`);
      return '';
    }
  }

  _convertRawHtmlTable(htmlStr, paraPrId = null) {
    const rows = [];
    let currentRow  = null;
    let currentCell = null;
    let cellBuf     = [];
    let depth       = 0;

    const parser = new Parser({
      onopentag(tag, attrs) {
        if (tag === 'table') { depth++; return; }
        if (depth !== 1) return;
        if (tag === 'tr') currentRow = [];
        else if (tag === 'td' || tag === 'th') {
          cellBuf     = [];
          currentCell = {
            isHeader: tag === 'th',
            colspan:  parseInt(attrs.colspan || '1', 10),
            rowspan:  parseInt(attrs.rowspan || '1', 10),
            text: '',
          };
        }
      },
      onclosetag(tag) {
        if (tag === 'table') { depth--; return; }
        if (depth !== 1) return;
        if ((tag === 'td' || tag === 'th') && currentCell) {
          currentCell.text = cellBuf.join('').trim();
          if (currentRow) currentRow.push(currentCell);
          currentCell = null;
          cellBuf     = [];
        } else if (tag === 'tr' && currentRow) {
          rows.push(currentRow);
          currentRow = null;
        }
      },
      ontext(data) {
        if (currentCell && depth === 1) cellBuf.push(data);
      },
    }, { decodeEntities: true });
    parser.write(htmlStr);
    parser.end();

    if (!rows.length) return '';

    const cellGrid = new Map();
    let maxRow = 0, maxCol = 0;
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      let currCol = 0;
      for (const cell of rows[rowIdx]) {
        while (cellGrid.has(`${rowIdx},${currCol}`)) currCol++;
        const { colspan, rowspan, text } = cell;
        const ib = text
          ? { t: 'Para', c: [{ t: 'Str', c: text }] }
          : { t: 'Para', c: [] };
        for (let r = 0; r < rowspan; r++) {
          for (let c = 0; c < colspan; c++) {
            cellGrid.set(`${rowIdx + r},${currCol + c}`, {
              originRow: rowIdx, originCol: currCol,
              rowspan, colspan, blocks: [ib],
            });
          }
        }
        maxRow = Math.max(maxRow, rowIdx + rowspan - 1);
        maxCol = Math.max(maxCol, currCol + colspan - 1);
        currCol += colspan;
      }
    }

    const rowCnt = maxRow + 1;
    const colCnt = maxCol + 1;
    const TOTAL_TABLE_WIDTH = 45000;
    const tblId  = String(Date.now() % 100000000 + Math.trunc(Math.random() * 10000));
    const eppid  = paraPrId !== null ? paraPrId : this.normalParaPrId;

    const xmlParts = [
      this._createParaStart(this.normalStyleId, eppid),
      this._createRunStart(0),
    ];

    if (this.tableBorderFillId === null) this._ensureTableBorderFill();

    const plm        = this._getLeftMarginFromParaPr(eppid);
    const ew         = TOTAL_TABLE_WIDTH - plm;
    const colWidths  = Array.from({ length: colCnt }, () => Math.trunc(ew / colCnt));

    xmlParts.push(
      `<hp:tbl id="${tblId}" zOrder="0" numberingType="TABLE" ` +
      `textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" ` +
      `dropcapstyle="None" pageBreak="CELL" repeatHeader="1" ` +
      `rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" ` +
      `borderFillIDRef="${this.tableBorderFillId}" noAdjust="0">`
    );
    xmlParts.push(
      `<hp:sz width="${ew}" widthRelTo="ABSOLUTE" ` +
      `height="${rowCnt * 1000}" heightRelTo="ABSOLUTE" protect="0"/>`
    );
    xmlParts.push(
      '<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" ' +
      'allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" ' +
      'horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" ' +
      'vertOffset="0" horzOffset="0"/>'
    );
    xmlParts.push('<hp:outMargin left="0" right="0" top="0" bottom="1417"/>');
    xmlParts.push('<hp:inMargin left="510" right="510" top="141" bottom="141"/>');

    const processed = new Set();
    for (let rowIdx = 0; rowIdx < rowCnt; rowIdx++) {
      xmlParts.push('<hp:tr>');
      for (let colIdx = 0; colIdx < colCnt; colIdx++) {
        const key = `${rowIdx},${colIdx}`;
        const ci  = cellGrid.get(key);

        // Phantom cell only for genuinely missing positions (no entry in the grid).
        // Span-covered positions must NOT get a phantom — the origin cell's rowSpan/colSpan
        // already covers that space, and a duplicate <hp:tc> breaks the layout.
        if (!ci) {
          const psid = String(Date.now() % 1000000000 + Math.trunc(Math.random() * 100000));
          xmlParts.push(
            `<hp:tc name="" header="0" hasMargin="0" protect="0" ` +
            `editable="0" dirty="0" borderFillIDRef="${this.tableBorderFillId}">`
          );
          xmlParts.push(
            `<hp:subList id="${psid}" textDirection="HORIZONTAL" lineWrap="BREAK" ` +
            `vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" ` +
            `textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">`
          );
          xmlParts.push(
            this._createParaStart(this.normalStyleId, this.normalParaPrId) +
            '<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>'
          );
          xmlParts.push('</hp:subList>');
          xmlParts.push(`<hp:cellAddr colAddr="${colIdx}" rowAddr="${rowIdx}"/>`);
          xmlParts.push(`<hp:cellSpan colSpan="1" rowSpan="1"/>`);
          xmlParts.push(`<hp:cellSz width="${colWidths[colIdx]}" height="1000"/>`);
          xmlParts.push('<hp:cellMargin left="510" right="510" top="141" bottom="141"/>');
          xmlParts.push('</hp:tc>');
          continue;
        }

        // Span-covered position — skip, the origin cell handles it via rowSpan/colSpan.
        if (ci.originRow !== rowIdx || ci.originCol !== colIdx) continue;

        if (processed.has(key)) continue;
        processed.add(key);

        const cw  = colWidths.slice(colIdx, colIdx + ci.colspan).reduce((a, b) => a + b, 0);
        const sid = String(Date.now() % 1000000000 + Math.trunc(Math.random() * 100000));
        let cxml  = this._processBlocksForTableCell(ci.blocks);
        if (!cxml.trim()) {
          cxml = (
            this._createParaStart(this.normalStyleId, this.normalParaPrId) +
            '<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>'
          );
        }
        xmlParts.push(
          `<hp:tc name="" header="0" hasMargin="0" protect="0" ` +
          `editable="0" dirty="0" borderFillIDRef="${this.tableBorderFillId}">`
        );
        xmlParts.push(
          `<hp:subList id="${sid}" textDirection="HORIZONTAL" lineWrap="BREAK" ` +
          `vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" ` +
          `textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">`
        );
        xmlParts.push(cxml);
        xmlParts.push('</hp:subList>');
        xmlParts.push(`<hp:cellAddr colAddr="${colIdx}" rowAddr="${rowIdx}"/>`);
        xmlParts.push(`<hp:cellSpan colSpan="${ci.colspan}" rowSpan="${ci.rowspan}"/>`);
        xmlParts.push(`<hp:cellSz width="${cw}" height="1000"/>`);
        xmlParts.push('<hp:cellMargin left="510" right="510" top="141" bottom="141"/>');
        xmlParts.push('</hp:tc>');
      }
      xmlParts.push('</hp:tr>');
    }
    xmlParts.push('</hp:tbl>', '</hp:run>', '</hp:p>');
    return xmlParts.join('');
  }

  _handleCodeBlock(content) {
    const codeText = content.length > 1 ? content[1] : '';
    return (
      this._createParaStart(this.normalStyleId, this.normalParaPrId) +
      `<hp:run charPrIDRef="0"><hp:t>${this._escapeText(codeText)}</hp:t></hp:run>` +
      '</hp:p>'
    );
  }

  // ------------------------------------------------------------------ HR / blockquote

  _handleHorizontalRule() {
    const cacheKey = '__horizontal_rule__';
    let hrId;
    if (this.paraPrCache.has(cacheKey)) {
      hrId = this.paraPrCache.get(cacheKey);
    } else {
      hrId = this._createHrParaPr();
      this.paraPrCache.set(cacheKey, hrId);
    }
    return (
      this._createParaStart(this.normalStyleId, hrId) +
      '<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>'
    );
  }

  _createHrParaPr() {
    if (!this.headerRoot) return String(this.normalParaPrId);
    const hrBfId   = this._ensureHrBorderFill();
    let baseNode   = findDescendantByAttr(this.headerRoot, HH_NS, 'paraPr', 'id', String(this.normalParaPrId));
    if (!baseNode) baseNode = findDescendantByAttr(this.headerRoot, HH_NS, 'paraPr', 'id', '0');
    if (!baseNode) return String(this.normalParaPrId);

    const newNode = baseNode.cloneNode(true);
    this.maxParaPrId++;
    const newId = String(this.maxParaPrId);
    newNode.setAttribute('id', newId);
    newNode.setAttribute('borderFillIDRef', String(hrBfId));

    const paraProps = findDescendant(this.headerRoot, HH_NS, 'paraProperties');
    if (paraProps) paraProps.appendChild(newNode);
    return newId;
  }

  _ensureHrBorderFill() {
    if (this._hrBorderFillId !== null) return this._hrBorderFillId;
    this.maxBorderFillId++;
    const bfId          = this.maxBorderFillId;
    this._hrBorderFillId = bfId;
    const bfXml = (
      `<hh:borderFill xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" ` +
      `xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" ` +
      `id="${bfId}" threeD="0" shadow="0" slash="NONE" backSlash="NONE" ` +
      `crookedSlash="0" counterstrike="0">` +
      `<hh:leftBorder type="NONE" width="0.12 mm" color="#000000"/>` +
      `<hh:rightBorder type="NONE" width="0.12 mm" color="#000000"/>` +
      `<hh:topBorder type="NONE" width="0.12 mm" color="#000000"/>` +
      `<hh:bottomBorder type="SOLID" width="0.12 mm" color="#A0A0A0"/>` +
      `<hh:diagonal type="NONE" crooked="0"/>` +
      `<hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#000000" alpha="0"/></hc:fillBrush></hh:borderFill>`
    );
    const bfDoc  = new DOMParser().parseFromString(bfXml, 'text/xml');
    const bfElem = this.headerDoc.importNode(bfDoc.documentElement, true);
    let bfc = findDescendant(this.headerRoot, HH_NS, 'borderFills');
    if (!bfc) bfc = createElement(this.headerRoot, HH_NS, 'hh', 'borderFills');
    bfc.appendChild(bfElem);
    return bfId;
  }

  _handleBlockQuote(content, paraPrId = null) {
    const BQ_EXTRA   = 3600;
    const baseMargin = paraPrId ? this._getLeftMarginFromParaPr(paraPrId) : 0;
    const bqMargin   = baseMargin + BQ_EXTRA;
    const cacheKey   = `${bqMargin},0`;
    let bqId;
    if (this.paraPrCache.has(cacheKey)) {
      bqId = this.paraPrCache.get(cacheKey);
    } else {
      bqId = this._createParaPrWithMargin(bqMargin);
      this.paraPrCache.set(cacheKey, bqId);
    }

    const result = [];
    for (const block of (content || [])) {
      if (typeof block !== 'object' || !block) continue;
      const bt = block.t;
      const bc = block.c;
      if (bt === 'Para' || bt === 'Plain')
        result.push(this._createParaStart(this.normalStyleId, bqId) + this._processInlines(bc) + '</hp:p>');
      else if (bt === 'Header')      result.push(this._handleHeader(bc));
      else if (bt === 'BulletList')  result.push(this._handleBulletList(bc));
      else if (bt === 'OrderedList') result.push(this._handleOrderedList(bc));
      else if (bt === 'Table')       result.push(this._handleTable(bc, bqId));
      else if (bt === 'HorizontalRule') result.push(this._handleHorizontalRule());
      else if (bt === 'BlockQuote')  result.push(this._handleBlockQuote(bc, bqId));
      else if (bt === 'CodeBlock')   result.push(this._handleCodeBlock(bc));
      else if (bt === 'Div') {
        const classes = bc && bc[0] && bc[0][1] ? bc[0][1] : [];
        if (classes.includes('hwpx-container')) result.push(this._handleContainer(bc, bqId, 0));
        else if (classes.includes('hwpx-shape')) result.push(this._handleShape(bc, bqId));
        else result.push(this._handleBlockQuote(bc && bc.length > 1 ? bc[1] : [], bqId));
      }
    }
    return result.join('\n');
  }

  // ------------------------------------------------------------------ top-level

  _processBlocks(blocks) {
    const result = [];
    // Track flow state so each hwpx-container starts a fresh page like the
    // source document: the FIRST container after ordinary content gets a page
    // break; consecutive containers don't (their full-height backgrounds already
    // push the next one onto a new page).
    let emittedContent   = false;
    let prevWasContainer = false;
    for (const block of blocks) {
      if (typeof block !== 'object' || !block) continue;
      const bt = block.t;
      const bc = block.c;
      let isContainer = false;
      if      (bt === 'Para')          result.push(this._handlePara(bc, null, block.paraStyle));
      else if (bt === 'Plain')         result.push(this._handlePlain(bc, null, block.paraStyle));
      else if (bt === 'Header')        result.push(this._handleHeader(bc));
      else if (bt === 'BulletList')    result.push(this._handleBulletList(bc));
      else if (bt === 'OrderedList')   result.push(this._handleOrderedList(bc));
      else if (bt === 'Table')         { const x = this._handleTable(bc); if (x) result.push(x); }
      else if (bt === 'Div') {
        const classes = bc && bc[0] && bc[0][1] ? bc[0][1] : [];
        if (classes.includes('hwpx-container')) {
          isContainer = true;
          const pageBreak = (emittedContent && !prevWasContainer) ? 1 : 0;
          result.push(this._handleContainer(bc, null, pageBreak));
        }
        else if (classes.includes('hwpx-shape')) result.push(this._handleShape(bc));
        else result.push(this._processBlocks(bc && bc.length > 1 ? bc[1] : []));
      }
      else if (bt === 'CodeBlock')     result.push(this._handleCodeBlock(bc));
      else if (bt === 'HorizontalRule') result.push(this._handleHorizontalRule());
      else if (bt === 'BlockQuote')    result.push(this._handleBlockQuote(bc));
      else if (bt === 'RawBlock')      { const x = this._handleRawBlockInList(bc); if (x) result.push(x); }
      emittedContent   = true;
      prevWasContainer = isContainer;
    }
    return result.join('\n');
  }

  _processInlines(inlines, activeFormats = new Set(), baseColor = null, baseSize = null) {
    const result = [];
    for (const inline of inlines) {
      const it = inline.t;
      const ic = inline.c;

      if (it === 'Str') {
        const cid = this._getOrCreateCharPr(0, activeFormats, baseColor, baseSize);
        result.push(`<hp:run charPrIDRef="${cid}"><hp:t>${escapeXml(ic)}</hp:t></hp:run>`);
      }
      else if (it === 'Space') {
        const cid = this._getOrCreateCharPr(0, activeFormats, baseColor, baseSize);
        result.push(`<hp:run charPrIDRef="${cid}"><hp:t> </hp:t></hp:run>`);
      }
      else if (it === 'Strong') {
        const nf = new Set([...activeFormats, 'BOLD']);
        result.push(this._processInlines(ic, nf, baseColor, baseSize));
      }
      else if (it === 'Emph') {
        const nf = new Set([...activeFormats, 'ITALIC']);
        result.push(this._processInlines(ic, nf, baseColor, baseSize));
      }
      else if (it === 'Underline') {
        const nf = new Set([...activeFormats, 'UNDERLINE']);
        result.push(this._processInlines(ic, nf, baseColor, baseSize));
      }
      else if (it === 'Strikeout') {
        const nf = new Set([...activeFormats, 'STRIKEOUT']);
        result.push(this._processInlines(ic, nf, baseColor, baseSize));
      }
      else if (it === 'Superscript') {
        const nf = new Set([...activeFormats, 'SUPERSCRIPT']);
        result.push(this._processInlines(ic, nf, baseColor, baseSize));
      }
      else if (it === 'Subscript') {
        const nf = new Set([...activeFormats, 'SUBSCRIPT']);
        result.push(this._processInlines(ic, nf, baseColor, baseSize));
      }
      else if (it === 'Span') {
        const attr       = ic[0];
        const spanInlines = ic[1];
        const styles     = this._extractStyleFromAttr(attr);
        const nf         = new Set(activeFormats);
        let nc = baseColor, ns = baseSize;
        if (styles.bold)      nf.add('BOLD');
        if (styles.italic)    nf.add('ITALIC');
        if (styles.underline) nf.add('UNDERLINE');
        if (styles.strikeout) nf.add('STRIKEOUT');
        if (styles.color)           nc = styles.color;
        if (styles['font-size'])    ns = styles['font-size'];
        result.push(this._processInlines(spanInlines, nf, nc, ns));
      }
      else if (it === 'LineBreak') {
        result.push('<hp:lineseg/>');
      }
      else if (it === 'SoftBreak') {
        const cid = this._getOrCreateCharPr(0, activeFormats, baseColor, baseSize);
        result.push(`<hp:run charPrIDRef="${cid}"><hp:t> </hp:t></hp:run>`);
      }
      else if (it === 'Code') {
        const cid = this._getOrCreateCharPr(0, activeFormats, baseColor, baseSize);
        result.push(`<hp:run charPrIDRef="${cid}"><hp:t>${escapeXml(ic[1])}</hp:t></hp:run>`);
      }
      else if (it === 'Link') {
        // Render link display text (href is not representable in HWPX inline; text is preserved)
        result.push(this._processInlines(ic[1], activeFormats, baseColor, baseSize));
      }
      else if (it === 'Image') {
        const imgXml = this._handleImageInline(ic);
        if (imgXml) result.push(imgXml);
      }
    }
    return result.join('');
  }

  // ------------------------------------------------------------------ entry points

  process() {
    if (!this.ast) return '';
    const blocks  = this.ast.blocks || [];
    this.output   = [this._processBlocks(blocks)];
    return this.output.join('\n');
  }

  getModifiedHeaderXml() {
    if (!this.headerRoot) return this.headerXmlContent;

    for (const [containerLocalName, childLocalName] of [
      ['charProperties', 'charPr'],
      ['paraProperties', 'paraPr'],
      ['borderFills',    'borderFill'],
    ]) {
      const container = findDescendant(this.headerRoot, HH_NS, containerLocalName);
      if (container) {
        const count = countDirectChildren(container, HH_NS, childLocalName);
        container.setAttribute('itemCnt', String(count));
      }
    }

    return new XMLSerializer().serializeToString(this.headerDoc);
  }

  // ------------------------------------------------------------------ static helpers

  static _defaultTemplateDir() {
    return path.join(__dirname, '..', 'template');
  }

  /**
   * Convert an HTML string to HWPX and return a Node.js Buffer.
   *
   * Drop-in equivalent to HTMLtoDOCX(html) from html-to-docx:
   *   const buffer = await HTMLtoHWPX(htmlString);
   *
   * @param {string} htmlString      - HTML content as a string
   * @param {string} [referencePath] - path to the extracted HWPX template directory
   * @returns {Promise<Buffer>}
   */
  static async htmlToBuffer(htmlString, referencePath = null, basePath = null) {
    if (!referencePath) referencePath = HtmlToHwpx._defaultTemplateDir();

    if (!fs.existsSync(referencePath) || !fs.statSync(referencePath).isDirectory()) {
      throw new Error(
        `referencePath must be an extracted template directory, got: ${referencePath}\n` +
        'Unzip your .hwpx file into a folder and pass that folder path.'
      );
    }

    const headerXml = fs.readFileSync(path.join(referencePath, 'Contents', 'header.xml'), 'utf8');
    const ast = HtmlToAst.parse(htmlString);
    const converter = new HtmlToHwpx({ jsonAst: ast, headerXmlContent: headerXml, htmlContent: htmlString, basePath });
    const sectionContent = converter.process();
    const modifiedHeader = converter.getModifiedHeaderXml();

    const sectionXml = `<?xml version="1.0" encoding="utf-8"?>
<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app">
  <hp:p paraPrIDRef="1" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0">
      <hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="1" textVerticalWidthHead="0" masterPageCnt="0">
        <hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>
        <hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>
        <hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>
        <hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>
        <hp:pagePr landscape="WIDELY" width="59530" height="84190" gutterType="LEFT_ONLY">
          <hp:margin header="4250" footer="2240" gutter="0" left="7200" right="7200" top="4255" bottom="4960"/>
        </hp:pagePr>
        <hp:footNotePr>
          <hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="1"/>
          <hp:noteLine length="-1" type="SOLID" width="0.25 mm" color="#000000"/>
          <hp:noteSpacing betweenNotes="283" belowLine="0" aboveLine="1000"/>
          <hp:numbering type="CONTINUOUS" newNum="1"/>
          <hp:placement place="EACH_COLUMN" beneathText="0"/>
        </hp:footNotePr>
        <hp:endNotePr>
          <hp:autoNumFormat type="ROMAN_SMALL" userChar="" prefixChar="" suffixChar="" supscript="1"/>
          <hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>
          <hp:noteSpacing betweenNotes="0" belowLine="0" aboveLine="1000"/>
          <hp:numbering type="CONTINUOUS" newNum="1"/>
          <hp:placement place="END_OF_DOCUMENT" beneathText="0"/>
        </hp:endNotePr>
        <hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">
          <hp:offset left="1417" right="1417" top="1417" bottom="1417"/>
        </hp:pageBorderFill>
        <hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">
          <hp:offset left="1417" right="1417" top="1417" bottom="1417"/>
        </hp:pageBorderFill>
        <hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">
          <hp:offset left="1417" right="1417" top="1417" bottom="1417"/>
        </hp:pageBorderFill>
      </hp:secPr>
      <hp:ctrl>
        <hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/>
      </hp:ctrl>
    </hp:run>
    <hp:run charPrIDRef="0">
      <hp:t/>
    </hp:run>
  </hp:p>
${sectionContent}
</hs:sec>`;

    const images  = converter.images;
    const skip    = new Set(['Contents/header.xml', 'Contents/section0.xml', 'Contents/content.hpf']);
    const zip     = new JSZip();

    const walkDir = (dir, base) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath  = (base ? base + '/' : '') + entry.name;
        if (entry.isDirectory()) {
          walkDir(fullPath, relPath);
        } else if (!skip.has(relPath)) {
          zip.file(relPath, fs.readFileSync(fullPath));
        }
      }
    };
    walkDir(referencePath, '');

    // Embed image files under BinData/
    for (const img of images) {
      zip.file(`BinData/${img.name}.${img.ext}`, img.data);
    }

    // Update content.hpf manifest with image entries
    let contentHpf = fs.readFileSync(path.join(referencePath, 'Contents', 'content.hpf'), 'utf8');
    if (images.length > 0) {
      const imgItems = images.map(img =>
        `<opf:item id="${img.name}" href="BinData/${img.name}.${img.ext}" ` +
        `media-type="${img.mime}" isEmbeded="1"/>`
      ).join('');
      contentHpf = contentHpf.replace('</opf:manifest>', imgItems + '</opf:manifest>');
    }

    zip.file('Contents/header.xml',   Buffer.from(modifiedHeader, 'utf8'));
    zip.file('Contents/section0.xml', Buffer.from(sectionXml,     'utf8'));
    zip.file('Contents/content.hpf',  Buffer.from(contentHpf,     'utf8'));

    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  /**
   * Convert an HTML file to HWPX using a reference template directory.
   *
   * @param {string} inputPath      - path to the input HTML file
   * @param {string} outputPath     - path for the generated .hwpx file
   * @param {string} [referencePath] - path to the extracted HWPX template directory
   * @returns {Promise<void>}
   */
  static async convertToHwpx(inputPath, outputPath, referencePath = null) {
    if (!referencePath) referencePath = HtmlToHwpx._defaultTemplateDir();

    if (!fs.existsSync(referencePath) || !fs.statSync(referencePath).isDirectory()) {
      throw new Error(
        `referencePath must be an extracted template directory, got: ${referencePath}\n` +
        'Unzip your .hwpx file into a folder and pass that folder path.'
      );
    }

    const headerXml  = fs.readFileSync(path.join(referencePath, 'Contents', 'header.xml'),   'utf8');
    // section0.xml is part of the template but will be overwritten below

    const ext = path.extname(inputPath).toLowerCase();
    let htmlContent;
    if (ext === '.html' || ext === '.htm') {
      htmlContent = fs.readFileSync(inputPath, 'utf8');
    } else {
      throw new Error(
        `Unsupported input format '${ext}'. ` +
        'Only .html / .htm input is supported. Convert your source to HTML first.'
      );
    }

    const inputDir = path.dirname(path.resolve(inputPath));
    const ast = HtmlToAst.parse(htmlContent);
    const converter = new HtmlToHwpx({ jsonAst: ast, headerXmlContent: headerXml, htmlContent, basePath: inputDir });
    const sectionContent = converter.process();
    const modifiedHeader = converter.getModifiedHeaderXml();

    const sectionXml = `<?xml version="1.0" encoding="utf-8"?>
<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app">
  <hp:p paraPrIDRef="1" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0">
      <hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="1" textVerticalWidthHead="0" masterPageCnt="0">
        <hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>
        <hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>
        <hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>
        <hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>
        <hp:pagePr landscape="WIDELY" width="59530" height="84190" gutterType="LEFT_ONLY">
          <hp:margin header="4250" footer="2240" gutter="0" left="7200" right="7200" top="4255" bottom="4960"/>
        </hp:pagePr>
        <hp:footNotePr>
          <hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="1"/>
          <hp:noteLine length="-1" type="SOLID" width="0.25 mm" color="#000000"/>
          <hp:noteSpacing betweenNotes="283" belowLine="0" aboveLine="1000"/>
          <hp:numbering type="CONTINUOUS" newNum="1"/>
          <hp:placement place="EACH_COLUMN" beneathText="0"/>
        </hp:footNotePr>
        <hp:endNotePr>
          <hp:autoNumFormat type="ROMAN_SMALL" userChar="" prefixChar="" suffixChar="" supscript="1"/>
          <hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>
          <hp:noteSpacing betweenNotes="0" belowLine="0" aboveLine="1000"/>
          <hp:numbering type="CONTINUOUS" newNum="1"/>
          <hp:placement place="END_OF_DOCUMENT" beneathText="0"/>
        </hp:endNotePr>
        <hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">
          <hp:offset left="1417" right="1417" top="1417" bottom="1417"/>
        </hp:pageBorderFill>
        <hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">
          <hp:offset left="1417" right="1417" top="1417" bottom="1417"/>
        </hp:pageBorderFill>
        <hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">
          <hp:offset left="1417" right="1417" top="1417" bottom="1417"/>
        </hp:pageBorderFill>
      </hp:secPr>
      <hp:ctrl>
        <hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/>
      </hp:ctrl>
    </hp:run>
    <hp:run charPrIDRef="0">
      <hp:t/>
    </hp:run>
  </hp:p>
${sectionContent}
</hs:sec>`;

    const images  = converter.images;
    const skip    = new Set(['Contents/header.xml', 'Contents/section0.xml', 'Contents/content.hpf']);
    const zip     = new JSZip();

    // Walk template directory and add all files except the ones we override
    const walkDir = (dir, base) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath  = (base ? base + '/' : '') + entry.name;
        if (entry.isDirectory()) {
          walkDir(fullPath, relPath);
        } else if (!skip.has(relPath)) {
          zip.file(relPath, fs.readFileSync(fullPath));
        }
      }
    };
    walkDir(referencePath, '');

    // Embed image files under BinData/
    for (const img of images) {
      zip.file(`BinData/${img.name}.${img.ext}`, img.data);
    }

    // Update content.hpf manifest with image entries
    let contentHpf = fs.readFileSync(path.join(referencePath, 'Contents', 'content.hpf'), 'utf8');
    if (images.length > 0) {
      const imgItems = images.map(img =>
        `<opf:item id="${img.name}" href="BinData/${img.name}.${img.ext}" ` +
        `media-type="${img.mime}" isEmbeded="1"/>`
      ).join('');
      contentHpf = contentHpf.replace('</opf:manifest>', imgItems + '</opf:manifest>');
    }

    zip.file('Contents/header.xml',   Buffer.from(modifiedHeader, 'utf8'));
    zip.file('Contents/section0.xml', Buffer.from(sectionXml,     'utf8'));
    zip.file('Contents/content.hpf',  Buffer.from(contentHpf,     'utf8'));

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(outputPath, buffer);
  }
}

module.exports = { HtmlToHwpx, HTMLStyleExtractor };