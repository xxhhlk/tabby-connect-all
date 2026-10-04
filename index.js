/*
 * tabby-connect-all — connect every restored session in the background on startup.
 *
 * Why this is needed:
 *   tabby-terminal/src/api/baseTerminalTab.component.ts does, right after the tab
 *   is created:
 *
 *       setImmediate(async () => {
 *           if (this.hasFocus) {
 *               await this.frontend?.attach(...)          // -> resize -> onFrontendReady -> initializeSession()
 *           } else {
 *               this.focused$.pipe(first()).subscribe(async () => {
 *                   await this.frontend?.attach(...)      // only when the tab is activated
 *               })
 *           }
 *       })
 *
 *   So a restored tab only connects once it has been activated. There is no
 *   setting for this (and no plugin in the registry does it), hence this plugin.
 *
 * What it does:
 *   After the tab-recovery pass finishes, it walks app.tabs (including tabs inside
 *   split containers) and calls initializeSession() on each not-yet-connected
 *   connectable session, all at once. Output produced while the tab is in the
 *   background is buffered by Tabby itself (BaseSession.initialDataBuffer) and
 *   flushed the moment the tab is activated, so nothing is lost.
 */
'use strict'

const { NgModule, Component } = require('@angular/core')
const { CommonModule } = require('@angular/common')
const { FormsModule } = require('@angular/forms')
const tabbyCore = require('tabby-core')
const { AppService, ConfigService, LogService, ConfigProvider } = tabbyCore
const TabbyCoreModule = tabbyCore.default

// tabby-settings is a builtin plugin, but stay loadable without it: the settings
// tab is a nicety, the connection pass is the point.
let SettingsTabProvider = null
try {
    SettingsTabProvider = require('tabby-settings').SettingsTabProvider
} catch (e) { /* settings UI unavailable */ }

const DEFAULTS = {
    enabled: true,
    delayMs: 2000,
    types: ['ssh', 'telnet', 'serial'],
    initialSize: { columns: 80, rows: 24 },
    markActivity: true,
}

/** Order also drives the order of the checkboxes in the settings tab. */
const SESSION_TYPES = [
    { id: 'ssh', label: 'SSH' },
    { id: 'telnet', label: 'Telnet' },
    { id: 'serial', label: 'Serial' },
    { id: 'local', label: 'Local shells' },
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Terminal sizes are in character cells; a 0 here would break the remote PTY. */
const SIZE_LIMITS = { columns: [20, 1000], rows: [5, 500] }

function readSize (raw) {
    const out = {}
    for (const key of ['columns', 'rows']) {
        const [min, max] = SIZE_LIMITS[key]
        const value = Math.round(Number(raw && raw[key]))
        out[key] = Number.isFinite(value) && value >= min
            ? Math.min(value, max)
            : DEFAULTS.initialSize[key]
    }
    return out
}

function readOptions (config) {
    const raw = (config.store && config.store.connectAll) || {}
    return {
        enabled: raw.enabled !== false,
        delayMs: typeof raw.delayMs === 'number' && raw.delayMs >= 0 ? raw.delayMs : DEFAULTS.delayMs,
        types: Array.isArray(raw.types) && raw.types.length ? raw.types : DEFAULTS.types,
        initialSize: readSize(raw.initialSize),
        markActivity: raw.markActivity !== false,
    }
}

/** app.tabs holds SplitTabComponent containers too — flatten them. */
function collectTabs (app) {
    const out = []
    for (const tab of (app.tabs || [])) {
        let children = null
        if (tab && typeof tab.getAllTabs === 'function') {
            try {
                children = tab.getAllTabs()
            } catch (e) {
                children = null
            }
        }
        if (Array.isArray(children) && children.length) {
            out.push(...children)
        } else {
            out.push(tab)
        }
    }
    return out
}

async function connectTab (tab, options) {
    const profile = tab.profile
    if (!profile || !options.types.includes(profile.type)) {
        return 'skipped'
    }
    if (tab.session) {
        return 'already-connected'
    }
    if (typeof tab.initializeSession !== 'function') {
        return 'skipped'
    }

    // The PTY size is normally learned from the terminal frontend. A background
    // tab has no attached frontend yet, so `this.size` is still undefined and
    // SSHTabComponent would blow up on `this.size.columns` *after* opening the
    // shell channel — then retry with a second connection. Seed it instead.
    if (!tab.size) {
        tab.size = { columns: options.initialSize.columns, rows: options.initialSize.rows }
    }

    // Flush the saved scrollback now. Tabby would otherwise append it in
    // onFrontendReady() — i.e. *after* the "Connecting to <host>" line this call
    // prints and after the live output, which reverses the order you see when
    // connecting from an active tab. Writing it up front keeps the stock order:
    // history -> Connecting -> live output.
    if (tab.savedState && tab.frontend) {
        try {
            tab.frontend.write(tab.savedState)
            tab.savedState = null
        } catch (e) { /* keep the state if the frontend refuses it */ }
    }

    // Consume exactly one initializeSession() call — the one Tabby makes when the
    // tab is first activated. Without this, activating the tab would open a second
    // connection and orphan the one created here.
    const original = tab.initializeSession
    tab.initializeSession = async function () {
        if (this.__connectAllArmed) {
            this.__connectAllArmed = false
            return
        }
        return original.call(this)
    }

    await original.call(tab)

    if (tab.session && tab.session.open) {
        tab.__connectAllArmed = true

        // Light up the tab header's activity marker (the 2px line at the bottom of
        // the tab, .activity-indicator in tabHeader.component.scss).
        //
        // Tabby only ever calls displayActivity() from binaryOutput$, and a
        // background session's output is held in BaseSession.initialDataBuffer
        // until releaseInitialDataBuffer() runs on the first onFrontendReady() —
        // so a tab connected here would otherwise stay unmarked until the user
        // happens to click it. Marking it is also semantically right: the session
        // *has* produced output (banner, prompt) that the user has not looked at.
        // It clears on its own when the tab gets focused (AppService calls
        // clearActivity()), or via the tab context menu.
        if (options.markActivity && typeof tab.displayActivity === 'function') {
            try {
                tab.displayActivity()
            } catch (e) { /* marker is cosmetic */ }
        }
        return 'connected'
    }
    return 'failed'
}

/**
 * Registers the defaults so `connectAll` shows up in the config file and is always
 * populated for the settings tab. Structural merge semantics mean a user's own
 * values always win over these.
 */
class ConnectAllConfigProvider extends ConfigProvider {
    constructor () {
        super()
        this.defaults = {
            connectAll: {
                enabled: DEFAULTS.enabled,
                delayMs: DEFAULTS.delayMs,
                types: DEFAULTS.types.slice(),
                markActivity: DEFAULTS.markActivity,
                initialSize: { ...DEFAULTS.initialSize },
            },
        }
        this.platformDefaults = {}
    }
}

/** Settings → Connect All */
class ConnectAllSettingsTabComponent {
    constructor (config) {
        this.config = config
        this.sessionTypes = SESSION_TYPES
    }

    get options () {
        return this.config.store.connectAll
    }

    save () {
        this.config.save()
    }

    hasType (id) {
        return this.options.types.includes(id)
    }

    toggleType (id, enabled) {
        const next = new Set(this.options.types)
        if (enabled) {
            next.add(id)
        } else {
            next.delete(id)
        }
        // keep SESSION_TYPES order so the stored array is stable
        this.options.types = SESSION_TYPES.map(t => t.id).filter(x => next.has(x))
        this.save()
    }

    reset () {
        this.options.enabled = DEFAULTS.enabled
        this.options.delayMs = DEFAULTS.delayMs
        this.options.types = DEFAULTS.types.slice()
        this.options.markActivity = DEFAULTS.markActivity
        this.options.initialSize = { ...DEFAULTS.initialSize }
        this.save()
    }
}

const SETTINGS_PARAMTYPES = [ConfigService]
try {
    if (typeof Reflect !== 'undefined' && typeof Reflect.defineMetadata === 'function') {
        Reflect.defineMetadata('design:paramtypes', SETTINGS_PARAMTYPES, ConnectAllSettingsTabComponent)
    }
} catch (e) { /* metadata is best-effort */ }
ConnectAllSettingsTabComponent.parameters = SETTINGS_PARAMTYPES

Component({
    selector: 'connect-all-settings-tab',
    styles: ['.session-types { display: flex; flex-wrap: wrap; gap: 4px 16px; }'],
    template: `
        <h3 class="mb-3">Connect All</h3>

        <div class="form-line">
            <div class="header">
                <div class="title">Connect all sessions on startup</div>
                <div class="description">
                    After Tabby restores your tabs, connect every session in the background instead of
                    waiting for each tab to be activated.
                </div>
            </div>
            <toggle [(ngModel)]="options.enabled" (ngModelChange)="save()"></toggle>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Delay</div>
                <div class="description">
                    Milliseconds to wait after the tabs are restored before connecting. Raise it if you
                    have many sessions behind a slow bastion.
                </div>
            </div>
            <input type="number" class="form-control" min="0" step="250"
                   [(ngModel)]="options.delayMs" (ngModelChange)="save()">
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Session types</div>
                <div class="description">Which kinds of restored sessions to connect in the background.</div>
            </div>
            <div class="session-types">
                <div class="form-check" *ngFor="let type of sessionTypes">
                    <input class="form-check-input" type="checkbox"
                           [id]="'connect-all-' + type.id"
                           [checked]="hasType(type.id)"
                           (change)="toggleType(type.id, $event.target.checked)">
                    <label class="form-check-label" [for]="'connect-all-' + type.id">{{type.label}}</label>
                </div>
            </div>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Mark connected tabs</div>
                <div class="description">
                    Light up the activity marker — the line at the bottom of the tab — on the sessions
                    that came up.
                </div>
            </div>
            <toggle [(ngModel)]="options.markActivity" (ngModelChange)="save()"></toggle>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="title">Initial terminal size (columns x rows, in character cells)</div>
                <div class="description">
                    PTY size used until you open the tab and a real resize arrives. This is a
                    character grid, not pixels. To see what a session is really using, run
                    <code>stty size</code> in it — it prints <b>rows first</b>.
                </div>
            </div>
            <div class="input-group">
                <input type="number" class="form-control" min="20" max="1000"
                       placeholder="columns" title="columns (characters)"
                       [(ngModel)]="options.initialSize.columns" (ngModelChange)="save()">
                <span class="input-group-text">x</span>
                <input type="number" class="form-control" min="5" max="500"
                       placeholder="rows" title="rows (characters)"
                       [(ngModel)]="options.initialSize.rows" (ngModelChange)="save()">
            </div>
        </div>

        <div class="form-line">
            <div class="header">
                <div class="description">
                    The same values can be edited by hand under <code>connectAll</code> in the config file.
                </div>
            </div>
            <button class="btn btn-secondary" (click)="reset()">Reset to defaults</button>
        </div>
    `,
})(ConnectAllSettingsTabComponent)

class ConnectAllSettingsTabProvider extends SettingsTabProvider {
    constructor () {
        super()
        this.id = 'connect-all'
        this.icon = 'plug'
        this.title = 'Connect All'
    }

    getComponentType () {
        return ConnectAllSettingsTabComponent
    }
}

class ConnectAllModule {
    constructor (app, config, log) {
        const logger = log.create('connect-all')

        config.ready$.toPromise().then(async () => {
            const options = readOptions(config)
            if (!options.enabled) {
                logger.info('disabled by config')
                return
            }

            // AppService recovers the tabs from its own config.ready$ callback;
            // give that pass a chance to land before we look at app.tabs.
            for (let i = 0; i < 40 && !app.tabs.length; i++) {
                await sleep(250)
            }
            await sleep(options.delayMs)

            const targets = collectTabs(app)
                .filter(tab => tab && tab.profile && options.types.includes(tab.profile.type))
            if (!targets.length) {
                logger.info('nothing to connect')
                return
            }

            const started = Date.now()
            const results = await Promise.allSettled(targets.map(tab => connectTab(tab, options)))

            const counts = {}
            for (const result of results) {
                const key = result.status === 'fulfilled' ? result.value : 'error'
                counts[key] = (counts[key] || 0) + 1
            }
            logger.info(
                `connected ${counts['connected'] || 0}/${targets.length} session(s) ` +
                `in ${Date.now() - started}ms`,
                counts,
            )
        }).catch(error => logger.error('startup pass failed', error))
    }
}

// Angular DI reads constructor metadata; without a TypeScript build we declare it
// by hand. Both shapes are checked by Angular's ReflectionCapabilities.
const PARAMTYPES = [AppService, ConfigService, LogService]
try {
    if (typeof Reflect !== 'undefined' && typeof Reflect.defineMetadata === 'function') {
        Reflect.defineMetadata('design:paramtypes', PARAMTYPES, ConnectAllModule)
    }
} catch (e) { /* metadata is best-effort */ }
ConnectAllModule.parameters = PARAMTYPES

const imports = [CommonModule, FormsModule]
if (TabbyCoreModule) {
    // brings in <toggle>, the translate pipe and the CDK drop directives that
    // Tabby's own settings tabs use
    imports.push(TabbyCoreModule)
}

const providers = [
    { provide: ConfigProvider, useClass: ConnectAllConfigProvider, multi: true },
]
if (SettingsTabProvider) {
    providers.push({ provide: SettingsTabProvider, useClass: ConnectAllSettingsTabProvider, multi: true })
}

NgModule({
    imports,
    declarations: [ConnectAllSettingsTabComponent],
    providers,
})(ConnectAllModule)

module.exports = ConnectAllModule
module.exports.default = ConnectAllModule
module.exports.ConnectAllModule = ConnectAllModule
module.exports.ConnectAllSettingsTabComponent = ConnectAllSettingsTabComponent
