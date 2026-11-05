// Prints test results and works out the exit code.
let passed = 0;
let failed = 0;

function check( name, ok, detail ) {
    if ( ok ) passed++; else failed++;
    console.log( `${ok ? 'PASS' : 'FAIL'} ${name}${detail != null && detail !== '' ? ` (${detail})` : ''}` );
}

/** Prints the totals and ends the process, failing if anything failed. */
function finish() {
    console.log( `\n${passed} passed, ${failed} failed` );
    process.exit( failed ? 1 : 0 );
}

/** Reports a test script that couldn't finish, and ends the process. */
function abort( error ) {
    console.error( error );
    console.log( `\n${passed} passed, ${failed} failed, and the run stopped early` );
    process.exit( 1 );
}

module.exports = { check, finish, abort };
