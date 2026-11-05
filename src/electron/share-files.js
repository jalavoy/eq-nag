const { BrowserWindow, dialog, ipcMain } = require( 'electron' );
const fs = require( 'fs' );
const log = require( 'electron-log' );
const { canHang } = require( './utilities/regex-safety' );
const customAlphabet = require( 'nanoid' ).customAlphabet;
const nanoid = customAlphabet( '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 16 );

/** Identifies a file as a Nag share file. */
const shareFormat = 'nag-share';
/** The newest version of the share file format that this version of Nag can read. */
const shareFormatVersion = 1;
const shareFileExtension = 'nagshare';
/** Share files embed their sound files, but they still have to fit in memory. */
const maxShareFileBytes = 100 * 1024 * 1024;
const maxFolderDepth = 50;
const shareTypes = [ 'triggers', 'fct' ];

const fileFilters = [
    { name: 'Nag share file', extensions: [ shareFileExtension ] },
    { name: 'All files', extensions: [ '*' ] },
];










/**
 * Returns true if the given value is an object, and not an array or null.
 *
 * @param {any} value The value to evaluate.
 */
function isObject( value ) {
    return value != null && typeof value === 'object' && !Array.isArray( value );
}










/**
 * Returns true if the given folder, and all of its children, are valid.
 *
 * @param {any} folder The folder to evaluate.
 * @param {number} depth The depth of this folder in the hierarchy.
 */
function isValidFolder( folder, depth = 0 ) {
    return isObject( folder )
        && depth < maxFolderDepth
        && typeof folder.folderId === 'string'
        && typeof folder.name === 'string'
        && ( folder.children == null || ( Array.isArray( folder.children ) && folder.children.every( f => isValidFolder( f, depth + 1 ) ) ) );
}










/**
 * Returns true if the given value is empty, a number, or text containing only a number.
 *
 * @param {any} value The value to evaluate.
 */
function isNumeric( value ) {
    return value == null
        || value === ''
        || ( typeof value === 'number' && Number.isFinite( value ) )
        || ( typeof value === 'string' && value.trim() !== '' && Number.isFinite( +value ) );
}









/**
 * Returns true if the given value is empty or text.
 *
 * @param {any} value The value to evaluate.
 */
function isText( value ) {
    return value == null || typeof value === 'string';
}









/**
 * Returns true if the properties of the given action have the expected types.
 *
 * @param {any} action The action to evaluate.
 */
function isValidAction( action ) {
    return isObject( action )
        && [ 'duration', 'repeatCount', 'endingDuration', 'castTime' ].every( key => isNumeric( action[ key ] ) )
        && [ 'overlayId', 'displayText', 'timerIcon', 'storageDuration' ].every( key => isText( action[ key ] ) );
}









/**
 * Returns true if the given capture phrase has the expected types.
 *
 * @param {any} phrase The capture phrase to evaluate.
 */
function isValidCapturePhrase( phrase ) {
    return isObject( phrase )
        && isText( phrase.phrase )
        && isNumeric( phrase.duration );
}









/**
 * Returns true if the given trigger has the properties required to install it.
 *
 * @param {any} trigger The trigger to evaluate.
 */
function isValidTrigger( trigger ) {
    return isObject( trigger )
        && typeof trigger.triggerId === 'string'
        && typeof trigger.folderId === 'string'
        && typeof trigger.name === 'string'
        && Array.isArray( trigger.capturePhrases )
        && trigger.capturePhrases.every( isValidCapturePhrase )
        && Array.isArray( trigger.actions )
        && trigger.actions.every( isValidAction );
}










/**
 * Checks that the contents of a share file can be installed.  A share file
 * comes from another person, so nothing in it can be assumed to be correct.
 *
 * @returns {string | null} Returns a message describing the problem, or null if the contents are valid.
 *
 * @param {any} share The parsed contents of the share file.
 * @param {'triggers' | 'fct'} expectedType The type of share the user is importing.
 */
function validateShareFile( share, expectedType ) {
    if ( !isObject( share ) || share.format !== shareFormat ) {
        return 'This is not a Nag share file.';
    }
    if ( !Number.isInteger( share.formatVersion ) || share.formatVersion < 1 ) {
        return 'This share file has an invalid format version.';
    }
    if ( share.formatVersion > shareFormatVersion ) {
        return 'This share file was made by a newer version of Nag.  Update Nag to import it.';
    }
    if ( !shareTypes.includes( share.type ) ) {
        return 'This share file contains an unknown type of data.';
    }
    if ( share.type !== expectedType ) {
        return share.type === 'fct'
            ? 'This share file contains floating combat text settings.  Import it from the Floating Combat Text tab.'
            : 'This share file contains triggers.  Import it from the Triggers tab.';
    }
    if ( typeof share.shareId !== 'string' || typeof share.versionId !== 'string' || !isObject( share.model ) ) {
        return 'This share file is missing required information.';
    }

    const model = share.model;

    if ( model.overlays != null && !( Array.isArray( model.overlays ) && model.overlays.every( f => isObject( f ) && typeof f.overlayId === 'string' ) ) ) {
        return 'This share file contains invalid overlays.';
    }

    if ( share.type === 'fct' ) {
        if ( !Array.isArray( model.fctGroups ) || !model.fctGroups.every( isObject ) ) {
            return 'This share file contains invalid floating combat text settings.';
        }
    } else {
        if ( !Array.isArray( model.triggers ) || !model.triggers.every( isValidTrigger ) ) {
            return 'This share file contains invalid triggers.';
        }
        if ( !Array.isArray( model.folders ) || !model.folders.every( f => isValidFolder( f ) ) ) {
            return 'This share file contains invalid folders.';
        }

        const unsafe = model.triggers.find( canHang );
        if ( unsafe ) {
            return `The trigger "${unsafe.name}" has a regular expression that could freeze Nag, so this share file can't be imported.`;
        }
    }

    // The sound files themselves are checked when they are imported.
    if ( share.files != null && !( Array.isArray( share.files ) && share.files.every( f => isObject( f ) && typeof f.fileId === 'string' && typeof f.fileName === 'string' && typeof f.contents === 'string' ) ) ) {
        return 'This share file contains invalid sound files.';
    }

    return null;
}










/**
 * Attaches the ipc events for exporting and importing share files.
 */
function registerShareFileHandlers() {

    ipcMain.handle( 'file:share:export',
        /**
         * Asks the user where to save the share, and writes the share file.
         *
         * @param {Electron.IpcMainInvokeEvent} event The event args.
         * @param {{type: 'triggers' | 'fct', model: any, files: any[] | undefined, suggestedName: string | undefined}} data The share to export.
         * @returns {Promise<{canceled: boolean, error?: string}>} The result of the export.
         */
        async ( event, data ) => {
            try {
                const contents = JSON.stringify( {
                    format: shareFormat,
                    formatVersion: shareFormatVersion,
                    type: data.type,
                    shareId: nanoid(),
                    versionId: nanoid(),
                    exportedAt: new Date().toISOString(),
                    model: data.model,
                    files: data.files ?? [],
                } );

                if ( Buffer.byteLength( contents ) > maxShareFileBytes ) {
                    return { canceled: false, error: 'This export is too large to share because of the size of its sound files.' };
                }

                const fileName = `${data.suggestedName || 'nag-share'}`.replace( /[<>:"/\\|?*\x00-\x1f]/g, '' ).trim() || 'nag-share';
                const result = await dialog.showSaveDialog( BrowserWindow.fromWebContents( event.sender ), {
                    title: 'Export to file',
                    defaultPath: `${fileName}.${shareFileExtension}`,
                    filters: fileFilters,
                } );

                if ( result.canceled || !result.filePath ) {
                    return { canceled: true };
                }

                await fs.promises.writeFile( result.filePath, contents, 'utf-8' );
                log.info( `[share-files] Exported a share file to ${result.filePath}.` );

                return { canceled: false };

            } catch ( error ) {
                log.error( '[share-files] Could not export the share file.', error );
                return { canceled: false, error: `Could not save the file: ${error?.message ?? error}` };
            }
        } );

    ipcMain.handle( 'file:share:import',
        /**
         * Asks the user for a share file, then reads and validates it.
         *
         * @param {Electron.IpcMainInvokeEvent} event The event args.
         * @param {'triggers' | 'fct'} expectedType The type of share the user is importing.
         * @returns {Promise<{canceled: boolean, share?: any, error?: string}>} The result of the import.
         */
        async ( event, expectedType ) => {
            try {
                const result = await dialog.showOpenDialog( BrowserWindow.fromWebContents( event.sender ), {
                    title: 'Import from file',
                    filters: fileFilters,
                    properties: [ 'openFile' ],
                } );

                if ( result.canceled || result.filePaths.length === 0 ) {
                    return { canceled: true };
                }

                const stats = await fs.promises.stat( result.filePaths[ 0 ] );
                if ( stats.size > maxShareFileBytes ) {
                    return { canceled: false, error: 'This file is too large to be a Nag share file.' };
                }

                let share;
                try {
                    share = JSON.parse( await fs.promises.readFile( result.filePaths[ 0 ], 'utf-8' ) );
                } catch ( error ) {
                    return { canceled: false, error: 'This is not a Nag share file.' };
                }

                const problem = validateShareFile( share, expectedType );
                if ( problem ) {
                    log.warn( `[share-files] Rejected ${result.filePaths[ 0 ]}: ${problem}` );
                    return { canceled: false, error: problem };
                }

                return { canceled: false, share: share };

            } catch ( error ) {
                log.error( '[share-files] Could not import the share file.', error );
                return { canceled: false, error: `Could not read the file: ${error?.message ?? error}` };
            }
        } );

}

module.exports = { registerShareFileHandlers, validateShareFile };
