// Write-to-Display Structured Field decoder for ENPTUI segments.
//
// Called from InboundParser when it sees a WTDSF order (0x15) inside a
// regular WTD command. A single WTDSF body can contain ONE OR MORE
// concatenated ENPTUI segments, each with its own length header.
//
// Segment layout:
//
//     +0  +1  segment length (big-endian, includes itself)
//     +2  class (0xD9 = ENPTUI; anything else = unknown, skip)
//     +3  minor type (see ./Constants.js Sf.*)
//     +4..n  type-specific payload
//
// This module decodes the wrapper and dispatches to the appropriate
// primitive parser. Each primitive returns a small JS object that gets
// stored on `screen.enptui` for later use by the renderer / input layer.
//
// Malformed or unknown ENPTUI structures are protocol errors. The decoder
// therefore stops the WTDSF and retains IBM's 32-bit sense code so the
// terminal can return a negative response instead of desynchronising.

import { ENPTUI_CLASS, Sf, ConstructKind, SenseCode } from './Constants.js';
import { decodeSelectionField, buildAttachedScrollBar,
    refreshSelectionPresentation } from './primitives/SelectionField.js';
import { decodeWindow }         from './primitives/Window.js';
import { decodeScrollBar }      from './primitives/ScrollBar.js';
import { EnptuiDataStreamError, enptuiFail as fail } from './DataStreamError.js';

export { EnptuiDataStreamError };

// Grid construct-type values per the ENPTUI architecture document:
const GRID_UPPER_H   = 0;
const GRID_LOWER_H   = 1;
const GRID_LEFT_V    = 2;
const GRID_RIGHT_V   = 3;
const GRID_PLAIN_BOX = 4;
const GRID_H_RULED   = 5;
const GRID_V_RULED   = 6;
const GRID_HV_RULED  = 7;

// Per-cell bit flags in the grid buffer.
const G_LOWER_H = 0x01;
const G_RIGHT_V = 0x02;
const G_UPPER_H = 0x04;
const G_LEFT_V  = 0x08;

/** Apply a single grid minor record to the buffer. Walks the affected
 *  rectangle (rec.width × rec.height cells starting at rec.startRow/
 *  startCol) and ORs in the appropriate bit flags. `repeat1` / `repeat2`
 *  control rule spacing/repetition according to the construct type. */
function applyGridMinor (grid, screen, rec) {
    // In the grid minor options, 0x80 means remove the named edges;
    // an unset bit means draw them. This polarity is intentionally the
    // reverse of the major pre-flag that clears the complete buffer.
    const clear = (rec.hvOptions & 0x80) !== 0;
    const op = (row, col, mask) => {
        if (row < 0 || row >= screen.rows || col < 0 || col >= screen.cols) return;
        const idx = row * screen.cols + col;
        grid[idx] = clear ? (grid[idx] & ~mask) : (grid[idx] | mask);
    };
    const r0 = rec.startRow - 1;
    const c0 = rec.startCol - 1;
    if (r0 < 0 || c0 < 0 || r0 >= screen.rows || c0 >= screen.cols) return false;

    if (rec.constructType === GRID_UPPER_H || rec.constructType === GRID_LOWER_H) {
        if (rec.width < 1 || c0 + rec.width > screen.cols) return false;
        const mask = rec.constructType === GRID_UPPER_H ? G_UPPER_H : G_LOWER_H;
        const count = Math.max(1, rec.repeat1);
        const spacing = rec.hasRepeat2 ? rec.repeat2 : 1;
        if (count > 1 && spacing < 1) return false;
        for (let n = 0; n < count; n++)
            for (let c = 0; c < rec.width; c++) op(r0 + n * spacing, c0 + c, mask);
        return true;
    }

    if (rec.constructType === GRID_LEFT_V || rec.constructType === GRID_RIGHT_V) {
        if (rec.height < 1 || r0 + rec.height > screen.rows) return false;
        const mask = rec.constructType === GRID_LEFT_V ? G_LEFT_V : G_RIGHT_V;
        const count = Math.max(1, rec.repeat1);
        const spacing = rec.hasRepeat2 ? rec.repeat2 : 1;
        if (count > 1 && spacing < 1) return false;
        for (let n = 0; n < count; n++)
            for (let r = 0; r < rec.height; r++) op(r0 + r, c0 + n * spacing, mask);
        return true;
    }

    if (rec.constructType < GRID_PLAIN_BOX || rec.constructType > GRID_HV_RULED
        || rec.width < 1 || rec.height < 1
        || r0 + rec.height > screen.rows || c0 + rec.width > screen.cols) return false;
    for (let c = 0; c < rec.width; c++) {
        op(r0, c0 + c, G_UPPER_H);
        op(r0 + rec.height - 1, c0 + c, G_LOWER_H);
    }
    for (let r = 0; r < rec.height; r++) {
        op(r0 + r, c0, G_LEFT_V);
        op(r0 + r, c0 + rec.width - 1, G_RIGHT_V);
    }
    if (rec.constructType === GRID_H_RULED || rec.constructType === GRID_HV_RULED) {
        if (rec.repeat1 < 1) return false;
        for (let r = rec.repeat1; r < rec.height; r += rec.repeat1)
            for (let c = 0; c < rec.width; c++) op(r0 + r, c0 + c, G_UPPER_H);
    }
    if (rec.constructType === GRID_V_RULED || rec.constructType === GRID_HV_RULED) {
        if (rec.repeat2 < 1) return false;
        for (let c = rec.repeat2; c < rec.width; c += rec.repeat2)
            for (let r = 0; r < rec.height; r++) op(r0 + r, c0 + c, G_LEFT_V);
    }
    return true;
}

function validateGridMinor (rec, screen) {
    const { constructType: type, startRow: row, startCol: col, width, height } = rec;
    if (type < GRID_UPPER_H || type > GRID_HV_RULED) return SenseCode.GRID_CONSTR;
    if (row < 1 || row > screen.rows || col < 1 || col > screen.cols)
        return SenseCode.GRID_OFFSET;
    if (type !== GRID_LEFT_V && type !== GRID_RIGHT_V
        && (width < 1 || col + width - 1 > screen.cols)) return SenseCode.GRID_OFFSET;
    if (type !== GRID_UPPER_H && type !== GRID_LOWER_H
        && (height < 1 || row + height - 1 > screen.rows)) return SenseCode.GRID_OFFSET;

    if (type === GRID_UPPER_H || type === GRID_LOWER_H) {
        const count = Math.max(1, rec.repeat1);
        const spacing = rec.hasRepeat2 ? rec.repeat2 : 1;
        if (count > 1 && spacing < 1) return SenseCode.GRID_HVOPT;
        if (row + (count - 1) * spacing > screen.rows) return SenseCode.GRID_OFFSET;
    } else if (type === GRID_LEFT_V || type === GRID_RIGHT_V) {
        const count = Math.max(1, rec.repeat1);
        const spacing = rec.hasRepeat2 ? rec.repeat2 : 1;
        if (count > 1 && spacing < 1) return SenseCode.GRID_HVOPT;
        if (col + (count - 1) * spacing > screen.cols) return SenseCode.GRID_OFFSET;
    } else {
        if ((type === GRID_H_RULED || type === GRID_HV_RULED)
            && (rec.repeat1 < 1 || rec.repeat1 > height)) return SenseCode.GRID_HVOPT;
        if ((type === GRID_V_RULED || type === GRID_HV_RULED)
            && (rec.repeat2 < 1 || rec.repeat2 > width)) return SenseCode.GRID_HVOPT;
    }
    return 0;
}

function equivalentSelectionField (left, right) {
    return left.kind === right.kind
        && left.cursorAtStart === right.cursorAtStart
        && left.textSize === right.textSize
        && left.numOfRows === right.numOfRows
        && left.numOfCols === right.numOfCols
        && left.numOfNulls === right.numOfNulls
        && left.scrollAttached === right.scrollAttached;
}

function equivalentScrollBar (left, right) {
    return left.kind === ConstructKind.SCROLL_BAR
        && right.kind === ConstructKind.SCROLL_BAR
        && left.cursorAtStart === right.cursorAtStart
        && left.length === right.length
        && left.direction === right.direction;
}

/**
 * @param {Uint8Array} bytes        full WTDSF body (segments back-to-back)
 * @param {object}     screen       ScreenBuffer instance, used both for
 *                                  read (write address when a segment
 *                                  is "at current SBA") and write (push
 *                                  decoded constructs onto screen.enptui).
 */
export function decodeWdsf (bytes, screen) {
    let pos = 0;
    while (pos < bytes.length) {
        if (pos + 4 > bytes.length)
            fail(`truncated ENPTUI segment at offset ${pos}`, SenseCode.PREMATURE_DS_TERMINATION);
        const len   = (bytes[pos] << 8) | bytes[pos + 1];
        const cls   =  bytes[pos + 2];
        const minor =  bytes[pos + 3];
        if (len < 4) {
            fail(`ENPTUI segment too short (len=${len}) at offset ${pos}`, SenseCode.MAJOR_LEN_ERROR);
        }
        if (pos + len > bytes.length) {
            fail(`ENPTUI segment length ${len} exceeds remaining WTDSF data`, SenseCode.PREMATURE_DS_TERMINATION);
        }
        const end     = pos + len;
        const payload = bytes.subarray(pos + 4, end);

        if (cls !== ENPTUI_CLASS) {
            fail(`invalid ENPTUI class 0x${cls.toString(16)}`, SenseCode.WSF_CLASS_TYPE);
        }

        dispatch(minor, payload, screen);
        pos = end;
    }
}

function dispatch (minor, payload, screen) {
    switch (minor) {
        case Sf.DEFINE_SEL_FLD: {
            const sf = decodeSelectionField(payload, screen);
            if (!sf) fail('invalid ENPTUI selection field', SenseCode.WSF_PARM);
            // SBA is only the anchor, not the complete identity. A smaller
            // construct may legitimately be defined over an older one at the
            // same address. Replace only an equivalent pseudo-field; normal
            // rectangle coverage below handles a new field that fully hides
            // an older construct.
            const equivalent = screen.enptui.all.find(c =>
                equivalentSelectionField(sf, c));
            // A menu refresh is allowed to omit Draw Menu Bar. In that form
            // the separator presentation is inherited from the equivalent
            // menu already on the presentation space.
            if (sf.kind === ConstructKind.MENU_BAR
                && !sf.menuSeparator && equivalent?.menuSeparator) {
                sf.menuSeparator = structuredClone(equivalent.menuSeparator);
                sf.boundsWidth = sf.menuSeparator.endCol - sf.menuSeparator.startCol + 1;
            }
            const prior = equivalent
                ? screen.enptui.removeWhere(c => c === equivalent)
                : [];
            const removed = [...new Set([
                ...prior, ...screen.enptui.removeCoveredBy(sf),
            ])];
            for (const parent of [...removed])
                removed.push(...screen.enptui.removeChildrenLinkedTo(parent));
            sf.formatOrder = screen.allocateFormatOrder();
            screen.enptui.add(sf);
            // When the SF carries an attached scroll bar, create it
            // as a separate construct linked to its parent so
            // REMOVE_GUI_SEL_FLD cascades correctly and the user
            // can drag/click the scroll thumb independently.
            const attached = buildAttachedScrollBar(sf);
            if (attached) {
                attached.formatOrder = screen.allocateFormatOrder();
                screen.enptui.add(attached);
            }
            refreshSelectionPresentation(screen, removed);
            return;
        }
        case Sf.CREATE_WINDOW: {
            const w = decodeWindow(payload, screen);
            if (!w) fail('invalid ENPTUI window', SenseCode.WSF_PARM);
            // Creating a window clears field constructs fully covered by
            // its rectangle. Remove attached children as part
            // of the same graph operation before the new window is drawn.
            const covered = screen.enptui.removeCoveredBy(w);
            const removed = [...covered];
            for (const parent of removed)
                removed.push(...screen.enptui.removeChildrenLinkedTo(parent));
            for (const oldWindow of covered.filter(c => c.kind === ConstructKind.WINDOW))
                removed.push(...screen.enptui.removeChildrenOf(oldWindow));

            // Window creation replaces its complete presentation-space
            // footprint. Subsequent ordinary writes inside the content
            // area remain visible; the renderer therefore draws only the
            // window decoration, not an opaque cover on every frame.
            screen.clearPresentationRect(
                w.topRow, w.leftCol, w.height, w.width);
            screen.enptui.add(w);
            screen.currentEnptuiWindowAddress = w.cursorAtStart;
            refreshSelectionPresentation(screen, removed);
            // IBM clears any pre-existing grid edges covered by the new
            // window; otherwise rules bleed through its background.
            for (const grid of screen.enptui.constructs.filter(c => c.kind === ConstructKind.GRID)) {
                for (let row = w.topRow - 1; row < w.topRow - 1 + w.height; row++) {
                    for (let col = w.leftCol - 1; col < w.leftCol - 1 + w.width; col++)
                        grid.gridBuf[row * screen.cols + col] = 0;
                }
            }
            return;
        }
        case Sf.SCROLL_BAR_FLD: {
            const sb = decodeScrollBar(payload, screen);
            if (!sb) fail('invalid ENPTUI scroll bar', SenseCode.WSF_PARM);
            const equivalent = screen.enptui.all.find(c => equivalentScrollBar(sb, c));
            const prior = equivalent
                ? screen.enptui.removeWhere(c => c === equivalent)
                : [];
            const removedConstructs = [...new Set([
                ...prior, ...screen.enptui.removeCoveredBy(sb),
            ])];
            for (const removed of [...removedConstructs]) {
                if (removed.parent) removed.parent.attachedScrollBar = null;
                removedConstructs.push(...screen.enptui.removeChildrenLinkedTo(removed));
            }
            sb.formatOrder = screen.allocateFormatOrder();
            screen.enptui.add(sb);
            refreshSelectionPresentation(screen, removedConstructs);
            return;
        }
        case Sf.UNREST_WIN_CURSOR: {
            // Lets the cursor leave the current window's interior. The
            // host emits this once after CreateWindow when it wants to
            // relax the restriction (e.g. a pull-down menu over a list).
            // We flip the `cursorRestricted` flag on the matching window
            // so InputController's arrow-key clamp lets through.
            if (payload.length !== 2) fail('invalid Unrestrict Window length', SenseCode.MAJOR_LEN_ERROR);
            const win = screen.enptui.all.findLast(c =>
                c.kind === ConstructKind.WINDOW
                && c.cursorAtStart === screen.currentEnptuiWindowAddress);
            if (win) win.cursorRestricted = false;
            return;
        }
        case Sf.WRITE_DATA: {
            // Two field-write modes per the IBM implementation:
            //   flag1 bit 0x40 = CCSID-based Unicode write into the
            //     5250 field that owns the current SBA. Payload: flag1,
            //     flag2, ccsidHi, ccsidLo, then up to (field.length * 2)
            //     bytes (UTF-16BE or similar).
            //   flag1 bit 0x80 = standard EBCDIC write into the 5250
            //     field. Payload: flag1, reserved, bytes.
            if (payload.length < 2) fail('invalid Write Data length', SenseCode.MAJOR_LEN_ERROR);
            const flag1 = payload[0];

            if ((flag1 & 0xC0) !== 0) {
                // The current SBA must address the first data position of
                // a formatted field. `Field.start` is the non-display SF
                // attribute cell in ScreenBuffer, so looking it up by an
                // exact start match is one position too early.
                const physicalField = screen.fieldAt(screen.writeAddress);
                const field = physicalField
                    && screen.writeAddress === (physicalField.start + 1) % screen.size
                    ? physicalField
                    : null;
                const clearTargets = targets => {
                    for (const target of targets) {
                        for (let k = 0; k < target.length; k++) {
                            const idx = (target.start + 1 + k) % screen.size;
                            screen.enptui.occludeInactiveAt(idx, screen.cols);
                            const cell = screen.cells[idx];
                            cell.byte = 0;
                            cell.glyph = ' ';
                        }
                    }
                };
                if (flag1 & 0x40) {
                    // CCSID-based write. Decode UTF-16BE code units into
                    // the presentation model while retaining an SBCS
                    // fallback byte for ordinary terminal operations.
                    // payload: [0]=flag1 [1]=flag2 [2..3]=ccsid [4..]=data
                    const ccsid = payload.length >= 4 ? (payload[2] << 8) | payload[3] : -1;
                    if (![1200, 13488, 17584].includes(ccsid)) {
                        fail(`unsupported WRITE_DATA CCSID ${ccsid}`, SenseCode.WRITE_DATA_CCSID_ERROR);
                    }
                    const data = payload.subarray(4);
                    if (payload.length < 4 || data.length % 2 !== 0)
                        fail('invalid CCSID WRITE_DATA payload', SenseCode.WRITE_DATA_ERROR);
                    const targets = field ? screen.fieldChain(field) : [];
                    const positions = [];
                    for (const target of targets) {
                        for (let k = 0; k < Math.floor(target.length / 2); k++)
                            positions.push((target.start + 1 + k) % screen.size);
                    }
                    if (field && data.length / 2 > positions.length)
                        fail('CCSID WRITE_DATA exceeds target field', SenseCode.WRITE_DATA_TOO_LONG);
                    const modified = targets.map(target => target.modified);
                    if (field) clearTargets(targets);
                    for (let i = 0, k = 0; i + 1 < data.length; i += 2, k++) {
                        const cp = (data[i] << 8) | data[i + 1];
                        const idx = field
                            ? positions[k]
                            : (screen.writeAddress + k) % screen.size;
                        screen.enptui.occludeInactiveAt(idx, screen.cols);
                        const cell = screen.cells[idx];
                        cell.byte = screen.ebcdic.fromCharCode(cp);
                        cell.glyph = String.fromCharCode(cp);
                        cell.attributePlace = false;
                        cell.startField = false;
                    }
                    targets.forEach((target, i) => { target.modified = modified[i]; });
                    if (!field)
                        screen.setWriteAddressIndex(
                            (screen.writeAddress + data.length / 2) % screen.size);
                } else {
                    // Standard EBCDIC write. Payload: flag1, reserved,
                    // then data bytes. Continued-field segments form one
                    // logical target and are filled in segment order.
                    if (!field)
                        fail('WRITE_DATA at SBA with no field present', SenseCode.WRITE_DATA_ERROR);
                    const data = payload.subarray(2);
                    const targets = screen.fieldChain(field);
                    const capacity = targets.reduce((sum, target) => sum + target.length, 0);
                    if (data.length > capacity)
                        fail('WRITE_DATA exceeds target field', SenseCode.WRITE_DATA_TOO_LONG);
                    const modified = targets.map(target => target.modified);
                    clearTargets(targets);
                    let source = 0;
                    for (const target of targets) {
                        for (let k = 0; k < target.length && source < data.length; k++, source++) {
                            const idx = (target.start + 1 + k) % screen.size;
                            screen.enptui.occludeInactiveAt(idx, screen.cols);
                            const cell = screen.cells[idx];
                            cell.byte = data[source];
                            cell.glyph = screen.ebcdic.toChar(data[source]);
                        }
                    }
                    targets.forEach((target, i) => { target.modified = modified[i]; });
                    screen.applyWordWrap(field, (targets[0].start + 1) % screen.size);
                }
                return;
            }

            fail(`WRITE_DATA missing field-write flag 0x${flag1.toString(16)}`, SenseCode.WRITE_DATA_ERROR);
        }
        case Sf.PROG_MOUSE_BUTTON: {
            // Three reserved bytes are followed by 4-byte definitions:
            // flags, first pointer event, optional second event, AID.
            if (payload.length === 3) {
                screen.enptui.removeWhere(c => c.kind === ConstructKind.MOUSE_EVENTS);
                screen.queuedPointerAid = null;
                screen.pointerMarker = null;
                return; // IBM clear definition
            }
            if (payload.length < 7 || (payload.length - 3) % 4 !== 0)
                fail('invalid programmable mouse-button length', SenseCode.MAJOR_LEN_ERROR);
            // Definitions are incremental. A later segment replaces only
            // entries with the same first event; the three-byte form is
            // the operation that explicitly clears the complete table.
            const existing = screen.enptui.all.find(
                c => c.kind === ConstructKind.MOUSE_EVENTS)?.definitions ?? [];
            const definitionsByEvent = new Map(
                existing.map(definition => [definition.firstEvent, definition]));
            for (let pos = 3; pos < payload.length; pos += 4) {
                const flags = payload[pos];
                const firstEvent = payload[pos + 1];
                const secondEvent = (flags & 0x80) ? payload[pos + 2] : 0;
                if (firstEvent < 1 || firstEvent > 18
                    || (secondEvent !== 0 && (secondEvent < 1 || secondEvent > 18)))
                    fail('invalid programmable mouse pointer event', SenseCode.WSF_PARM);
                definitionsByEvent.set(firstEvent, {
                    flags,
                    firstEvent,
                    secondEvent,
                    aidCode: payload[pos + 3],
                });
            }
            const definitions = [...definitionsByEvent.values()];
            screen.enptui.removeWhere(c => c.kind === ConstructKind.MOUSE_EVENTS);
            screen.pointerMarker = null;
            screen.enptui.add({ kind: ConstructKind.MOUSE_EVENTS, cursorAtStart: -1, definitions });
            return;
        }
        case Sf.REMOVE_GUI_SEL_FLD: {
            if (payload.length !== 2) fail('invalid Remove Selection Field length', SenseCode.MAJOR_LEN_ERROR);
            // Remove the selection field / menu bar / push buttons at
            // the current SBA, AND any attached scroll bar that referenced
            // it as parent. The ENPTUI clear-construct path does
            // the same cascade so the user doesn't see a phantom
            // scrollbar after its list disappears.
            const parent = screen.enptui.inactivateFirst(construct =>
                construct.cursorAtStart === screen.writeAddress
                && [ConstructKind.SELECTION_FIELD, ConstructKind.MENU_BAR,
                    ConstructKind.PUSH_BUTTONS].includes(construct.kind));
            if (parent) screen.enptui.inactivateChildrenLinkedTo(parent);
            // Removing the GUI field removes its interaction/decoration,
            // but Choice Text already written to the presentation space
            // remains until the host overwrites it.
            return;
        }
        case Sf.REMOVE_GUI_WINDOW: {
            if (payload.length !== 3) fail('invalid Remove Window length', SenseCode.MAJOR_LEN_ERROR);
            // Cascade: every selection field or scroll bar that lay
            // entirely inside the window goes away too.
            const menuPullDown = (payload[0] & 0x40) !== 0;
            const currentWindow = screen.enptui.all.findLast(c =>
                c.kind === ConstructKind.WINDOW
                && c.cursorAtStart === screen.currentEnptuiWindowAddress);
            const removedWindow = screen.enptui.inactivateFirst(c =>
                c.kind === ConstructKind.WINDOW && c.cursorAtStart === screen.writeAddress
                && c.menuPullDown === menuPullDown);
            if (removedWindow) {
                const w = removedWindow;
                const bounds = screen.enptui.boundsOf(w);
                screen.enptui.inactivateWhere(construct => {
                    if (![ConstructKind.SELECTION_FIELD, ConstructKind.MENU_BAR,
                        ConstructKind.PUSH_BUTTONS, ConstructKind.SCROLL_BAR].includes(construct.kind))
                        return false;
                    const child = screen.enptui.boundsOf(construct);
                    return child && bounds
                        && child.top >= bounds.top && child.left >= bounds.left
                        && child.bottom <= bounds.bottom && child.right <= bounds.right;
                });
            }
            if (removedWindow === currentWindow)
                screen.currentEnptuiWindowAddress = null;
            return;
        }
        case Sf.REMOVE_SCROLL_BAR_FLD:
            if (payload.length !== 2) fail('invalid Remove Scroll Bar length', SenseCode.MAJOR_LEN_ERROR);
            screen.enptui.inactivateFirst(construct =>
                construct.cursorAtStart === screen.writeAddress
                && construct.kind === ConstructKind.SCROLL_BAR);
            return;
        case Sf.REMOVE_ALL_GUI: {
            if (payload.length !== 3) fail('invalid Remove All GUI length', SenseCode.MAJOR_LEN_ERROR);
            const guiKinds = [ConstructKind.WINDOW, ConstructKind.SELECTION_FIELD,
                ConstructKind.MENU_BAR, ConstructKind.PUSH_BUTTONS, ConstructKind.SCROLL_BAR];
            const redrawBasicPresentation = (payload[1] & 0x80) !== 0;
            const removed = screen.enptui.inactivateWhere(
                construct => guiKinds.includes(construct.kind));
            // Redraw requests materialise the low-byte character form of
            // graphical constructs before their pseudo-fields disappear.
            // Scroll bars deliberately retain their last graphical image;
            // push-button removal already suppresses its frame in the
            // inactive renderer.
            if (redrawBasicPresentation) {
                for (const construct of removed) {
                    if ([ConstructKind.WINDOW, ConstructKind.SELECTION_FIELD,
                        ConstructKind.MENU_BAR].includes(construct.kind))
                        construct.basicPresentation = true;
                }
            }
            screen.currentEnptuiWindowAddress = null;
            return;
        }
        case Sf.DEFINE_GRID: {
            // Per the ENPTUI grid definition.
            // Major header (after class+minor):
            //   [0] class-check (must be 0x01)
            //   [1] preFlags1 (0x80 = clear all grid first)
            //   [2] reserved
            //   [3] preFlags2 (0x80 = clear grid after applying minors)
            //   [4..6] reserved
            // Followed by zero or more minor records of length 7..11:
            //   [0] minorLen
            //   [1] constructType (0..7 - UPPER_H/LOWER_H/LEFT_V/RIGHT_V/
            //                       PLAIN_BOX/H_RULED/V_RULED/HV_RULED)
            //   [2] hvOptions (0x80 = clear, else set)
            //   [3] startRow (1-based)
            //   [4] startCol (1-based)
            //   [5] width   (columns spanned for H types)
            //   [6] height  (rows    spanned for V types)
            //   [7..8] reserved
            //   [9] repeat1 (if minorLen >= 10: row-repeat for H/HV)
            //   [10] repeat2 (if minorLen >= 11: col-repeat for V/HV)
            if (payload.length < 5) fail('invalid Define Grid length', SenseCode.MAJOR_LEN_ERROR);
            if (payload[0] !== 1) fail('invalid Define Grid class check', SenseCode.WSF_PARM);
            const preFlags1 = payload[1];
            const preFlags2 = payload[3];

            // Grid is stored as a per-cell bit map. Bits per cell:
            //   0x01 = lower horizontal rule on this cell's bottom edge
            //   0x02 = right  vertical   rule on this cell's right edge
            //   0x04 = upper horizontal rule on this cell's top    edge
            //   0x08 = left   vertical   rule on this cell's left  edge
            let grid = (preFlags1 & 0x80)
                ? new Uint8Array(screen.size)              // fresh start
                : (screen.enptui.constructs.find(c => c.kind === 'grid')?.gridBuf ?? new Uint8Array(screen.size));

            // Full lengths 9/10 contain only the five-byte base header
            // (plus an optional trailing reserved byte). Length 11+
            // carries both additional reserved bytes and starts minors
            // at payload offset 7.
            let pos = payload.length < 7 ? payload.length : 7;
            const records = [];
            while (pos + 7 <= payload.length) {
                const minorLen = payload[pos];
                if (minorLen < 7 || minorLen > 11 || pos + minorLen > payload.length)
                    fail('invalid Define Grid minor length', SenseCode.INVALID_MINOR_LENGTH);
                const rec = {
                    constructType: payload[pos + 1],
                    hvOptions:     payload[pos + 2],
                    startRow:      payload[pos + 3],
                    startCol:      payload[pos + 4],
                    width:         payload[pos + 5],
                    height:        payload[pos + 6],
                    repeat1:       minorLen >= 10 ? payload[pos + 9]  : 1,
                    repeat2:       minorLen >= 11 ? payload[pos + 10] : 1,
                    hasRepeat2:    minorLen >= 11,
                };
                const gridSense = validateGridMinor(rec, screen);
                if (gridSense) fail('invalid Define Grid construct', gridSense);
                if (applyGridMinor(grid, screen, rec)) records.push(rec);
                pos += minorLen;
            }
            if (pos !== payload.length)
                fail('truncated Define Grid minor', SenseCode.INVALID_MINOR_LENGTH);
            if (preFlags2 & 0x80) grid = new Uint8Array(screen.size);

            // Replace any existing grid construct at this SBA.
            screen.enptui.removeWhere(c => c.kind === ConstructKind.GRID);
            screen.enptui.add({
                kind:          'grid',
                cursorAtStart: screen.writeAddress,
                gridBuf:       grid,
                records,
            });
            return;
        }
        case Sf.CLEAR_GRID: {
            // The CLEAR_GRID minor clears a rectangle of cells (zeroes the
            // grid buffer at those positions) - it does NOT remove the
            // whole construct. Payload: [0] flag, [1..2] reserved,
            // [3] startRow, [4] startCol, [5] width, [6] height.
            if (payload.length !== 7) fail('invalid Clear Grid length', SenseCode.MAJOR_LEN_ERROR);
            if (payload[0] !== 1) fail('invalid Clear Grid class check', SenseCode.WSF_PARM);
            const grids = screen.enptui.constructs.filter(c => c.kind === 'grid');
            {
                const r0 = payload[3] - 1, c0 = payload[4] - 1;
                const w  = payload[5],     h  = payload[6];
                if (r0 < 0 || c0 < 0 || w < 1 || h < 1
                    || r0 + h > screen.rows || c0 + w > screen.cols)
                    fail('Clear Grid rectangle outside presentation space', SenseCode.GRID_OFFSET);
                for (const g of grids) {
                    if (!g.gridBuf) continue;
                    for (let r = 0; r < h; r++) {
                        for (let c = 0; c < w; c++) {
                            const idx = (r0 + r) * screen.cols + (c0 + c);
                            if (idx >= 0 && idx < g.gridBuf.length) g.gridBuf[idx] = 0;
                        }
                    }
                }
            }
            return;
        }
        default:
            fail(`unknown ENPTUI minor type 0x${minor.toString(16)}`, SenseCode.WSF_CLASS_TYPE);
    }
}
