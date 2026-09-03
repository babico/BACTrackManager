export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
}

export interface TokenStore {
  load(): Promise<TokenBundle | null>;
  save(bundle: TokenBundle): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private bundle: TokenBundle | null = null;
  async load(): Promise<TokenBundle | null> {
    return this.bundle;
  }
  async save(bundle: TokenBundle): Promise<void> {
    this.bundle = bundle;
  }
  async clear(): Promise<void> {
    this.bundle = null;
  }
}
