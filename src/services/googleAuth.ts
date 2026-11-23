import { AuthState, GoogleUserProfile } from './syncTypes';

/**
 * Minimal Google Drive scope required for TestMark:
 * Grants access strictly to folders and files created or managed by TestMark
 * (SYNC_TestMark and SYNC_TestMark/BACKUP). Never requests full Drive access.
 */
export const GOOGLE_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
] as const;

const PROFILE_HINT_STORAGE_KEY = 'testmark_google_profile_hint_v1';
const TOKEN_SAFETY_BUFFER_MS = 3 * 60 * 1000; // Renew 3 minutes before expiry
const DEFAULT_TOKEN_TTL_MS = 55 * 60 * 1000; // Conservative 55 min TTL
const SILENT_TOKEN_TIMEOUT_MS = 10_000;
const DRIVE_ABOUT_URL =
  'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName,photoLink,permissionId)';

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken: (overrideConfig?: {
    prompt?: string;
    hint?: string;
    scope?: string;
  }) => void;
}

interface GoogleIdentityGlobal {
  accounts?: {
    oauth2?: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        hint?: string;
        callback: (response: GisTokenResponse) => void;
        error_callback?: (error: { type?: string; message?: string }) => void;
      }) => GisTokenClient;
      revoke: (token: string, done?: () => void) => void;
    };
  };
}

export interface DriveUserVerificationResult {
  ok: boolean;
  status: number;
  user?: GoogleUserProfile;
}

export interface AuthRuntimeAdapter {
  isOnline: () => boolean;
  getClientId: () => string;
  loadProfileHint: () => GoogleUserProfile | null;
  saveProfileHint: (user: GoogleUserProfile | null) => void;
  requestGisToken: (options: {
    clientId: string;
    hint?: string;
    prompt: '' | 'consent' | 'select_account';
  }) => Promise<{ accessToken: string; expiresInSec: number; grantedScope?: string }>;
  revokeGisToken: (token: string) => Promise<void>;
  verifyDriveAccess: (accessToken: string) => Promise<DriveUserVerificationResult>;
}

function getGoogleGlobal(): GoogleIdentityGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { google?: GoogleIdentityGlobal }).google;
}

let gisScriptPromise: Promise<void> | null = null;

function ensureGisScriptLoaded(): Promise<void> {
  if (getGoogleGlobal()?.accounts?.oauth2) {
    return Promise.resolve();
  }
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('Ambiente browser non disponibile per GIS.'));
  }
  if (gisScriptPromise) return gisScriptPromise;

  gisScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src*="accounts.google.com/gsi/client"]'
    );
    if (existing) {
      const checkReady = (attemptsLeft: number) => {
        if (getGoogleGlobal()?.accounts?.oauth2) {
          resolve();
        } else if (attemptsLeft <= 0) {
          gisScriptPromise = null;
          reject(new Error('Google Identity Services non disponibile.'));
        } else {
          window.setTimeout(() => checkReady(attemptsLeft - 1), 150);
        }
      };
      checkReady(40);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (getGoogleGlobal()?.accounts?.oauth2) {
        resolve();
      } else {
        gisScriptPromise = null;
        reject(new Error('Google Identity Services caricato ma non inizializzato.'));
      }
    };
    script.onerror = () => {
      gisScriptPromise = null;
      reject(new Error('Impossibile caricare Google Identity Services.'));
    };
    document.head.appendChild(script);
  });

  return gisScriptPromise;
}

function readConfiguredGoogleClientId(): string {
  try {
    const metaEnv = (
      import.meta as unknown as { env?: Record<string, string | undefined> }
    )?.env;
    const raw = (metaEnv?.VITE_GOOGLE_CLIENT_ID || '').trim();
    if (!raw || raw.startsWith('YOUR_GOOGLE_OAUTH_')) {
      return '';
    }
    return raw;
  } catch {
    return '';
  }
}

function createBrowserAuthAdapter(): AuthRuntimeAdapter {
  return {
    isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),

    getClientId: () => readConfiguredGoogleClientId(),

    /**
     * Stores ONLY the non-sensitive user email/displayName hint so TestMark can
     * silently re-request a fresh Drive token on reopen. NEVER stores tokens or secrets.
     */
    loadProfileHint: () => {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return null;
        const raw = window.localStorage.getItem(PROFILE_HINT_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<GoogleUserProfile>;
        if (!parsed || typeof parsed.email !== 'string' || !parsed.email.includes('@')) {
          return null;
        }
        return {
          uid: typeof parsed.uid === 'string' ? parsed.uid : parsed.email,
          email: parsed.email,
          displayName: typeof parsed.displayName === 'string' ? parsed.displayName : null,
          photoURL: typeof parsed.photoURL === 'string' ? parsed.photoURL : null,
        };
      } catch {
        return null;
      }
    },

    saveProfileHint: (user) => {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return;
        if (!user) {
          window.localStorage.removeItem(PROFILE_HINT_STORAGE_KEY);
          return;
        }
        const safeProfile: GoogleUserProfile = {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL,
        };
        window.localStorage.setItem(
          PROFILE_HINT_STORAGE_KEY,
          JSON.stringify(safeProfile)
        );
      } catch {
        // Never break auth if storage is restricted
      }
    },

    requestGisToken: async ({ clientId, hint, prompt }) => {
      if (!clientId) {
        throw new Error('oauth_client_not_configured');
      }
      await ensureGisScriptLoaded();
      const oauth2 = getGoogleGlobal()?.accounts?.oauth2;
      if (!oauth2) {
        throw new Error('gis_unavailable');
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        const timeoutMs = prompt === '' ? SILENT_TOKEN_TIMEOUT_MS : 120_000;
        const timer = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(
              new Error(prompt === '' ? 'silent_token_timeout' : 'popup_timeout')
            );
          }
        }, timeoutMs);

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          fn();
        };

        const client = oauth2.initTokenClient({
          client_id: clientId,
          scope: GOOGLE_DRIVE_SCOPES.join(' '),
          hint,
          callback: (resp) => {
            if (resp.error || !resp.access_token) {
              finish(() =>
                reject(new Error(resp.error || 'access_token_missing'))
              );
              return;
            }
            const parsedExpires = Number(resp.expires_in);
            const expiresInSec =
              Number.isFinite(parsedExpires) && parsedExpires > 0
                ? parsedExpires
                : 3500;
            finish(() =>
              resolve({
                accessToken: resp.access_token as string,
                expiresInSec,
                grantedScope: resp.scope,
              })
            );
          },
          error_callback: (err) => {
            finish(() =>
              reject(new Error(err?.type || err?.message || 'gis_popup_error'))
            );
          },
        });

        client.requestAccessToken({
          prompt,
          hint,
        });
      });
    },

    revokeGisToken: async (token) => {
      const oauth2 = getGoogleGlobal()?.accounts?.oauth2;
      if (!oauth2 || !token) return;
      await new Promise<void>((resolve) => {
        try {
          oauth2.revoke(token, () => resolve());
        } catch {
          resolve();
        }
      });
    },

    verifyDriveAccess: async (accessToken) => {
      const res = await fetch(DRIVE_ABOUT_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        cache: 'no-store',
      });
      if (!res.ok) {
        return { ok: false, status: res.status };
      }
      try {
        const data = (await res.json()) as {
          user?: {
            emailAddress?: string;
            displayName?: string;
            photoLink?: string;
            permissionId?: string;
          };
        };
        const email = data.user?.emailAddress || '';
        return {
          ok: true,
          status: res.status,
          user: email
            ? {
                uid: data.user?.permissionId || email,
                email,
                displayName: data.user?.displayName || null,
                photoURL: data.user?.photoLink || null,
              }
            : undefined,
        };
      } catch {
        return { ok: true, status: res.status };
      }
    },
  };
}

function classifyAuthError(err: unknown): { code: string; message: string } {
  const raw = err instanceof Error ? err.message : String(err);

  if (raw.includes('oauth_client_not_configured')) {
    return {
      code: 'not_configured',
      message:
        'Client ID OAuth Google non configurato. Imposta la variabile VITE_GOOGLE_CLIENT_ID nelle impostazioni del repository GitHub (o in .env.local).',
    };
  }
  if (raw.includes('popup_closed') || raw.includes('popup-closed')) {
    return {
      code: 'popup_closed',
      message: 'Finestra di accesso Google chiusa prima del completamento.',
    };
  }
  if (raw.includes('popup_failed_to_open') || raw.includes('popup_blocked')) {
    return {
      code: 'popup_blocked',
      message:
        'Il browser ha bloccato il popup Google. Consenti i popup per questo sito e riprova.',
    };
  }
  if (raw.includes('origin_mismatch') || raw.includes('unauthorized')) {
    return {
      code: 'unauthorized_domain',
      message:
        'Origine non autorizzata in Google Cloud Console. Aggiungi https://adrianoruzza.github.io tra le Origini JavaScript autorizzate.',
    };
  }
  if (raw.includes('access_denied') || raw.includes('insufficient_scope')) {
    return {
      code: 'permission_denied',
      message:
        'Autorizzazione Google Drive negata o revocata. Concedi nuovamente il permesso per sincronizzare.',
    };
  }
  if (raw.includes('Failed to fetch') || raw.includes('network')) {
    return {
      code: 'network_error',
      message: 'Connessione assente o instabile durante la verifica dell’account Google.',
    };
  }
  return {
    code: 'auth_failed',
    message: 'Accesso Google non completato. Riprova o verifica le autorizzazioni.',
  };
}

/**
 * Autonomous Google OAuth 2.0 + Drive session manager (Phase A — Pure GIS, Zero API Keys).
 *
 * Security invariants:
 * - Zero Google API Keys (AIza...), zero OAuth Client Secrets, zero hardcoded credentials.
 * - Uses ONLY a public OAuth 2.0 Web Client ID supplied via VITE_GOOGLE_CLIENT_ID.
 * - Access tokens are cached STRICTLY in JS memory (never in localStorage/sessionStorage).
 * - Every token is verified against Google Drive API before marking Drive access active.
 */
export class GoogleAuthManager {
  private readonly adapter: AuthRuntimeAdapter;
  private state: AuthState = {
    status: 'initializing',
    user: null,
    hasDriveAccess: false,
    tokenExpiresAt: null,
    errorCode: null,
    errorMessage: null,
  };

  // In-memory access token cache (NEVER persisted to Web Storage)
  private cachedAccessToken: string | null = null;
  private tokenExpiresAt: number | null = null;
  private silentRefreshPromise: Promise<string | null> | null = null;
  private listeners = new Set<(state: AuthState) => void>();
  private initialized = false;

  constructor(adapter?: AuthRuntimeAdapter) {
    this.adapter = adapter ?? createBrowserAuthAdapter();
  }

  public getState(): AuthState {
    return { ...this.state };
  }

  public subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<AuthState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private clearInMemoryToken(): void {
    this.cachedAccessToken = null;
    this.tokenExpiresAt = null;
  }

  private isTokenFresh(): boolean {
    return (
      Boolean(this.cachedAccessToken) &&
      this.tokenExpiresAt !== null &&
      Date.now() < this.tokenExpiresAt - TOKEN_SAFETY_BUFFER_MS
    );
  }

  /**
   * Initializes session restoration on app startup without opening unrequested popups.
   */
  public init(): () => void {
    if (!this.initialized) {
      this.initialized = true;
      void this.restoreSessionOnStartup();
    }
    return () => {
      // Singleton remains active while mounted; use dispose() in tests
    };
  }

  public dispose(): void {
    this.clearInMemoryToken();
    this.listeners.clear();
    this.initialized = false;
  }

  private async restoreSessionOnStartup(): Promise<void> {
    const savedProfile = this.adapter.loadProfileHint();
    if (!savedProfile) {
      this.setState({
        status: 'signed_out',
        user: null,
        hasDriveAccess: false,
        tokenExpiresAt: null,
        errorCode: null,
        errorMessage: null,
      });
      return;
    }

    if (!this.adapter.isOnline()) {
      this.setState({
        status: 'offline_session',
        user: savedProfile,
        hasDriveAccess: false,
        tokenExpiresAt: null,
        errorCode: null,
        errorMessage: null,
      });
      return;
    }

    const clientId = this.adapter.getClientId();
    if (!clientId) {
      this.setState({
        status: 'needs_reauth',
        user: savedProfile,
        hasDriveAccess: false,
        tokenExpiresAt: null,
        errorCode: 'not_configured',
        errorMessage:
          'Client ID OAuth Google non configurato (VITE_GOOGLE_CLIENT_ID).',
      });
      return;
    }

    this.setState({
      status: 'authenticating',
      user: savedProfile,
      hasDriveAccess: false,
      errorCode: null,
      errorMessage: null,
    });

    const token = await this.trySilentTokenRenewal(savedProfile);
    if (token) {
      this.setState({
        status: 'authenticated',
        user: this.state.user ?? savedProfile,
        hasDriveAccess: true,
        tokenExpiresAt: this.tokenExpiresAt,
        errorCode: null,
        errorMessage: null,
      });
    } else {
      this.setState({
        status: 'needs_reauth',
        user: savedProfile,
        hasDriveAccess: false,
        tokenExpiresAt: null,
        errorCode: 'reauth_required',
        errorMessage:
          'Sessione Google rilevata, ma è necessario rinnovare il permesso per accedere a Google Drive.',
      });
    }
  }

  /**
   * Attempts silent OAuth token refresh via GIS (`prompt: ''`) and verifies real Drive access.
   * Deduplicates concurrent refresh attempts.
   */
  public async trySilentTokenRenewal(
    explicitUser?: GoogleUserProfile | null
  ): Promise<string | null> {
    const user = explicitUser ?? this.state.user;
    const clientId = this.adapter.getClientId();
    if (!user || !clientId || !this.adapter.isOnline()) return null;

    if (this.isTokenFresh() && this.cachedAccessToken) {
      return this.cachedAccessToken;
    }

    if (this.silentRefreshPromise) {
      return this.silentRefreshPromise;
    }

    this.silentRefreshPromise = (async () => {
      try {
        const gisResult = await this.adapter.requestGisToken({
          clientId,
          hint: user.email || undefined,
          prompt: '',
        });

        if (
          gisResult.grantedScope &&
          !gisResult.grantedScope.includes('drive.file')
        ) {
          this.clearInMemoryToken();
          return null;
        }

        const verify = await this.adapter.verifyDriveAccess(gisResult.accessToken);
        if (!verify.ok) {
          this.clearInMemoryToken();
          return null;
        }

        const resolvedUser = verify.user ?? user;
        this.adapter.saveProfileHint(resolvedUser);

        const ttlMs = Math.min(
          Math.max(gisResult.expiresInSec * 1000, 5 * 60 * 1000),
          DEFAULT_TOKEN_TTL_MS
        );
        this.cachedAccessToken = gisResult.accessToken;
        this.tokenExpiresAt = Date.now() + ttlMs;
        this.state = { ...this.state, user: resolvedUser };
        return this.cachedAccessToken;
      } catch {
        this.clearInMemoryToken();
        return null;
      } finally {
        this.silentRefreshPromise = null;
      }
    })();

    return this.silentRefreshPromise;
  }

  /**
   * Interactive Google Sign-In triggered by an explicit user click.
   * Uses Google Identity Services OAuth 2.0 (no API keys, no client secrets)
   * and verifies real Drive access before completing authentication.
   */
  public async signIn(options?: { forceAccountSelect?: boolean }): Promise<AuthState> {
    if (!this.adapter.isOnline()) {
      this.setState({
        status: this.state.user ? 'offline_session' : 'error',
        errorCode: 'offline',
        errorMessage:
          'Connessione Internet assente. I dati locali restano disponibili; accedi quando torni online.',
      });
      return this.getState();
    }

    const clientId = this.adapter.getClientId();
    if (!clientId) {
      const classified = classifyAuthError(new Error('oauth_client_not_configured'));
      this.setState({
        status: this.state.user ? 'needs_reauth' : 'error',
        hasDriveAccess: false,
        errorCode: classified.code,
        errorMessage: classified.message,
      });
      return this.getState();
    }

    this.setState({
      status: 'authenticating',
      errorCode: null,
      errorMessage: null,
    });

    try {
      const gisResult = await this.adapter.requestGisToken({
        clientId,
        hint: options?.forceAccountSelect ? undefined : this.state.user?.email,
        prompt: options?.forceAccountSelect ? 'select_account' : 'consent',
      });

      if (
        gisResult.grantedScope &&
        !gisResult.grantedScope.includes('drive.file')
      ) {
        throw new Error('insufficient_scope');
      }

      const verified = await this.adapter.verifyDriveAccess(gisResult.accessToken);
      if (!verified.ok) {
        throw new Error('access_denied');
      }

      const resolvedUser: GoogleUserProfile =
        verified.user ??
        this.state.user ?? {
          uid: 'google_drive_user',
          email: 'Account Google',
          displayName: null,
          photoURL: null,
        };

      const ttlMs = Math.min(
        Math.max(gisResult.expiresInSec * 1000, 5 * 60 * 1000),
        DEFAULT_TOKEN_TTL_MS
      );
      this.cachedAccessToken = gisResult.accessToken;
      this.tokenExpiresAt = Date.now() + ttlMs;
      this.adapter.saveProfileHint(resolvedUser);

      this.setState({
        status: 'authenticated',
        user: resolvedUser,
        hasDriveAccess: true,
        tokenExpiresAt: this.tokenExpiresAt,
        errorCode: null,
        errorMessage: null,
      });
      return this.getState();
    } catch (err) {
      const classified = classifyAuthError(err);
      this.clearInMemoryToken();
      this.setState({
        status: this.state.user ? 'needs_reauth' : 'signed_out',
        hasDriveAccess: false,
        tokenExpiresAt: null,
        errorCode: classified.code,
        errorMessage: classified.message,
      });
      return this.getState();
    }
  }

  /**
   * Interactive one-click Drive permission reconnection when the account hint exists
   * but silent renewal was blocked or permissions were revoked.
   */
  public async reconnectDrive(): Promise<AuthState> {
    if (!this.state.user) {
      return this.signIn({ forceAccountSelect: true });
    }
    return this.signIn({ forceAccountSelect: false });
  }

  /**
   * Returns a valid Drive access token from memory, silently renewing it if near expiry.
   * Never opens an unrequested popup.
   */
  public async getValidAccessToken(options?: { forceRefresh?: boolean }): Promise<string | null> {
    if (!this.state.user) return null;
    if (!options?.forceRefresh && this.isTokenFresh() && this.cachedAccessToken) {
      return this.cachedAccessToken;
    }

    if (options?.forceRefresh) {
      this.clearInMemoryToken();
    }

    if (!this.adapter.isOnline()) {
      this.setState({
        status: 'offline_session',
        hasDriveAccess: false,
      });
      return null;
    }

    const renewed = await this.trySilentTokenRenewal(this.state.user);
    if (renewed) {
      this.setState({
        status: 'authenticated',
        hasDriveAccess: true,
        tokenExpiresAt: this.tokenExpiresAt,
        errorCode: null,
        errorMessage: null,
      });
      return renewed;
    }

    this.setState({
      status: 'needs_reauth',
      hasDriveAccess: false,
      tokenExpiresAt: null,
      errorCode: 'reauth_required',
      errorMessage:
        'Autorizzazione Google Drive scaduta o revocata. Tocca "Riconnetti Google Drive" per riprendere la sincronizzazione.',
    });
    return null;
  }

  /**
   * Called by Drive client when an API call returns HTTP 401/403 (revoked/expired token).
   * Attempts one silent renewal; if that fails, marks session as needs_reauth.
   */
  public async handleUnauthorizedResponse(): Promise<string | null> {
    return this.getValidAccessToken({ forceRefresh: true });
  }

  /**
   * Called when browser transitions from offline -> online so an offline_session
   * silently restores Drive access without user intervention.
   */
  public async handleNetworkRestored(): Promise<boolean> {
    if (!this.state.user) return false;
    if (this.isTokenFresh() && this.state.hasDriveAccess) return true;
    const token = await this.getValidAccessToken();
    return Boolean(token);
  }

  /**
   * Signs out from Google, clears in-memory token and profile hint.
   * Local student data is NEVER touched.
   */
  public async signOut(options?: { revokeToken?: boolean }): Promise<void> {
    const tokenToRevoke = this.cachedAccessToken;
    this.clearInMemoryToken();
    this.adapter.saveProfileHint(null);
    if (options?.revokeToken && tokenToRevoke) {
      await this.adapter.revokeGisToken(tokenToRevoke);
    }
    this.setState({
      status: 'signed_out',
      user: null,
      hasDriveAccess: false,
      tokenExpiresAt: null,
      errorCode: null,
      errorMessage: null,
    });
  }
}

export const googleAuth = new GoogleAuthManager();
