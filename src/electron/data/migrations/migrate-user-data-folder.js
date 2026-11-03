const { app, dialog } = require( 'electron' );
const fs = require( 'fs' );
const path = require( 'path' );
const log = require( 'electron-log' );

/** The name of the user data folder before the app was renamed. */
const oldFolderName = 'electron-angular-eq-parse';

/** The last file copied, so that an interrupted copy is tried again on the next launch. */
const completedFile = 'user-preferences.json';

/** Files that belong to Chromium or the log, which are recreated as needed. */
const notCopied = [ 'Cache', 'Code Cache', 'DawnCache', 'GPUCache', 'Local State', 'Local Storage', 'Network', 'Preferences', 'Session Storage', 'blob_storage', 'lockfile', 'logs' ];

/**
 * Copies the user's data from the old user data folder to the new one.  The
 * old folder is left in place, so that the user can go back to an old version.
 *
 * This has to run before any of the data stores are created.
 */
function migrateUserDataFolder() {
    const newPath = app.getPath( 'userData' );
    const oldPath = path.join( app.getPath( 'appData' ), oldFolderName );

    // The new folder itself always exists by now, as Chromium and the log create it on startup.
    if ( fs.existsSync( path.join( newPath, completedFile ) ) || !fs.existsSync( path.join( oldPath, completedFile ) ) ) {
        return;
    }

    try {
        fs.readdirSync( oldPath )
            .filter( name => name !== completedFile && !notCopied.includes( name ) )
            .forEach( name => fs.cpSync( path.join( oldPath, name ), path.join( newPath, name ), { recursive: true } ) );

        fs.copyFileSync( path.join( oldPath, completedFile ), path.join( newPath, completedFile ) );

        log.info( `[Migrations] Copied the user data folder from ${oldPath} to ${newPath}.` );
    } catch ( error ) {
        log.error( '[Migrations] Could not copy the user data folder.', error );
        dialog.showErrorBox( 'Could not copy your settings', `Nag could not copy your settings from:\n${oldPath}\n\nto:\n${newPath}\n\nYour settings have not been changed, but Nag will start without them. Close Nag and open it again to retry.` );
    }
}

module.exports = { migrateUserDataFolder };
