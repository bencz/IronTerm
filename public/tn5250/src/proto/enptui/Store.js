// ENPTUI construct store. Lives on `screen.enptui` and tracks every
// active GUI primitive (windows, selection fields, push buttons, menu
// bars, scroll bars). Constructs are keyed by their starting buffer
// address (the SBA where the host emitted the CreateWindow / DefineSelFld
// segment), so we can quickly remove them with a `removeAt(addr)` when
// the host sends a Remove* command.
//
// The renderer iterates this store every paint to overlay the GUI
// primitives on top of the regular character cells. The input layer
// consults it to figure out which construct (if any) owns the cell the
// user is clicking on.

import { ConstructKind } from './Constants.js';

export class EnptuiStore {
    constructor () {
        this.constructs = [];        // insertion-ordered for paint correctness
    }

    clear () {
        this.constructs = [];
    }

    /** Preserve the full GUI graph across 5250 Save/Restore Screen.
     *  structuredClone keeps typed arrays and the parent references used
     *  by attached scroll bars intact. */
    snapshot () {
        return structuredClone(this.constructs);
    }

    restore (snapshot) {
        this.constructs = snapshot ? structuredClone(snapshot) : [];
    }

    add (construct) {
        if (!construct) return;
        // The host may re-emit a construct at the same SBA position
        // (e.g. refreshing a selection field). Replace in place rather
        // than stacking duplicates.
        const idx = this.constructs.findIndex(c =>
            c.cursorAtStart === construct.cursorAtStart && c.kind === construct.kind);
        if (idx >= 0) this.constructs[idx] = construct;
        else this.constructs.push(construct);
    }

    removeAt (cursor, kind) {
        const removed = this.constructs.filter(c =>
            c.cursorAtStart === cursor && (!kind || c.kind === kind));
        this.constructs = this.constructs.filter(c =>
            !(c.cursorAtStart === cursor && (!kind || c.kind === kind)));
        return removed;
    }

    removeWhere (predicate) {
        const removed = this.constructs.filter(predicate);
        this.constructs = this.constructs.filter(c => !predicate(c));
        return removed;
    }

    /** Remove every input construct that lies entirely inside `window`'s
     *  bounding rectangle, the way a GUI window is destroyed - any
     *  SelectionField or ScrollBar
     *  that the host previously anchored INSIDE the window goes away
     *  with it. Returns the removed children for inspection. */
    removeChildrenOf (window) {
        if (!window) return [];
        const top    = window.topRow;
        const left   = window.leftCol;
        const bot    = top  + window.height - 1;
        const right  = left + window.width  - 1;
        const inside = (r, c) => r >= top && r <= bot && c >= left && c <= right;
        const boundsOf = construct => {
            if (Number.isInteger(construct.boundsTopRow)
                && Number.isInteger(construct.boundsLeftCol)) {
                return {
                    top: construct.boundsTopRow,
                    left: construct.boundsLeftCol,
                    bottom: construct.boundsTopRow + (construct.boundsHeight ?? 1) - 1,
                    right: construct.boundsLeftCol + (construct.boundsWidth ?? 1) - 1,
                };
            }
            if (construct.kind === ConstructKind.SCROLL_BAR) {
                const cTop = construct.rowOffset + 1;
                const cLeft = construct.colOffset + 1;
                return {
                    top: cTop,
                    left: cLeft,
                    bottom: cTop + (construct.boundsHeight ?? 1) - 1,
                    right: cLeft + (construct.boundsWidth ?? 1) - 1,
                };
            }
            if (construct.itemPositions?.length) {
                const positions = construct.itemPositions.filter(Boolean);
                if (!positions.length) return null;
                return {
                    top: Math.min(...positions.map(p => p.row)),
                    left: Math.min(...positions.map(p => p.col)),
                    bottom: Math.max(...positions.map(p => p.row)),
                    right: Math.max(...positions.map(p => p.col + (p.hitWidth ?? 1) - 1)),
                };
            }
            const r = construct.topRow ?? construct.row;
            const c = construct.leftCol ?? construct.col;
            if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
            return { top: r, left: c, bottom: r, right: c };
        };
        const removed = [];
        this.constructs = this.constructs.filter(c => {
            // IBM cascades only field constructs (construct types 2..5),
            // never another window, the global grid, or PMB definitions.
            if (![ConstructKind.SELECTION_FIELD, ConstructKind.MENU_BAR,
                ConstructKind.PUSH_BUTTONS, ConstructKind.SCROLL_BAR].includes(c.kind)) return true;
            const bounds = boundsOf(c);
            if (!bounds) return true;
            if (inside(bounds.top, bounds.left) && inside(bounds.bottom, bounds.right)) {
                removed.push(c);
                return false;
            }
            return true;
        });
        return removed;
    }

    /** Remove every construct linked as a child of `parent` (via the
     *  `parent` reference set when a SelectionField has an attached
     *  ScrollBar). */
    removeChildrenLinkedTo (parent) {
        if (!parent) return [];
        const removed = this.constructs.filter(c => c.parent === parent);
        this.constructs = this.constructs.filter(c => c.parent !== parent);
        return removed;
    }

    /** Iterate all constructs of a given kind. */
    *of (kind) {
        for (const c of this.constructs) if (c.kind === kind) yield c;
    }

    /** First construct that visually contains the given (row, col) - 1-based. */
    constructAt (row, col) {
        for (const c of this.constructs) {
            if (c.kind === ConstructKind.WINDOW
                && row >= c.topRow && row < c.topRow + c.height
                && col >= c.leftCol && col < c.leftCol + c.width)
                return c;
        }
        return null;
    }

    get all () { return this.constructs; }
}
