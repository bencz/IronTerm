// Input handling for the TN5250 client: keyboard → AID / typing,
// mouse → cursor placement + selection, clipboard copy/paste.
//
// Mirrors the TN3270 controller's architecture (document-level keydown
// so the canvas doesn't need focus) but with the 5250 AID set and
// navigation conventions: PageUp = Roll Down, PageDown = Roll Up,
// Help = Ctrl+H, Print = Ctrl+P, Escape = Error Reset.

import { Aid, aidFromName, ATTR_BASE } from '../proto/Constants.js';
import { ConstructKind } from '../proto/enptui/Constants.js';
import { Selection } from './Selection.js';

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
     * @param {()=>void}            hooks.onDelete
     * @param {()=>void}            hooks.onEraseEof
     * @param {()=>void}            hooks.onEraseInput
     * @param {()=>void}            hooks.onInsert
     * @param {(addr:number)=>void} hooks.onMoveCursor
     * @param {(text:string)=>void} hooks.onFlash
     * @param {()=>void}            hooks.onSystemRequest
     * @param {()=>void}            hooks.onFieldExit
     * @param {()=>void}            hooks.onFieldPlus
     * @param {()=>void}            hooks.onFieldMinus
     */
    constructor (hooks) {
        this.h = hooks;
        this.canvas = hooks.canvas;
        this.renderer = hooks.renderer;
        this.screen = hooks.screen;
        this.pendingPointer = null;

        this.selection = new Selection({
            canvas:        hooks.canvas,
            renderer:      hooks.renderer,
            screen:        hooks.screen,
            onType:        hooks.onType,
            onFlash:       hooks.onFlash,
            onClickCursor: (click) => this.#handleClick(click),
            onPointerEvent: (click) => this.#handlePointerEvent(click),
            hasPointerDefinitions: () => this.#pointerDefinitions().length > 0,
        });

        this.#bindKeyboard();
    }

    #handleClick (click) {
        if (this.#tryEnptuiClick(click)) return;
        const addr = click.row * this.screen.cols + click.col;
        this.h.onMoveCursor?.(addr);
    }

    #pointerDefinitions () {
        return this.screen.enptui?.all.find(
            c => c.kind === ConstructKind.MOUSE_EVENTS)?.definitions ?? [];
    }

    #handlePointerEvent (click) {
        // IBM routes selection-field and scrollbar cells through their
        // construct handlers before consulting programmable mouse events.
        if (this.#interactiveEnptuiAt(click.row + 1, click.col + 1)) return false;
        const definitions = this.#pointerDefinitions();
        if (definitions.length === 0) {
            this.pendingPointer = null;
            this.screen.pointerMarker = null;
            return false;
        }

        if (this.pendingPointer) {
            // Replacing the host's PMB definition invalidates a pending
            // first event, even when the replacement uses the same event
            // number. Definitions are immutable objects owned by the
            // currently active construct, so identity is unambiguous.
            if (!definitions.includes(this.pendingPointer.definition)) {
                this.pendingPointer = null;
                this.screen.pointerMarker = null;
            }
        }

        if (this.pendingPointer) {
            const pending = this.pendingPointer;
            if (this.screen.keyboardLocked) return false;
            if (pending.definition.secondEvent === click.pointerEvent) {
                this.pendingPointer = null;
                this.screen.pointerMarker = null;
                this.#firePointerDefinition(pending.definition, click, true, pending.click);
                return true;
            }
            return false;
        }

        const definition = definitions.find(d => d.firstEvent === click.pointerEvent);
        if (!definition) return false;
        if (this.screen.keyboardLocked) {
            const singleEvent = (definition.flags & 0x80) === 0;
            if (singleEvent && (definition.flags & 0x20) !== 0 && !this.screen.queuedPointerAid)
                this.screen.queuedPointerAid = definition.aidCode;
            return true;
        }
        if ((definition.flags & 0x80) !== 0 && definition.secondEvent) {
            this.pendingPointer = { definition, click };
            if ((definition.flags & 0x10) !== 0) {
                this.screen.pointerMarker = { row: click.row, col: click.col };
                this.renderer.draw();
            }
            return true;
        }
        this.#firePointerDefinition(definition, click, false);
        return true;
    }

    #firePointerDefinition (definition, click, isDoubleEvent, originClick = click) {
        if ((definition.flags & 0x40) !== 0) {
            const addr = click.row * this.screen.cols + click.col;
            this.h.onMoveCursor?.(addr);
        }
        if (!definition.aidCode) return;
        if (isDoubleEvent) {
            this.screen.pendingPointerAid = {
                row: originClick.row + 1,
                col: originClick.col + 1,
                aid: definition.aidCode,
            };
            this.h.onAid?.(Aid.POINTER);
        } else {
            this.h.onAid?.(definition.aidCode);
        }
    }

    #interactiveEnptuiAt (row1, col1) {
        for (const c of this.screen.enptui?.all ?? []) {
            if (c.kind === ConstructKind.SCROLL_BAR) {
                const vertical = c.direction === 0;
                const axis = vertical ? row1 : col1;
                const offAxis = vertical ? col1 : row1;
                const start = vertical ? c.rowOffset + 1 : c.colOffset + 2;
                const end = vertical ? start + c.length - 1 : c.colOffset + c.length - 1;
                const center = vertical ? c.colOffset + 2 : c.rowOffset + 1;
                if (offAxis === center && axis >= start && axis <= end) return true;
                continue;
            }
            if (!c.itemPositions) continue;
            for (let i = 0; i < c.itemPositions.length; i++) {
                if (c.items?.[i]?.nonCursorable) continue;
                const pos = c.itemPositions[i];
                const width = pos.hitWidth ?? pos.slotWidth ?? c.textSize ?? 1;
                if (row1 === pos.row && col1 >= pos.col && col1 < pos.col + width) return true;
            }
        }
        return false;
    }

    // ---- keyboard -----------------------------------------------------

    #bindKeyboard () {
        document.addEventListener('keydown', async (event) => {
            // Let the toolbar / form fields keep their own input. Match
            // the same activeElement guard tn3270 uses so typing into
            // the bridge URL doesn't leak into the terminal.
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA')
                return;
            const mod = event.metaKey || event.ctrlKey;

            // Clipboard shortcuts (work offline too).
            if (mod && event.key.toLowerCase() === 'c') {
                event.preventDefault(); await this.selection.copy(); return;
            }
            if (mod && event.key.toLowerCase() === 'v') {
                event.preventDefault(); await this.selection.paste(); return;
            }
            if (mod && event.key.toLowerCase() === 'a') {
                event.preventDefault(); this.selection.selectAll(); return;
            }
            // Ctrl chords for 5250-specific AIDs not on a function key.
            if (mod && event.key.toLowerCase() === 'h') {
                event.preventDefault(); this.h.onAid?.(Aid.HELP); return;
            }
            if (mod && event.key.toLowerCase() === 'p') {
                event.preventDefault(); this.h.onAid?.(Aid.PRINT); return;
            }
            // Shift+Escape is the conventional 5250 System Request key.
            // It must be checked before plain Escape (Error Reset).
            if (event.shiftKey && event.key === 'Escape') {
                event.preventDefault(); this.h.onSystemRequest?.(); return;
            }
            if (event.code === 'NumpadEnter') {
                event.preventDefault(); this.h.onFieldExit?.(); return;
            }
            if (event.code === 'NumpadAdd') {
                event.preventDefault(); this.h.onFieldPlus?.(); return;
            }
            if (event.code === 'NumpadSubtract') {
                event.preventDefault(); this.h.onFieldMinus?.(); return;
            }

            // Alt+letter: ENPTUI mnemonic activation. Walk every
            // selection field / menu bar / push-button group and find
            // the item whose mnemonicOffset designates the typed
            // character within its label. Alt+A jumps straight to the
            // item whose mnemonic is 'A' in a radio list.
            if (event.altKey && !event.ctrlKey && !event.metaKey
                && event.key.length === 1) {
                if (this.#tryMnemonic(event.key)) {
                    event.preventDefault();
                    return;
                }
            }

            if (event.key === 'Escape') {
                if (this.selection.hasSelection()) {
                    event.preventDefault();
                    this.selection.clear();
                    return;
                }
                // Error Reset clears local error/alarm state. It must not
                // override a host-owned system-wait keyboard lock.
                event.preventDefault();
                this.screen.alarm = false;
                this.screen.errorMode = false;
                this.screen.errorHelpMode = false;
                this.h.onFlash?.('reset');
                this.renderer.draw();
                return;
            }

            const aid = this.#functionKeyName(event);
            if (aid) {
                event.preventDefault();
                if (aid === 'Enter' && this.#enterOnEnptuiItem()) return;
                const code = aidFromName(aid);
                if (code !== null) this.h.onAid?.(code);
                return;
            }

            if (event.key === 'Tab') {
                event.preventDefault();
                if (event.shiftKey) this.h.onBackTab?.();
                else                this.h.onTab?.();
                return;
            }
            if (event.key === 'Backspace')  { event.preventDefault(); this.h.onBackspace?.(); return; }
            if (event.key === 'Insert')     { event.preventDefault(); this.h.onInsert?.(); return; }
            if (event.key === 'Delete') {
                event.preventDefault();
                if (event.ctrlKey || event.metaKey) this.h.onEraseInput?.();
                else if (event.altKey) this.h.onEraseEof?.();
                else this.h.onDelete?.();
                return;
            }

            if (event.key === 'Home')       { event.preventDefault(); this.#home(); return; }
            if (event.key === 'End')        { event.preventDefault(); this.#end(); return; }

            if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
                event.preventDefault();
                this.#arrow(event.key);
                return;
            }

            if (event.key.length === 1 && !mod) {
                event.preventDefault();
                // Space on an ENPTUI item toggles the selection / activates
                // the push button — space is bound to the focused item
                // rather than typing a literal space. Fall back to typing
                // only when no item owns the cursor cell.
                if (event.key === ' ') {
                    const hit = this.screen.enptuiItemAtCursor?.();
                    if (hit) {
                        this.#activateEnptuiItem(hit.construct, hit.index);
                        return;
                    }
                }
                const enptuiHit = this.screen.enptuiItemAtCursor?.();
                if (enptuiHit && this.#selectionCharacter(event.key, enptuiHit)) return;
                this.h.onType?.(event.key);
            }
        });
    }

    /** Translate a keyboard event into a 5250 AID name (or null). The
     *  mapping follows the IBM i operator convention used by every
     *  5250 emulator: F1-F12 send PF1-12, Shift+F1-F12 send PF13-24,
     *  PageUp / PageDown drive Roll Up / Roll Down (note the screen
     *  semantics are flipped from the keyboard label - rolling "up"
     *  brings later content into view, like Page Down). */
    #functionKeyName (event) {
        if (event.key === 'Enter')    return 'Enter';
        if (event.key === 'PageDown') return 'RollUp';   // bring next page up
        if (event.key === 'PageUp')   return 'RollDown'; // bring previous page down
        if (event.key.startsWith('F') && /^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) {
            const n = parseInt(event.key.slice(1), 10);
            return event.shiftKey ? `PF${n + 12}` : `PF${n}`;
        }
        return null;
    }

    /** Home goes to the first character of the first unprotected,
     *  non-bypass field (matches IBM 5250 Home key behaviour). */
    #home () {
        const target = this.screen.homePosition();
        if (target !== null) this.h.onMoveCursor?.(target);
    }

    /** End walks the current field forward to the last non-null cell -
     *  the natural position after the user types into it. */
    #end () {
        const s = this.screen;
        const here = s.cursor;
        const field = s.fieldAt(here);
        if (!field || field.bypass) return;
        let last = (field.start + 1) % s.size;
        let p = (field.start + 1) % s.size;
        // `field.length` is the count of data cells (excludes attr).
        for (let n = 0; n < field.length; n++) {
            const cell = s.cells[p];
            if (cell && cell.byte !== 0x00 && cell.glyph !== ' ')
                last = (p + 1) % s.size;
            p = (p + 1) % s.size;
        }
        this.h.onMoveCursor?.(last);
    }

    #arrow (key) {
        const s = this.screen;
        if (this.#navigateEnptui(key)) return;
        let addr = s.cursor;
        if (key === 'ArrowLeft')  addr = (addr - 1 + s.size) % s.size;
        if (key === 'ArrowRight') addr = (addr + 1) % s.size;
        if (key === 'ArrowUp')    addr = (addr - s.cols + s.size) % s.size;
        if (key === 'ArrowDown')  addr = (addr + s.cols) % s.size;

        // ENPTUI window cursor restriction. If the cursor was inside a
        // window that was created with the "restricted cursor" flag
        // (flag1 bit 0x80 in CreateWindow) AND the host hasn't
        // sent UNREST_WIN_CURSOR since, clamp the new position to the
        // window's interior, per the ENPTUI reference.
        const window = this.#enclosingRestrictedWindow(s.cursor);
        if (window) {
            const target = this.#clampToWindow(addr, window);
            if (target !== null) addr = target;
        }
        this.h.onMoveCursor?.(addr);
    }

    #navigateEnptui (key) {
        const hit = this.screen.enptuiItemAtCursor?.();
        if (!hit) return false;
        const { construct, index } = hit;
        const item = construct.items[index];
        const scrollAid = key === 'ArrowLeft'  && item.leftChoice  ? Aid.ROLL_LEFT
            : key === 'ArrowRight' && item.rightChoice ? Aid.ROLL_RIGHT
            : key === 'ArrowUp'    && item.topChoice   ? Aid.ROLL_DOWN
            : key === 'ArrowDown'  && item.bottomChoice ? Aid.ROLL_UP
            : null;
        if (scrollAid !== null) {
            this.h.onAid?.(scrollAid);
            return true;
        }

        const current = construct.itemPositions[index];
        const candidates = construct.itemPositions
            .map((pos, i) => ({ pos, i, item: construct.items[i] }))
            .filter(entry => entry.pos && !entry.item.nonCursorable && entry.i !== index);
        let eligible;
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
            eligible = candidates.filter(entry => entry.pos.row === current.row
                && (key === 'ArrowLeft' ? entry.pos.textCol < current.textCol
                                        : entry.pos.textCol > current.textCol));
            eligible.sort((a, b) => key === 'ArrowLeft'
                ? b.pos.textCol - a.pos.textCol : a.pos.textCol - b.pos.textCol);
        } else {
            eligible = candidates.filter(entry => key === 'ArrowUp'
                ? entry.pos.row < current.row : entry.pos.row > current.row);
            eligible.sort((a, b) => {
                const rowA = Math.abs(a.pos.row - current.row);
                const rowB = Math.abs(b.pos.row - current.row);
                return rowA - rowB
                    || Math.abs(a.pos.textCol - current.textCol)
                     - Math.abs(b.pos.textCol - current.textCol);
            });
        }

        let target = eligible[0];
        if (!target && !construct.cursorExitable && candidates.length) {
            const all = construct.itemPositions
                .map((pos, i) => ({ pos, i, item: construct.items[i] }))
                .filter(entry => entry.pos && !entry.item.nonCursorable);
            target = (key === 'ArrowLeft' || key === 'ArrowUp') ? all.at(-1) : all[0];
        }
        if (target) {
            this.h.onMoveCursor?.(target.pos.textIdx);
            return true;
        }

        const pullDown = [0x31, 0x32, 0x51].includes(construct.subType);
        if (pullDown && construct.cancelAID) {
            this.h.onAid?.(construct.cancelAID);
            return true;
        }
        return false;
    }

    /** Find the most-recently-defined restricted ENPTUI window that
     *  contains buffer index `cursor`. Returns null if no such window
     *  is active or the cursor is outside every restricted window. */
    #enclosingRestrictedWindow (cursor) {
        const s = this.screen;
        if (!s.enptui) return null;
        const r = (cursor / s.cols | 0) + 1;
        const c = (cursor % s.cols) + 1;
        for (const w of s.enptui.all) {
            if (w.kind !== ConstructKind.WINDOW) continue;
            if (!w.cursorRestricted) continue;
            if (r >= w.innerTopRow && r < w.innerTopRow + w.innerHeight
             && c >= w.innerLeftCol && c < w.innerLeftCol + w.innerWidth) return w;
        }
        return null;
    }

    /** Project buffer index `addr` back into the window's interior.
     *  Returns the clamped index, or null when no clamp was needed. */
    #clampToWindow (addr, w) {
        const s = this.screen;
        const r = (addr / s.cols | 0) + 1;
        const c = (addr % s.cols) + 1;
        const top = w.innerTopRow,    bot   = w.innerTopRow  + w.innerHeight - 1;
        const left = w.innerLeftCol,  right = w.innerLeftCol + w.innerWidth  - 1;
        if (r >= top && r <= bot && c >= left && c <= right) return null;
        const rr = Math.max(top, Math.min(bot, r));
        const cc = Math.max(left, Math.min(right, c));
        return (rr - 1) * s.cols + (cc - 1);
    }

    // ---- ENPTUI click handling ----------------------------------------

    /** ENPTUI: handle a click that may have landed on a radio button,
     *  checkbox, push button or scroll bar. Returns true
     *  when the click was consumed (so the caller should NOT also move
     *  the cursor). */
    #tryEnptuiClick (click) {
        const s = this.screen;
        if (!s.enptui || s.enptui.all.length === 0) return false;
        const row1 = click.row + 1;
        const col1 = click.col + 1;

        for (const c of s.enptui.all) {
            if (c.kind === ConstructKind.SCROLL_BAR) {
                if (this.#tryScrollBarClick(c, row1, col1)) return true;
                continue;
            }
            if (c.kind !== ConstructKind.SELECTION_FIELD
                && c.kind !== ConstructKind.PUSH_BUTTONS
                && c.kind !== ConstructKind.MENU_BAR) continue;
            for (let i = 0; i < c.items.length; i++) {
                if (c.items[i].nonCursorable) continue;
                const pos = c.itemPositions?.[i];
                if (!pos) continue;
                const startCol = pos.col;
                const endCol   = pos.col + (pos.hitWidth ?? pos.slotWidth ?? c.textSize ?? 1) - 1;
                if (row1 !== pos.row) continue;
                if (col1 < startCol || col1 > endCol) continue;
                if (s.keyboardLocked) return true;
                if (c.pointerMayMoveCursor) this.h.onMoveCursor?.(pos.textIdx);
                this.#activateEnptuiItem(c, i);
                return true;
            }
        }
        return false;
    }

    #selectionCharacter (ch, hit) {
        const { construct } = hit;
        const byte = this.screen.ebcdic.fromCharCode(ch.codePointAt(0));
        if (ch === '/' || (construct.selectChar && byte === construct.selectChar)) {
            this.#selectEnptuiItem(construct, hit.index);
            return true;
        }

        const target = ch.toLowerCase();
        const mnemonicIndex = construct.items.findIndex(item => {
            if (item.unavailable || item.mnemonicOffset < 0) return false;
            const mnemonicByte = item.textBytes?.[item.mnemonicOffset];
            return mnemonicByte !== undefined
                && this.screen.ebcdic.toChar(mnemonicByte)?.toLowerCase() === target;
        });
        if (mnemonicIndex >= 0) {
            const pos = construct.itemPositions[mnemonicIndex];
            if (pos) this.h.onMoveCursor?.(pos.textIdx);
            this.#selectEnptuiItem(construct, mnemonicIndex);
            return true;
        }

        // A selection pseudo-field owns character input while focused;
        // unmatched text must not leak into an underlying 5250 field.
        this.h.onFlash?.('invalid selection key');
        return true;
    }

    #selectEnptuiItem (construct, idx) {
        if (this.screen.keyboardLocked) return;
        const item = construct.items[idx];
        if (!item || item.unavailable || item.nonCursorable) return;
        if (!construct.multi) {
            for (let i = 0; i < construct.items.length; i++) {
                construct.items[i].selected = false;
                this.#repaintItem(construct, i);
            }
        }
        item.selected = true;
        construct.modified = true;
        this.#repaintItem(construct, idx);
        this.renderer.draw();
        if (construct.autoEnterOnSelect)
            this.h.onAid?.(item.aidCode || Aid.ENTER);
    }

    /** Hit-test a click against the scroll bar's interactive zones and
     *  fire the appropriate scroll AID. Hit-zone codes (1=upArrow,
     *  2=dnArrow,
     *  5=pageUp, 6=pageDown, 9=thumb). We don't model arrow buttons as
     *  separate cells - the first and last cell of the bar act as
     *  arrow buttons.
     *
     *  The bar's `direction` field is 0 = vertical, 1 = horizontal.
     *  AIDs sent: Roll Up / Roll Down for vertical movement; Roll Left
     *  / Roll Right for horizontal. The host receives the AID and
     *  responds with a refreshed list + WRITE_DATA carrying the new
     *  slider position. */
    #tryScrollBarClick (sb, row1, col1) {
        const vertical = sb.direction === 0;
        const start    = vertical ? sb.rowOffset + 1 : sb.colOffset + 2;
        const end      = vertical ? start + sb.length - 1 : sb.colOffset + sb.length - 1;
        const axis     = vertical ? row1 : col1;
        const offAxis  = vertical ? col1 : row1;
        const onAxis   = vertical ? sb.colOffset + 2 : sb.rowOffset + 1;
        if (offAxis !== onAxis) return false;
        if (axis < start || axis > end) return false;
        if (this.screen.keyboardLocked) return true;

        // Map axis position to one of: top arrow, bottom arrow, shaft
        // above thumb, shaft below thumb, thumb. Thumb covers a span
        // proportional to visibleRows/totalRows of the bar's length.
        const thumbLen  = sb.sliderCellSize
            ?? Math.max(1, Math.floor(sb.length * (sb.visibleRows / Math.max(sb.totalRows, 1))));
        const thumbPos  = sb.sliderCellPos
            ?? Math.floor((sb.sliderPos / Math.max(sb.totalRows, 1)) * sb.length);
        const thumbStart = (vertical ? sb.rowOffset + 1 : sb.colOffset + 1) + thumbPos;
        const thumbEnd   = thumbStart + thumbLen - 1;
        let aid;
        if (axis === start)                     aid = vertical ? Aid.ROLL_DOWN  : Aid.ROLL_LEFT;
        else if (axis === end)                  aid = vertical ? Aid.ROLL_UP    : Aid.ROLL_RIGHT;
        else if (axis < thumbStart)             aid = vertical ? Aid.ROLL_DOWN  : Aid.ROLL_LEFT;
        else if (axis > thumbEnd)               aid = vertical ? Aid.ROLL_UP    : Aid.ROLL_RIGHT;
        else                                    aid = null;   // thumb click - host will refresh after drag
        if (aid !== null) {
            const page = axis !== start && axis !== end;
            sb.scrollIncrement = page ? Math.max(1, sb.visibleRows) : 1;
            sb.modified = true;
            if (sb.parent) sb.parent.modified = true;
            this.h.onAid?.(aid);
        }
        return true;
    }

    /** Look for an ENPTUI item whose mnemonic letter matches the typed
     *  character (case-insensitive), move focus to it and select it. */
    #tryMnemonic (ch) {
        if (this.screen.keyboardLocked) return false;
        const target = ch.toLowerCase();
        const s = this.screen;
        for (const c of s.enptui.all) {
            if (c.kind !== ConstructKind.SELECTION_FIELD
                && c.kind !== ConstructKind.PUSH_BUTTONS
                && c.kind !== ConstructKind.MENU_BAR) continue;
            for (let i = 0; i < c.items.length; i++) {
                const item = c.items[i];
                if (item.unavailable) continue;
                if (item.mnemonicOffset < 0) continue;
                const byte = item.textBytes?.[item.mnemonicOffset];
                if (byte === undefined) continue;
                const ch = s.ebcdic.toChar(byte);
                if (!ch) continue;
                if (ch.toLowerCase() !== target) continue;
                const pos = c.itemPositions?.[i];
                if (pos) this.h.onMoveCursor?.(pos.textIdx);
                this.#selectEnptuiItem(c, i);
                return true;
            }
        }
        return false;
    }

    #enterOnEnptuiItem () {
        const hit = this.screen.enptuiItemAtCursor?.();
        if (!hit) return false;
        if (this.screen.keyboardLocked) return true;
        const { construct, index } = hit;
        const item = construct.items[index];
        if (!item || item.unavailable || item.nonCursorable) return true;

        // Enter optionally auto-selects the focused choice, then submits
        // that choice's own AID only when it is selected. This is distinct
        // from Space/pointer activation, which toggles the choice first.
        if (construct.autoSelect && !item.selected) {
            if (!construct.multi && construct.kind !== ConstructKind.PUSH_BUTTONS) {
                for (let i = 0; i < construct.items.length; i++) {
                    construct.items[i].selected = false;
                    this.#repaintItem(construct, i);
                }
            }
            item.selected = true;
            construct.modified = true;
            this.#repaintItem(construct, index);
            this.renderer.draw();
        }
        this.h.onAid?.(item.selected && item.aidCode ? item.aidCode : Aid.ENTER);
        return true;
    }

    #activateEnptuiItem (construct, idx) {
        if (this.screen.keyboardLocked) return;
        const item = construct.items[idx];
        if (!item || item.unavailable || item.nonCursorable) return;

        // IBM's pointer path is the Space-key path: ordinary single-choice
        // fields/menu bars deselect their peers and toggle the target;
        // push buttons toggle without clearing their peers. Multi-choice
        // fields independently toggle each item.
        if (!construct.multi && construct.kind !== ConstructKind.PUSH_BUTTONS) {
            for (let i = 0; i < construct.items.length; i++) {
                construct.items[i].selected = false;
                this.#repaintItem(construct, i);
            }
        }
        item.selected = !item.selected;
        construct.modified = true;
        // Repaint immediately so the user sees the change before
        // submitting the AID; the indicator overlay reads from
        // construct.items so no further state update is needed.
        this.#repaintItem(construct, idx);
        this.renderer.draw();
        if ((item.selected && construct.autoEnterOnSelect)
            || (!item.selected && construct.autoEnterOnDeselect))
            this.h.onAid?.(item.aidCode || Aid.ENTER);
    }

    /** Update the indicator cell to reflect the new selected state.
     *  Without this, the underlying EBCDIC byte that was painted at
     *  decode time stays at '.', '/', etc. */
    #repaintItem (construct, idx) {
        const pos = construct.itemPositions[idx];
        if (!pos) return;
        const s = this.screen;
        const item = construct.items[idx];
        if (!item || item.dummy) return;
        const attrIndex = item.unavailable ? 5 : item.selected ? 4 : 3;
        const attrByte = construct.choiceAttrs[attrIndex];
        const attrCell = s.cells[pos.anchorIdx];
        if (attrCell) {
            attrCell.byte = attrByte;
            attrCell.glyph = ' ';
            attrCell.attributePlace = true;
            attrCell.attr = ATTR_BASE[attrByte] ?? s.activeAttr;
        }
        if (!construct.drawIndicator || item.unavailable) return;
        const cellIdx = pos.indicatorIdx;
        const cell = s.cells[cellIdx];
        if (!cell) return;
        // Sync the on-screen EBCDIC indicator with the new state so
        // submit time (when the host reads the screen) sees it.
        if (construct.single) {
            cell.byte = item.selected ? 0x61 /* / */ : 0x4B /* . */;
        } else {
            cell.byte = item.selected ? 0x61 /* / */ : 0x40 /* sp */;
        }
        cell.glyph = s.ebcdic.toChar(cell.byte);
    }

}

export { aidFromName };
