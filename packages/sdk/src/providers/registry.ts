import type { ProviderAdapter } from "./adapter";

// ---------------------------------------------------------------------------
// ProviderRegistry — registered adapter map, injected into ProviderRouter.
// Consumers supply adapters via LoretOptions.adapters at construction time.
// ---------------------------------------------------------------------------

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: ProviderAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: ProviderAdapter): this {
    if (this.adapters.has(adapter.name)) {
      throw new Error(
        `ProviderRegistry: adapter "${adapter.name}" is already registered. ` +
          `Call replace() to override an existing adapter.`,
      );
    }
    this.adapters.set(adapter.name, adapter);
    return this;
  }

  /** Replace an existing adapter (e.g., to inject a test double). */
  replace(adapter: ProviderAdapter): this {
    this.adapters.set(adapter.name, adapter);
    return this;
  }

  get(provider: string): ProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  getOrThrow(provider: string): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(
        `ProviderRegistry: no adapter registered for provider "${provider}". ` +
          `Register it via new Loret({ adapters: [...] }).`,
      );
    }
    return adapter;
  }

  has(provider: string): boolean {
    return this.adapters.has(provider);
  }

  registeredNames(): string[] {
    return Array.from(this.adapters.keys());
  }
}
