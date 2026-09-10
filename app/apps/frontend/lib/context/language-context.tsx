'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchLanguageConfig,
  updateLanguageConfig,
  type SupportedLanguage,
} from '@/lib/api/config';
import { accountApi, type AccountProfile } from '@/lib/api/account';
import { useAuth } from '@/components/auth/auth-provider';
import { locales, defaultLocale, localeNames, type Locale } from '@/i18n/config';

const CONTENT_STORAGE_KEY = 'resume_matcher_content_language';
const UI_STORAGE_KEY = 'resume_matcher_ui_language';
const PROFILE_EVENT_KEY = 'careerlens_profile_changed';
const PUBLIC_UI_KEY = 'careerlens_public_ui_language';

interface LanguageContextValue {
  contentLanguage: SupportedLanguage;
  uiLanguage: Locale;
  isLoading: boolean;
  setContentLanguage: (lang: SupportedLanguage) => Promise<void>;
  setUiLanguage: (lang: Locale) => Promise<void>;
  languageNames: typeof localeNames;
  supportedLanguages: readonly Locale[];
  accountProfile: AccountProfile | null;
  preferencesError: string;
  reloadProfile: () => Promise<void>;
  applyProfile: (profile: AccountProfile) => void;
}
const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

function storedLanguage(key: string): Locale {
  try {
    const value = localStorage.getItem(key);
    if (locales.includes(value as Locale)) return value as Locale;
  } catch {
    /* Browsers may disable storage. Server preferences remain available. */
  }
  return defaultLocale;
}
function storeLanguage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage is optional. */
  }
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const mode = auth?.session?.mode;
  const userId = auth?.session?.user?.id;
  const identity = mode === 'hosted' ? `hosted:${userId ?? 'public'}` : (mode ?? 'loading');
  const activeIdentity = useRef(identity);
  const request = useRef(0);
  const [state, setState] = useState({
    identity,
    uiLanguage: defaultLocale as Locale,
    contentLanguage: defaultLocale as SupportedLanguage,
    profile: null as AccountProfile | null,
    loading: true,
    error: '',
  });
  // Never render a previous account's preference, even before effect cleanup runs.
  const current =
    state.identity === identity
      ? state
      : {
          identity,
          uiLanguage: defaultLocale,
          contentLanguage: defaultLocale,
          profile: null,
          loading: true,
          error: '',
        };

  const reloadProfile = useCallback(async () => {
    if (mode !== 'hosted' || !userId) return;
    const read = ++request.current;
    try {
      const profile = await accountApi.profile();
      if (read !== request.current || activeIdentity.current !== identity) return;
      if (profile.id !== userId) throw new Error('Account changed. Please reload.');
      setState({
        identity,
        uiLanguage: profile.ui_language,
        contentLanguage: profile.content_language,
        profile,
        loading: false,
        error: '',
      });
    } catch (cause) {
      if (read !== request.current || activeIdentity.current !== identity) return;
      setState((previous) => ({
        ...previous,
        identity,
        loading: false,
        error: cause instanceof Error ? cause.message : 'Unable to load account preferences.',
      }));
    }
  }, [identity, mode, userId]);

  const applyProfile = useCallback(
    (profile: AccountProfile) => {
      if (mode !== 'hosted' || profile.id !== userId || activeIdentity.current !== identity) return;
      request.current++;
      setState({
        identity,
        uiLanguage: profile.ui_language,
        contentLanguage: profile.content_language,
        profile,
        loading: false,
        error: '',
      });
      // Notify other tabs to read their own authenticated profile; never broadcast profile data.
      storeLanguage(
        PROFILE_EVENT_KEY,
        JSON.stringify({ id: profile.id, revision: crypto.randomUUID() })
      );
    },
    [identity, mode, userId]
  );

  useEffect(() => {
    activeIdentity.current = identity;
    const read = ++request.current;
    setState({
      identity,
      uiLanguage: defaultLocale,
      contentLanguage: defaultLocale,
      profile: null,
      loading: !!mode && (mode === 'local' || !!userId),
      error: '',
    });
    if (!mode) return;
    if (mode === 'hosted') {
      if (userId) void reloadProfile();
      else
        setState((previous) => ({
          ...previous,
          uiLanguage: storedLanguage(PUBLIC_UI_KEY),
          loading: false,
        }));
      return () => {
        request.current++;
      };
    }
    setState((previous) => ({
      ...previous,
      uiLanguage: storedLanguage(UI_STORAGE_KEY),
      contentLanguage: storedLanguage(CONTENT_STORAGE_KEY),
    }));
    void fetchLanguageConfig()
      .then((config) => {
        if (read !== request.current || activeIdentity.current !== identity) return;
        if (locales.includes(config.content_language)) {
          setState((previous) => ({ ...previous, contentLanguage: config.content_language }));
          storeLanguage(CONTENT_STORAGE_KEY, config.content_language);
        }
      })
      .catch(() => {
        /* Local mode keeps its cached preferences when offline. */
      })
      .finally(() => {
        if (read === request.current) setState((previous) => ({ ...previous, loading: false }));
      });
    return () => {
      // Invalidate every read issued during this identity, including focus refreshes.
      request.current = Math.max(read, request.current) + 1;
    };
  }, [identity, mode, userId, reloadProfile]);

  useEffect(() => {
    const refresh = () => {
      if (mode === 'hosted' && userId) void reloadProfile();
    };
    const changed = (event: StorageEvent) => {
      if (mode === 'hosted' && userId && event.key === PROFILE_EVENT_KEY) {
        try {
          if (JSON.parse(event.newValue ?? '{}').id === userId) refresh();
        } catch {
          /* Ignore invalid events. */
        }
      }
      if (mode === 'local' && [UI_STORAGE_KEY, CONTENT_STORAGE_KEY].includes(event.key ?? '')) {
        setState((previous) => ({
          ...previous,
          uiLanguage: storedLanguage(UI_STORAGE_KEY),
          contentLanguage: storedLanguage(CONTENT_STORAGE_KEY),
        }));
      }
    };
    window.addEventListener('storage', changed);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('storage', changed);
      window.removeEventListener('focus', refresh);
    };
  }, [mode, userId, reloadProfile]);

  useEffect(() => {
    document.documentElement.lang = current.uiLanguage;
  }, [current.uiLanguage]);

  const setUiLanguage = useCallback(
    async (lang: Locale) => {
      if (!locales.includes(lang)) throw new Error('Unsupported language.');
      if (mode === 'hosted' && userId) {
        applyProfile(await accountApi.updateProfile({ ui_language: lang }));
        return;
      }
      setState((previous) => ({ ...previous, uiLanguage: lang }));
      storeLanguage(mode === 'local' ? UI_STORAGE_KEY : PUBLIC_UI_KEY, lang);
    },
    [mode, userId, applyProfile]
  );

  const setContentLanguage = useCallback(
    async (lang: SupportedLanguage) => {
      if (!locales.includes(lang)) throw new Error('Unsupported language.');
      if (mode === 'hosted') {
        if (!userId) throw new Error('Sign in to save account preferences.');
        applyProfile(await accountApi.updateProfile({ content_language: lang }));
        return;
      }
      await updateLanguageConfig({ content_language: lang });
      if (activeIdentity.current !== identity) return;
      setState((previous) => ({ ...previous, contentLanguage: lang }));
      storeLanguage(CONTENT_STORAGE_KEY, lang);
    },
    [identity, mode, userId, applyProfile]
  );

  return (
    <LanguageContext.Provider
      value={{
        contentLanguage: current.contentLanguage,
        uiLanguage: current.uiLanguage,
        isLoading: current.loading,
        accountProfile: current.profile,
        preferencesError: current.error,
        setContentLanguage,
        setUiLanguage,
        reloadProfile,
        applyProfile,
        languageNames: localeNames,
        supportedLanguages: locales,
      }}
    >
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within a LanguageProvider');
  return context;
}
