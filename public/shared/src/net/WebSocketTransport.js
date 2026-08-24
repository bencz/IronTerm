// Thin wrapper around a WebSocket configured for binary frames. The
// upstream service is a websockify-style relay: every binary frame
// carries raw TCP bytes from / to the mainframe.

export class WebSocketTransport {
    /**
     * @param {string} url           ws:// or wss:// URL of the bridge
     * @param {object} handlers
     * @param {()=>void}                  handlers.onOpen
     * @param {(b:Uint8Array)=>void}      handlers.onData
     * @param {(reason:string)=>void}     handlers.onClose
     * @param {(err:string)=>void}        handlers.onError
     * @param {string|string[]}           [handlers.protocols]   websocket subprotocols
     */
    constructor (url, handlers) {
        this.url = url;
        this.handlers = handlers;
        this.ws = null;
        this.generation = 0;
        this.openTimeoutMs = handlers.openTimeoutMs ?? 15_000;
        this.maxMessageBytes = handlers.maxMessageBytes ?? (4 * 1024 * 1024);
        this.maxBufferedBytes = handlers.maxBufferedBytes ?? (4 * 1024 * 1024);
        this.openTimer = null;
    }

    open () {
        if (this.ws && (this.ws.readyState === WebSocket.CONNECTING ||
                        this.ws.readyState === WebSocket.OPEN)) {
            throw new Error('WebSocket transport is already open');
        }
        // The 'binary' subprotocol is what websockify uses for raw TCP.
        // Some bridges use 'binary.tn3270', so accept either when the
        // caller passes one explicitly; otherwise default to 'binary'.
        const protocols = this.handlers.protocols ?? 'binary';
        const ws = new WebSocket(this.url, protocols);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        const generation = ++this.generation;

        this.openTimer = setTimeout(() => {
            if (!this.#isCurrent(ws, generation) || ws.readyState !== WebSocket.CONNECTING) return;
            this.handlers.onError?.(`websocket open timeout after ${this.openTimeoutMs} ms`);
            try { ws.close(4000, 'open timeout'); } catch {}
        }, this.openTimeoutMs);

        ws.addEventListener('open', () => {
            if (!this.#isCurrent(ws, generation)) return;
            this.#clearOpenTimer();
            this.handlers.onOpen?.();
        });
        ws.addEventListener('message', async (ev) => {
            if (!this.#isCurrent(ws, generation)) return;
            if (typeof ev.data === 'string') {
                this.handlers.onError?.('unexpected text frame from websocket bridge');
                return;
            }
            let data;
            if (ev.data instanceof ArrayBuffer) data = new Uint8Array(ev.data);
            else if (typeof Blob !== 'undefined' && ev.data instanceof Blob)
                data = new Uint8Array(await ev.data.arrayBuffer());
            else {
                this.handlers.onError?.('unsupported websocket frame type');
                return;
            }
            if (!this.#isCurrent(ws, generation)) return;
            if (data.byteLength > this.maxMessageBytes) {
                this.handlers.onError?.(`websocket frame exceeds ${this.maxMessageBytes} bytes`);
                try { ws.close(1009, 'frame too large'); } catch {}
                return;
            }
            this.handlers.onData?.(data);
        });
        ws.addEventListener('close',   (ev) => {
            if (!this.#isCurrent(ws, generation)) return;
            this.#clearOpenTimer();
            this.ws = null;
            const clean = ev.wasClean ? 'clean' : 'unclean';
            this.handlers.onClose?.(ev.reason || `${clean} close, code ${ev.code}`);
        });
        ws.addEventListener('error',   () => {
            if (!this.#isCurrent(ws, generation)) return;
            this.handlers.onError?.('websocket error');
        });
    }

    /** Send raw bytes. No-op when not connected. */
    send (bytes) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            if (this.ws.bufferedAmount > this.maxBufferedBytes) {
                this.handlers.onError?.(`websocket backpressure exceeds ${this.maxBufferedBytes} bytes`);
                return false;
            }
            // Slice to a fresh buffer so the WebSocket implementation
            // can't see (and freeze) data the caller still owns.
            this.ws.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
            return true;
        }
        return false;
    }

    close () {
        if (!this.ws) return;
        const ws = this.ws;
        this.generation++;
        this.#clearOpenTimer();
        this.ws = null;
        try { ws.close(1000, 'client disconnect'); } catch { /* ignore */ }
    }

    get isOpen () {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    #isCurrent (ws, generation) {
        return this.ws === ws && this.generation === generation;
    }

    #clearOpenTimer () {
        if (this.openTimer !== null) {
            clearTimeout(this.openTimer);
            this.openTimer = null;
        }
    }
}
