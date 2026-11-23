import { FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
import {
  Auth,
  GoogleAuthProvider,
  User,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { AuthState, GoogleUserProfile } from './syncTypes';

/**
 * Minimal Google Drive scope required for TestMark:
 * Grants access strictly to folders and files created or managed by TestMark
 * (SYNC_TestMark and SYNC_TestMark/BACKUP). Never requests full Drive access.
 */
export const GOOGLE_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
] as const;

const TOKEN_SAFETY_BUFFER_MS = 3 * 60 * 1000; // Renew 3 minutes before expiry
const DEFAULT_TOKEN_TTL_MS = 55 * 60 * 1000; // Conservative 55 min TTL
const SILENT_TOKEN_TIMEOUT_MS = 10_000;
const DRIVE_ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)';

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

export interface AuthRuntimeAdapter {
  isOnline: () => boolean;
  subscribeAuthState: (callback: (user: GoogleUserProfile | null) => void) => () => void;
  popupSignIn: (options: { forceAccountSelect: boolean }) => Promise<{
    user: GoogleUserProfile;
    accessToken: string | null;
  }>;
  requestGisToken: (options: {
    hint?: string;
    prompt: '' | 'consent' | 'select_account';
  }) => Promise<{ accessToken: string; expiresInSec: number; grantedScope?: string }>;
  revokeGisToken: (token: string) => Promise<void>;
  signOutProvider: () => Promise<void>;
  verifyDriveAccess: (
    accessToken: string
  ) => Promise<{ ok: boolean; status: number; email?: string }>;
}

function mapFirebaseUser(user: User): GoogleUserProfile {
  return {
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName,
    photoURL: user.photoURL,
  };
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

function createBrowserAuthAdapter(): AuthRuntimeAdapter {
  let app: FirebaseApp | null = null;
  let auth: Auth | null = null;

  const getFirebaseAuthInstance = (): Auth => {
    if (auth) return auth;
    app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    auth = getAuth(app);
    // Explicitly enforce persistent local session across app closes/reopens
    void setPersistence(auth, browserLocalPersistence).catch(() => {
      // Fallback to Firebase default persistence if IndexedDB is restricted
    });
    return auth;
  };

  return {
    isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),

    subscribeAuthState: (callback) => {
      const authInstance = getFirebaseAuthInstance();
      return onAuthStateChanged(authInstance, (user) => {
        callback(user ? mapFirebaseUser(user) : null);
      });
    },

    popupSignIn: async ({ forceAccountSelect }) => {
      const authInstance = getFirebaseAuthInstance();
      const provider = new GoogleAuthProvider();
      for (const scope of GOOGLE_DRIVE_SCOPES) {
        provider.addScope(scope);
      }
      provider.setCustomParameters({
        prompt: forceAccountSelect ? 'select_account' : 'select_account',
      });

      const result = await signInWithPopup(authInstance, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      return {
        user: mapFirebaseUser(result.user),
        accessToken: credential?.accessToken ?? null,
      };
    },

    requestGisToken: async ({ hint, prompt }) => {
      const clientId = firebaseConfig.oAuthClientId;
      if (!clientId) {
        throw new Error('Client OAuth Google non configurato.');
      }
      await ensureGisScriptLoaded();
      const oauth2 = getGoogleGlobal()?.accounts?.oauth2;
      if (!oauth2) {
        throw new Error('Modulo OAuth Google non disponibile.');
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('silent_token_timeout'));
          }
        }, SILENT_TOKEN_TIMEOUT_MS);

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

    signOutProvider: async () => {
      const authInstance = getFirebaseAuthInstance();
      await signOut(authInstance);
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
        const data = (await res.json()) as { user?: { emailAddress?: string } };
        return { ok: true, status: res.status, email: data.user?.emailAddress };
      } catch {
        return { ok: true, status: res.status };
      }
    },
  };
}

function classifyAuthError(err: unknown): { code: string; message: string } {
  const raw =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code)
      : err instanceof Error
        ? err.message
        : String(err);

  if (raw.includes('popup-closed-by-user') || raw.includes('popup_closed')) {
    return {
      code: 'popup_closed',
      message: 'Finestra di accesso Google chiusa prima del completamento.',
    };
  }
  if (raw.includes('popup-blocked') || raw.includes('popup_failed_to_open')) {
    return {
      code: 'popup_blocked',
      message:
        'Il browser ha bloccato il popup Google. Consenti i popup per questo sito e riprova.',
    };
  }
  if (raw.includes('unauthorized-domain') || raw.includes('origin_mismatch')) {
    return {
      code: 'unauthorized_domain',
      message:
        'Dominio non ancora autorizzato in Google Cloud / Firebase Console per OAuth.',
    };
  }
  if (raw.includes('access_denied') || raw.includes('insufficient_scope')) {
    return {
      code: 'permission_denied',
      message:
        'Autorizzazione Google Drive negata o revocata. Concedi nuovamente il permesso per sincronizzare.',
    };
  }
  if (raw.includes('network-request-failed') || raw.includes('Failed to fetch')) {
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
 * Autonomous Google OAuth 2.0 + Drive session manager (Phase A).
 *
 * Security invariants:
 * - Access tokens are cached STRICTLY in JS memory (never in localStorage/sessionStorage).
 * - Every token is verified against Google Drive API before marking Drive access active.
 * - On app reopen, Firebase restores the user identity and GIS silently renews the
 *   Drive access token without repeating popups when permissions remain valid.
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
  private isSigningIn = false;
  private silentRefreshPromise: Promise<string | null> | null = null;
  private unsubscribeProvider: (() => void) | null = null;
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
   * Initializes persistent session observation. Safe to call multiple times.
   */
  public init(): () => void {
    if (!this.initialized) {
      this.initialized = true;
      this.unsubscribeProvider = this.adapter.subscribeAuthState((user) => {
        void this.handleProviderAuthChange(user);
      });
    }
    return () => {
      // Keep singleton auth active while app is mounted; explicit dispose() available for tests
    };
  }

  public dispose(): void {
    if (this.unsubscribeProvider) {
      this.unsubscribeProvider();
      this.unsubscribeProvider = null;
    }
    this.clearInMemoryToken();
    this.listeners.clear();
    this.initialized = false;
  }

  private async handleProviderAuthChange(user: GoogleUserProfile | null): Promise<void> {
    if (!user) {
      this.clearInMemoryToken();
      if (!this.isSigningIn) {
        this.setState({
          status: 'signed_out',
          user: null,
          hasDriveAccess: false,
          tokenExpiresAt: null,
          errorCode: null,
          errorMessage: null,
        });
      }
      return;
    }

    // If an interactive sign-in is actively completing, let signIn() finish verifying Drive
    if (this.isSigningIn) {
      return;
    }

    // If we already have a fresh verified token in memory for this user, stay authenticated
    if (this.isTokenFresh() && this.state.user?.uid === user.uid && this.state.hasDriveAccess) {
      this.setState({
        status: 'authenticated',
        user,
        hasDriveAccess: true,
        tokenExpiresAt: this.tokenExpiresAt,
        errorCode: null,
        errorMessage: null,
      });
      return;
    }

    // App reopened with persisted user identity, but offline: keep session without nagging
    if (!this.adapter.isOnline()) {
      this.setState({
        status: 'offline_session',
        user,
        hasDriveAccess: false,
        tokenExpiresAt: null,
        errorCode: null,
        errorMessage: null,
      });
      return;
    }

    // App reopened online: attempt silent Drive token renewal (no popup!)
    this.setState({
      status: 'authenticating',
      user,
      hasDriveAccess: false,
      errorCode: null,
      errorMessage: null,
    });

    const token = await this.trySilentTokenRenewal(user);
    if (token) {
      this.setState({
        status: 'authenticated',
        user,
        hasDriveAccess: true,
        tokenExpiresAt: this.tokenExpiresAt,
        errorCode: null,
        errorMessage: null,
      });
    } else {
      // Silent renewal unavailable (e.g., revoked permissions or strict cookie policy)
      this.setState({
        status: 'needs_reauth',
        user,
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
    if (!user || !this.adapter.isOnline()) return null;

    if (this.isTokenFresh() && this.cachedAccessToken) {
      return this.cachedAccessToken;
    }

    if (this.silentRefreshPromise) {
      return this.silentRefreshPromise;
    }

    this.silentRefreshPromise = (async () => {
      try {
        const gisResult = await this.adapter.requestGisToken({
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

        const ttlMs = Math.min(
          Math.max(gisResult.expiresInSec * 1000, 5 * 60 * 1000),
          DEFAULT_TOKEN_TTL_MS
        );
        this.cachedAccessToken = gisResult.accessToken;
        this.tokenExpiresAt = Date.now() + ttlMs;
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
   * Completes account selection, ensures Drive scope is granted, and verifies Drive API access
   * before resolving as authenticated.
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

    this.isSigningIn = true;
    this.setState({
      status: 'authenticating',
      errorCode: null,
      errorMessage: null,
    });

    try {
      const popupResult = await this.adapter.popupSignIn({
        forceAccountSelect: options?.forceAccountSelect ?? true,
      });

      let token = popupResult.accessToken;
      let expiresInSec = 3300;

      // Verify Drive API reachability; if Firebase credential omitted or lacked Drive scope,
      // obtain the Drive access token via GIS inside the same user-initiated flow.
      let verified = token ? await this.adapter.verifyDriveAccess(token) : { ok: false, status: 401 };

      if (!verified.ok) {
        const gisResult = await this.adapter.requestGisToken({
          hint: popupResult.user.email || undefined,
          prompt: 'consent',
        });
        token = gisResult.accessToken;
        expiresInSec = gisResult.expiresInSec;
        verified = await this.adapter.verifyDriveAccess(token);
      }

      if (!token || !verified.ok) {
        this.clearInMemoryToken();
        this.setState({
          status: 'needs_reauth',
          user: popupResult.user,
          hasDriveAccess: false,
          tokenExpiresAt: null,
          errorCode: 'drive_access_denied',
          errorMessage:
            'Account riconosciuto ma accesso a Google Drive non autorizzato. Concedi il permesso Drive e riprova.',
        });
        return this.getState();
      }

      const ttlMs = Math.min(
        Math.max(expiresInSec * 1000, 5 * 60 * 1000),
        DEFAULT_TOKEN_TTL_MS
      );
      this.cachedAccessToken = token;
      this.tokenExpiresAt = Date.now() + ttlMs;

      this.setState({
        status: 'authenticated',
        user: popupResult.user,
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
    } finally {
      this.isSigningIn = false;
    }
  }

  /**
   * Interactive one-click Drive permission reconnection when the user identity is already
   * persisted but silent renewal was blocked or permissions were revoked.
   */
  public async reconnectDrive(): Promise<AuthState> {
    if (!this.state.user) {
      return this.signIn({ forceAccountSelect: true });
    }
    if (!this.adapter.isOnline()) {
      this.setState({
        status: 'offline_session',
        errorCode: 'offline',
        errorMessage: 'Connessione Internet assente.',
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
        hint: this.state.user.email || undefined,
        prompt: 'consent',
      });
      const verified = await this.adapter.verifyDriveAccess(gisResult.accessToken);
      if (!verified.ok) {
        throw new Error('access_denied');
      }

      const ttlMs = Math.min(
        Math.max(gisResult.expiresInSec * 1000, 5 * 60 * 1000),
        DEFAULT_TOKEN_TTL_MS
      );
      this.cachedAccessToken = gisResult.accessToken;
      this.tokenExpiresAt = Date.now() + ttlMs;

      this.setState({
        status: 'authenticated',
        hasDriveAccess: true,
        tokenExpiresAt: this.tokenExpiresAt,
        errorCode: null,
        errorMessage: null,
      });
      return this.getState();
    } catch (err) {
      // Fallback to full popup sign-in if GIS cannot resolve
      const classified = classifyAuthError(err);
      if (classified.code === 'popup_closed' || classified.code === 'permission_denied') {
        this.clearInMemoryToken();
        this.setState({
          status: 'needs_reauth',
          hasDriveAccess: false,
          tokenExpiresAt: null,
          errorCode: classified.code,
          errorMessage: classified.message,
        });
        return this.getState();
      }
      return this.signIn({ forceAccountSelect: true });
    }
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
        'Autorizzazione Google Drive scaduta o revocata. Tocca "Riconnetti Google" per riprendere la sincronizzazione.',
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
   * Signs out from Google and clears all in-memory token state.
   * Local student data is NEVER touched.
   */
  public async signOut(options?: { revokeToken?: boolean }): Promise<void> {
    const tokenToRevoke = this.cachedAccessToken;
    this.clearInMemoryToken();
    if (options?.revokeToken && tokenToRevoke) {
      await this.adapter.revokeGisToken(tokenToRevoke);
    }
    try {
      await this.adapter.signOutProvider();
    } finally {
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
}

export const googleAuth = new GoogleAuthManager();
