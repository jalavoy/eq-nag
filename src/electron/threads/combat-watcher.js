const { CharacterModel } = require( "../data/models/character" );
const { ipcRenderer, ipcMain } = require( 'electron' );
const { DpsMeterSettings, LogRecord, EncounterResetEventArgs, EncounterModel, ExternalEncounterModel, PlayerDps } = require( "../data/models/combat-parser" );
const { OverlayWindow } = require( "../data/models/overlay-window" );
const { ErrorMessages, TriggerParseHistoryModel, getActionLabel, LogTypes } = require( "../data/models/trigger" );
const { CombatParser, minifyCombatLogs } = require( "../utilities/combat-parser" );
const { TakpCombatParser } = require( "../utilities/combat-parser-takp" );
const { ThjCombatParser } = require( "../utilities/combat-parser-thj" );
const customAlphabet = require( 'nanoid' ).customAlphabet;
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const nanoid = customAlphabet( alphabet, 16 );
const fs = require( 'fs' );
const { nagException, nagLog } = require( "../utilities/nag-console" );
const FileMonitor = require( "../utilities/file-monitor" );
const perf = require( "../utilities/perf" );
const { FctModel } = require( "../data/models/fct" );

/**
 * Sends to the main thread to log the message.
 * 
 * @param {string} message The message to log.
 * @param {any | undefined} payload The payload to log.
 * @param {string | undefined} label The label to log.
 */
const log = ( message, payload, label ) => {
    nagLog( {
        label: label ?? 'Combat Watcher',
        message: message,
        payload: payload,
    } );
}

/** @type {CharacterModel} */
let charModel = null;
/** @type {string} */
let characterName = null;
/** @type {string} */
let characterId = null;
/** @type {boolean} */
let dpsTrackingEnabled = false;
/** @type {boolean} */
let recordEncounters = false;
/** @type {DpsMeterSettings} */
let dpsMeterSettings = new DpsMeterSettings();

/** @type {boolean} */
let backupStarted = false;

/** @type {string} */
let logFilePath = null;
/** @type {number} */
let logParseTimeoutId = null;
const logParseTimer = 50;
/** @type {boolean} */
let changingLogFile = false;

let simStoppedFileMonitor = false;

/** @type {number} */
let currentPosition = null;
let watcher = null;
let enableFct = false;
let isDev = false;
/** @type {OverlayWindow} */
let overlays = [];
/** @type {FileMonitor} */
let fileMonitor = null;
let logPosition = 0;

/**
 * Sends the error information to the main thread for logging.
 * 
 * @param {any} err The error object.
 * @param {string} raw The log entry currently processing.
 * @param {boolean} simulating True if we're simulating a log file.
 * @param {number} padTime The number of seconds to add to log time.
 */
const logParseError = ( err, raw, simulating, padTime ) => {
    if ( raw ) {
        nagException( {
            source: 'combat-watcher.js',
            error: err,
            logEntry: raw,
            simulating: simulating === true,
            padTime: padTime === undefined ? 'undefined' :
                padTime === null ? 'null' :
                    padTime,
        } );
    } else {
        nagException( err );
    }
};










/**
 * Sends the error information to the main thread for logging.
 * 
 * @param {any} err The error object.
 * @param {string} raw The log entry currently processing.
 * @param {boolean} simulating True if we're simulating a log file.
 * @param {number} padTime The number of seconds to add to log time.
 */
const logError = ( err, raw, simulating, padTime ) => {
    logParseError( err, raw, simulating, padTime );
};

/** @type {CombatParser | TakpCombatParser | ThjCombatParser | undefined} */
let myCombatParser = undefined;

/** @type {string[]} */
let myCombatParserCache = [];

const sendDpsToRenderer = async () => {

    // Notes: We send the updated encounter stats to
    // the renderer, not just the current state of things.  This must come 
    // with an encounter id.  When an encounter ends, we send the renderer the 
    // last bucket of updated stats instead of a copy of the entire encounter.
    // The renderer will then choose which encounters to display based on the
    // player selected encounter settings.  This should be simple, if the 
    // encounter start time - last encounter end time < value, then we display
    // both encounters. Extrapolate for more than 2 at a time.
    // Ideally, we would not need an encounter ended event.

    let e = myCombatParser?.getCurrentEncounterStats();

    if ( e?.encounter?.active === true ) {
        
        let encounterNpcs = [ null, ...e.encounter.npcs ];

        for ( let i = 0; i < e.verifiedPlayers.length; i++ ) {
            const playerEvents = e.encounter.playerEvents[ e.verifiedPlayers[ i ] ];

            if ( !playerEvents ) {
                continue;
            }

            for ( let iNpc = 0; iNpc < encounterNpcs.length; iNpc++ ) {
                const npcName = encounterNpcs[ iNpc ];
                const playerDps = new PlayerDps();

                playerDps.characterName = e.verifiedPlayers[ i ];
                playerDps.name = e.verifiedPlayers[ i ];
                playerDps.class = playerEvents.class;
                playerDps.dps = 0;
                playerDps.hps = 0;
                playerDps.damage = 0;
                playerDps.healing = 0;
                playerDps.time = 0;
                playerDps.pets = [];
                playerDps.npcName = npcName ?? undefined;
                
                const outgoingDps = playerEvents.playerDpsOutgoing.filter( f => !npcName || f.npcName === npcName );
                for ( let iDps = 0; iDps < outgoingDps.length; iDps++ ) {
                    const event = outgoingDps[ iDps ];

                    playerDps.damage += event.damage;
                    playerDps.healing += event.healing;
                    playerDps.time += event.time;

                    if ( event.pets ) {
                        for ( let iPet = 0; iPet < event.pets.length; iPet++ ) {
                            const pet = event.pets[ iPet ];
                            let petDps = playerDps.pets.find( p => p.name === pet.name );

                            if ( petDps == null ) {
                                petDps = {
                                    name: pet.name,
                                    dps: 0,
                                    damage: 0,
                                    time: 0,
                                };
                                playerDps.pets.push( petDps );
                            }

                            petDps.damage += pet.damage;
                            petDps.healing += pet.healing;
                            petDps.time += pet.time;
                        }
                    }

                    // Calculate the DPS and HPS.
                    playerDps.dps = playerDps.damage / ( playerDps.time > 0 ? playerDps.time : 1 );
                    playerDps.hps = playerDps.healing / ( playerDps.time > 0 ? playerDps.time : 1 );

                    playerDps.pets.forEach( p => {
                        p.dps = p.damage / ( p.time > 0 ? p.time : 1 );
                        p.hps = p.healing / ( p.time > 0 ? p.time : 1 );
                    } );
                }

                e.playerDps.push( playerDps );
            }

        }

        e.encounter.playerEvents = [];

        ipcRenderer.send( 'renderer:current-encounter', { ...e, characterName: characterName } );
    }
    
};

const startDpsTracking = () => {
    dpsTrackingEnabled = true;
};

/** @type {EncounterModel[]} */
let myEncounters = [];

/**
 * Executes when the encounter is reset.
 * 
 * @param {EncounterResetEventArgs} e The events from the encounter.
 */
const onEncounterReset = ( e ) => {

    myEncounters.push( {
        encounterId: e.encounterId,
        characterName: characterName,
        serverName: charModel.server,
        logRecords: e.logRecords,
        externalEncounterIds: e.externalEncounterIds,
        externalEncounterIdCharacters: e.externalEncounterIdCharacters,
        externalEncounterInfos: [],
        npcs: e.npcs,
        logs: e.logs,
    } );

    ipcRenderer.send( 'renderer:encounter-reset', { character: characterName, encounter: e.encounter } );

    saveEncounter( e.encounterId );
    
    // TODO: Send the full encounter log to disk.  I think that this should work differently than the current db structure.
    //          I think the best way is to have a local directory to store a .json file for each encounter.
    //          Filename format: {characterName}_{serverName}_{timestamp}.json
}

/**
 * Saves the encounter to disk.
 * 
 * @param {string} encounterId The id of the encounter to save.
 */
const saveEncounter = ( encounterId ) => {
    let encounterIndex = myEncounters.findIndex( e => e.encounterId === encounterId );

    if ( encounterIndex >= 0 ) {

        if ( !recordEncounters ) {
            myEncounters = myEncounters.filter( e => e.encounterId !== encounterId );

            nagLog( {
                label: 'Encounter Reset',
                message: `Encounter will not be saved for ${characterName}.`,
            } );
            
        } else {
            const encounter = myEncounters.splice( encounterIndex, 1 )[ 0 ];

            ipcRenderer.invoke( 'log:save-encounter', encounter ).then( () => {
                myEncounters = myEncounters.filter( e => e.encounterId !== encounterId );

                nagLog( {
                    label: 'Encounter Save',
                    message: `Encounter saved for ${characterName}.`,
                } );
            } );
        }
    }
}

const stopDpsTracking = () => {
    dpsTrackingEnabled = false;
};

/** @type {string | undefined} */
var lastCombatLogEntry = undefined;
/**
 * Starts parsing and watching log file changes for the specified file.
 * 
 * @param {string} logPath The file path to the log file.
 * @param {number} startLogPosition If a value is provided, will start parsing the log file at the given position.
 */
async function startParsingLogFile( logPath, startLogPosition ) {

    fileMonitor.monitorLines( ( lines ) => {
        // let start = performance.now();
        let fcts = [];

        lines.forEach( ( line, index ) => {
            if ( line && line.length > 0 ) {
                let prevLog = index === 0 ? lastCombatLogEntry : lines[ index - 1 ];
                let nextLog = index < lines.length - 1 ? lines[ index + 1 ] : undefined;
                let fct = parseLogEntries( line, false, 0, prevLog, nextLog );
                if ( fct ) {
                    fcts = fcts.concat( fct );
                }
            }
        } );

        lastCombatLogEntry = lines[ lines.length - 1 ];
        
        dpsTrackingEnabled === true && sendDpsToRenderer();

        if ( fcts.length > 0 && enableFct ) {
            ipcRenderer.send( 'overlay:send:fct-component', fcts );
        }

        // console.log( 'done processing lines, total time', performance.now() - start );
    }, startLogPosition )
        .then( () => {
            log( `Monitoring log file: ${logPath}`, undefined, 'Combat Watcher' );
        } )
        .catch( error => {
            log( `Error monitoring log file: ${logPath}`, error, 'Combat Watcher' );
        } );
    
}

/**
 * Parses the given log entry.
 * 
 * @returns {FctModel[]} Returns the FCT Models.
 * 
 * @param {string} raw The raw log entry.
 * @param {boolean} simulating If true, only simulates executing triggers via a consol.log call.
 * @param {padTime} padTime The amount of time to add to the timestamps of log entries.
 * @param {string | undefined} prevLog The previous log entry.
 * @param {string | undefined} nextLog The next log entry.
 */
function parseLogEntries( raw, simulating, padTime, prevLog, nextLog ) {
    try {
        /** @type {FctModel[]} */
        let output = [];

        simulating = simulating === true ? true : false;

        // This could be optimized better.
        // TODO: This should be checked in the bootstrap.
        if ( myCombatParser?.loaded && (dpsMeterSettings.show || enableFct) ) {
            
            if ( myCombatParserCache?.length > 0 ) {
                // Add cached log entries to the combat tracker.
                myCombatParserCache.forEach( ( c, i, a ) => {
                    let fctModel = myCombatParser?.addCombatEvent( c, padTime, i > 0 ? a[ i - 1 ] : undefined, i < a.length - 1 ? a[ i + 1 ] : undefined );

                    if ( fctModel ) {
                        output.push( fctModel );
                    }

                    // if ( fctModel && enableFct && !simulating ) {
                    //     ipcRenderer.send( 'overlay:send:fct-component', fctModel );
                    // }
                } );
                myCombatParserCache = [];
            }

            // Add to the combat tracker.
            const perfStart = perf.enabled ? perf.now() : 0;
            let fctModel = myCombatParser?.addCombatEvent( raw, padTime, prevLog, nextLog );
            perf.enabled && perf.record( 'combat-watcher: line', perfStart );

            if ( fctModel ) {
                output.push( fctModel );
            }

            // if ( fctModel && enableFct && !simulating ) {
            //     ipcRenderer.send( 'overlay:send:fct-component', fctModel );
            // }

        } else if ( (dpsMeterSettings.show || enableFct) ) {

            // Add to the combat tracker cache.
            myCombatParserCache.push( raw );

        }

        return output;

    } catch ( error ) {
        logError( error, raw, simulating, padTime );
    }
}

/**
 * Initializes the combat watcher.
 */
function CombatWatcher() {

    ipcRenderer
        .invoke( 'settings:get', { key: 'dpsMeterSettings', subscribe: true } )
        .then( data => {
            dpsMeterSettings = data ?? new DpsMeterSettings();
        } );
    
    ipcRenderer.on( 'combat-database:add:pet',
        /**
         * Handles the add-pet event.
         * 
         * @param {Electron.IpcRendererEvent} event The event args.
         * @param {{petName: string, ownerName: string, forcePet: boolean}} data The data.
         */
        ( event, data ) => {
            if ( myCombatParser != null && data?.petName ) {
                myCombatParser.addPet( data.petName, data.ownerName, data.forcePet );
            }
        } );
    
    ipcRenderer.on( 'log:character:changed',
        /**
         * Handles the changing of the parse character.
         * 
         * @param {Electron.IpcRendererEvent} event The event args.
         * @param {{character: CharacterModel, logPosition: number | undefined}} data The character model.
         */
        async ( event, data ) => {
            if ( data && data.character?.characterId ) {
                
                stopDpsTracking();

                characterName = data.character.name;
                charModel = data.character;
                characterId = data.character.characterId;

                myCombatParser = charModel.takp ? new TakpCombatParser( characterName, charModel.server ) :
                    charModel.thj ? new ThjCombatParser( characterName, charModel.server ) :
                    new CombatParser( characterName, charModel.server );
                myCombatParser.onEncounterReset = onEncounterReset;
                startDpsTracking();

                logFilePath = data.character.logFile;
                logPosition = data.logPosition;

                let fn = async () => {
                    fileMonitor = new FileMonitor( logFilePath );
                    await startParsingLogFile( logFilePath, logPosition >= 0 ? logPosition : null );
                }
    
                if ( fileMonitor != null )
                    fileMonitor.stopMonitoringLogFile().then( () => fn() );
                else
                    fn();
            
            } else if ( data.character == null ) {
                // Stop watching combat stats.
                stopDpsTracking();

                let fn = () => {
                    characterName = null;
                    charModel = null;
                    characterId = null;

                    myCombatParser = undefined;

                    logFilePath = null;
                    logPosition = 0;

                    fileMonitor = null;
                }

                if ( fileMonitor ) {
                    fileMonitor.stopMonitoringLogFile().then( () => fn() );
                } else {
                    fn();
                }
            } else {

            }
        } );
    
    ipcRenderer.on( 'log:combat:unload', async () => {

        ipcRenderer.send( 'log:combat:unloaded', null );

    } );
    
    ipcRenderer.on( 'settings:get:dpsMeterSettings:generic',
        /**
         * 
         * @param {Electron.IpcRendererEvent} event The event args
         * @param {boolean} data True if enabled.
         */
        async ( event, data ) => {
            let prevShow = dpsMeterSettings.show;
            dpsMeterSettings = data ?? new DpsMeterSettings();

            if ( dpsMeterSettings.show && !prevShow ) {
                startDpsTracking();

            } else if ( !dpsMeterSettings.show && prevShow ) {
                stopDpsTracking();
            }

        } );
    
    ipcRenderer.on( 'log:backup-started',
        /**
         * @param {Electron.IpcRendererEvent} event The event args.
         */
        function ( event ) {
            backupStarted = true;
        } );

    ipcRenderer.on( 'log:changed',
        /**
         * Handles the log:changed event.
         * 
         * @param {Electron.IpcRendererEvent} event The event args.
         * @param {string} data The log file path.
         */
        async ( event, data ) => {
            
            logFilePath = data;

            let fn = async () => {
                fileMonitor = new FileMonitor( logFilePath );
                await startParsingLogFile( logFilePath, logPosition >= 0 ? logPosition : null );
            }

            if ( fileMonitor != null )
                fileMonitor.stopMonitoringLogFile().then( () => fn() );
            else
                fn();
        
        } );

    ipcRenderer.on( 'log:simulate:file', function ( event, data ) {
        throw new Error( 'Not implemented' );
    } );


    ipcRenderer.on( 'log:simulate:begin',
        /**
         * @param {Electron.IpcRendererEvent} event 
         * @param {any} data 
         */
        async ( event, data ) => {
            stopDpsTracking();

            myCombatParser?.resetEncounter();

            if ( fileMonitor != null ) {
                // We only want to start the file monitor if we stopped it.
                // The 'log:change' event waits for a sim to end on its own 
                // before starting the file monitor again.
                simStoppedFileMonitor = true;
                await fileMonitor.stopMonitoringLogFile();
            }
        } );

    ipcRenderer.on( 'log:simulate:end',
        /**
         * @param {Electron.IpcRendererEvent} event 
         * @param {any} data 
         */
        async ( event, data ) => {
            if ( simStoppedFileMonitor ) {
                let logStats = await fs.promises.stat( logFilePath );
                await startParsingLogFile( logFilePath, logStats ? logStats.size : Number.MAX_SAFE_INTEGER );
                startDpsTracking();
            }
        } );

    ipcRenderer.on( 'log:simulate:lines',
        /**
         * 
         * @param {Electron.IpcRendererEvent} event 
         * @param {{lines: string[], padTime: number}} data 
         */
        ( event, data ) => {

            // Simulations do not render FCT.
            // TODO: Enable FCT for simulations.
            data.lines.forEach( line => parseLogEntries( line, true, data.padTime ) );
        
            sendDpsToRenderer();
        } );

    ipcRenderer.on( 'tick', function ( event, data ) {

        enableFct = data.enableFct;
        isDev = data.isDev;
        charModel = data.characterModel ? data.characterModel : charModel;
        overlays = data.overlays;

    } );
    
    ipcRenderer.on( 'combat:record-encounters',
        /**
         * 
         * @param {import("electron").IpcRendererEvent} event The event args.
         * @param {{recordEncounters: boolean}} data The data.
         */
        function ( event, data ) {
            recordEncounters = data.recordEncounters;
        } );

}


module.exports = CombatWatcher;
