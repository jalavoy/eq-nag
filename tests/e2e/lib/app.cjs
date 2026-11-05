// Starts a packaged build on a throwaway profile and connects to its windows.
const { spawn } = require( 'child_process' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );

// tools/perf/cdp.mjs uses the WebSocket built into Node 22. CI builds on Node 18.
const ws = require( 'ws' );
globalThis.WebSocket ??= ws.WebSocket ?? ws;

const root = path.resolve( __dirname, '../../..' );
const devToolsPort = 9336;
const inspectPort = 9337;
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

/** The build to test: --exe <path>, or the output of electron-builder's dir target. */
function exePath( args ) {
    const i = args.indexOf( '--exe' );
    const exe = i > -1 ? args[ i + 1 ] : path.join( root, 'electron', 'output', 'win-unpacked', 'EQ Nag.exe' );
    if ( !fs.existsSync( exe ) ) {
        throw new Error( `No build at ${exe}. See tests/README.md for how to build one.` );
    }
    return exe;
}

/** Returns the arguments that aren't --exe <path>. */
function otherArgs( args ) {
    const i = args.indexOf( '--exe' );
    return i > -1 ? args.filter( ( _, n ) => n !== i && n !== i + 1 ) : args;
}

/** Creates a temporary folder for this run, and a function that removes it. */
function createWorkFolder() {
    const folder = fs.mkdtempSync( path.join( os.tmpdir(), 'nag-e2e-' ) );
    return { folder, remove: () => fs.rmSync( folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 } ) };
}

/**
 * Connects to a window, or to the main process.
 *
 * @param {{webSocketDebuggerUrl: string}} target The target to connect to.
 * @param {string[]} [errors] Receives errors the target reports.
 */
async function open( target, errors ) {
    const { connect } = await import( '../../../tools/perf/cdp.mjs' );
    const cdp = await connect( target );
    if ( errors ) {
        cdp.ws.addEventListener( 'message', event => {
            const m = JSON.parse( event.data );
            if ( m.method === 'Runtime.exceptionThrown' ) errors.push( m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text );
            else if ( m.method === 'Log.entryAdded' && m.params.entry.level === 'error' ) errors.push( m.params.entry.text );
            else if ( m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error' ) errors.push( m.params.args.map( a => a.value ?? a.description ).join( ' ' ) );
        } );
        await cdp.send( 'Log.enable' );
    }
    await cdp.send( 'Runtime.enable' );
    return {
        send: cdp.send,
        close: cdp.close,
        eval: async ( expression, timeout = 15000 ) => {
            const r = await Promise.race( [
                cdp.send( 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true } ),
                sleep( timeout ).then( () => ( { timedOut: true } ) ),
            ] );
            if ( r.timedOut ) throw new Error( `Timed out evaluating: ${expression.slice( 0, 80 )}` );
            if ( r.result.exceptionDetails ) throw new Error( r.result.exceptionDetails.exception?.description ?? 'evaluate failed' );
            return r.result.result.value;
        },
    };
}

/**
 * Starts the app and waits for its windows.
 *
 * @param {string} exe The build to run.
 * @param {string} profile The throwaway profile folder.
 */
async function start( exe, profile ) {
    const { targets } = await import( '../../../tools/perf/cdp.mjs' );
    const child = spawn( exe, [ `--user-data-dir=${profile}`, `--remote-debugging-port=${devToolsPort}`, `--inspect=${inspectPort}` ], { stdio: 'ignore' } );
    const pages = async () => ( await targets( devToolsPort ) ).filter( t => t.type === 'page' );
    const app = { child, pages, profile };

    let renderer, main, combat;
    for ( let i = 0; i < 60 && !( renderer && main && combat ); i++ ) {
        await sleep( 1000 );
        try {
            const all = await pages();
            renderer = all.find( t => /renderer\.html/.test( t.url ) );
            main = all.find( t => /#\/dashboard/.test( t.url ) );
            combat = all.find( t => /combat-watcher\.html/.test( t.url ) );
        } catch { }
    }
    if ( !( renderer && main && combat ) ) {
        await stop( app );
        throw new Error( `The app's windows didn't start. See ${path.join( profile, 'logs', 'main.log' )}` );
    }
    app.rendererErrors = [];
    app.renderer = await open( renderer, app.rendererErrors );
    app.ui = await open( main );
    app.combat = await open( combat );
    app.node = await open( ( await targets( inspectPort ) )[ 0 ] );

    /** Runs code in the main process, where `electron` and `dialog` are available. */
    app.main = code => app.node.eval( `( async () => { const electron = process.mainModule ? process.mainModule.require( 'electron' ) : require( 'electron' ); const { dialog } = electron; ${code} } )()` );
    await sleep( 2500 );
    return app;
}

/** Ends the app. On Windows this has to end the whole process tree. */
async function stop( app ) {
    for ( const c of [ app.renderer, app.ui, app.combat, app.node ] ) {
        try { c?.close(); } catch { }
    }
    spawn( 'taskkill', [ '/PID', String( app.child.pid ), '/T', '/F' ], { stdio: 'ignore' } );
    await sleep( 2500 );
}

module.exports = { exePath, otherArgs, createWorkFolder, open, start, stop, sleep };
