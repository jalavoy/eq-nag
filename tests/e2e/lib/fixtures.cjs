// Builds a throwaway Nag profile from made-up data. The tests never read or
// write the real settings folder.
const fs = require( 'fs' );
const path = require( 'path' );
const appVersion = require( '../../../package.json' ).version;

const alertOverlayId = 'overlayAlert0001';
const timerOverlayId = 'overlayTimer0001';
const testFolderId = 'folderTests00001';
/** A custom color, which must survive launching the app. */
const customTimerBackground = '#123456';

function overlay( overlayId, name, overlayType, x, extra = {} ) {
    return {
        overlayId, name, overlayType, x, y: 100, windowWidth: 400, windowHeight: 300,
        fontFamily: 'Roboto', fontSize: 24, lineHeight: 100, fontWeight: 400, fontColor: '#ffffff', fontTransparency: 1,
        horizontalAlignment: 'center', verticalAlignment: 'top',
        backgroundColor: '#000000', backgroundTransparency: 0, borderColor: '#000000', borderTransparency: 0,
        timerSortType: 1, timerColor: '#008000', timerBackgroundColor: null, textOverflow: null,
        showTextBorder: false, textBorderColor: '#000000', textBorderIntensity: 0,
        showTextGlow: false, textGlowColor: '#000000', textGlowIntensity: 0, textGlowSize: 0,
        groupByTarget: false, groupHeaderSize: 16, groupHeaderWeight: 400, groupHeaderColor: '#ffffff', groupMinWidth: 200,
        showTimeRemaining: true, hideTargetLabel: false, reverse: false, displayId: 1, displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
        ...extra,
    };
}

/** A trigger that shows the given text when a log line matches the phrase. */
function alertTrigger( id, phrase, text ) {
    return {
        triggerId: id, name: id, folderId: testFolderId, enabled: true, captureMethod: 'Any match', conditions: [], classLevels: [], sequentialRestartBehavior: 'none',
        capturePhrases: [ { phraseId: `p${id}`, phrase, useRegEx: true } ],
        actions: text ? [ { actionType: 0, actionId: `a${id}`, overlayId: alertOverlayId, displayText: text, duration: 120, phrases: [ `p${id}` ] } ] : [],
    };
}

const markerCount = 6;

function triggerDatabase() {
    const markers = Array.from( { length: markerCount }, ( _, i ) => alertTrigger( `marker${i + 1}`, `^MARKER${i + 1}$`, `SHOWN_${i + 1}_X` ) );
    return {
        version: 97, tags: [], installedPackages: [], installedQuickShares: [], packageOverlayMap: {}, packageOverlays: {},
        successfulTriggerExecutions: [], failedTriggerExecutions: [], exceptionHistory: [], folders: [ { folderId: testFolderId, name: 'Tests', children: [] } ],
        triggers: [
            ...markers,
            // Slow on a long line of a's, but the safe regex engine can run it.
            alertTrigger( 'slowSafe', '^(a+)+$', 'SLOW_SAFE' ),
            // Slow on a long line of c's, and only the watchdog can stop it.
            alertTrigger( 'slowHang', '^(c+)+\\1$', 'SLOW_HANG' ),
        ],
    };
}

/**
 * Creates the profile folder.
 *
 * @param {string} profile The folder to create.
 * @param {{damageTriggers?: boolean}} options damageTriggers leaves a cut-off
 * trigger file, with a good backup beside it.
 * @returns {{log: string, profile: string}} Returns the character's log file.
 */
function createProfile( profile, options = {} ) {
    fs.rmSync( profile, { recursive: true, force: true } );
    fs.mkdirSync( profile, { recursive: true } );
    const write = ( name, data ) => fs.writeFileSync( path.join( profile, name ), JSON.stringify( data ) );

    const log = path.join( profile, 'eqlog_Tester_test.txt' );
    fs.writeFileSync( log, '' );

    // Version 1 settings: the app's own migrations fill in everything else.
    // The update notes are marked as seen, and the FCT combat group question
    // as answered, so neither window opens during a run.
    write( 'user-preferences.json', {
        version: 1, setup: false, setupCompleted: true, minimizeToTrayOnLoad: false, everquestInstallFolder: path.join( profile, 'eq' ),
        windowBounds: { x: 100, y: 100, width: 1100, height: 750 }, persistentStorage: {},
        lastViewedUpdateNotes: appVersion, askForCombatGroupMigrations: false,
    } );
    write( 'overlays-database.json', {
        version: 19, fctCombatGroups: [],
        overlays: [
            overlay( alertOverlayId, 'Test alerts', 'Alert', 100 ),
            overlay( timerOverlayId, 'Test timers', 'Timer', 600, { timerBackgroundColor: customTimerBackground } ),
        ],
    } );
    write( 'characters-database.json', {
        version: 13, triggerProfiles: [],
        characters: [ {
            characterId: 'testerCharacter1', name: 'Tester', server: 'test', class: 'Wizard', logFile: log,
            p99: false, takp: false, daybreak: true, disabledTriggers: [], disableTriggersByDefault: false, disableFct: false,
        } ],
    } );

    const triggers = triggerDatabase();
    if ( options.damageTriggers ) {
        fs.writeFileSync( path.join( profile, 'trigger-database.json' ), JSON.stringify( triggers ).slice( 0, 500 ) );
        fs.writeFileSync( path.join( profile, 'trigger-database.json.bak' ), JSON.stringify( triggers ) );
    } else {
        write( 'trigger-database.json', triggers );
    }
    return { profile, log };
}

module.exports = { createProfile, alertOverlayId, timerOverlayId, customTimerBackground, markerCount };
