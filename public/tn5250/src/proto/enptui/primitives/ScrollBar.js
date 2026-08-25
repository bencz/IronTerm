// ENPTUI Scroll Bar Field (minor type 0x53) decoder.
//
// A scroll bar attaches to another construct (typically a selection
// list inside a window) and represents the visible-vs-total ratio of
// items, with arrow caps at top/bottom and a draggable "thumb" / slider.
//
// Wire layout:
//
//   +0  flag1
//   +1  reserved
//   +2..+5  total rows/columns (32-bit, big-endian)
//   +6..+9  rows/columns available before the slider (32-bit)
//   +10 bar size in screen cells
//   ...etc.
//
// Reference: ENPTUI scroll-bar construct definition.
//
// The decoder captures geometry for rendering; InputController maps bar
// zones to the corresponding Roll AIDs and translates direct thumb dragging
// back into the host's scroll increment.

import { ConstructKind, SenseCode } from '../Constants.js';
import { enptuiFail as fail } from '../DataStreamError.js';

export function scrollBarMetrics (length, totalRows, sliderPos, vertical) {
    let actualSize = length;
    if (vertical) {
        if (length > 4) actualSize -= 2;
    } else if (length < 7) {
        actualSize -= 2;
    } else {
        actualSize -= 4;
    }
    actualSize = Math.max(1, actualSize);
    let sliderCellSize = Math.floor(((length - (vertical ? 0 : 2)) * actualSize) / totalRows);
    if (sliderCellSize === 0) sliderCellSize = 1;
    let sliderCellPos = sliderPos === 0 ? 0 : Math.max(1, Math.floor((sliderPos * actualSize) / totalRows));
    sliderCellPos++;
    if (vertical && length + sliderPos === totalRows)
        sliderCellSize = Math.max(1, length - sliderCellPos - 1);
    if (sliderCellPos + sliderCellSize > actualSize && sliderPos + length < totalRows) {
        if (sliderCellSize > 1) sliderCellSize--;
        else sliderCellPos--;
    }
    return { actualSize, sliderCellPos, sliderCellSize };
}

export function decodeScrollBar (body, screen) {
    if (body.length < 11)
        fail('invalid ENPTUI scrollbar major length', SenseCode.INVALID_MINOR_LENGTH);

    const flag1       = body[0];
    const direction   = (flag1 & 0x80) !== 0 ? 1 : 0;
    const totalRows   = readU32(body, 2);
    const sliderPos   = readU32(body, 6);
    const length      = body[10];
    const anchorRow   = (screen.writeAddress / screen.cols) | 0;
    const anchorCol   = screen.writeAddress % screen.cols;
    const vertical    = direction === 0;
    const boundsWidth = vertical ? 3 : length;
    const boundsHeight = vertical ? length : 1;
    if (length < 1 || totalRows < 1 || sliderPos > totalRows
        || anchorRow + boundsHeight > screen.rows
        || anchorCol + boundsWidth > screen.cols) return null;

    // These are the exact cell-space quantities defined for scroll bars.
    // Keep the wire value (`sliderPos`) too,
    // because that is what field metadata and host responses represent.
    const { actualSize, sliderCellPos, sliderCellSize } =
        scrollBarMetrics(length, totalRows, sliderPos, vertical);

    return {
        kind: ConstructKind.SCROLL_BAR,
        cursorAtStart: screen.writeAddress,
        flag1,
        direction,
        rowOffset: anchorRow,
        colOffset: anchorCol,
        length,
        totalRows,
        visibleRows: vertical ? length : Math.max(0, length - 2),
        sliderPos,
        actualSize,
        sliderCellPos,
        sliderCellSize,
        boundsWidth,
        boundsHeight,
        moveCursor: (flag1 & 0x40) !== 0,
        // Standalone scroll pseudo-fields initialize with
        // MDT off; only an operator scroll action marks them modified.
        modified: false,
        scrollIncrement: 0,
    };
}

function readU32 (bytes, off) {
    return ((bytes[off] & 0xFF) * 0x1000000)
         + ((bytes[off + 1] & 0xFF) << 16)
         + ((bytes[off + 2] & 0xFF) << 8)
         +  (bytes[off + 3] & 0xFF);
}
