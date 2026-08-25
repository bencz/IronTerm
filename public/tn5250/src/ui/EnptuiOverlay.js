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
        if (!store || (store.visuals.length === 0 && !this.screen.pointerMarker)) return;

        this.g = geometry;
        const visuals = store.visuals;
        for (let index = 0; index < visuals.length; index++) {
            const c = visuals[index];
            let clipDepth = 0;
            const clipped = c.active === false && c.occludedCells?.size > 0;
            if (clipped) {
                this.#clipRetainedPresentation(ctx, c);
                clipDepth++;
            }

            // ENPTUI decorations are painted after the terminal character
            // plane. A newer window must therefore mask older borders, grid
            // rules and controls explicitly; merely painting its own frame
            // cannot erase a rule that crosses the window interior.
            const coveringWindows = visuals.slice(index + 1)
                .filter(construct => construct.kind === ConstructKind.WINDOW);
            if (coveringWindows.length > 0) {
                this.#clipBehindWindows(ctx, c, coveringWindows);
                clipDepth++;
            }
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
            while (clipDepth-- > 0) ctx.restore();
        }
        this.#drawPointerMarker(ctx);
    }

    /** Clip an older construct around every newer window. Window creation
     *  replaces the complete rectangular footprint, including graphical
     *  overlays that are not represented by ordinary presentation cells. */
    #clipBehindWindows (ctx, construct, windows) {
        const { cellWidth, cellHeight } = this.g;
        const bounds = this.screen.enptui.boundsOf(construct);
        let visible = [{
            left: Math.max(0, (bounds?.left ?? 1) - 1),
            top: Math.max(0, (bounds?.top ?? 1) - 1),
            right: Math.min(this.screen.cols, bounds?.right ?? this.screen.cols),
            bottom: Math.min(this.screen.rows, bounds?.bottom ?? this.screen.rows),
        }];

        for (const window of windows) {
            const windowBounds = this.screen.enptui.boundsOf(window);
            if (!windowBounds) continue;
            const blockers = [];
            if (window.active !== false || !window.occludedCells?.size) {
                blockers.push({
                    left: windowBounds.left - 1,
                    top: windowBounds.top - 1,
                    right: windowBounds.right,
                    bottom: windowBounds.bottom,
                });
            } else {
                // A removed window retains only the cells that have not yet
                // been replaced by subsequent host output.
                for (let row = windowBounds.top; row <= windowBounds.bottom; row++) {
                    for (let col = windowBounds.left; col <= windowBounds.right; col++) {
                        const address = (row - 1) * this.screen.cols + col - 1;
                        if (window.occludedCells.has(address)) continue;
                        blockers.push({
                            left: col - 1, top: row - 1,
                            right: col, bottom: row,
                        });
                    }
                }
            }
            for (const blocker of blockers) {
                visible = visible.flatMap(rect => this.#subtractRect(rect, blocker));
                if (visible.length === 0) break;
            }
            if (visible.length === 0) break;
        }

        ctx.save();
        ctx.beginPath();
        for (const rect of visible) {
            ctx.rect(rect.left * cellWidth, rect.top * cellHeight,
                (rect.right - rect.left) * cellWidth,
                (rect.bottom - rect.top) * cellHeight);
        }
        ctx.clip();
    }

    /** Return the non-overlapping pieces of `rect` after removing `cut`. */
    #subtractRect (rect, cut) {
        const left = Math.max(rect.left, cut.left);
        const top = Math.max(rect.top, cut.top);
        const right = Math.min(rect.right, cut.right);
        const bottom = Math.min(rect.bottom, cut.bottom);
        if (left >= right || top >= bottom) return [rect];

        const pieces = [];
        if (rect.top < top)
            pieces.push({ ...rect, bottom: top });
        if (bottom < rect.bottom)
            pieces.push({ ...rect, top: bottom });
        if (rect.left < left)
            pieces.push({ left: rect.left, top, right: left, bottom });
        if (right < rect.right)
            pieces.push({ left: right, top, right: rect.right, bottom });
        return pieces;
    }

    /** Retained GUI presentation behaves like ordinary terminal cells:
     *  a later host write replaces only the cells it touches. */
    #clipRetainedPresentation (ctx, construct) {
        const bounds = this.screen.enptui.boundsOf(construct);
        const { cellWidth, cellHeight } = this.g;
        ctx.save();
        ctx.beginPath();
        if (bounds) {
            for (let row = bounds.top; row <= bounds.bottom; row++) {
                for (let col = bounds.left; col <= bounds.right; col++) {
                    const address = (row - 1) * this.screen.cols + col - 1;
                    if (construct.occludedCells.has(address)) continue;
                    ctx.rect((col - 1) * cellWidth, (row - 1) * cellHeight,
                        cellWidth, cellHeight);
                }
            }
        }
        ctx.clip();
    }

    #drawPointerMarker (ctx) {
        const marker = this.screen.pointerMarker;
        if (!marker) return;
        const { cellWidth, cellHeight } = this.g;
        // Pointer coordinates are zero-based. The marker occupies the
        // event cell and its following cell; its three grid strokes are
        // the left cap, horizontal body and right cap of that two-cell box.
        const startCol = Math.max(0, marker.col);
        const widthCells = Math.min(2, this.screen.cols - startCol);
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
        ctx.lineWidth = 1;
        for (let idx = 0; idx < g.gridBuf.length; idx++) {
            const flags = g.gridBuf[idx];
            if (flags === 0) continue;
            const row = (idx / cols) | 0;
            const col = idx % cols;
            const x = col * cw;
            const y = row * ch;
            // Grid graphics live in the same presentation cell as its
            // display attribute. This is what lets one DDS grid use blue
            // box edges and white interior rules, for example; a global
            // overlay colour loses that distinction.
            const desc = this.screen.cells[idx]?.attr;
            // A non-display attribute suppresses the character glyph, not
            // the independent grid edge stored at the same address. Using
            // its background colour here makes valid grid records vanish
            // on the normal black terminal background.
            const foreground = desc?.reverse
                ? (COLOR[desc.bg] ?? COLOR.black)
                : (COLOR[desc?.fg] ?? COLOR.turquoise);
            ctx.strokeStyle = foreground;
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
        const hpx = w.height * cellHeight;

        ctx.save();
        // The decoder already cleared the complete footprint when the window
        // was created. Do not cover it again here: normal 5250 data written
        // into the content area after Create Window must remain visible.
        // Non-display border (host requested zero-visible-frame
        // attribute 0x27/0x2F/0x37/0x3F): skip the frame entirely.
        // Title/footer still renders below.
        if (!w.noBorder) {
            const borderDesc = ATTR_BASE[w.borderAttr];
            const frameColor = borderDesc ? (COLOR[borderDesc.fg] ?? COLOR.turquoise)
                                           : COLOR.turquoise;
            ctx.strokeStyle = frameColor;
            ctx.fillStyle = frameColor;
            ctx.font = `${fontSize}px ${TERMINAL_FONT}`;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';

            // The two outer columns are presentation-attribute cells.
            // The visible frame occupies cells 2..width-1.
            const leftX = x + cellWidth * 1.5;
            const rightX = x + (w.width - 1.5) * cellWidth;
            const topY = y + cellHeight / 2;
            const bottomY = y + hpx - cellHeight / 2;
            // REMOVE_ALL_GUI can request the character fallback of every
            // graphical border. In that form all eight low-byte border
            // characters are repeated explicitly instead of being drawn as
            // canvas rules.
            const overridden = w.basicPresentation
                ? new Array(8).fill(true)
                : (w.borderOverrides ?? []);
            const drawTop = !w.menuPullDown || this.#menuSeparatorSupports(w);
            const glyph = index => this.screen.ebcdic.toChar(w.borders[index]) || ' ';
            const drawGlyph = (index, col, row) => {
                ctx.fillText(glyph(index),
                    x + (col + 0.5) * cellWidth,
                    y + (row + 0.5) * cellHeight);
            };

            ctx.beginPath();
            if (drawTop && !overridden[1]) {
                ctx.moveTo(leftX, topY);
                ctx.lineTo(rightX, topY);
            }
            if (!overridden[6]) {
                ctx.moveTo(leftX, bottomY);
                ctx.lineTo(rightX, bottomY);
            }
            if (!overridden[3]) {
                ctx.moveTo(leftX, topY);
                ctx.lineTo(leftX, bottomY);
            }
            if (!overridden[4]) {
                ctx.moveTo(rightX, topY);
                ctx.lineTo(rightX, bottomY);
            }
            ctx.stroke();

            if (overridden[0]) drawGlyph(0, 1, 0);
            if (drawTop && overridden[1])
                for (let col = 2; col <= w.width - 3; col++) drawGlyph(1, col, 0);
            if (overridden[2]) drawGlyph(2, w.width - 2, 0);
            if (overridden[3])
                for (let row = 1; row <= w.height - 2; row++) drawGlyph(3, 1, row);
            if (overridden[4])
                for (let row = 1; row <= w.height - 2; row++) drawGlyph(4, w.width - 2, row);
            if (overridden[5]) drawGlyph(5, 1, w.height - 1);
            if (overridden[6])
                for (let col = 2; col <= w.width - 3; col++) drawGlyph(6, col, w.height - 1);
            if (overridden[7]) drawGlyph(7, w.width - 2, w.height - 1);
            ctx.setLineDash([]);
        }

        // Title and footer come as { text, attr, align } objects from
        // the Window decoder. Attr is a 5250 attribute byte; resolve it
        // through ATTR_BASE so colour and reverse/underline modifiers
        // match what the host requested.
        const drawText = (info, yPos) => {
            if (!info || !info.text) return;
            // A zero title/footer attribute means that no attribute cell is
            // written before the text.  The characters therefore inherit the
            // window border attribute already active on that row.
            const desc = ATTR_BASE[info.attr || w.borderAttr];
            const fg = desc?.reverse ? (COLOR[desc.bg] ?? COLOR.black)
                                     : (COLOR[desc?.fg] ?? COLOR.white);
            const bg = desc?.reverse ? (COLOR[desc.fg] ?? COLOR.white)
                                     : (COLOR[desc?.bg] ?? COLOR.black);
            ctx.font = `${fontSize}px ${TERMINAL_FONT}`;
            ctx.textBaseline = 'middle';
            const hasAttr = info.attr !== 0;
            const capacity = Math.max(0, w.contentWidth + (hasAttr ? 0 : 2));
            const txt = info.text.slice(0, capacity);
            const txtW = txt.length * cellWidth;
            const offset = info.align === 'center' ? Math.floor((capacity - txt.length) / 2)
                : info.align === 'right' ? capacity - txt.length : 0;
            const txtX = x + (hasAttr ? 3 : 2) * cellWidth + offset * cellWidth;
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

    /** A pull-down window shares its top edge with the menu separator
     *  only when the separator actually reaches the window anchor. */
    #menuSeparatorSupports (window) {
        const anchorCol = window.leftCol + 2;
        for (const menu of this.screen.enptui.visuals) {
            if (menu.kind !== ConstructKind.MENU_BAR || menu.basicPresentation) continue;
            const separator = menu.menuSeparator;
            // A pull-down shares its top edge only with the graphical
            // menu-line character. A host-supplied ordinary character is
            // still a separator visually, but it has no graphical line
            // identity and therefore cannot replace the window top rule.
            if (!separator || !this.#isGraphicalMenuSeparator(separator)) continue;
            const separatorRow = menu.row + (menu.menuRows ?? 1);
            if (separatorRow !== window.topRow
                || anchorCol < separator.startCol
                || anchorCol > separator.endCol) continue;
            // Removing a menu keeps its presentation until later output
            // replaces the relevant cell. That retained graphical line can
            // still support a subsequently created pull-down.
            const address = (separatorRow - 1) * this.screen.cols + anchorCol - 1;
            if (!menu.occludedCells?.has(address)) return true;
        }
        return false;
    }

    /** Overlay fancy radio / checkbox markers on top of the single-cell
     *  ASCII indicator SelectionField.js painted. Each item knows its
     *  absolute (row, col) on screen; the indicator sits at the very
     *  first cell of the item slot (no parens/brackets around it).
     *  We blank that cell and paint a Unicode glyph (●/○/☑/☐) on top. */
    #drawSelectionField (ctx, sel) {
        const s = this.screen;
        if (!sel.itemPositions?.length) return;
        // The presentation buffer already contains the low-byte indicator,
        // text and attributes used after a basic redraw. Painting the rich
        // overlay here would incorrectly turn it back into a GUI construct.
        if (sel.basicPresentation) return;
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

            const r0 = pos.row - 1;
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
            if (sel.drawIndicator && !item.unavailable) {
                const c0 = pos.indicatorIdx % s.cols;
                const cellX = c0 * cellWidth;
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
        // Menu choices use the same cursor/selected/unavailable palettes
        // as other selection fields even though they have no radio or
        // checkbox indicator. Paint their labels before the separator.
        this.#drawSelectionField(ctx, mb);
        const { cellWidth, cellHeight } = this.g;
        const y = (mb.row - 1) * cellHeight;

        ctx.save();
        const separator = mb.menuSeparator;
        if (separator) {
            const suppressAttribute = separator.suppressAttribute;
            const row = (mb.row - 1) + (mb.menuRows ?? 1);
            const inheritedCell = this.screen.cells[
                row * this.screen.cols + Math.max(0, separator.startCol - 1)];
            const desc = suppressAttribute
                ? inheritedCell?.attr
                : ATTR_BASE[separator.attr];
            const fg = desc ? (COLOR[desc.fg] ?? COLOR.turquoise) : COLOR.turquoise;
            const rowY = y + (mb.menuRows ?? 1) * cellHeight;
            // Unless SuppressAttr is set, the end cells are attribute
            // places and the visible separator occupies only the cells
            // between them.
            const firstVisible = separator.startCol + (suppressAttribute ? 0 : 1);
            const lastVisible = separator.endCol - (suppressAttribute ? 0 : 1);
            if (lastVisible < firstVisible) {
                ctx.restore();
                return;
            }
            if (!this.#isGraphicalMenuSeparator(separator) || mb.basicPresentation) {
                const glyph = this.screen.ebcdic.toChar(separator.char) || ' ';
                ctx.fillStyle = fg;
                ctx.textAlign = 'center';
                for (let col = firstVisible; col <= lastVisible; col++) {
                    ctx.fillText(glyph,
                        (col - 0.5) * cellWidth,
                        rowY + cellHeight / 2);
                }
            } else {
                ctx.strokeStyle = fg;
                ctx.lineWidth = 1;
                // The graphical separator occupies the centre stroke of
                // its presentation row. A menu pull-down uses that same
                // coordinate for its top border; drawing at the cell's
                // bottom would cut through the first pull-down choice.
                const lineY = rowY + cellHeight / 2;
                ctx.beginPath();
                ctx.moveTo((firstVisible - 1) * cellWidth, lineY);
                ctx.lineTo(lastVisible * cellWidth, lineY);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    /** Menu-line codes are graphical glyphs, not ordinary EBCDIC text.
     *  Their low byte overlaps common vertical-bar/bracket variants, but
     *  the retained graphical presentation is one continuous rule. */
    #isGraphicalMenuSeparator (separator) {
        return !separator.customCharacter
            || separator.char === 0x4F
            || separator.char === 0xBB;
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
        //   - Cursor and unavailable states use the corresponding host
        //     Choice Attributes palette entries.
        //   - Unavailable button uses the unavailable palette colour.
        for (let i = 0; i < pb.items.length; i++) {
            const item = pb.items[i];
            const pos  = pb.itemPositions[i];
            if (!pos || item.dummy) continue;

            const isFocused = (i === focusedIdx);
            const r = pos.row - 1;
            const c = pos.col - 1;
            const x = c * cellWidth;
            const y = r * cellHeight;
            const textLength = pos.textLength ?? pb.textSize;
            const wpx = textLength * cellWidth;
            const hpx = cellHeight;

            // A push button's selected/default state is returned to the
            // host, but does not select a different text palette. Focus
            // and availability do.
            const attrByte = item.unavailable
                ? pb.choiceAttrs[isFocused
                    ? AttrIndex.CUR_UNAVAILABLE : AttrIndex.UNAVAILABLE]
                : pb.choiceAttrs[isFocused
                    ? AttrIndex.CUR_AVAILABLE : AttrIndex.AVAILABLE];
            const desc = ATTR_BASE[attrByte];
            const fg = desc?.reverse ? (COLOR[desc.bg] ?? COLOR.black)
                                     : (COLOR[desc?.fg] ?? COLOR.turquoise);
            const bg = desc?.reverse ? (COLOR[desc.fg] ?? COLOR.turquoise)
                                     : (COLOR[desc?.bg] ?? COLOR.black);
            const frameColor = fg;
            ctx.strokeStyle = frameColor;
            ctx.lineWidth = 1;

            // Repaint the complete label so cursor-specific attributes
            // work even when they are not a conventional reverse-video
            // pair. NoPushBox suppresses only the frame, not this label.
            ctx.fillStyle = bg;
            ctx.fillRect(x, y, wpx, hpx);
            ctx.fillStyle = fg;
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
            if (item.mnemonicOffset >= 0 && item.mnemonicOffset < textLength)
                ctx.fillRect(x + item.mnemonicOffset * cellWidth,
                    y + hpx - 2, cellWidth, 1);
            if (desc?.underline) ctx.fillRect(x, y + hpx - 1, wpx, 1);

            // Removing a push-button construct keeps its last text in the
            // presentation space, but removes the graphical button frame.
            if (pb.active === false || (item.flag2 & 0x04) !== 0) continue;

            // Draw caps + rule. The 3D look comes from horizontal lines
            // 1 px from top/bottom plus side caps.
            ctx.beginPath();
            ctx.moveTo(x, y + 0.5);                ctx.lineTo(x + wpx, y + 0.5);
            ctx.moveTo(x, y + hpx - 0.5);          ctx.lineTo(x + wpx, y + hpx - 0.5);
            ctx.moveTo(x + 0.5, y);                ctx.lineTo(x + 0.5, y + hpx);
            ctx.moveTo(x + wpx - 0.5, y);          ctx.lineTo(x + wpx - 0.5, y + hpx);
            ctx.stroke();
        }
        ctx.restore();
    }

    #drawScrollBar (ctx, sb) {
        const { cellWidth: cw, cellHeight: ch } = this.g;
        const vertical = sb.direction === 0;
        // A vertical bar owns three presentation-space columns because
        // attributes sit on either side of it, but only the centre column
        // is visible. Horizontal bars likewise reserve an attribute cell
        // at each end, leaving `length - 2` visible cells.
        const x = (sb.colOffset + 1) * cw;
        const y = sb.rowOffset * ch;
        const visibleCells = vertical ? sb.length : Math.max(1, sb.length - 2);
        const width = vertical ? cw : visibleCells * cw;
        const height = vertical ? visibleCells * ch : ch;
        const arrowSpan = vertical ? ch : cw;

        ctx.save();
        ctx.fillStyle = COLOR.black;
        ctx.fillRect(x, y, width, height);
        ctx.strokeStyle = COLOR.turquoise;
        ctx.fillStyle = COLOR.turquoise;
        ctx.lineWidth = 1;

        const sliderCells = Math.max(1, sb.sliderCellSize ?? 1);
        const sliderPos = Math.max(1, sb.sliderCellPos ?? 1);
        if (vertical) {
            // The visible column contains one outlined terminal shaft.
            // Its arrow caps are square subdivisions of that shaft; the
            // control does not occupy the two neighbouring attribute cells.
            const railWidth = Math.max(5, Math.min(cw - 2, Math.round(cw * 0.75)));
            const railX = x + (width - railWidth) / 2;
            const cap = Math.min(ch, railWidth);
            ctx.strokeRect(railX + 0.5, y + 0.5,
                Math.max(1, railWidth - 1), Math.max(1, height - 1));
            ctx.beginPath();
            ctx.moveTo(railX, y + cap + 0.5);
            ctx.lineTo(railX + railWidth, y + cap + 0.5);
            ctx.moveTo(railX, y + height - cap - 0.5);
            ctx.lineTo(railX + railWidth, y + height - cap - 0.5);
            ctx.stroke();
            const thumbTop = Math.min(height - arrowSpan,
                Math.max(arrowSpan, sliderPos * ch));
            const thumbBottom = Math.min(height - arrowSpan,
                thumbTop + sliderCells * ch);
            ctx.fillStyle = COLOR.turquoise;
            ctx.fillRect(railX + 2, y + thumbTop,
                Math.max(1, railWidth - 4), Math.max(1, thumbBottom - thumbTop));
            ctx.strokeStyle = COLOR.turquoise;
            this.#drawScrollArrow(ctx, railX, y, railWidth, cap, true, true);
            this.#drawScrollArrow(ctx, railX, y + height - cap,
                railWidth, cap, true, false);
        } else {
            const railHeight = Math.max(5, Math.min(ch - 2, Math.round(ch * 0.65)));
            const railY = y + (height - railHeight) / 2;
            const cap = Math.min(cw, railHeight);
            ctx.strokeRect(x + 0.5, railY + 0.5,
                Math.max(1, width - 1), Math.max(1, railHeight - 1));
            ctx.beginPath();
            ctx.moveTo(x + cap + 0.5, railY);
            ctx.lineTo(x + cap + 0.5, railY + railHeight);
            ctx.moveTo(x + width - cap - 0.5, railY);
            ctx.lineTo(x + width - cap - 0.5, railY + railHeight);
            ctx.stroke();
            const thumbLeft = Math.min(width - arrowSpan,
                Math.max(arrowSpan, sliderPos * cw));
            const thumbRight = Math.min(width - arrowSpan,
                thumbLeft + sliderCells * cw);
            ctx.fillStyle = COLOR.turquoise;
            ctx.fillRect(x + thumbLeft, railY + 2,
                Math.max(1, thumbRight - thumbLeft), Math.max(1, railHeight - 4));
            ctx.strokeStyle = COLOR.turquoise;
            this.#drawScrollArrow(ctx, x, railY, cap, railHeight, false, true);
            this.#drawScrollArrow(ctx, x + width - cap, railY,
                cap, railHeight, false, false);
        }
        ctx.restore();
    }

    #drawScrollArrow (ctx, x, y, width, height, vertical, decrement) {
        const cx = x + width / 2;
        const cy = y + height / 2;
        const dx = Math.max(2, width * 0.22);
        const dy = Math.max(2, height * 0.18);
        ctx.beginPath();
        if (vertical) {
            const sign = decrement ? 1 : -1;
            ctx.moveTo(cx - dx, cy + sign * dy);
            ctx.lineTo(cx, cy - sign * dy);
            ctx.lineTo(cx + dx, cy + sign * dy);
        } else {
            const sign = decrement ? 1 : -1;
            ctx.moveTo(cx + sign * dx, cy - dy);
            ctx.lineTo(cx - sign * dx, cy);
            ctx.lineTo(cx + sign * dx, cy + dy);
        }
        ctx.stroke();
    }
}
