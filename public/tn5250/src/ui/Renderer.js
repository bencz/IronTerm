// Canvas renderer for the 5250 presentation space.
//
// Each cell knows its attribute descriptor (see ScreenBuffer.placeAttribute);
// we map that to foreground/background colours, plus the modifier
// effects (blink / underline / reverse-image / hidden / column-sep).
// Attribute cells themselves are non-display and are never rendered.
//
// On top of the character grid we overlay ENPTUI primitives — windows,
// radio/checkbox indicators, push-button frames, menu bars, scroll bars
// — read from screen.enptui. These are rendered AFTER the cell layer so
// they paint over any underlying text/colour the host emitted.

import { ConstructKind, isSingleSelect } from '../proto/enptui/Constants.js';
import { AttrIndex } from '../proto/enptui/primitives/SelectionField.js';
import { ATTR_BASE } from '../proto/Constants.js';

const COLOR = {
    black:     '#000000',
    green:     '#33ff33',
    red:       '#ff4444',
    white:     '#ffffff',
    turquoise: '#5cf6ff',
    yellow:    '#ffff44',
    pink:      '#ff66cc',
    blue:      '#3399ff',
};

function fgFor (cell) {
    if (cell.attr.hidden) return cell.attr.bg ? COLOR[cell.attr.bg] : '#000';
    return COLOR[cell.attr.fg] ?? COLOR.green;
}
function bgFor (cell) {
    return COLOR[cell.attr.bg] ?? COLOR.black;
}

export class Renderer {
    constructor (canvas, screen) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.screen = screen;
        this.cellWidth = 0;
        this.cellHeight = 0;
        this.fontSize = 16;
        this.cursorBlink = true;
        this.selection = null;

        // requestAnimationFrame coalescer - many records can arrive in
        // rapid succession (especially during a sign-off / menu switch);
        // we collapse all of them into a single paint per frame so the
        // user doesn't see the intermediate clear-screen flashes.
        this._rafPending = false;

        // One blink ticker only - 500ms toggle drives both the cursor
        // and any blinking attribute. Same pattern tn3270 uses.
        setInterval(() => {
            this.cursorBlink = !this.cursorBlink;
            this.draw();
        }, 500);
    }

    /** External hook for input selection - re-uses the coalesced draw. */
    setSelection (sel) { this.selection = sel; this.draw(); }

    resize () {
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width  = Math.max(1, Math.floor(rect.width));
        this.canvas.height = Math.max(1, Math.floor(rect.height));
        const s = this.screen;
        this.cellWidth  = this.canvas.width  / s.cols;
        this.cellHeight = this.canvas.height / s.rows;
        this.fontSize = this.#computeFontSize();
        this.draw();
    }

    #computeFontSize () {
        const ctx = this.ctx;
        // Find the largest font that keeps glyphs within cell bounds.
        for (let sz = Math.floor(this.cellHeight); sz >= 6; sz--) {
            ctx.font = `${sz}px "IBM Plex Mono", monospace`;
            const w = ctx.measureText('W').width;
            if (w <= this.cellWidth * 0.95) return sz;
        }
        return 8;
    }

    /** Public entry. Coalesces multiple synchronous calls into a single
     *  paint that fires on the next animation frame. The browser will
     *  also batch with its own paint cycle, so a burst of N draws never
     *  results in more than 1 visible frame per screen refresh. */
    draw () {
        if (this._rafPending) return;
        this._rafPending = true;
        requestAnimationFrame(() => {
            this._rafPending = false;
            this.#renderNow();
        });
    }

    #renderNow () {
        const s = this.screen;
        const ctx = this.ctx;
        if (!ctx) return;

        ctx.fillStyle = COLOR.black;
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.font = `${this.fontSize}px "IBM Plex Mono", monospace`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        // Pre-compute the highlight-on-entry override: if the cursor is
        // inside an input field whose FCW 0x89 set a per-field attribute,
        // every cell of that field is rendered with that attribute byte
        // instead of its own. Mirrors real 5250 hardware which swaps the
        // colour of the entire field the moment the user enters it.
        const cursorField = s.fieldAt(s.cursor);
        const highlightDesc = (cursorField && cursorField.highlightAttr)
            ? (ATTR_BASE[cursorField.highlightAttr] ?? null)
            : null;

        for (let r = 0; r < s.rows; r++) {
            for (let c = 0; c < s.cols; c++) {
                const idx = r * s.cols + c;
                const cell = s.cells[idx];
                if (cell.attributePlace) continue;       // non-display

                const x = c * this.cellWidth;
                const y = r * this.cellHeight;

                // Apply highlight-on-entry over the field's cells.
                const useDesc = (highlightDesc && cell.field === cursorField)
                    ? highlightDesc : cell.attr;
                const fg = useDesc.hidden ? (useDesc.bg ? COLOR[useDesc.bg] : '#000')
                                          : (COLOR[useDesc.fg] ?? COLOR.green);
                const bg = COLOR[useDesc.bg] ?? COLOR.black;
                if (bg !== COLOR.black || useDesc.reverse) {
                    ctx.fillStyle = useDesc.reverse ? fg : bg;
                    ctx.fillRect(x, y, this.cellWidth, this.cellHeight);
                }

                // Blink: skip drawing the glyph on the "off" half of
                // the cursor ticker (shares the 500ms cadence so we
                // never run multiple intervals fighting each other).
                if (useDesc.blink && !this.cursorBlink) continue;

                const drawFg = useDesc.reverse ? bg : fg;
                ctx.fillStyle = drawFg;
                const glyph = cell.glyph || ' ';
                ctx.fillText(glyph, x + this.cellWidth * 0.02, y + this.cellHeight / 2);

                // Underline. Real IBM 5250 hardware (and tn5250j,
                // ECL/PS5250) only underline cells whose active
                // attribute byte has the UL flag set - that's bytes
                // 0x24-0x26, 0x2C-0x2E, 0x34-0x36, 0x3C-0x3E in
                // ATTR_BASE. Input fields with a non-underline
                // attribute (e.g. 0x20 plain green) must render
                // without an underscore.
                if (useDesc.underline) {
                    ctx.fillStyle = drawFg;
                    ctx.fillRect(x, y + this.cellHeight - 1, this.cellWidth, 1);
                }

                // Extended attribute (Write Extended Attribute) — only
                // a handful of pens are commonly used: type 0x02 carries
                // additional highlight bits (0x04 underline, 0x08 blink,
                // 0x40 reverse) that stack with the basic attribute.
                if (cell.extAttr && cell.extAttr.type === 0x02) {
                    const v = cell.extAttr.value;
                    if ((v & 0x04) && !useDesc.underline) {
                        ctx.fillStyle = drawFg;
                        ctx.fillRect(x, y + this.cellHeight - 1, this.cellWidth, 1);
                    }
                }
                // Column separators existed on real IBM 5250 hardware
                // but modern emulators (incl. tn5250j) skip them by
                // default - they clutter the screen on every cell of a
                // 0x30-0x33 run. We follow the same convention; flip
                // this on if you actually want them.
            }
        }

        // ENPTUI overlay - paints windows, selection markers, push
        // buttons, menu bars and scroll bars on top of the cell grid.
        this.#drawEnptui(ctx, s);

        // Selection overlay (mouse drag).
        if (this.selection) {
            ctx.fillStyle = 'rgba(80, 145, 255, 0.35)';
            const sel = this.selection;
            const x1 = sel.col1 * this.cellWidth;
            const y1 = sel.row1 * this.cellHeight;
            const w  = (sel.col2 - sel.col1 + 1) * this.cellWidth;
            const h  = (sel.row2 - sel.row1 + 1) * this.cellHeight;
            ctx.fillRect(x1, y1, w, h);
        }

        // Cursor block. Solid semi-transparent fill at the bottom of
        // the cursor cell - red when keyboard is locked (system wait),
        // white otherwise. Same convention tn3270 uses; avoids the
        // 'difference' composite mode which can flicker during fast
        // transitions like sign-off.
        if (this.cursorBlink) {
            const cx = (s.cursor % s.cols) * this.cellWidth;
            const cy = (s.cursor / s.cols | 0) * this.cellHeight;
            ctx.fillStyle = s.keyboardLocked
                ? 'rgba(255, 80, 80, 0.55)'
                : 'rgba(255, 255, 255, 0.55)';
            ctx.fillRect(cx, cy + this.cellHeight - 4, this.cellWidth, 4);
        }
    }

    // ---- ENPTUI overlay -----------------------------------------------

    #drawEnptui (ctx, s) {
        const store = s.enptui;
        if (!store || store.all.length === 0) return;

        for (const c of store.all) {
            switch (c.kind) {
                case ConstructKind.WINDOW:           this.#drawWindow(ctx, c); break;
                case ConstructKind.SELECTION_FIELD:  this.#drawSelectionField(ctx, c, s); break;
                case ConstructKind.MENU_BAR:         this.#drawMenuBar(ctx, c, s); break;
                case ConstructKind.PUSH_BUTTONS:     this.#drawPushButtons(ctx, c, s); break;
                case ConstructKind.SCROLL_BAR:       this.#drawScrollBar(ctx, c); break;
                case ConstructKind.GRID:             this.#drawGrid(ctx, c); break;
                // Mouse regions are invisible by design — they exist
                // only so the input controller can fire AIDs when the
                // user clicks inside them.
            }
        }
    }

    /** Draw the grid separator lines from a host-defined construct.
     *  ECL stores grid edges as a per-cell bit map (G_LOWER_H/G_RIGHT_V/
     *  G_UPPER_H/G_LEFT_V); we mirror that here and stroke each edge
     *  on its cell boundary. Bit map is constructed by WdsfDecoder's
     *  applyGridMinor() when DEFINE_GRID is processed. */
    #drawGrid (ctx, g) {
        if (!g.gridBuf) return;
        const cw = this.cellWidth;
        const ch = this.cellHeight;
        const cols = this.screen.cols;
        ctx.save();
        ctx.strokeStyle = COLOR.turquoise;
        ctx.lineWidth = 1;
        for (let idx = 0; idx < g.gridBuf.length; idx++) {
            const flags = g.gridBuf[idx];
            if (flags === 0) continue;
            const row = (idx / cols) | 0;
            const col = idx % cols;
            const x = col * cw;
            const y = row * ch;
            ctx.beginPath();
            if (flags & 0x04) { ctx.moveTo(x, y + 0.5);                 ctx.lineTo(x + cw, y + 0.5); }
            if (flags & 0x01) { ctx.moveTo(x, y + ch - 0.5);            ctx.lineTo(x + cw, y + ch - 0.5); }
            if (flags & 0x08) { ctx.moveTo(x + 0.5, y);                 ctx.lineTo(x + 0.5, y + ch); }
            if (flags & 0x02) { ctx.moveTo(x + cw - 0.5, y);            ctx.lineTo(x + cw - 0.5, y + ch); }
            ctx.stroke();
        }
        ctx.restore();
    }

    #drawWindow (ctx, w) {
        const x = (w.leftCol - 1) * this.cellWidth;
        const y = (w.topRow  - 1) * this.cellHeight;
        const wpx = w.width  * this.cellWidth;
        const hpx = w.height * this.cellHeight;

        ctx.save();
        // Non-display border (host requested zero-visible-frame
        // attribute 0x27/0x2F/0x37/0x3F): skip the frame entirely.
        // Title/footer still renders below.
        if (!w.noBorder) {
            const borderDesc = ATTR_BASE[w.borderAttr];
            const frameColor = borderDesc ? (COLOR[borderDesc.fg] ?? COLOR.turquoise)
                                           : COLOR.turquoise;
            ctx.strokeStyle = frameColor;
            // Line style decoded from the Border minor's byte 5:
            //   0=solid, 1=bold, 2=double, 3=dotted, 8=dashed,
            //   9=bold dashed, 10=double dashed
            switch (w.lineStyle) {
                case 1:  ctx.lineWidth = 2; break;
                case 3:  ctx.setLineDash([2, 2]); break;
                case 8:  ctx.setLineDash([5, 3]); break;
                case 9:  ctx.lineWidth = 2; ctx.setLineDash([5, 3]); break;
                case 10: ctx.setLineDash([5, 3]); break;
            }
            // Menu-pull-down windows omit the top border so the visual
            // glues to the originating menu-bar row.
            if (w.menuPullDown) {
                ctx.beginPath();
                ctx.moveTo(x + 0.5, y);
                ctx.lineTo(x + 0.5, y + hpx);
                ctx.lineTo(x + wpx - 0.5, y + hpx);
                ctx.lineTo(x + wpx - 0.5, y);
                ctx.stroke();
            } else {
                ctx.strokeRect(x + 0.5, y + 0.5, wpx - 1, hpx - 1);
                if (w.lineStyle === 2 || w.lineStyle === 10) {
                    ctx.strokeRect(x + 2.5, y + 2.5, wpx - 5, hpx - 5);
                }
            }
            ctx.setLineDash([]);
        }

        // Title and footer come as { text, attr, align } objects from
        // the Window decoder. Attr is a 5250 attribute byte; resolve it
        // through ATTR_BASE so colour and reverse/underline modifiers
        // match what the host requested.
        const drawText = (info, yPos) => {
            if (!info || !info.text) return;
            const desc = ATTR_BASE[info.attr];
            const fg = desc?.reverse ? (COLOR[desc.bg] ?? COLOR.black)
                                     : (COLOR[desc?.fg] ?? COLOR.white);
            const bg = desc?.reverse ? (COLOR[desc.fg] ?? COLOR.white)
                                     : (COLOR[desc?.bg] ?? COLOR.black);
            ctx.font = `${this.fontSize}px "IBM Plex Mono", monospace`;
            ctx.textBaseline = 'middle';
            const txt = ' ' + info.text.trimEnd() + ' ';
            const txtW = txt.length * this.cellWidth;
            let txtX;
            if (info.align === 'center')      txtX = x + (wpx - txtW) / 2;
            else if (info.align === 'right')  txtX = x + wpx - txtW - this.cellWidth;
            else                              txtX = x + this.cellWidth;
            ctx.fillStyle = bg;
            ctx.fillRect(txtX, yPos, txtW, this.cellHeight);
            ctx.fillStyle = fg;
            ctx.textAlign = 'left';
            for (let i = 0; i < txt.length; i++) {
                ctx.fillText(txt[i],
                    txtX + i * this.cellWidth + this.cellWidth * 0.02,
                    yPos + this.cellHeight / 2);
            }
            if (desc?.underline) {
                ctx.fillStyle = fg;
                ctx.fillRect(txtX, yPos + this.cellHeight - 1, txtW, 1);
            }
        };
        drawText(w.title,  y);
        drawText(w.footer, y + hpx - this.cellHeight);
        ctx.restore();
    }

    /** Overlay fancy radio / checkbox markers on top of the single-cell
     *  ASCII indicator SelectionField.js painted. Each item knows its
     *  absolute (row, col) on screen; the indicator sits at the very
     *  first cell of the item slot (no parens/brackets around it).
     *  We blank that cell and paint a Unicode glyph (●/○/☑/☐) on top. */
    #drawSelectionField (ctx, sel, s) {
        if (!sel.drawIndicator || !sel.itemPositions?.length) return;

        // Identify the item the cursor is currently on (if any) so we
        // can paint a reverse-video focus highlight over its label —
        // same convention IACS / PCOMM use to show which radio /
        // checkbox the keyboard is about to toggle.
        const focused = s.enptuiItemAtCursor?.();
        const focusedIdx = (focused && focused.construct === sel) ? focused.index : -1;

        ctx.save();
        ctx.font = `${this.fontSize}px "IBM Plex Mono", monospace`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';

        for (let i = 0; i < sel.items.length; i++) {
            const item = sel.items[i];
            const pos  = sel.itemPositions[i];
            if (!pos) continue;

            const r0 = pos.row - 1;
            const c0 = pos.col - 1;
            const cellX = c0 * this.cellWidth;
            const cellY = r0 * this.cellHeight;
            const isFocused = (i === focusedIdx);

            // Resolve the per-state attribute byte the host sent in
            // ChoiceAttributes. Picks the cursor-* slot when the item
            // is focused; otherwise the non-cursor slot. Colours come
            // from the standard ATTR_BASE table.
            const attrByte = item.unavailable
                ? sel.choiceAttrs[isFocused ? AttrIndex.CUR_UNAVAILABLE : AttrIndex.UNAVAILABLE]
                : item.selected
                    ? sel.choiceAttrs[isFocused ? AttrIndex.CUR_SELECTED  : AttrIndex.SELECTED]
                    : sel.choiceAttrs[isFocused ? AttrIndex.CUR_AVAILABLE : AttrIndex.AVAILABLE];
            const indAttrByte = item.unavailable
                ? sel.choiceAttrs[AttrIndex.IND_UNAVAILABLE]
                : sel.choiceAttrs[AttrIndex.IND_AVAILABLE];
            const indDesc = ATTR_BASE[indAttrByte] ?? sel.items[0]?.indDesc;
            const itemDesc = ATTR_BASE[attrByte];

            // Clear the indicator cell so the underlying EBCDIC '.'
            // or '/' doesn't show through underneath our glyph.
            ctx.fillStyle = '#000';
            ctx.fillRect(cellX, cellY, this.cellWidth, this.cellHeight);

            const marker = sel.single
                ? (item.selected ? '●' : '○')
                : (item.selected ? '☑' : '☐');

            ctx.fillStyle = indDesc ? (COLOR[indDesc.fg] ?? COLOR.green) : COLOR.green;
            ctx.fillText(marker, cellX + this.cellWidth / 2, cellY + this.cellHeight / 2);

            // Repaint the label cells with the resolved per-state
            // attribute. We re-render the EBCDIC bytes (already in the
            // screen buffer) using the chosen fg/bg, then drop the
            // mnemonic underline on top.
            if (itemDesc) {
                const textCol = c0 + 2;
                const textX = textCol * this.cellWidth;
                const textW = (sel.textSize ?? 0) * this.cellWidth;
                const fg = itemDesc.reverse ? (COLOR[itemDesc.bg] ?? COLOR.black)
                                            : (COLOR[itemDesc.fg] ?? COLOR.green);
                const bg = itemDesc.reverse ? (COLOR[itemDesc.fg] ?? COLOR.green)
                                            : (COLOR[itemDesc.bg] ?? COLOR.black);
                ctx.fillStyle = bg;
                ctx.fillRect(textX, cellY, textW, this.cellHeight);
                ctx.fillStyle = fg;
                ctx.textAlign = 'left';
                for (let k = 0; k < (sel.textSize ?? 0); k++) {
                    const cIdx = (pos.row - 1) * s.cols + textCol + k;
                    const cell = s.cells[cIdx];
                    if (!cell) break;
                    ctx.fillText(cell.glyph || ' ',
                        textX + k * this.cellWidth + this.cellWidth * 0.02,
                        cellY + this.cellHeight / 2);
                }
                // Mnemonic underline: highlight the host-designated
                // shortcut character so the user knows which keystroke
                // jumps directly to this item.
                if (item.mnemonicOffset >= 0 && item.mnemonicOffset < (sel.textSize ?? 0)) {
                    ctx.fillStyle = fg;
                    ctx.fillRect(
                        textX + item.mnemonicOffset * this.cellWidth,
                        cellY + this.cellHeight - 2,
                        this.cellWidth, 1);
                }
                if (itemDesc.underline) {
                    ctx.fillStyle = fg;
                    ctx.fillRect(textX, cellY + this.cellHeight - 1, textW, 1);
                }
                ctx.textAlign = 'center';
            }
        }
        ctx.restore();
    }

    #drawMenuBar (ctx, mb, s) {
        if (!mb.items?.length) return;
        const x = (mb.col - 1) * this.cellWidth;
        const y = (mb.row - 1) * this.cellHeight;
        const wpx = s.cols * this.cellWidth - x;

        ctx.save();
        // Reverse-video bar background.
        ctx.fillStyle = 'rgba(80, 145, 255, 0.18)';
        ctx.fillRect(x, y, wpx, this.cellHeight);

        // Underline beneath the bar.
        ctx.strokeStyle = COLOR.turquoise;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + this.cellHeight - 1);
        ctx.lineTo(x + wpx, y + this.cellHeight - 1);
        ctx.stroke();
        ctx.restore();
    }

    #drawPushButtons (ctx, pb, s) {
        if (!pb.itemPositions?.length) return;
        const focused = s.enptuiItemAtCursor?.();
        const focusedIdx = (focused && focused.construct === pb) ? focused.index : -1;
        ctx.save();
        ctx.lineWidth = 1;

        // Each button occupies `textSize` cells starting at its
        // itemPosition. ECL renders the frame with line-drawing chars:
        // `[` cap on the left, horizontal rule across the top + bottom,
        // `]` cap on the right. We approximate using stroked lines so
        // the visual matches without forcing a specific glyph set.
        // Conventions per ECL:
        //   - `isNoPushButtonBox` (flag2 0x04) suppresses the frame.
        //   - Cursor on a button (focused) inverts colours.
        //   - Default button (choiceState 0x40) gets a thicker frame.
        //   - Unavailable button uses the unavailable palette colour.
        for (let i = 0; i < pb.items.length; i++) {
            const item = pb.items[i];
            const pos  = pb.itemPositions[i];
            if (!pos) continue;
            if ((item.flag2 & 0x04) !== 0) continue;     // NoPushBox flag

            const isFocused = (i === focusedIdx);
            const isDefault = item.selected;             // "default" button == pre-selected
            const r = pos.row - 1;
            const c = pos.col - 1;
            const x = c * this.cellWidth;
            const y = r * this.cellHeight;
            const wpx = pb.textSize * this.cellWidth;
            const hpx = this.cellHeight;

            // Pick frame colour from the host-supplied palette.
            const attrByte = item.unavailable
                ? pb.choiceAttrs[AttrIndex.UNAVAILABLE]
                : isFocused
                    ? pb.choiceAttrs[AttrIndex.CUR_AVAILABLE]
                    : pb.choiceAttrs[AttrIndex.AVAILABLE];
            const desc = ATTR_BASE[attrByte];
            const frameColor = desc ? (COLOR[desc.fg] ?? COLOR.turquoise) : COLOR.turquoise;
            ctx.strokeStyle = frameColor;
            ctx.lineWidth = isDefault ? 2 : 1;

            if (isFocused) {
                // Invert: fill the whole button rectangle with the
                // frame colour and re-draw label text in black.
                ctx.fillStyle = frameColor;
                ctx.fillRect(x, y, wpx, hpx);
                ctx.fillStyle = '#000';
                ctx.font = `${this.fontSize}px "IBM Plex Mono", monospace`;
                ctx.textBaseline = 'middle';
                ctx.textAlign = 'left';
                for (let k = 0; k < pb.textSize; k++) {
                    const cIdx = r * s.cols + c + k;
                    const cell = s.cells[cIdx];
                    if (!cell) break;
                    ctx.fillText(cell.glyph || ' ',
                        x + k * this.cellWidth + this.cellWidth * 0.02,
                        y + hpx / 2);
                }
            }

            // Draw caps + rule. The 3D look comes from horizontal lines
            // 1 px from top/bottom plus side caps.
            ctx.beginPath();
            ctx.moveTo(x, y + 0.5);                ctx.lineTo(x + wpx, y + 0.5);
            ctx.moveTo(x, y + hpx - 0.5);          ctx.lineTo(x + wpx, y + hpx - 0.5);
            ctx.moveTo(x + 0.5, y);                ctx.lineTo(x + 0.5, y + hpx);
            ctx.moveTo(x + wpx - 0.5, y);          ctx.lineTo(x + wpx - 0.5, y + hpx);
            ctx.stroke();
            ctx.lineWidth = 1;
        }
        ctx.restore();
    }

    #drawScrollBar (ctx, sb) {
        const cw = this.cellWidth;
        const ch = this.cellHeight;
        const x = sb.colOffset * cw;
        const y = sb.rowOffset * ch;

        ctx.save();
        ctx.strokeStyle = COLOR.turquoise;
        ctx.fillStyle   = 'rgba(92, 246, 255, 0.18)';
        if (sb.direction === 0) {
            // Vertical
            const length = sb.length * ch;
            ctx.fillRect(x, y, cw, length);
            ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, length - 1);
            // Thumb proportional to visible/total.
            const total = Math.max(sb.totalRows, 1);
            const visible = Math.max(sb.visibleRows, 1);
            const thumbH = Math.max(ch, (visible / total) * length);
            const thumbY = y + (sb.sliderPos / total) * length;
            ctx.fillStyle = COLOR.turquoise;
            ctx.fillRect(x + 2, thumbY + 2, cw - 4, thumbH - 4);
        } else {
            // Horizontal
            const length = sb.length * cw;
            ctx.fillRect(x, y, length, ch);
            ctx.strokeRect(x + 0.5, y + 0.5, length - 1, ch - 1);
            const total = Math.max(sb.totalRows, 1);
            const visible = Math.max(sb.visibleRows, 1);
            const thumbW = Math.max(cw, (visible / total) * length);
            const thumbX = x + (sb.sliderPos / total) * length;
            ctx.fillStyle = COLOR.turquoise;
            ctx.fillRect(thumbX + 2, y + 2, thumbW - 4, ch - 4);
        }
        ctx.restore();
        void isSingleSelect;        // imported for future use
    }
}
