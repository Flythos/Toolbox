// Toolbox — pure, DOM-free registry logic.
//
// A "tool" is one re-homable entry, identified by a key string:
//   options:<element-id>  — an <a id="option_…"> item in the hamburger menu (#options)
//   wand:<element-id>     — a div.list-group-item entry in the wand menu (#extensionsMenu)
//   custom:<id>           — a user-defined stscript button (never generates hide rules)
//
// Membership in the toolbox (and its display order) is one array:
// settings.inToolbox. Hiding a re-homed tool in its source menu is done with
// !important stylesheet rules built by buildHideRules() — stylesheet rules
// survive DOM re-renders and core's own .show() calls, and the original
// elements stay in the DOM so their click handlers keep working.

export const SCHEMA_VERSION = 1;

// Every source a tool can come from.
export const SOURCES = new Set(['options', 'wand', 'custom']);

// Options-menu items core keeps permanently hidden itself — never offered.
export const OPTIONS_SKIP = new Set(['option_settings']);

// Ids that appear more than once inside #options (a hidden copy + the visible
// copy). Hiding via `#options a#<id>` matches every copy, which is fine;
// execution must target the visible copy specifically.
export const DUPLICATE_OPTION_IDS = new Set(['option_close_chat']);

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const ICON_TOKEN = /^fa-[a-z0-9-]+$/i;

export function defaults() {
    return {
        version: SCHEMA_VERSION,
        // Catalogs of every tool ever discovered (raw element ids / custom defs).
        tools: { options: [], wand: [], custom: [] },
        // Keys currently living in the toolbox = membership AND display order.
        inToolbox: [],
        fab: { x: null, y: null },
        showFab: true,
        closeOnExecute: false,
    };
}

// Coerces anything loaded from disk into a valid settings object. Unknown or
// mistyped fields fall back to defaults instead of poisoning the session.
export function mergeDefaults(stored) {
    const base = defaults();
    if (!stored || typeof stored !== 'object') {
        return base;
    }
    return {
        version: SCHEMA_VERSION,
        tools: {
            options: asStringArray(stored.tools?.options),
            wand: asStringArray(stored.tools?.wand),
            custom: Array.isArray(stored.tools?.custom)
                ? stored.tools.custom.filter(t => t && typeof t === 'object' && typeof t.id === 'string')
                : [],
        },
        inToolbox: asStringArray(stored.inToolbox),
        fab: {
            x: Number.isFinite(stored.fab?.x) ? stored.fab.x : null,
            y: Number.isFinite(stored.fab?.y) ? stored.fab.y : null,
        },
        showFab: typeof stored.showFab === 'boolean' ? stored.showFab : base.showFab,
        closeOnExecute: typeof stored.closeOnExecute === 'boolean' ? stored.closeOnExecute : base.closeOnExecute,
    };
}

function asStringArray(value) {
    return Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : [];
}

export function genId() {
    return `${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

export function keyToString(source, id) {
    if (typeof source !== 'string' || !SOURCES.has(source)) {
        return null;
    }
    if (typeof id !== 'string' || id.length === 0) {
        return null;
    }
    return `${source}:${id}`;
}

export function stringToKey(key) {
    if (typeof key !== 'string') {
        return null;
    }
    const sep = key.indexOf(':');
    if (sep <= 0) {
        return null;
    }
    const source = key.slice(0, sep);
    const id = key.slice(sep + 1);
    if (!SOURCES.has(source) || id.length === 0 || !SAFE_ID.test(id)) {
        return null;
    }
    return { source, id };
}

// Cleans settings.inToolbox against the catalogs: dedupes (first occurrence
// wins, order preserved) and drops keys that no longer resolve to a known
// tool. Membership is never expanded here — joining the toolbox is always an
// explicit user action.
export function normalizeOrder(inToolbox, knownKeys) {
    const known = new Set(knownKeys);
    const order = [];
    const dropped = [];
    for (const key of Array.isArray(inToolbox) ? inToolbox : []) {
        if (typeof key !== 'string') {
            continue;
        }
        if (!known.has(key)) {
            dropped.push(key);
            continue;
        }
        if (!order.includes(key)) {
            order.push(key);
        }
    }
    return { order, dropped };
}

// The CSS that removes re-homed tools from their source menus. Only options
// and wand keys produce rules (custom tools have no source menu); ids are
// validated so a hostile stored key can't inject CSS. Rules are deliberately
// generated even for tools currently undiscovered (e.g. a temporarily
// disabled extension), so the re-homing survives enable/disable cycles.
export function buildHideRules(inToolbox) {
    const rules = [];
    for (const key of Array.isArray(inToolbox) ? inToolbox : []) {
        const parsed = stringToKey(key);
        if (!parsed) {
            continue;
        }
        if (parsed.source === 'options') {
            rules.push(`#options a#${parsed.id}{display:none!important}`);
        } else if (parsed.source === 'wand') {
            rules.push(`#extensionsMenu #${parsed.id}{display:none!important}`);
        }
    }
    return rules.join('\n');
}

// Keeps only real FontAwesome utility classes from free-form user input.
export function sanitizeIcon(raw) {
    return String(raw ?? '')
        .split(/\s+/)
        .filter(token => ICON_TOKEN.test(token))
        .join(' ');
}

// Validates + normalizes a custom tool definition from the settings form.
// Returns { ok: true, tool } or { ok: false, error }.
export function validateCustomTool(input) {
    const label = String(input?.label ?? '').trim();
    const script = String(input?.script ?? '').trim();
    if (!label) {
        return { ok: false, error: 'Label is required.' };
    }
    if (!script) {
        return { ok: false, error: 'Script is required.' };
    }
    return {
        ok: true,
        tool: {
            id: typeof input.id === 'string' && input.id ? input.id : genId(),
            label,
            icon: sanitizeIcon(input.icon) || 'fa-solid fa-toolbox',
            script,
        },
    };
}
