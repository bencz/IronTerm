// Telnet framing + TN3270/TN3270E option negotiation.
//
// Sits between the raw byte stream (delivered from a websockify-style
// bridge) and the 3270 layer. Responsibilities:
//
//   1. Strip / handle Telnet IAC sequences (DO, DONT, WILL, WONT,
//      subnegotiations, EOR record framing).
//   2. Negotiate BINARY, EOR, TERMINAL-TYPE, TN3270E — accept
//      everything we want, refuse everything else.
//   3. Strip the 5-byte TN3270E data-stream header from inbound 3270
//      records, emit the same header on outbound records.
//   4. Surface complete 3270 records to the listener (via `onRecord`).
//
// Outbound bytes that contain a literal 0xFF must be doubled before
// going on the wire — Telnet treats a single 0xFF as IAC.

import { Telnet, TelnetOption, TermType, Tn3270e, TnHeader, Models } from '../proto/Constants.js';

const ASCII = new TextEncoder();

// Decode an ASCII byte sequence; tolerant of non-ASCII bytes (replaced
// with '?' which never matters because hosts only send ASCII in
// terminal-type / TN3270E subnegotiations).
function asciiDecode (bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
}

export class TelnetStream {
    /**
     * @param {object}   opts
     * @param {(b:Uint8Array)=>void} opts.send       send raw bytes on the WS
     * @param {(rec:Uint8Array)=>void} opts.onRecord called once per 3270 record
     * @param {(state:object)=>void} [opts.onState]  optional negotiation listener
     * @param {(b:Uint8Array)=>void} [opts.onNvt]    optional NVT-mode text listener
     * @param {string}   [opts.terminalType]         e.g. "IBM-3278-2-E"
     * @param {number}   [opts.keepAliveSeconds]     idle interval before NOP (default 120s)
     */
    constructor ({ send, onRecord, onState, onNvt, terminalType, keepAliveSeconds }) {
        this.rawSend   = send;
        this.onRecord  = onRecord;
        this.onState   = onState ?? (() => {});
        this.onNvt     = onNvt   ?? (() => {});
        this.terminalType = terminalType ?? Models[2].terminalType;

        // Buffer for the in-progress 3270 record.
        this.record = [];
        // Buffer for an in-progress IAC SB ... IAC SE block.
        this.sb = null;
        // True after we've seen a lone IAC and are waiting for the second byte.
        this.iacPending = false;
        // The verb we are mid-decoding (DO/DONT/WILL/WONT) — null otherwise.
        this.command = 0;

        // Negotiated state
        this.state = {
            binary: false,
            eor: false,
            ttype: false,
            tn3270e: false,
            deviceType: '',
            functions: [],
        };

        // ---- NOP keepalive ----------------------------------------
        // Send `IAC NOP` whenever the connection has been idle for
        // 2 minutes — keeps NAT entries warm and detects half-open
        // sockets. We only schedule it once we've actually seen a byte
        // (i.e. socket is connected); it stops automatically on close.
        this.keepAliveMs = (keepAliveSeconds ?? 120) * 1000;
        this.lastSendAt = Date.now();
        this.keepAliveTimer = setInterval(() => this.#tickKeepAlive(), 30_000);

        // Outbound TN3270E sequence counter — RFC 2355 §3.2 says these
        // should be unique and monotonically increasing. The 16-bit
        // field wraps at 0xFFFF; we start at 0 and increment per record.
        // Hosts that don't validate this (most don't) are unaffected.
        this.outboundSeq = 0;
    }

    /** Wraps the raw send so we can timestamp every outbound packet. */
    send (bytes) {
        this.lastSendAt = Date.now();
        this.rawSend(bytes);
    }

    /** Stop timers etc. */
    close () {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    #tickKeepAlive () {
        if (Date.now() - this.lastSendAt < this.keepAliveMs) return;
        this.send(Uint8Array.of(Telnet.IAC, Telnet.NOP));
    }

    // ---- inbound -------------------------------------------------------

    /** Feed bytes coming in from the WebSocket. Must be a Uint8Array. */
    feed (bytes) {
        for (let i = 0; i < bytes.length; i++)
            this.#feedByte(bytes[i]);
    }

    #feedByte (b) {
        // Mid-DO/DONT/WILL/WONT — `b` is the option code.
        if (this.command !== 0) {
            this.#handleVerb(this.command, b);
            this.command = 0;
            return;
        }

        if (this.sb !== null) {
            // Inside an SB block. Watch for IAC SE.
            if (this.iacPending) {
                this.iacPending = false;
                if (b === Telnet.SE) {
                    this.#handleSubnegotiation(this.sb);
                    this.sb = null;
                } else if (b === Telnet.IAC) {
                    this.sb.push(0xFF);             // doubled IAC inside SB
                } else {
                    // Some other IAC inside an SB: the spec says ignore
                    // and keep collecting.
                    this.sb.push(b);
                }
                return;
            }
            if (b === Telnet.IAC) { this.iacPending = true; return; }
            this.sb.push(b);
            return;
        }

        if (this.iacPending) {
            this.iacPending = false;
            switch (b) {
                case Telnet.IAC:   this.record.push(0xFF); return;     // doubled IAC == data 0xFF
                case Telnet.EOR:   this.#emitRecord(); return;
                case Telnet.SB:    this.sb = []; return;
                case Telnet.NOP:   return;
                case Telnet.DO:
                case Telnet.DONT:
                case Telnet.WILL:
                case Telnet.WONT:
                    this.command = b;
                    return;
                default:
                    // Unknown 2-byte command — ignore.
                    return;
            }
        }

        if (b === Telnet.IAC) { this.iacPending = true; return; }

        // Plain data byte. Two paths:
        //   - BINARY negotiated → it's part of a 3270 record (waiting for IAC EOR).
        //   - BINARY not negotiated → we're in NVT mode (Telnet's default ASCII
        //     teletype mode). Hosts that show a banner / connection-broker
        //     prompt before switching to TN3270 land here. Forward to the
        //     NVT listener; do NOT accumulate as 3270 data.
        if (this.state.binary) {
            this.record.push(b);
        } else {
            this.onNvt(Uint8Array.of(b));
        }
    }

    #emitRecord () {
        if (this.record.length === 0) return;
        const bytes = Uint8Array.from(this.record);
        this.record.length = 0;

        if (!this.state.tn3270e) {
            // Plain TN3270 (no header) — feed everything to the 3270 layer.
            // No metadata; positive/negative responses are TN3270E-only.
            this.onRecord(bytes, { dataType: TnHeader.TYPE_3270_DATA, seq: 0, responseFlag: 0 });
            return;
        }

        if (bytes.length < TnHeader.LENGTH) return;
        const dataType     = bytes[0];
        const requestFlag  = bytes[1];   void requestFlag;
        const responseFlag = bytes[2];
        const seq          = (bytes[3] << 8) | bytes[4];
        const payload      = bytes.subarray(TnHeader.LENGTH);

        // Only TYPE_3270_DATA carries 3270 datastream we should render.
        // BIND_IMAGE / UNBIND / NVT / SSCP-LU all reach us when we
        // negotiated BIND-IMAGE; let them pass silently — we don't
        // implement SNA bind state (and the host operates fine without).
        // Note: we no longer emit the positive response here; the
        // upper layer (Terminal) decides based on whether parsing
        // succeeded, so negative responses can be sent on errors.
        if (dataType === TnHeader.TYPE_3270_DATA)
            this.onRecord(payload, { dataType, seq, responseFlag });
    }

    /** Echo a successful record with an empty body. Caller picks the
     *  right time (after parsing succeeded) and passes the host's seq. */
    sendPositiveResponse (seq) {
        const out = new Uint8Array(7);
        out[0] = TnHeader.TYPE_RESPONSE;
        out[1] = 0x00;        // POSITIVE
        out[2] = 0x00;
        out[3] = (seq >> 8) & 0xFF;
        out[4] =  seq       & 0xFF;
        out[5] = Telnet.IAC;
        out[6] = Telnet.EOR;
        this.send(out);
    }

    /** Reject a record we couldn't process. `senseCode` is one byte —
     *  RFC 2355 §5.4 leaves the values implementation-defined; common
     *  values used by other implementations:
     *    0x10  function not supported / generic input error
     *    0x08  operation check / sequence error
     *  Hosts care more about *whether* a negative response arrives than
     *  the sense byte itself; our default is 0x10. */
    sendNegativeResponse (seq, senseCode = 0x10) {
        const out = new Uint8Array(8);
        out[0] = TnHeader.TYPE_RESPONSE;
        out[1] = 0x00;
        out[2] = 0x01;        // NEGATIVE
        out[3] = (seq >> 8) & 0xFF;
        out[4] =  seq       & 0xFF;
        out[5] = senseCode & 0xFF;
        out[6] = Telnet.IAC;
        out[7] = Telnet.EOR;
        this.send(out);
    }

    // ---- option verbs --------------------------------------------------

    #handleVerb (verb, opt) {
        const T = TelnetOption;
        const known = opt === T.BINARY || opt === T.EOR
                   || opt === T.TERMINAL_TYPE || opt === T.TN3270E;

        // Host: DO <opt>  → we agree (WILL) iff it's an option we want.
        if (verb === Telnet.DO) {
            const reply = known ? Telnet.WILL : Telnet.WONT;
            this.#sendBytes([Telnet.IAC, reply, opt]);
            if (reply === Telnet.WILL) this.#markEnabled(opt);
            return;
        }
        // Host: DONT  → confirm WONT
        if (verb === Telnet.DONT) {
            this.#sendBytes([Telnet.IAC, Telnet.WONT, opt]);
            this.#markDisabled(opt);
            return;
        }
        // Host: WILL <opt>  → we accept (DO) iff it's one we want.
        if (verb === Telnet.WILL) {
            const reply = known ? Telnet.DO : Telnet.DONT;
            this.#sendBytes([Telnet.IAC, reply, opt]);
            if (reply === Telnet.DO) this.#markEnabled(opt);
            return;
        }
        // Host: WONT  → confirm DONT
        if (verb === Telnet.WONT) {
            this.#sendBytes([Telnet.IAC, Telnet.DONT, opt]);
            this.#markDisabled(opt);
            return;
        }
    }

    #markEnabled (opt) {
        switch (opt) {
            case TelnetOption.BINARY:        this.state.binary = true; break;
            case TelnetOption.EOR:           this.state.eor = true; break;
            case TelnetOption.TERMINAL_TYPE: this.state.ttype = true; break;
            case TelnetOption.TN3270E:       this.state.tn3270e = true; break;
        }
        this.onState(this.state);
    }
    #markDisabled (opt) {
        switch (opt) {
            case TelnetOption.BINARY:        this.state.binary = false; break;
            case TelnetOption.EOR:           this.state.eor = false; break;
            case TelnetOption.TERMINAL_TYPE: this.state.ttype = false; break;
            case TelnetOption.TN3270E:       this.state.tn3270e = false; break;
        }
        this.onState(this.state);
    }

    // ---- subnegotiation -----------------------------------------------

    #handleSubnegotiation (data) {
        if (data.length === 0) return;
        const opt = data[0];
        if (opt === TelnetOption.TERMINAL_TYPE) {
            this.#handleTtype(data);
        } else if (opt === TelnetOption.TN3270E) {
            this.#handleTn3270e(data);
        }
        // BINARY / EOR have no SB; anything else is ignored.
    }

    #handleTtype (data) {
        // Host sends: IAC SB TTYPE SEND IAC SE  → reply with our type.
        if (data[1] === TermType.SEND) {
            const name = ASCII.encode(this.terminalType);
            const out = new Uint8Array(4 + name.length + 2);
            let p = 0;
            out[p++] = Telnet.IAC; out[p++] = Telnet.SB;
            out[p++] = TelnetOption.TERMINAL_TYPE;
            out[p++] = TermType.IS;
            out.set(name, p); p += name.length;
            out[p++] = Telnet.IAC; out[p++] = Telnet.SE;
            this.send(out);
        }
    }

    #handleTn3270e (data) {
        // Layout: 0x28 <op> <subop> [...payload...]
        const op    = data[1];
        const subOp = data[2];

        // Host: SEND DEVICE-TYPE  → respond with DEVICE-TYPE REQUEST <type>
        if (op === Tn3270e.SEND && subOp === Tn3270e.DEVICE_TYPE) {
            const name = ASCII.encode(this.terminalType);
            const out = new Uint8Array(5 + name.length + 2);
            let p = 0;
            out[p++] = Telnet.IAC; out[p++] = Telnet.SB;
            out[p++] = TelnetOption.TN3270E;
            out[p++] = Tn3270e.DEVICE_TYPE;
            out[p++] = Tn3270e.REQUEST;
            out.set(name, p); p += name.length;
            out[p++] = Telnet.IAC; out[p++] = Telnet.SE;
            this.send(out);
            return;
        }

        // Host: DEVICE-TYPE IS <name> [0x01 <luname>]
        if (op === Tn3270e.DEVICE_TYPE && subOp === Tn3270e.IS) {
            // Find optional separator (0x01) splitting deviceType from LU.
            let sep = -1;
            for (let i = 3; i < data.length; i++)
                if (data[i] === 0x01) { sep = i; break; }
            const end = sep === -1 ? data.length : sep;
            this.state.deviceType = asciiDecode(data.slice(3, end));
            this.onState(this.state);
            // Now request the standard set of functions: BIND-IMAGE (0),
            // RESPONSES (2), SYSREQ (4).
            const fns = [Tn3270e.FN_BIND_IMAGE, Tn3270e.FN_RESPONSES, Tn3270e.FN_SYSREQ];
            const out = new Uint8Array(5 + fns.length + 2);
            let p = 0;
            out[p++] = Telnet.IAC; out[p++] = Telnet.SB;
            out[p++] = TelnetOption.TN3270E;
            out[p++] = Tn3270e.FUNCTIONS;
            out[p++] = Tn3270e.REQUEST;
            for (const f of fns) out[p++] = f;
            out[p++] = Telnet.IAC; out[p++] = Telnet.SE;
            this.send(out);
            return;
        }

        // Host: FUNCTIONS REQUEST <list> — host counter-proposed; accept
        // its list verbatim by echoing as IS.
        if (op === Tn3270e.FUNCTIONS && subOp === Tn3270e.REQUEST) {
            const out = new Uint8Array(data.length + 4);
            let p = 0;
            out[p++] = Telnet.IAC; out[p++] = Telnet.SB;
            out.set(data, p); p += data.length;
            out[2 + 2] = Tn3270e.IS;        // overwrite the REQUEST sub-op
            out[p++] = Telnet.IAC; out[p++] = Telnet.SE;
            this.send(out);
            this.state.functions = Array.from(data.slice(3));
            this.onState(this.state);
            return;
        }

        // Host: FUNCTIONS IS <list> — agreement; nothing to do but record.
        if (op === Tn3270e.FUNCTIONS && subOp === Tn3270e.IS) {
            this.state.functions = Array.from(data.slice(3));
            this.onState(this.state);
            return;
        }
    }

    // ---- outbound ------------------------------------------------------

    /** Send a 3270 record. Wraps it in the TN3270E header (when the
     *  option is active) and the IAC EOR framing, doubling any literal
     *  0xFF bytes inside the payload first. */
    sendRecord (record3270) {
        // Double IAC bytes inside the payload.
        let escaped = record3270;
        let doubles = 0;
        for (let i = 0; i < record3270.length; i++)
            if (record3270[i] === 0xFF) doubles++;
        if (doubles > 0) {
            escaped = new Uint8Array(record3270.length + doubles);
            let p = 0;
            for (let i = 0; i < record3270.length; i++) {
                escaped[p++] = record3270[i];
                if (record3270[i] === 0xFF) escaped[p++] = 0xFF;
            }
        }

        const headerLen = this.state.tn3270e ? TnHeader.LENGTH : 0;
        const out = new Uint8Array(headerLen + escaped.length + 2);
        let p = 0;
        if (headerLen > 0) {
            // Increment then use — first record has seq=1, wraps at 0xFFFF.
            this.outboundSeq = (this.outboundSeq + 1) & 0xFFFF;
            const seq = this.outboundSeq;
            out[p++] = TnHeader.TYPE_3270_DATA;
            out[p++] = 0x00;                              // request-flag
            out[p++] = 0x00;                              // response-flag (NO_RESPONSE)
            out[p++] = (seq >> 8) & 0xFF;
            out[p++] =  seq       & 0xFF;
        }
        out.set(escaped, p); p += escaped.length;
        out[p++] = Telnet.IAC;
        out[p++] = Telnet.EOR;
        this.send(out);
    }

    #sendBytes (arr) { this.send(Uint8Array.from(arr)); }

    /** Send raw ASCII text in NVT mode (for connection-broker prompts).
     *  Doubles 0xFF the same way 3270 records do, and translates the JS
     *  string with a TextEncoder; doesn't append IAC EOR. */
    sendNvtText (str) {
        const bytes = ASCII.encode(str);
        // IAC doubling
        let doubles = 0;
        for (const b of bytes) if (b === 0xFF) doubles++;
        if (doubles === 0) {
            this.send(bytes);
            return;
        }
        const out = new Uint8Array(bytes.length + doubles);
        let p = 0;
        for (const b of bytes) {
            out[p++] = b;
            if (b === 0xFF) out[p++] = 0xFF;
        }
        this.send(out);
    }

    /** True while we're still in raw NVT (Telnet-default) mode. */
    get isNvt () { return !this.state.binary; }
}
