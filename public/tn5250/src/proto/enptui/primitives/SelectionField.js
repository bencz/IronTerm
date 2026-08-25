// ENPTUI Define Selection Field (minor type 0x50) decoder.
//
// A DefineSelFld segment carries an entire selection construct: depending
// on its sub-type byte it can be a menu bar (0x01), inline radio group
// (0x11), inline checkbox group (0x12), a list inside a window (0x21/22),
// a pull-down (0x31/32), or a row of push buttons (0x41/0x51).
//
// Wire layout (byte offsets are RELATIVE to the segment payload — i.e.
// the byte right after `length+class+minor` was already consumed by
// WdsfDecoder). Verified byte-for-byte against the IBM ENPTUI
// architecture document.
//
//   [ 0] flag1            bit 0 = field MDT, bits 6-7 unused
//   [ 1] flag2            bit 7 (0x80) = scrollbar attached
//   [ 2] flag3
//   [ 3] selectionType    (SelType.* — MENU_BAR, SINGLE_SEL_FLD, etc.)
//   [ 4] guiDeviceChar    high nibble 0 = client should draw indicators
//   [ 5- 8] reserved      (4 bytes)
//   [ 9] textSize         number of EBCDIC cells per item label
//   [10] numOfRows
//   [11] numOfCols
//   [12] numOfNulls       padding cells between columns
//   [13] reserved
//   [14] selectChar       AID byte sent when user toggles (rarely used)
//   [15] cancelAID
//
// If flag2 has bit 0x80 (scrollbar attached), the next 8 bytes carry
// totalRows and sliderPos as two big-endian 32-bit values
// before the first minor structure begins.
//
// Otherwise minor structures begin at offset 16. Each entry is
//     <minorLen 1 byte> <minorType 1 byte> ...
// where minorType = 0x10 = Choice Text, 0x01 = Choice Attributes.
//
// Each Choice Text entry layout (offsets relative to the entry start):
//
//   [0] minorLen           total bytes of this entry (includes itself)
//   [1] minorType (0x10)
//   [2] flag1              bits 6-7 = choiceState
//                          0x40 = selected & enabled
//                          0x00 = unselected & enabled
//                          0x80 / 0xC0 = unavailable
//   [3] flag2
//   [4] flag3              bit 7 set means "regular" entry layout
//   [5+] text              textSize EBCDIC bytes (already space-padded)
//
// Conditional bytes between flag3 and text (only when flag3 high bit set):
//   • +1 byte if flag1 & 0x08 = mnemonicOffset
//   • +1 byte if flag1 & 0x04 = aidCode
//   • +1 byte if flag1 & 0x01
//   • +2 bytes if flag1 & 0x02 (and 0x01 not set)
// We honour all of these by walking the byte pointer; in the common
// case (flag1 = 0x00) text starts right at offset 5.
//
// Once parsed, the dispatcher materialises the indicator + item text in
// the presentation space. Keeping parsing and painting separate is
// important: redefining or removing a construct must clear the old
// footprint before the remaining constructs are painted again.

import { ENPTUI_CLASS, SelType, ConstructKind, SenseCode, isPushButton, isSingleSelect, isMultiSelect, isMenuBar } from '../Constants.js';
import { scrollBarMetrics } from './ScrollBar.js';
import { enptuiFail as fail } from '../DataStreamError.js';
import { ATTR_BASE } from '../../Constants.js';

// Minor type bytes inside a DefineSelFld
const MINOR_CHOICE_TEXT  = 0x10;
const MINOR_CHOICE_ATTRS = 0x01;
const MINOR_DRAW_MENU    = 0x09;

// Choice-state bits in flag1
const CS_MASK     = 0xC0;
const CS_SELECTED = 0x40;
const CS_UNSELECTED = 0x00;

// Palette indices - 8 attribute bytes describing each
// state the item can be in. The defaults match ENPTUISelectionField's
// constructor; ChoiceAttributes (minor 0x01) can override any slot.
//   [0] cursor on available item
//   [1] cursor on selected item
//   [2] cursor on unavailable item
//   [3] normal available
//   [4] normal selected
//   [5] normal unavailable
//   [6] indicator for available
//   [7] indicator for unavailable
const DEFAULT_CHOICE_ATTRS = Object.freeze([0x21, 0x23, 0x3B, 0x20, 0x22, 0x3A, 0x20, 0x20]);

export const AttrIndex = Object.freeze({
    CUR_AVAILABLE:    0,
    CUR_SELECTED:     1,
    CUR_UNAVAILABLE:  2,
    AVAILABLE:        3,
    SELECTED:         4,
    UNAVAILABLE:      5,
    IND_AVAILABLE:    6,
    IND_UNAVAILABLE:  7,
});

/** Walk a Choice Attributes minor entry and overlay the host's palette
 *  onto `attrs` in place. The flag byte at entry[2] must have its high
 *  bit set; otherwise the entry is malformed and we leave the palette
 *  alone. Per the ENPTUI reference, only EVEN-indexed payload bytes carry
 *  attribute values - odd bytes are reserved alignment padding. */
function applyChoiceAttrs (entry, attrs) {
    if (entry.length < 5) return;
    const flag = entry[2];
    if ((flag & 0x80) === 0) return;
    // entry[3] reserved, palette pairs start at offset 4.
    for (let i = 0; i < 8; i++) {
        const idx = 4 + i * 2;
        if (idx >= entry.length) break;
        const v = entry[idx];
        if (v !== 0) attrs[i] = v;
    }
}

/**
 * @param {Uint8Array} body   bytes after class+minor (= payload[0] is flag1)
 * @param {object}     screen ScreenBuffer (for current SBA + cell write-through)
 */
export function decodeSelectionField (body, screen) {
    // The fixed header must be followed by at least one byte belonging
    // to the first minor structure. A header-only field is truncated,
    // not an empty but otherwise valid selection field.
    if (body.length < 17)
        fail('invalid ENPTUI selection-field major length', SenseCode.INVALID_MINOR_LENGTH);

    // ---- header ----------------------------------------------------
    const flag1         = body[0];
    const flag2         = body[1];
    const flag3         = body[2];
    const selectionType = body[3];
    const guiDeviceChar = body[4];
    // body[5..8] reserved (4 bytes)
    const textSize      = body[9];
    const numOfRows     = body[10];
    const numOfCols     = body[11];
    let numOfNulls      = body[12];
    if (numOfCols === 1) numOfNulls = 0;
    // body[13] reserved
    const selectChar    = body[14];
    const cancelAID     = body[15];
    const single  = isSingleSelect(selectionType);
    const multi   = isMultiSelect(selectionType);
    const isMenu  = isMenuBar(selectionType);
    const isPB    = isPushButton(selectionType);
    const guiKind = guiDeviceChar & 0xF0;

    if ((flag1 & 0xC0) === 0x40) return null;
    if (numOfRows < 1 || numOfCols < 1) return null;
    if (isPB && guiKind === 0x00) return null;
    if (!isMenu && !isPB && [0x20, 0x30, 0x40, 0x50, 0x60].includes(guiKind)) return null;

    // High nibble of guiDeviceChar = 0 means the host wants us to draw
    // the indicator (radio circle / checkbox); other values disable it.
    // Push-button fields never get an indicator regardless of what the
    // GUI characteristics byte requests - the button frame IS the
    // visual cue, and reserving 2 cells before the label would shift
    // the button text right and break centering.
    const drawIndicator = !isMenu && !isPB && guiKind === 0x00;

    // The attached-scroll header has exactly two 32-bit quantities. We capture
    // totalRows/sliderPos so the
    // attached scrollbar construct (created after the items are
    // parsed) can render with the correct thumb position.
    const scrollAttached = (flag2 & 0x80) !== 0;
    if (scrollAttached && [SelType.MENU_BAR, SelType.SINGLE_SEL_FLD,
        SelType.MULTI_SEL_FLD, SelType.PUSH_BUTTONS,
        SelType.PUSH_BUTTON_PULL].includes(selectionType)) return null;
    let attachedScrollTotal = 0;
    let attachedScrollSlider = 0;
    if (scrollAttached && body.length < 25)
        fail('truncated attached-scrollbar header', SenseCode.INVALID_MINOR_LENGTH);
    if (scrollAttached && body.length >= 24) {
        attachedScrollTotal  = readU32(body, 16);
        attachedScrollSlider = readU32(body, 20);
        if (attachedScrollTotal < 1 || attachedScrollSlider > attachedScrollTotal)
            return null;
    }
    let pos = 16 + (scrollAttached ? 8 : 0);

    // ---- iterate minor structures (ChoiceText + ChoiceAttributes) --
    const items = [];
    const choiceAttrs = DEFAULT_CHOICE_ATTRS.slice();
    if (guiKind === 0) {
        choiceAttrs[AttrIndex.CUR_SELECTED] = 0x21;
        choiceAttrs[AttrIndex.SELECTED] = 0x20;
    }
    let menuSeparator = null;
    while (pos + 2 <= body.length) {
        const minorLen  = body[pos];
        const minorType = body[pos + 1];
        if (minorLen < 2 || pos + minorLen > body.length)
            fail('invalid selection-field minor length', SenseCode.INVALID_MINOR_LENGTH);
        const entry = body.subarray(pos, pos + minorLen);
        if (minorType === MINOR_CHOICE_TEXT) {
            if (minorLen < 4)
                fail('invalid Choice Text minor length', SenseCode.INVALID_MINOR_LENGTH);
            const item = parseChoiceText(entry, textSize);
            if (item) items.push(item);
        } else if (minorType === MINOR_CHOICE_ATTRS) {
            if (minorLen <= 3 || minorLen >= 20)
                fail('invalid Choice Attributes minor length', SenseCode.INVALID_MINOR_LENGTH);
            applyChoiceAttrs(entry, choiceAttrs);
        } else if (minorType === MINOR_DRAW_MENU && isMenu) {
            if (minorLen <= 4 || minorLen >= 9)
                fail('invalid Draw Menu minor length', SenseCode.INVALID_MINOR_LENGTH);
            menuSeparator = parseMenuSeparator(entry);
        }
        pos += minorLen;
    }

    if (pos !== body.length)
        fail('trailing selection-field minor bytes', SenseCode.INVALID_MINOR_LENGTH);
    if (items.length === 0) return null;

    const oneRow = isMenu || numOfRows === 1;
    let layoutCols = numOfCols;
    if (isMenu && items.some(item => item.newRow)) {
        // Irregular menu rows are rectangularised with invisible,
        // non-cursorable ChoiceText entries. Those entries deliberately
        // remain in the response index space, so a selected item after a
        // short row gets the same ordinal the IBM terminal sends.
        let rowItems = 0;
        let maxCols = 0;
        for (const item of items) {
            if (item.newRow) {
                maxCols = Math.max(maxCols, rowItems);
                rowItems = 0;
            }
            rowItems++;
        }
        maxCols = Math.max(maxCols, rowItems);
        const padded = [];
        rowItems = 0;
        for (const item of items) {
            if (item.newRow) {
                while (rowItems < maxCols) {
                    padded.push(makeDummyChoice(textSize));
                    rowItems++;
                }
                rowItems = 0;
            }
            padded.push(item);
            rowItems++;
        }
        while (rowItems < maxCols) {
            padded.push(makeDummyChoice(textSize));
            rowItems++;
        }
        items.splice(0, items.length, ...padded);
        layoutCols = maxCols;
    } else if (!oneRow && items.length % layoutCols !== 0) {
        const missing = layoutCols - (items.length % layoutCols);
        for (let i = 0; i < missing; i++) items.push(makeDummyChoice(textSize));
    }
    const pushPadsText = isPB && guiKind !== 0x60;
    const pushAttrOverlap = isPB && (guiKind === 0x40 || guiKind === 0x50);
    for (const item of items) {
        const baseLength = oneRow ? item.actualLength : textSize;
        item.textBytes = item.textBytes.slice(0, baseLength);
        if (!pushPadsText) continue;

        // Push-button labels are padded with a blank on both sides. When
        // the choice already occupies textSize cells those blanks replace
        // the edge cells; otherwise they extend the short one-row label.
        const paddedLength = textSize > baseLength ? baseLength + 2 : baseLength;
        const padded = new Uint8Array(paddedLength);
        padded.fill(0x40);
        const copyLength = Math.max(0, Math.min(baseLength, paddedLength - 2));
        padded.set(item.textBytes.subarray(0, copyLength), 1);
        item.textBytes = padded;
        if (item.mnemonicOffset >= 0) item.mnemonicOffset++;
    }

    const subTypeName = (
        isMenu  ? ConstructKind.MENU_BAR     :
        isPB    ? ConstructKind.PUSH_BUTTONS :
        ConstructKind.SELECTION_FIELD);

    const startAddress = screen.writeAddress;
    const sfRow = (startAddress / screen.cols | 0);     // 0-based
    const sfCol = (startAddress % screen.cols);

    // Compute the presentation-space positions without mutating cells.
    // The dispatcher paints only after it has removed and cleared any
    // construct being replaced. Item widths can vary on a one-row
    // construct, so positions are accumulated instead of being derived
    // from a fixed column multiplier.
    const itemSlotWidth = textSize + numOfNulls + (drawIndicator ? 4 : 2);
    const itemPositions = [];

    // Row/column cursor that honours per-item NewRow (flag1 0x20)
    // overrides. Without NewRow the layout is a strict numOfCols-wide
    // grid; with NewRow set on item i, the layout jumps to a fresh
    // row even when the previous row hadn't filled all columns. Used
    // by menu bars and irregular selection groups.
    let curRow = 0;
    let curCol = 0;
    let anchor = startAddress;
    let rowSpan = 0;
    let firstRowSpan = 0;
    for (let i = 0; i < items.length; i++) {
        // NewRow is meaningful for menu bars. Choice fields/push buttons
        // use the row/column counts in the major header.
        if (isMenu && items[i].newRow) {
            curRow++;
            curCol = 0;
            if (firstRowSpan === 0) firstRowSpan = rowSpan;
            rowSpan = 0;
            anchor = startAddress + curRow * screen.cols;
        }
        const itemAnchor = anchor;
        const indicatorIdx = drawIndicator ? itemAnchor - 1 : -1;
        const textIdx = itemAnchor + 1;
        const r = drawIndicator ? (indicatorIdx / screen.cols) | 0 : (textIdx / screen.cols) | 0;
        const c = drawIndicator ? indicatorIdx % screen.cols : textIdx % screen.cols;
        const displayLength = items[i].textBytes.length;
        const step = displayLength + numOfNulls + (drawIndicator ? 4 : (pushAttrOverlap ? 1 : 2));
        const tailIdx = textIdx + displayLength + (pushAttrOverlap ? 0 : numOfNulls);

        if (itemAnchor < 0 || textIdx < 0 || tailIdx >= screen.size
            || (drawIndicator && indicatorIdx - 1 < 0)
            || r < 0 || r >= screen.rows || c < 0 || c >= screen.cols
            || (textIdx % screen.cols) + displayLength + (pushAttrOverlap ? 0 : numOfNulls) >= screen.cols)
            return null;

        itemPositions.push({
            row: r + 1,
            col: c + 1,
            idx: drawIndicator ? indicatorIdx : textIdx,
            anchorIdx: itemAnchor,
            indicatorIdx,
            textIdx,
            textRow: ((textIdx / screen.cols) | 0) + 1,
            textCol: (textIdx % screen.cols) + 1,
            slotWidth: step,
            textLength: displayLength,
        });

        rowSpan += step;
        curCol++;
        // Menu bars are variable-width rows. IBM advances to another
        // screen row only when the next Choice Text carries NewRow;
        // numOfCols is derived metadata there, not a wrapping limit.
        if (!isMenu && curCol >= layoutCols) {
            if (firstRowSpan === 0) firstRowSpan = rowSpan;
            curCol = 0;
            curRow++;
            rowSpan = 0;
            anchor = startAddress + curRow * screen.cols;
        } else {
            anchor = itemAnchor + step;
        }
    }

    // A choice owns more than its visible label. Its interactive range
    // starts at the leading attribute (two cells before the anchor when
    // an indicator is present) and ends after the trailing attribute and
    // any inter-choice null padding. This keeps clicks on radio markers,
    // button frames and column spacing inside the pseudo-field.
    for (let i = 0; i < itemPositions.length; i++) {
        const position = itemPositions[i];
        const hasLaterCursorableInRow = itemPositions.some((candidate, candidateIndex) =>
            candidateIndex > i && candidate?.row === position.row
            && !items[candidateIndex]?.nonCursorable);
        const hitStartIdx = position.anchorIdx - (drawIndicator ? 2 : 0);
        position.hitCol = (hitStartIdx % screen.cols) + 1;
        position.hitWidth = position.textLength + 2 + (drawIndicator ? 2 : 0)
            + (hasLaterCursorableInRow ? numOfNulls : 0);
    }

    const layoutSpan = firstRowSpan || rowSpan;
    const boundsStart = startAddress - (drawIndicator ? 2 : 0);
    let boundsWidth = Math.max(1, layoutSpan - numOfNulls);
    if (isPB && pushAttrOverlap) boundsWidth++;
    if (scrollAttached) boundsWidth += 2;
    if (isMenu && menuSeparator)
        boundsWidth = menuSeparator.endCol - menuSeparator.startCol + 1;
    const itemRowCount = itemPositions.length
        ? Math.max(...itemPositions.map(p => p.textRow)) - sfRow
        : 1;
    const boundsHeight = isMenu
        ? itemRowCount + (menuSeparator ? 1 : 0)
        : isPB ? numOfRows : itemRowCount;

    const result = {
        kind: subTypeName,
        subType: selectionType,
        flag1, flag2, flag3,
        cursorAtStart: startAddress,
        row: sfRow + 1, col: sfCol + 1,
        single,
        multi,
        isMenu,
        isPushButton: isPB,
        drawIndicator,
        textSize, numOfRows, numOfCols: layoutCols, numOfNulls,
        screenCols: screen.cols,
        boundsTopRow: ((boundsStart / screen.cols) | 0) + 1,
        boundsLeftCol: (boundsStart % screen.cols) + 1,
        boundsWidth,
        boundsHeight,
        itemSlotWidth,
        fieldWidth: Math.max(1,
            layoutSpan - numOfNulls - (drawIndicator ? 4 : (pushAttrOverlap ? 1 : 2))),
        pushPadsText,
        pushAttrOverlap,
        items,
        itemPositions,
        menuRows: itemRowCount,
        menuSeparator,
        // Per-state attribute palette the host wants applied to items.
        // Renderer consults choiceAttrs[AttrIndex.CUR_AVAILABLE] etc.
        // when painting focus/selected/unavailable overlays.
        choiceAttrs,
        scrollAttached,
        attachedScrollTotal,
        attachedScrollSlider,
        fieldMdt: (flag1 & 0x01) !== 0,
        autoSelect: (flag1 & 0x02) !== 0,
        autoEnter: (flag1 & 0x0C) !== 0,
        autoEnterOnSelect: (flag1 & 0x0C) !== 0,
        autoEnterOnDeselect: (flag1 & 0x08) !== 0,
        cursorMoveToInput: (flag2 & 0x10) !== 0,
        fieldAdvance: (flag2 & 0x08) !== 0,
        cursorExitable: (flag2 & 0x04) === 0,
        pointerMayMoveCursor: (flag2 & 0x02) === 0,
        deselectOnUnlock: (flag3 & 0x80) !== 0,
        selectChar,
        cancelAID,
        modified: (flag1 & 0x01) !== 0,
    };
    return result;
}

/** Whether a construct owns presentation-space cells rather than being
 *  rendered exclusively as an overlay. */
export function isMaterializedSelection (construct) {
    return Boolean(construct && [ConstructKind.SELECTION_FIELD,
        ConstructKind.MENU_BAR, ConstructKind.PUSH_BUTTONS].includes(construct.kind));
}

/** Clear every presentation-space cell owned by removed selection
 *  constructs. Bounds are clipped defensively because the display can
 *  change geometry between records. Field references are preserved:
 *  they belong to the format table, not to the visual construct. */
export function clearSelectionConstructs (screen, constructs) {
    for (const construct of constructs ?? []) {
        if (!isMaterializedSelection(construct)) continue;
        const top = (construct.boundsTopRow ?? 1) - 1;
        const left = (construct.boundsLeftCol ?? 1) - 1;
        const height = Math.max(0, construct.boundsHeight ?? 0);
        const width = Math.max(0, construct.boundsWidth ?? 0);
        for (let row = Math.max(0, top); row < Math.min(screen.rows, top + height); row++) {
            for (let col = Math.max(0, left); col < Math.min(screen.cols, left + width); col++) {
                const cell = screen.cells[row * screen.cols + col];
                cell.byte = 0;
                cell.glyph = ' ';
                cell.attributePlace = false;
                cell.startField = false;
                cell.extAttr = null;
            }
        }
    }
}

/** Materialise one selection construct in the presentation space. */
export function paintSelectionField (screen, construct) {
    if (!isMaterializedSelection(construct)) return;
    const { items = [], itemPositions = [], choiceAttrs = [] } = construct;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const position = itemPositions[i];
        if (!position || item.dummy) continue;
        // A push button expresses selected/default state through its frame.
        // Its label keeps the available palette until it becomes unavailable.
        const itemAttr = choiceAttrs[item.unavailable ? AttrIndex.UNAVAILABLE
            : item.selected && !construct.isPushButton
                ? AttrIndex.SELECTED : AttrIndex.AVAILABLE] ?? 0x20;

        writeAttribute(screen, position.anchorIdx, itemAttr);
        const tail = screen.cells[position.textIdx + position.textLength];
        // Choice text must not replace an attribute/field boundary already
        // owned by the presentation space (for example a window border or
        // the following ordinary field).
        if (tail && !tail.attributePlace && !tail.startField)
            writeAttribute(screen, position.textIdx + position.textLength, 0x20);

        // Selection fields and push buttons add inter-column nulls only
        // between cursorable choices in the same row. Menu-bar rows retain
        // their explicit padding after each choice.
        const hasLaterChoiceInRow = itemPositions.some((candidate, candidateIndex) =>
            candidateIndex > i && candidate?.row === position.row
            && !items[candidateIndex]?.dummy
            && !items[candidateIndex]?.nonCursorable);
        if (!construct.pushAttrOverlap && (construct.isMenu || hasLaterChoiceInRow)) {
            for (let n = 1; n <= construct.numOfNulls; n++) {
                const cell = screen.cells[position.textIdx + position.textLength + n];
                if (!cell) break;
                cell.byte = 0;
                cell.glyph = ' ';
                cell.attributePlace = false;
                cell.startField = false;
                cell.extAttr = null;
            }
        }
        if (construct.drawIndicator && !item.unavailable) {
            const indicatorAttr = choiceAttrs[AttrIndex.IND_AVAILABLE] ?? 0x20;
            writeAttribute(screen, position.indicatorIdx - 1, indicatorAttr);
            writeIndicator(screen, position.indicatorIdx, item, construct.single,
                construct.isPushButton, indicatorAttr);
        }

        const textCol = position.textIdx % screen.cols;
        for (let k = 0; k < item.textBytes.length && textCol + k < screen.cols; k++) {
            const cell = screen.cells[position.textIdx + k];
            if (!cell) break;
            cell.byte = item.textBytes[k];
            cell.glyph = screen.ebcdic.toChar(item.textBytes[k]);
            cell.attributePlace = false;
            cell.startField = false;
            cell.attr = ATTR_BASE[itemAttr] ?? screen.activeAttr;
            cell.extAttr = null;
        }
    }
}

/** Clear removed footprints, restore the ordinary attribute plane, then
 *  redraw every active materialised construct in insertion order. */
export function refreshSelectionPresentation (screen, removed = []) {
    clearSelectionConstructs(screen, removed);
    screen.recalcAttributes();
    for (const construct of screen.enptui.all)
        paintSelectionField(screen, construct);
}

function parseMenuSeparator (entry) {
    if (entry.length < 5 || entry.length > 8) return null;
    const flags = entry[2];
    const startCol = entry[3];
    const endCol = entry[4];
    if (startCol < 1 || endCol < startCol) return null;
    let attr = 0x3A;
    let char = 0x4B;
    if (entry.length >= 7 && entry[6] !== 0) attr = entry[6];
    const customCharacter = entry.length >= 8
        && (flags & 0x80) !== 0
        && entry[7] !== 0;
    if (customCharacter) char = entry[7];
    return {
        flags,
        startCol,
        endCol,
        attr,
        char,
        customCharacter,
        suppressAttribute: (flags & 0x40) !== 0,
    };
}

/** When a Selection Field's header signalled scrollAttached, return a
 *  fully-formed ScrollBar construct that the dispatcher can store
 *  alongside the parent. Parent ↔ child linkage is set so
 *  REMOVE_GUI_SEL_FLD cascades correctly. */
export function buildAttachedScrollBar (selResult) {
    if (!selResult || !selResult.scrollAttached) return null;
    // Position the bar at the right edge of the field's row block.
    // Anchor it just past the last column of the item layout.
    const fieldWidth = selResult.fieldWidth;
    const anchor = selResult.cursorAtStart + fieldWidth + 1;
    const length = selResult.numOfRows;
    const totalRows = selResult.attachedScrollTotal || selResult.items.length;
    const sliderPos = selResult.attachedScrollSlider;
    const metrics = scrollBarMetrics(length, totalRows, sliderPos, true);
    return {
        kind: ConstructKind.SCROLL_BAR,
        cursorAtStart: anchor,
        parent:      selResult,
        direction:   0,                 // 0 = vertical, 1 = horizontal
        rowOffset:   (anchor / selResult.screenCols) | 0,
        colOffset:   anchor % selResult.screenCols,
        length,
        totalRows,
        visibleRows: selResult.numOfRows,
        sliderPos,
        ...metrics,
        boundsWidth: 3,
        boundsHeight: length,
        moveCursor: false,
        modified: false,
        scrollIncrement: 0,
    };
}

function parseChoiceText (entry, textSize) {
    // entry[0] = minorLen, entry[1] = 0x10
    const flag1 = entry[2];
    const flag2 = entry[3];
    const flag3 = entry[4];
    if ((flag3 & 0x80) === 0) return null;

    let mnemonicOffset = -1;
    let aidCode = 0;
    let p = 5;

    // Optional header bytes (only when flag3 advertises GUI layout):
    //   flag1 0x08 → mnemonicOffset byte
    //   flag1 0x04 → aidCode byte (push-button AID, F3=Cancel, etc.)
    //   flag1 0x01 → 1 extra byte (numeric single-select index)
    //   flag1 0x02 → 2 extra bytes (numeric double-select index)
    if ((flag3 & 0x80) !== 0) {
        const optionalLength = ((flag1 & 0x08) !== 0 ? 1 : 0)
            + ((flag1 & 0x04) !== 0 ? 1 : 0)
            + ((flag1 & 0x01) !== 0 ? 1 : (flag1 & 0x02) !== 0 ? 2 : 0);
        if (p + optionalLength > entry.length)
            fail('truncated Choice Text optional data', SenseCode.INVALID_MINOR_LENGTH);
        if ((flag1 & 0x08) !== 0) mnemonicOffset = entry[p++];
        if ((flag1 & 0x04) !== 0) aidCode = entry[p++];
        if ((flag1 & 0x01) !== 0) p += 1;
        else if ((flag1 & 0x02) !== 0) p += 2;
    }

    const choiceState = flag1 & CS_MASK;
    const selected    = choiceState === CS_SELECTED;
    const unavailable = (choiceState & 0x80) !== 0;     // 0x80 or 0xC0

    // flag2 carries layout / cursor hints. The most important is
    // NewRow (0x20) forces this item to start a fresh row in menu
    // layouts. The directional bits request Roll AIDs at an edge, and
    // NoPushBox is consumed by the push-button renderer.
    const newRow         = (flag1 & 0x20) !== 0;
    const topChoice      = (flag2 & 0x40) !== 0;
    const bottomChoice   = (flag2 & 0x20) !== 0;
    const leftChoice     = (flag2 & 0x10) !== 0;
    const rightChoice    = (flag2 & 0x08) !== 0;

    // Up to `textSize` bytes of text; pad with EBCDIC space (0x40) if
    // the entry is shorter than expected.
    const textBytes = new Uint8Array(textSize);
    textBytes.fill(0x40);
    const avail = Math.max(0, Math.min(textSize, entry.length - p));
    // A Choice Text minor without text is structural padding.  The host
    // does not have to repeat the Non-Cursorable bit for that form.
    const nonCursorable = (flag2 & 0x80) !== 0 || avail === 0;
    for (let i = 0; i < avail; i++) textBytes[i] = entry[p + i];

    return {
        flag1, flag2, flag3,
        selected, unavailable,
        newRow, nonCursorable, topChoice, bottomChoice, leftChoice, rightChoice,
        mnemonicOffset, aidCode,
        actualLength: avail,
        textBytes,
        // text in client-readable form is computed lazily by the
        // renderer using the screen's current code page.
    };
}

function makeDummyChoice (textSize) {
    const textBytes = new Uint8Array(textSize);
    textBytes.fill(0x40);
    return {
        flag1: 0,
        flag2: 0x80,
        flag3: 0x80,
        selected: false,
        unavailable: true,
        newRow: false,
        nonCursorable: true,
        topChoice: false,
        bottomChoice: false,
        leftChoice: false,
        rightChoice: false,
        mnemonicOffset: -1,
        aidCode: 0,
        actualLength: textSize,
        textBytes,
        dummy: true,
    };
}

function readU32 (bytes, off) {
    return ((bytes[off] & 0xFF) * 0x1000000)
         + ((bytes[off + 1] & 0xFF) << 16)
         + ((bytes[off + 2] & 0xFF) << 8)
         +  (bytes[off + 3] & 0xFF);
}

function writeIndicator (screen, baseIdx, item, single, isPB, attrByte) {
    // ENPTUI selection indicators render as
    // a single cell — no parens or brackets around them. We paint the
    // raw EBCDIC byte here so that even when the Renderer overlay isn't
    // running the user still sees something meaningful, and the overlay
    // then swaps that single cell for a fancier Unicode glyph.
    //
    //   single-select radio:    '/' (selected) or '.' (unselected)
    //   multi-select checkbox:  '/' (selected) or ' ' (unselected)
    //   push button: nothing (Renderer draws the frame)
    if (isPB) return;
    const cell = screen.cells[baseIdx];
    const byte = single
        ? (item.selected ? 0x61 /* / */ : 0x4B /* . */)
        : (item.selected ? 0x61 /* / */ : 0x40 /* sp */);
    cell.byte = byte;
    cell.glyph = screen.ebcdic.toChar(byte);
    cell.attributePlace = false;
    cell.attr = ATTR_BASE[attrByte] ?? screen.activeAttr;
}

function writeAttribute (screen, idx, byte) {
    const cell = screen.cells[idx];
    if (!cell) return;
    cell.byte = byte;
    cell.glyph = ' ';
    cell.attributePlace = true;
    cell.startField = false;
    cell.attr = ATTR_BASE[byte] ?? screen.activeAttr;
}

export { ENPTUI_CLASS, SelType };
