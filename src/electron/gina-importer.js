const electron = require( 'electron' );
const { app, BrowserWindow, ipcMain, screen } = require( "electron" );
const ForwardRef = require( '../electron/forward-ref' );
const fs = require( 'fs' );
const path = require( "path" );
const log = require( 'electron-log' );
// const parser = require( 'xml2json' );
const parseStringPromise = require( 'xml2js' ).parseStringPromise;

/** @type {string} */
var ginaDataPath = null;

/** @type {string} */
var ginaConfigFileName = 'GINAConfig.xml';

/** @type {string[]} */
var importedGinaTriggers = [];

/** How many levels of the home folder to search for GINA, after checking the usual places. */
const ginaSearchDepth = 6;
/** Large folders that aren't worth searching. */
const ginaSearchSkipped = [ 'AppData', 'node_modules' ];

class GinaImporter {

    /** @type {string} */
    #storePath;

    constructor() {
        let userDataPath = ( electron.app || electron.remote.app ).getPath( 'userData' );
        this.#storePath = path.join( userDataPath, 'imported.json' );
        this.loadDataFile();
    }
    









    /**
     * Initializes the GINA importer service.
     * 
     * @param {ForwardRef} mainWindowRef The main window of the application.
     * @param {boolean} isDev Sets up the log watcher window for development environment if true.
     */
    initGinaImporter( mainWindowRef, isDev ) {
        
        ipcMain.on( 'gina:get:configuration', ( event, triggerId ) => {
            getGinaConfig( jsonData => {
                if ( jsonData ) {
                    event.sender.send( 'gina:get:configuration', jsonData.Configuration );
                } else {
                    event.sender.send( 'gina:get:configuration', null );
                }
            } );
        } );
        
    }
    









    /**
     * Loads the list of GINA triggers already imported.
     */
    loadDataFile() {
        try {
            let data = JSON.parse( fs.readFileSync( this.#storePath ) );

            if ( data ) {
                importedGinaTriggers = data.importedGinaTriggers;
            }

        } catch ( error ) {
            
        }
    }










    /**
     * Saves the imported gina information, preventing those triggers from 
     * appearing in the list.
     */
    storeDataFile() {
        try {
            fs.writeFile( this.#storePath, JSON.stringify( { importedGinaTriggers: importedGinaTriggers } ), () => { } );
        } catch ( error ) {
            console.error( 'Error storing ' + this.#storePath, error );
        }
    }

}










/**
 * Parses the gina config file.
 * 
 * @param {(json: any) => void} onLoaded This method is executed when the config file is loaded and parsed into a json string.
 */
async function getGinaConfig( onLoaded ) {
    // TODO: This should be done in a thread, with a direct reference to the GINA importer window.
    try {
        // Only searched for when it's needed, and not on every launch.
        ginaDataPath = ginaDataPath ?? await findGinaFolder();

        if ( !ginaDataPath ) {
            log.info( 'GINA was not found.' );
            onLoaded( null );
            return;
        }

        const data = await fs.promises.readFile( path.join( ginaDataPath, ginaConfigFileName ), { encoding: 'utf8' } );
        onLoaded( await parseStringPromise( data, { normalize: false, normalizeTags: false, explicitArray: false, ignoreAttrs: true } ) );

    } catch ( error ) {
        log.error( 'Could not read the GINA configuration.', error );
        onLoaded( null );
    }
}










/**
 * Returns the sub folders of the given folder.
 *
 * @param {string} folder The folder path.
 * @returns {Promise<string[]>} The names of the sub folders.
 */
async function getSubFolders( folder ) {
    try {
        const entities = await fs.promises.readdir( folder, { withFileTypes: true } );
        return entities.filter( dirent => dirent.isDirectory() ).map( dirent => dirent.name );
    } catch ( error ) {
        // Usually directory read permissions, just ignore it.
        return [];
    }
}










/**
 * Finds the GINA data folder: first in the usual places, then by searching the
 * user's home folder a level at a time, stopping at the first one found.
 *
 * @returns {Promise<string | null>} The path of the folder, or null if GINA wasn't found.
 */
async function findGinaFolder() {
    const home = app.getPath( 'home' );
    const appData = app.getPath( 'appData' );

    const isGinaFolder = folder => /GimaSoft[\\/]GINA/i.test( folder ) && fs.existsSync( path.join( folder, ginaConfigFileName ) );

    for ( const root of [ appData, process.env.LOCALAPPDATA ?? path.join( home, 'AppData', 'Local' ), app.getPath( 'documents' ), home ] ) {
        const gimaSoft = path.join( root, 'GimaSoft' );
        for ( const dir of await getSubFolders( gimaSoft ) ) {
            if ( isGinaFolder( path.join( gimaSoft, dir ) ) ) {
                return path.join( gimaSoft, dir );
            }
        }
    }

    let level = [ home ];
    for ( let depth = 0; depth < ginaSearchDepth && level.length > 0; depth++ ) {
        const nextLevel = [];

        for ( const folder of level ) {
            for ( const dir of await getSubFolders( folder ) ) {
                const childPath = path.join( folder, dir );

                if ( isGinaFolder( childPath ) ) {
                    return childPath;
                }
                if ( !ginaSearchSkipped.includes( dir ) && !dir.startsWith( '.' ) ) {
                    nextLevel.push( childPath );
                }
            }
        }

        level = nextLevel;
    }

    return null;
}










GinaImporter.findGinaFolder = findGinaFolder;

module.exports = GinaImporter;