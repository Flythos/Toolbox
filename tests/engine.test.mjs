// Toolbox registry tests — pure logic, no DOM.
// Run: `npm test`
import { strict as assert } from 'node:assert';
import {
    DUPLICATE_OPTION_IDS,
    OPTIONS_SKIP,
    SCHEMA_VERSION,
    WAND_GEN_PREFIX,
    buildHideRules,
    defaults,
    genId,
    keyToString,
    mergeDefaults,
    normalizeOrder,
    sanitizeIcon,
    stringToKey,
    validateCustomTool,
} from '../src/registry.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`PASS ${name}`);
        passed++;
    } catch (error) {
        console.log(`FAIL ${name}\n  ${error?.message ?? error}`);
        failed++;
    }
}

// --- key round-trips ---

test('keyToString/stringToKey round-trip for all sources', () => {
    for (const [source, id] of [
        ['options', 'option_regenerate'],
        ['wand', 'send_picture'],
        ['custom', 'abc123'],
    ]) {
        const key = keyToString(source, id);
        assert.equal(key, `${source}:${id}`);
        assert.deepEqual(stringToKey(key), { source, id });
    }
});

test('stringToKey rejects malformed keys', () => {
    assert.equal(stringToKey('no-separator'), null);
    assert.equal(stringToKey(':option_x'), null);
    assert.equal(stringToKey('options:'), null);
    assert.equal(stringToKey('bogus:option_x'), null);
    assert.equal(stringToKey('options:bad id'), null);
    assert.equal(stringToKey('options:injection}{body{}'), null);
    assert.equal(stringToKey(null), null);
    assert.equal(stringToKey(42), null);
    assert.deepEqual(stringToKey('wand:send_picture'), { source: 'wand', id: 'send_picture' });
});

test('keyToString rejects invalid source or empty id', () => {
    assert.equal(keyToString('menu', 'x'), null);
    assert.equal(keyToString('options', ''), null);
    assert.equal(keyToString('options', null), null);
});

// --- mergeDefaults ---

test('mergeDefaults of nothing returns defaults', () => {
    const merged = mergeDefaults(undefined);
    assert.equal(merged.version, SCHEMA_VERSION);
    assert.deepEqual(merged.tools, { options: [], wand: [], custom: [] });
    assert.deepEqual(merged.inToolbox, []);
    assert.deepEqual(merged.fab, { x: null, y: null });
    assert.equal(merged.showFab, true);
    assert.equal(merged.closeOnExecute, false);
});

test('mergeDefaults preserves stored values', () => {
    const merged = mergeDefaults({
        tools: { options: ['option_regenerate'], wand: ['sd_gen'], custom: [{ id: 'c1', label: 'L', icon: '', script: '/help' }] },
        inToolbox: ['options:option_regenerate'],
        fab: { x: 12.5, y: 40 },
        showFab: false,
        closeOnExecute: true,
    });
    assert.deepEqual(merged.tools.options, ['option_regenerate']);
    assert.deepEqual(merged.tools.wand, ['sd_gen']);
    assert.equal(merged.tools.custom.length, 1);
    assert.deepEqual(merged.inToolbox, ['options:option_regenerate']);
    assert.deepEqual(merged.fab, { x: 12.5, y: 40 });
    assert.equal(merged.showFab, false);
    assert.equal(merged.closeOnExecute, true);
});

test('mergeDefaults coerces mistyped fields', () => {
    const merged = mergeDefaults({
        tools: { options: 'nope', wand: [1, 'sd_gen', null], custom: ['bad', { id: 'c1' }, null] },
        inToolbox: 'nope',
        fab: { x: '12px', y: NaN },
        showFab: 'yes',
        closeOnExecute: 1,
    });
    assert.deepEqual(merged.tools.options, []);
    assert.deepEqual(merged.tools.wand, ['sd_gen']);
    assert.deepEqual(merged.tools.custom.map(t => t.id), ['c1']);
    assert.deepEqual(merged.inToolbox, []);
    assert.deepEqual(merged.fab, { x: null, y: null });
    assert.equal(merged.showFab, true);
    assert.equal(merged.closeOnExecute, false);
});

// --- normalizeOrder ---

test('normalizeOrder dedupes and drops unknown keys', () => {
    const { order, dropped } = normalizeOrder(['b', 'a', 'b', 'zzz', 'custom:gone'], ['a', 'b', 'custom:live']);
    assert.deepEqual(order, ['b', 'a']);
    assert.deepEqual(dropped, ['zzz', 'custom:gone']);
});

test('normalizeOrder never expands membership', () => {
    const { order } = normalizeOrder([], ['a', 'b']);
    assert.deepEqual(order, []);
});

test('normalizeOrder handles junk input', () => {
    assert.deepEqual(normalizeOrder(null, ['a']).order, []);
    assert.deepEqual(normalizeOrder([1, {}, 'a'], ['a']).order, ['a']);
});

// --- buildHideRules ---

test('buildHideRules emits options rule', () => {
    assert.equal(buildHideRules(['options:option_regenerate']), '#options a#option_regenerate{display:none!important}');
});

test('buildHideRules emits wand rule', () => {
    assert.equal(buildHideRules(['wand:send_picture']), '#extensionsMenu #send_picture{display:none!important}');
});

test('buildHideRules hides both duplicate close_chat copies via one rule', () => {
    assert.equal(buildHideRules(['options:option_close_chat']), '#options a#option_close_chat{display:none!important}');
});

test('buildHideRules skips custom tools and unsafe ids', () => {
    assert.equal(buildHideRules(['custom:abc123']), '');
    assert.equal(buildHideRules(['options:bad id']), '');
    assert.equal(buildHideRules(['wand:evil}{body{}']), '');
    assert.equal(buildHideRules(['garbage']), '');
});

test('buildHideRules uses attribute selector for generated wand ids', () => {
    const key = keyToString('wand', `${WAND_GEN_PREFIX}abc123`);
    assert.equal(buildHideRules([key]), '#extensionsMenu [data-toolbox-id="gen-abc123"]{display:none!important}');
});

test('buildHideRules preserves order and joins rules', () => {
    const css = buildHideRules(['wand:send_picture', 'options:option_regenerate', 'custom:x']);
    assert.equal(css, '#extensionsMenu #send_picture{display:none!important}\n#options a#option_regenerate{display:none!important}');
    assert.equal(buildHideRules([]), '');
    assert.equal(buildHideRules(undefined), '');
});

// --- sanitizeIcon / validateCustomTool ---

test('sanitizeIcon keeps only fa-* tokens', () => {
    assert.equal(sanitizeIcon('fa-solid fa-wand-magic-sparkles'), 'fa-solid fa-wand-magic-sparkles');
    assert.equal(sanitizeIcon('alert(1) fa-solid fa-x onclick=1'), 'fa-solid fa-x');
    assert.equal(sanitizeIcon(''), '');
    assert.equal(sanitizeIcon(null), '');
    assert.equal(sanitizeIcon('fa-lg fa-fw fa-solid fa-repeat'), 'fa-lg fa-fw fa-solid fa-repeat');
});

test('validateCustomTool accepts and normalizes', () => {
    const result = validateCustomTool({ label: '  Hi  ', icon: 'junk fa-solid fa-star', script: ' /help ' });
    assert.equal(result.ok, true);
    assert.equal(result.tool.label, 'Hi');
    assert.equal(result.tool.icon, 'fa-solid fa-star');
    assert.equal(result.tool.script, '/help');
    assert.ok(result.tool.id.length > 0);
});

test('validateCustomTool keeps a provided id (update path)', () => {
    const result = validateCustomTool({ id: 'keep1', label: 'L', script: '/x' });
    assert.equal(result.ok, true);
    assert.equal(result.tool.id, 'keep1');
});

test('validateCustomTool defaults the icon', () => {
    const result = validateCustomTool({ label: 'L', script: '/x' });
    assert.equal(result.tool.icon, 'fa-solid fa-toolbox');
});

test('validateCustomTool rejects empty label/script', () => {
    assert.equal(validateCustomTool({ label: '  ', script: '/x' }).ok, false);
    assert.equal(validateCustomTool({ label: 'L', script: '', selector: '' }).ok, false);
    assert.equal(validateCustomTool(null).ok, false);
});

test('validateCustomTool accepts selector-only tools and rejects both', () => {
    const result = validateCustomTool({ label: 'MQS', script: '', selector: '#mqs_open_button' });
    assert.equal(result.ok, true);
    assert.equal(result.tool.selector, '#mqs_open_button');
    assert.equal(result.tool.script, '');
    assert.equal(validateCustomTool({ label: 'L', script: '/x', selector: '#y' }).ok, false);
    assert.equal(validateCustomTool({ label: 'L', selector: '   ' }).ok, false);
});

// --- genId / constants ---

test('genId produces non-empty ids and varies', () => {
    const a = genId();
    const b = genId();
    assert.ok(a.length > 0);
    assert.notEqual(a, b);
});

test('core hidden items are documented', () => {
    assert.ok(OPTIONS_SKIP.has('option_settings'));
    assert.ok(DUPLICATE_OPTION_IDS.has('option_close_chat'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}
