// ENPTUI CreateWindow (minor type 0x51) decoder.
//
// A Window draws a rectangular box on the screen with optional title
// and footer text, and indicates the "interior" cells the user should
// see as the active area. Real layout per the ENPTUI architecture
// document:
//
//   payload[0]  flag1
//   payload[1]  reserved
//   payload[2]  reserved
//   payload[3]  height (rows)
//   payload[4]  width  (cols)
//   payload[5+] minor structures: <minorLen 1B> <minorType 1B> <body>
//     minorType 0x01 = Border Presentation (flag + 8 border glyphs)
//     minorType 0x10 = Title/Footer (flag selects which, + attr + text)
//
// The CreateWindow header carries only the rectangle; title, footer
// and border characters arrive as minor structures so the host can
// send each independently. Window position comes from the cursor at
// the time of the CreateWindow segment (i.e. the most recent SBA).

import { ConstructKind, SenseCode } from '../Constants.js';
import { enptuiFail as fail } from '../DataStreamError.js';

const MINOR_BORDER       = 0x01;
const MINOR_TITLE_FOOTER = 0x10;

// Default border glyph palette (CP037 EBCDIC codes):
//   topLeft, top, topRight, leftSide, rightSide, botLeft, bot, botRight
const DEFAULT_BORDERS = [0x4B, 0x4B, 0x4B, 0x7A, 0x7A, 0x7A, 0x4B, 0x7A];

// Non-display attribute bytes.
// When the border's "presentation attribute" matches any of these the
// window has NO visible border - the host wants only the interior to
// show, no rectangle drawn around it.
const NON_DISPLAY_ATTRS = new Set([0x27, 0x2F, 0x37, 0x3F]);

export function decodeWindow (body, screen) {
    if (body.length < 5)
        fail('invalid ENPTUI window major length', SenseCode.INVALID_MINOR_LENGTH);

    const flag1   = body[0];
    const reserved1 = body[1];
    const reserved2 = body[2];
    const height  = body[3];
    const width   = body[4];

    // Window top-left comes from the cursor's row/col at decode time
    // (the host emits an SBA immediately before the CreateWindow).
    const sfRow = (screen.cursor / screen.cols | 0);
    const sfCol = (screen.cursor % screen.cols);

    // Per the ENPTUI window construct:
    //   flag1 bit 0x80 = cursor restricted to the window interior
    //   flag1 bit 0x40 = menu-pull-down (skip top border row to glue
    //                    visually to the parent menu bar)
    const cursorRestricted = (flag1 & 0x80) !== 0;
    const menuPullDown     = (flag1 & 0x40) !== 0;

    // IBM HOD treats the wire width/depth as the content rectangle. The
    // complete construct also owns three cells on either side and one
    // border row above/below it.
    const outerWidth  = width + 6;
    const outerHeight = height + 2;
    if (width < 1 || height < 1 || sfCol + outerWidth > screen.cols
        || sfRow + outerHeight > screen.rows) return null;

    // Walk minor structures for border / title / footer.
    const result = {
        kind: ConstructKind.WINDOW,
        cursorAtStart: screen.cursor,
        topRow:  sfRow + 1,                  // store 1-based to match SBA convention
        leftCol: sfCol + 1,
        height: outerHeight,
        width: outerWidth,
        contentHeight: height,
        contentWidth: width,
        innerTopRow: sfRow + 2,
        innerLeftCol: sfCol + 4,
        innerHeight: height,
        innerWidth: width,
        flag1,
        reserved1,
        reserved2,
        cursorRestricted,
        menuPullDown,
        borderAttr:  0x3A,
        noBorder:    false,
        borders:     DEFAULT_BORDERS.slice(),
        title:       null,                   // {text, attr, align} | null
        footer:      null,
    };

    let pos = 5;
    while (pos + 2 <= body.length) {
        const minorLen  = body[pos];
        const minorType = body[pos + 1];
        if (minorLen < 2 || pos + minorLen > body.length)
            fail('invalid window minor length', SenseCode.INVALID_MINOR_LENGTH);
        const entry = body.subarray(pos, pos + minorLen);
        if (minorType === MINOR_BORDER) {
            if (minorLen < 4 || minorLen > 13)
                fail('invalid Border Presentation minor length', SenseCode.INVALID_MINOR_LENGTH);
            applyBorder(entry, result);
        } else if (minorType === MINOR_TITLE_FOOTER) {
            if (minorLen <= 6)
                fail('invalid Title/Footer minor length', SenseCode.INVALID_MINOR_LENGTH);
            applyTitleFooter(entry, result, screen);
        }
        pos += minorLen;
    }
    if (pos !== body.length)
        fail('trailing window minor bytes', SenseCode.INVALID_MINOR_LENGTH);
    return result;
}

/** Border Presentation minor (0x01). Layout verified against IBM HOD:
 *    entry[0] minorLen
 *    entry[1] minorType (0x01)
 *    entry[2] flag (high bit 0x80 ⇒ entry carries 8 glyph overrides)
 *    entry[3] reserved
 *    entry[4] border attribute, entry[5..12] glyph overrides */
function applyBorder (entry, result) {
    if (entry.length < 3) return;
    const flag = entry[2];
    if ((flag & 0x80) === 0) return;
    if (entry.length >= 5 && entry[4] !== 0) {
        result.borderAttr = entry[4];
        result.noBorder = NON_DISPLAY_ATTRS.has(entry[4]);
    }
    for (let i = 0; i < 8 && 5 + i < entry.length; i++) {
        if (entry[5 + i] !== 0) result.borders[i] = entry[5 + i];
    }
}

/** Title/Footer minor (0x10). Layout per the ENPTUI reference:
 *    entry[0] minorLen
 *    entry[1] minorType (0x10)
 *    entry[2] flag (0x20 = footer, else title; 0x40/0x80 = alignment)
 *    entry[3] reserved
 *    entry[4] text attribute (5250 attribute byte)
 *    entry[5] reserved
 *    entry[6..N] EBCDIC text bytes */
function applyTitleFooter (entry, result, screen) {
    if (entry.length < 7) return;
    const flag       = entry[2];
    // entry[3] reserved
    const textAttr   = entry[4];
    // entry[5] reserved
    const isFooter   = (flag & 0x20) !== 0;
    const align      = (flag & 0x40) ? 'right'
                    : (flag & 0x80) ? 'left'
                    : 'center';
    const textBytes  = entry.subarray(6);
    let text = '';
    for (const b of textBytes) {
        text += b === 0x00 ? ' ' : screen.ebcdic.toChar(b);
    }
    const info = { text, textBytes, attr: textAttr, align };
    if (isFooter) result.footer = info;
    else          result.title  = info;
}
