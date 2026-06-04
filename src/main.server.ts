import { BootstrapContext, bootstrapApplication } from '@angular/platform-browser';
import { DataPlotter } from './app/app';
import { config } from './app/app.config.server';

const bootstrap = (context: BootstrapContext) =>
    bootstrapApplication(DataPlotter, config, context);

export default bootstrap;
