const electron = require( 'electron' );
const path = require( 'path' );
const fs = require( 'fs' );
const fsp = fs.promises;
const archiver = require( 'archiver' );
const FsUtilities = require( '../utilities/file-system' );
const log = require( 'electron-log' );

/** The minimum time between updates to a store's backup copy. */
const backupIntervalMs = 60 * 1000;
/** Antivirus and file indexers can briefly lock a file, so these operations are retried. */
const retryCount = 5;
const retryDelayMs = 50;
const retryErrorCodes = [ 'EBUSY', 'EPERM', 'EACCES' ];

/**
 * Blocks the current thread for the given number of milliseconds.
 *
 * @param {number} ms The number of milliseconds.
 */
function sleepSync( ms ) {
    Atomics.wait( new Int32Array( new SharedArrayBuffer( 4 ) ), 0, 0, ms );
}

/**
 * Executes the given operation, retrying if the file is briefly locked.
 *
 * @template T
 * @param {() => T} operation The file operation.
 * @returns {T}
 */
function withRetries( operation ) {
    for ( let i = 0; ; i++ ) {
        try {
            return operation();
        } catch ( error ) {
            if ( i >= retryCount || !retryErrorCodes.includes( error.code ) ) {
                throw error;
            }
            sleepSync( retryDelayMs );
        }
    }
}

class Store {
    /** The stored file path and location for this object. */
    #path;
    /** The folder for the current user data store. */
    userDataPath;
    /** This object's default values. */
    #defaults;
    /** Virtual properties */
    #virtual = [];
    /** The config name of this object. */
    configName;
    /** The time of the last update to the backup copy. */
    #lastBackupTime = 0;
    /** Queues async writes, so that they finish in the order they were requested. */
    #asyncWrites = Promise.resolve();
    /** True once the user has been told that this store can't be saved. */
    #writeFailureReported = false;
    /** The data waiting to be saved by a scheduled write. */
    #scheduledData = null;
    /** The timer of the scheduled write. */
    #scheduledTimer = null;

    constructor( opts ) {
        // Renderer process has to get `app` module via `remote`, whereas the main process can get it directly
        // app.getPath('userData') will return a string of the user's app data directory path.
        this.userDataPath = ( electron.app || electron.remote.app ).getPath( 'userData' );
        // We'll use the `configName` property to set the file name and path.join to bring it all together as a string
        this.#path = path.join( this.userDataPath, opts.configName + '.json' );
        this.#defaults = opts.defaults;
        this.configName = opts.configName;
        this.#virtual = opts.virtual || [];
        // this.data = parseDataFile( this.path, opts.defaults );
        electron.app?.on?.( 'will-quit', () => this.flushScheduledWrite() );
    }
    

    /** The path of the copy of the previous save. */
    get #backupPath() {
        return `${this.#path}.bak`;
    }

    parseDataFile() {
        try {
            return this.#readFile( this.#path );
        } catch ( error ) {
            // The file doesn't exist yet, which will be the case on the first application run.
            if ( error.code === 'ENOENT' ) {
                return this.#defaults;
            }

            return this.#recoverDataFile( error );
        }
    }

    /**
     * Reads and parses the given store file.
     *
     * @param {string} filePath The path of the file.
     * @returns {any} The parsed contents.
     */
    #readFile( filePath ) {
        const data = JSON.parse( withRetries( () => fs.readFileSync( filePath, 'utf-8' ) ) );

        if ( data == null || typeof data !== 'object' || Array.isArray( data ) ) {
            throw new Error( 'The file does not contain a store object.' );
        }

        return data;
    }

    /**
     * Keeps the damaged data file so it can't be overwritten, then loads the
     * backup copy if there is a good one.
     *
     * @param {Error} readError The error from reading the data file.
     * @returns {any} The recovered data, or the defaults.
     */
    #recoverDataFile( readError ) {
        log.error( `[Store] Could not read ${this.#path}.`, readError );

        const damagedPath = path.join( this.userDataPath, `${this.configName}.damaged-${FsUtilities.getFileTimestamp()}.json` );
        let damagedKept = true;
        try {
            withRetries( () => fs.renameSync( this.#path, damagedPath ) );
        } catch ( error ) {
            damagedKept = false;
            log.error( `[Store] Could not keep the damaged file ${this.#path}.`, error );
        }

        let data = this.#defaults;
        let recovered = false;
        try {
            data = this.#readFile( this.#backupPath );
            recovered = true;
            log.info( `[Store] Recovered ${this.configName} from ${this.#backupPath}.` );
        } catch ( error ) {
            log.error( `[Store] There is no usable backup of ${this.configName}.`, error );
        }

        this.#notifyUser(
            `Nag could not read ${this.configName}.json`,
            `${recovered ? 'Nag restored this data from its backup copy, so your most recent changes may be missing.' : 'There was no usable backup, so Nag started with the default values for this data.'}`
            + `${damagedKept ? `\n\nThe damaged file was kept here:\n${damagedPath}` : ''}`
        );

        return data;
    }

    /**
     * Shows a warning once the app is ready, without blocking startup.
     *
     * @param {string} message The warning.
     * @param {string} detail The details of the warning.
     */
    #notifyUser( message, detail ) {
        electron.app?.whenReady().then( () => {
            electron.dialog?.showMessageBox( { type: 'warning', title: 'Nag', message: message, detail: detail } );
        } );
    }

    /**
     * Logs that the data could not be saved, and tells the user once.
     *
     * @param {Error} error The write error.
     */
    #reportWriteFailure( error ) {
        log.error( `[Store] Error storing ${this.configName}.`, error );

        if ( !this.#writeFailureReported ) {
            this.#writeFailureReported = true;
            this.#notifyUser( `Nag could not save ${this.configName}.json`, `Recent changes may be lost when Nag closes.  Check that the drive isn't full.\n\n${error?.message ?? error}` );
        }
    }

    /**
     * Copies the current data file to the backup copy.  The copy is only updated
     * occasionally, so that it is older than a problem that shows up right away.
     */
    #updateBackup() {
        const now = Date.now();
        if ( now - this.#lastBackupTime < backupIntervalMs ) {
            return;
        }

        try {
            if ( fs.existsSync( this.#path ) ) {
                withRetries( () => fs.copyFileSync( this.#path, this.#backupPath ) );
                this.#lastBackupTime = now;
            }
        } catch ( error ) {
            log.error( `[Store] Could not update ${this.#backupPath}.`, error );
        }
    }

    /**
     * Replaces the data file in one step, so that a crash or a full disk leaves
     * either the old file or the new file, and never part of one.
     *
     * @param {string} contents The new contents of the data file.
     */
    #writeFile( contents ) {
        const tempPath = `${this.#path}.tmp`;

        const fd = fs.openSync( tempPath, 'w' );
        try {
            fs.writeSync( fd, contents );
            fs.fsyncSync( fd );
        } finally {
            fs.closeSync( fd );
        }

        this.#updateBackup();
        withRetries( () => fs.renameSync( tempPath, this.#path ) );
    }

    /**
     * Replaces the data file in one step, without blocking the thread.
     *
     * @param {string} contents The new contents of the data file.
     */
    async #writeFileAsync( contents ) {
        const tempPath = `${this.#path}.async.tmp`;

        const handle = await fsp.open( tempPath, 'w' );
        try {
            await handle.writeFile( contents );
            await handle.sync();
        } finally {
            await handle.close();
        }

        this.#updateBackup();
        withRetries( () => fs.renameSync( tempPath, this.#path ) );
    }

    /**
     * Returns the text to save for the given data, without its virtual properties.
     *
     * @param {any} data The data to save.
     * @returns {string}
     */
    #serialize( data ) {
        if ( !data )
            throw 'Attmept to store null data file!';

        if ( this.#virtual.length === 0 ) {
            return JSON.stringify( data );
        }

        let storeData = { ...data };
        for ( let i = 0; i < this.#virtual.length; i++ ) {
            delete storeData[ this.#virtual[ i ] ];
        }

        return JSON.stringify( storeData );
    }

    /**
     * Saves the data after a short delay.  Calling this again restarts the
     * delay, so a burst of changes is written once.  Use this for changes that
     * happen many times in a row.
     *
     * @param {any} data The data to save.
     * @param {number} delayMs The delay before saving.
     */
    scheduleStoreDataFile( data, delayMs = 500 ) {
        this.#scheduledData = data;
        clearTimeout( this.#scheduledTimer );
        this.#scheduledTimer = setTimeout( () => this.flushScheduledWrite(), delayMs );
    }

    /**
     * Saves the data from a scheduled write now, if there is one waiting.
     */
    flushScheduledWrite() {
        if ( this.#scheduledData ) {
            this.storeDataFile( this.#scheduledData );
        }
    }

    /**
     * A save includes all of the latest data, so a scheduled write isn't needed anymore.
     */
    #cancelScheduledWrite() {
        clearTimeout( this.#scheduledTimer );
        this.#scheduledTimer = null;
        this.#scheduledData = null;
    }

    storeDataFile( data ) {

        const contents = this.#serialize( data );
        this.#cancelScheduledWrite();

        try {
            this.#writeFile( contents );
        } catch ( error ) {
            this.#reportWriteFailure( error );
        }
    }

    storeDataFileAsync( data ) {

        const contents = this.#serialize( data );
        this.#cancelScheduledWrite();

        this.#asyncWrites = this.#asyncWrites
            .then( () => this.#writeFileAsync( contents ) )
            .catch( error => this.#reportWriteFailure( error ) );

        return this.#asyncWrites;
    }

    /**
     * Creates a backup of the database.
     * 
     * @param {(string) => void)} onComplete Callback function executed when the backup file is created that receives the backup file location.
     */
    backupDatafile( onComplete ) {
        let backupFile = path.join( this.userDataPath, `-${FsUtilities.getFileTimestamp()}-backup.zip` );
        let output = fs.createWriteStream( backupFile );
        let zip = archiver( 'zip' );

        output.on( 'close', () => {
            onComplete( backupFile );
        } );

        zip.pipe( output );
        zip.file( this.#path, { name: this.configName + '.json' } );
        zip.finalize();
    }

}

module.exports = Store;
