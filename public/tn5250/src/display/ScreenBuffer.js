// 5250 presentation space.
//
// The 5250 model is similar to 3270 but with several important
// differences:
//
//   • Attributes are bytes in the 0x20-0x3F range placed anywhere in
//     the buffer. Each one occupies a non-display cell and governs
//     every following cell until the next attribute byte.
//   • Field formatting is described per-field by a Field Format Word
//     (FFW) plus optional Field Control Words (FCWs); SF orders carry
//     these alongside the visual attribute byte that opens the field.
//   • Fields are normally re-described from scratch on every WTD;
//     a Clear Format Table command erases the field set without
//     touching the visible cells (used by some apps before refresh).
//   • There's a saved/restored screen pair (SAVE/RESTORE opcodes) so
//     pop-up help and window-style UIs can stack.
//
// The model also owns input semantics (shift rules, Field Exit, FER,
// adjustment, mandatory fields) and the ENPTUI construct store. DBCS
// runs remain intentionally outside this single-byte presentation model.

import { Ebcdic } from '../../../shared/src/proto/Ebcdic.js';
import { ATTR_BASE, isAttribute, Ffw, Shift, Adjust } from '../proto/Constants.js';
import { EnptuiStore } from '../proto/enptui/Store.js';
import { Cell, DEFAULT_ATTR_DESC } from './Cell.js';
import { acceptsByShift, isEbcdicDigit, isEbcdicLetter,
    EBC_SPACE, EBC_MINUS, EBC_DIGITS_MIN } from './shift-rules.js';
import { debugFor } from '../../../shared/src/core/debug.js';

const debug = debugFor('tn5250.screen');

// Re-exported so existing consumers that imported these from ScreenBuffer
// keep working without an edit.
export { isEbcdicDigit, isEbcdicLetter, EBC_SPACE, EBC_DIGITS_MIN };

class Field {
    /** Build from the byte stream the host sent in an SF order. */
    constructor (start, opts) {
        this.start  = start;           // index of the attribute byte that opens the field
        this.length = opts.length;     // data-cell count (excludes the attribute cell)
        this.attr   = opts.attr;       // basic attribute byte (0x20-0x3F)
        this.ffw0   = opts.ffw0 ?? 0;  // first FFW byte
        this.ffw1   = opts.ffw1 ?? 0;  // second FFW byte
        this.fcws   = opts.fcws ?? [];

        // FFW byte 0 — bypass/dup/mdt/shift
        this.bypass   = (this.ffw0 & Ffw.BYPASS)      !== 0;
        this.dup      = (this.ffw0 & Ffw.DUP_ALLOWED) !== 0;
        this.modified = (this.ffw0 & Ffw.MDT)         !== 0;
        this.shift    =  this.ffw0 & Ffw.SHIFT_NUMERIC;
        this.signedNumeric = this.shift === Shift.SIGNED_NUMERIC;
        this.ioOnly = this.shift === Shift.IO_ONLY;

        // FFW byte 1 — input semantics enforced at typeByte / submit time
        this.autoEnter = (this.ffw1 & Ffw.AUTO_ENTER) !== 0;
        this.fer       = (this.ffw1 & Ffw.FER)        !== 0
            || (this.ffw1 & Ffw.ADJUST) === Adjust.RIGHT_ZERO
            || (this.ffw1 & Ffw.ADJUST) === Adjust.RIGHT_BLANK
            || this.signedNumeric;
        this.monocase  = (this.ffw1 & Ffw.MONOCASE)   !== 0;
        this.mandatory = (this.ffw1 & Ffw.MANDATORY)  !== 0;
        this.adjust    =  this.ffw1 & Ffw.ADJUST;
        // A field delivered with MDT already set is host-complete. A later
        // operator edit clears this completion state until the appropriate
        // field-navigation or Field Exit action occurs.
        this.exited    = !this.fer || this.modified;

        // FCW (Field Control Word) pairs - tag bytes and their values
        // following the FFW. We pick out the three that affect runtime
        // behaviour; everything else stays in this.fcws for inspection.
        //   0x80 = next resequence number
        //   0x84 = transparent field
        //   0x86 = continued field segment (0x80 means word-wrap)
        //   0x88 = cursor progression order (target field id)
        //   0x89 = highlight-on-entry attribute byte
        //   0x8A = pointer AID
        // Other FCWs, including DBCS variants, stay available via
        // this.fcws even when this single-byte model does not apply them.
        this.continuedKind   = 0;
        this.cursorProgress  = 0;
        this.highlightAttr   = 0;
        this.cursorInvisible = false;
        this.resequence      = 0;
        this.transparent     = false;
        this.wordWrap        = false;
        this.pointerAid      = 0;
        this.modulus         = 0;
        this.ccsid           = 0;
        this.maxReturnLength = 0;
        let ccsidHigh = 0;
        let ccsidLow = 0;
        let maxReturnHigh = 0;
        let maxReturnLow = 0;
        for (const [tag, val] of this.fcws) {
            if      (tag === 0x80) this.resequence = val;
            else if (tag === 0x84) this.transparent = true;
            else if (tag === 0x86 && val === 0x80) this.wordWrap = true;
            else if (tag === 0x86) this.continuedKind  = val;
            else if (tag === 0x88) this.cursorProgress = val;
            else if (tag === 0x89) {
                this.cursorInvisible = (val & 0x20) !== 0;
                this.highlightAttr = (val & 0x1F) | 0x20;
            }
            else if (tag === 0x8A) this.pointerAid = val;
            else if (tag === 0x90) ccsidHigh = val;
            else if (tag === 0x91) ccsidLow = val;
            else if (tag === 0x92) maxReturnHigh = val;
            else if (tag === 0x93) maxReturnLow = val;
            else if (tag === 0xB1 && val === 0x40) this.modulus = 11;
            else if (tag === 0xB1 && val === 0xA0) this.modulus = 10;
        }
        this.ccsid = (ccsidHigh << 8) | ccsidLow;
        this.maxReturnLength = (maxReturnHigh << 8) | maxReturnLow;
        this.continued      = this.continuedKind !== 0;
        this.continuedFirst = this.continuedKind === 1;
        this.continuedLast  = this.continuedKind === 2;
        this.continuedMid   = this.continuedKind === 3;
    }
}

export class ScreenBuffer {
    /**
     * @param {number} rows
     * @param {number} cols
     * @param {Ebcdic} [ebcdic] code-page table (CP037 by default)
     */
    constructor (rows, cols, ebcdic) {
        this.rows = rows;
        this.cols = cols;
        // Unit tests and embedders may use arbitrary buffer sizes, so
        // geometry switching is opt-in. Terminal configures the real
        // 5250 standard (24x80) and selected alternate model explicitly.
        this.standardRows = rows;
        this.standardCols = cols;
        this.alternateRows = rows;
        this.alternateCols = cols;
        this.ebcdic = ebcdic ?? Ebcdic.get('CP037');

        this.cells = new Array(rows * cols);
        for (let i = 0; i < this.cells.length; i++) this.cells[i] = new Cell();

        this.cursor = 0;                  // visible/input cursor, index 0..size-1
        this.writeAddress = 0;            // host datastream SBA
        this.fields = [];                 // ordered by start position
        // Monotonic insertion order for the field-format table. ENPTUI
        // input constructs participate in the same logical table as SF
        // fields, even though they live in a separate render store.
        this.nextFormatOrder = 0;
        this.keyboardLocked = true;       // unlocked by an unlock-keyboard CC1
        this.messageLight = false;
        this.alarm = false;
        this.insertMode = false;
        this.autoEnterRequested = false;
        this.pendingPointerAid = null;
        this.queuedPointerAid = null;
        this.pointerMarker = null;

        // SAVE/RESTORE snapshots include ENPTUI and operator state, not
        // just cells. Tokens let the host keep more than one opaque image.
        this.savedScreen = null;
        this.savedScreens = new Map();
        this.nextSavedScreenId = 1;
        this.lastRestoredSessionState = null;

        // Cursor orders are collected while the WTD is parsed. WCC2 then
        // resolves IC/MC and exposes the final movement to the terminal.
        this.pendingCursor = -1;
        this.pendingInsertAddress = -1;
        this.pendingMoveAddress = -1;
        this.homeAddress = 0;

        // Running attribute "pen" - every attribute byte (0x20-0x3F)
        // emitted by the host sets this, and every subsequent data
        // byte / RA fill picks it up so the colour propagates through
        // the screen exactly like IBM hardware. SBA does NOT reset it
        // (per IBM 5250 ref); only a fresh Clear Unit does.
        this.activeAttr = DEFAULT_ATTR_DESC;

        // ENPTUI constructs (windows, selection fields, push buttons,
        // menu bars, scroll bars). The InboundParser populates this
        // from WTDSF segments; the Renderer paints them as overlays.
        this.enptui = new EnptuiStore();
        // Address of the most recently created ENPTUI window. Window
        // cursor restriction and Unrestrict Window Cursor apply to this
        // window only; removing it does not reactivate an older window.
        this.currentEnptuiWindowAddress = null;

        // Extended attribute "pen" set by WEA (Write Extended Attribute)
        // orders. Reset to null whenever the basic attribute pen
        // (0x20-0x3F) changes, mirroring real IBM 5250 hardware: WEA
        // augments the current basic attribute but is wiped the moment
        // the host emits another attribute place.
        this.extendedAttr = null;
        this.sysreqMode = false;
        this.errorMode = false;
        this.errorHelpMode = false;
        this.errorHelpResumeLocked = null;
        this.errorLineSnapshot = null;
        this.sysreqLineSnapshot = null;

        // Start-of-Header state. PF bits select cursor+AID-only replies;
        // the error row and cursor-to-input policy are retained too.
        this.soh = {
            cursorMoveToInput: false,
            resequence: 0,
            errRow: 0,
            pfBytes: [0x00, 0x00, 0x00],
        };
    }

    get size () { return this.rows * this.cols; }

    configureGeometry ({ standardRows = 24, standardCols = 80,
                         alternateRows = standardRows, alternateCols = standardCols } = {}) {
        this.standardRows = standardRows;
        this.standardCols = standardCols;
        this.alternateRows = alternateRows;
        this.alternateCols = alternateCols;
    }

    setEbcdic (ebcdic) {
        this.ebcdic = ebcdic;
        for (const cell of this.cells)
            cell.glyph = cell.attributePlace ? ' ' : this.ebcdic.toChar(cell.byte);
    }

    resize (rows, cols) {
        this.rows = rows;
        this.cols = cols;
        this.cells = new Array(rows * cols);
        for (let i = 0; i < this.cells.length; i++) this.cells[i] = new Cell();
        this.cursor = 0;
        this.writeAddress = 0;
        this.fields = [];
        this.nextFormatOrder = 0;
        this.keyboardLocked = true;
        this.messageLight = false;
        this.alarm = false;
        this.insertMode = false;
        this.autoEnterRequested = false;
        this.pendingPointerAid = null;
        this.queuedPointerAid = null;
        this.pointerMarker = null;
        this.pendingCursor = -1;
        this.pendingInsertAddress = -1;
        this.pendingMoveAddress = -1;
        this.homeAddress = 0;
        this.activeAttr = DEFAULT_ATTR_DESC;
        this.extendedAttr = null;
        this.sysreqMode = false;
        this.errorMode = false;
        this.errorHelpMode = false;
        this.errorHelpResumeLocked = null;
        this.errorLineSnapshot = null;
        this.sysreqLineSnapshot = null;
        this.soh = { cursorMoveToInput: false, resequence: 0, errRow: 0, pfBytes: [0, 0, 0] };
        this.enptui.clear();
        this.currentEnptuiWindowAddress = null;
    }

    // ---- mutation API used by the parser ------------------------------

    clearUnit (alternate = false) {
        const rows = alternate ? this.alternateRows : this.standardRows;
        const cols = alternate ? this.alternateCols : this.standardCols;
        if (rows !== this.rows || cols !== this.cols) {
            this.rows = rows;
            this.cols = cols;
            this.cells = new Array(rows * cols);
            for (let i = 0; i < this.cells.length; i++) this.cells[i] = new Cell();
        }
        for (const cell of this.cells) cell.reset();
        this.fields = [];
        this.nextFormatOrder = 0;
        this.cursor = 0;
        this.writeAddress = 0;
        this.messageLight = false;
        this.alarm = false;
        this.insertMode = false;
        this.autoEnterRequested = false;
        this.pendingPointerAid = null;
        this.queuedPointerAid = null;
        this.pointerMarker = null;
        this.pendingCursor = -1;
        this.pendingInsertAddress = -1;
        this.pendingMoveAddress = -1;
        this.homeAddress = 0;
        this.sysreqMode = false;
        this.errorMode = false;
        this.errorHelpMode = false;
        this.errorHelpResumeLocked = null;
        this.errorLineSnapshot = null;
        this.sysreqLineSnapshot = null;
        this.activeAttr = DEFAULT_ATTR_DESC;
        this.extendedAttr = null;
        this.soh = { cursorMoveToInput: false, resequence: 0, errRow: 0, pfBytes: [0, 0, 0] };
        // Clear Unit also wipes every active GUI construct - the host
        // is starting over with the screen, so windows/selections that
        // belonged to the previous panel don't carry over.
        this.enptui.clear();
        this.currentEnptuiWindowAddress = null;
    }
    clearFormatTable ({ preserveWindows = false } = {}) {
        this.fields = [];
        this.nextFormatOrder = 0;
        // Only GUI pseudo-fields belong to the format table. Grid and
        // programmable-pointer definitions have independent lifetimes.
        this.enptui.inactivateWhere(construct =>
            ['selectionField', 'menuBar', 'pushButtons', 'scrollBar'].includes(construct.kind)
            || (!preserveWindows && construct.kind === 'window'));
        if (!preserveWindows) this.currentEnptuiWindowAddress = null;
    }

    /** Temporarily replace a host-defined message-line range. Reset must
     *  reveal exactly the presentation cells that were underneath it. */
    beginErrorLine (start, end) {
        if (!Number.isInteger(start) || !Number.isInteger(end)
            || start < 0 || end < start || end >= this.size)
            throw new RangeError(`Invalid 5250 error line ${start}-${end}`);

        if (this.errorLineSnapshot) this.clearErrorMode();
        const length = end - start + 1;
        this.errorLineSnapshot = {
            start,
            cells: this.cells.slice(start, start + length).map(cell => ({ ...cell })),
            homeAddress: this.homeAddress,
        };
        for (let i = start; i <= end; i++) this.cells[i].reset();
        this.errorMode = true;
        this.errorHelpMode = false;
        this.sysreqMode = false;
        this.insertMode = false;
        this.keyboardLocked = false;
        this.writeAddress = start;
    }

    clearErrorMode () {
        const saved = this.errorLineSnapshot;
        if (saved) {
            for (let i = 0; i < saved.cells.length; i++)
                this.cells[saved.start + i] = Object.assign(new Cell(), saved.cells[i]);
            this.homeAddress = saved.homeAddress;
        }
        this.errorLineSnapshot = null;
        this.errorMode = false;
        this.errorHelpMode = false;
        this.errorHelpResumeLocked = null;
        this.recalcAttributes();
    }

    /** Temporarily replace the host message row with the local System
     *  Request entry field. The complete format table is isolated while the
     *  operator types, then restored together with the overwritten row. */
    beginSystemRequest () {
        if (this.sysreqMode || this.sysreqLineSnapshot) return false;
        const row = this.soh.errRow >= 1 && this.soh.errRow <= this.rows
            ? this.soh.errRow : this.rows;
        const start = (row - 1) * this.cols;
        this.sysreqLineSnapshot = {
            start,
            cells: this.cells.slice(start, start + this.cols).map(cell => ({ ...cell })),
            fields: this.fields,
            nextFormatOrder: this.nextFormatOrder,
            cursor: this.cursor,
            writeAddress: this.writeAddress,
            homeAddress: this.homeAddress,
            keyboardLocked: this.keyboardLocked,
            insertMode: this.insertMode,
            activeAttr: this.activeAttr,
            extendedAttr: this.extendedAttr,
        };

        for (let i = start; i < start + this.cols; i++) this.cells[i].reset();
        this.fields = [];
        this.nextFormatOrder = 0;
        this.writeAddress = start;
        this.addField({ attr: 0x34, length: this.cols - 2,
            ffw0: 0x40, ffw1: 0x00, fcws: [] });
        this.homeAddress = start + 1;
        this.cursor = start + 1;
        this.insertMode = false;
        this.keyboardLocked = false;
        this.sysreqMode = true;
        this.recalcAttributes();
        return true;
    }

    /** Return the typed System Request string in host bytes. Nulls inside
     *  the value become spaces and trailing nulls are omitted. */
    systemRequestData () {
        if (!this.sysreqMode || this.fields.length === 0) return new Uint8Array(0);
        const field = this.fields[0];
        const bytes = [];
        for (let i = 1; i <= field.length; i++)
            bytes.push(this.cells[(field.start + i) % this.size].byte);
        while (bytes.length > 0 && bytes.at(-1) === 0x00) bytes.pop();
        return Uint8Array.from(bytes, byte => byte === 0x00 ? 0x40 : byte);
    }

    endSystemRequest () {
        const saved = this.sysreqLineSnapshot;
        if (!saved) {
            this.sysreqMode = false;
            return false;
        }
        for (let i = 0; i < saved.cells.length; i++)
            this.cells[saved.start + i] = Object.assign(new Cell(), saved.cells[i]);
        this.fields = saved.fields;
        this.nextFormatOrder = saved.nextFormatOrder;
        this.cursor = saved.cursor;
        this.writeAddress = saved.writeAddress;
        this.homeAddress = saved.homeAddress;
        this.keyboardLocked = saved.keyboardLocked;
        this.insertMode = saved.insertMode;
        this.activeAttr = saved.activeAttr;
        this.extendedAttr = saved.extendedAttr;
        this.sysreqLineSnapshot = null;
        this.sysreqMode = false;
        this.recalcAttributes();
        return true;
    }

    /** Apply the local state changes of the 5250 Error Reset key. Reset
     *  releases an ordinary keyboard inhibit. When cancelling System
     *  Request, restoring its saved screen also restores the pre-request
     *  keyboard state. */
    resetOperatorState () {
        this.alarm = false;
        this.insertMode = false;
        this.keyboardLocked = false;
        this.autoEnterRequested = false;
        this.pendingPointerAid = null;
        this.pointerMarker = null;
        this.clearErrorMode();
        if (this.sysreqMode) this.endSystemRequest();
    }

    allocateFormatOrder () {
        return this.nextFormatOrder++;
    }

    /** Apply a host keyboard-unlock transition and its ENPTUI side
     *  effect. Selection flag3 bit 0x80 asks the terminal to clear every
     *  cursorable choice whenever the host unlocks input. */
    unlockKeyboard ({ deselectChoices = true } = {}) {
        this.keyboardLocked = false;
        if (!deselectChoices) return;
        for (const construct of this.enptui.all) {
            if (!construct.deselectOnUnlock || !construct.items) continue;
            for (let i = 0; i < construct.items.length; i++) {
                const item = construct.items[i];
                if (item.nonCursorable) continue;
                item.selected = false;
                const position = construct.itemPositions?.[i];
                const anchorIdx = position?.anchorIdx;
                if (Number.isInteger(anchorIdx) && anchorIdx >= 0) {
                    const byte = construct.choiceAttrs?.[3] ?? 0x20;
                    const cell = this.cells[anchorIdx];
                    cell.byte = byte;
                    cell.glyph = ' ';
                    cell.attributePlace = true;
                    cell.attr = ATTR_BASE[byte] ?? this.activeAttr;
                }
                const indicatorIdx = position?.indicatorIdx;
                if (Number.isInteger(indicatorIdx) && indicatorIdx >= 0) {
                    const byte = construct.single ? 0x4B : 0x40;
                    this.cells[indicatorIdx].byte = byte;
                    this.cells[indicatorIdx].glyph = this.ebcdic.toChar(byte);
                }
            }
        }
    }

    saveScreen (region = null, { sessionState = null } = {}) {
        const saved = {
            cells: this.cells.map(c => ({ ...c })),
            fields: this.fields.map(f => ({
                ...f,
                fcws: f.fcws.map(pair => [...pair]),
            })),
            cursor: this.cursor,
            writeAddress: this.writeAddress,
            pendingCursor: this.pendingCursor,
            pendingInsertAddress: this.pendingInsertAddress,
            pendingMoveAddress: this.pendingMoveAddress,
            homeAddress: this.homeAddress,
            keyboardLocked: this.keyboardLocked,
            messageLight: this.messageLight,
            alarm: this.alarm,
            insertMode: this.insertMode,
            autoEnterRequested: this.autoEnterRequested,
            pendingPointerAid: this.pendingPointerAid ? { ...this.pendingPointerAid } : null,
            queuedPointerAid: this.queuedPointerAid,
            pointerMarker: this.pointerMarker ? { ...this.pointerMarker } : null,
            sysreqMode: !!this.sysreqMode,
            errorMode: !!this.errorMode,
            errorHelpMode: !!this.errorHelpMode,
            errorHelpResumeLocked: this.errorHelpResumeLocked,
            activeAttr: { ...this.activeAttr },
            extendedAttr: this.extendedAttr ? { ...this.extendedAttr } : null,
            soh: { ...this.soh, pfBytes: [...this.soh.pfBytes] },
            nextFormatOrder: this.nextFormatOrder,
            enptui: this.enptui.snapshot(),
            currentEnptuiWindowAddress: this.currentEnptuiWindowAddress,
            rows: this.rows,
            cols: this.cols,
            region: region ? { ...region } : null,
            sessionState: sessionState ? structuredClone(sessionState) : null,
        };
        this.savedScreen = saved;

        const id = this.nextSavedScreenId;
        this.nextSavedScreenId = (id + 1) >>> 0;
        if (this.nextSavedScreenId === 0) this.nextSavedScreenId = 1;
        this.savedScreens.set(id, saved);
        while (this.savedScreens.size > 32)
            this.savedScreens.delete(this.savedScreens.keys().next().value);

        return Uint8Array.of(
            0x49, 0x54, 0x35, 0x32,
            (id >>> 24) & 0xFF, (id >>> 16) & 0xFF,
            (id >>> 8) & 0xFF, id & 0xFF,
        );
    }

    restoreScreen (token = null) {
        const saved = token?.length
            ? this.savedScreens.get(this.#savedScreenId(token))
            : this.savedScreen;
        if (!saved) return false;
        this.lastRestoredSessionState = saved.sessionState
            ? structuredClone(saved.sessionState)
            : null;
        const previousCells = saved.region ? this.cells : null;
        this.rows = saved.rows ?? this.rows;
        this.cols = saved.cols ?? this.cols;
        this.fields = saved.fields.map(f => ({
            ...f,
            fcws: f.fcws.map(pair => [...pair]),
        }));
        const fieldsByStart = new Map(this.fields.map(field => [field.start, field]));
        const sourceCells = previousCells?.length === saved.cells.length
            ? previousCells.map(c => ({ ...c }))
            : saved.cells;
        if (previousCells?.length === saved.cells.length) {
            const { row, col, width, depth } = saved.region;
            for (let r = 0; r < depth; r++) {
                const start = (row - 1 + r) * this.cols + col - 1;
                for (let c = 0; c < width; c++)
                    sourceCells[start + c] = saved.cells[start + c];
            }
        }
        this.cells = sourceCells.map(o => {
            const cell = Object.assign(new Cell(), o);
            if (o.field) cell.field = fieldsByStart.get(o.field.start) ?? null;
            return cell;
        });
        this.cursor = saved.cursor;
        this.writeAddress = saved.writeAddress ?? saved.cursor;
        this.pendingCursor = saved.pendingCursor;
        this.pendingInsertAddress = saved.pendingInsertAddress ?? -1;
        this.pendingMoveAddress = saved.pendingMoveAddress ?? -1;
        this.homeAddress = saved.homeAddress ?? 0;
        this.keyboardLocked = saved.keyboardLocked;
        this.messageLight = saved.messageLight;
        this.alarm = saved.alarm ?? false;
        this.insertMode = saved.insertMode;
        this.autoEnterRequested = saved.autoEnterRequested ?? false;
        this.pendingPointerAid = saved.pendingPointerAid ? { ...saved.pendingPointerAid } : null;
        this.queuedPointerAid = saved.queuedPointerAid ?? null;
        this.pointerMarker = saved.pointerMarker ? { ...saved.pointerMarker } : null;
        this.sysreqMode = saved.sysreqMode ?? false;
        this.errorMode = saved.errorMode ?? false;
        this.errorHelpMode = saved.errorHelpMode ?? false;
        this.errorHelpResumeLocked = saved.errorHelpResumeLocked ?? null;
        this.activeAttr = { ...saved.activeAttr };
        this.extendedAttr = saved.extendedAttr ? { ...saved.extendedAttr } : null;
        this.soh = { ...saved.soh, pfBytes: [...saved.soh.pfBytes] };
        this.nextFormatOrder = saved.nextFormatOrder
            ?? Math.max(-1,
                ...this.fields.map(field => field.formatOrder ?? -1),
                ...saved.enptui.map(construct => construct.formatOrder ?? -1)) + 1;
        this.enptui.restore(saved.enptui);
        this.currentEnptuiWindowAddress = saved.currentEnptuiWindowAddress ?? null;
        this.recalcAttributes();
        return true;
    }

    #savedScreenId (token) {
        if (token.length !== 8
            || token[0] !== 0x49 || token[1] !== 0x54
            || token[2] !== 0x35 || token[3] !== 0x32) return -1;
        return ((token[4] << 24) | (token[5] << 16)
            | (token[6] << 8) | token[7]) >>> 0;
    }

    /** Record the latest SOH order's bookkeeping bits. */
    startOfHeader (opts = {}) {
        this.soh = {
            cursorMoveToInput: !!opts.cursorMoveToInput,
            resequence: opts.resequence ?? 0,
            errRow:   opts.errRow  ?? 0,
            pfBytes:  opts.pfBytes ?? [0x00, 0x00, 0x00],
        };
    }

    /** SOH bytes 5-7 select PF keys whose response is cursor+AID only.
     *  They do not disable the key. IBM stores PF24..17 in byte 5,
     *  PF16..9 in byte 6 and PF8..1 in byte 7. */
    isSohShortReadPf (n) {
        if (n < 1 || n > 24) return false;
        const byteIdx = 2 - (((n - 1) / 8) | 0);
        const bit = (n - 1) % 8;
        return (this.soh.pfBytes[byteIdx] & (1 << bit)) !== 0;
    }

    /** Retained presentation hook for a future DBCS/NLS plane. The SBCS
     *  parser rejects WEA before reaching this method. */
    setExtendedAttr (type, value) {
        this.extendedAttr = { type, value };
    }

    /** Plain EBCDIC data byte from the WTD stream: overwrite the current
     *  display position, inherit the active attribute pen, and advance.
     *  Existing attribute places are not skipped: a later WTD is allowed
     *  to replace an attribute from an earlier write. */
    placeByte (b) {
        if (this.writeAddress < 0 || this.writeAddress >= this.size)
            throw new RangeError('5250 write exceeds end of display');
        this.enptui.occludeInactiveAt(this.writeAddress, this.cols);
        const cell = this.cells[this.writeAddress];
        cell.byte = b;
        cell.glyph = this.ebcdic.toChar(b);
        cell.attributePlace = false;
        cell.startField = false;
        cell.attr = this.activeAttr;          // running pen
        cell.extAttr = this.extendedAttr;     // inherit WEA pen, may be null
        this.#advanceWrite();
    }

    /** A 0x20-0x3F byte in the WTD stream marks an attribute place: the
     *  byte is stored, that cell becomes non-display, the running pen
     *  is updated, and we advance. Any pending WEA extension is dropped
     *  - a basic attribute resets the extended pen, per IBM 5250 ref.
     *
     *  Note: no eager forward propagation here. The full attribute
     *  inheritance pass runs once per WTD record via recalcAttributes()
     *  (called from InboundParser at WTD end). That centralised walk
     *  correctly handles all orderings of SF / placeAttribute / RA /
     *  EA, including SF orders that arrive AFTER a placeAttribute (the
     *  case where eager propagation would leave stale attr values on
     *  cells that should have inherited the SF's attribute byte). */
    placeAttribute (b) {
        if (this.writeAddress < 0 || this.writeAddress >= this.size)
            throw new RangeError('5250 attribute write exceeds end of display');
        this.enptui.occludeInactiveAt(this.writeAddress, this.cols);
        const cell = this.cells[this.writeAddress];
        const desc = ATTR_BASE[b] ?? DEFAULT_ATTR_DESC;
        cell.byte = b;
        cell.attributePlace = true;
        // Do NOT set startField here - that flag is reserved for SF
        // order attribute places (see addField). Setting it on every
        // inline attribute byte would create spurious field boundaries
        // for nullModifiedFields() and friends.
        cell.attr = desc;
        cell.glyph = ' ';
        cell.extAttr = null;
        this.activeAttr   = desc;             // pen update
        this.extendedAttr = null;             // drop WEA pen
        this.#advanceWrite();
    }

    repeatToAddress (row, col, byte) {
        const target = this.#index(row, col);
        if (target < this.writeAddress)
            throw new RangeError('5250 RA target precedes current write address');
        const filler = byte & 0xFF;
        const fillGlyph = filler >= 0x40 ? this.ebcdic.toChar(filler) : ' ';
        const fillerIsAttr = isAttribute(filler);
        const fillerAttr   = fillerIsAttr ? (ATTR_BASE[filler] ?? DEFAULT_ATTR_DESC) : null;

        for (let i = this.writeAddress; i <= target; i++) {
            this.enptui.occludeInactiveAt(i, this.cols);
            const cell = this.cells[i];
            if (fillerIsAttr) {
                cell.byte = filler;
                cell.attributePlace = true;
                // Preserve an existing SF marker at its format-table
                // anchor. Every other repeated attribute is inline.
                cell.attr = fillerAttr;
                cell.glyph = ' ';
                cell.extAttr = null;
                this.activeAttr = fillerAttr;
            } else {
                // RA is a write, not a fill-only-if-empty operation. It
                // must replace old inline attributes and SF presentation
                // bytes just like an ordinary data byte does. The field
                // itself remains in the independent format table.
                cell.byte = filler;
                cell.glyph = fillGlyph;
                cell.attributePlace = false;
                cell.startField = false;
                cell.attr = this.activeAttr;       // inherit running pen
                cell.extAttr = this.extendedAttr;
            }
        }
        if (fillerIsAttr) this.extendedAttr = null;
        this.writeAddress = target + 1;
    }

    eraseToAddress (row, col, planes = [0x00]) {
        const target = this.#index(row, col);
        if (target < this.writeAddress)
            throw new RangeError('5250 EA target precedes current write address');
        const eraseDisplay = planes.some(plane => plane === 0x00 || plane === 0xFF);
        if (eraseDisplay) {
            for (let i = this.writeAddress; i <= target; i++) {
                this.enptui.occludeInactiveAt(i, this.cols);
                this.cells[i].reset();
            }
        }
        this.writeAddress = target + 1;
    }

    /** Clear only the character presentation plane inside a rectangle while
     *  leaving the independently maintained field-format table intact. */
    clearPresentationRect (topRow, leftCol, height, width) {
        if (!Number.isInteger(topRow) || !Number.isInteger(leftCol)
            || !Number.isInteger(height) || !Number.isInteger(width)
            || topRow < 1 || leftCol < 1 || height < 0 || width < 0
            || topRow + height - 1 > this.rows
            || leftCol + width - 1 > this.cols) {
            throw new RangeError('invalid 5250 presentation rectangle');
        }

        for (let row = topRow - 1; row < topRow - 1 + height; row++) {
            for (let col = leftCol - 1; col < leftCol - 1 + width; col++) {
                const address = row * this.cols + col;
                this.enptui.occludeInactiveAt(address, this.cols);
                const cell = this.cells[address];
                cell.byte = 0x00;
                cell.glyph = ' ';
                cell.extAttr = null;
                // A Start Field belongs to the format table, not to the
                // character plane. Ordinary inline attributes do not.
                if (!cell.startField) cell.attributePlace = false;
            }
        }
        this.recalcAttributes();
    }

    setWriteAddress (row, col) { this.writeAddress = this.#index(row, col); }
    setWriteAddressIndex (index) {
        if (index < -1 || index >= this.size)
            throw new RangeError(`Invalid 5250 write address ${index}`);
        this.writeAddress = index;
    }
    // Compatibility alias retained for parser-era consumers.
    setCursor (row, col) { this.setWriteAddress(row, col); }
    setCursorBeforeStart () { this.writeAddress = -1; }
    beginWriteToDisplay ({ retainWriteAddress = false } = {}) {
        // Every ordinary WTD begins at the first presentation-space
        // position.  SBA orders may move it afterward.  WEC is the sole
        // exception: its temporary message-line writer is positioned by
        // beginErrorLine() before the WTD body is decoded.
        if (!retainWriteAddress) this.writeAddress = 0;
        this.pendingInsertAddress = -1;
        this.pendingMoveAddress = -1;
    }

    setPendingInsert (insertCursor, row, col) {
        const address = this.#index(row, col);
        if (insertCursor) {
            this.pendingInsertAddress = address;
            this.homeAddress = address;
        } else {
            this.pendingMoveAddress = address;
        }
    }

    applyWcc2Cursor (cc1) {
        const retainCursor = (cc1 & 0x40) !== 0;
        if (this.pendingMoveAddress >= 0) {
            this.pendingCursor = this.pendingMoveAddress;
        } else if (!retainCursor) {
            this.pendingCursor = this.pendingInsertAddress >= 0
                ? this.pendingInsertAddress
                : (this.firstFocusable() ?? this.homeAddress);
        }
        this.pendingInsertAddress = -1;
        this.pendingMoveAddress = -1;
    }

    homePosition () {
        const field = this.logicalField(this.fieldAt(this.homeAddress));
        if (field && !field.bypass) return this.homeAddress;
        return this.firstFocusable();
    }

    addField ({ attr, length, ffw0, ffw1, fcws }) {
        // SF order layout per IBM 5250 Functions Reference §3:
        //
        //     0x1D <FFW0> [<FFW1> <FCW pairs>...] <attr> <length-hi> <length-lo>
        //
        // The `length` field is **the number of data character positions,
        // EXCLUSIVE of the leading attribute byte**. So `length=2` means
        // 1 attribute cell + 2 data cells (total 3 cells on screen).
        // Confirmed against pub400's PDM Opt field (length=2, accepts
        // 2-digit options like 14, 15, 24) and Library field (length=10,
        // shows "BENCZ1" + 4 nulls in the dump).
        //
        // We follow the IBM convention: `length` is the count of data
        // cells exclusive of the leading attribute byte.
        const start = this.writeAddress;
        if (length <= 0 || length >= this.size || start + length >= this.size)
            throw new RangeError(`Invalid 5250 field length ${length}`);
        if (!this.fields.some(existing => existing.start === start)
            && this.fields.length >= 500)
            throw new RangeError('5250 field-format table exceeds 500 fields');
        const desc  = ATTR_BASE[attr] ?? DEFAULT_ATTR_DESC;
        const existing = this.fields.find(candidate => candidate.start === start);
        const field = new Field(start, { length, attr, ffw0, ffw1, fcws });
        field.formatOrder = existing?.formatOrder ?? this.allocateFormatOrder();
        this.#validateFieldDefinition(field);
        this.fields = this.fields.filter(existing => existing.start !== start);
        this.fields.push(field);
        this.fields.sort((a, b) => a.start - b.start);

        if (start >= 0) {
            this.enptui.occludeInactiveAt(start, this.cols);
            const attrCell = this.cells[start];
            attrCell.byte = attr;
            attrCell.attributePlace = true;
            attrCell.startField = true;
            attrCell.attr = desc;
            attrCell.glyph = ' ';
            // Tag the attr cell with the field reference too. fieldAt()
            // still uses the `idx > f.start` test so the attr cell isn't
            // considered "inside" the field for input purposes, but
            // recalcAttributes() needs cell.field to identify SF starts.
            attrCell.field = field;
        }

        // Force-overwrite every data cell that belongs to this field.
        // The host can re-WTD without a Clear Unit in between, leaving
        // stale `attributePlace` flags from a previous SF in our cells;
        // honouring those flags would make the new field end early.
        // We DO NOT extend beyond the field's last data cell - cells at
        // positions > start+length are managed by the global attribute
        // inheritance pass (recalcAttributes) once per record.
        for (let i = 1; i <= length; i++) {
            const idx = (start + i) % this.size;
            this.enptui.occludeInactiveAt(idx, this.cols);
            const c = this.cells[idx];
            c.attributePlace = false;
            c.startField     = false;
            c.attr           = desc;
            c.field          = field;
        }

        this.activeAttr = desc;
        this.#advanceWrite();
    }

    #validateFieldDefinition (field) {
        if ((field.signedNumeric || field.modulus) && field.length < 2)
            throw new RangeError('invalid 5250 numeric-check field length');
        if (field.modulus && field.length > 33)
            throw new RangeError('5250 modulus field exceeds 33 positions');
        if (field.ccsid && (field.length < 2 || field.length % 2 !== 0))
            throw new RangeError('tagged-CCSID field length must be even');
        if (field.maxReturnLength && field.maxReturnLength % 2 !== 0)
            throw new RangeError('tagged-CCSID maximum return length must be even');

        const mandatoryFill = field.adjust === Adjust.MANDATORY;
        const rightAdjust = field.adjust === Adjust.RIGHT_ZERO
            || field.adjust === Adjust.RIGHT_BLANK;
        if (field.continued) {
            if (![1, 2, 3].includes(field.continuedKind)
                || mandatoryFill || field.modulus || field.signedNumeric
                || rightAdjust || field.resequence) {
                throw new RangeError('invalid 5250 continued-field definition');
            }
            const firstData = field.start + 1;
            const lastData = field.start + field.length;
            if ((firstData / this.cols | 0) !== (lastData / this.cols | 0))
                throw new RangeError('5250 continued-field segment crosses a row');

            // Continued segments form a chain in field-format-table order,
            // not in presentation-space address order.  Multiple vertical
            // CNTFLD fields may overlap the same rows at different columns;
            // looking at the physically preceding field then links the two
            // independent chains together.
            const previous = this.fields
                .filter(existing => (existing.formatOrder ?? -1) < field.formatOrder)
                .sort((a, b) => (b.formatOrder ?? -1) - (a.formatOrder ?? -1))[0];
            if (field.continuedFirst) {
                // A first segment starts a new chain regardless of what
                // preceded it. A middle/last segment must immediately
                // continue an open chain.
            } else if (!previous?.continued
                || previous.continuedLast
                || (previous.continuedKind !== 1 && previous.continuedKind !== 3)) {
                throw new RangeError('orphaned 5250 continued-field segment');
            }
        }

        if (field.wordWrap) {
            if (mandatoryFill || field.modulus || field.signedNumeric
                || rightAdjust || field.ioOnly
                || field.shift === Shift.NUMERIC_ONLY
                || field.shift === Shift.DIGITS_ONLY || field.dup) {
                throw new RangeError('invalid 5250 word-wrap field definition');
            }
            const firstData = field.start + 1;
            const lastData = field.start + field.length;
            if ((firstData / this.cols | 0) === (lastData / this.cols | 0))
                field.wordWrap = false;
        }

        if (field.cursorProgress && this.soh?.resequence)
            throw new RangeError('cursor progression conflicts with field resequencing');

        // Highlight-on-entry is inapplicable to bypass fields. Invisible
        // cursors are only meaningful for I/O fields; keep the field but
        // suppress the invalid presentation request.
        if (field.highlightAttr && (field.bypass
            || (field.cursorInvisible && !field.ioOnly))) {
            field.highlightAttr = 0;
            field.cursorInvisible = false;
        }
    }

    resetMdtFlags (nonBypassOnly = false) {
        for (const f of this.fields) {
            if (!nonBypassOnly || !f.bypass) f.modified = false;
        }
        if (!nonBypassOnly) {
            for (const construct of this.enptui.all) construct.modified = false;
        }
    }

    clearNonBypassFields (modifiedOnly = false) {
        for (const f of this.fields) {
            if (f.continued && !f.continuedFirst) continue;
            const logical = this.logicalField(f);
            if (logical.bypass || (modifiedOnly && !logical.modified)) continue;
            for (const idx of this.#fieldDataPositions(logical, false)) {
                const cell = this.cells[idx];
                cell.byte = 0x00;
                cell.glyph = ' ';
            }
            // IBM eraseField() raises MDT. WCC1 combinations which also
            // reset MDT do so in the following operation.
            this.#markFieldChainModified(logical);
        }
    }

    roll (top, bottom, distance, down) {
        // Inclusive row range, 1-based. ROLL shifts the retained rows;
        // it does not rotate discarded rows into the newly exposed area.
        const t = (top - 1) | 0;
        const b = (bottom - 1) | 0;
        if (t < 0 || b >= this.rows || b <= t
            || distance < 0 || distance > b - t) return false;
        if (distance === 0) return true;
        const span = b - t + 1;
        const rows = [];
        for (let r = t; r <= b; r++)
            rows.push(this.cells.slice(r * this.cols, (r + 1) * this.cols)
                .map(cell => Object.assign(new Cell(), cell)));

        if (down) {
            for (let offset = span - 1; offset >= distance; offset--) {
                const row = rows[offset - distance];
                for (let col = 0; col < this.cols; col++)
                    this.cells[(t + offset) * this.cols + col] = row[col];
            }
        } else {
            for (let offset = 0; offset < span - distance; offset++) {
                const row = rows[offset + distance];
                for (let col = 0; col < this.cols; col++)
                    this.cells[(t + offset) * this.cols + col] = row[col];
            }
        }
        return true;
    }

    // ---- input (user typing) -------------------------------------------

    /** Find the field that contains absolute buffer index `idx`.
     *  Field occupies `f.start` (attribute cell) + `f.length` data
     *  cells, so the data range is (f.start, f.start + f.length]. */
    fieldAt (idx) {
        for (const f of this.fields) {
            const end = (f.start + f.length + 1) % this.size;
            if (f.start < end) {
                if (idx > f.start && idx < end) return f;
            } else {
                if (idx > f.start || idx < end) return f;
            }
        }
        return null;
    }

    /** Return every physical segment belonging to the same logical field.
     *  A malformed/incomplete continued-field definition is deliberately
     *  isolated to its current segment so input cannot spill into an
     *  unrelated field. */
    fieldChain (field) {
        if (!field?.continued) return field ? [field] : [];
        // SF definition order owns continuation. Address order is retained
        // by this.fields for fieldAt(), but is insufficient here because
        // two column-oriented continued fields can be physically interleaved.
        const ordered = [...this.fields].sort((a, b) => {
            const orderA = a.formatOrder ?? Number.MAX_SAFE_INTEGER;
            const orderB = b.formatOrder ?? Number.MAX_SAFE_INTEGER;
            return orderA - orderB || a.start - b.start;
        });
        const index = ordered.indexOf(field);
        if (index < 0) return [field];

        let first = index;
        while (first > 0 && !ordered[first].continuedFirst) {
            const previous = ordered[first - 1];
            if (!previous.continued || previous.continuedLast) return [field];
            first--;
        }
        if (!ordered[first].continuedFirst) return [field];

        const chain = [];
        for (let i = first; i < ordered.length; i++) {
            const segment = ordered[i];
            if (!segment.continued) break;
            chain.push(segment);
            if (segment.continuedLast) return chain;
        }
        return [field];
    }

    /** Resolve the physical segment to the first segment that owns the
     *  logical field's FFW/FCW semantics. */
    logicalField (field) {
        return this.fieldChain(field)[0] ?? field ?? null;
    }

    #fieldDataPositions (field, excludeSign = true) {
        const positions = [];
        for (const segment of this.fieldChain(field)) {
            let length = segment.length
                - (excludeSign && segment.signedNumeric ? 1 : 0);
            if (this.logicalField(field)?.ccsid) length = Math.floor(length / 2);
            for (let n = 1; n <= length; n++)
                positions.push((segment.start + n) % this.size);
        }
        return positions;
    }

    #markFieldChainModified (field) {
        for (const segment of this.fieldChain(field)) {
            segment.modified = true;
            if (segment.fer) segment.exited = false;
        }
    }

    /** Reflow the word containing `changedAt` at every physical line or
     *  continued-segment boundary. Null padding is inserted before a word
     *  that would otherwise be split; if the reflow cannot fit, the field
     *  is left exactly as it was. */
    applyWordWrap (field, changedAt) {
        const chain = this.fieldChain(field);
        if (!chain.some(segment => segment.wordWrap)) return false;
        const positions = this.#fieldDataPositions(field, false);
        const changedOffset = positions.indexOf(changedAt);
        if (changedOffset < 0 || positions.length === 0) return false;

        const values = positions.map(idx => this.cells[idx].byte);
        let wrapStart = changedOffset;
        while (wrapStart > 0) {
            const previous = values[wrapStart - 1];
            if (previous === 0x00 || previous === EBC_SPACE) break;
            wrapStart--;
        }

        // Collapse editing nulls in the affected suffix while preserving a
        // single null separator between adjacent non-blank text runs.
        let i = values.length - 1;
        while (i >= wrapStart && values[i] === 0x00) values.splice(i--, 1);
        let sawNull = false;
        let sawSpace = false;
        while (i >= wrapStart) {
            const byte = values[i];
            if (byte === EBC_SPACE) {
                sawSpace = true;
                sawNull = false;
            } else if (byte === 0x00) {
                values.splice(i, 1);
                if (!sawSpace) sawNull = true;
            } else {
                if (sawNull) values.splice(i + 1, 0, 0x00);
                sawNull = false;
                sawSpace = false;
            }
            i--;
        }

        const boundaries = [];
        if (chain.length > 1) {
            let end = -1;
            for (const segment of chain.slice(0, -1)) {
                end += segment.length;
                boundaries.push({ end, start: end - segment.length + 1 });
            }
        } else {
            for (let n = 0; n < positions.length - 1; n++) {
                if (positions[n] % this.cols === this.cols - 1)
                    boundaries.push({ end: n, start: Math.max(0, n - this.cols + 1) });
            }
        }

        let cursorOffset = positions.indexOf(this.cursor);
        for (const boundary of boundaries) {
            if (boundary.end < wrapStart) continue;
            if (boundary.end >= values.length) break;
            let breakAt = boundary.end;
            while (values[breakAt] !== 0x00 && values[breakAt] !== EBC_SPACE) {
                if (breakAt === boundary.start || breakAt === 0) {
                    breakAt = boundary.end;
                    break;
                }
                breakAt--;
            }
            if (breakAt === boundary.end) continue;
            const count = boundary.end - breakAt;
            const insertAt = breakAt + 1;
            values.splice(insertAt, 0, ...new Array(count).fill(0x00));
            if (cursorOffset >= 0 && insertAt < cursorOffset) cursorOffset += count;
        }

        if (values.length > positions.length) return false;
        for (let n = 0; n < positions.length; n++) {
            const byte = values[n] ?? 0x00;
            const cell = this.cells[positions[n]];
            cell.byte = byte;
            cell.glyph = byte === 0x00 ? ' ' : this.ebcdic.toChar(byte);
        }
        if (cursorOffset >= 0)
            this.cursor = positions[Math.min(cursorOffset, positions.length - 1)];
        return true;
    }

    /** Type one EBCDIC byte at the current cursor. Returns true if it
     *  was accepted (we were inside an unprotected, non-bypass field). */
    typeByte (b) {
        const here = this.cursor;
        const cell = this.cells[here];
        const physicalField = this.fieldAt(here);
        const f = this.logicalField(physicalField);
        const r = (here / this.cols | 0) + 1;
        const c = (here % this.cols) + 1;
        if (!physicalField || !f) {
            debug.warn(`typeByte FAIL at idx=${here} (r${r},c${c}): no field; ` +
                `cell.attributePlace=${cell.attributePlace} cell.field=${cell.field ? 'set' : 'null'}`);
            this.alarm = true;
            return false;
        }
        if (f.bypass) {
            debug.warn(`typeByte FAIL at idx=${here} (r${r},c${c}): field is bypass; ` +
                `field.start=${f.start} field.length=${f.length} ffw0=0x${f.ffw0.toString(16)}`);
            this.alarm = true;
            return false;
        }
        if (f.ioOnly) {
            this.alarm = true;
            return false;
        }
        if (cell.attributePlace) {
            debug.warn(`typeByte FAIL at idx=${here} (r${r},c${c}): cell is attributePlace; ` +
                `field.start=${f.start} field.length=${f.length}`);
            this.alarm = true;
            return false;
        }
        // Monocase fields (FFW byte 2 bit 0x20) force typed lowercase
        // letters to their uppercase EBCDIC equivalent before storing,
        // matching the IBM 5250 reference.
        // CP037/CP1047 share the lowercase a-i = 0x81-0x89, j-r =
        // 0x91-0x99, s-z = 0xA2-0xA9; uppercase counterparts are
        // 0xC1-0xC9, 0xD1-0xD9, 0xE2-0xE9. Adding 0x40 maps each block.
        if (f.monocase) {
            if      (b >= 0x81 && b <= 0x89) b += 0x40;
            else if (b >= 0x91 && b <= 0x99) b += 0x40;
            else if (b >= 0xA2 && b <= 0xA9) b += 0x40;
        }

        // Shift enforcement. Real 5250 hardware refuses keys that don't
        // match the field's data-shift specification (FFW byte 0, low
        // nibble). Reject early so the host never sees, e.g., letters
        // in a digits-only field.
        if (!acceptsByShift(b, f.shift)) {
            debug.warn(`typeByte FAIL: byte 0x${b.toString(16)} rejected by shift=${f.shift}`);
            this.alarm = true;
            return false;
        }

        const positions = this.#fieldDataPositions(f);
        const offset = positions.indexOf(here);
        if (offset < 0) {
            this.alarm = true;
            return false;
        }

        if (this.insertMode) {
            const last = positions[positions.length - 1];
            if (this.cells[last].byte !== 0x00) {
                this.alarm = true;
                return false;
            }
            for (let n = positions.length - 1; n > offset; n--) {
                const dstIdx = positions[n];
                const srcIdx = positions[n - 1];
                this.cells[dstIdx].byte = this.cells[srcIdx].byte;
                this.cells[dstIdx].glyph = this.cells[srcIdx].glyph;
            }
        }

        cell.byte = b;
        cell.glyph = this.ebcdic.toChar(b);
        // Don't touch cell.attr - it was set by the field's SF and the
        // running pen would inherit it from the field's start attribute
        // anyway.
        this.#markFieldChainModified(f);
        if (offset === positions.length - 1) {
            if (f.autoEnter && !f.fer) this.autoEnterRequested = true;
            else if (f.fer) {
                for (const segment of this.fieldChain(f)) segment.exited = true;
                this.cursor = here;
            }
            else {
                const first = this.fieldChain(f)[0];
                const next = this.nextInputAfter(first.start);
                if (next) this.cursor = (next.start + 1) % this.size;
            }
        } else {
            this.cursor = positions[offset + 1];
        }
        this.applyWordWrap(f, here);
        return true;
    }

    /** Type a browser Unicode character without losing it through the
     *  selected SBCS translation when the host tagged the field with a
     *  CCSID. Ordinary fields keep the existing EBCDIC path. */
    typeCharacter (character) {
        const here = this.cursor;
        const field = this.logicalField(this.fieldAt(here));
        const byte = this.ebcdic.fromCharCode(character.charCodeAt(0));
        if (!this.typeByte(byte)) return false;
        if (field?.ccsid) this.cells[here].glyph = character;
        return true;
    }

    /** Enforce the current field plus the screen-wide mandatory-entry rule
     *  before an AID leaves. Mandatory fill and self-check belong only to
     *  the field containing the cursor; mandatory entry is screen-wide and
     *  becomes active after the operator has modified any input field. */
    validateForAid ({ skipMandatoryEntry = false } = {}) {
        const current = this.logicalField(this.fieldAt(this.cursor));
        if (current && !current.bypass) {
            const departure = this.#fieldDepartureError(current);
            if (departure) return departure;
            const needsExplicitExit = current.modified && !current.autoEnter
                && (current.signedNumeric
                    || current.adjust === Adjust.RIGHT_ZERO
                    || current.adjust === Adjust.RIGHT_BLANK);
            if (needsExplicitExit
                && this.fieldChain(current).some(segment => !segment.exited))
                return { field: current, reason: 'Field Exit' };
        }

        const masterModified = this.fields.some(field => field.modified)
            || this.enptui.all.some(construct => construct.modified);
        if (!skipMandatoryEntry && masterModified) {
            for (const field of this.fields) {
                if (field.bypass || (field.continued && !field.continuedFirst)) continue;
                if (field.mandatory && !this.fieldChain(field).some(segment => segment.modified))
                    return { field, reason: 'mandatory entry' };
            }
        }
        return null;
    }

    /** Validate an operator cursor move. Host-driven cursor placement does
     *  not use this path. Leaving a field may be refused by mandatory-fill
     *  or modulus checking, and successful field navigation completes FER. */
    moveCursorTo (target, { completeField = true } = {}) {
        if (this.keyboardLocked || !Number.isInteger(target)) return false;
        const destination = ((target % this.size) + this.size) % this.size;
        const current = this.logicalField(this.fieldAt(this.cursor));
        const next = this.logicalField(this.fieldAt(destination));
        if (current && current !== next) {
            const validation = this.#fieldDepartureError(current);
            if (validation) {
                this.cursor = (current.start + 1) % this.size;
                this.alarm = true;
                return false;
            }
            if (completeField)
                for (const segment of this.fieldChain(current)) segment.exited = true;
        }
        this.cursor = destination;
        return true;
    }

    #fieldDepartureError (field) {
        const positions = this.#fieldDataPositions(field, false);
        const nulls = positions.reduce((count, index) =>
            count + (this.cells[index].byte === 0x00 ? 1 : 0), 0);
        // A mandatory-fill field may remain completely untouched. Once it
        // is modified it must be either completely filled or completely
        // cleared; partial input is rejected.
        if (field.adjust === Adjust.MANDATORY && field.modified
            && nulls > 0 && nulls < positions.length)
            return { field, reason: 'mandatory fill' };
        if (field.modulus && !this.#validSelfCheck(field))
            return { field, reason: `valid Modulus ${field.modulus} check digit` };
        return null;
    }

    #validSelfCheck (field) {
        const bytes = this.#fieldDataPositions(field, false)
            .map(index => this.cells[index].byte);
        if (field.signedNumeric) bytes.pop();
        if (bytes.length <= 1) return true;
        const digits = bytes.map(byte => {
            const digit = byte & 0x0F;
            return digit <= 9 ? digit : 0;
        });
        if (digits.every(digit => digit === 0)) return true;
        const check = digits.pop();
        let sum = 0;
        if (field.modulus === 10) {
            let weight = 2;
            for (let i = digits.length - 1; i >= 0; i--) {
                let product = digits[i] * weight;
                if (product > 9) product -= 9;
                sum += product;
                weight = weight === 2 ? 1 : 2;
            }
        } else {
            let weight = 2;
            for (let i = digits.length - 1; i >= 0; i--) {
                sum += digits[i] * weight;
                weight = weight === 7 ? 2 : weight + 1;
            }
        }
        const remainder = sum % field.modulus;
        return remainder === 0 ? check === 0 : remainder + check === field.modulus;
    }

    /** Complete the current input field as the physical Field Exit key
     *  would: apply right adjustment/fill, satisfy FER, then tab onward. */
    fieldExit () {
        if (this.keyboardLocked) return false;
        const field = this.logicalField(this.fieldAt(this.cursor));
        if (!field || field.bypass) {
            this.alarm = true;
            return false;
        }

        const chain = this.fieldChain(field);
        const positions = this.#fieldDataPositions(field, false);
        const values = positions.map(idx => this.cells[idx].byte);

        if (field.mandatory && !field.modified) {
            this.alarm = true;
            return false;
        }
        const departure = this.#fieldDepartureError(field);
        if (departure) {
            this.alarm = true;
            this.cursor = (field.start + 1) % this.size;
            return false;
        }

        if (field.adjust === Adjust.RIGHT_ZERO
            || field.adjust === Adjust.RIGHT_BLANK
            || field.adjust === Adjust.MANDATORY) {
            let end = values.length;
            while (end > 0 && (values[end - 1] === 0x00 || values[end - 1] === EBC_SPACE)) end--;
            const content = values.slice(0, end);
            const pad = field.adjust === Adjust.RIGHT_BLANK ? EBC_SPACE : 0xF0;
            values.fill(pad);
            const offset = values.length - content.length;
            for (let i = 0; i < content.length; i++) values[offset + i] = content[i];
            for (let n = 0; n < values.length; n++) {
                const cell = this.cells[positions[n]];
                cell.byte = values[n];
                cell.glyph = this.ebcdic.toChar(values[n]);
            }
            this.#markFieldChainModified(field);
        }

        for (const segment of chain) segment.exited = true;
        if (field.autoEnter) this.autoEnterRequested = true;
        else {
            const next = this.nextInputAfter(chain[0].start);
            if (next) this.cursor = (next.start + 1) % this.size;
        }
        return true;
    }

    toggleInsertMode () {
        if (this.keyboardLocked) return false;
        this.insertMode = !this.insertMode;
        return true;
    }

    deleteChar () {
        if (this.keyboardLocked) return false;
        const field = this.logicalField(this.fieldAt(this.cursor));
        if (!field || field.bypass || field.ioOnly) {
            this.alarm = true;
            return false;
        }
        const positions = this.#fieldDataPositions(field);
        const offset = positions.indexOf(this.cursor);
        if (offset < 0) {
            this.alarm = true;
            return false;
        }
        for (let n = offset; n < positions.length - 1; n++) {
            this.cells[positions[n]].byte = this.cells[positions[n + 1]].byte;
            this.cells[positions[n]].glyph = this.cells[positions[n + 1]].glyph;
        }
        const end = positions[positions.length - 1];
        this.cells[end].byte = 0x00;
        this.cells[end].glyph = ' ';
        this.#markFieldChainModified(field);
        return true;
    }

    deleteWord () {
        if (this.keyboardLocked) return false;
        const field = this.logicalField(this.fieldAt(this.cursor));
        if (!field || field.bypass || field.ioOnly) {
            this.alarm = true;
            return false;
        }
        const positions = this.#fieldDataPositions(field);
        const offset = positions.indexOf(this.cursor);
        if (offset < 0) {
            this.alarm = true;
            return false;
        }

        const blank = index => {
            const byte = this.cells[positions[index]]?.byte ?? 0;
            return byte === 0x00 || byte === EBC_SPACE;
        };
        let end = offset;
        if (blank(end)) {
            while (end < positions.length && blank(end)) end++;
        } else {
            while (end < positions.length && !blank(end)) end++;
            while (end < positions.length && blank(end)) end++;
        }
        const count = Math.max(1, end - offset);
        for (let n = offset; n < positions.length; n++) {
            const source = n + count;
            const cell = this.cells[positions[n]];
            if (source < positions.length) {
                cell.byte = this.cells[positions[source]].byte;
                cell.glyph = this.cells[positions[source]].glyph;
            } else {
                cell.byte = 0x00;
                cell.glyph = ' ';
            }
        }
        this.#markFieldChainModified(field);
        this.applyWordWrap(field, this.cursor);
        return true;
    }

    eraseToEndOfField () {
        if (this.keyboardLocked) return false;
        const field = this.logicalField(this.fieldAt(this.cursor));
        if (!field || field.bypass || field.ioOnly) {
            this.alarm = true;
            return false;
        }
        const positions = this.#fieldDataPositions(field, false);
        const offset = positions.indexOf(this.cursor);
        if (offset < 0) {
            this.alarm = true;
            return false;
        }
        for (let n = offset; n < positions.length; n++) {
            this.cells[positions[n]].byte = 0x00;
            this.cells[positions[n]].glyph = ' ';
        }
        this.#markFieldChainModified(field);
        return true;
    }

    eraseInput () {
        if (this.keyboardLocked) return false;
        this.clearNonBypassFields(true);
        const home = this.firstFocusable();
        if (home !== null) this.cursor = home;
        return true;
    }

    eraseField () {
        if (this.keyboardLocked) return false;
        const field = this.logicalField(this.fieldAt(this.cursor));
        if (!field || field.bypass || field.ioOnly) {
            this.alarm = true;
            return false;
        }
        const positions = this.#fieldDataPositions(field, false);
        for (const index of positions) {
            this.cells[index].byte = 0x00;
            this.cells[index].glyph = ' ';
        }
        this.#markFieldChainModified(field);
        this.cursor = positions[0];
        return true;
    }

    /** Insert Field Mark or fill the remainder with DUP, then advance
     *  when the logical field has been completed. */
    insertDupOrFieldMark (duplicate) {
        if (this.keyboardLocked) return false;
        const field = this.logicalField(this.fieldAt(this.cursor));
        if (!field || field.bypass || field.ioOnly || !field.dup) {
            this.alarm = true;
            return false;
        }
        const positions = this.#fieldDataPositions(field, false);
        const offset = positions.indexOf(this.cursor);
        if (offset < 0) {
            this.alarm = true;
            return false;
        }
        const value = duplicate ? 0x1C : 0x1E;
        const end = duplicate ? positions.length : offset + 1;
        for (let n = offset; n < end; n++) {
            const cell = this.cells[positions[n]];
            cell.byte = value;
            cell.glyph = duplicate ? '✜' : '✞';
        }
        this.#markFieldChainModified(field);

        if (duplicate || offset === positions.length - 1) {
            for (const segment of this.fieldChain(field)) segment.exited = true;
            if (field.autoEnter) {
                // DUP completes the entire logical field at once. The
                // resulting Enter AID reports its final data position,
                // not the position where the operator pressed DUP.
                this.cursor = positions.at(-1);
                this.autoEnterRequested = true;
            }
            else {
                const next = this.nextInputAfter(field.start);
                if (next) this.cursor = (next.start + 1) % this.size;
            }
        } else {
            this.cursor = positions[offset + 1];
        }
        return true;
    }

    wordTab (backwards = false) {
        if (this.keyboardLocked) return false;
        const displayedAsSpace = index => {
            const cell = this.cells[index];
            return !cell || cell.attributePlace
                || cell.byte === 0x00 || cell.byte === EBC_SPACE;
        };
        const firstCharacter = index => !displayedAsSpace(index)
            && (index === 0 || displayedAsSpace((index - 1 + this.size) % this.size));

        // Word navigation is a presentation-space operation, not a
        // field operation. Protected labels and host text are valid word
        // targets too; scan cyclically from the cell after/before the
        // cursor until the next visible word boundary is found.
        for (let distance = 1; distance <= this.size; distance++) {
            const index = backwards
                ? (this.cursor - distance + this.size) % this.size
                : (this.cursor + distance) % this.size;
            if (!firstCharacter(index)) continue;
            this.cursor = index;
            return true;
        }
        return false;
    }

    fieldSignExit (negative) {
        if (this.keyboardLocked) return false;
        const field = this.logicalField(this.fieldAt(this.cursor));
        const numericMinus = field?.signedNumeric || field?.shift === Shift.NUMERIC_ONLY;
        const firstPosition = field ? this.#fieldDataPositions(field, false)[0] : -1;
        if (!field || field.bypass || field.ioOnly
            || (negative && (!numericMinus || field.continued))) {
            this.alarm = true;
            return false;
        }
        // Mandatory-entry is checked before Erase-to-End marks the field
        // modified. Field Plus/Minus at its first position is likewise an
        // empty departure, even when the host supplied an initial MDT.
        if (field.mandatory
            && (!field.modified || this.cursor === firstPosition)) {
            this.alarm = true;
            return false;
        }
        this.eraseToEndOfField();
        if (!this.fieldExit()) return false;

        const positions = this.#fieldDataPositions(field, false);
        if (field.signedNumeric) {
            const sign = positions.at(-1);
            this.cells[sign].byte = negative ? EBC_MINUS : 0x00;
            this.cells[sign].glyph = negative ? '-' : ' ';
        } else if (negative) {
            // Numeric-only fields carry their zoned sign in the final
            // field position, not on the last digit that happens to have
            // been typed. Field Minus may therefore zone a cleared final
            // position when the operator exits early.
            const digit = positions.at(-1);
            const byte = this.cells[digit].byte;
            this.cells[digit].byte = (byte & 0x0F) | 0xD0;
            this.cells[digit].glyph = this.ebcdic.toChar(this.cells[digit].byte);
        }
        this.#markFieldChainModified(field);
        return true;
    }

    /** Find the next unprotected non-bypass field whose start > `addr`
     *  (cyclic). Used by Tab navigation. */
    nextInputAfter (addr) {
        if (this.fields.length === 0) return null;
        const ordered = [...this.fields].sort((a, b) => a.start - b.start);
        for (const f of ordered)
            if (!f.bypass && (!f.continued || f.continuedFirst) && f.start > addr) return f;
        for (const f of ordered)
            if (!f.bypass && (!f.continued || f.continuedFirst)) return f;
        return null;
    }

    /** Collect every screen position the cursor can tab into, sorted by
     *  buffer index. Two sources contribute: SF input fields (first data
     *  cell, skipping bypass) and ENPTUI selectable items (radio button,
     *  checkbox, push-button — anything the host expects the user to
     *  navigate through). Push-buttons and unavailable items are still
     *  navigable so the user can read them; the activation handler
     *  decides whether toggling actually does anything.
     *
     *  For selection items the stop lands on the FIRST TEXT CELL (one
     *  past the indicator + space), so the cursor block highlights the
     *  item label and the user can read which row they are on. */
    #tabStops () {
        const stops = [];
        for (const f of this.fields) {
            if (f.bypass || (f.continued && !f.continuedFirst)) continue;
            stops.push((f.start + 1) % this.size);
        }
        for (const c of this.enptui.all) {
            if (!c.itemPositions) continue;
            for (let i = 0; i < c.itemPositions.length; i++) {
                if (c.items?.[i]?.nonCursorable) continue;
                if (!c.fieldAdvance && i > 0) continue;
                const pos = c.itemPositions[i];
                if (Number.isInteger(pos.textIdx)) stops.push(pos.textIdx);
            }
        }
        return stops.sort((a, b) => a - b);
    }

    /** Ordinary SFs and ENPTUI selection pseudo-fields share the same
     *  field-table numbering used by Cursor Progression FCWs. Standalone
     *  scroll bars occupy the host table too, but are deliberately absent
     *  from the standard cursor-progression list. */
    #standardFieldEntries () {
        const entries = [];
        for (const field of this.fields) {
            if (field.continued && !field.continuedFirst) continue;
            entries.push({ type: 'field', value: field });
        }
        for (const construct of this.enptui.all) {
            if (!['selectionField', 'menuBar', 'pushButtons'].includes(construct.kind)) continue;
            entries.push({ type: 'enptui', value: construct });
        }
        entries.sort((a, b) => {
            const orderA = a.value.formatOrder ?? Number.MAX_SAFE_INTEGER;
            const orderB = b.value.formatOrder ?? Number.MAX_SAFE_INTEGER;
            if (orderA !== orderB) return orderA - orderB;
            return (a.value.start ?? a.value.cursorAtStart)
                - (b.value.start ?? b.value.cursorAtStart);
        });
        return entries;
    }

    #entryCursor (entry, backwards = false) {
        if (entry.type === 'field') return (entry.value.start + 1) % this.size;
        const positions = entry.value.itemPositions ?? [];
        const indices = positions.map((_, index) => index)
            .filter(index => !entry.value.items?.[index]?.nonCursorable);
        if (!indices.length) return null;
        const index = backwards && entry.value.fieldAdvance
            ? indices[indices.length - 1]
            : indices[0];
        return positions[index]?.textIdx ?? null;
    }

    /** Locate the ENPTUI selectable item the cursor is currently on,
     *  if any. Used by the space-key handler to decide whether the
     *  press should toggle a selection vs. type a literal space. */
    enptuiItemAtAddress (address) {
        const r = (address / this.cols | 0) + 1;
        const c = (address % this.cols) + 1;
        for (const construct of this.enptui.frontToBack) {
            if (construct.kind === 'window') {
                const bounds = this.enptui.boundsOf(construct);
                if (bounds && r >= bounds.top && r <= bounds.bottom
                    && c >= bounds.left && c <= bounds.right) return null;
                continue;
            }
            if (!construct.itemPositions) continue;
            if (construct.kind !== 'selectionField'
                && construct.kind !== 'pushButtons'
                && construct.kind !== 'menuBar') continue;
            for (let i = 0; i < construct.itemPositions.length; i++) {
                const pos = construct.itemPositions[i];
                if (construct.items?.[i]?.nonCursorable) continue;
                if (pos.row !== r) continue;
                const width = pos.hitWidth ?? pos.slotWidth ?? construct.textSize ?? 1;
                const start = pos.hitCol ?? pos.col;
                if (c < start || c >= start + width) continue;
                return { construct, index: i };
            }
        }
        return null;
    }

    enptuiItemAtCursor () {
        return this.enptuiItemAtAddress(this.cursor);
    }

    /** Buffer index of the first place a host invite should park the
     *  cursor — used by Terminal.handleRecord when the host didn't
     *  send an IC order. Considers SF input fields AND ENPTUI items so
     *  screens that have only checkboxes / radios still place focus on
     *  the first item instead of leaving the cursor at (1,1). */
    firstFocusable () {
        const stops = this.#tabStops();
        return stops.length ? stops[0] : null;
    }

    /** Move to the first input position on or after the next display row. */
    newLine () {
        if (this.keyboardLocked) return false;
        const nextRow = (((this.cursor / this.cols) | 0) + 1) % this.rows;
        const rowStart = nextRow * this.cols;
        const containing = this.logicalField(this.fieldAt(rowStart));
        if (containing && !containing.bypass) {
            return this.moveCursorTo(rowStart);
        }
        const stops = this.#tabStops();
        if (stops.length === 0) return false;
        return this.moveCursorTo(stops.find(stop => stop >= rowStart) ?? stops[0]);
    }

    /** Move cursor to the next tab stop. If the field the cursor is in
     *  has a non-zero FCW 0x88 cursor-progression target, jump to that
     *  numbered field instead of the natural buffer-order next stop —
     *  this lets the host build non-sequential tab orders (data-entry
     *  forms often jump from CITY to ZIP and back to STATE, for
     *  instance). Cyclic when no explicit target is set. */
    tab () {
        const stops = this.#tabStops();
        if (stops.length === 0) return false;
        const current = this.logicalField(this.fieldAt(this.cursor));
        if (current && current.cursorProgress > 0) {
            // The 1-based target counts every standard field, including
            // bypass fields and ENPTUI selection pseudo-fields.
            const target = this.#standardFieldEntries()[current.cursorProgress - 1];
            if (target && (target.type !== 'field' || !target.value.bypass)) {
                const cursor = this.#entryCursor(target);
                if (cursor !== null) return this.moveCursorTo(cursor);
                return false;
            }
        }
        const next = stops.find(s => s > this.cursor);
        return this.moveCursorTo(next ?? stops[0]);
    }

    /** Reverse of tab() — used by Shift+Tab. */
    backTab () {
        const stops = this.#tabStops();
        if (stops.length === 0) return false;
        const current = this.logicalField(this.fieldAt(this.cursor));
        const entries = this.#standardFieldEntries();
        const hit = this.enptuiItemAtCursor();
        const currentEntry = hit
            ? entries.find(entry => entry.type === 'enptui' && entry.value === hit.construct)
            : entries.find(entry => entry.type === 'field' && entry.value === current);
        const currentNumber = currentEntry ? entries.indexOf(currentEntry) + 1 : 0;
        if (currentNumber > 0) {
            const source = entries.find(entry => entry.type === 'field'
                && !entry.value.bypass
                && entry.value.cursorProgress === currentNumber);
            if (source) {
                return this.moveCursorTo(this.#entryCursor(source, true));
            }
        }
        let prev = null;
        for (const s of stops) {
            if (s < this.cursor) prev = s;
            else break;
        }
        return this.moveCursorTo(prev ?? stops[stops.length - 1]);
    }

    backspace () {
        if (this.keyboardLocked) return false;
        const currentField = this.logicalField(this.fieldAt(this.cursor));
        if (!currentField || currentField.bypass || currentField.ioOnly) {
            this.alarm = true;
            return false;
        }
        const positions = this.#fieldDataPositions(currentField);
        const offset = positions.indexOf(this.cursor);
        if (offset <= 0) {
            this.alarm = true;
            return false;
        }
        this.cursor = positions[offset - 1];
        return this.deleteChar();
    }

    // ---- internals -----------------------------------------------------

    #advance () { this.cursor = (this.cursor + 1) % this.size; }
    #advanceWrite () { this.writeAddress++; }

    /** Convert a valid 1-based wire address into a buffer index. */
    #index (row, col) {
        const r = row | 0;
        const c = col | 0;
        if (r < 1 || r > this.rows || c < 1 || c > this.cols)
            throw new RangeError(`Invalid 5250 screen address row=${row} col=${col}`);
        return (r - 1) * this.cols + (c - 1);
    }

    /** Re-walk the buffer and re-assign each cell's active attribute
     *  descriptor based on the most-recent INLINE attribute place to
     *  its left (buffer-order). Two attribute-source types exist on a
     *  5250 screen and they propagate differently:
     *
     *    • Inline placeAttribute (0x20-0x3F bytes between data): each
     *      one resets the "running pen" forward through every blank
     *      cell until the next inline attribute place. This is how the
     *      long horizontal underline after `===>` appears on the Main
     *      Menu - the host emits attr 0x24 once and lets the pen carry
     *      across blank cells until the next inline reset.
     *
     *    • SF (Start of Field) attribute: the attribute byte at the
     *      field's start applies ONLY to the field's `length` data
     *      cells. Cells past `start + length` REVERT to the prior
     *      running pen rather than continuing the field's attribute.
     *      Without this rule a field with `attr 0x39` (pink-reverse)
     *      bleeds across the rest of the buffer.
     *
     *  Called from InboundParser at the end of every WTD record. */
    recalcAttributes () {
        let active = DEFAULT_ATTR_DESC;
        let i = 0;
        // SBA(1,0)+SF creates a virtual attribute place immediately
        // before cell zero. Apply its field attribute without consuming
        // the real last cell of the presentation space.
        const virtual = this.fields.find(field => field.start === -1);
        if (virtual) {
            const desc = ATTR_BASE[virtual.attr] ?? DEFAULT_ATTR_DESC;
            for (let j = 0; j < virtual.length && j < this.size; j++)
                this.cells[j].attr = desc;
            i = Math.min(virtual.length, this.size);
        }
        while (i < this.size) {
            const cell = this.cells[i];
            if (cell.attributePlace) {
                if (cell.startField && cell.field) {
                    // SF field start: apply this attr cell's CURRENT
                    // value (which may have been overwritten by a
                    // later placeAttribute targeting the same buffer
                    // position - see the Main Menu `===>` pattern) to
                    // every data cell of the field. Then skip past
                    // the field. The running pen does NOT change so
                    // cells beyond start+length resume whatever attr
                    // was active before the SF, preventing the field
                    // from bleeding visually.
                    const fieldDesc = cell.attr;
                    const len = cell.field.length;
                    for (let j = 1; j <= len; j++) {
                        const idx = (i + j) % this.size;
                        this.cells[idx].attr = fieldDesc;
                    }
                    i += 1 + len;
                    continue;
                }
                // Inline attribute byte: update the running pen.
                active = cell.attr;
            } else {
                cell.attr = active;
            }
            i++;
        }
    }
}
