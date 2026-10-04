/*
 * Offline harness for tabby-connect-all.
 *
 * Stubs @angular/core, @angular/common and tabby-core so index.js can be loaded
 * outside Tabby, then drives the module constructor with fake services and fake
 * tabs to verify: tab collection, type filtering, concurrency, the PTY-size
 * seed, the failure path, and the consume-once arming of initializeSession().
 */
'use strict'

const assert = require('assert')
const Module = require('module')

const NgModule = meta => cls => { cls.__ngModuleMeta = meta; return cls }
const Component = meta => cls => { cls.__componentMeta = meta; return cls }

class StubConfigProvider {
    constructor () {
        this.platformDefaults = {}
    }
}
class StubSettingsTabProvider {
    constructor () {
        this.weight = 0
        this.prioritized = false
    }
    getComponentType () { return null }
}
class StubTabbyCoreModule {}

const stubs = {
    '@angular/core': { NgModule, Component },
    '@angular/common': { CommonModule: class CommonModule {} },
    '@angular/forms': { FormsModule: class FormsModule {} },
    'tabby-settings': { SettingsTabProvider: StubSettingsTabProvider },
    'tabby-core': {
        AppService: class AppService {},
        ConfigService: class ConfigService {},
        LogService: class LogService {},
        ConfigProvider: StubConfigProvider,
        default: StubTabbyCoreModule,
    },
}

const originalLoad = Module._load
Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) {
        return stubs[request]
    }
    return originalLoad.apply(this, arguments)
}

const ConnectAllModule = require('../index.js')
const ConnectAllSettingsTabComponent = ConnectAllModule.ConnectAllSettingsTabComponent

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeTab ({ type, open = false, fail = false, delay = 30, hasSession = false, savedState = null }) {
    const tab = {
        profile: { type },
        session: hasSession ? { open: true } : null,
        savedState,
        frontendWrites: [],
        frontend: {
            write (data) { tab.frontendWrites.push(data) },
        },
        initializeCalls: 0,
        startedAt: null,
        activityMarked: false,
        displayActivity () { this.activityMarked = true },
        async initializeSession () {
            this.initializeCalls++
            this.startedAt = this.startedAt ?? Date.now()
            await sleep(delay)
            if (fail) {
                throw new Error('boom')
            }
            this.session = { open: true }
        },
    }
    return tab
}

async function main () {
    // --- plugin shape (what Tabby's plugin loader expects) -------------------
    const meta = ConnectAllModule.__ngModuleMeta
    assert.ok(meta, 'NgModule() must have been applied')
    assert.strictEqual(require('../index.js').default, ConnectAllModule, 'loader reads module.default')
    assert.ok(
        Array.isArray(ConnectAllModule.parameters) && ConnectAllModule.parameters.length === 3,
        'design:paramtypes must be declared for Angular DI',
    )

    // --- settings tab registration ------------------------------------------
    assert.ok(
        meta.declarations.includes(ConnectAllSettingsTabComponent),
        'the settings component must be declared so resolveComponentFactory() can build it',
    )
    const configProviderEntry = meta.providers.find(p => p.provide === StubConfigProvider)
    assert.ok(configProviderEntry?.multi, 'ConfigProvider must be registered as a multi provider')
    const tabProviderEntry = meta.providers.find(p => p.provide === StubSettingsTabProvider)
    assert.ok(tabProviderEntry?.multi, 'SettingsTabProvider must be registered as a multi provider')
    assert.ok(meta.imports.includes(StubTabbyCoreModule), 'TabbyCoreModule must be imported for <toggle>')

    const tabProvider = new tabProviderEntry.useClass()
    assert.strictEqual(tabProvider.getComponentType(), ConnectAllSettingsTabComponent)
    assert.strictEqual(tabProvider.id, 'connect-all')
    assert.strictEqual(tabProvider.title, 'Connect All')

    // config defaults provider
    const defaults = new configProviderEntry.useClass().defaults
    assert.strictEqual(defaults.connectAll.enabled, true)
    assert.strictEqual(defaults.connectAll.delayMs, 2000)
    assert.deepStrictEqual(defaults.connectAll.types, ['ssh', 'telnet', 'serial'])
    assert.strictEqual(defaults.connectAll.markActivity, true)

    // component metadata: inline template, no build step
    assert.ok(ConnectAllSettingsTabComponent.__componentMeta?.template.includes('connectAll'))
    assert.ok(ConnectAllSettingsTabComponent.__componentMeta.template.includes('<toggle'))
    assert.ok(
        Array.isArray(ConnectAllSettingsTabComponent.parameters) &&
        ConnectAllSettingsTabComponent.parameters.length === 1,
        'the settings component needs design:paramtypes too',
    )

    // --- settings component behaviour ---------------------------------------
    let saves = 0
    const store = {
        connectAll: {
            enabled: true,
            delayMs: 2000,
            types: ['ssh', 'telnet', 'serial'],
            markActivity: true,
            initialSize: { columns: 80, rows: 24 },
        },
    }
    const settings = new ConnectAllSettingsTabComponent({ store, save: () => saves++ })

    assert.strictEqual(settings.hasType('ssh'), true)
    assert.strictEqual(settings.hasType('local'), false)
    settings.toggleType('local', true)
    assert.deepStrictEqual(store.connectAll.types, ['ssh', 'telnet', 'serial', 'local'])
    assert.strictEqual(saves, 1, 'toggling must persist')
    settings.toggleType('telnet', false)
    assert.deepStrictEqual(store.connectAll.types, ['ssh', 'serial', 'local'], 'order stays canonical')
    settings.reset()
    assert.strictEqual(saves, 3, 'reset must persist')
    assert.deepStrictEqual(store.connectAll.types, ['ssh', 'telnet', 'serial'])
    assert.strictEqual(store.connectAll.delayMs, 2000)

    // --- fake services -----------------------------------------------------
    const logs = []
    const log = { create: name => ({ info: (...a) => logs.push(['info', name, ...a]), error: (...a) => logs.push(['error', name, ...a]) }) }

    const sshA = makeTab({ type: 'ssh', savedState: 'OLD-SCROLLBACK' })
    const sshB = makeTab({ type: 'ssh', delay: 60 })
    const sshConnected = makeTab({ type: 'ssh', hasSession: true })
    const sshFailing = makeTab({ type: 'ssh', fail: true, savedState: 'OLD-SCROLLBACK' })
    const localTab = makeTab({ type: 'local' })

    const splitChildren = [makeTab({ type: 'ssh' }), makeTab({ type: 'telnet' })]
    const splitContainer = { getAllTabs: () => splitChildren }

    const app = { tabs: [sshA, sshB, sshConnected, sshFailing, localTab, splitContainer] }
    const config = {
        store: { connectAll: { delayMs: 0 } },
        ready$: { toPromise: async () => undefined },
    }

    const started = Date.now()
    new ConnectAllModule(app, config, log)

    await sleep(400)

    // --- assertions --------------------------------------------------------
    assert.strictEqual(sshA.session?.open, true, 'sshA should be connected')
    assert.strictEqual(sshB.session?.open, true, 'sshB should be connected')
    assert.strictEqual(splitChildren[0].session?.open, true, 'split child ssh should be connected')
    assert.strictEqual(splitChildren[1].session?.open, true, 'split child telnet should be connected')
    assert.strictEqual(localTab.initializeCalls, 0, 'local tab must be untouched by default')
    assert.strictEqual(sshConnected.initializeCalls, 0, 'already-connected tab must be skipped')
    assert.strictEqual(sshFailing.session, null, 'failing tab stays disconnected')

    // concurrency: every target must have been kicked off before any resolved
    assert.strictEqual(sshA.initializeCalls, 1)
    assert.strictEqual(sshB.initializeCalls, 1)
    const starts = [sshA, sshB, sshFailing, ...splitChildren].map(t => t.startedAt)
    assert.ok(starts.every(Boolean), 'every target must have started')
    const spread = Math.max(...starts) - Math.min(...starts)
    assert.ok(spread < 20, `expected all sessions to start together, spread was ${spread}ms`)

    // PTY size seed (needed so SSHTabComponent does not fail after opening the shell)
    assert.deepStrictEqual(sshA.size, { columns: 80, rows: 24 }, 'size should be seeded')

    // saved scrollback is flushed up front so it stays *before* the live output
    assert.deepStrictEqual(sshA.frontendWrites, ['OLD-SCROLLBACK'], 'scrollback should be pre-written')
    assert.strictEqual(sshA.savedState, null, 'savedState must be cleared after the pre-write')
    assert.deepStrictEqual(sshFailing.frontendWrites, ['OLD-SCROLLBACK'], 'scrollback survives a failed connect')
    assert.deepStrictEqual(sshB.frontendWrites, [], 'no savedState -> no frontend write')

    // consume-once arming: the activation-time call is swallowed, the next one goes through
    await sshA.initializeSession()
    assert.strictEqual(sshA.initializeCalls, 1, 'activation call must be swallowed')
    await sshA.initializeSession()
    assert.strictEqual(sshA.initializeCalls, 2, 'a later reconnect must still go through')

    // the failing tab must stay un-armed so activating it retries normally
    assert.strictEqual(sshFailing.__connectAllArmed, undefined)

    // tab-header activity marker: only for sessions that actually came up
    assert.strictEqual(sshA.activityMarked, true, 'connected tab must show the activity marker')
    assert.strictEqual(sshB.activityMarked, true, 'connected tab must show the activity marker')
    assert.strictEqual(splitChildren[0].activityMarked, true, 'split child must be marked too')
    assert.strictEqual(splitChildren[1].activityMarked, true, 'split child must be marked too')
    assert.strictEqual(sshFailing.activityMarked, false, 'a failed connect must not claim activity')
    assert.strictEqual(localTab.activityMarked, false, 'untouched tabs stay unmarked')
    assert.strictEqual(sshConnected.activityMarked, false, 'already-connected tabs are left alone')

    // --- the size is in character cells; out-of-range input must not reach the PTY
    assert.ok(
        ConnectAllSettingsTabComponent.__componentMeta.template.includes('character cells'),
        'the settings label must state the unit',
    )
    assert.ok(
        ConnectAllSettingsTabComponent.__componentMeta.template.includes('Initial terminal columns') &&
        ConnectAllSettingsTabComponent.__componentMeta.template.includes('Initial terminal rows'),
        'columns and rows must each have their own labelled row',
    )
    // Regression guard: two inputs inside one .input-group rendered as a black block
    // separator with no visible text in Tabby's theme. Tabby's own settings tabs put a
    // single `input.form-control` directly under `.form-line`, and so do we.
    assert.ok(
        !ConnectAllSettingsTabComponent.__componentMeta.template.includes('input-group'),
        'do not use .input-group in a settings tab',
    )
    assert.strictEqual(
        (ConnectAllSettingsTabComponent.__componentMeta.template.match(/<input[^>]*options\.initialSize\.(?:columns|rows)[^>]*>/g) || [])
            .filter(tag => tag.includes('class="form-control"')).length,
        2,
        'both size fields must be plain .form-control inputs',
    )

    const clampTab = makeTab({ type: 'ssh' })
    new ConnectAllModule(
        { tabs: [clampTab] },
        {
            store: { connectAll: { delayMs: 0, initialSize: { columns: 0, rows: 99999 } } },
            ready$: { toPromise: async () => undefined },
        },
        log,
    )
    await sleep(200)
    assert.deepStrictEqual(
        clampTab.size,
        { columns: 80, rows: 500 },
        'columns=0 falls back to the default, rows=99999 clamps to the max',
    )

    const missingSizeTab = makeTab({ type: 'ssh' })
    new ConnectAllModule(
        { tabs: [missingSizeTab] },
        {
            store: { connectAll: { delayMs: 0, initialSize: { columns: 'wide', rows: null } } },
            ready$: { toPromise: async () => undefined },
        },
        log,
    )
    await sleep(200)
    assert.deepStrictEqual(missingSizeTab.size, { columns: 80, rows: 24 }, 'non-numeric sizes fall back')

    const summary = logs.find(l => typeof l[2] === 'string' && l[2].startsWith('connected '))
    assert.ok(summary, 'expected a summary log line')
    assert.ok(summary[2].includes('4/6'), `summary should count 4 of 6, got: ${summary[2]}`)

    console.log('summary log :', summary[2])
    console.log('counts      :', JSON.stringify(summary[3]))
    console.log('start spread:', spread + 'ms (all 4 kicked off together)')
    console.log('\nALL CHECKS PASSED')
}

main().catch(error => {
    console.error('FAILED:', error.message)
    process.exit(1)
})
