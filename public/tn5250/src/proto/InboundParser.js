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

import { Cmd, Order, NegResp, isAttribute } from './Constants.js';
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
        this.queryStationStateRequested = null;
        this.saveScreenRequested = null;

        // Inbound record pointer (parser-local, reset per record).
        this.buf = null;
        this.pos = 0;
        this.suspendedErrorRead = null;
        this.errorCode = Uint8Array.of(0, 0);

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
        this.keyboardStateChanged = false;
        this.createdEnptuiThisRecord = false;

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
                case Cmd.WRITE_TO_DISPLAY:           this.#wtd(true);  break;
                case Cmd.WRITE_ERROR_CODE:           this.#writeErrorCode(false); break;
                case Cmd.WRITE_ERROR_CODE_TO_WINDOW: this.#writeErrorCode(true); break;
                case Cmd.CLEAR_UNIT:                 this.#clearUnit(false); break;
                case Cmd.CLEAR_UNIT_ALT: {
                    // Clear Unit Alternate is followed by a 1-byte param
                    // that selects the alternate screen size. Per the
                    // IBM 5250 reference only 0x00 is valid; anything else is
                    // an error condition (we surface as a warning).
                    const param = this.#u8();
                    if (param !== 0x00) {
                        throw this.#error(`CUA with invalid parameter 0x${param.toString(16)}`,
                            NegResp.CLEAR_UNIT_ALT_INVALID);
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
                    // WSF has its own length, so another ESC-introduced
                    // command may legally follow it in the same record.
                    this.readPending = false;
                    this.invited = false;
                    break;
                case Cmd.TRUE_TRANSPARENCY_WRITE:
                    this.#trueTransparencyWrite();
                    break;
                case Cmd.SAVE_SCREEN:
                    this.saveScreenRequested = {
                        partial: false,
                        token: this.saveScreen(),
                    };
                    break;
                case Cmd.SAVE_PARTIAL_SCREEN:
                    this.#flushPendingCc2();
                    this.#savePartialScreen();
                    break;
                case Cmd.RESTORE_SCREEN: {
                    const token = this.buf.slice(this.pos);
                    this.pos = this.buf.length;
                    if (!this.restoreScreen(token))
                        throw this.#stateError('unknown Save Screen token');
                    return;
                }
                case Cmd.RESTORE_PARTIAL_SCREEN: {
                    const length = this.#u16();
                    if (length === 0) break;
                    if (this.pos + length > this.buf.length)
                        throw this.#error(`truncated Restore Partial Screen image at offset ${this.pos}`,
                            NegResp.TOO_LITTLE_DATA);
                    const token = this.buf.slice(this.pos, this.pos + length);
                    this.pos += length;
                    if (!this.restoreScreen(token))
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

    #error (message, senseCode = NegResp.COMMAND_NOT_VALID) {
        const error = new Error(message);
        error.negativeResponse = true;
        error.senseCode = senseCode;
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
        this.queryStationStateRequested = null;
        this.saveScreenRequested = null;
    }

    #u8 ()  {
        if (this.pos >= this.buf.length)
            throw this.#error(`truncated 5250 data at offset ${this.pos}`,
                NegResp.TOO_LITTLE_DATA);
        return this.buf[this.pos++] & 0xFF;
    }
    #peek () {
        if (this.pos >= this.buf.length)
            throw this.#error(`truncated 5250 data at offset ${this.pos}`,
                NegResp.TOO_LITTLE_DATA);
        return this.buf[this.pos] & 0xFF;
    }
    #u16 () {
        const hi = this.#u8();
        const lo = this.#u8();
        return (hi << 8) | lo;
    }

    // ---- WTD -----------------------------------------------------------

    #wtd (hasControls, { errorWrite = false } = {}) {
        this.screen.beginWriteToDisplay({ retainWriteAddress: errorWrite });
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
                        throw this.#error(`TD length ${len} exceeds remaining data`,
                            NegResp.INVALID_TRANSPARENT_DATA);
                    if (this.screen.writeAddress + len > this.screen.size)
                        throw this.#error(`TD length ${len} overwrites end of display`,
                            NegResp.INVALID_TRANSPARENT_DATA);
                    for (let i = 0; i < len; i++) {
                        this.screen.placeByte(this.#u8());
                    }
                    break;
                }
                case Order.SBA:   this.#orderSba();   break;
                case Order.WEA: {
                    // In a display SBCS session the only defined WEA
                    // type is the NLS/DBCS plane selector (0x05). Since
                    // this client deliberately does not advertise a DBCS
                    // session, every WEA is a request error. Consuming and
                    // painting invented colour/highlight types would hide
                    // a protocol mismatch and corrupt subsequent output.
                    const type = this.#u8();
                    const value = this.#u8();
                    throw this.#error(
                        `WEA type 0x${type.toString(16)} value 0x${value.toString(16)} is unavailable in an SBCS session`,
                        NegResp.INVALID_EXT_ATTRIBUTE);
                    break;
                }
                case Order.IC: {
                    const row = this.#u8();
                    const col = this.#u8();
                    if (errorWrite) {
                        if (row < 1 || row > this.screen.rows
                            || col < 1 || col > this.screen.cols)
                            throw this.#error(`invalid error cursor position ${row},${col}`,
                                NegResp.INVALID_ADDRESS);
                        this.screen.cursor = (row - 1) * this.screen.cols + col - 1;
                    } else {
                        try {
                            this.screen.setPendingInsert(true, row, col);
                        } catch (error) {
                            throw this.#error(error.message, NegResp.INVALID_ADDRESS);
                        }
                    }
                    break;
                }
                case Order.MC: {
                    const row = this.#u8();
                    const col = this.#u8();
                    try {
                        this.screen.setPendingInsert(false, row, col);
                    } catch (error) {
                        throw this.#error(error.message, NegResp.INVALID_ADDRESS);
                    }
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
                        throw this.#error(`invalid WTDSF segment length ${segLen}`,
                            NegResp.STRUCTURED_FIELD_LENGTH);
                    const end    = start + segLen;
                    const body   = this.buf.subarray(start, end);
                    decodeWdsf(body, this.screen);
                    this.createdEnptuiThisRecord = true;
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

    #writeErrorCode (toWindow) {
        const row = this.screen.soh.errRow >= 1 && this.screen.soh.errRow <= this.screen.rows
            ? this.screen.soh.errRow
            : this.screen.rows;
        const rowStart = (row - 1) * this.screen.cols;
        let start = rowStart;
        let end = rowStart + this.screen.cols - 1;
        if (toWindow) {
            const startCol = this.#u8();
            const endCol = this.#u8();
            if (startCol < 1 || endCol < startCol || endCol > this.screen.cols)
                throw this.#error(`invalid WECW columns ${startCol}-${endCol}`,
                    NegResp.INVALID_ADDRESS);
            start = rowStart + startCol - 1;
            end = rowStart + endCol - 1;
        }

        const originalBuffer = this.buf;
        const bodyStart = this.pos;
        let terminator = originalBuffer.indexOf(Order.ESC, bodyStart);
        if (terminator < 0) terminator = originalBuffer.length;
        let bodyEnd = terminator;
        if (toWindow) {
            bodyEnd = bodyStart + end - start + 1;
            if (originalBuffer[bodyStart] === Order.IC) bodyEnd += 3;
            if (bodyEnd > terminator)
                throw this.#error('truncated WECW body', NegResp.TOO_LITTLE_DATA);
        }

        // Error Help returns the four-digit identifier that begins the
        // error line, packed as two BCD bytes. IC and a leading display
        // attribute are orders rather than identifier digits.
        let errorPos = bodyStart;
        if (originalBuffer[errorPos] === Order.IC) errorPos += 3;
        if (isAttribute(originalBuffer[errorPos])) errorPos++;
        if (errorPos + 3 < bodyEnd && originalBuffer[errorPos] !== Order.ESC) {
            this.errorCode = Uint8Array.of(
                ((originalBuffer[errorPos] & 0x0F) << 4)
                    | (originalBuffer[errorPos + 1] & 0x0F),
                ((originalBuffer[errorPos + 2] & 0x0F) << 4)
                    | (originalBuffer[errorPos + 3] & 0x0F),
            );
        }

        if (!this.suspendedErrorRead) {
            this.suspendedErrorRead = {
                readPending: this.readPending,
                invited: this.invited,
                readType: this.readType,
            };
        }
        this.readPending = false;
        this.invited = false;

        const savedWriteAddress = this.screen.writeAddress;
        this.screen.beginErrorLine(start, end);
        try {
            this.buf = originalBuffer.subarray(bodyStart, bodyEnd);
            this.pos = 0;
            this.#wtd(false, { errorWrite: true });
        } finally {
            this.buf = originalBuffer;
            this.pos = terminator < originalBuffer.length - 1
                ? terminator
                : originalBuffer.length;
            this.screen.writeAddress = savedWriteAddress;
        }
    }

    clearErrorMode () {
        this.screen.clearErrorMode();
        const saved = this.suspendedErrorRead;
        if (saved) {
            if (saved.readPending && saved.readType === Cmd.READ_INPUT_FIELDS) {
                this.readPending = true;
                this.invited = saved.invited;
                this.readType = saved.readType;
            }
            this.suspendedErrorRead = null;
        }
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
        this.keyboardStateChanged = cc0Top !== 0x00;
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
        let effectiveCc1 = cc1;
        const unlockAlreadyPending = (this.pendingCc2 & 0x08) !== 0;
        // An unlock on an already-unlocked workstation is not a new
        // keyboard transition when CC0 requested no state change. In that
        // case the cursor must remain where the operator left it and
        // unlock-only side effects must not run again. The same rule applies
        // to a later WTD after an earlier WTD queued the record's unlock.
        if ((unlockAlreadyPending || !this.screen.keyboardLocked)
            && !this.keyboardStateChanged) {
            effectiveCc1 |= 0x40;
            effectiveCc1 &= ~0x08;
        }

        const previousCursor = this.screen.cursor;
        const previousSelection = this.screen.enptuiItemAtAddress(previousCursor)?.construct;
        this.screen.applyWcc2Cursor(effectiveCc1);
        const nextCursor = this.screen.pendingCursor;
        const nextSelection = nextCursor >= 0
            ? this.screen.enptuiItemAtAddress(nextCursor)?.construct
            : null;
        // A host cursor refresh within the same selection pseudo-field
        // must not jump away from the operator's currently focused item.
        if (previousSelection && previousSelection === nextSelection)
            this.screen.pendingCursor = previousCursor;
        this.hasPendingCc2 = true;
        this.pendingCc2 |= effectiveCc1 & 0x4F;
        if ((effectiveCc1 & 0x40) === 0) this.pendingCc2 &= ~0x40;
        if ((effectiveCc1 & 0x02) !== 0 && (effectiveCc1 & 0x01) === 0)
            this.pendingCc2 = (this.pendingCc2 | 0x02) & ~0x01;
    }

    #processCc2 (cc1) {
        if ((cc1 & 0x08) && !this.screen.errorMode) {
            this.screen.unlockKeyboard({
                deselectChoices: !this.createdEnptuiThisRecord,
            });
        }
        if (cc1 & 0x04) this.screen.alarm = true;
        if (cc1 & 0x02) { this.screen.messageLight = false; }
        if (cc1 & 0x01) { this.screen.messageLight = true;  }
    }

    #flushPendingCc2 () {
        if (!this.hasPendingCc2) return;
        this.#processCc2(this.pendingCc2);
        this.hasPendingCc2 = false;
        this.pendingCc2 = 0;
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
            throw this.#error(`invalid SOH length ${len}`, NegResp.INVALID_SOH);
        const end = this.pos + len;
        if (end > this.buf.length) throw this.#error(
            `SOH length ${len} exceeds remaining data`, NegResp.INVALID_SOH);

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

        // SOH starts a new field-format table while keeping an enclosing
        // window active; the following SF orders rebuild the panel fields.
        this.screen.clearFormatTable({ preserveWindows: true });
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
        try {
            this.screen.repeatToAddress(row, col, byte);
        } catch (error) {
            const sense = /precedes/.test(error?.message)
                ? NegResp.ADDRESS_PRECEDES
                : /address/.test(error?.message)
                    ? NegResp.INVALID_ADDRESS
                    : NegResp.WRITE_PAST_END;
            throw this.#error(error.message, sense);
        }
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
            throw this.#error(`invalid EA attribute-plane length ${length}`,
                NegResp.INVALID_ERASE_ADDRESS);
        const planes = [];
        for (let i = 0; i < length - 1; i++) {
            planes.push(this.#u8());
        }
        // Plane 0 clears all SBCS presentation planes; 0xFF is the
        // architected alias that also includes the NLS plane in a DBCS
        // session. Plane 5 and every other selector require a DBCS/NLS
        // presentation model and must not be silently ignored here.
        if (planes.some(plane => plane !== 0x00 && plane !== 0xFF))
            throw this.#error(`unsupported EA attribute plane 0x${planes.find(
                plane => plane !== 0x00 && plane !== 0xFF).toString(16)}`,
            NegResp.INVALID_ERASE_ADDRESS);
        try {
            this.screen.eraseToAddress(row, col, planes);
        } catch (error) {
            throw this.#error(error.message, /precedes/.test(error?.message)
                ? NegResp.ADDRESS_PRECEDES
                : NegResp.INVALID_ADDRESS);
        }
    }

    #orderSba () {
        const row = this.#u8();
        const col = this.#u8();
        // Row 1 / column 0 is the documented virtual attribute position
        // immediately before the presentation space. It is legal only
        // when the next order is SF and makes that field start at (1,1).
        if (row === 1 && col === 0) {
            if (this.#peek() !== Order.SF)
                throw this.#error('SBA row=1 col=0 is only valid before SF',
                    NegResp.INVALID_ADDRESS);
            this.screen.setCursorBeforeStart();
        } else {
            try {
                this.screen.setWriteAddress(row, col);
            } catch (error) {
                throw this.#error(error.message, NegResp.INVALID_ADDRESS);
            }
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
            while (next >= 0x80) {
                const v = this.#u8();
                fcws.push([next, v]);
                next = this.#u8();
            }
            if (!isAttribute(next))
                throw this.#error(
                    `invalid Start Field attribute 0x${next.toString(16)}`,
                    NegResp.INVALID_START_FIELD);
            attr = next;
        } else {
            // No FFW is present: the first byte is the display
            // attribute itself. It must not leak into field flags.
            if (!isAttribute(first))
                throw this.#error(
                    `invalid Start Field attribute 0x${first.toString(16)}`,
                    NegResp.INVALID_START_FIELD);
            attr = first;
        }

        const length = this.#u16();
        try {
            this.screen.addField({ attr, length, ffw0, ffw1, fcws });
        } catch (error) {
            throw this.#error(error.message, NegResp.INVALID_START_FIELD);
        }
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
        this.suspendedErrorRead = null;
        this.errorCode = Uint8Array.of(0, 0);
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
            token: this.saveScreen(region),
        };
    }

    saveScreen (region = null) {
        return this.screen.saveScreen(region, {
            sessionState: {
                readPending: this.readPending,
                readType: this.readType,
                invited: this.invited,
                lastReadCc0: this.lastReadCc0 ?? 0,
                lastReadCc1: this.lastReadCc1 ?? 0,
            },
        });
    }

    restoreScreen (token = null) {
        const rows = this.screen.rows;
        const cols = this.screen.cols;
        const restored = this.screen.restoreScreen(token);
        const state = this.screen.lastRestoredSessionState;
        if (restored && state) {
            this.readPending = !!state.readPending;
            this.readType = state.readType ?? this.readType;
            this.invited = !!state.invited;
            this.lastReadCc0 = state.lastReadCc0 ?? 0;
            this.lastReadCc1 = state.lastReadCc1 ?? 0;
        }
        if (restored && (rows !== this.screen.rows || cols !== this.screen.cols))
            this.onGeometryChange(this.screen.rows, this.screen.cols);
        return restored;
    }

    // ---- true-transparency write --------------------------------------

    #trueTransparencyWrite () {
        // Length includes its own two bytes. The remaining bytes carry
        // host metadata (often HTML/accessibility DDS annotations), not
        // 5250 presentation-space characters. Consume the block so a
        // following command remains aligned; the character-cell and
        // ENPTUI renderers intentionally have nothing to paint for it.
        const start = this.pos;
        const length = this.#u16();
        if (length < 2)
            throw this.#error(`invalid True Transparency Write length ${length}`,
                NegResp.INVALID_TRANSPARENT_DATA);
        const end = start + length;
        if (end > this.buf.length)
            throw this.#error(`truncated True Transparency Write at offset ${start}`,
                NegResp.INVALID_TRANSPARENT_DATA);
        this.pos = end;
    }

    // ---- write-structured-field (Query / ENPTUI) ----------------------

    #wsf () {
        // One WSF command carries one length-delimited structured field.
        // The outer command dispatcher resumes at its end, which matters
        // when another command follows in the same GDS record. Dispatch
        // on (class, type):
        //
        //   0xD9 0x70 - Query 5250 capabilities ("who are you?")
        //   0xD9 0x72 - Query Station State
        //   0x00 0x88 - 5250 Erase/Reset
        //
        // Unsupported structures are rejected so the host does not wait
        // indefinitely for a response we cannot represent correctly.
        if (this.pos + 4 > this.buf.length)
            throw this.#error(`truncated WSF segment at offset ${this.pos}`,
                NegResp.STRUCTURED_FIELD_LENGTH);
        const start = this.pos;
        const len = this.#u16();
        if (len < 4 || start + len > this.buf.length)
            throw this.#error(`invalid WSF segment length ${len}`,
                NegResp.STRUCTURED_FIELD_LENGTH);
        const cls = this.#u8();
        const type = this.#u8();
        const segEnd = start + len;
        const payload = this.buf.subarray(this.pos, segEnd);

        if (cls === 0xD9 && type === 0x70) {
            if (payload.length !== 1 || payload[0] !== 0)
                throw this.#error('invalid Query request parameters',
                    NegResp.STRUCTURED_FIELD_PARAM);
            this.queryRequested = true;
        } else if (cls === 0xD9 && type === 0x72) {
            if (payload.length !== 2)
                throw this.#error('invalid Query Station State length',
                    NegResp.STRUCTURED_FIELD_LENGTH);
            if ((payload[0] & 0x80) !== 0)
                throw this.#error('invalid Query Station State flags',
                    NegResp.STRUCTURED_FIELD_PARAM);
            this.queryStationStateRequested = {
                extended: (payload[0] & 0x40) !== 0 && payload[1] === 0,
            };
        } else if (cls === 0x00 && type === 0x88) {
            // 5250 Erase/Reset - same effect as Clear Unit + Clear
            // Format Table. Apply both and resume.
            this.#clearUnit(false);
            this.screen.clearFormatTable();
        } else {
            throw this.#error(
                `unsupported WSF class/type 0x${cls.toString(16)}/0x${type.toString(16)}`,
                NegResp.STRUCTURED_FIELD_TYPE);
        }
        this.pos = segEnd;
    }

    // ---- ROLL ----------------------------------------------------------

    #roll () {
        // ROLL <direction+distance> <top-line> <bottom-line>.
        // Bit 0x80 moves retained data down; the low five bits are the
        // number of rows. Bits 0x20/0x40 are reserved.
        const control = this.#u8();
        const top = this.#u8();
        const bottom = this.#u8();
        const distance = control & 0x1F;
        const down = (control & 0x80) !== 0;
        if (!this.screen.roll(top, bottom, distance, down))
            throw this.#error(`invalid ROLL region ${top}-${bottom} distance ${distance}`,
                NegResp.INVALID_ROLL);
    }
}
