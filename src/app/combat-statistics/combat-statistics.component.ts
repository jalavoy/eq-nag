import { Component, OnInit } from '@angular/core';
import { IpcService } from '../ipc.service';
import { CharacterOptionModel } from '../core.model';

@Component( {
    selector: 'app-combat-statistics',
    templateUrl: './combat-statistics.component.html',
    styleUrls: [ './combat-statistics.component.scss', '../core.scss' ]
} )
export class CombatStatisticsComponent implements OnInit {

    public characterOptions: CharacterOptionModel[] = [];
    private _combatCharacterId: string | null = null;
    public get combatCharacterId(): string {
        return this._combatCharacterId || '';
    }
    public set combatCharacterId( value: string | null ) {
        this._combatCharacterId = value;
        this.ipcService.changeCombatCharacter( value );
    }

    constructor(
        private readonly ipcService: IpcService,
    ) { }

    ngOnInit(): void {

        this.ipcService.getCharacters().subscribe( characters => {
            this.characterOptions = characters?.length > 0 ? characters
                .sort( ( a, b ) => a.name.localeCompare( b.name ) )
                .sort( ( a, b ) => a.server.localeCompare( b.server ) )
                .map( x => ( { characterId: x.characterId, name: x.name, server: x.server, class: x.class, } ) ) : [];
        } );
        this.ipcService.tickReceived().subscribe( data => this.characterOptions = data.characterOptions?.length > 0 ? data.characterOptions : this.characterOptions );


        this.ipcService.onCombatCharacterChanged().subscribe( characterId => {
            this._combatCharacterId = characterId;
        } );

    }

    public getCombatName(): string {
        if ( this._combatCharacterId ) {
            let character = this.characterOptions.find( x => x.characterId === this._combatCharacterId );
            return character ? character.name : 'Unknown';
        } else {
            return 'Auto';
        }
    }

    public getCombatServer(): string {
        if (this._combatCharacterId) {
            let character = this.characterOptions.find( x => x.characterId === this._combatCharacterId );
            return character ? character.server : 'Unknown';
        } else {
            return 'Auto';
        }
    }

    public openCombatStatsSettings(): void {
        this.ipcService.showSettingsWindow( 'combatStatistics' );
    }

}
