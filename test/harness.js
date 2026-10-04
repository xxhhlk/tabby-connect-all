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

const stubs = {
    '@angular/core': { NgModule },
    '@angular/common': { CommonModule: class CommonModule {} },
    'tabby-core': {
        AppService: class AppService {},
        ConfigService: class ConfigService {},
        LogService: class LogService {},
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
    assert.ok(ConnectAllModule.__ngModuleMeta, 'NgModule() must have been applied')
    assert.strictEqual(require('../index.js').default, ConnectAllModule, 'loader reads module.default')
    assert.ok(
        Array.isArray(ConnectAllModule.parameters) && ConnectAllModule.parameters.length === 3,
        'design:paramtypes must be declared for Angular DI',
    )

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
