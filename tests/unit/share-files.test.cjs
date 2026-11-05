// Checks that share files are validated before they're imported.
const Module = require( 'module' );
const fs = require( 'fs' );
const path = require( 'path' );
const { check, finish, abort } = require( '../lib/report.cjs' );

const root = path.resolve( __dirname, '../..' );
const load = Module._load;
Module._load = function ( request, ...args ) {
    if ( request === 'electron' || request === 'electron-log' ) return {};
    return load.call( this, request, ...args );
};

try {
    const { validateShareFile } = require( path.join( root, 'src/electron/share-files.js' ) );

    const wrap = triggers => ( { format: 'nag-share', formatVersion: 1, type: 'triggers', shareId: 'a', versionId: 'b', model: { triggers, folders: [] }, files: [] } );
    const trigger = ( action, phrases = [ { phrase: 'x' } ] ) => ( { triggerId: 't', folderId: 'f', name: 'n', capturePhrases: phrases, actions: [ action ] } );
    const validate = ( action, phrases ) => validateShareFile( wrap( [ trigger( action, phrases ) ] ), 'triggers' );
    const evil = '<img src=x onerror="window.__pwned=1">';

    check( 'Rejects HTML in a duration', validate( { actionType: 6, showDuration: true, duration: evil } ) !== null );
    check( 'Rejects an object as a duration', validate( { duration: { a: 1 } } ) !== null );
    check( 'Rejects Infinity as a duration', validate( { duration: 'Infinity' } ) !== null );
    check( 'Rejects an array as display text', validate( { displayText: [ evil ] } ) !== null );
    check( 'Rejects a phrase that is not an object', validate( {}, [ 'x' ] ) !== null );
    check( 'Rejects HTML in a phrase duration', validate( {}, [ { phrase: 'x', duration: evil } ] ) !== null );

    for ( const duration of [ 30, 0, null, undefined, '', '30', 2.5 ] ) {
        check( `Accepts a duration of ${JSON.stringify( duration )}`, validate( { duration } ) === null );
    }
    check( 'Still allows HTML in display text', validate( { displayText: '<b>hi</b>' } ) === null );

    const typical = JSON.parse( fs.readFileSync( path.join( __dirname, '../fixtures/typical-triggers.nagshare' ), 'utf-8' ) );
    const typicalError = validateShareFile( typical, typical.type );
    check( 'Accepts a typical share file', typicalError === null, typicalError );
} catch ( error ) {
    abort( error );
}

finish();
