// Toolbox — one floating toolbox that re-homes tools out of SillyTavern's two
// expandable menus.
//
// The settings control ("resorting") lets every discovered entry of the
// hamburger options menu (#options) and the wand menu (#extensionsMenu) move
// into the toolbox and out of its menu, and back again:
//   - checked   → tool is hidden in its source menu (a persistent !important
//                 stylesheet rule; the element stays in the DOM, so core keeps
//                 treating it exactly like its own "hidden but executable"
//                 items, e.g. #option_settings) and appears in the toolbox.
//   - unchecked → rule removed, tool is back in its menu.
// Executing a re-homed tool dispatches a click on the hidden original
// (mirroring what core's slash commands do), so behavior is identical.
//
// The toolbox opens from a floating, draggable button (Megumin-Suite-style),
// whose position persists in the extension settings. Custom tools — user
// defined label + FontAwesome icon + stscript — are toolbox-only buttons that
// never touch any menu.
//
// Tools whose menu entry core shows/hides contextually (Save checkpoint,
// Back to parent chat, Convert to group, TTS…) are offered by the toolbox
// only while their original entry is currently visible, mirroring the menu.

import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    animation_duration,
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../script.js';
import { executeSlashCommands } from '../../../../scripts/slash-commands.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../../scripts/popup.js';
import { loadMovingUIState } from '../../../../scripts/power-user.js';
import { dragElement } from '../../../../scripts/RossAscends-mods.js';
import { delay, escapeHtml } from '../../../../scripts/utils.js';
import {
    DUPLICATE_OPTION_IDS,
    OPTIONS_SKIP,
    buildHideRules,
    keyToString,
    mergeDefaults,
    normalizeOrder,
    sanitizeIcon,
    stringToKey,
    validateCustomTool,
} from './src/registry.js';

// `$` (jQuery) is a page-level global provided by SillyTavern.

const MODULE_NAME = 'toolbox';

// The folder name the extension actually lives in (used for the template path).
const folderName = decodeURIComponent(
    new URL(import.meta.url).pathname.split('/').filter(Boolean).slice(-2, -1)[0],
);
const extensionFolderPath = `third-party/${folderName}`;

const settings = mergeDefaults(extension_settings[MODULE_NAME]);
extension_settings[MODULE_NAME] = settings;

let panelElement = null;
let fabElement = null;
let hideStyleEl = null;
let settingsBlock = null;
let wandObserver = null;
let editingCustomId = null;

// id -> { label, icon } discovered from the live menus at render time.
const discovered = {
    options: new Map(),
    wand: new Map(),
};

function toast(kind, message) {
    if (typeof toastr === 'function') {
        toastr[kind]?.(message, 'Toolbox');
    } else {
        console.log(`[Toolbox] ${kind}: ${message}`);
    }
}

// --- catalogs / keys ---

function knownKeys() {
    return [
        ...settings.tools.options.map(id => keyToString('options', id)),
        ...settings.tools.wand.map(id => keyToString('wand', id)),
        ...settings.tools.custom.map(tool => keyToString('custom', tool.id)),
    ].filter(Boolean);
}

// --- discovery ---

// Strips size/utility classes, keeps only fa-* tokens for reuse in our icons.
function iconClassOf($el) {
    const iconEl = $el.find('[class*="fa-"]').first();
    if (!iconEl.length) {
        return '';
    }
    const cls = String(iconEl.attr('class') ?? '');
    const skip = /^(fa-(?:lg|fw|xs|sm|xl|2xs|2xl|2x|3x|4x|5x))$/;
    const tokens = cls.split(/\s+/).filter(token => token.startsWith('fa-') && !skip.test(token));
    return tokens.join(' ');
}

function discoverOptions() {
    $('#options a[id]').each(function () {
        const id = String(this.id);
        if (OPTIONS_SKIP.has(id)) {
            return;
        }
        const $el = $(this);
        const label = $el.find('span[data-i18n]').first().text().trim() || $el.text().trim() || id;
        discovered.options.set(id, {
            label,
            icon: iconClassOf($el) || 'fa-solid fa-bars',
        });
    });
}

function discoverWand() {
    $('#extensionsMenu .list-group-item[id]').each(function () {
        const id = String(this.id);
        if (!/^[A-Za-z0-9_-]+$/.test(id)) {
            return;
        }
        const $el = $(this);
        const label = $el.find('span').first().text().trim() || String($el.attr('title') ?? '') || id;
        discovered.wand.set(id, {
            label,
            icon: iconClassOf($el) || 'fa-solid fa-puzzle-piece',
        });
    });
}

// Adds newly discovered tools to the catalogs (membership is never expanded).
function syncDiscovered() {
    let changed = false;
    for (const id of discovered.options.keys()) {
        if (!settings.tools.options.includes(id)) {
            settings.tools.options.push(id);
            changed = true;
        }
    }
    for (const id of discovered.wand.keys()) {
        if (!settings.tools.wand.includes(id)) {
            settings.tools.wand.push(id);
            changed = true;
        }
    }
    if (changed) {
        const { order } = normalizeOrder(settings.inToolbox, knownKeys());
        settings.inToolbox = order;
        saveSettingsDebounced();
    }
}

// Third-party extensions append their wand entries after our init; keep the
// catalogs current. Re-homing rules persist through enable/disable cycles.
function watchWandMenu() {
    if (wandObserver) {
        return;
    }
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        return;
    }
    wandObserver = new MutationObserver(() => {
        try {
            discoverWand();
            syncDiscovered();
            refreshSettingsRows();
        } catch (error) {
            console.error('[Toolbox] wand menu observer error', error);
        }
    });
    wandObserver.observe(menu, { childList: true, subtree: true });
}

// --- re-homing rules ---

function applyHideRules() {
    if (!hideStyleEl) {
        hideStyleEl = document.createElement('style');
        hideStyleEl.id = 'toolbox-hide-rules';
        document.head.appendChild(hideStyleEl);
    }
    hideStyleEl.textContent = buildHideRules(settings.inToolbox);
}

function isSourceItemVisible(source, id) {
    try {
        if (source === 'options') {
            const items = document.querySelectorAll(`#options a#${id}`);
            return Array.from(items).some(el => window.getComputedStyle(el).display !== 'none');
        }
        if (source === 'wand') {
            const el = document.getElementById(id);
            return Boolean(el) && window.getComputedStyle(el).display !== 'none';
        }
    } catch (error) {
        console.error(`[Toolbox] visibility check failed for ${source}:${id}`, error);
    }
    return false;
}

// --- execution ---

async function runCustomTool(tool) {
    try {
        await executeSlashCommands(tool.script);
    } catch (error) {
        console.error(`[Toolbox] custom tool "${tool.label}" failed`, error);
        toast('error', `Custom tool "${tool.label}" failed — see console.`);
    }
}

function executeTool(key) {
    const parsed = stringToKey(key);
    if (!parsed) {
        return;
    }
    if (parsed.source === 'options') {
        // Duplicate-id items: trigger the visible copy (same handler either way).
        const $el = DUPLICATE_OPTION_IDS.has(parsed.id)
            ? $(`#options a#${parsed.id}`).last()
            : $(`#${parsed.id}`);
        if ($el.length) {
            $el.trigger('click', { fromSlashCommand: true });
        } else {
            toast('warning', `"${parsed.id}" is not available right now.`);
        }
    } else if (parsed.source === 'wand') {
        const el = document.getElementById(parsed.id);
        if (el) {
            $(el).trigger('click');
        } else {
            toast('warning', `"${parsed.id}" is not available right now.`);
        }
    } else {
        const tool = settings.tools.custom.find(candidate => candidate.id === parsed.id);
        if (tool) {
            void runCustomTool(tool);
        }
    }
    if (settings.closeOnExecute) {
        hidePanel();
    }
}

// --- toolbox panel ---

function toolMeta(parsed) {
    if (!parsed) {
        return { label: '(invalid tool)', icon: 'fa-solid fa-circle-question' };
    }
    if (parsed.source === 'custom') {
        const tool = settings.tools.custom.find(candidate => candidate.id === parsed.id);
        return tool
            ? { label: tool.label, icon: tool.icon }
            : { label: '(missing tool)', icon: 'fa-solid fa-circle-question' };
    }
    const meta = (parsed.source === 'options' ? discovered.options : discovered.wand).get(parsed.id);
    return meta ?? { label: parsed.id, icon: 'fa-solid fa-circle-question' };
}

// Toolbox mirrors the source menu: context-dependent entries are only offered
// while their original menu item is currently visible.
function toolViewModel(parsed) {
    if (!parsed) {
        return null;
    }
    const key = keyToString(parsed.source, parsed.id);
    if (!key) {
        return null;
    }
    if (parsed.source === 'custom') {
        const tool = settings.tools.custom.find(candidate => candidate.id === parsed.id);
        if (!tool) {
            return null;
        }
        return { key, label: tool.label, icon: tool.icon, title: `${tool.label} (custom tool)` };
    }
    const meta = (parsed.source === 'options' ? discovered.options : discovered.wand).get(parsed.id);
    if (!meta || !isSourceItemVisible(parsed.source, parsed.id)) {
        return null;
    }
    const where = parsed.source === 'options' ? 'hamburger menu' : 'wand menu';
    return { key, label: meta.label, icon: meta.icon, title: `${meta.label} (from ${where})` };
}

function toolButtonHtml(vm) {
    // Keys are "source:safe-id" (ids validated at discovery/parse time).
    return `
    <div class="tb-tool" data-key="${vm.key}" title="${escapeHtml(vm.title)}">
        <div class="tb-tool-icon ${vm.icon}"></div>
        <div class="tb-tool-label">${escapeHtml(vm.label)}</div>
    </div>`;
}

function refreshPanel() {
    if (!panelElement) {
        return;
    }
    const models = settings.inToolbox
        .map(key => toolViewModel(stringToKey(key)))
        .filter(Boolean);
    panelElement.find('#tbGrid').html(models.map(toolButtonHtml).join(''));
    panelElement.find('#tbEmpty').toggleClass('tb-hidden', models.length > 0);
    panelElement.find('#tbGrid').toggleClass('tb-hidden', models.length === 0);
}

function openToolboxSettings() {
    try {
        const content = document.getElementById('rm_extensions_block');
        if (content && !content.classList.contains('openDrawer')) {
            $('#extensions-settings-button .drawer-toggle').first().trigger('click');
        }
        window.setTimeout(() => {
            document.getElementById('toolbox-settings-block')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }, 400);
    } catch (error) {
        console.error('[Toolbox] failed to open the extensions drawer', error);
    }
}

function wirePanel() {
    const panel = panelElement;
    panel.find('#tbClose').on('click', hidePanel);
    panel.find('#tbMinimize').on('click', () => panel.toggleClass('tb-minimized'));
    panel.find('#tbOpenSettings').on('click', openToolboxSettings);
    // Delegated — the grid is re-rendered wholesale.
    panel.on('click', '.tb-tool', function () {
        executeTool(String($(this).data('key')));
    });
}

async function buildPanel() {
    if (panelElement) {
        return;
    }
    const template = await renderExtensionTemplateAsync(extensionFolderPath, 'panel');
    panelElement = $(template);
    $('#movingDivs').append(panelElement);
    wirePanel();
    loadMovingUIState();
    dragElement(panelElement);
    refreshPanel();
}

function showPanel() {
    if (!panelElement) {
        return;
    }
    refreshPanel();
    if (panelElement.css('display') !== 'flex') {
        panelElement.addClass('resizing');
        panelElement.css('display', 'flex');
        panelElement.css('opacity', 0);
        panelElement.transition({
            opacity: 1.0,
            duration: animation_duration,
        }, async function () {
            await delay(50);
            panelElement.removeClass('resizing');
        });
    }
}

function hidePanel() {
    if (!panelElement || panelElement.css('display') === 'none') {
        return;
    }
    panelElement.transition({ opacity: 0, duration: animation_duration }, async function () {
        panelElement.css('display', 'none');
        await delay(50);
    });
}

function togglePanel() {
    if (!panelElement) {
        return;
    }
    if (panelElement.css('display') === 'none') {
        showPanel();
    } else {
        hidePanel();
    }
}

// --- floating opener button ---

function clampFab(x, y) {
    const width = fabElement?.outerWidth() || 48;
    const height = fabElement?.outerHeight() || 48;
    const maxX = Math.max(0, window.innerWidth - width);
    const maxY = Math.max(0, window.innerHeight - height);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
}

function setFabPosition(x, y, persist = false) {
    if (!fabElement) {
        return;
    }
    const { x: cx, y: cy } = clampFab(x, y);
    fabElement.css({ left: `${cx}px`, top: `${cy}px`, right: 'auto' });
    if (persist) {
        settings.fab = { x: cx, y: cy };
        saveSettingsDebounced();
    }
}

function currentFabPosition() {
    const el = fabElement?.[0];
    if (!el) {
        return { x: 0, y: 0 };
    }
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
}

function restoreFabPosition() {
    if (!fabElement) {
        return;
    }
    if (Number.isFinite(settings.fab?.x) && Number.isFinite(settings.fab?.y)) {
        setFabPosition(settings.fab.x, settings.fab.y);
    } else {
        // Default anchor: top-right corner.
        fabElement.css({ left: 'auto', top: '60px', right: '20px' });
    }
}

function wireFab() {
    const el = fabElement[0];
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origin = { x: 0, y: 0 };

    const onDown = event => {
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }
        dragging = true;
        moved = false;
        startX = event.clientX;
        startY = event.clientY;
        origin = currentFabPosition();
        el.setPointerCapture?.(event.pointerId);
    };

    const onMove = event => {
        if (!dragging) {
            return;
        }
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!moved && Math.hypot(dx, dy) > 5) {
            moved = true;
            fabElement.addClass('tb-fab-dragging');
        }
        if (moved) {
            setFabPosition(origin.x + dx, origin.y + dy);
            event.preventDefault();
        }
    };

    const onUp = () => {
        if (!dragging) {
            return;
        }
        dragging = false;
        fabElement.removeClass('tb-fab-dragging');
        if (moved) {
            const { x, y } = currentFabPosition();
            setFabPosition(x, y, true);
        } else {
            togglePanel();
        }
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', () => {
        dragging = false;
        fabElement.removeClass('tb-fab-dragging');
    });
}

function buildFab() {
    $('#toolbox-fab').remove();
    fabElement = null;
    if (!settings.showFab) {
        return;
    }
    fabElement = $('<div id="toolbox-fab" class="fa-solid fa-toolbox" title="Open Toolbox"></div>');
    $('body').append(fabElement);
    restoreFabPosition();
    wireFab();
}

function wireFabResizeGuard() {
    window.addEventListener('resize', () => {
        if (!fabElement) {
            return;
        }
        // Keep the button on screen without moving the user's saved anchor.
        const { x, y } = currentFabPosition();
        setFabPosition(x, y);
    });
}

// --- settings drawer ---

function sourceRowHtml(source, id) {
    const meta = (source === 'options' ? discovered.options : discovered.wand).get(id);
    const key = keyToString(source, id);
    if (!key) {
        return '';
    }
    const inToolbox = settings.inToolbox.includes(key);
    const missing = !meta;
    const label = meta?.label ?? id;
    const icon = meta?.icon ?? 'fa-solid fa-circle-question';
    const where = source === 'options' ? 'hamburger menu' : 'wand menu';
    const title = `${where}${missing ? ' — currently missing (extension disabled or removed?)' : ''}`;
    return `
    <label class="tb-row${missing ? ' tb-row-missing' : ''}" title="${escapeHtml(title)}">
        <input type="checkbox" class="tb-row-toggle" data-key="${key}" ${inToolbox ? 'checked' : ''}>
        <span class="tb-row-icon ${icon}"></span>
        <span class="tb-row-label">${escapeHtml(label)}</span>
        ${missing ? '<span class="tb-missing-tag">missing</span>' : ''}
    </label>`;
}

function customRowHtml(tool) {
    return `
    <div class="tb-custom-list-row" data-id="${tool.id}">
        <span class="tb-row-icon ${tool.icon}"></span>
        <span class="tb-row-label">${escapeHtml(tool.label)}</span>
        <div class="menu_button tb-mini-btn tb-custom-edit" title="Edit"><i class="fa-solid fa-pen"></i></div>
        <div class="menu_button tb-mini-btn tb-custom-delete" title="Delete"><i class="fa-solid fa-trash"></i></div>
    </div>`;
}

function orderRowHtml(key) {
    const parsed = stringToKey(key);
    const meta = toolMeta(parsed);
    return `
    <div class="tb-order-row" data-key="${key}">
        <span class="tb-row-icon ${meta.icon}"></span>
        <span class="tb-order-label">${escapeHtml(meta.label)}</span>
        <div class="tb-order-btns">
            <div class="menu_button tb-order-up" title="Move up"><i class="fa-solid fa-arrow-up"></i></div>
            <div class="menu_button tb-order-down" title="Move down"><i class="fa-solid fa-arrow-down"></i></div>
        </div>
    </div>`;
}

function refreshSettingsRows() {
    if (!settingsBlock) {
        return;
    }
    settingsBlock.find('#tbOptionsList').html(
        settings.tools.options.map(id => sourceRowHtml('options', id)).join('') || '<div class="tb-hint">Nothing discovered yet.</div>',
    );
    settingsBlock.find('#tbWandList').html(
        settings.tools.wand.map(id => sourceRowHtml('wand', id)).join('') || '<div class="tb-hint">Nothing discovered yet.</div>',
    );
    settingsBlock.find('#tbCustomList').html(
        settings.tools.custom.map(customRowHtml).join('') || '<div class="tb-hint">No custom tools yet.</div>',
    );
    settingsBlock.find('#tbOrderList').html(
        settings.inToolbox.map(orderRowHtml).join('') || '<div class="tb-hint">The toolbox is empty.</div>',
    );
    settingsBlock.find('#tb_show_fab').prop('checked', settings.showFab);
    settingsBlock.find('#tb_close_on_execute').prop('checked', settings.closeOnExecute);
}

function persistAndApply() {
    saveSettingsDebounced();
    applyHideRules();
    refreshPanel();
    refreshSettingsRows();
}

function setInToolbox(key, add) {
    const index = settings.inToolbox.indexOf(key);
    if (add && index === -1) {
        settings.inToolbox.push(key);
    } else if (!add && index !== -1) {
        settings.inToolbox.splice(index, 1);
    } else {
        return;
    }
    persistAndApply();
}

function moveKey(key, delta) {
    const list = settings.inToolbox;
    const index = list.indexOf(key);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= list.length) {
        return;
    }
    list.splice(target, 0, list.splice(index, 1)[0]);
    persistAndApply();
}

function clearCustomForm() {
    editingCustomId = null;
    settingsBlock.find('#tbCustomLabel').val('');
    settingsBlock.find('#tbCustomIcon').val('');
    settingsBlock.find('#tbCustomScript').val('');
    settingsBlock.find('#tbCustomIconPreview').attr('class', 'fa-solid fa-toolbox');
    settingsBlock.find('#tbCustomSaveLabel').text('Add tool');
    settingsBlock.find('#tbCustomCancel').addClass('tb-hidden');
}

function loadCustomIntoForm(tool) {
    editingCustomId = tool.id;
    settingsBlock.find('#tbCustomLabel').val(tool.label);
    settingsBlock.find('#tbCustomIcon').val(tool.icon);
    settingsBlock.find('#tbCustomScript').val(tool.script);
    settingsBlock.find('#tbCustomIconPreview').attr('class', tool.icon);
    settingsBlock.find('#tbCustomSaveLabel').text('Save tool');
    settingsBlock.find('#tbCustomCancel').removeClass('tb-hidden');
}

async function deleteCustomTool(toolId) {
    const tool = settings.tools.custom.find(candidate => candidate.id === toolId);
    if (!tool) {
        return;
    }
    const confirmed = await callGenericPopup(`Delete custom tool "${tool.label}"?`, POPUP_TYPE.CONFIRM);
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }
    settings.tools.custom = settings.tools.custom.filter(candidate => candidate.id !== toolId);
    const key = keyToString('custom', toolId);
    const index = settings.inToolbox.indexOf(key);
    if (index !== -1) {
        settings.inToolbox.splice(index, 1);
    }
    if (editingCustomId === toolId) {
        clearCustomForm();
    }
    persistAndApply();
}

function saveCustomTool() {
    const input = {
        id: editingCustomId ?? undefined,
        label: String(settingsBlock.find('#tbCustomLabel').val() ?? ''),
        icon: String(settingsBlock.find('#tbCustomIcon').val() ?? ''),
        script: String(settingsBlock.find('#tbCustomScript').val() ?? ''),
    };
    const result = validateCustomTool(input);
    if (!result.ok) {
        toast('warning', result.error);
        return;
    }
    const tool = result.tool;
    const existing = settings.tools.custom.find(candidate => candidate.id === tool.id);
    if (existing) {
        Object.assign(existing, tool);
    } else {
        settings.tools.custom.push(tool);
    }
    clearCustomForm();
    persistAndApply();
}

function addSettingsPanel() {
    const html = `
    <div id="toolbox-settings-block" class="toolbox-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Toolbox</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="tb_show_fab">
                    <input id="tb_show_fab" type="checkbox">
                    <span>Show the floating toolbox button</span>
                </label>
                <div id="tb_reset_fab" class="menu_button">
                    <i class="fa-solid fa-crosshairs fa-fw"></i>
                    <span>Reset button position</span>
                </div>
                <label class="checkbox_label" for="tb_close_on_execute">
                    <input id="tb_close_on_execute" type="checkbox">
                    <span>Close the toolbox after using a tool</span>
                </label>
                <div class="tb-section">
                    <div class="tb-section-title">Hamburger menu</div>
                    <div class="tb-hint">Checked tools move out of the ☰ menu into the toolbox; unchecked tools return to the menu.</div>
                    <div id="tbOptionsList"></div>
                </div>
                <div class="tb-section">
                    <div class="tb-section-title">Wand menu</div>
                    <div class="tb-hint">Checked tools move out of the ✨ menu into the toolbox. Note: when every wand entry is re-homed, ST hides the wand button itself.</div>
                    <div id="tbWandList"></div>
                </div>
                <div class="tb-section">
                    <div class="tb-section-title">Custom tools</div>
                    <div class="tb-hint">Toolbox-only buttons that run slash commands. Plugin actions that register commands can be driven from here.</div>
                    <div id="tbCustomList"></div>
                    <div class="tb-custom-form">
                        <label for="tbCustomLabel">Label</label>
                        <input id="tbCustomLabel" class="text_pole" type="text" placeholder="My tool">
                        <label for="tbCustomIcon">Icon (FontAwesome classes)</label>
                        <div class="tb-icon-line">
                            <input id="tbCustomIcon" class="text_pole" type="text" placeholder="fa-solid fa-wand-magic-sparkles">
                            <i id="tbCustomIconPreview" class="fa-solid fa-toolbox"></i>
                        </div>
                        <label for="tbCustomScript">Script (slash commands)</label>
                        <textarea id="tbCustomScript" class="text_pole" rows="3" placeholder="/help"></textarea>
                        <div class="tb-custom-actions">
                            <div id="tbCustomSave" class="menu_button">
                                <i class="fa-solid fa-check fa-fw"></i>
                                <span id="tbCustomSaveLabel">Add tool</span>
                            </div>
                            <div id="tbCustomCancel" class="menu_button tb-hidden">
                                <i class="fa-solid fa-xmark fa-fw"></i>
                                <span>Cancel</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="tb-section">
                    <div class="tb-section-title">Toolbox contents</div>
                    <div class="tb-hint">Order of the tools inside the toolbox.</div>
                    <div id="tbOrderList"></div>
                </div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);
    settingsBlock = $('#toolbox-settings-block');
    wireSettings();
    refreshSettingsRows();
}

function wireSettings() {
    settingsBlock.find('#tb_show_fab').on('change', function () {
        settings.showFab = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        buildFab();
    });
    settingsBlock.find('#tb_reset_fab').on('click', () => {
        settings.fab = { x: null, y: null };
        saveSettingsDebounced();
        buildFab();
        toast('success', 'Toolbox button position reset.');
    });
    settingsBlock.find('#tb_close_on_execute').on('change', function () {
        settings.closeOnExecute = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
    });

    settingsBlock.on('change', '.tb-row-toggle', function () {
        setInToolbox(String($(this).data('key')), Boolean(this.checked));
    });
    settingsBlock.on('click', '.tb-order-up', function () {
        moveKey(String($(this).closest('.tb-order-row').data('key')), -1);
    });
    settingsBlock.on('click', '.tb-order-down', function () {
        moveKey(String($(this).closest('.tb-order-row').data('key')), 1);
    });
    settingsBlock.on('click', '.tb-custom-edit', function () {
        const id = String($(this).closest('.tb-custom-list-row').data('id'));
        const tool = settings.tools.custom.find(candidate => candidate.id === id);
        if (tool) {
            loadCustomIntoForm(tool);
        }
    });
    settingsBlock.on('click', '.tb-custom-delete', function () {
        void deleteCustomTool(String($(this).closest('.tb-custom-list-row').data('id')));
    });
    settingsBlock.find('#tbCustomIcon').on('input', function () {
        const icon = sanitizeIcon(String($(this).val() ?? '')) || 'fa-solid fa-toolbox';
        settingsBlock.find('#tbCustomIconPreview').attr('class', icon);
    });
    settingsBlock.find('#tbCustomSave').on('click', saveCustomTool);
    settingsBlock.find('#tbCustomCancel').on('click', clearCustomForm);
}

// --- init ---

function onAppReady() {
    try {
        discoverOptions();
        discoverWand();
        syncDiscovered();
        applyHideRules();
        refreshSettingsRows();
        void buildPanel();
        watchWandMenu();
        const registered = knownKeys().length;
        const rehomed = settings.inToolbox.filter(key => stringToKey(key)?.source !== 'custom').length;
        console.log(`[Toolbox] ready — ${registered} tools registered, ${settings.inToolbox.length} in toolbox, ${rehomed} re-homed from menus`);
    } catch (error) {
        console.error('[Toolbox] init failed', error);
    }
}

function onChatChanged() {
    // Context-dependent tools change availability; the panel refreshes lazily
    // on the next open anyway, so skip work while it is hidden.
    if (panelElement && panelElement.css('display') !== 'none') {
        refreshPanel();
    }
}

jQuery(async () => {
    // Hide re-homed entries before APP_READY so they never flash in the menus.
    applyHideRules();
    addSettingsPanel();
    buildFab();
    wireFabResizeGuard();
    eventSource.on(event_types.APP_READY, onAppReady);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    console.log('[Toolbox] module loaded, waiting for APP_READY');
});
