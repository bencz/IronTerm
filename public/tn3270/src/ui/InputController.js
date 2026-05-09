// Input handling: keyboard → terminal commands, mouse → selection +
// cursor placement, clipboard copy/paste. Pure UI glue - talks to the
// Terminal via callback hooks; never touches the wire directly.

import { aidFromName } from '../proto/Constants.js';

const DRAG_PIXEL_THRESHOLD = 3;
void DRAG_PIXEL_THRESHOLD;

export class InputController {
    /**
     * @param {object} hooks
     * @param {HTMLCanvasElement} hooks.canvas
     * @param {import('./Renderer.js').Renderer} hooks.renderer
     * @param {import('../display/ScreenBuffer.js').ScreenBuffer} hooks.screen
     * @param {(aid:number)=>void}  hooks.onAid
     * @param {(s:string)=>void}    hooks.onType
     * @param {()=>void}            hooks.onTab
     * @param {()=>void}            hooks.onBackspace
     * @param {(addr:number)=>void} hooks.onMoveCursor
     * @param {(text:string)=>void} hooks.onFlash
     */
    constructor (hooks) {
        this.h = hooks;
        this.canvas = hooks.canvas;
        this.renderer = hooks.renderer;
        this.screen = hooks.screen;

        this.selection = null;
        this.dragOrigin = null;
        this.dragMoved = false;

        this.#bindKeyboard();
        this.#bindMouse();
    }

    // ---- keyboard -----------------------------------------------------

    #bindKeyboard () {
        document.addEventListener('keydown', async (event) => {
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA')
                return;
            const mod = event.metaKey || event.ctrlKey;

            // Clipboard shortcuts work even offline.
            if (mod && event.key.toLowerCase() === 'c') {
                event.preventDefault(); await this.#copy(); return;
            }
            if (mod && event.key.toLowerCase() === 'v') {
                event.preventDefault(); await this.#paste(); return;
            }
            if (mod && event.key.toLowerCase() === 'a') {
                event.preventDefault(); this.#selectAll(); return;
            }

            if (event.key === 'Escape' && this.selection) {
                event.preventDefault();
                this.#clearSelection();
                return;
            }

            const aid = this.#functionKeyName(event);
            if (aid) {
                event.preventDefault();
                const code = aidFromName(aid);
                if (code !== null) this.h.onAid?.(code);
                return;
            }

            if (event.key === 'Tab')        { event.preventDefault(); this.h.onTab?.(); return; }
            if (event.key === 'Backspace')  { event.preventDefault(); this.h.onBackspace?.(); return; }

            if (event.key === 'Insert')     { event.preventDefault(); this.h.onToggleInsert?.(); return; }

            if (event.key === 'Home')       { event.preventDefault(); this.#home(); return; }
            if (event.key === 'End')        { event.preventDefault(); this.#end(); return; }

            if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
                event.preventDefault();
                this.#arrow(event.key);
                return;
            }

            if (event.key.length === 1 && !mod) {
                event.preventDefault();
                this.h.onType?.(event.key);
            }
        });
    }

    #functionKeyName (event) {
        if (event.key === 'Enter')    return 'Enter';
        if (event.key === 'Escape')   return 'Clear';
        if (event.key === 'PageUp')   return 'PF7';
        if (event.key === 'PageDown') return 'PF8';
        if (event.key.startsWith('F') && /^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) {
            const n = parseInt(event.key.slice(1), 10);
            return event.shiftKey ? `PF${n + 12}` : `PF${n}`;
        }
        return null;
    }

    #home () {
        const target = this.screen.fields.find(f => !f.protected);
        if (target) this.h.onMoveCursor?.((target.start + 1) % this.screen.size);
    }

    #end () {
        const s = this.screen;
        const here = s.cursor;
        const field = s.fieldAt(here);
        if (!field || field.protected) return;
        let last = (field.start + 1) % s.size;
        let p = (field.start + 1) % s.size;
        for (let n = 1; n < field.length; n++) {
            const cell = s.cells[p];
            if (cell && cell.byte !== 0x00 && cell.glyph !== ' ')
                last = (p + 1) % s.size;
            p = (p + 1) % s.size;
        }
        this.h.onMoveCursor?.(last);
    }

    #arrow (key) {
        const s = this.screen;
        let addr = s.cursor;
        if (key === 'ArrowLeft')  addr = (addr - 1 + s.size) % s.size;
        if (key === 'ArrowRight') addr = (addr + 1) % s.size;
        if (key === 'ArrowUp')    addr = (addr - s.cols + s.size) % s.size;
        if (key === 'ArrowDown')  addr = (addr + s.cols) % s.size;
        this.h.onMoveCursor?.(addr);
    }

    // ---- mouse / selection --------------------------------------------

    #bindMouse () {
        this.canvas.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            this.dragOrigin = this.#cellAtMouse(event);
            this.dragMoved = false;
            this.selection = this.#norm(this.dragOrigin, this.dragOrigin);
            this.renderer.setSelection(this.selection);
        });
        this.canvas.addEventListener('mousemove', (event) => {
            if (!this.dragOrigin) return;
            const cell = this.#cellAtMouse(event);
            if (cell.row !== this.dragOrigin.row || cell.col !== this.dragOrigin.col)
                this.dragMoved = true;
            this.selection = this.#norm(this.dragOrigin, cell);
            this.renderer.setSelection(this.selection);
        });
        document.addEventListener('mouseup', () => {
            if (!this.dragOrigin) return;
            const wasDrag = this.dragMoved;
            const click = this.dragOrigin;
            this.dragOrigin = null;
            if (!wasDrag) {
                this.selection = null;
                this.renderer.setSelection(null);
                const addr = click.row * this.screen.cols + click.col;
                this.h.onMoveCursor?.(addr);
            }
        });
    }

    #cellAtMouse (event) {
        const rect = this.canvas.getBoundingClientRect();
        const cw = rect.width  / this.screen.cols;
        const ch = rect.height / this.screen.rows;
        const col = Math.max(0, Math.min(this.screen.cols - 1,
            Math.floor((event.clientX - rect.left) / cw)));
        const row = Math.max(0, Math.min(this.screen.rows - 1,
            Math.floor((event.clientY - rect.top) / ch)));
        return { row, col };
    }

    #norm (o, e) {
        return {
            row1: Math.min(o.row, e.row),
            col1: Math.min(o.col, e.col),
            row2: Math.max(o.row, e.row),
            col2: Math.max(o.col, e.col),
        };
    }

    #clearSelection () {
        this.selection = null;
        this.renderer.setSelection(null);
    }

    #selectAll () {
        const s = this.screen;
        this.selection = { row1: 0, col1: 0, row2: s.rows - 1, col2: s.cols - 1 };
        this.renderer.setSelection(this.selection);
    }

    // ---- clipboard ----------------------------------------------------

    #selectionToText () {
        if (!this.selection) return '';
        const s = this.screen;
        const lines = [];
        for (let r = this.selection.row1; r <= this.selection.row2; r++) {
            let line = '';
            for (let c = this.selection.col1; c <= this.selection.col2; c++) {
                const cell = s.cells[r * s.cols + c];
                if (!cell) continue;
                line += cell.hidden ? ' ' : (cell.glyph || ' ');
            }
            lines.push(line.replace(/\s+$/, ''));
        }
        return lines.join('\n');
    }

    async #copy () {
        const text = this.#selectionToText();
        if (!text) { this.h.onFlash?.('nothing selected'); return; }
        try {
            await navigator.clipboard.writeText(text);
            this.h.onFlash?.(`copied ${text.length} chars`);
        } catch {
            // Fallback for browsers that block the async clipboard API.
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity  = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); this.h.onFlash?.(`copied ${text.length} chars`); }
            catch { this.h.onFlash?.('copy failed'); }
            finally { document.body.removeChild(ta); }
        }
    }

    async #paste () {
        try {
            const text = await navigator.clipboard.readText();
            if (!text) return;
            // 3270 input fields are flat - strip line breaks and tabs so
            // they don't get typed as literal control chars.
            const cleaned = text.replace(/[\r\n\t]+/g, ' ');
            this.h.onType?.(cleaned);
        } catch {
            this.h.onFlash?.('paste blocked');
        }
    }
}
