// Everything that depends on how the main window's HTML looks is here, so a
// Material upgrade only has to update this file.
const { sleep } = require( './app.cjs' );

const selectors = {
    tab: '.mat-tab-label',
    triggersMenuButton: 'app-triggers button[aria-label="Example icon-button with a menu"]',
    folderName: '.tree-click-target',
    dialog: 'mat-dialog-container',
    selectedStep: '.mat-step-header[aria-selected="true"]',
    selectBox: 'mat-select .mat-select-trigger',
    selectOption: 'mat-option',
    clickable: 'button, [role="menuitem"], .mat-select-trigger, mat-option',
};

const topDialog = `[ ...document.querySelectorAll( '${selectors.dialog}' ) ].pop()`;

/** Clicks the last visible control with exactly this text. */
function click( page, text ) {
    return page.eval( `( () => {
        const all = [ ...document.querySelectorAll( '${selectors.clickable}' ) ].filter( e => e.innerText.trim() === ${JSON.stringify( text )} && !e.disabled );
        all[ all.length - 1 ].click();
        return true;
    } )()` );
}

/** Clicks the element with exactly this text, waiting for it to be drawn. */
async function clickWhenDrawn( page, selector, text, what ) {
    const texts = () => page.eval( `[ ...document.querySelectorAll( '${selector}' ) ].map( e => e.innerText.trim() )` );
    for ( let i = 0; i < 40; i++ ) {
        if ( ( await texts() ).includes( text ) ) {
            return page.eval( `[ ...document.querySelectorAll( '${selector}' ) ].find( e => e.innerText.trim() === ${JSON.stringify( text )} ).click()` );
        }
        await sleep( 500 );
    }
    throw new Error( `The ${what} "${text}" never appeared. Found: ${JSON.stringify( await texts() )}` );
}

function openTab( page, name ) {
    return clickWhenDrawn( page, selectors.tab, name, 'tab' );
}

function selectFolder( page, name ) {
    return clickWhenDrawn( page, selectors.folderName, name, 'folder' );
}

function openTriggersMenu( page ) {
    return page.eval( `document.querySelector( '${selectors.triggersMenuButton}' ).click()` );
}

/** Opens one of the Auto Generation items in the Triggers tab's menu. */
async function openGenerator( page, name ) {
    await openTriggersMenu( page );
    await sleep( 500 );
    await click( page, 'Auto Generation' );
    await sleep( 500 );
    await click( page, name );
    await sleep( 900 );
}

function dialogText( page ) {
    return page.eval( `${topDialog}?.innerText ?? ''` );
}

/** Types into the first text box of the top dialog. */
function typeInDialog( page, text ) {
    return page.eval( `( () => {
        const input = [ ...${topDialog}.querySelectorAll( 'input' ) ].find( i => i.type === 'text' );
        input.value = ${JSON.stringify( text )};
        input.dispatchEvent( new Event( 'input', { bubbles: true } ) );
        return true;
    } )()` );
}

function dialogHasInputValue( page, value ) {
    return page.eval( `[ ...document.querySelectorAll( '${selectors.dialog} input' ) ].some( i => i.value === ${JSON.stringify( value )} )` );
}

function currentStep( page ) {
    return page.eval( `${topDialog}?.querySelector( '${selectors.selectedStep}' )?.innerText ?? ''` );
}

/** Picks the first option of the first select box in the top dialog. */
async function pickFirstOption( page ) {
    await page.eval( `${topDialog}.querySelector( '${selectors.selectBox}' ).click()` );
    await sleep( 400 );
    await page.eval( `document.querySelector( '${selectors.selectOption}' ).click()` );
    await sleep( 500 );
}

function hasButton( page, pattern ) {
    return page.eval( `[ ...document.querySelectorAll( 'button' ) ].some( b => ${pattern}.test( b.innerText ) )` );
}

module.exports = { click, openTab, selectFolder, openTriggersMenu, openGenerator, dialogText, typeInDialog, dialogHasInputValue, currentStep, pickFirstOption, hasButton };
