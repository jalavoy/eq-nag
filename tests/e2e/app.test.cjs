// Drives a packaged build on throwaway profiles with made-up data.
//
//   node tests/e2e/app.test.cjs [--exe <path>] [group ...]
//
// Groups: triggers, saving, settingsCleanup, generators, damagedFile, importFolders
const fs = require( 'fs' );
const path = require( 'path' );
const { check, finish, abort } = require( '../lib/report.cjs' );
const { exePath, otherArgs, createWorkFolder, open, start, stop, sleep } = require( './lib/app.cjs' );
const { createProfile, customTimerBackground, markerCount } = require( './lib/fixtures.cjs' );
const ui = require( './lib/ui.cjs' );

const args = process.argv.slice( 2 );
const work = createWorkFolder();
const readJson = file => JSON.parse( fs.readFileSync( file, 'utf-8' ) );

// --== Log lines and overlays ==--
const stamp = () => {
    const d = new Date();
    return `[${d.toDateString().slice( 0, 10 )} ${d.toTimeString().slice( 0, 8 )} ${d.getFullYear()}]`;
};
const writeLine = ( log, text ) => fs.appendFileSync( log, `${stamp()} ${text}\r\n` );
const logWatcher = async app => ( await app.pages() ).find( t => /log-watcher\.html/.test( t.url ) );
const isShown = ( app, marker ) => app.renderer.eval( `document.body.textContent.includes( 'SHOWN_${marker}_X' )` );
const waitShown = async ( app, marker, ms ) => {
    for ( let t = 0; t < ms; t += 500 ) {
        if ( await isShown( app, marker ) ) return true;
        await sleep( 500 );
    }
    return false;
};
const waitWatcher = async ( app, wanted, ms ) => {
    for ( let t = 0; t < ms; t += 1000 ) {
        const w = await logWatcher( app );
        if ( wanted( w ) ) return w;
        await sleep( 1000 );
    }
    return undefined;
};

const tests = {
    /** Triggers firing, stored variables, and hang protection. Takes about 5 minutes. */
    async triggers() {
        const { profile, log } = createProfile( path.join( work.folder, 'triggers' ) );
        const app = await start( exePath( args ), profile );
        try {
            await app.main( `global.__boxes = []; dialog.showMessageBox = async o => { global.__boxes.push( o ); return { response: 0 }; }; return true;` );
            writeLine( log, 'hello' );
            const first = await waitWatcher( app, w => !!w, 20000 );
            check( 'Log watcher starts for the test character', !!first );
            await sleep( 3000 );
            writeLine( log, 'MARKER1' );
            check( 'A trigger fires and shows on an overlay', await waitShown( app, 1, 10000 ) );

            const overlays = readJson( path.join( profile, 'overlays-database.json' ) ).overlays;
            check( 'Overlay background color survives launch', overlays.some( o => o.timerBackgroundColor === customTimerBackground ) );

            const store = ( keys, value ) => app.combat.eval( `( () => { require( 'electron' ).ipcRenderer.send( 'settings:set:persistent-storage-value', ${JSON.stringify( { keys, value } )} ); return true; } )()` );
            await store( [ 'x', '__proto__', 'polluted' ], 'yes' );
            await store( [ 'y', 'constructor', 'prototype', 'polluted2' ], 'yes' );
            await store( [ 'Scores', 'Tester' ], '42' );
            await store( [ 'Scores', 'Other', 'Deep' ], '7' );
            await sleep( 800 );
            check( 'Stored variable names cannot pollute prototypes', !await app.node.eval( `( {} ).polluted === 'yes' || ( {} ).polluted2 === 'yes'` ) );
            const stored = readJson( path.join( profile, 'user-preferences.json' ) ).persistentStorage;
            check( 'Normal stored variables still save', stored?.Scores?.Tester === '42' && stored?.Scores?.Other?.Deep === '7', JSON.stringify( stored ) );

            // The safe regex engine can run this one.
            const started = Date.now();
            writeLine( log, `${'a'.repeat( 45 )}!` );
            await sleep( 2500 );
            writeLine( log, 'MARKER2' );
            check( 'A slow pattern does not stall the watcher', await waitShown( app, 2, 12000 ), `${Date.now() - started} ms` );
            check( 'The same watcher is still running', ( await logWatcher( app ) )?.id === first.id );

            // Only the watchdog can stop this one.
            for ( let round = 1; round <= 3; round++ ) {
                const before = await logWatcher( app );
                writeLine( log, `${'c'.repeat( 45 )}!` );
                const t0 = Date.now();
                await waitWatcher( app, w => !w || w.id !== before.id, 75000 );
                const now = await logWatcher( app );
                check( `Watchdog ends a hung watcher (round ${round})`, !now || now.id !== before.id, `${Math.round( ( Date.now() - t0 ) / 1000 )}s` );
                await sleep( 6000 );
                if ( round < 3 ) {
                    writeLine( log, `MARKER${round + 2}` );
                    const back = await waitWatcher( app, w => !!w, 15000 );
                    check( `Triggers restart after a hang (round ${round})`, !!back && await waitShown( app, round + 2, 15000 ) );
                    await sleep( 2000 );
                }
            }
            writeLine( log, `MARKER${markerCount}` );
            await sleep( 12000 );
            check( 'After 3 hangs the watcher stays off', !await logWatcher( app ) );
            check( 'Triggers do not fire while it is off', !await isShown( app, markerCount ) );
            const boxes = await app.node.eval( `JSON.stringify( global.__boxes )` );
            check( 'The user is told, and the slow trigger is named', /turned off/.test( boxes ) && /slowHang/.test( boxes ), boxes.slice( 0, 200 ) );
            check( 'The app itself stays responsive', await app.ui.eval( `1 + 1` ) === 2 );
        } finally { await stop( app ); }
    },

    /** Moving the window, and quitting with a save pending. */
    async saving() {
        const { profile } = createProfile( path.join( work.folder, 'saving' ) );
        const prefs = () => readJson( path.join( profile, 'user-preferences.json' ) ).windowBounds;
        const app = await start( exePath( args ), profile );
        try {
            await sleep( 2000 );
            const mainWindow = `electron.BrowserWindow.getAllWindows().find( w => /dashboard|index\\.html/.test( w.webContents.getURL() ) )`;
            const x0 = prefs().x;
            await app.main( `const w = ${mainWindow}; const b = w.getBounds(); for ( let i = 1; i <= 40; i++ ) { w.setPosition( b.x + i, b.y ); await new Promise( r => setTimeout( r, 15 ) ); } global.__x = w.getBounds().x; return true;` );
            const during = prefs().x;
            await sleep( 1200 );
            const wanted = await app.node.eval( `global.__x` );
            check( 'The window position is not saved while moving', during === x0, `${during} vs ${x0}` );
            check( 'The window position saves once it stops', prefs().x === wanted, `${prefs().x} vs ${wanted}` );
            const mainLog = fs.readFileSync( path.join( profile, 'logs', 'main.log' ), 'utf-8' );
            check( 'GINA is not searched for at launch', !/gina path/i.test( mainLog ) );
            check( 'Test runs do not check for updates', !/Checking for update/i.test( mainLog ) );

            await app.main( `const w = ${mainWindow}; w.setPosition( w.getBounds().x + 7, w.getBounds().y ); global.__x2 = w.getBounds().x; return true;` );
            const x2 = await app.node.eval( `global.__x2` );
            app.main( `electron.app.quit(); return true;` ).catch( () => { } );
            await sleep( 4000 );
            check( 'A pending position is saved on quit', prefs().x === x2, `${prefs().x} vs ${x2}` );
        } finally { await stop( app ); }
    },

    /** The settings for quick share codes and author profiles are removed. */
    async settingsCleanup() {
        const { profile } = createProfile( path.join( work.folder, 'settings' ) );
        const file = path.join( profile, 'user-preferences.json' );
        const old = readJson( file );
        Object.assign( old, { version: 11, glowOnStartup: true, masterVolume: 37, enableQuickShareImports: true, quickShareAuthorsList: [ 'Someone' ], quickShareAuthorsListType: 1, author: { authorId: 'x', name: 'Old', discord: 'old#1' } } );
        fs.writeFileSync( file, JSON.stringify( old ) );
        const app = await start( exePath( args ), profile );
        try {
            await sleep( 2000 );
            const now = readJson( file );
            const left = [ 'enableQuickShareImports', 'quickShareAuthorsList', 'quickShareAuthorsListType', 'author' ].filter( k => k in now );
            check( 'Old settings are removed from the file', left.length === 0, left.join() );
            check( 'Settings are on version 12 or newer', now.version >= 12, now.version );
            check( 'Other settings are kept', now.masterVolume === 37 && now.everquestInstallFolder === old.everquestInstallFolder );
            const channels = await app.main( `return [ 'settings:get:author', 'settings:set:author', 'settings:get:quickShareImports', 'settings:set:quickShareImports', 'settings:get:quickShareAuthorsList', 'settings:set:quickShareAuthorsListType' ].filter( c => electron.ipcMain.listenerCount( c ) > 0 );` );
            check( 'Old settings channels are gone', channels.length === 0, channels.join() );
            check( 'The share file install channel is still there', await app.main( `return electron.ipcMain.listenerCount( 'quickShare:install' );` ) === 1 );
            check( 'The main window has content', await app.ui.eval( `document.querySelector( 'app-root' ) != null && document.body.innerText.length > 0` ) );
        } finally { await stop( app ); }
    },

    /** The DoT and buff generators, and re-importing, with a fake spell. Contacts no websites. */
    async generators() {
        const { profile } = createProfile( path.join( work.folder, 'generators' ) );
        const dbFile = path.join( profile, 'trigger-database.json' );
        const db = readJson( dbFile );
        const imported = ( id, importType, externalSource, url ) => ( { triggerId: id, name: id, folderId: 'folderGen0000001', enabled: true, captureMethod: 'Any match', conditions: [], classLevels: [], sequentialRestartBehavior: 'none', capturePhrases: [ { phraseId: `p${id}`, phrase: 'x', useRegEx: false } ], actions: [], importType, externalSource, allakhazamUrl: url } );
        const zam = 'https://everquest.allakhazam.com/db/spell.html?spell=1';
        const eqsr = 'https://spells.eqresource.com/spells.php?id=1';
        db.folders.push( { folderId: 'folderGen0000001', name: 'GENFOLDER', children: [] } );
        db.triggers.push( imported( 'zamDot', 1, 'ZAM', zam ), imported( 'zamBuff', 4, 'ZAM', zam ), imported( 'zamAbility', 2, 'ZAM', zam ), imported( 'eqsrAbility', 2, 'EQSR', eqsr ), imported( 'eqsrDot', 1, 'EQSR', eqsr ) );
        fs.writeFileSync( dbFile, JSON.stringify( db ) );

        const app = await start( exePath( args ), profile );
        const openEditor = async id => {
            await app.ui.eval( `window.api.ipc.send( 'trigger:dialog:edit', ${JSON.stringify( id )} )` );
            let target;
            for ( let i = 0; i < 20 && !target; i++ ) {
                await sleep( 500 );
                target = ( await app.pages() ).find( t => t.url.includes( `#/trigger/${id}` ) );
            }
            const page = await open( target );
            await sleep( 2000 );
            return page;
        };
        const hasReimport = page => ui.hasButton( page, '/Re-import from/' );
        try {
            await app.main( `const { ipcMain } = electron;
                global.__scraped = 0;
                ipcMain.removeHandler( 'scraper:get:eqsr-spell' );
                ipcMain.handle( 'scraper:get:eqsr-spell', async () => {
                    global.__scraped++;
                    return { name: 'Fake Spell', duration: 60, classes: [], castOnOther: 'target is burned.', castOnYou: 'You are burned.', youCast: 'You burn target.', gemIndex: -1, gemSrc: null, targetType: 'Single', castTime: 0, effectFades: 'The burn fades.', itemsWithEffect: [], itemClickOnly: false };
                } );
                global.__zam = 0;
                electron.session.defaultSession.webRequest.onBeforeRequest( { urls: [ '*://*.allakhazam.com/*' ] }, ( d, cb ) => { global.__zam++; cb( { cancel: true } ); } );
                return true;` );

            await ui.openTab( app.ui, 'Triggers' );
            await sleep( 800 );
            await ui.selectFolder( app.ui, 'GENFOLDER' );
            await sleep( 400 );

            // The DoT generator, all the way to a saved trigger.
            await ui.openGenerator( app.ui, 'DoT Timer' );
            check( 'The DoT generator opens for EQ Spell Resources', /Import DoT Timer \(EQ Spell Resources\)/.test( await ui.dialogText( app.ui ) ) );
            const url = 'https://spells.eqresource.com/spells.php?id=1447';
            await ui.typeInDialog( app.ui, url );
            await sleep( 200 );
            await ui.click( app.ui, 'Next' );
            await sleep( 900 );
            check( 'The DoT generator gets the spell and moves on', /Tracking/.test( await ui.currentStep( app.ui ) ), await ui.currentStep( app.ui ) );
            await ui.pickFirstOption( app.ui );
            await ui.click( app.ui, 'Next' );
            await sleep( 700 );
            await ui.click( app.ui, 'Import' );
            await sleep( 2500 );
            const saved = readJson( dbFile ).triggers.find( t => t.name === 'Fake Spell' );
            check( 'The DoT trigger is saved', saved != null );
            check( 'The generator closes after importing', !/Import DoT Timer/.test( await ui.dialogText( app.ui ) ) );
            check( 'The saved trigger records EQ Spell Resources', saved?.externalSource === 'EQSR' && saved?.allakhazamUrl === url && saved?.importType === 1, `${saved?.externalSource} ${saved?.importType}` );
            const phrases = JSON.stringify( saved?.capturePhrases?.map( p => p.phrase ) );
            check( 'The target is replaced in the capture phrase', /is burned/.test( phrases ) && !/target is burned/.test( phrases ), phrases );

            // The buff generator's first step.
            await ui.openGenerator( app.ui, 'Buff Timer' );
            check( 'The buff generator opens for EQ Spell Resources', /Import Buff Timer \(EQ Spell Resources\)/.test( await ui.dialogText( app.ui ) ) );
            await ui.typeInDialog( app.ui, url );
            await sleep( 200 );
            await ui.click( app.ui, 'Next' );
            await sleep( 900 );
            const buffStep = await ui.currentStep( app.ui );
            check( 'The buff generator gets the spell and moves on', buffStep.length > 0 && !/Scrape/.test( buffStep ), buffStep );
            await ui.click( app.ui, 'Cancel' );

            // Re-importing a trigger made from Allakhazam.
            const editor = await openEditor( 'zamDot' );
            check( 'An Allakhazam DoT trigger can still be re-imported', await hasReimport( editor ) );
            await ui.click( editor, 'Re-import from EQ Spell Resources' );
            await sleep( 800 );
            check( 'Re-import asks for an EQ Spell Resources address', /made from Allakhazam/.test( await ui.dialogText( editor ) ) );
            await ui.typeInDialog( editor, url );
            await sleep( 300 );
            await ui.click( editor, 'Re-import' );
            await sleep( 1000 );
            check( 'Re-import opens the generator with the new address', /Import DoT Timer \(EQ Spell Resources\)/.test( await ui.dialogText( editor ) ) && await ui.dialogHasInputValue( editor, url ) );
            editor.close();

            for ( const [ id, wanted ] of [ [ 'zamBuff', true ], [ 'eqsrDot', true ], [ 'zamAbility', false ], [ 'eqsrAbility', false ] ] ) {
                const page = await openEditor( id );
                check( `Re-import button on ${id}: ${wanted ? 'shown' : 'hidden'}`, await hasReimport( page ) === wanted );
                page.close();
            }

            check( 'The generators used the EQ Spell Resources path', await app.node.eval( `global.__scraped` ) >= 2 );
            check( 'Nothing contacted Allakhazam', await app.node.eval( `global.__zam` ) === 0 );
        } finally { await stop( app ); }
    },

    /** A trigger file cut off by a crash is restored from its backup. */
    async damagedFile() {
        const { profile, log } = createProfile( path.join( work.folder, 'damaged' ), { damageTriggers: true } );
        const app = await start( exePath( args ), profile );
        try {
            await sleep( 3000 );
            const db = readJson( path.join( profile, 'trigger-database.json' ) );
            const restored = db.triggers.filter( t => /^marker/.test( t.triggerId ) ).length;
            check( 'Triggers are restored from the backup', restored === markerCount, restored );
            check( 'The damaged file is kept', fs.readdirSync( profile ).filter( n => n.startsWith( 'trigger-database.damaged-' ) ).length === 1 );
            writeLine( log, 'hello' );
            await waitWatcher( app, w => !!w, 20000 );
            await sleep( 3000 );
            writeLine( log, 'MARKER1' );
            check( 'A restored trigger fires', await waitShown( app, 1, 10000 ) );
        } finally { await stop( app ); }
    },

    /** The import window keeps folders with triggers and drops empty ones. */
    async importFolders() {
        const { profile } = createProfile( path.join( work.folder, 'import' ) );
        const share = path.join( work.folder, 'folders.nagshare' );
        const folder = ( id, name ) => ( { folderId: id, name, children: [] } );
        const trigger = ( id, folderId ) => ( { triggerId: id, name: `Trigger ${id}`, folderId, enabled: true, capturePhrases: [ { phraseId: `p${id}`, phrase: 'hello', useRegEx: false } ], actions: [], conditions: [], classLevels: [] } );
        fs.writeFileSync( share, JSON.stringify( {
            format: 'nag-share', formatVersion: 1, type: 'triggers', shareId: 'shareIdFolders01', versionId: 'versionFolders01', files: [],
            model: { name: 'folders', overlays: [], triggers: [ trigger( 'keepMe0000000001', 'folderHasTriggers' ) ], folders: [ folder( 'folderHasTriggers', 'FOLDER_WITH_TRIGGERS' ), folder( 'folderIsEmpty', 'FOLDER_EMPTY' ) ] },
        } ) );
        const app = await start( exePath( args ), profile );
        try {
            await app.main( `dialog.showOpenDialog = async () => ( { canceled: false, filePaths: [ ${JSON.stringify( share )} ] } ); return true;` );
            await ui.openTab( app.ui, 'Triggers' );
            await sleep( 800 );
            await ui.openTriggersMenu( app.ui );
            await sleep( 600 );
            await ui.click( app.ui, 'Import from File' );
            await sleep( 2500 );
            const text = await ui.dialogText( app.ui );
            check( 'A folder with triggers stays in the import list', /FOLDER_WITH_TRIGGERS/.test( text ), text.slice( 0, 120 ).replace( /\n/g, ' ' ) );
            check( 'An empty folder is removed from the import list', !/FOLDER_EMPTY/.test( text ) );
        } finally { await stop( app ); }
    },
};

( async () => {
    const wanted = otherArgs( args );
    const unknown = wanted.filter( g => !tests[ g ] );
    if ( unknown.length ) throw new Error( `Unknown groups: ${unknown.join( ', ' )}. Groups: ${Object.keys( tests ).join( ', ' )}` );
    for ( const group of wanted.length ? wanted : Object.keys( tests ) ) {
        console.log( `\n--== ${group} ==--` );
        await tests[ group ]();
    }
    work.remove();
    finish();
} )().catch( error => {
    console.log( `Logs from this run are in ${work.folder}` );
    abort( error );
} );
