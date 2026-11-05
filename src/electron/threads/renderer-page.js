const urlParams = new URLSearchParams( window.location.search );
var Renderer = window.api.getRenderer();
var data = Renderer( +urlParams.get( 'originX' ), +urlParams.get( 'originY' ), urlParams.get('glowOnStart') === 'true' );

var recordEncounters = false;
function toggleRecordEncounters() {
    recordEncounters = !recordEncounters;
    window.api.recordEncounters(recordEncounters);

    if (recordEncounters) {
        document.getElementById('encounterRecordBtn').classList.add('record-enabled');
    } else {
        document.getElementById('encounterRecordBtn').classList.remove('record-enabled');
    }
}

// The security policy of this page doesn't allow inline event handlers.
document.addEventListener( 'click', e => {
    if ( e.target.closest( '.show-combat-settings' ) ) {
        window.api.showSettings( 'combatStatistics' );
    } else if ( e.target.closest( '#encounterRecordBtn' ) ) {
        toggleRecordEncounters();
    }
} );
