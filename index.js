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

const { NgModule } = require('@angular/core')
const { CommonModule } = require('@angular/common')
const { AppService, ConfigService, LogService } = require('tabby-core')

const DEFAULTS = {
    enabled: true,
    delayMs: 2000,
    types: ['ssh', 'telnet', 'serial'],
    initialSize: { columns: 80, rows: 24 },
    markActivity: true,
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function readOptions (config) {
    const raw = (config.store && config.store.connectAll) || {}
    return {
        enabled: raw.enabled !== false,
        delayMs: typeof raw.delayMs === 'number' && raw.delayMs >= 0 ? raw.delayMs : DEFAULTS.delayMs,
        types: Array.isArray(raw.types) && raw.types.length ? raw.types : DEFAULTS.types,
        initialSize: raw.initialSize || DEFAULTS.initialSize,
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

NgModule({ imports: [CommonModule] })(ConnectAllModule)

module.exports = ConnectAllModule
module.exports.default = ConnectAllModule
module.exports.ConnectAllModule = ConnectAllModule
