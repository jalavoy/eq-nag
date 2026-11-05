// Checks the overlay window on a throwaway profile: that it builds its overlays,
// and that script from a shared trigger can't run in it.
//
//   node tests/e2e/overlay.test.cjs [--exe <path>]
const path = require( 'path' );
const { check, finish, abort } = require( '../lib/report.cjs' );
const { exePath, createWorkFolder, start, stop, sleep } = require( './lib/app.cjs' );
const { createProfile, timerOverlayId } = require( './lib/fixtures.cjs' );

const work = createWorkFolder();

( async () => {
    const { profile } = createProfile( path.join( work.folder, 'overlay' ) );
    const app = await start( exePath( process.argv.slice( 2 ) ), profile );
    const { renderer: r, combat, rendererErrors: errors } = app;
    try {
        await r.send( 'Page.enable' );
        await r.send( 'Page.reload', {} );
        await sleep( 5000 );

        const count = await r.eval( `document.querySelectorAll( '.overlay-container' ).length` );
        check( 'The overlay page builds its overlays', count >= 2, count );
        check( 'The combat window renders', await r.eval( `!!document.querySelector( '.window.dps-meter' )` ) );
        check( 'The Font Awesome config applies', await r.eval( `window.FontAwesomeConfig?.autoReplaceSvg === false` ) );
        check( 'The Font Awesome script loads', await r.eval( `!!window.FontAwesome` ) );

        const send = component => combat.eval( `( () => { const c = ${JSON.stringify( component )}; c.timestamp = new Date(); require( 'electron' ).ipcRenderer.send( 'overlay:send:component', c ); return true; } )()` );
        const timer = ( id, duration ) => ( { instanceId: id, triggerId: 't', triggerName: 'test', overlayId: timerOverlayId, matches: [], action: { actionId: id, actionType: 3, showDuration: true, duration, displayText: id, timerColor: '#008000', hideTimer: false } } );

        await send( timer( 'SAFE_TIMER', 90 ) );
        await sleep( 300 );
        const shown = await r.eval( `( () => { const s = [ ...document.querySelectorAll( 'span.time-remaining' ) ].find( e => e.parentElement.textContent.includes( 'SAFE_TIMER' ) ); return s ? s.textContent : null; } )()` );
        check( 'A normal timer shows its time', /\d/.test( shown ?? '' ), JSON.stringify( shown ) );

        await send( timer( 'EVIL_TIMER', '<img src=x onerror="window.__pwned=1">' ) );
        await sleep( 3000 );
        check( 'A malicious duration does not run script', !await r.eval( `window.__pwned === 1` ) );
        check( 'A malicious duration does not create an element', !await r.eval( `!!document.querySelector( 'span.time-remaining img' ) || !!document.querySelector( 'img[src="x"]' )` ) );

        // The second layer: script injected by any other route is blocked.
        await r.eval( `( () => { const d = document.createElement( 'div' ); d.innerHTML = '<img src="nope.png" onerror="window.__inline=1">'; document.body.appendChild( d ); const s = document.createElement( 'script' ); s.textContent = 'window.__script=1'; document.body.appendChild( s ); return true; } )()` );
        await sleep( 1500 );
        check( 'The page policy blocks inline event handlers', !await r.eval( `window.__inline === 1` ) );
        check( 'The page policy blocks inline script', !await r.eval( `window.__script === 1` ) );

        await r.eval( `document.querySelector( '#encounterRecordBtn' ).click()` );
        await sleep( 300 );
        check( 'The record button toggles on', await r.eval( `document.querySelector( '#encounterRecordBtn' ).classList.contains( 'record-enabled' )` ) );
        await r.eval( `document.querySelector( '#encounterRecordBtn' ).click()` );
        await sleep( 300 );
        check( 'The record button toggles off', !await r.eval( `document.querySelector( '#encounterRecordBtn' ).classList.contains( 'record-enabled' )` ) );
        const before = errors.length;
        await r.eval( `document.querySelector( '.show-combat-settings' ).click()` );
        await sleep( 1000 );
        check( 'The settings button runs without an error', errors.length === before, errors.slice( before ).join( ' | ' ).slice( 0, 200 ) );

        const unique = [ ...new Set( errors ) ];
        const unexpected = unique.filter( e => !/nope\.png|ERR_FILE_NOT_FOUND|inline|Content Security Policy|app-update/i.test( e ) );
        const blocked = unique.filter( e => /Content Security Policy/i.test( e ) && !/inline event|inline script/i.test( e ) );
        check( 'No unexpected errors in the overlay page', unexpected.length === 0, unexpected.join( ' | ' ).slice( 0, 500 ) );
        check( 'The page policy blocks nothing the app needs', blocked.length === 0, blocked.join( ' | ' ).slice( 0, 500 ) );
    } finally {
        await stop( app );
    }
    work.remove();
    finish();
} )().catch( error => {
    console.log( `Logs from this run are in ${work.folder}` );
    abort( error );
} );
