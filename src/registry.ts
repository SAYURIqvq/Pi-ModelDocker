import { providerSchema, modelSchema, PiModelDockerError, type ConfigDocument, type ModelInput, type ProviderInput } from './contracts.js';
import type { CredentialResolver } from './credentials.js';
import { SqliteStore } from './store.js';

export class Registry {
  constructor(readonly store: SqliteStore) {}
  snapshot() { return this.store.read(); }
  importConfig(document: unknown, expectedRevision?: number) { return this.store.replace(document, expectedRevision); }
  exportConfig(): ConfigDocument { return this.snapshot().document; }
  private edit(update: (doc: ConfigDocument) => void): number {
    const { document, revision } = this.snapshot(); update(document); return this.store.replace(document, revision);
  }
  putProvider(provider: ProviderInput): number {
    const parsed = providerSchema.safeParse(provider);
    if (!parsed.success) throw new PiModelDockerError('invalid_config', 'Invalid provider configuration.');
    return this.edit(doc => {
      const i = doc.providers.findIndex(p => p.id === provider.id);
      if (i < 0) doc.providers.push(parsed.data); else doc.providers[i] = parsed.data;
    });
  }
  putModel(model: ModelInput): number {
    const parsed = modelSchema.safeParse(model);
    if (!parsed.success) throw new PiModelDockerError('invalid_config', 'Invalid model configuration.');
    return this.edit(doc => {
      const i = doc.models.findIndex(m => m.routeId === model.routeId);
      if (i < 0) doc.models.push(parsed.data); else doc.models[i] = parsed.data;
    });
  }
  deleteModel(routeId: string): number {
    return this.edit(doc => {
      if (!doc.models.some(m => m.routeId === routeId)) throw new PiModelDockerError('not_found', 'Route not found.');
      doc.models = doc.models.filter(m => m.routeId !== routeId);
      for (const m of doc.models) m.fallbackRouteIds = m.fallbackRouteIds.filter(id => id !== routeId);
      if (doc.selectedRouteId === routeId) doc.selectedRouteId = null;
    });
  }
  deleteProvider(providerId: string): number {
    return this.edit(doc => {
      if (!doc.providers.some(p => p.id === providerId)) throw new PiModelDockerError('not_found', 'Provider not found.');
      doc.providers = doc.providers.filter(p => p.id !== providerId);
      doc.models = doc.models.filter(m => m.providerId !== providerId);
      const remaining = new Set(doc.models.map(m => m.routeId));
      for (const m of doc.models) m.fallbackRouteIds = m.fallbackRouteIds.filter(id => remaining.has(id));
      if (doc.selectedRouteId && !remaining.has(doc.selectedRouteId)) doc.selectedRouteId = null;
    });
  }
  select(routeId: string | null): number {
    return this.edit(doc => {
      if (routeId !== null) {
        const model = doc.models.find(m => m.routeId === routeId);
        if (!model) throw new PiModelDockerError('not_found', 'Route not found.');
        if (!model.enabled || !doc.providers.find(p => p.id === model.providerId)?.enabled) throw new PiModelDockerError('unavailable', 'The model or provider is disabled.');
      }
      doc.selectedRouteId = routeId;
    });
  }
  /** Safe to forward to a UI. Does not expose addresses or credential references. */
  async catalog(credentials: CredentialResolver) {
    const { revision, document } = this.snapshot();
    const models = await Promise.all(document.models.map(async model => {
      const provider = document.providers.find(p => p.id === model.providerId)!;
      let reason: string | null = !provider.enabled || !model.enabled ? 'disabled' : null;
      if (!reason && provider.credentialRef) {
        try { if (!await credentials.resolve(provider.credentialRef)) reason = 'credential_missing'; }
        catch { reason = 'credential_unavailable'; }
      }
      return { routeId: model.routeId, providerName: provider.name, name: model.name,
        modelId: model.modelId, capabilities: model.capabilities, stream: model.stream,
        available: reason === null, unavailableReason: reason };
    }));
    return { schemaVersion: 1, catalogRevision: revision, selectedRouteId: document.selectedRouteId, models };
  }
}
