/** Backreferences and lookaround.  V8's linear-time engine can't run patterns that use these, so they can still hang. */
const rgxNeedsBacktracking = /\\[1-9]|\\k<|\(\?[=!]|\(\?<[=!]/;
/** The start of an unbounded quantifier: *, + or {n,}. */
const rgxUnboundedQuantifier = /^(?:[*+]|\{\d+,\})/;
/** Nag's short codes, such as {S} and {N1}, which become unbounded patterns. */
const rgxShortCode = /^\{[A-Za-z]\w*\}/;









/**
 * Returns true if the given pattern repeats a group that can itself match in
 * many ways, such as (a+)+ or (a|b)+.  These are the patterns that can take
 * exponentially longer as the text gets longer.
 *
 * @param {string} pattern The regular expression pattern.
 */
function hasNestedRepetition( pattern ) {
    /** @type {{ repeats: boolean }[]} */
    const groups = [ { repeats: false } ];

    for ( let i = 0; i < pattern.length; i++ ) {
        const c = pattern[ i ];

        if ( c === '\\' ) {
            i++;
        } else if ( c === '[' ) {
            for ( i++; i < pattern.length && pattern[ i ] !== ']'; i++ ) {
                if ( pattern[ i ] === '\\' ) {
                    i++;
                }
            }
        } else if ( c === '(' ) {
            groups.push( { repeats: false } );
        } else if ( c === '|' ) {
            groups[ groups.length - 1 ].repeats = true;
        } else if ( c === ')' && groups.length > 1 ) {
            const group = groups.pop();
            const unbounded = rgxUnboundedQuantifier.test( pattern.slice( i + 1 ) );

            if ( group.repeats && unbounded ) {
                return true;
            }
            if ( group.repeats || unbounded ) {
                groups[ groups.length - 1 ].repeats = true;
            }
        } else if ( rgxShortCode.test( pattern.slice( i ) ) || rgxUnboundedQuantifier.test( pattern.slice( i ) ) ) {
            groups[ groups.length - 1 ].repeats = true;
        }
    }

    return false;
}









/**
 * Returns the text of every regular expression phrase in the given trigger.
 *
 * @param {any} value The trigger, or any part of it.
 * @returns {string[]} The patterns.
 */
function getRegexPhrases( value ) {
    if ( value == null || typeof value !== 'object' ) {
        return [];
    }

    const phrases = value.useRegEx === true && typeof value.phrase === 'string' ? [ value.phrase ] : [];

    return phrases.concat( ...Object.values( value ).map( getRegexPhrases ) );
}









/**
 * Returns true if the trigger has a phrase that could hang the app even with
 * V8's linear-time fallback.
 *
 * @param {any} trigger The trigger to evaluate.
 */
function canHang( trigger ) {
    return getRegexPhrases( trigger ).some( pattern => hasNestedRepetition( pattern ) && rgxNeedsBacktracking.test( pattern ) );
}









/**
 * Returns true if the trigger has a phrase with a shape that is known to be slow.
 *
 * @param {any} trigger The trigger to evaluate.
 */
function isSuspect( trigger ) {
    return getRegexPhrases( trigger ).some( hasNestedRepetition );
}

module.exports = { hasNestedRepetition, canHang, isSuspect };
