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
        if (construct.active === undefined) construct.active = true;
        // Replacement is decided by the decoder from construct-specific
        // equality and coverage rules.  SBA alone is not an identity: nested
        // windows may legitimately share their top-left address.
        this.constructs.push(construct);
    }

    removeAt (cursor, kind) {
        const removed = this.constructs.filter(c =>
            c.cursorAtStart === cursor && (!kind || c.kind === kind));
        this.constructs = this.constructs.filter(c =>
            !(c.cursorAtStart === cursor && (!kind || c.kind === kind)));
        return removed;
    }

    /** Disable matching constructs while retaining their last painted
     *  presentation.  Format-table and Remove-GUI operations remove the
     *  pseudo-field from keyboard/read processing, but the characters and
     *  framing already displayed remain until later output replaces them. */
    inactivateAt (cursor, kind) {
        return this.inactivateWhere(construct =>
            construct.cursorAtStart === cursor && (!kind || construct.kind === kind));
    }

    inactivateFirst (predicate) {
        const construct = this.constructs.find(candidate =>
            candidate.active !== false && predicate(candidate));
        if (!construct) return null;
        construct.active = false;
        return construct;
    }

    inactivateWhere (predicate) {
        const inactivated = [];
        for (const construct of this.constructs) {
            if (construct.active === false || !predicate(construct)) continue;
            construct.active = false;
            inactivated.push(construct);
        }
        return inactivated;
    }

    /** Mark one cell of an inactive construct's retained presentation as
     *  replaced by later host output. Active constructs are redrawn from
     *  their live state; only presentation-only constructs need this mask. */
    occludeInactiveAt (address, cols) {
        if (!Number.isInteger(address) || !Number.isInteger(cols) || cols < 1) return;
        const row = ((address / cols) | 0) + 1;
        const col = (address % cols) + 1;
        const fullyOccluded = new Set();
        for (const construct of this.constructs) {
            if (construct.active !== false) continue;
            const bounds = this.boundsOf(construct);
            if (!bounds || row < bounds.top || row > bounds.bottom
                || col < bounds.left || col > bounds.right) continue;
            if (!construct.occludedCells) construct.occludedCells = new Set();
            construct.occludedCells.add(address);
            const visibleCells = Math.max(0, bounds.bottom - bounds.top + 1)
                * Math.max(0, bounds.right - bounds.left + 1);
            if (visibleCells > 0 && construct.occludedCells.size >= visibleCells)
                fullyOccluded.add(construct);
        }
        if (fullyOccluded.size)
            this.constructs = this.constructs.filter(construct => !fullyOccluded.has(construct));
    }

    removeWhere (predicate) {
        const removed = this.constructs.filter(predicate);
        this.constructs = this.constructs.filter(c => !predicate(c));
        return removed;
    }

    boundsOf (construct) {
        if (!construct) return null;
        if (Number.isInteger(construct.boundsTopRow)
            && Number.isInteger(construct.boundsLeftCol)) {
            return {
                top: construct.boundsTopRow,
                left: construct.boundsLeftCol,
                bottom: construct.boundsTopRow + (construct.boundsHeight ?? 1) - 1,
                right: construct.boundsLeftCol + (construct.boundsWidth ?? 1) - 1,
            };
        }
        if (construct.kind === ConstructKind.WINDOW) {
            return {
                top: construct.topRow,
                left: construct.leftCol,
                bottom: construct.topRow + construct.height - 1,
                right: construct.leftCol + construct.width - 1,
            };
        }
        if (construct.kind === ConstructKind.SCROLL_BAR) {
            const top = construct.rowOffset + 1;
            const left = construct.colOffset + 1;
            return {
                top,
                left,
                bottom: top + (construct.boundsHeight ?? 1) - 1,
                right: left + (construct.boundsWidth ?? 1) - 1,
            };
        }
        if (construct.itemPositions?.length) {
            const positions = construct.itemPositions.filter(Boolean);
            if (!positions.length) return null;
            return {
                top: Math.min(...positions.map(position => position.row)),
                left: Math.min(...positions.map(position => position.hitCol ?? position.col)),
                bottom: Math.max(...positions.map(position => position.row)),
                right: Math.max(...positions.map(position =>
                    (position.hitCol ?? position.col) + (position.hitWidth ?? 1) - 1)),
            };
        }
        return null;
    }

    /** Remove active GUI constructs completely covered by a newly
     *  defined construct. Global grid and pointer-definition state are
     *  not rectangular GUI fields and therefore do not participate. */
    removeCoveredBy (owner) {
        const outer = this.boundsOf(owner);
        if (!outer) return [];
        return this.removeWhere(construct => {
            if ([ConstructKind.GRID, ConstructKind.MOUSE_EVENTS].includes(construct.kind))
                return false;
            const inner = this.boundsOf(construct);
            return inner
                && inner.top >= outer.top && inner.left >= outer.left
                && inner.bottom <= outer.bottom && inner.right <= outer.right;
        });
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
        const removed = [];
        this.constructs = this.constructs.filter(c => {
            // IBM cascades only field constructs (construct types 2..5),
            // never another window, the global grid, or PMB definitions.
            if (![ConstructKind.SELECTION_FIELD, ConstructKind.MENU_BAR,
                ConstructKind.PUSH_BUTTONS, ConstructKind.SCROLL_BAR].includes(c.kind)) return true;
            const bounds = this.boundsOf(c);
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

    inactivateChildrenLinkedTo (parent) {
        return this.inactivateWhere(construct => construct.parent === parent);
    }

    /** Iterate all constructs of a given kind. */
    *of (kind) {
        for (const c of this.constructs)
            if (c.active !== false && c.kind === kind) yield c;
    }

    /** Topmost window that visually contains the given (row, col) - 1-based. */
    constructAt (row, col) {
        for (const c of this.frontToBack) {
            if (c.active !== false && c.kind === ConstructKind.WINDOW
                && row >= c.topRow && row < c.topRow + c.height
                && col >= c.leftCol && col < c.leftCol + c.width)
                return c;
        }
        return null;
    }

    /** Active constructs participate in input, reads and host updates. */
    get all () { return this.constructs.filter(construct => construct.active !== false); }

    /** Hit testing follows paint stacking: the newest active construct is
     *  examined first, while `all` retains host definition order for Tab
     *  traversal and outbound reads. */
    get frontToBack () { return this.all.slice().reverse(); }

    /** Active and presentation-only constructs are both paintable. */
    get visuals () { return this.constructs; }
}
