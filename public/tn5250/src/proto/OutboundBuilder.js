// 5250 outbound (terminal → host) record builder.
//
// Every method returns a Uint8Array sized to the *payload* the
// telnet layer will frame with a GDS header (`GdsHeader.wrap`).
// The Terminal owns the wrapping so it can attach the right opcode
// and flag bits to each record.
//
// The big four for a usable signon:
//
//   buildAidResponse(aid)
//        Builds the response to an INVITE / READ_INPUT_FIELDS /
//        READ_MDT_FIELDS - 3 bytes of header (row, col, AID) followed
//        by all the unprotected/modified fields delimited by SBA orders.
//
//   buildQueryResponse(enhanced)
//        Answers the host's Query (WSF 0xD9/0x70) with the standard
//        64-byte structured field that identifies us as a 5250 emulator
//        and advertises capabilities (incl. ENPTUI when `enhanced`).
//
//   buildReadScreenResponse()
//        Dumps every cell of the presentation space verbatim (used
//        for screen-immediate reads / hostprint).
//
//   buildCancelInvite() / buildAttention()
//        Empty body records that drive housekeeping opcodes.

import { Aid, Gds, Adjust } from './Constants.js';

const ATTR_DEFAULT = 0x20;
const EBC_SPACE    = 0x40;
const EBC_ZERO     = 0xF0;

/** Slide the non-blank/non-null bytes in `arr` to the right edge and
 *  prefix the freed slots with `pad`. Used at submit time to honour
 *  the FFW byte 2 adjust nibble (right-zero / right-blank / mandatory).
 *  Mutates `arr` in place. */
function rightJustify (arr, pad) {
    // Find the rightmost non-space byte to know the actual data slice.
    let end = arr.length;
    while (end > 0 && (arr[end - 1] === EBC_SPACE || arr[end - 1] === 0))
        end--;
    if (end === 0) return;
    // Shift everything from [0..end) right so it ends at arr.length-1.
    const shift = arr.length - end;
    if (shift <= 0) return;
    for (let i = arr.length - 1; i >= shift; i--) arr[i] = arr[i - shift];
    for (let i = 0; i < shift; i++) arr[i] = pad;
}

export class OutboundBuilder {
    constructor (screen) {
        this.screen = screen;
    }

    // ---- AID response (Enter, PFx, Help, Roll, ...) -------------------

    /** Build the payload for a Put/Get opcode response. The host sees:
     *      <row> <col> <aid> [<SBA><row><col><field-data>]*
     *  Each modified field is preceded by an SBA pointing at its first
     *  data cell (one past the SF attribute byte). */
    buildAidResponse (aid, { includeAll = false, preserveNulls = false } = {}) {
        const out = [];
        // Cursor row/col are 1-based on the wire.
        const row = (this.screen.cursor / this.screen.cols | 0) + 1;
        const col = (this.screen.cursor % this.screen.cols) + 1;
        out.push(row, col, aid);
        if (aid === Aid.POINTER && this.screen.pendingPointerAid) {
            const pointer = this.screen.pendingPointerAid;
            out.push(pointer.row, pointer.col, pointer.aid);
            this.screen.pendingPointerAid = null;
        }

        // Some AIDs (CLEAR, HELP, Roll, PA-like keys) submit no field
        // data; everything else streams the modified fields.
        if (!this.#isShortRead(aid)) {
            for (const f of this.screen.fields) {
                if (f.bypass) continue;
                if (!includeAll && !f.modified) continue;
                this.#emitField(out, f, { preserveNulls });
            }
            this.#emitEnptuiFields(out, { includeAll });
        }
        return Uint8Array.from(out);
    }

    /** For Read MDT / Read Input we don't include cursor + AID -
     *  the host invited us so it knows where we are. The payload is
     *  just the SBA-delimited field stream. */
    buildReadResponse ({ includeAll = false, aid = null, preserveNulls = false } = {}) {
        const out = [];
        if (aid !== null) {
            const row = (this.screen.cursor / this.screen.cols | 0) + 1;
            const col = (this.screen.cursor % this.screen.cols) + 1;
            out.push(row, col, aid & 0xFF);
        }
        for (const f of this.screen.fields) {
            if (f.bypass) continue;
            if (!includeAll && !f.modified) continue;
            this.#emitField(out, f, { preserveNulls });
        }
        this.#emitEnptuiFields(out, { includeAll });
        return Uint8Array.from(out);
    }

    #emitEnptuiFields (out, { includeAll = false } = {}) {
        for (const construct of this.screen.enptui?.all ?? []) {
            const isSelection = construct.kind === 'selectionField'
                || construct.kind === 'menuBar'
                || construct.kind === 'pushButtons';
            const isStandaloneScroll = construct.kind === 'scrollBar' && !construct.parent;
            if (!isSelection && !isStandaloneScroll) continue;
            if (!includeAll && !construct.modified) continue;

            const addr = construct.cursorAtStart;
            if (!Number.isInteger(addr) || addr < 0 || addr >= this.screen.size) continue;
            out.push(0x11,
                ((addr / this.screen.cols) | 0) + 1,
                (addr % this.screen.cols) + 1);

            if (isStandaloneScroll) {
                this.#pushU32(out, construct.scrollIncrement ?? 0);
                continue;
            }

            // IBM serializes every non-multi construct (including menu bars
            // and push buttons) as a two-byte selected-choice index.
            if (!construct.multi) {
                const selected = construct.items.findIndex(item => item.selected);
                out.push(0x00, selected < 0 ? 0x00 : selected + 0x20);
            } else {
                for (const item of construct.items) out.push(item.selected ? 0xF1 : 0x00);
            }

            const attached = (this.screen.enptui?.all ?? []).find(c =>
                c.kind === 'scrollBar' && c.parent === construct);
            if (attached) this.#pushU32(out, attached.scrollIncrement ?? 0);

            // HOD clears selected choices while an auto-enter response is
            // being collected, preventing a transient button/menu choice
            // from remaining latched after its AID has been sent.
            if (construct.autoEnter) {
                for (const item of construct.items) item.selected = false;
            }
        }
    }

    #pushU32 (out, value) {
        const n = Math.max(0, Number(value) || 0) >>> 0;
        out.push((n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF);
    }

    #emitField (out, f, { preserveNulls = false } = {}) {
        const startData = (f.start + 1) % this.screen.size;
        const row = (startData / this.screen.cols | 0) + 1;
        const col = (startData % this.screen.cols) + 1;
        out.push(0x11, row, col);                 // SBA row col

        // Collect the field's data bytes first. `f.length` is the count
        // of data cells (per IBM SF order semantics).
        const bytes = new Array(f.length).fill(preserveNulls ? 0x00 : EBC_SPACE);
        for (let i = 0; i < f.length; i++) {
            const idx = (startData + i) % this.screen.size;
            const cell = this.screen.cells[idx];
            if (cell.startField) {
                // Hit the next field's attribute place - shrink length.
                bytes.length = i;
                break;
            }
            bytes[i] = preserveNulls ? cell.byte : (cell.byte === 0 ? EBC_SPACE : cell.byte);
        }

        // Apply field-level right-adjust / zero-fill before transmit.
        // 5250 reference: the bits in FFW byte 2 low nibble decide:
        //   5 = right-adjust, fill left with EBCDIC zero (0xF0)
        //   6 = right-adjust, fill left with EBCDIC blank (0x40)
        //   7 = mandatory-fill — pad zero-fill the same as 5
        // Other values (0..4) are "no adjustment". Real hardware does
        // the shift at field-exit time; we do it at submit which is
        // equivalent for non-DBCS fields.
        const adj = f.adjust;
        if (adj === Adjust.RIGHT_ZERO || adj === Adjust.MANDATORY) {
            rightJustify(bytes, EBC_ZERO);
        } else if (adj === Adjust.RIGHT_BLANK) {
            rightJustify(bytes, EBC_SPACE);
        }

        for (const b of bytes) out.push(b);
    }

    #isShortRead (aid) {
        // Per the 5250 reference, these AIDs submit ONLY cursor
        // row+col+AID with no field data:
        //   0xBD CLEAR
        //   0x6B / 0x6C / 0x6E  (PA1 / PA2 / PA3 - we don't bind keys
        //                       to these yet but the predicate stays)
        //   0xF3 HELP
        //   0xF6 PRINT
        //   0xF8 (reserved / display backup)
        return aid === Aid.HELP
            || aid === Aid.CLEAR
            || aid === Aid.PRINT
            || aid === 0x6B || aid === 0x6C || aid === 0x6E
            || aid === 0xF8;
    }

    // ---- Query response (RFC 1205 §5.3) -------------------------------

    /** Query reply through byte 60 as defined by RFC 1205. Capabilities
     *  are derived from the selected model and only implemented features
     *  are advertised. */
    buildQueryResponse ({ modelKey = '3179-2', enhanced = false } = {}) {
        const a = new Uint8Array(61);
        a[0] = 0x00;                // cursor row (0 = none in a WSF reply)
        a[1] = 0x00;                // cursor col
        a[2] = 0x88;                // inbound write-structured-field AID
        // Length counts bytes 3..60 inclusive.
        a[3] = 0x00;
        a[4] = 0x3A;
        a[5] = 0xD9;                // command class
        a[6] = 0x70;                // command type = Query
        a[7] = 0x80;                // flag byte
        a[8] = 0x06;                // controller hardware class ...
        a[9] = 0x00;                //   ... 0x0600 = "Other WSF / emulator"
        a[10] = 0x03;               // code level - V3R2.0
        a[11] = 0x02;
        a[12] = 0x00;
        // 13-28 reserved (zeroed by Uint8Array initialiser)
        a[29] = 0x01;               // device type 0x01 = 5250 emulator
        const modelIds = {
            '5251-11': '5251011', '5291-1': '5291001', '5292-2': '5292002',
            '3196-A1': '31960A1', '3179-2': '3179002', '3180-2': '3180002',
            '3477-FC': '34770FC', '3477-FG': '34770FG',
        };
        const modelId = this.screen.ebcdic.encode(modelIds[modelKey] ?? modelIds['3179-2']);
        a.set(modelId, 30);
        a[37] = 0x01;               // keyboard id
        a[38] = 0x01;               // extended keyboard id
        a[39] = 0x00;               // reserved
        a[40] = 0x00; a[41] = 0x24; a[42] = 0x24; a[43] = 0x00;  // serial
        a[44] = 0x01; a[45] = 0xF4;  // max display fields = 500
        // 46-48: reserved
        // Move Cursor + Read MDT Immediate Alternate are implemented.
        a[49] = 0x03;
        const large = this.screen.rows > 24 || this.screen.cols > 80;
        const color = ['5292-2', '3179-2', '3477-FC'].includes(modelKey);
        a[50] = (large ? 0x30 : 0x10) | (color ? 0x01 : 0x00);
        // Enhanced graphics is model/caller-controlled. Terminal enables
        // it only for the ENPTUI-capable 5292-2 profile.
        a[53] = enhanced ? 0x20 : 0x00;
        return a;
    }

    // ---- screen dump --------------------------------------------------

    buildReadScreenResponse () {
        const n = this.screen.size;
        const out = new Uint8Array(n);
        let lastAttr = ATTR_DEFAULT;
        for (let i = 0; i < n; i++) {
            const cell = this.screen.cells[i];
            if (cell.attributePlace) {
                lastAttr = cell.byte;
                out[i] = lastAttr;
            } else {
                out[i] = cell.byte === 0 ? 0x40 : cell.byte;
            }
        }
        return out;
    }

    /** RFC 1205 Save Screen response: ESC Restore-Screen followed by
     *  the complete screen image. The host later returns this exact
     *  payload in a Restore Screen operation. */
    buildSaveScreenResponse () {
        const image = this.buildReadScreenResponse();
        const out = new Uint8Array(2 + image.length);
        out[0] = 0x04;                  // command escape
        out[1] = 0x12;                  // Restore Screen command
        out.set(image, 2);
        return out;
    }

    // ---- empty bodies for control opcodes -----------------------------

    /** Cancel-Invite uses a fixed empty payload + opcode 0x0A. */
    buildCancelInvite () { return new Uint8Array(0); }
    /** Attention uses ATN flag + empty payload + opcode 0x00. */
    buildAttention ()    { return new Uint8Array(0); }
}

// Reference exports so Terminal.js can spell out the flags it needs
// without re-importing from ./Constants.js.
export { Gds };
