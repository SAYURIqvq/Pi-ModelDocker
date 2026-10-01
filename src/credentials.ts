export interface CredentialResolver { resolve(reference: string): Promise<string | undefined> }
/** Secrets stay outside the registry. Implement this interface for an OS vault. */
export class Credentials implements CredentialResolver {
  #memory = new Map<string, string>();
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}
  set(reference: `memory:${string}`, key: string): void {
    if (!/^memory:[\w.-]+$/.test(reference) || !key.trim()) throw new Error('Invalid credential input.');
    this.#memory.set(reference, key.trim());
  }
  delete(reference: string): void { this.#memory.delete(reference); }
  async resolve(reference: string): Promise<string | undefined> {
    const key = reference.startsWith('env:') ? this.env[reference.slice(4)] : this.#memory.get(reference);
    return key?.trim() || undefined;
  }
}
