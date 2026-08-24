// 5250 inbound (host → terminal) data-stream parser.
//
// One instance per session. `process(record)` is called once per
// telnet record (already GDS-unwrapped by the Terminal); the parser
// then walks the commands inside that record, updating the
// ScreenBuffer and recording any immediate reply the outer session
// layer must send.
//
// Display-session commands handled:
//
//     0x11  WTD   Write To Display          orders below
//     0x40  CU    Clear Unit                blanks screen + fields
//     0x20  CUA   Clear Unit Alternate      same, alternate size
//     0x50  CFT   Clear Format Table        forgets field formats
//     0x42  RIF   Read Input Fields         queue invite + remember readType
//     0x52  RMDT  Read MDT Fields           queue invite + readType
//     0x72  RI    Read Immediate            return every input field
//     0x82  RMDTA Read MDT Alternate        pending modified-field read
//     0x83  RMDTIA Read MDT Immediate Alt   immediate modified-field read
//     0x62/0x64   Read Screen               basic / extended-attribute form
//     0x66-0x6C   Read Screen To Print      basic / EA / grid variants
//     0x21  WEC   Write Error Code          like WTD into error line
//     0x22  WEC-W Write Error Code to Win
//     0x23  ROLL  scroll partition          rare in signon
//     0x02/0x03   Save Screen / Save Partial Screen
//     0x12/0x13   Restore Screen / Restore Partial Screen
//     0xF3  WSF   Write Structured Field    Query / station controls
//
// Orders inside WTD / WEC payloads:
//     0x01 SOH    Start of Header
//     0x02 RA     Repeat to Address
//     0x03 EA     Erase to Address
//     0x04 ESC    end-of-command escape
//     0x10 TD     Transparent Data
//     0x11 SBA    Set Buffer Address (row,col)
//     0x12 WEA    Write Extended Attribute
//     0x13 IC     Insert Cursor (row,col)
//     0x14 MC     Move Cursor (row,col)
//     0x15 WTDSF  Write To Display Structured Field (ENPTUI carrier)
//     0x1D SF     Start of Field
//
// Anything in 0x20-0x3F sets the basic attribute (colour/highlight).
// Any byte ≥0x40 is EBCDIC data and gets typed into the screen at the
// current write address (which is distinct from the visible cursor).
//
// On error we throw - Terminal.js catches it and (when the host asked
// for a response) sends a negative response. Right now telnet 5250
// doesn't use TN3270E-style positive responses, so the caller can
// ignore the success path.

import { Cmd, Order, isAttribute } from './Constants.js';
import { decodeWdsf } from './enptui/WdsfDecoder.js';
import { debugFor } from '../../../shared/src/core/debug.js';

const debug = debugFor('tn5250.parser');

export class InboundParser {
    constructor (screen, { onGeometryChange } = {}) {
        this.screen = screen;
        this.onGeometryChange = onGeometryChange ?? (() => {});

        // Read state - set by RIF / RMDT, consumed by sendAid().
        this.readPending  = false;
        this.readType     = 0x00;     // 0x42 read-input, 0x52 read-MDT
        this.invited      = false;
        this.readImmediateRequested = false;
        this.readScreenRequested = false;
        this.queryRequested = false;
        this.queryStationStateRequested = false;
        this.saveScreenRequested = null;

        // Inbound record pointer (parser-local, reset per record).
        this.buf = null;
        this.pos = 0;

        // Diagnostic: set of every attribute byte the host has ever
        // emitted. Useful when calibrating ATTR_BASE against a real
        // IBM i - the user can `console.log([...parser.attrSeen()])`
        // and see exactly which 0x20-0x3F variants are in play.
        this.#attrSeen = new Set();
    }

    /** Read-only view of the attribute bytes seen since startup. */
    attrSeen () { return Array.from(this.#attrSeen).sort(); }

    #attrSeen;

    /** Process one GDS-unwrapped record payload. Every command is
     *  strictly introduced by ESC (0x04): (0x04 cmd args...)*. */
    process (payload) {
        this.buf = payload;
        this.pos = 0;
        this.pendingCc2 = 0;
        this.hasPendingCc2 = false;

        try {
            this.#dispatchCommands();
            if (this.hasPendingCc2) this.#processCc2(this.pendingCc2);
        } catch (error) {
            if (error && typeof error === 'object') error.negativeResponse = true;
            throw error;
        } finally {
            // Run the global attribute inheritance pass exactly once per
            // record. WTD and WEC orders can leave attribute places and
            // SF data cells in any order; this single walk computes the
            // final cell.attr value for every position the same way
            // real IBM 5250 hardware does at scan time.
            this.screen.recalcAttributes();
        }
    }

    #dispatchCommands () {
        while (this.pos < this.buf.length) {
            const esc = this.#u8();
            if (esc !== Order.ESC)
                throw this.#error(`expected command ESC at offset ${this.pos - 1}, got 0x${esc.toString(16)}`);
            if (this.pos >= this.buf.length)
                throw this.#error(`truncated command after ESC at offset ${this.pos - 1}`);
            const cmd = this.#u8();
            switch (cmd) {
                case 0x07: {                          // audible bell + 2 reserved bytes
                    this.screen.alarm = true;
                    if (this.pos < this.buf.length) this.#u8();
                    if (this.pos < this.buf.length) this.#u8();
                    break;
                }
                case Cmd.WRITE_TO_DISPLAY:           this.#wtd(true);  break;
                case Cmd.WRITE_ERROR_CODE:           this.#wtd(false); break;
                case Cmd.WRITE_ERROR_CODE_TO_WINDOW: this.#wtd(false); break;
                case Cmd.CLEAR_UNIT:                 this.#clearUnit(false); break;
                case Cmd.CLEAR_UNIT_ALT: {
                    // Clear Unit Alternate is followed by a 1-byte param
                    // that selects the alternate screen size. Per the
                    // IBM 5250 reference only 0x00 is valid; anything else is
                    // an error condition (we surface as a warning).
                    const param = this.#u8();
                    if (param !== 0x00) {
                        throw this.#error(`CUA with invalid parameter 0x${param.toString(16)}`);
                    }
                    this.#clearUnit(true);
                    break;
                }
                case Cmd.CLEAR_FORMAT_TABLE:         this.screen.clearFormatTable(); break;
                case Cmd.READ_INPUT_FIELDS:          this.#read(0x42); break;
                case Cmd.READ_MDT_FIELDS:            this.#read(0x52); break;
                case Cmd.READ_MDT_ALT:               this.#read(0x82); break;
                case Cmd.READ_IMMEDIATE:
                    this.readType = Cmd.READ_IMMEDIATE;
                    this.readImmediateRequested = true;
                    break;
                case Cmd.READ_MDT_IMMEDIATE_ALT:
                    // RFC 1205: no control characters follow 0x83; return
                    // modified fields immediately with AID 0x00.
                    this.readType    = 0x83;
                    this.readImmediateRequested = true;
                    break;
                case Cmd.READ_SCREEN_IMMEDIATE:
                case Cmd.READ_SCREEN_WITH_EA:
                case Cmd.READ_SCREEN_TO_PRINT:
                case Cmd.READ_SCREEN_TO_PRINT_WITH_EA:
                case Cmd.READ_SCREEN_TO_PRINT_WITH_GRID:
                case Cmd.READ_SCREEN_TO_PRINT_WITH_GRID_EA:
                    // Host wants the entire presentation space sent
                    // back verbatim. The actual response is built by
                    // Terminal.js using OutboundBuilder.buildReadScreenResponse.
                    // We just flag the request so the outer layer fires
                    // the response after the record is fully parsed.
                    this.readScreenRequested = cmd;
                    break;
                case Cmd.WRITE_STRUCTURED_FIELD:
                    this.#wsf();
                    return;        // WSF always ends the record
                case Cmd.SAVE_SCREEN:
                    this.saveScreenRequested = {
                        partial: false,
                        token: this.screen.saveScreen(),
                    };
                    break;
                case Cmd.SAVE_PARTIAL_SCREEN:
                    this.#savePartialScreen();
                    break;
                case Cmd.RESTORE_SCREEN: {
                    const token = this.buf.slice(this.pos);
                    this.pos = this.buf.length;
                    if (!this.#restoreScreen(token))
                        throw this.#stateError('unknown Save Screen token');
                    return;
                }
                case Cmd.RESTORE_PARTIAL_SCREEN: {
                    const length = this.#u16();
                    if (length === 0) break;
                    if (this.pos + length > this.buf.length)
                        throw this.#error(`truncated Restore Partial Screen image at offset ${this.pos}`);
                    const token = this.buf.slice(this.pos, this.pos + length);
                    this.pos += length;
                    if (!this.#restoreScreen(token))
                        throw this.#stateError('unknown Save Partial Screen token');
                    break;
                }
                case Cmd.ROLL:                       this.#roll(); break;
                default:
                    throw this.#error(`unknown 5250 command 0x${cmd.toString(16).padStart(2,'0')} at offset ${this.pos - 1}`);
            }
        }
    }

    // ---- byte cursor ---------------------------------------------------

    #error (message) {
        const error = new Error(message);
        error.negativeResponse = true;
        return error;
    }

    #stateError (message) {
        const error = this.#error(message);
        error.stateError = true;
        return error;
    }

    clearTransientRequests () {
        this.readImmediateRequested = false;
        this.readScreenRequested = false;
        this.queryRequested = false;
        this.queryStationStateRequested = false;
        this.saveScreenRequested = null;
    }

    #u8 ()  {
        if (this.pos >= this.buf.length)
            throw this.#error(`truncated 5250 data at offset ${this.pos}`);
        return this.buf[this.pos++] & 0xFF;
    }
    #peek () {
        if (this.pos >= this.buf.length)
            throw this.#error(`truncated 5250 data at offset ${this.pos}`);
        return this.buf[this.pos] & 0xFF;
    }
    #u16 () {
        const hi = this.#u8();
        const lo = this.#u8();
        return (hi << 8) | lo;
    }

    // ---- WTD -----------------------------------------------------------

    #wtd (hasControls) {
        this.screen.beginWriteToDisplay();
        let cc1 = null;
        if (hasControls) {
            const cc0 = this.#u8();
            cc1 = this.#u8();
            this.#processCc1(cc0);
        }

        while (this.pos < this.buf.length) {
            const b = this.#u8();
            switch (b) {
                case Order.SOH:   this.#orderSoh();   break;
                case Order.RA:    this.#orderRa();    break;
                case Order.EA:    this.#orderEa();    break;
                case Order.ESC:
                    if (cc1 !== null) this.#preprocessCc2(cc1);
                    // The ESC belongs to the following command. At end
                    // of record it is accepted as a WTD terminator only.
                    if (this.pos < this.buf.length) this.pos--;
                    return;                         // command terminator
                case Order.TD: {
                    // Transparent Data carries `len` raw bytes that must
                    // be placed into the buffer verbatim at the cursor —
                    // they're "transparent" only in the sense that the
                    // host does not want the parser to interpret them as
                    // orders or attributes. Per the IBM 5250 reference,
                    // each byte is treated like a plain data byte.
                    const len = this.#u16();
                    if (this.pos + len > this.buf.length)
                        throw this.#error(`TD length ${len} exceeds remaining data`);
                    if (this.screen.writeAddress + len > this.screen.size)
                        throw this.#error(`TD length ${len} overwrites end of display`);
                    for (let i = 0; i < len; i++) {
                        this.screen.placeByte(this.#u8());
                    }
                    break;
                }
                case Order.SBA:   this.#orderSba();   break;
                case Order.WEA: {
                    // Write Extended Attribute - 2-byte (type, value)
                    // pair that overrides the running "pen" for the
                    // cells emitted after it, until the next basic
                    // attribute (0x20-0x3F) reset. Most hosts only use
                    // the basic attribute table; WEA appears when the
                    // host wants colours / underlines outside that
                    // table. We record it on the screen so future
                    // placeByte() calls inherit the extension.
                    const type = this.#u8();
                    const value = this.#u8();
                    this.screen.setExtendedAttr(type, value);
                    break;
                }
                case Order.IC: {
                    const row = this.#u8();
                    const col = this.#u8();
                    this.screen.setPendingInsert(true, row, col);
                    break;
                }
                case Order.MC: {
                    const row = this.#u8();
                    const col = this.#u8();
                    this.screen.setPendingInsert(false, row, col);
                    break;
                }
                case Order.WTDSF: {
                    // The WTDSF body is one OR MORE concatenated ENPTUI
                    // segments. The first two bytes of each segment are
                    // its length (which includes those length bytes).
                    // We hand the entire body to the ENPTUI decoder and
                    // it walks the segment chain itself.
                    const segLen = this.#u16();
                    const start  = this.pos - 2;
                    if (segLen < 4 || start + segLen > this.buf.length)
                        throw this.#error(`invalid WTDSF segment length ${segLen}`);
                    const end    = start + segLen;
                    const body   = this.buf.subarray(start, end);
                    decodeWdsf(body, this.screen);
                    this.pos = end;
                    break;
                }
                case Order.SF:    this.#orderSf();    break;
                default:
                    if (isAttribute(b)) {
                        this.screen.placeAttribute(b);
                        this.#attrSeen.add(b);
                    } else {
                        this.screen.placeByte(b);
                    }
                    break;
            }
        }
        if (cc1 !== null) this.#preprocessCc2(cc1);
    }

    /** Control-character bytes 0 and 1 of a WTD command (CC0/CC1).
     *  Verified byte-for-byte against the IBM 5250 reference.
     *
     *  CC0 - top 3 bits dispatch on 8 cases. Any non-zero high-nibble
     *  locks the keyboard during the WTD; specific cases also reset
     *  MDT flags and / or null the non-bypass field contents.
     *
     *     0x00 = no action (keyboard stays as-is)
     *     0x20 = lock keyboard only
     *     0x40 = reset MDT on non-bypass fields + lock
     *     0x60 = reset MDT on all fields + lock
     *     0x80 = clear modified non-bypass fields + lock
     *     0xA0 = clear all non-bypass, then reset non-bypass MDT + lock
     *     0xC0 = clear modified non-bypass, then reset non-bypass MDT + lock
     *     0xE0 = clear all non-bypass, then reset all MDT + lock
     *
     *  CC1 - bit flags (NB: our old mapping was wrong on every bit):
     *     0x08 = unlock keyboard after WTD completes (WCC2_UNLOCK)
     *     0x04 = sound alarm (WCC2_ALARM)
     *     0x02 = message light off
     *     0x01 = message light on */
    #processCc1 (cc0) {
        const cc0Top = cc0 & 0xE0;
        if (cc0Top !== 0x00) this.screen.keyboardLocked = true;
        switch (cc0Top) {
            case 0x40:
                this.screen.resetMdtFlags(true);
                break;
            case 0x60:
                this.screen.resetMdtFlags(false);
                break;
            case 0x80:
                this.screen.clearNonBypassFields(true);
                break;
            case 0xA0:
                this.screen.clearNonBypassFields(false);
                this.screen.resetMdtFlags(true);
                break;
            case 0xC0:
                this.screen.clearNonBypassFields(true);
                this.screen.resetMdtFlags(true);
                break;
            case 0xE0:
                this.screen.clearNonBypassFields(false);
                this.screen.resetMdtFlags(false);
                break;
        }
    }

    #preprocessCc2 (cc1) {
        this.screen.applyWcc2Cursor(cc1);
        this.hasPendingCc2 = true;
        this.pendingCc2 |= cc1 & 0x4F;
        if ((cc1 & 0x40) === 0) this.pendingCc2 &= ~0x40;
        if ((cc1 & 0x02) !== 0 && (cc1 & 0x01) === 0)
            this.pendingCc2 = (this.pendingCc2 | 0x02) & ~0x01;
    }

    #processCc2 (cc1) {
        if (cc1 & 0x08) this.screen.unlockKeyboard();
        if (cc1 & 0x04) this.screen.alarm = true;
        if (cc1 & 0x02) { this.screen.messageLight = false; }
        if (cc1 & 0x01) { this.screen.messageLight = true;  }
    }

    #orderSoh () {
        // Layout per IBM 5250 Functions Reference §3.4.4:
        //   SOH <len> <flag1> <reserved> <reserved> <reserved> <errRow>
        //       <pfMask1> <pfMask2> <pfMask3>
        //
        //   flag1 bit 0x10 = move cursor to an input field after AID
        //   errRow         = row at which the host wants error msgs
        //   pfMask1        = enable bits for PF24..PF17 (high → low)
        //   pfMask2        = enable bits for PF16..PF9
        //   pfMask3        = enable bits for PF8..PF1
        //
        // PF bits select short-read keys: cursor and AID are returned,
        // without field data. They do not disable those keys.
        const len = this.#u8();
        if (len < 1 || len > 7)
            throw this.#error(`invalid SOH length ${len}`);
        const end = this.pos + len;
        if (end > this.buf.length) throw this.#error(`SOH length ${len} exceeds remaining data`);

        const flag1 = (this.pos < end) ? this.#u8() : 0;
        // Per the IBM 5250 reference: SOH byte layout
        // after the length byte is flag1, reserved, resequence, errRow,
        // pfMask1, pfMask2, pfMask3 = 7 bytes total. We previously
        // skipped 3 bytes between flag1 and errRow which consumed the
        // errRow itself and shifted every subsequent field by one.
        if (this.pos < end) this.#u8();   // reserved
        const resequence = (this.pos < end) ? this.#u8() : 0;
        const errRow = (this.pos < end) ? this.#u8() : 0;
        // Byte 0 covers PF24..17, byte 1 PF16..9, byte 2 PF8..1.
        const pfBytes = [
            (this.pos < end) ? this.#u8() : 0,
            (this.pos < end) ? this.#u8() : 0,
            (this.pos < end) ? this.#u8() : 0,
        ];
        this.pos = end;

        // IBM clears the old field-format table at every valid SOH;
        // the following SF orders build the new table for this panel.
        this.screen.clearFormatTable();
        this.screen.startOfHeader({
            cursorMoveToInput: (flag1 & 0x10) !== 0,
            resequence,
            errRow,
            pfBytes,
        });
    }

    #orderRa () {
        // RA <row> <col> <byte>
        const row  = this.#u8();
        const col  = this.#u8();
        const byte = this.#u8();
        this.screen.repeatToAddress(row, col, byte);
    }

    #orderEa () {
        // EA <row> <col> <length> <length-1 attribute-plane bytes>
        // Per the IBM 5250 reference §3.4.6, the
        // EA order always carries a length byte after the address, and
        // length-1 additional bytes naming attribute planes to clear
        // (we don't model planes separately, so we consume and ignore
        // those bytes — but failing to consume them garbles the rest
        // of the WTD stream).
        const row    = this.#u8();
        const col    = this.#u8();
        const length = this.#u8();
        if (length < 2 || length > 5 || this.pos + length - 1 > this.buf.length)
            throw this.#error(`invalid EA attribute-plane length ${length}`);
        const planes = [];
        for (let i = 0; i < length - 1; i++) {
            planes.push(this.#u8());
        }
        this.screen.eraseToAddress(row, col, planes);
    }

    #orderSba () {
        const row = this.#u8();
        const col = this.#u8();
        // Row 1 / column 0 is the documented virtual attribute position
        // immediately before the presentation space. It is legal only
        // when the next order is SF and makes that field start at (1,1).
        if (row === 1 && col === 0) {
            if (this.#peek() !== Order.SF)
                throw this.#error('SBA row=1 col=0 is only valid before SF');
            this.screen.setCursorBeforeStart();
        } else {
            this.screen.setWriteAddress(row, col);
        }
    }

    #orderSf () {
        // SF <FFW0> [FFW1 [FCW pairs...]] <attr> <len-hi> <len-lo>
        const first = this.#u8();
        let ffw0 = 0;
        let ffw1 = 0;
        let attr = 0;
        const fcws = [];

        if (first >= 0x40) {
            ffw0 = first;
            ffw1 = this.#u8();
            // Walk FCW pairs until we hit the attribute byte. Tags
            // valid per IBM ref include 0x80-0x85, 0x86, 0x88-0x8A,
            // 0x90-0x93, 0xB1-0xBF. No need to special-case 0x81 —
            // that was a defunct guard from an early experiment; real
            // FCW pairs of `0x81 <value>` are perfectly legal and must
            // be captured like any other tag.
            let next = this.#u8();
            while (!isAttribute(next)) {
                const v = this.#u8();
                fcws.push([next, v]);
                next = this.#u8();
            }
            attr = next;
        } else {
            // No FFW is present: the first byte is the display
            // attribute itself. It must not leak into field flags.
            attr = first;
        }

        const length = this.#u16();
        this.screen.addField({ attr, length, ffw0, ffw1, fcws });
    }

    // ---- read commands -------------------------------------------------

    #read (kind) {
        const cc0 = this.#u8();
        const cc1 = this.#u8();
        this.lastReadCc0 = cc0;
        this.lastReadCc1 = cc1;
        this.readType    = kind;
        this.readPending = true;
        this.invited     = true;
    }

    #clearUnit (alternate) {
        const rows = this.screen.rows;
        const cols = this.screen.cols;
        this.screen.clearUnit(alternate);
        if (rows !== this.screen.rows || cols !== this.screen.cols)
            this.onGeometryChange(this.screen.rows, this.screen.cols);
    }

    #savePartialScreen () {
        const startRow = this.#u8();
        const startCol = this.#u8();
        this.#u8();                         // reserved
        const depth = this.#u8();
        const width = this.#u8() + 6;
        const valid = startRow > 0 && startCol > 0 && depth > 0
            && startRow + depth - 1 <= this.screen.rows
            && startCol + width - 1 <= this.screen.cols;
        const region = valid
            ? { row: startRow, col: startCol, width, depth }
            : null;
        this.saveScreenRequested = {
            partial: true,
            token: this.screen.saveScreen(region),
        };
    }

    #restoreScreen (token = null) {
        const rows = this.screen.rows;
        const cols = this.screen.cols;
        const restored = this.screen.restoreScreen(token);
        if (restored && (rows !== this.screen.rows || cols !== this.screen.cols))
            this.onGeometryChange(this.screen.rows, this.screen.cols);
        return restored;
    }

    // ---- write-structured-field (Query / ENPTUI) ----------------------

    #wsf () {
        // Each WSF carries one or more structured-field segments back
        // to back. We dispatch on (class, type) - per IBM 5250 ref:
        //
        //   0xD9 0x70 - Query 5250 capabilities ("who are you?")
        //   0xD9 0x71 - Query Station State (cursor + screen geometry)
        //   0x00 0x88 - 5250 Erase/Reset
        //   0xB0 0x00 - Set Reply Mode (which extended fields we accept)
        //   0xD9 0x00 - Define Audit Window Table
        //   0xD9 0x01 - Read Text Screen
        //
        // Unsupported structures are rejected so the host does not wait
        // indefinitely for a response we cannot represent correctly.
        while (this.pos < this.buf.length) {
            if (this.pos + 4 > this.buf.length)
                throw this.#error(`truncated WSF segment at offset ${this.pos}`);
            const len = this.#u16();
            if (len < 4 || this.pos - 2 + len > this.buf.length)
                throw this.#error(`invalid WSF segment length ${len}`);
            const cls  = this.#u8();
            const type = this.#u8();
            const segEnd = this.pos - 4 + len;       // start was len bytes back
            const payload = this.buf.subarray(this.pos, segEnd);

            if (cls === 0xD9 && type === 0x70) {
                this.queryRequested = true;
            } else if (cls === 0xD9 && type === 0x71) {
                // Query Station State - host wants cursor row/col and
                // a snapshot of screen control state. We mark it so the
                // Terminal can emit the appropriate response.
                this.queryStationStateRequested = true;
            } else if (cls === 0xB0 && type === 0x00) {
                // Set Reply Mode - host tells us which extended-field
                // formats it expects in our outbound. We don't yet
                // emit extended-field formats anyway, so storing the
                // mode is enough to keep tests happy.
                this.replyMode = payload[0] ?? 0;
            } else if (cls === 0x00 && type === 0x88) {
                // 5250 Erase/Reset - same effect as Clear Unit + Clear
                // Format Table. Apply both and resume.
                this.#clearUnit(false);
                this.screen.clearFormatTable();
            } else {
                throw this.#error(`unsupported WSF class/type 0x${cls.toString(16)}/0x${type.toString(16)}`);
            }
            this.pos = segEnd;
        }
    }

    // ---- ROLL ----------------------------------------------------------

    #roll () {
        // ROLL <direction-byte> <top-line> <bottom-line> <lines-to-roll>
        // direction-byte: 0x80 = up, 0x00 = down, lines in low 7 bits.
        const dir  = this.#u8();
        const top  = this.#u8();
        const bot  = this.#u8();
        const dist = dir & 0x7F;
        const up   = (dir & 0x80) !== 0;
        this.screen.roll(top, bot, dist, up);
    }
}
