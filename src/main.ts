import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { DataPlotter } from './app/app';

bootstrapApplication(DataPlotter, appConfig)
  .catch((err) => console.error(err));
