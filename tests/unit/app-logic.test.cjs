// Tests for saving and recovering data, log backups, regex safety and the GINA search.
// Everything happens in a temporary folder. Electron is replaced with a small stub.
const Module = require( 'module' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const crypto = require( 'crypto' );

const { check, finish, abort } = require( '../lib/report.cjs' );

const appDir = path.resolve( __dirname, '../..' );
const tmp = fs.mkdtempSync( path.join( os.tmpdir(), 'nag-unit-' ) );
const boxes = [], sent = [];
const electronStub = {
    app: { getPath: () => tmp, whenReady: () => Promise.resolve() },
    dialog: { showMessageBox: o => { boxes.push( o ); return Promise.resolve( {} ); } },
    ipcRenderer: { send: ( c, ...a ) => sent.push( [ c, ...a ] ) },
};
const load = Module._load;
Module._load = function ( r, ...a ) {
    if ( r === 'electron' ) return electronStub;
    if ( r === 'electron-log' ) return { info() {}, warn() {}, error() {} };
    return load.call( this, r, ...a );
};

const flush = () => new Promise( r => setTimeout( r, 20 ) );
const hash = f => crypto.createHash( 'sha1' ).update( fs.readFileSync( f ) ).digest( 'hex' );

( async () => {
    const Store = require( path.join( appDir, 'src/electron/data/store.js' ) );
    const file = n => path.join( tmp, n );
    const mk = n => new Store( { configName: n, defaults: { isDefault: true } } );

    // --== Store ==--
    let s = mk( 'missing' );
    check( 'Missing file gives defaults with no warning', s.parseDataFile().isDefault === true && boxes.length === 0 );

    s = mk( 'save' );
    s.storeDataFile( { v: 1 } );
    check( 'Save writes the file', JSON.parse( fs.readFileSync( file( 'save.json' ) ) ).v === 1 );
    check( 'Save leaves no temp file', !fs.existsSync( file( 'save.json.tmp' ) ) );
    s.storeDataFile( { v: 2 } );
    check( 'Second save keeps the previous save as the backup', JSON.parse( fs.readFileSync( file( 'save.json.bak' ) ) ).v === 1 );
    s.storeDataFile( { v: 3 } );
    check( 'Backup is not rewritten on every save', JSON.parse( fs.readFileSync( file( 'save.json.bak' ) ) ).v === 1 );
    check( 'Latest save is in the file', JSON.parse( fs.readFileSync( file( 'save.json' ) ) ).v === 3 );

    fs.writeFileSync( file( 'nobak.json' ), '{"triggers":[{"na' );
    boxes.length = 0;
    let d = mk( 'nobak' ).parseDataFile();
    await flush();
    const kept = fs.readdirSync( tmp ).filter( n => n.startsWith( 'nobak.damaged-' ) );
    check( 'Damaged file with no backup gives defaults', d.isDefault === true );
    check( 'Damaged file is kept', kept.length === 1 && fs.readFileSync( file( kept[ 0 ] ), 'utf-8' ).includes( 'triggers' ) );
    check( 'User is warned about the damaged file', boxes.length === 1 && boxes[ 0 ].detail.includes( kept[ 0 ] ) );

    fs.writeFileSync( file( 'hasbak.json' ), Buffer.alloc( 500 ) );
    fs.writeFileSync( file( 'hasbak.json.bak' ), JSON.stringify( { triggers: [ 'mine' ] } ) );
    boxes.length = 0;
    d = mk( 'hasbak' ).parseDataFile();
    await flush();
    check( 'Damaged file (zero filled, as after a power cut) restores the backup', d.triggers?.[ 0 ] === 'mine' );
    check( 'Warning says it was restored', boxes[ 0 ]?.detail.includes( 'restored' ) );

    fs.writeFileSync( file( 'emptyfile.json' ), '' );
    check( 'Empty file counts as damaged', mk( 'emptyfile' ).parseDataFile().isDefault === true && fs.readdirSync( tmp ).some( n => n.startsWith( 'emptyfile.damaged-' ) ) );
    fs.writeFileSync( file( 'nullfile.json' ), 'null' );
    check( 'A file containing null counts as damaged', mk( 'nullfile' ).parseDataFile().isDefault === true && fs.readdirSync( tmp ).some( n => n.startsWith( 'nullfile.damaged-' ) ) );

    // A full disk during the write leaves the old file alone.
    s = mk( 'full' );
    s.storeDataFile( { v: 'good' } );
    const before = hash( file( 'full.json' ) );
    await flush();
    const writeSync = fs.writeSync;
    fs.writeSync = () => { const e = new Error( 'no space' ); e.code = 'ENOSPC'; throw e; };
    boxes.length = 0;
    s.storeDataFile( { v: 'bad' } ); s.storeDataFile( { v: 'bad' } );
    fs.writeSync = writeSync;
    await flush();
    check( 'Failed write leaves the old file unchanged', hash( file( 'full.json' ) ) === before );
    check( 'Failed write warns once', boxes.length === 1, boxes.length );

    // A briefly locked file is retried.
    s = mk( 'locked' );
    s.storeDataFile( { v: 1 } );
    const renameSync = fs.renameSync;
    let attempts = 0;
    fs.renameSync = ( ...a ) => { if ( ++attempts <= 2 ) { const e = new Error( 'busy' ); e.code = 'EPERM'; throw e; } return renameSync( ...a ); };
    s.storeDataFile( { v: 2 } );
    fs.renameSync = renameSync;
    check( 'Locked file is retried', attempts === 3 && JSON.parse( fs.readFileSync( file( 'locked.json' ) ) ).v === 2, attempts );

    s = mk( 'async' );
    await Promise.all( Array.from( { length: 25 }, ( _, i ) => s.storeDataFileAsync( { v: i } ) ) );
    check( 'Async saves finish in order', JSON.parse( fs.readFileSync( file( 'async.json' ) ) ).v === 24 );
    check( 'Async saves leave no temp file', !fs.existsSync( file( 'async.json.async.tmp' ) ) );

    // A crash in the middle of a save: the temp file is partial, the real file is intact.
    fs.writeFileSync( file( 'crash.json' ), '{"v":"good"}' );
    fs.writeFileSync( file( 'crash.json.tmp' ), '{"v":"ha' );
    check( 'Partial temp file from a crash is ignored', mk( 'crash' ).parseDataFile().v === 'good' );

    // --== Log backup ==--
    const AdmZip = require( path.join( appDir, 'node_modules/adm-zip' ) );
    const LogBackup = require( path.join( appDir, 'src/electron/threads/log-backup.js' ) );
    const waitFor = async c => { for ( let i = 0; i < 100 && !sent.some( s => c.includes( s[ 0 ] ) ); i++ ) await new Promise( r => setTimeout( r, 50 ) ); };
    const eq = n => { const d = path.join( tmp, n, 'Logs' ); fs.mkdirSync( d, { recursive: true } ); return d; };

    let logs = eq( 'good' );
    fs.writeFileSync( path.join( logs, 'archive_eqlog_A_x.txt' ), '[line] a\r\n'.repeat( 2000 ) );
    fs.writeFileSync( path.join( logs, 'archive_eqlog_B_x.txt' ), '[line] b\r\n'.repeat( 2000 ) );
    sent.length = 0;
    LogBackup( [ path.join( logs, 'archive_eqlog_A_x.txt' ), path.join( logs, 'archive_eqlog_B_x.txt' ) ], path.dirname( logs ), [], 1 );
    await waitFor( [ 'window:child:close', 'log:backup:critical-failure' ] );
    await flush();
    let zip = new AdmZip( path.join( logs, 'LogArchive.zip' ) );
    check( 'Good backup archives both logs', zip.getEntries().length === 2, zip.getEntries().length );
    check( 'Archived contents are complete', zip.getEntries().every( e => e.getData().length === 20000 ) );
    check( 'Good backup removes the originals', !fs.existsSync( path.join( logs, 'archive_eqlog_A_x.txt' ) ) && !fs.existsSync( path.join( logs, 'archive_eqlog_B_x.txt' ) ) );
    check( 'Good backup leaves no temp file', !fs.existsSync( path.join( logs, 'LogArchive.zip.tmp' ) ) );
    check( 'Good backup reports no failure', !sent.some( s => s[ 0 ] === 'log:backup:critical-failure' ) );

    // The second file fails partway, with an existing archive in place.
    logs = eq( 'bad' );
    const prior = new AdmZip(); prior.addFile( 'old.txt', Buffer.from( 'old logs' ) ); prior.writeZip( path.join( logs, 'LogArchive.zip' ) );
    const priorHash = hash( path.join( logs, 'LogArchive.zip' ) );
    fs.writeFileSync( path.join( logs, 'archive_eqlog_C_x.txt' ), '[line] c\r\n'.repeat( 2000 ) );
    fs.mkdirSync( path.join( logs, 'LogArchive.zip.tmp' ) );   // Makes writing the new archive fail.
    fs.writeFileSync( path.join( logs, 'LogArchive.zip.tmp', 'x' ), 'x' );
    sent.length = 0;
    LogBackup( [ path.join( logs, 'archive_eqlog_C_x.txt' ) ], path.dirname( logs ), [], 1 );
    await waitFor( [ 'window:child:close', 'log:backup:critical-failure' ] );
    await flush();
    check( 'Failed backup keeps the original log', fs.existsSync( path.join( logs, 'archive_eqlog_C_x.txt' ) ) );
    check( 'Failed backup leaves the existing archive unchanged', hash( path.join( logs, 'LogArchive.zip' ) ) === priorHash );
    check( 'Failed backup is reported', sent.some( s => s[ 0 ] === 'log:backup:critical-failure' ) );
    check( 'Failed backup does not say it finished', !sent.some( s => s[ 0 ] === 'window:child:close' ) );

    // A log that can't be read.
    logs = eq( 'unreadable' );
    sent.length = 0;
    LogBackup( [ path.join( logs, 'does-not-exist.txt' ) ], path.dirname( logs ), [], 1 );
    await waitFor( [ 'window:child:close', 'log:backup:critical-failure' ] );
    check( 'A missing log is reported instead of hanging', sent.some( s => s[ 0 ] === 'log:backup:critical-failure' ) );

    // --== Regex checks ==--
    const { hasNestedRepetition, canHang, isSuspect } = require( path.join( appDir, 'src/electron/utilities/regex-safety.js' ) );
    for ( const p of [ '^(a+)+$', '(.*)*x', '(?<n>\\w+\\s?)+$', '(a|b)+c', '({S} )+', '((a)+)*', '(x{2,})+' ] ) check( `Flags ${p}`, hasNestedRepetition( p ) );
    for ( const p of [ '^You hit (?<t>.+?) for (\\d+) points\\.$', '^(?:~ )?${Character} clears their mind\\.$', '(a+)?b', '[(a+)+]', '\\(a+\\)+', '(ab){2,3}', '^{S} says, \'{S1}\'$', '(a)(b)+c' ] ) check( `Allows ${p}`, !hasNestedRepetition( p ) );
    const t = ( phrase, useRegEx = true ) => ( { name: 'x', capturePhrases: [ { phrase, useRegEx } ], actions: [] } );
    check( 'Blocks a nested pattern with a backreference', canHang( t( '^(a+)+\\1$' ) ) );
    check( 'Blocks a nested pattern with lookahead', canHang( t( '^(a+)+(?=b)' ) ) );
    check( 'Does not block a nested pattern the safe engine can run', !canHang( t( '^(a+)+$' ) ) && isSuspect( t( '^(a+)+$' ) ) );
    check( 'Ignores phrases that are not regular expressions', !canHang( t( '^(a+)+\\1$', false ) ) );
    check( 'Finds phrases anywhere in a trigger', canHang( { actions: [ { endEarlyPhrases: [ { phrase: '(a+)+\\1', useRegEx: true } ] } ] } ) );

    const { validateShareFile } = require( path.join( appDir, 'src/electron/share-files.js' ) );
    const wrap = trig => ( { format: 'nag-share', formatVersion: 1, type: 'triggers', shareId: 'a', versionId: 'b', model: { triggers: [ trig ], folders: [] }, files: [] } );
    const full = phrase => ( { triggerId: 't', folderId: 'f', name: 'Evil', capturePhrases: [ { phrase, useRegEx: true } ], actions: [] } );
    const msg = validateShareFile( wrap( full( '^(a+)+\\1$' ) ), 'triggers' );
    check( 'Share import rejects it and names the trigger', /"Evil"/.test( msg ?? '' ), msg );
    check( 'Share import accepts normal phrases', validateShareFile( wrap( full( '^You hit (.+?)$' ) ), 'triggers' ) === null );

    const predefinedFolder = path.join( appDir, 'src/electron/data/predefined-triggers' );
    const predefined = fs.readdirSync( predefinedFolder ).filter( n => n.endsWith( '.json' ) ).map( n => JSON.parse( fs.readFileSync( path.join( predefinedFolder, n ), 'utf-8' ) ) );
    check( `None of the ${predefined.length} built-in triggers look slow`, predefined.length > 0 && !predefined.some( t => canHang( t ) || isSuspect( t ) ) );
    const typical = JSON.parse( fs.readFileSync( path.join( __dirname, '../fixtures/typical-triggers.nagshare' ), 'utf-8' ) ).model.triggers;
    check( 'Typical triggers do not look slow', !typical.some( t => canHang( t ) || isSuspect( t ) ) );

    // --== Delayed saves ==--
    s = mk( 'sched' );
    let writes = 0;
    const renameCount = fs.renameSync;
    fs.renameSync = ( ...a ) => { writes++; return renameCount( ...a ); };
    for ( let i = 0; i < 200; i++ ) s.scheduleStoreDataFile( { v: i }, 80 );
    check( 'A burst of changes has not been saved yet', !fs.existsSync( file( 'sched.json' ) ) );
    await new Promise( r => setTimeout( r, 200 ) );
    check( 'A burst of 200 changes is saved once', writes === 1, writes );
    check( 'The last change is the one saved', JSON.parse( fs.readFileSync( file( 'sched.json' ) ) ).v === 199 );
    writes = 0;
    s.scheduleStoreDataFile( { v: 'quit' }, 60000 );
    s.flushScheduledWrite();
    check( 'A scheduled save is written when flushed at quit', JSON.parse( fs.readFileSync( file( 'sched.json' ) ) ).v === 'quit' && writes === 1 );
    s.flushScheduledWrite();
    check( 'Flushing twice does not save twice', writes === 1, writes );
    s.scheduleStoreDataFile( { v: 'old' }, 30 );
    s.storeDataFile( { v: 'newer' } );
    await new Promise( r => setTimeout( r, 80 ) );
    fs.renameSync = renameCount;
    check( 'A direct save cancels the scheduled one', JSON.parse( fs.readFileSync( file( 'sched.json' ) ) ).v === 'newer' );
    const vs = new Store( { configName: 'virt', defaults: {}, virtual: [ 'secret' ] } );
    const vdata = { keep: 1, secret: 2 };
    vs.storeDataFile( vdata );
    check( 'Virtual properties are not saved, and the live data keeps them', !( 'secret' in JSON.parse( fs.readFileSync( file( 'virt.json' ) ) ) ) && vdata.secret === 2 );
    let threw = false; try { mk( 'nul' ).storeDataFile( null ); } catch ( e ) { threw = true; }
    check( 'Saving null is still refused', threw );

    const Arr = require( path.join( appDir, 'src/electron/utilities/arrays.js' ) );
    const hist = { 1000: [ 'a' ], 2000: [ 'b' ], 3000: [ 'c' ] };
    Arr.removeKeysBelow( hist, 2000 );
    check( 'Old history is removed and recent history is kept', Object.keys( hist ).join() === '2000,3000' );

    // GINA search
    const GinaImporter = require( path.join( appDir, 'src/electron/gina-importer.js' ) );
    const ginaRoot = path.join( tmp, 'gina-home' );
    const paths = { home: ginaRoot, appData: path.join( ginaRoot, 'AppData', 'Roaming' ), documents: path.join( ginaRoot, 'Documents' ), userData: tmp };
    electronStub.app.getPath = n => paths[ n ] ?? tmp;
    const localAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = path.join( ginaRoot, 'AppData', 'Local' );
    const mkGina = p => { fs.mkdirSync( p, { recursive: true } ); fs.writeFileSync( path.join( p, 'GINAConfig.xml' ), '<Configuration/>' ); return p; };
    fs.mkdirSync( ginaRoot, { recursive: true } );
    check( 'GINA search returns null when it is not installed', await GinaImporter.findGinaFolder() === null );
    fs.mkdirSync( path.join( ginaRoot, 'AppData', 'Roaming', 'GimaSoft', 'GINA-empty' ), { recursive: true } );
    check( 'A GINA folder with no config does not count', await GinaImporter.findGinaFolder() === null );
    const odd = mkGina( path.join( ginaRoot, 'Games', 'Old', 'GimaSoft', 'GINA' ) );
    check( 'Finds GINA in an unusual folder under home', await GinaImporter.findGinaFolder() === odd );
    const usual = mkGina( path.join( ginaRoot, 'AppData', 'Local', 'GimaSoft', 'GINA' ) );
    check( 'Checks the usual place first', await GinaImporter.findGinaFolder() === usual );
    process.env.LOCALAPPDATA = localAppData;
    electronStub.app.getPath = () => tmp;

    // --== Log bootstrap ==--
    electronStub.ipcMain = { on() {}, once() {}, handle() {}, removeAllListeners() {} };
    electronStub.BrowserWindow = class {}; electronStub.screen = {};
    const LogBootstrap = require( path.join( appDir, 'src/electron/log-bootstrap.js' ) );
    const bootstrap = new LogBootstrap();
    let result = 'resolved'; await bootstrap.backupLogFiles( {}, 0 ).catch( e => { result = `rejected: ${e}`; } );
    check( 'A backup with no log files finishes without an error', result === 'resolved', result );

    fs.rmSync( tmp, { recursive: true, force: true } );
    finish();
} )().catch( error => {
    fs.rmSync( tmp, { recursive: true, force: true } );
    abort( error );
} );
