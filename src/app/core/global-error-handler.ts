import { HttpErrorResponse } from '@angular/common/http';
import { ErrorHandler, Injectable, NgZone } from '@angular/core';
import { IpcService } from '../ipc.service';

@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
    constructor(
        private ipcService: IpcService
    ) { }

    handleError( error: Error | any ) {
        if ( error instanceof Error ) {
            this.ipcService.logException( error.stack );
        } else if ( error instanceof HttpErrorResponse ) {
            // This object has functions in its headers, so it can't be sent to the main process.
            this.ipcService.logException( error.message );
        } else {
            this.ipcService.logException( error );
        }

        console.error( error );
    }
}
