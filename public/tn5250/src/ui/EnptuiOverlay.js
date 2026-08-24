// ENPTUI overlay: paints windows, selection-field indicators, push
// buttons, menu bars, scroll bars and grid separators on top of the
// 5250 cell grid. Driven entirely from screen.enptui (populated by
// the WdsfDecoder during inbound parsing).
//
// Geometry is provided by the renderer:
//   { cellWidth, cellHeight, fontSize, cursorBlink }
//
// All colour lookups go through ./theme.js.

import { ConstructKind } from '../proto/enptui/Constants.js';
import { AttrIndex } from '../proto/enptui/primitives/SelectionField.js';
import { ATTR_BASE } from '../proto/Constants.js';
import { COLOR, TERMINAL_FONT } from './theme.js';

export class EnptuiOverlay {
    /** @param {import('../display/ScreenBuffer.js').ScreenBuffer} screen */
    constructor (screen) {
        this.screen = screen;
        this.g = null;
    }

    /** Paint all active ENPTUI constructs on the canvas. */
    paint (ctx, geometry) {
        const store = this.screen.enptui;
        if (!store || store.all.length === 0) return;

        this.g = geometry;
        for (const c of store.all) {
            switch (c.kind) {
                case ConstructKind.WINDOW:           this.#drawWindow(ctx, c); break;
                case ConstructKind.SELECTION_FIELD:  this.#drawSelectionField(ctx, c); break;
                case ConstructKind.MENU_BAR:         this.#drawMenuBar(ctx, c); break;
                case ConstructKind.PUSH_BUTTONS:     this.#drawPushButtons(ctx, c); break;
                case ConstructKind.SCROLL_BAR:       this.#drawScrollBar(ctx, c); break;
                case ConstructKind.GRID:             this.#drawGrid(ctx, c); break;
                // Programmable mouse definitions are global and have no
                // persistent visual of their own.
            }
        }
        this.#drawPointerMarker(ctx);
    }

    #drawPointerMarker (ctx) {
        const marker = this.screen.pointerMarker;
        if (!marker) return;
        const { cellWidth, cellHeight } = this.g;
        const startCol = Math.max(0, marker.col - 1);
        const widthCells = Math.min(3, this.screen.cols - startCol);
        ctx.save();
        ctx.strokeStyle = COLOR.turquoise;
        ctx.lineWidth = 1;
        ctx.strokeRect(
            startCol * cellWidth + 0.5,
            marker.row * cellHeight + 0.5,
            widthCells * cellWidth - 1,
            cellHeight - 1);
        ctx.restore();
    }

    /** Draw the grid separator lines from a host-defined construct.
     *  Grid edges are stored as a per-cell bit map (G_LOWER_H /
     *  G_RIGHT_V / G_UPPER_H / G_LEFT_V); we stroke each edge on its
     *  cell boundary. The bit map is constructed by WdsfDecoder's
     *  applyGridMinor() when DEFINE_GRID is processed. */
    #drawGrid (ctx, g) {
        if (!g.gridBuf) return;
        const { cellWidth: cw, cellHeight: ch } = this.g;
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
        const { cellWidth, cellHeight, fontSize } = this.g;
        const x = (w.leftCol - 1) * cellWidth;
        const y = (w.topRow  - 1) * cellHeight;
        const wpx = w.width  * cellWidth;
        const hpx = w.height * cellHeight;

        ctx.save();
        // Non-display border (host requested zero-visible-frame
        // attribute 0x27/0x2F/0x37/0x3F): skip the frame entirely.
        // Title/footer still renders below.
        if (!w.noBorder) {
            const borderDesc = ATTR_BASE[w.borderAttr];
            const frameColor = borderDesc ? (COLOR[borderDesc.fg] ?? COLOR.turquoise)
                                           : COLOR.turquoise;
            ctx.strokeStyle = frameColor;
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
            ctx.font = `${fontSize}px ${TERMINAL_FONT}`;
            ctx.textBaseline = 'middle';
            const txt = ' ' + info.text.trimEnd() + ' ';
            const txtW = txt.length * cellWidth;
            let txtX;
            if (info.align === 'center')      txtX = x + (wpx - txtW) / 2;
            else if (info.align === 'right')  txtX = x + wpx - txtW - cellWidth;
            else                              txtX = x + cellWidth;
            ctx.fillStyle = bg;
            ctx.fillRect(txtX, yPos, txtW, cellHeight);
            ctx.fillStyle = fg;
            ctx.textAlign = 'left';
            for (let i = 0; i < txt.length; i++) {
                ctx.fillText(txt[i],
                    txtX + i * cellWidth + cellWidth * 0.02,
                    yPos + cellHeight / 2);
            }
            if (desc?.underline) {
                ctx.fillStyle = fg;
                ctx.fillRect(txtX, yPos + cellHeight - 1, txtW, 1);
            }
        };
        drawText(w.title,  y);
        drawText(w.footer, y + hpx - cellHeight);
        ctx.restore();
    }

    /** Overlay fancy radio / checkbox markers on top of the single-cell
     *  ASCII indicator SelectionField.js painted. Each item knows its
     *  absolute (row, col) on screen; the indicator sits at the very
     *  first cell of the item slot (no parens/brackets around it).
     *  We blank that cell and paint a Unicode glyph (●/○/☑/☐) on top. */
    #drawSelectionField (ctx, sel) {
        const s = this.screen;
        if (!sel.drawIndicator || !sel.itemPositions?.length) return;
        const { cellWidth, cellHeight, fontSize } = this.g;

        // Identify the item the cursor is currently on (if any) so we
        // can paint a reverse-video focus highlight over its label —
        // shows which radio / checkbox the keyboard is about to toggle.
        const focused = s.enptuiItemAtCursor?.();
        const focusedIdx = (focused && focused.construct === sel) ? focused.index : -1;

        ctx.save();
        ctx.font = `${fontSize}px ${TERMINAL_FONT}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';

        for (let i = 0; i < sel.items.length; i++) {
            const item = sel.items[i];
            const pos  = sel.itemPositions[i];
            if (!pos || item.dummy) continue;

            const r0 = ((pos.indicatorIdx / s.cols) | 0);
            const c0 = pos.indicatorIdx % s.cols;
            const cellX = c0 * cellWidth;
            const cellY = r0 * cellHeight;
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

            // IBM suppresses the indicator for an unavailable choice,
            // but still renders its label with the unavailable palette.
            if (!item.unavailable) {
                // Clear the raw EBCDIC marker before drawing the Unicode
                // radio/checkbox glyph over the same cell.
                ctx.fillStyle = '#000';
                ctx.fillRect(cellX, cellY, cellWidth, cellHeight);

                const marker = sel.single
                    ? (item.selected ? '●' : '○')
                    : (item.selected ? '☑' : '☐');

                ctx.fillStyle = indDesc ? (COLOR[indDesc.fg] ?? COLOR.green) : COLOR.green;
                ctx.fillText(marker, cellX + cellWidth / 2, cellY + cellHeight / 2);
            }

            // Repaint the label cells with the resolved per-state
            // attribute. We re-render the EBCDIC bytes (already in the
            // screen buffer) using the chosen fg/bg, then drop the
            // mnemonic underline on top.
            if (itemDesc) {
                const textCol = pos.textCol - 1;
                const textX = textCol * cellWidth;
                const textLength = pos.textLength ?? sel.textSize ?? 0;
                const textW = textLength * cellWidth;
                const fg = itemDesc.reverse ? (COLOR[itemDesc.bg] ?? COLOR.black)
                                            : (COLOR[itemDesc.fg] ?? COLOR.green);
                const bg = itemDesc.reverse ? (COLOR[itemDesc.fg] ?? COLOR.green)
                                            : (COLOR[itemDesc.bg] ?? COLOR.black);
                ctx.fillStyle = bg;
                ctx.fillRect(textX, cellY, textW, cellHeight);
                ctx.fillStyle = fg;
                ctx.textAlign = 'left';
                for (let k = 0; k < textLength; k++) {
                    const cIdx = pos.textIdx + k;
                    const cell = s.cells[cIdx];
                    if (!cell) break;
                    ctx.fillText(cell.glyph || ' ',
                        textX + k * cellWidth + cellWidth * 0.02,
                        cellY + cellHeight / 2);
                }
                // Mnemonic underline: highlight the host-designated
                // shortcut character so the user knows which keystroke
                // jumps directly to this item.
                if (item.mnemonicOffset >= 0 && item.mnemonicOffset < textLength) {
                    ctx.fillStyle = fg;
                    ctx.fillRect(
                        textX + item.mnemonicOffset * cellWidth,
                        cellY + cellHeight - 2,
                        cellWidth, 1);
                }
                if (itemDesc.underline) {
                    ctx.fillStyle = fg;
                    ctx.fillRect(textX, cellY + cellHeight - 1, textW, 1);
                }
                ctx.textAlign = 'center';
            }
        }
        ctx.restore();
    }

    #drawMenuBar (ctx, mb) {
        if (!mb.items?.length) return;
        const { cellWidth, cellHeight } = this.g;
        const y = (mb.row - 1) * cellHeight;

        ctx.save();
        const separator = mb.menuSeparator;
        if (separator) {
            const desc = ATTR_BASE[separator.attr];
            ctx.strokeStyle = desc ? (COLOR[desc.fg] ?? COLOR.turquoise) : COLOR.turquoise;
            ctx.lineWidth = 1;
            const lineY = y + (mb.menuRows ?? 1) * cellHeight - 0.5;
            ctx.beginPath();
            ctx.moveTo((separator.startCol - 1) * cellWidth, lineY);
            ctx.lineTo(separator.endCol * cellWidth, lineY);
            ctx.stroke();
        }
        ctx.restore();
    }

    #drawPushButtons (ctx, pb) {
        const s = this.screen;
        if (!pb.itemPositions?.length) return;
        const { cellWidth, cellHeight, fontSize } = this.g;
        const focused = s.enptuiItemAtCursor?.();
        const focusedIdx = (focused && focused.construct === pb) ? focused.index : -1;
        ctx.save();
        ctx.lineWidth = 1;

        // Each button occupies `textSize` cells starting at its
        // itemPosition. We render the frame with stroked lines so the
        // visual matches without forcing a specific glyph set:
        //   - left cap, horizontal rule on top + bottom, right cap.
        // Conventions:
        //   - `isNoPushButtonBox` (flag2 0x04) suppresses the frame.
        //   - Cursor on a button (focused) inverts colours.
        //   - Default button (choiceState 0x40) gets a thicker frame.
        //   - Unavailable button uses the unavailable palette colour.
        for (let i = 0; i < pb.items.length; i++) {
            const item = pb.items[i];
            const pos  = pb.itemPositions[i];
            if (!pos || item.dummy) continue;
            if ((item.flag2 & 0x04) !== 0) continue;     // NoPushBox flag

            const isFocused = (i === focusedIdx);
            const isDefault = item.selected;             // "default" button == pre-selected
            const r = pos.row - 1;
            const c = pos.col - 1;
            const x = c * cellWidth;
            const y = r * cellHeight;
            const textLength = pos.textLength ?? pb.textSize;
            const wpx = textLength * cellWidth;
            const hpx = cellHeight;

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
                ctx.font = `${fontSize}px ${TERMINAL_FONT}`;
                ctx.textBaseline = 'middle';
                ctx.textAlign = 'left';
                for (let k = 0; k < textLength; k++) {
                    const cIdx = pos.textIdx + k;
                    const cell = s.cells[cIdx];
                    if (!cell) break;
                    ctx.fillText(cell.glyph || ' ',
                        x + k * cellWidth + cellWidth * 0.02,
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
        const { cellWidth: cw, cellHeight: ch } = this.g;
        const x = sb.colOffset * cw;
        const y = sb.rowOffset * ch;

        ctx.save();
        ctx.strokeStyle = COLOR.turquoise;
        ctx.fillStyle   = 'rgba(92, 246, 255, 0.18)';
        if (sb.direction === 0) {
            // Vertical
            const length = sb.length * ch;
            ctx.fillRect(x, y, 3 * cw, length);
            ctx.strokeRect(x + cw + 0.5, y + 0.5, cw - 1, length - 1);
            const thumbH = Math.max(ch, (sb.sliderCellSize ?? 1) * ch);
            const thumbY = y + (sb.sliderCellPos ?? 1) * ch;
            ctx.fillStyle = COLOR.turquoise;
            ctx.fillRect(x + cw + 2, thumbY + 2, cw - 4, Math.max(1, thumbH - 4));
        } else {
            // Horizontal
            const length = sb.length * cw;
            ctx.fillRect(x, y, length, ch);
            ctx.strokeRect(x + 0.5, y + 0.5, length - 1, ch - 1);
            const thumbW = Math.max(cw, (sb.sliderCellSize ?? 1) * cw);
            const thumbX = x + (sb.sliderCellPos ?? 1) * cw;
            ctx.fillStyle = COLOR.turquoise;
            ctx.fillRect(thumbX + 2, y + 2, thumbW - 4, ch - 4);
        }
        ctx.restore();
    }
}
