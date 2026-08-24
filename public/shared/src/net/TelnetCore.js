// Generic Telnet framing + option machinery shared by TN3270 and TN5250.
//
// Responsibilities (always the same regardless of host protocol):
//   1. Strip / handle IAC sequences from inbound bytes.
//   2. Negotiate BINARY, EOR, TERMINAL-TYPE on its own. Any DO/WILL for
//      another option is offered to the configured extension; if the
//      extension claims the option as "known", we agree with DO/WILL,
//      otherwise we refuse with DONT/WONT.
//   3. Collect IAC SB ... IAC SE blocks. TERMINAL-TYPE SEND is handled
//      here directly (everyone answers it the same way). Everything else
//      is dispatched to `extension.handleSubnegotiation(opt, data)`.
//   4. Frame records on the way out: optional extension `wrapOutbound`
//      hook prepends protocol-specific headers; we add IAC EOR and
//      double any literal 0xFF inside the payload.
//   5. On the way in, optional `unwrapInbound` strips those headers and
//      attaches per-record metadata before we hand the payload up.
//   6. NOP keepalive so NAT entries stay warm and half-open sockets
//      surface promptly.
//
// The extension API is fully optional; with no extension, you get a
// vanilla telnet client that understands BINARY/EOR/TTYPE.

import { Telnet, TelnetOption, TermType } from '../proto/TelnetConstants.js';

const ASCII = new TextEncoder();

function asciiDecode (bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
}

/**
 * Extension contract (all methods optional):
 *   attach(core)                        — called once at construction
 *   isKnownOption(opt) → boolean        — agree to DO/WILL for this option?
 *   handleSubnegotiation(opt, data)     — IAC SB <opt> ... IAC SE
 *   onOptionEnabled(opt)                — option became active (we sent DO or WILL)
 *   onOptionDisabled(opt)               — option became inactive
 *   wrapOutbound(record) → Uint8Array   — prepend a protocol header
 *   unwrapInbound(bytes) → {payload, meta} | null
 *                                        — strip header, attach metadata,
 *                                          or return null to drop the record
 */
export class TelnetCore {
    /**
     * @param {object}   opts
     * @param {(b:Uint8Array)=>void}        opts.send        send raw bytes on the WS
     * @param {(rec:Uint8Array, meta:object)=>void} opts.onRecord  one full inbound record
     * @param {(state:object)=>void}        [opts.onState]   negotiation listener
     * @param {(b:Uint8Array)=>void}        [opts.onNvt]     pre-binary NVT text
     * @param {string}                      opts.terminalType   IBM-3278-2-E / IBM-3477-FC / ...
     * @param {object}                      [opts.extension] protocol plugin (see contract)
     * @param {number}                      [opts.keepAliveSeconds]  idle interval before NOP (default 120)
     * @param {number}                      [opts.maxRecordBytes] maximum inbound record (default 1 MiB)
     * @param {number}                      [opts.maxSubnegotiationBytes] maximum SB body (default 64 KiB)
     * @param {(message:string)=>void}      [opts.onProtocolError]
     */
    constructor ({ send, onRecord, onState, onNvt, terminalType, extension, keepAliveSeconds,
                   maxRecordBytes, maxSubnegotiationBytes, onProtocolError }) {
        this.rawSend = send;
        this.onRecord = onRecord;
        this.onState  = onState ?? (() => {});
        this.onNvt    = onNvt   ?? (() => {});
        this.onProtocolError = onProtocolError ?? (() => {});
        this.terminalType = terminalType ?? '';
        this.ext = extension ?? null;

        this.record = [];
        this.sb = null;
        this.iacPending = false;
        this.command = 0;
        this.discardRecord = false;
        this.discardSb = false;
        this.maxRecordBytes = maxRecordBytes ?? (1024 * 1024);
        this.maxSubnegotiationBytes = maxSubnegotiationBytes ?? (64 * 1024);

        // Telnet options are negotiated independently in each direction.
        // `local` means we WILL perform the option; `remote` means the
        // peer WILL perform it. Keeping those states separate prevents
        // repeated DO/WILL loops and, critically, avoids treating inbound
        // data as binary merely because the peer asked us to send binary.
        this.localOptions = new Set();
        this.remoteOptions = new Set();
        this.impliedBidirectionalOptions = new Set();

        // Negotiated state. Extensions can mutate this on `onOptionEnabled`
        // so the negotiation listener sees a single coherent object.
        // Initialised BEFORE `extension.attach` is called so extensions
        // can publish their own flags into the same object.
        this.state = {
            binary: false,
            eor:    false,
            ttype:  false,
        };

        // Now that core state is ready, let the extension wire itself in.
        if (this.ext?.attach) this.ext.attach(this);

        this.keepAliveMs    = (keepAliveSeconds ?? 120) * 1000;
        this.lastActivityAt = Date.now();
        this.keepAliveTimer = setInterval(() => this.#tickKeepAlive(), 30_000);
    }

    /** Mark the state object so extensions can publish their own flags. */
    setState (patch) {
        Object.assign(this.state, patch);
        this.onState(this.state);
    }

    /** Wraps the raw send so we can timestamp every outbound packet. */
    send (bytes) {
        this.lastActivityAt = Date.now();
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
        if (Date.now() - this.lastActivityAt < this.keepAliveMs) return;
        this.send(Uint8Array.of(Telnet.IAC, Telnet.NOP));
    }

    // ---- inbound -------------------------------------------------------

    /** Feed bytes coming in from the WebSocket. Must be a Uint8Array. */
    feed (bytes) {
        this.lastActivityAt = Date.now();
        this.nvtBatch = [];
        for (let i = 0; i < bytes.length; i++)
            this.#feedByte(bytes[i]);
        if (this.nvtBatch.length > 0)
            this.onNvt(Uint8Array.from(this.nvtBatch));
        this.nvtBatch = null;
    }

    #feedByte (b) {
        if (this.command !== 0) {
            this.#handleVerb(this.command, b);
            this.command = 0;
            return;
        }

        if (this.sb !== null) {
            if (this.iacPending) {
                this.iacPending = false;
                if (b === Telnet.SE) {
                    if (!this.discardSb) this.#handleSubnegotiation(this.sb);
                    this.sb = null;
                    this.discardSb = false;
                } else if (b === Telnet.IAC) {
                    this.#pushSb(0xFF);             // doubled IAC inside SB
                } else {
                    // Some other IAC inside an SB: per spec, ignore and
                    // keep collecting.
                    this.#pushSb(b);
                }
                return;
            }
            if (b === Telnet.IAC) { this.iacPending = true; return; }
            this.#pushSb(b);
            return;
        }

        if (this.iacPending) {
            this.iacPending = false;
            switch (b) {
                case Telnet.IAC:   this.#pushRecord(0xFF); return;     // doubled IAC == data 0xFF
                case Telnet.EOR:
                    if (this.#remoteEnabled(TelnetOption.EOR)) this.#emitRecord();
                    return;
                case Telnet.SB:    this.sb = []; this.discardSb = false; return;
                case Telnet.NOP:   return;
                case Telnet.DO:
                case Telnet.DONT:
                case Telnet.WILL:
                case Telnet.WONT:
                    this.command = b;
                    return;
                default:
                    // Unknown 2-byte command - ignore.
                    return;
            }
        }

        if (b === Telnet.IAC) { this.iacPending = true; return; }

        // Plain data byte. Two paths:
        //   - BINARY negotiated → it's part of a record (waiting for IAC EOR).
        //   - BINARY not negotiated → NVT mode (Telnet ASCII teletype),
        //     used by hosts that show a banner / connection-broker prompt
        //     before switching to the binary data stream.
        if (this.#remoteEnabled(TelnetOption.BINARY)) {
            this.#pushRecord(b);
        } else {
            this.nvtBatch?.push(b);
        }
    }

    #pushRecord (b) {
        if (this.discardRecord) return;
        if (this.record.length >= this.maxRecordBytes) {
            this.record.length = 0;
            this.discardRecord = true;
            this.onProtocolError(`Telnet record exceeds ${this.maxRecordBytes} bytes`);
            return;
        }
        this.record.push(b);
    }

    #pushSb (b) {
        if (this.discardSb) return;
        if (this.sb.length >= this.maxSubnegotiationBytes) {
            this.sb.length = 0;
            this.discardSb = true;
            this.onProtocolError(`Telnet subnegotiation exceeds ${this.maxSubnegotiationBytes} bytes`);
            return;
        }
        this.sb.push(b);
    }

    #emitRecord () {
        if (this.discardRecord) {
            this.record.length = 0;
            this.discardRecord = false;
            return;
        }
        if (this.record.length === 0) return;
        const bytes = Uint8Array.from(this.record);
        this.record.length = 0;

        if (this.ext?.unwrapInbound) {
            const out = this.ext.unwrapInbound(bytes);
            if (!out) return;                 // extension swallowed the record
            this.onRecord(out.payload, out.meta || {});
            return;
        }
        this.onRecord(bytes, {});
    }

    // ---- option verbs --------------------------------------------------

    #handleVerb (verb, opt) {
        const known = this.#isCoreOption(opt) || !!this.ext?.isKnownOption?.(opt);

        if (verb === Telnet.DO) {
            if (!known) {
                this.#sendBytes([Telnet.IAC, Telnet.WONT, opt]);
            } else if (!this.localOptions.has(opt)) {
                this.localOptions.add(opt);
                this.#sendBytes([Telnet.IAC, Telnet.WILL, opt]);
                this.#optionChanged(opt, 'local', true);
            }
            return;
        }
        if (verb === Telnet.DONT) {
            if (this.localOptions.delete(opt)) {
                this.#sendBytes([Telnet.IAC, Telnet.WONT, opt]);
                this.#optionChanged(opt, 'local', false);
            }
            return;
        }
        if (verb === Telnet.WILL) {
            if (!known) {
                this.#sendBytes([Telnet.IAC, Telnet.DONT, opt]);
            } else if (!this.remoteOptions.has(opt)) {
                this.remoteOptions.add(opt);
                this.#sendBytes([Telnet.IAC, Telnet.DO, opt]);
                this.#optionChanged(opt, 'remote', true);
            }
            return;
        }
        if (verb === Telnet.WONT) {
            if (this.remoteOptions.delete(opt)) {
                this.#sendBytes([Telnet.IAC, Telnet.DONT, opt]);
                this.#optionChanged(opt, 'remote', false);
            }
            return;
        }
    }

    #isCoreOption (opt) {
        return opt === TelnetOption.BINARY
            || opt === TelnetOption.SUPPRESS_GO_AHEAD
            || opt === TelnetOption.EOR
            || opt === TelnetOption.TERMINAL_TYPE;
    }

    /** Some negotiated protocols (notably TN3270E) imply BINARY and EOR
     *  in both directions without separate option commands. */
    setImpliedBidirectionalOption (opt, enabled) {
        if (enabled) this.impliedBidirectionalOptions.add(opt);
        else this.impliedBidirectionalOptions.delete(opt);
        this.#publishOptionState();
    }

    #localEnabled (opt) {
        return this.localOptions.has(opt) || this.impliedBidirectionalOptions.has(opt);
    }

    #remoteEnabled (opt) {
        return this.remoteOptions.has(opt) || this.impliedBidirectionalOptions.has(opt);
    }

    #publishOptionState () {
        this.state.binary = this.#remoteEnabled(TelnetOption.BINARY);
        this.state.eor = this.#remoteEnabled(TelnetOption.EOR);
        this.state.ttype = this.#localEnabled(TelnetOption.TERMINAL_TYPE);
        this.state.localBinary = this.#localEnabled(TelnetOption.BINARY);
        this.state.remoteBinary = this.#remoteEnabled(TelnetOption.BINARY);
        this.state.localEor = this.#localEnabled(TelnetOption.EOR);
        this.state.remoteEor = this.#remoteEnabled(TelnetOption.EOR);
        this.state.localSuppressGoAhead = this.#localEnabled(TelnetOption.SUPPRESS_GO_AHEAD);
        this.state.remoteSuppressGoAhead = this.#remoteEnabled(TelnetOption.SUPPRESS_GO_AHEAD);
        this.onState(this.state);
    }

    #optionChanged (opt, direction, enabled) {
        // Compatibility fields describe the direction consumed by the UI:
        // inbound BINARY/EOR and our locally supplied terminal type.
        if (enabled) this.ext?.onOptionEnabled?.(opt, direction);
        else this.ext?.onOptionDisabled?.(opt, direction);
        this.#publishOptionState();
    }

    // ---- subnegotiation -----------------------------------------------

    #handleSubnegotiation (data) {
        if (data.length === 0) return;
        // The byte-state machine accumulates into a growable Array, but
        // protocol extensions operate on typed byte views (`subarray`,
        // zero-copy slices). Normalise once at this boundary.
        const bytes = Uint8Array.from(data);
        const opt = bytes[0];
        if (opt === TelnetOption.TERMINAL_TYPE) {
            this.#handleTtype(bytes);
            return;
        }
        this.ext?.handleSubnegotiation?.(opt, bytes);
    }

    #handleTtype (data) {
        // Host: IAC SB TTYPE SEND IAC SE  → reply with our type.
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

    // ---- outbound ------------------------------------------------------

    /** Send a host record. Goes through `extension.wrapOutbound` to gain
     *  any protocol-specific header, then we double IAC bytes inside the
     *  payload and append IAC EOR. */
    sendRecord (record) {
        const wrapped = this.ext?.wrapOutbound
            ? this.ext.wrapOutbound(record)
            : record;

        this.sendFramedRecord(wrapped);
    }

    /** Frame an already protocol-wrapped record. Extensions use this for
     *  control records such as TN3270E RESPONSE, which must not pass through
     *  wrapOutbound a second time. */
    sendFramedRecord (wrapped) {
        // Double IAC bytes inside the payload.
        let doubles = 0;
        for (let i = 0; i < wrapped.length; i++)
            if (wrapped[i] === 0xFF) doubles++;

        let escaped = wrapped;
        if (doubles > 0) {
            escaped = new Uint8Array(wrapped.length + doubles);
            let p = 0;
            for (let i = 0; i < wrapped.length; i++) {
                escaped[p++] = wrapped[i];
                if (wrapped[i] === 0xFF) escaped[p++] = 0xFF;
            }
        }

        const out = new Uint8Array(escaped.length + 2);
        out.set(escaped, 0);
        out[escaped.length]     = Telnet.IAC;
        out[escaped.length + 1] = Telnet.EOR;
        this.send(out);
    }

    #sendBytes (arr) { this.send(Uint8Array.from(arr)); }

    /** Send raw ASCII text in NVT mode (for connection-broker prompts).
     *  Doubles 0xFF the same way records do; does not append IAC EOR. */
    sendNvtText (str) {
        const bytes = ASCII.encode(str);
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

// Re-export the ASCII decoder so extensions don't have to roll their own.
export { asciiDecode };
