export interface CatalogAdminLoadRequest {
  controller: AbortController;
  version: number;
}

/**
 * Keeps async admin-catalog reads scoped to the currently mounted effect.
 * React StrictMode intentionally runs setup, cleanup, then setup again.
 */
export class CatalogAdminLoadLifecycle {
  private active = false;
  private version = 0;
  private controller: AbortController | null = null;

  activate(): void {
    this.active = true;
  }

  begin(): CatalogAdminLoadRequest {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.version += 1;
    return { controller, version: this.version };
  }

  isCurrent(request: CatalogAdminLoadRequest): boolean {
    return this.active && this.controller === request.controller &&
      !request.controller.signal.aborted && request.version === this.version;
  }

  isActive(): boolean {
    return this.active;
  }

  cleanup(): void {
    this.active = false;
    this.controller?.abort();
  }
}
