import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import { useAgentPlatform } from "@werft-ai/react";
import { useEffect, useRef } from "react";
import { queryKeys } from "../api/queries.ts";
import { useMe } from "../auth/guard.tsx";
import { type Locale, useI18n } from "./i18n.tsx";

/**
 * Keeps the signed-in user's saved language and this browser's in step,
 * since Slack writes to the user in the saved one: it wins when the console
 * opens, and a language picked here is saved. Opening the console saves
 * nothing. A failed save is not retried until the language changes again;
 * the console still switches.
 */
export function useSavedLocale() {
  const saved = useMe()?.user?.locale;
  const { locale, setLocale } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const { mutate: save } = useMutation<unknown, ApiError, Locale>({
    mutationFn: (next) =>
      unwrap(client.PATCH("/v1/auth/me", { body: { locale: next } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
  // Undefined until the saved language is first seen.
  const sent = useRef<Locale | null | undefined>(undefined);
  useEffect(() => {
    // Not loaded, an API key, or an API from before the field.
    if (saved === undefined) return;
    if (sent.current === undefined) {
      // One never saved stays unsaved until the person picks one.
      sent.current = saved ?? locale;
      if (saved !== null && saved !== locale) {
        setLocale(saved);
        return;
      }
    }
    if (locale === saved || locale === sent.current) return;
    sent.current = locale;
    save(locale);
  }, [saved, locale, setLocale, save]);
}
