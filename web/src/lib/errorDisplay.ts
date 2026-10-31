import { ApiError } from './api';
import { t } from './i18n';
import type { ApiErrorBody } from './types';

/** Every ApiErrorBody code has a matching `error.CODE` catalog entry (see
 * contracts/error-details.md and lib/i18n/en.ts's `error.*` block). */
const ERROR_CATALOG_KEY: Record<ApiErrorBody['code'], Parameters<typeof t>[0]> = {
  VALIDATION: 'error.VALIDATION',
  CONFLICT: 'error.CONFLICT',
  ADO_ERROR: 'error.ADO_ERROR',
  FORBIDDEN: 'error.FORBIDDEN',
  UNAUTHENTICATED: 'error.UNAUTHENTICATED',
  GATE_EXPIRED: 'error.GATE_EXPIRED',
  INVALID_PAT: 'error.INVALID_PAT',
  PAT_NO_ACCESS: 'error.PAT_NO_ACCESS',
  RATE_LIMITED: 'error.RATE_LIMITED',
  PAT_EXPIRED: 'error.PAT_EXPIRED',
  PAT_NO_PROJECTS: 'error.PAT_NO_PROJECTS',
  UNKNOWN_PROJECT: 'error.UNKNOWN_PROJECT',
  PROJECT_NO_ACCESS: 'error.PROJECT_NO_ACCESS',
  PROJECT_REQUIRED: 'error.PROJECT_REQUIRED',
  PROJECT_UNAVAILABLE: 'error.PROJECT_UNAVAILABLE',
  WIKI_MISSING: 'error.WIKI_MISSING',
  WIKI_PAGE_INVALID: 'error.WIKI_PAGE_INVALID',
  REPORTS_REASSIGN_REQUIRED: 'error.REPORTS_REASSIGN_REQUIRED',
  TEAM_NOT_EMPTY: 'error.TEAM_NOT_EMPTY',
  TYPE_NO_HOURS: 'error.TYPE_NO_HOURS',
};

/** Codes whose `error` text is passed straight through from Azure DevOps
 * (or, for RATE_LIMITED, describes a live condition) rather than being the
 * app's own words — FR-012 requires these to render as a translated lead
 * sentence with the untranslated upstream text shown beneath it as
 * secondary, visually-subordinate diagnostic detail (see
 * components/ui/InlineMessage.tsx's `detail` prop), never presented as if
 * the app wrote it itself. */
const DETAIL_CODES = new Set<ApiErrorBody['code']>(['ADO_ERROR', 'RATE_LIMITED']);

export interface ErrorDisplay {
  /** Always the active language's own sentence — never `err.message`. */
  message: string;
  /** The server's raw English text, only for the two upstream-passthrough
   * codes — pass to InlineMessage's `detail` prop. */
  detail?: string;
}

/** Turns any caught error into the two-part shape FR-012 describes. `fallback`
 * (a caller-supplied, context-specific translated string) is used only when
 * the failure carries no server `code` at all — a network error, or
 * anything that isn't an ApiError. */
export function describeError(err: unknown, fallback: string): ErrorDisplay {
  if (err instanceof ApiError) {
    const key = ERROR_CATALOG_KEY[err.code];
    if (key) {
      return {
        message: t(key),
        detail: DETAIL_CODES.has(err.code) && err.message ? err.message : undefined,
      };
    }
  }
  return { message: fallback };
}
