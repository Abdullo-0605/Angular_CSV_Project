import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render title', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Data Plotter');
  });

  // Renaming the root component without updating index.html renders a blank
  // page with no error anywhere, so assert the host element actually matches.
  it('index.html hosts the root component selector', () => {
    const html = readFileSync(join(process.cwd(), 'src/index.html'), 'utf8');
    expect(html).toContain('<app-root>');
  });
});
