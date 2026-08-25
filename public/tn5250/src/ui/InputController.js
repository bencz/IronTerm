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
     * @param {()=>void}            hooks.onNewline
     * @param {()=>void}            hooks.onDeleteWord
     * @param {()=>void}            hooks.onEraseField
     * @param {(backwards:boolean)=>void} hooks.onWordTab
     * @param {()=>void}            hooks.onDup
     * @param {()=>void}            hooks.onFieldMark
     * @param {()=>void}            hooks.onReset
     */
    constructor (hooks) {
        this.h = hooks;
        this.canvas = hooks.canvas;
        this.renderer = hooks.renderer;
        this.screen = hooks.screen;
        this.pendingPointer = null;
        this.delayedPointer = null;
        this.draggedScrollBar = null;

        this.selection = new Selection({
            canvas:        hooks.canvas,
            renderer:      hooks.renderer,
            screen:        hooks.screen,
            onType:        hooks.onType,
            onFlash:       hooks.onFlash,
            onClickCursor: (click) => this.#handleClick(click),
            onPointerEvent: (click) => this.#handlePointerEvent(click),
            onPointerMove: (click) => this.#handlePointerMove(click),
            hasPointerDefinitions: () => this.#pointerDefinitions().length > 0,
        });

        this.#bindKeyboard();
    }

    /** Cancel local gestures that cannot survive an operator Reset. */
    resetTransientState () {
        this.#clearPendingPointer();
        this.#clearDelayedPointer();
        this.draggedScrollBar = null;
    }

    #handleClick (click) {
        if (this.#tryEnptuiClick(click)) return;
        const addr = click.row * this.screen.cols + click.col;
        const pointerField = this.screen.logicalField(this.screen.fieldAt(addr));
        if (!this.screen.keyboardLocked && pointerField?.pointerAid) {
            this.#moveCursorWithInputPolicy(addr, null);
            this.h.onAid?.(pointerField.pointerAid);
            return;
        }
        const focused = this.screen.enptuiItemAtCursor?.();
        const construct = focused?.construct;
        if (construct
            && [0x31, 0x32, 0x51].includes(construct.subType)
            && construct.cancelAID) {
            this.h.onAid?.(construct.cancelAID);
            return;
        }
        this.#moveCursorWithInputPolicy(addr, null);
    }

    #pointerDefinitions () {
        return this.screen.enptui?.all.find(
            c => c.kind === ConstructKind.MOUSE_EVENTS)?.definitions ?? [];
    }

    #handlePointerEvent (click) {
        if (this.draggedScrollBar && (click.pointerEvent === 2 || click.pointerEvent === 11)) {
            this.#stopScrollBarDrag(click);
            return true;
        }
        if ((click.pointerEvent === 1 || click.pointerEvent === 10)
            && !this.screen.keyboardLocked) {
            const hit = this.#scrollBarAt(click.row + 1, click.col + 1);
            if (hit?.zone === 'thumb') {
                this.draggedScrollBar = {
                    scrollBar: hit.scrollBar,
                    originalCellPos: hit.scrollBar.sliderCellPos,
                    originalCursor: this.screen.cursor,
                };
                return true;
            }
        }
        // Only an ordinary unshifted left press/release gives selection
        // fields and scroll bars precedence over programmable mouse
        // definitions. Middle/right, Shift-modified and double-click
        // events remain programmable even on top of a GUI construct.
        const plainLeftEvent = click.pointerEvent === 1 || click.pointerEvent === 2;
        if (plainLeftEvent
            && this.#interactiveEnptuiAt(click.row + 1, click.col + 1)) return false;
        const definitions = this.#pointerDefinitions();
        if (definitions.length === 0) {
            this.#clearPendingPointer();
            this.#clearDelayedPointer();
            return false;
        }

        const definition = definitions.find(d => d.firstEvent === click.pointerEvent);
        if (click.pointerEvent % 3 === 0)
            this.#cancelDelayedPointerForDoubleClick(click.pointerEvent);

        if (this.pendingPointer) {
            // Replacing the host's PMB definition invalidates a pending
            // first event, even when the replacement uses the same event
            // number. Definitions are immutable objects owned by the
            // currently active construct, so identity is unambiguous.
            if (!definitions.includes(this.pendingPointer.definition)) {
                this.#clearPendingPointer();
            }
        }

        // Release and double-click events use the normal operator cursor
        // departure path before programmable processing. Press events are
        // intentionally immediate and do not perform this validation.
        const phase = (click.pointerEvent - 1) % 3;
        if (phase !== 0 && (definition || this.pendingPointer)
            && !this.screen.keyboardLocked) {
            const previousCursor = this.screen.cursor;
            const address = click.row * this.screen.cols + click.col;
            const moved = this.h.onMoveCursor?.(address);
            if (moved === false) return true;
            // The programmable definition itself decides whether the
            // pointer position or the original cursor is retained.
            this.screen.cursor = previousCursor;
        }

        if (this.pendingPointer) {
            const pending = this.pendingPointer;
            if (this.screen.keyboardLocked) return false;
            if (pending.definition.secondEvent === click.pointerEvent) {
                this.#clearPendingPointer();
                this.#processPointerDefinition(pending.definition, click, true, pending.click);
                return true;
            }
            // A release-first double-event can be superseded by a related
            // click definition received inside the platform double-click
            // interval. This is how press/release/double combinations avoid
            // leaving an obsolete first event pending indefinitely.
            if (definition
                && this.#shouldReplacePendingPointer(
                    pending.definition.firstEvent, click.pointerEvent)
                && pending.time !== 0
                && Date.now() - pending.time <= 500) {
                if ((definition.flags & 0x80) !== 0 && definition.secondEvent) {
                    this.#setPendingPointer(definition, click);
                } else {
                    this.#clearPendingPointer();
                    this.#processPointerDefinition(definition, click, false);
                }
                return true;
            }
            return false;
        }

        if (!definition) return false;
        if (this.screen.keyboardLocked) {
            const singleEvent = (definition.flags & 0x80) === 0;
            if (singleEvent && (definition.flags & 0x20) !== 0 && !this.screen.queuedPointerAid)
                this.screen.queuedPointerAid = definition.aidCode;
            return true;
        }
        if ((definition.flags & 0x80) !== 0 && definition.secondEvent) {
            this.#setPendingPointer(definition, click);
            return true;
        }
        this.#processPointerDefinition(definition, click, false);
        return true;
    }

    #setPendingPointer (definition, click) {
        this.#clearPendingPointer();
        const releaseEvent = (definition.firstEvent - 1) % 3 === 1;
        this.pendingPointer = {
            definition,
            click,
            time: releaseEvent ? Date.now() : 0,
        };
        if ((definition.flags & 0x10) !== 0) {
            this.screen.pointerMarker = { row: click.row, col: click.col };
            this.renderer.draw();
        }
    }

    #clearPendingPointer () {
        const hadMarker = this.screen.pointerMarker !== null;
        this.pendingPointer = null;
        this.screen.pointerMarker = null;
        if (hadMarker) this.renderer.draw();
    }

    #shouldReplacePendingPointer (firstEvent, currentEvent) {
        if ((currentEvent - 1) % 3 !== 2) return false;
        return firstEvent === currentEvent - 1 || firstEvent === currentEvent - 2;
    }

    #processPointerDefinition (definition, click, isDoubleEvent, originClick = click) {
        this.#clearDelayedPointer();
        if (this.#shouldDelayPointer(definition.firstEvent)) {
            const delayed = { definition, click, isDoubleEvent, originClick, timer: null };
            delayed.timer = globalThis.setTimeout(() => {
                if (this.delayedPointer !== delayed) return;
                this.delayedPointer = null;
                if (!this.#pointerDefinitions().includes(definition)) return;
                this.#firePointerDefinition(definition, click, isDoubleEvent, originClick);
            }, 500);
            this.delayedPointer = delayed;
            return;
        }
        this.#firePointerDefinition(definition, click, isDoubleEvent, originClick);
    }

    #shouldDelayPointer (eventId) {
        const phase = (eventId - 1) % 3;
        if (phase === 2) return false;
        const doubleClickEvent = eventId + (phase === 0 ? 2 : 1);
        return this.#pointerDefinitions().some(
            definition => definition.firstEvent === doubleClickEvent);
    }

    #cancelDelayedPointerForDoubleClick (eventId) {
        const delayedEvent = this.delayedPointer?.definition.firstEvent;
        if (!delayedEvent) return;
        if (delayedEvent === eventId - 1 || delayedEvent === eventId - 2)
            this.#clearDelayedPointer();
    }

    #clearDelayedPointer () {
        if (this.delayedPointer && this.delayedPointer.timer !== null)
            globalThis.clearTimeout(this.delayedPointer.timer);
        this.delayedPointer = null;
    }

    #handlePointerMove (click) {
        const drag = this.draggedScrollBar;
        if (!drag) return false;
        const sb = drag.scrollBar;
        const vertical = sb.direction === 0;
        const axis = vertical ? click.row : click.col;
        // Vertical slider positions are row offsets from the anchor. A
        // horizontal bar has a leading attribute cell and the protocol's
        // slider position is one greater than the pointer's anchor-relative
        // column. Treating both axes alike shifts a horizontal drag two
        // cells toward the decrement arrow.
        const requestedPos = vertical
            ? axis - sb.rowOffset
            : axis - sb.colOffset + 1;
        // Vertical bars reserve the final row for the increment arrow.
        // Horizontal bars also have a leading attribute cell, so their
        // last legal thumb position is one cell earlier.
        const trailingCells = vertical ? 1 : 3;
        const maxPos = Math.max(1, sb.length - trailingCells - (sb.sliderCellSize ?? 1));
        sb.sliderCellPos = Math.max(1, Math.min(maxPos, requestedPos));
        this.renderer.draw();
        return true;
    }

    #stopScrollBarDrag (click) {
        const drag = this.draggedScrollBar;
        this.draggedScrollBar = null;
        if (!drag) return;
        const sb = drag.scrollBar;
        const current = sb.sliderCellPos;
        const releasedAddress = click
            ? click.row * this.screen.cols + click.col
            : this.screen.cursor;
        const moved = this.h.onMoveCursor?.(releasedAddress);
        if (moved === false) {
            sb.sliderCellPos = drag.originalCellPos;
            this.renderer.draw();
            return;
        }
        if (sb.moveCursor) {
            const addr = sb.direction === 0
                ? (sb.rowOffset + current) * this.screen.cols + sb.colOffset + 1
                : sb.rowOffset * this.screen.cols + sb.colOffset + current + 1;
            this.h.onMoveCursor?.(addr);
        } else {
            this.screen.cursor = drag.originalCursor;
            this.renderer.draw();
        }
        if (current === drag.originalCellPos) return;

        const vertical = sb.direction === 0;
        const atTop = current === 1;
        const maxPos = Math.max(1,
            sb.length - (vertical ? 1 : 3) - (sb.sliderCellSize ?? 1));
        const visible = vertical ? sb.length : Math.max(1, sb.length - 2);
        let target = Math.floor(current * sb.totalRows / Math.max(1, sb.actualSize));
        if (atTop) target = 0;
        if (current === maxPos) target = Math.max(0, sb.totalRows - sb.length);
        // A zero result is meaningful here: the cell-space thumb moved,
        // but integer scaling mapped it back to the same dataset offset.
        // ENPTUI encodes that case as a page-sized increment rather than
        // suppressing the operator action.
        const computedIncrement = Math.abs(target - sb.sliderPos);
        const increment = computedIncrement || sb.length;

        sb.scrollIncrement = increment;
        sb.modified = true;
        if (sb.parent) sb.parent.modified = true;
        const towardStart = current < drag.originalCellPos;
        this.h.onAid?.(vertical
            ? (towardStart ? Aid.ROLL_DOWN : Aid.ROLL_UP)
            : (towardStart ? Aid.ROLL_LEFT : Aid.ROLL_RIGHT));
    }

    #firePointerDefinition (definition, click, isDoubleEvent, originClick = click) {
        if ((definition.flags & 0x40) !== 0) {
            const addr = click.row * this.screen.cols + click.col;
            // Departure validation already occurred for release/double
            // events. A press definition is specified as immediate, so its
            // move is likewise a direct programmable cursor placement.
            this.screen.cursor = addr;
            this.renderer.draw();
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
        for (const c of this.screen.enptui?.frontToBack ?? []) {
            if (c.kind === ConstructKind.WINDOW) {
                const bounds = this.screen.enptui.boundsOf(c);
                if (bounds && row1 >= bounds.top && row1 <= bounds.bottom
                    && col1 >= bounds.left && col1 <= bounds.right) return false;
                continue;
            }
            if (c.kind === ConstructKind.SCROLL_BAR) {
                if (this.#scrollBarAt(row1, col1, c)) return true;
                continue;
            }
            if (!c.itemPositions) continue;
            for (let i = 0; i < c.itemPositions.length; i++) {
                const pos = c.itemPositions[i];
                const width = pos.hitWidth ?? pos.slotWidth ?? c.textSize ?? 1;
                const start = pos.hitCol ?? pos.col;
                if (row1 === pos.row && col1 >= start && col1 < start + width) return true;
            }
        }
        return false;
    }

    // ---- keyboard -----------------------------------------------------

    #bindKeyboard () {
        document.addEventListener('paste', (event) => {
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            const text = event.clipboardData?.getData('text/plain');
            if (typeof text !== 'string') return;
            event.preventDefault();
            if (this.screen.errorHelpMode) return;
            if (this.screen.errorMode) {
                this.screen.alarm = true;
                this.h.onFlash?.('reset required');
                this.renderer.draw();
                return;
            }
            this.selection.pasteText(text);
        });

        document.addEventListener('keydown', async (event) => {
            // Let the toolbar / form fields keep their own input. Match
            // the same activeElement guard tn3270 uses so typing into
            // the bridge URL doesn't leak into the terminal.
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA')
                return;
            const mod = event.metaKey || event.ctrlKey;

            // After Error Help is requested, only Reset and the four
            // cursor keys dismiss that state. Cursor movement then proceeds
            // normally; every other key is consumed while the host-owned
            // help transaction remains outstanding.
            if (this.screen.errorHelpMode) {
                const arrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
                    .includes(event.key);
                if (event.key === 'Escape' || arrow) {
                    event.preventDefault();
                    this.h.onReset?.();
                    if (event.key === 'Escape') return;
                } else {
                    event.preventDefault();
                    return;
                }
            }

            // Clipboard shortcuts (work offline too).
            if (mod && event.key.toLowerCase() === 'c') {
                event.preventDefault(); await this.selection.copy(); return;
            }
            if (mod && event.key.toLowerCase() === 'a') {
                event.preventDefault(); this.selection.selectAll(); return;
            }
            // Ctrl chords for 5250-specific AIDs not on a function key.
            if (mod && event.key.toLowerCase() === 'h') {
                event.preventDefault(); this.h.onAid?.(Aid.HELP); return;
            }

            // A host-written error line temporarily owns the keyboard.
            // Character/editing keys are rejected while navigation and
            // AID keys first restore the underlying message line and then
            // continue normally. Help above is special: it asks the host
            // for the explanation associated with the displayed code.
            if (this.screen.errorMode) {
                if (this.#isErrorEditingKey(event, mod)) {
                    event.preventDefault();
                    this.screen.alarm = true;
                    this.h.onFlash?.('reset required');
                    this.renderer.draw();
                    return;
                }
                this.h.onReset?.();
            }

            if (mod && event.key.toLowerCase() === 'v') {
                // Let the browser dispatch its trusted `paste` event. Reading
                // navigator.clipboard here makes Firefox show a confirmation
                // menu instead of pasting immediately.
                return;
            }
            if (mod && event.key.toLowerCase() === 'p') {
                event.preventDefault(); this.h.onAid?.(Aid.PRINT); return;
            }
            // Shift+Escape is the conventional 5250 System Request key.
            // It must be checked before plain Escape (Error Reset).
            if (event.shiftKey && event.key === 'Escape') {
                event.preventDefault(); this.h.onSystemRequest?.(); return;
            }
            if (event.code === 'NumpadAdd') {
                event.preventDefault();
                if (this.screen.enptuiItemAtCursor?.()) this.#tab(false);
                else this.h.onFieldPlus?.();
                return;
            }
            if (event.code === 'NumpadSubtract') {
                event.preventDefault();
                if (this.screen.enptuiItemAtCursor?.()) this.#tab(false);
                else this.h.onFieldMinus?.();
                return;
            }

            // Keep both physical Enter keys as the Enter AID. Dedicated
            // editing functions use explicit chords so laptop keyboards
            // without a numeric keypad remain fully usable.
            if (mod && event.key === 'Enter') {
                event.preventDefault();
                if (this.screen.enptuiItemAtCursor?.()) this.#tab(false);
                else this.h.onFieldExit?.();
                return;
            }
            if (event.shiftKey && event.key === 'Enter') {
                event.preventDefault(); this.#newline(); return;
            }
            if (mod && event.shiftKey && event.key.toLowerCase() === 'd') {
                event.preventDefault();
                if (this.screen.enptuiItemAtCursor?.())
                    this.#rejectEnptuiChoice('invalid selection key');
                else this.h.onDup?.();
                return;
            }
            if (mod && event.shiftKey && event.key.toLowerCase() === 'm') {
                event.preventDefault();
                if (this.screen.enptuiItemAtCursor?.())
                    this.#rejectEnptuiChoice('invalid selection key');
                else this.h.onFieldMark?.();
                return;
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
                this.h.onReset?.();
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
                this.#tab(event.shiftKey);
                return;
            }
            if (event.key === 'Backspace')  {
                event.preventDefault();
                // A selection pseudo-field owns editing keys while the
                // cursor is on one of its choices. Backspace is consumed;
                // it must not alter a presentation-space field underneath.
                if (!this.screen.enptuiItemAtCursor?.()) {
                    if (mod && event.shiftKey) this.h.onEraseField?.();
                    else if (mod) this.h.onDeleteWord?.();
                    else this.h.onBackspace?.();
                }
                return;
            }
            if (event.key === 'Insert')     { event.preventDefault(); this.h.onInsert?.(); return; }
            if (event.key === 'Delete') {
                event.preventDefault();
                if (event.ctrlKey || event.metaKey) this.#eraseInput();
                else if (event.altKey) {
                    if (this.screen.enptuiItemAtCursor?.())
                        this.#rejectEnptuiChoice('invalid selection key');
                    else this.h.onEraseEof?.();
                }
                else {
                    const hit = this.screen.enptuiItemAtCursor?.();
                    if (hit) this.#deselectEnptuiItem(hit.construct, hit.index);
                    else this.h.onDelete?.();
                }
                return;
            }

            if (event.key === 'Home')       { event.preventDefault(); this.#home(); return; }
            if (event.key === 'End') {
                event.preventDefault();
                // End is consumed by a selection pseudo-field.  It must
                // not act on an ordinary input field underneath the GUI
                // construct.
                if (!this.screen.enptuiItemAtCursor?.()) this.#end();
                return;
            }

            if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
                event.preventDefault();
                if (mod && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                    if (!this.screen.enptuiItemAtCursor?.())
                        this.h.onWordTab?.(event.key === 'ArrowLeft');
                    return;
                }
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

    #isErrorEditingKey (event, mod) {
        if (mod && event.key.toLowerCase() === 'v') return true;
        if (event.key.length === 1 && !mod) return true;
        if (['Backspace', 'Delete'].includes(event.key)) return true;
        if (event.code === 'NumpadAdd' || event.code === 'NumpadSubtract') return true;
        if (event.key === 'Enter' && (mod || event.shiftKey)) return true;
        if (mod && event.shiftKey
            && ['d', 'm'].includes(event.key.toLowerCase())) return true;
        return false;
    }

    /** Translate a keyboard event into a 5250 AID name (or null). The
     *  mapping follows the IBM i operator convention used by every
     *  5250 emulator: F1-F12 send PF1-12, Shift+F1-F12 send PF13-24,
     *  PageUp / PageDown drive Roll Up / Roll Down (note the screen
     *  semantics are flipped from the keyboard label - rolling "up"
     *  brings later content into view, like Page Down). */
    #functionKeyName (event) {
        if (event.key === 'Enter' || event.code === 'NumpadEnter') return 'Enter';
        if (event.key === 'PageDown') return 'RollUp';   // bring next page up
        if (event.key === 'PageUp')   return 'RollDown'; // bring previous page down
        if (event.key.startsWith('F') && /^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) {
            const n = parseInt(event.key.slice(1), 10);
            return event.shiftKey && n <= 12 ? `PF${n + 12}` : `PF${n}`;
        }
        return null;
    }

    /** Home goes to the first character of the first unprotected,
     *  non-bypass field (matches IBM 5250 Home key behaviour). */
    #home () {
        const target = this.screen.homePosition();
        if (target === null) return;
        if (target === this.screen.cursor) this.h.onAid?.(Aid.HOME);
        else this.h.onMoveCursor?.(target);
    }

    #tab (backwards) {
        const hit = this.screen.enptuiItemAtCursor?.();
        if (hit) {
            const { construct, index } = hit;
            const cursorable = (construct.itemPositions ?? [])
                .map((pos, i) => ({ pos, i }))
                .filter(entry => entry.pos && !construct.items?.[entry.i]?.nonCursorable);
            const current = cursorable.findIndex(entry => entry.i === index);

            if (construct.fieldAdvance) {
                const target = cursorable[current + (backwards ? -1 : 1)];
                if (target) {
                    this.h.onMoveCursor?.(target.pos.textIdx);
                    return;
                }
            }
        }
        if (backwards) this.h.onBackTab?.();
        else this.h.onTab?.();
    }

    #newline () {
        const hit = this.screen.enptuiItemAtCursor?.();
        if (hit) {
            const current = hit.construct.itemPositions?.[hit.index];
            const entries = hit.construct.itemPositions
                ?.map((pos, i) => ({ pos, i, item: hit.construct.items?.[i] })) ?? [];
            // Newline first addresses the construct's left edge on the next
            // physical row. If that slot is structural/non-cursorable, the
            // search continues forward through later choices and wraps only
            // when the addressed row itself belongs to the construct.
            const nextRow = current?.row + 1;
            const rowEntries = entries.filter(entry => entry.pos?.row === nextRow)
                .sort((a, b) => a.pos.textCol - b.pos.textCol);
            let target = null;
            if (rowEntries.length) {
                const startIndex = rowEntries[0].i;
                target = entries.find(entry => entry.i >= startIndex
                    && entry.pos && !entry.item?.nonCursorable)
                    ?? entries.find(entry => entry.pos && !entry.item?.nonCursorable);
            }
            if (target) {
                this.#moveCursorWithInputPolicy(target.pos.textIdx, 'ArrowDown');
                return;
            }
        }
        this.h.onNewline?.();
    }

    /** End locates the end of the entered data from the current display
     *  row onward. A completely full field stays on its final cell; a
     *  partially filled field lands on the first blank after the data. */
    #end () {
        const s = this.screen;
        const here = s.cursor;
        const field = s.logicalField(s.fieldAt(here));
        if (!field || field.bypass) return;
        const chain = s.fieldChain(field);
        const rowStart = Math.floor(here / s.cols) * s.cols;
        const positions = [];
        for (const segment of chain) {
            let p = (segment.start + 1) % s.size;
            for (let n = 0; n < segment.length; n++) {
                positions.push(p);
                p = (p + 1) % s.size;
            }
        }

        let first = positions.findIndex(position => position >= rowStart);
        if (first < 0) first = 0;
        let lastData = -1;
        for (let i = positions.length - 1; i >= first; i--) {
            const byte = s.cells[positions[i]]?.byte ?? 0x00;
            if (byte !== 0x00 && byte !== 0x40) {
                lastData = i;
                break;
            }
        }
        const targetIndex = lastData < 0
            ? first
            : Math.min(lastData + 1, positions.length - 1);
        this.h.onMoveCursor?.(positions[targetIndex]);
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
        // sent UNREST_WIN_CURSOR since, wrap the new position to the
        // opposite edge of the window's interior.
        const window = this.#enclosingRestrictedWindow(s.cursor);
        if (window) {
            const target = this.#wrapInWindow(key, addr, window);
            if (target !== null) addr = target;
        }
        this.#moveCursorWithInputPolicy(addr, key);
    }

    #navigateEnptui (key) {
        const hit = this.screen.enptuiItemAtCursor?.();
        if (!hit) return false;
        const { construct, index } = hit;
        // A non-exitable menu bar is one horizontal navigation ring.
        // Up/Down therefore have the same meaning as Left/Right.
        if (construct.kind === ConstructKind.MENU_BAR && !construct.cursorExitable) {
            if (key === 'ArrowUp') key = 'ArrowLeft';
            else if (key === 'ArrowDown') key = 'ArrowRight';
        }
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

        const target = this.#selectionNavigationTarget(construct, index, key);
        if (target) {
            this.#moveCursorWithInputPolicy(target.pos.textIdx, key);
            return true;
        }

        if (construct.cursorExitable
            && (key === 'ArrowLeft' || key === 'ArrowRight')) {
            const row0 = construct.itemPositions[index].row - 1;
            const leftCol0 = Math.max(0, (construct.boundsLeftCol ?? 1) - 2);
            const rightCol0 = Math.min(this.screen.cols - 1,
                (construct.boundsLeftCol ?? 1) - 1 + (construct.boundsWidth ?? 1));
            let addr = row0 * this.screen.cols
                + (key === 'ArrowLeft' ? leftCol0 : rightCol0);
            // Selection-field navigation is processed before the ordinary
            // cursor path. It must still honour the current window's cursor
            // restriction when the field itself permits an edge exit.
            const window = this.#enclosingRestrictedWindow(this.screen.cursor);
            if (window) addr = this.#wrapInWindow(key, addr, window) ?? addr;
            this.#moveCursorWithInputPolicy(addr, key);
            return true;
        }
        return false;
    }

    #moveCursorWithInputPolicy (addr, key) {
        const s = this.screen;
        const enabled = s.soh?.cursorMoveToInput
            || (s.enptui?.all ?? []).some(c => c.cursorMoveToInput);
        if (enabled && !this.#inputPositionAt(addr))
            addr = this.#nearestInputPosition(addr, key);
        this.h.onMoveCursor?.(addr);
    }

    #inputPositionAt (addr) {
        const field = this.screen.logicalField(this.screen.fieldAt(addr));
        if (field && !field.bypass) return true;
        for (const construct of this.screen.enptui?.all ?? []) {
            for (let i = 0; i < (construct.itemPositions?.length ?? 0); i++) {
                if (construct.items?.[i]?.nonCursorable) continue;
                if (construct.itemPositions[i]?.textIdx === addr) return true;
            }
        }
        return false;
    }

    #nearestInputPosition (addr, key) {
        const s = this.screen;
        const candidates = new Set();
        for (const field of s.fields) {
            const logical = s.logicalField(field);
            if (!logical || logical.bypass) continue;
            for (let n = 1; n <= field.length; n++)
                candidates.add((field.start + n) % s.size);
        }
        for (const construct of s.enptui?.all ?? []) {
            for (let i = 0; i < (construct.itemPositions?.length ?? 0); i++) {
                if (construct.items?.[i]?.nonCursorable) continue;
                const textIdx = construct.itemPositions[i]?.textIdx;
                if (Number.isInteger(textIdx)) candidates.add(textIdx);
            }
        }
        if (candidates.size === 0) return 0;
        const ordered = [...candidates].sort((a, b) => a - b);
        if (key === 'ArrowLeft')
            return ordered.findLast(value => value <= addr) ?? ordered.at(-1);
        if (key === 'ArrowRight')
            return ordered.find(value => value >= addr) ?? ordered[0];

        const targetRow = (addr / s.cols) | 0;
        const targetCol = addr % s.cols;
        const direction = key === 'ArrowUp' ? -1 : 1;
        for (let offset = 0; offset < s.rows; offset++) {
            const row = (targetRow + direction * offset + s.rows) % s.rows;
            const inRow = ordered.filter(value => (value / s.cols | 0) === row);
            if (!inRow.length) continue;
            inRow.sort((a, b) => {
                const da = Math.abs(a % s.cols - targetCol);
                const db = Math.abs(b % s.cols - targetCol);
                return da - db || b - a;
            });
            return inRow[0];
        }
        return 0;
    }

    /** Resolve directional movement in the construct's logical choice
     *  matrix. At a non-exitable boundary, horizontal movement continues
     *  in reading order and vertical movement continues in column order. */
    #selectionNavigationTarget (construct, index, key) {
        const positions = construct.itemPositions ?? [];
        const items = construct.items ?? [];
        const valid = i => i >= 0 && i < items.length
            && positions[i] && !items[i].nonCursorable;
        const cursorable = positions
            .map((pos, i) => ({ pos, i, item: items[i] }))
            .filter(entry => entry.pos && !entry.item.nonCursorable);
        if (cursorable.length <= 1) return construct.cursorExitable ? null : cursorable[0];

        const rows = new Map();
        for (let i = 0; i < positions.length; i++) {
            if (!positions[i]) continue;
            const row = positions[i].row;
            if (!rows.has(row)) rows.set(row, []);
            rows.get(row).push(i);
        }
        const inferredCols = Math.max(1, ...[...rows.values()].map(indices => indices.length));
        const cols = Math.max(1, construct.numOfCols || inferredCols);
        const rowStart = Math.floor(index / cols) * cols;
        const rowEnd = Math.min(items.length - 1, rowStart + cols - 1);

        if (key === 'ArrowLeft' || key === 'ArrowRight') {
            const step = key === 'ArrowLeft' ? -1 : 1;
            const edge = key === 'ArrowLeft' ? rowStart : rowEnd;
            for (let i = index + step;
                step < 0 ? i >= edge : i <= edge; i += step) {
                if (valid(i)) return { pos: positions[i], i, item: items[i] };
            }
            if (construct.cursorExitable) return null;
            for (let offset = 1; offset < items.length; offset++) {
                const i = (index + step * offset + items.length) % items.length;
                if (valid(i)) return { pos: positions[i], i, item: items[i] };
            }
            return null;
        }

        const col = index % cols;
        const step = key === 'ArrowUp' ? -cols : cols;
        for (let i = index + step; i >= 0 && i < items.length; i += step) {
            if (valid(i)) return { pos: positions[i], i, item: items[i] };
        }
        if (construct.cursorExitable) return null;

        // Crossing the top/bottom moves to the preceding/following
        // logical column, then searches from the opposite vertical edge.
        const nextCol = key === 'ArrowUp'
            ? (col - 1 + cols) % cols
            : (col + 1) % cols;
        if (key === 'ArrowUp') {
            let i = nextCol + Math.floor((items.length - 1 - nextCol) / cols) * cols;
            for (; i >= 0; i -= cols) {
                if (valid(i)) return { pos: positions[i], i, item: items[i] };
            }
        } else {
            for (let i = nextCol; i < items.length; i += cols) {
                if (valid(i)) return { pos: positions[i], i, item: items[i] };
            }
        }
        return null;
    }

    /** Return the current restricted ENPTUI window when it contains the
     *  cursor. Removing the current window deliberately does not make an
     *  older window current again. */
    #enclosingRestrictedWindow (cursor) {
        const s = this.screen;
        if (!s.enptui) return null;
        const r = (cursor / s.cols | 0) + 1;
        const c = (cursor % s.cols) + 1;
        const window = s.enptui.all.findLast(construct =>
            construct.kind === ConstructKind.WINDOW
            && construct.cursorAtStart === s.currentEnptuiWindowAddress);
        if (!window?.cursorRestricted) return null;
        return r >= window.innerTopRow && r < window.innerTopRow + window.innerHeight
            && c >= window.innerLeftCol && c < window.innerLeftCol + window.innerWidth
            ? window : null;
    }

    /** Wrap an attempted move that escaped a restricted window back to
     *  the opposite edge. Horizontal movement follows reading order;
     *  vertical movement preserves the column. */
    #wrapInWindow (key, addr, w) {
        const s = this.screen;
        const r = (addr / s.cols | 0) + 1;
        const c = (addr % s.cols) + 1;
        const top = w.innerTopRow,    bot   = w.innerTopRow  + w.innerHeight - 1;
        const left = w.innerLeftCol,  right = w.innerLeftCol + w.innerWidth  - 1;
        if (r >= top && r <= bot && c >= left && c <= right) return null;
        const currentRow = (s.cursor / s.cols | 0) + 1;
        const currentCol = (s.cursor % s.cols) + 1;
        let rr = currentRow;
        let cc = currentCol;
        if (key === 'ArrowLeft') {
            if (currentRow === top && currentCol === left) {
                rr = bot; cc = right;
            } else {
                rr = currentRow - 1; cc = right;
            }
        } else if (key === 'ArrowRight') {
            if (currentRow === bot && currentCol === right) {
                rr = top; cc = left;
            } else {
                rr = currentRow + 1; cc = left;
            }
        } else if (key === 'ArrowUp') {
            rr = bot;
        } else if (key === 'ArrowDown') {
            rr = top;
        }
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

        for (const c of s.enptui.frontToBack) {
            if (c.kind === ConstructKind.WINDOW) {
                const bounds = s.enptui.boundsOf(c);
                if (bounds && row1 >= bounds.top && row1 <= bounds.bottom
                    && col1 >= bounds.left && col1 <= bounds.right) return false;
                continue;
            }
            if (c.kind === ConstructKind.SCROLL_BAR) {
                if (this.#tryScrollBarClick(c, row1, col1)) return true;
                continue;
            }
            if (c.kind !== ConstructKind.SELECTION_FIELD
                && c.kind !== ConstructKind.PUSH_BUTTONS
                && c.kind !== ConstructKind.MENU_BAR) continue;
            for (let i = 0; i < c.items.length; i++) {
                const pos = c.itemPositions?.[i];
                if (!pos) continue;
                const startCol = pos.hitCol ?? pos.col;
                const endCol   = startCol
                    + (pos.hitWidth ?? pos.slotWidth ?? c.textSize ?? 1) - 1;
                if (row1 !== pos.row) continue;
                if (col1 < startCol || col1 > endCol) continue;
                if (s.keyboardLocked) return true;
                if (c.items[i].nonCursorable) {
                    this.#rejectEnptuiChoice();
                    return true;
                }
                // Pointer activation is still an attempted cursor move even
                // when the construct asks us to restore the old cursor after
                // the click. Mandatory-fill/self-check departure rules can
                // therefore veto the activation before choice state changes.
                const previousCursor = s.cursor;
                const moved = this.h.onMoveCursor?.(pos.textIdx);
                if (moved === false) return true;
                this.#activateEnptuiItem(c, i);
                if (!c.pointerMayMoveCursor) {
                    s.cursor = previousCursor;
                    this.renderer.draw();
                }
                return true;
            }
        }
        return false;
    }

    #selectionCharacter (ch, hit) {
        const { construct } = hit;
        // Slash is the workstation's built-in Select key.  The host may
        // additionally supply another selection character; comparison of
        // that character follows operator-key semantics and is therefore
        // case-insensitive in the active code page.
        const configured = construct.selectChar
            ? this.screen.ebcdic.toChar(construct.selectChar)
            : '';
        if (ch === '/' || (configured && configured.toUpperCase() === ch.toUpperCase())) {
            this.#selectEnptuiItem(construct, hit.index);
            return true;
        }

        const target = ch.toLowerCase();
        const mnemonicIndex = construct.items.findIndex(item => {
            if (item.nonCursorable || item.mnemonicOffset < 0) return false;
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
        this.#rejectEnptuiChoice('invalid selection key');
        return true;
    }

    #selectEnptuiItem (construct, idx) {
        if (this.screen.keyboardLocked) return;
        const item = construct.items[idx];
        if (!item || item.nonCursorable) {
            this.#rejectEnptuiChoice();
            return;
        }
        if (!construct.multi) {
            this.#deselectOtherCursorableItems(construct, idx);
        }
        if (item.unavailable) {
            this.#rejectEnptuiChoice();
            return;
        }
        item.selected = true;
        construct.modified = true;
        this.#repaintItem(construct, idx);
        this.renderer.draw();
        if (construct.autoEnterOnSelect)
            this.h.onAid?.(item.aidCode || Aid.ENTER);
    }

    /** Delete deselects the focused ENPTUI choice instead of editing the
     *  normal field that happens to occupy the same screen cells. */
    #deselectEnptuiItem (construct, idx) {
        if (this.screen.keyboardLocked) return;
        const item = construct.items?.[idx];
        if (!item || item.unavailable || item.nonCursorable) return;
        item.selected = false;
        construct.modified = true;
        this.#repaintItem(construct, idx);
        this.renderer.draw();
        if (construct.autoEnterOnDeselect)
            this.h.onAid?.(item.aidCode || Aid.ENTER);
    }

    #rejectEnptuiChoice (message = 'choice unavailable') {
        this.screen.alarm = true;
        this.h.onFlash?.(message);
        this.renderer.draw();
    }

    /** Erase Input still clears ordinary input fields, then clears every
     *  cursorable ENPTUI choice. Only the construct under the cursor may
     *  trigger its configured deselection AID. */
    #eraseInput () {
        if (this.screen.keyboardLocked) return;
        const focused = this.screen.enptuiItemAtCursor?.();
        this.h.onEraseInput?.();
        for (const construct of this.screen.enptui?.all ?? []) {
            if (![ConstructKind.SELECTION_FIELD, ConstructKind.MENU_BAR,
                ConstructKind.PUSH_BUTTONS].includes(construct.kind)) continue;
            for (let i = 0; i < (construct.items?.length ?? 0); i++) {
                const item = construct.items[i];
                if (item.nonCursorable) continue;
                item.selected = false;
                this.#repaintItem(construct, i);
            }
            // Erase Input does not manufacture MDT for ENPTUI fields.
            // A field already marked by an earlier operator action keeps
            // that state, while an otherwise untouched host selection is
            // merely cleared from the local presentation.
        }
        this.renderer.draw();
        if (focused?.construct.autoEnterOnDeselect) {
            const item = focused.construct.items?.[focused.index];
            // Erase Input operates on the focused pseudo-field as a whole.
            // Availability prevents direct choice activation, but does not
            // suppress the field's configured deselection AID.
            if (item && !item.nonCursorable)
                this.h.onAid?.(item.aidCode || Aid.ENTER);
        }
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
        const hit = this.#scrollBarAt(row1, col1, sb);
        if (!hit) return false;
        if (this.screen.keyboardLocked) return true;
        const previousCursor = this.screen.cursor;
        const clickedAddress = (row1 - 1) * this.screen.cols + col1 - 1;
        const moved = this.h.onMoveCursor?.(clickedAddress);
        if (moved === false) return true;
        const retainCursor = sb.parent
            ? sb.parent.pointerMayMoveCursor
            : sb.moveCursor;
        const finish = () => {
            if (retainCursor) return;
            this.screen.cursor = previousCursor;
            this.renderer.draw();
        };

        const vertical = sb.direction === 0;
        const towardStart = hit.zone === 'decrement' || hit.zone === 'pageDecrement';
        const towardEnd = hit.zone === 'increment' || hit.zone === 'pageIncrement';
        const visible = vertical ? sb.length : Math.max(1, sb.length - 2);
        if ((towardStart && sb.sliderPos === 0)
            || (towardEnd && sb.sliderPos + visible >= sb.totalRows)) {
            finish();
            return true;
        }
        if (towardStart || towardEnd) {
            const page = hit.zone === 'pageDecrement' || hit.zone === 'pageIncrement';
            sb.scrollIncrement = page ? sb.length : 1;
            sb.modified = true;
            if (sb.parent) sb.parent.modified = true;
            this.h.onAid?.(vertical
                ? (towardStart ? Aid.ROLL_DOWN : Aid.ROLL_UP)
                : (towardStart ? Aid.ROLL_LEFT : Aid.ROLL_RIGHT));
        }
        finish();
        return true;
    }

    #scrollBarAt (row1, col1, only = null) {
        const constructs = only ? [only] : (this.screen.enptui?.frontToBack ?? []);
        for (const scrollBar of constructs) {
            if (scrollBar.kind === ConstructKind.WINDOW) {
                const bounds = this.screen.enptui.boundsOf(scrollBar);
                if (bounds && row1 >= bounds.top && row1 <= bounds.bottom
                    && col1 >= bounds.left && col1 <= bounds.right) return null;
                continue;
            }
            if (scrollBar.kind !== ConstructKind.SCROLL_BAR) continue;
            const vertical = scrollBar.direction === 0;
            const axis = vertical ? row1 : col1;
            const offAxis = vertical ? col1 : row1;
            const start = vertical ? scrollBar.rowOffset + 1 : scrollBar.colOffset + 2;
            const end = vertical
                ? start + scrollBar.length - 1
                : scrollBar.colOffset + scrollBar.length - 1;
            const center = vertical ? scrollBar.colOffset + 2 : scrollBar.rowOffset + 1;
            if (offAxis !== center || axis < start || axis > end) continue;
            const sliderPos = scrollBar.sliderCellPos ?? 1;
            const sliderSize = Math.max(1, scrollBar.sliderCellSize ?? 1);
            const thumbStart = vertical
                ? start + sliderPos
                : scrollBar.colOffset + sliderPos + 1;
            // Horizontal hit testing includes the cell immediately before
            // the painted shaft as part of the draggable slider zone. This
            // is intentional and matches the terminal cell-space contract.
            const thumbEnd = vertical
                ? thumbStart + sliderSize - 1
                : thumbStart + sliderSize;
            const zone = axis === start ? 'decrement'
                : axis === end ? 'increment'
                : axis < thumbStart ? 'pageDecrement'
                : axis > thumbEnd ? 'pageIncrement'
                : 'thumb';
            return { scrollBar, zone };
        }
        return null;
    }

    /** Look for an ENPTUI item whose mnemonic letter matches the typed
     *  character (case-insensitive), move focus to it and select it. */
    #tryMnemonic (ch) {
        if (this.screen.keyboardLocked) return false;
        const target = ch.toLowerCase();
        const s = this.screen;
        for (const c of s.enptui.frontToBack) {
            if (c.kind !== ConstructKind.SELECTION_FIELD
                && c.kind !== ConstructKind.PUSH_BUTTONS
                && c.kind !== ConstructKind.MENU_BAR) continue;
            for (let i = 0; i < c.items.length; i++) {
                const item = c.items[i];
                if (item.nonCursorable) continue;
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
        if (!item || item.nonCursorable) return true;

        // Enter optionally auto-selects the focused choice, then submits
        // that choice's own AID only when it is selected. This is distinct
        // from Space/pointer activation, which toggles the choice first.
        if (construct.autoSelect) {
            if (!construct.multi) {
                this.#deselectOtherCursorableItems(construct, index);
            }
            if (item.unavailable) {
                this.#rejectEnptuiChoice();
                return true;
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
        if (!item || item.nonCursorable) {
            this.#rejectEnptuiChoice();
            return;
        }

        // IBM's pointer path is the Space-key path: ordinary single-choice
        // fields/menu bars deselect their peers and toggle the target;
        // push buttons toggle without clearing their peers. Multi-choice
        // fields independently toggle each item.
        if (!construct.multi && construct.kind !== ConstructKind.PUSH_BUTTONS) {
            this.#deselectOtherCursorableItems(construct, idx);
        }
        if (item.unavailable) {
            this.#rejectEnptuiChoice();
            return;
        }
        item.selected = !item.selected;
        construct.modified = true;
        // Repaint immediately so the user sees the change before
        // submitting the AID; the indicator overlay reads from
        // construct.items so no further state update is needed.
        this.#repaintItem(construct, idx);
        this.renderer.draw();
        if (item.selected ? construct.autoEnterOnSelect : construct.autoEnterOnDeselect)
            this.h.onAid?.(item.aidCode || Aid.ENTER);
    }

    /** A single-choice activation may only change choices that the operator
     *  can reach. A selected non-cursorable choice is host-owned state and
     *  remains selected until a later host write replaces it. */
    #deselectOtherCursorableItems (construct, selectedIndex) {
        for (let i = 0; i < construct.items.length; i++) {
            if (i === selectedIndex || construct.items[i].nonCursorable) continue;
            construct.items[i].selected = false;
            this.#repaintItem(construct, i);
        }
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
        const attrIndex = item.unavailable ? 5
            : item.selected && construct.kind !== ConstructKind.PUSH_BUTTONS ? 4 : 3;
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
