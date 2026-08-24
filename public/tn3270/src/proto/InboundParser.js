// Parses a single 3270 record (one IAC-EOR delimited block, with the
// optional 5-byte TN3270E header already stripped) and applies it to a
// ScreenBuffer.
//
// Each record begins with a Command byte; everything after is either an
// order (one of the byte values in Order.*) or raw text (EBCDIC bytes
// terminated by the next order byte). The job is to walk the record
// once, dispatch each piece, and finally rebuild the field index on
// the buffer so the renderer has consistent state.

import {
    Cmd, Order, Wcc, Sf, isWriteCommand, isEraseWrite, isAlternate,
} from './Constants.js';
import { BufferAddress } from './BufferAddress.js';
import { debugFor } from '../../../shared/src/core/debug.js';

const log = debugFor('tn3270.parser');

export class InboundParser {
    /** @param {import('../display/ScreenBuffer.js').ScreenBuffer} buffer
     *  @param {import('./IndFile.js').IndFile} [indFile]  optional file-transfer driver */
    constructor (buffer, indFile = null) {
        this.buffer = buffer;
        // Set when the host sends a Read Partition (Query) - main loop
        // will pick it up and reply with a Query Reply.
        this.queryRequested = false;
        // Set when an explicit Read command arrives (RB / RM / RMA).
        this.readRequest = null;     // { kind: 'RB'|'RM'|'RMA' }

        // Reply-mode for the next Read Buffer (set via Set Reply Mode SF).
        // 0 = field, 1 = extended-field, 2 = character (with attr-list).
        this.replyMode = 0;
        this.replyModeAttrs = [];

        // Optional IND$FILE driver - when non-null, SFs of type 0xD0
        // are dispatched to it and its accumulated replies are flushed
        // by the Terminal after each record.
        this.indFile = indFile;

        // Toggle from devtools (`terminal.parser.debug = true`) for a
        // hex dump of every record and structured field as it arrives.
        this.debug = false;
    }

    // ---- entry point ---------------------------------------------------

    /** Process one full 3270 record. */
    process (record) {
        if (record.length === 0) return;
        const cmd = record[0];
        if (this.debug) {
            const peek = Array.from(record).slice(0, 16).map(b => b.toString(16).padStart(2,'0')).join(' ');
            log.log(`cmd=${cmd.toString(16).padStart(2,'0')} len=${record.length} ${peek}${record.length>16?' …':''}`);
        }

        if (isWriteCommand(cmd)) {
            this.#processWrite(record);
        } else if (cmd === Cmd.EAU_6F || cmd === Cmd.EAU_0F) {
            this.buffer.eraseAllUnprotected();
            this.buffer.recalcFields();
            this.buffer.keyboardLocked = false;
        } else if (cmd === Cmd.WSF_F3 || cmd === Cmd.WSF_11) {
            this.#processWriteStructuredField(record, 1);
        } else if (cmd === Cmd.RB_F2 || cmd === Cmd.RB_02) {
            this.readRequest = { kind: 'RB' };
        } else if (cmd === Cmd.RM_F6 || cmd === Cmd.RM_06) {
            this.readRequest = { kind: 'RM' };
        } else if (cmd === Cmd.RMA_6E || cmd === Cmd.RMA_0E) {
            this.readRequest = { kind: 'RMA' };
        } else {
            // Unknown top-level command - bubble up so the Terminal can
            // emit a NEGATIVE-RESPONSE if the host requested one.
            const err = new Error(`Unknown 3270 command 0x${cmd.toString(16)}`);
            err.senseCode = 0x00;     // command reject
            throw err;
        }
    }

    // ---- W / EW / EWA --------------------------------------------------

    #processWrite (record) {
        const cmd = record[0];
        const erase = isEraseWrite(cmd);
        const alt   = isAlternate(cmd);
        // (Alternate just means "use the secondary screen size" - we don't
        // toggle dimensions here because the model is fixed at connect time
        // per the negotiated terminal type.)
        void alt;

        if (erase) {
            this.buffer.clearScreen();
            this.buffer.resetPen();
        }

        // Per IBM 3270 reference: every Write command locks the keyboard
        // until WCC's RESTORE_KEYBD bit unlocks it. Doing this up front
        // means WCC=0x00 (no flags) leaves the keyboard locked, which
        // matches what every host expects. Without this, screens that
        // arrive with WCC=0 silently leave us "typeable" but the host
        // is mid-update and rejects our next AID.
        this.buffer.keyboardLocked = true;

        const wcc = record[1] ?? 0;
        this.#processOrders(record, 2);
        this.buffer.recalcFields();
        this.#applyWcc(wcc);
    }

    #applyWcc (wcc) {
        if (wcc & Wcc.SOUND_ALARM)   this.buffer.alarm = true;
        if (wcc & Wcc.RESET_MDT)     this.buffer.resetAllMdt();
        if (wcc & Wcc.RESTORE_KEYBD) this.buffer.keyboardLocked = false;
    }

    // ---- Order dispatcher ---------------------------------------------

    #processOrders (record, start) {
        const buf = this.buffer;
        let p = start;
        const max = record.length;
        // PT after a text run erases the rest of the field - see the
        // IBM 3270 Data Stream Programmer's Reference. Only data bytes
        // count as "text" for this purpose; control orders (SF, SBA,
        // etc.) reset it.
        let prevWasText = false;

        while (p < max) {
            const b = record[p];
            let nextPrevText = false;

            switch (b) {
                case Order.SBA: {
                    this.#require(record, p, 3, 'SBA');
                    const addr = this.#address(record[p + 1], record[p + 2], 'SBA');
                    buf.moveTo(addr);
                    p += 3;
                    break;
                }
                case Order.SF: {
                    this.#require(record, p, 2, 'SF');
                    buf.startField(record[p + 1]);
                    buf.moveRight();
                    p += 2;
                    break;
                }
                case Order.SFE: {
                    this.#require(record, p, 2, 'SFE');
                    const pairs = record[p + 1] & 0xFF;
                    this.#require(record, p, 2 + pairs * 2, 'SFE attribute pairs');
                    let q = p + 2;
                    let faByte = 0x00;
                    // Pass 1: find FA among the pairs.
                    for (let i = 0; i < pairs; i++) {
                        const code = record[q + i * 2];
                        const val  = record[q + i * 2 + 1];
                        if (code === 0xC0) faByte = val;     // XA_START_FIELD
                    }
                    buf.startField(faByte);
                    // Pass 2: stash extended attrs onto the FA cell so the
                    // field-recalc step can hand them to content cells.
                    const faCell = buf.cells[buf.position];
                    for (let i = 0; i < pairs; i++) {
                        const code = record[q + i * 2];
                        const val  = record[q + i * 2 + 1];
                        if      (code === 0x42) faCell.foreground = val & 0xFF;
                        else if (code === 0x45) faCell.background = val & 0xFF;
                        else if (code === 0x41) faCell.highlight  = val & 0xFF;
                        else if (code === 0xC1) faCell.validation = val & 0xFF;
                    }
                    buf.moveRight();
                    p = q + pairs * 2;
                    break;
                }
                case Order.SA: {
                    this.#require(record, p, 3, 'SA');
                    buf.setPenAttribute(record[p + 1], record[p + 2]);
                    p += 3;
                    break;
                }
                case Order.MF: {
                    // Modify Field - replaces attrs on the FA at current
                    // pen position, then advances pen by 1 (per spec).
                    this.#require(record, p, 2, 'MF');
                    const pairs = record[p + 1] & 0xFF;
                    this.#require(record, p, 2 + pairs * 2, 'MF attribute pairs');
                    let q = p + 2;
                    for (let i = 0; i < pairs; i++)
                        buf.modifyFieldAttribute(record[q + i * 2], record[q + i * 2 + 1]);
                    buf.moveRight();
                    p = q + pairs * 2;
                    break;
                }
                case Order.IC: {
                    buf.cursor = buf.position;
                    p += 1;
                    break;
                }
                case Order.PT: {
                    // Program Tab: if we just wrote text, erase to the
                    // end of the current field first; then jump to the
                    // next unprotected field.
                    if (prevWasText) buf.eraseToNextField();
                    buf.tab();
                    buf.position = buf.cursor;
                    p += 1;
                    break;
                }
                case Order.RA: {
                    this.#require(record, p, 4, 'RA');
                    const stop = this.#address(record[p + 1], record[p + 2], 'RA');
                    let charByte;
                    let consumed;
                    if (record[p + 3] === Order.GE) {
                        this.#require(record, p, 5, 'RA GE');
                        charByte = record[p + 4];
                        consumed = 5;
                    } else {
                        charByte = record[p + 3];
                        consumed = 4;
                    }
                    if (buf.position === stop) {
                        // Same as RA-to-self: fill whole buffer with charByte.
                        for (let i = 0; i < buf.size; i++)
                            buf.write(charByte);
                    } else {
                        let safety = buf.size + 1;
                        while (buf.position !== stop && safety-- > 0)
                            buf.write(charByte);
                    }
                    p += consumed;
                    break;
                }
                case Order.EUA: {
                    // Erase unprotected to address: walk forward
                    // overwriting unprotected cells with nulls until we
                    // hit `stop`. Also reset MDT on any unprotected
                    // field we crossed - IBM spec says EUA implicitly
                    // re-modifies-then-clears, so the field appears
                    // un-modified after the order.
                    this.#require(record, p, 3, 'EUA');
                    const stop = this.#address(record[p + 1], record[p + 2], 'EUA');
                    let safety = buf.size + 1;
                    const touched = new Set();
                    while (buf.position !== stop && safety-- > 0) {
                        const c = buf.cells[buf.position];
                        if (!c.startField && !c.protected) {
                            c.byte = 0x00;
                            c.glyph = ' ';
                            const f = buf.fieldAt(buf.position);
                            if (f && !f.protected) touched.add(f);
                        }
                        buf.moveRight();
                    }
                    for (const f of touched) {
                        const fa = buf.cells[f.start];
                        if (fa.fa) {
                            fa.fa.modified = false;
                            fa.byte = (fa.byte & ~0x01) & 0xFF;
                        }
                        f.modified = false;
                    }
                    p += 3;
                    break;
                }
                case Order.GE: {
                    // Graphics Escape - emit the next byte as-is. We don't
                    // have a graphics font; render the EBCDIC glyph.
                    this.#require(record, p, 2, 'GE');
                    buf.write(record[p + 1]);
                    nextPrevText = true;
                    p += 2;
                    break;
                }
                // Plain bytes / format-control characters go to text.
                default: {
                    buf.write(b);
                    nextPrevText = true;
                    p += 1;
                    break;
                }
            }
            prevWasText = nextPrevText;
        }
    }

    #require (record, offset, count, label) {
        if (offset + count <= record.length) return;
        const err = new Error(`Truncated 3270 ${label} at offset ${offset}`);
        err.senseCode = 0x02;
        throw err;
    }

    #address (a, b, label) {
        const address = BufferAddress.decode(a, b);
        if (address >= this.buffer.size) {
            const err = new Error(`Illegal 3270 ${label} buffer address ${address}`);
            err.senseCode = 0x02;
            throw err;
        }
        return address;
    }

    // ---- WSF -----------------------------------------------------------

    #processWriteStructuredField (record, start) {
        let p = start;
        const max = record.length;
        while (p < max) {
            if (p + 3 > max) {
                const err = new Error(`Truncated 3270 structured-field header at offset ${p}`);
                err.senseCode = 0x02;
                throw err;
            }
            const size = ((record[p] & 0xFF) << 8) | (record[p + 1] & 0xFF);
            if (size < 3 || p + size > max) {
                const err = new Error(`Invalid 3270 structured-field length ${size} at offset ${p}`);
                err.senseCode = 0x02;
                throw err;
            }
            const sfType = record[p + 2];
            const body = record.subarray(p + 3, p + size);
            this.#processSf(sfType, body);
            p += size;
        }
    }

    #processSf (type, body) {
        if (this.debug) {
            const hex = Array.from(body).slice(0, 24).map(b => b.toString(16).padStart(2,'0')).join(' ');
            log.log(`WSF SF type=${type.toString(16).padStart(2,'0')} bodyLen=${body.length} body=${hex}${body.length>24?' …':''}`);
        }
        switch (type) {
            case Sf.READ_PARTITION:
                // body[0] = partition id, body[1] = type (0x02 = Query, 0x03 = QueryList)
                if (body.length >= 2 && body[0] === 0xFF
                    && (body[1] === 0x02 || body[1] === 0x03))
                    this.queryRequested = true;
                break;
            case Sf.OUTBOUND_3270DS: {
                // Wrapper: the second byte is partition ID, the rest is a
                // normal W/EW/EWA/EAU command - feed it back through.
                if (body.length < 2) {
                    const err = new Error('Truncated Outbound 3270DS structured field');
                    err.senseCode = 0x02;
                    throw err;
                }
                const partition = body[0]; void partition;
                const inner = body.subarray(1);
                this.process(inner);
                break;
            }
            case Sf.ERASE_RESET:
                // body[0] flags: 0x00 default partition, 0x80 alternate.
                this.buffer.clearScreen();
                this.buffer.resetPen();
                this.buffer.recalcFields();
                break;
            case Sf.SET_REPLY_MODE:
                // body[0] = partition id, body[1] = mode,
                // body[2..] = attribute-type list (only used in char mode).
                if (body.length >= 2) {
                    this.replyMode = body[1] & 0xFF;
                    this.replyModeAttrs = Array.from(body.subarray(2));
                }
                break;
            case Sf.RESET_PARTITION:
                // Accepted; nothing to render.
                break;
            case Sf.IND_FILE:
                // The body has its own RT/ST + records; the IndFile
                // driver parses and queues replies. The Terminal flushes
                // them via indFile.drainReplies() after this record is
                // fully processed.
                if (this.indFile) this.indFile.process(body);
                break;
            default:
                {
                    const err = new Error(`Unsupported 3270 structured field 0x${type.toString(16)}`);
                    err.senseCode = 0x00;
                    throw err;
                }
        }
    }
}
