import { useEffect, useState } from 'react';
import { InlineMessage } from '../../components/ui/InlineMessage';
import { LoadingView } from '../../components/StatusView';
import { useBlockedConvention, useSaveBlockedConvention } from '../../lib/useScrum';
import type { BlockedConventionRule } from '../../lib/types';
import { useTranslation } from '../../lib/i18n';
import { Foreign } from '../../components/ui/Foreign';

/** A rule read back from the wiki (validateConvention/normalizeStore both
 * accept one with only `field` set, e.g. a hand-edited blob) may be missing
 * `states`/`tags` entirely — never assume they're arrays. */
function normalizeRule(rule?: Partial<BlockedConventionRule> | null): BlockedConventionRule {
  return { states: rule?.states ?? [], tags: rule?.tags ?? [], field: rule?.field ?? null, fieldBlockedValue: rule?.fieldBlockedValue };
}

function normalizeByType(byType: Record<string, Partial<BlockedConventionRule>> | undefined | null): Record<string, BlockedConventionRule> {
  return Object.fromEntries(Object.entries(byType ?? {}).map(([type, rule]) => [type, normalizeRule(rule)]));
}

/** FR-035c-iii: every choice offered here comes from `options` — the
 * project's REAL states/tags/fields — never typed freehand, so a convention
 * naming something the project doesn't have can't be constructed. */
export function BlockedConventionEditor({ sprintPath, onClose }: { sprintPath: string | null; onClose: () => void }) {
  const t = useTranslation();
  const { data: envelope, isLoading } = useBlockedConvention(sprintPath);
  const save = useSaveBlockedConvention(sprintPath);
  const [byType, setByType] = useState<Record<string, BlockedConventionRule>>({});
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (!envelope?.data || seeded) return;
    const initial = Object.keys(envelope.data.convention.byType).length > 0 ? envelope.data.convention.byType : envelope.data.suggestion?.byType ?? {};
    setByType(normalizeByType(initial));
    setSeeded(true);
  }, [envelope, seeded]);

  if (isLoading || !envelope?.data) return <LoadingView label={t('scrum.loadingConvention')} />;
  const { options, canEdit, suggestion } = envelope.data;

  if (!canEdit) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-ink-muted">
        {t('scrum.ownerOnlyFullExplanation')}
      </p>
    );
  }

  function ruleFor(type: string): BlockedConventionRule {
    return normalizeRule(byType[type]);
  }

  function updateType(type: string, patch: Partial<BlockedConventionRule>) {
    setByType((prev) => ({ ...prev, [type]: { ...ruleFor(type), ...patch } }));
  }

  function toggleState(type: string, state: string) {
    const rule = ruleFor(type);
    const states = rule.states.includes(state) ? rule.states.filter((s) => s !== state) : [...rule.states, state];
    updateType(type, { states });
  }

  function toggleTag(type: string, tag: string) {
    const rule = ruleFor(type);
    const tags = rule.tags.includes(tag) ? rule.tags.filter((t) => t !== tag) : [...rule.tags, tag];
    updateType(type, { tags });
  }

  async function handleSave() {
    // Drop types with no signal at all before saving — an empty rule for a
    // type it was never touched for should not persist as "configured".
    const cleaned = Object.fromEntries(
      Object.entries(byType).filter(([, rule]) => rule.states.length > 0 || rule.tags.length > 0 || rule.field)
    );
    try {
      await save.mutateAsync({ version: 1, byType: cleaned });
      onClose();
    } catch {
      // save.isError/save.error already surfaces this below; keep the
      // editor open (instead of closing on a failed save) so the user can
      // see the message and retry.
    }
  }

  return (
    <div className="space-y-3 rounded-card border border-border bg-surface-sunken p-3">
      {suggestion && Object.keys(byType).length === 0 && (
        <p className="text-xs text-ink-muted">
          {t('scrum.suggestedFromWorkflow', { suggestion: JSON.stringify(suggestion.byType) })}
        </p>
      )}

      {options.types.map((type) => {
        const rule = ruleFor(type);
        const states = options.statesByType[type] || [];
        return (
          <div key={type} className="space-y-1.5 border-t border-border pt-2 first:border-t-0 first:pt-0">
            <p className="text-xs font-medium text-ink"><Foreign as="span">{type}</Foreign></p>
            <div className="flex flex-wrap gap-1.5">
              {states.map((s) => (
                <label key={s.name} className="flex cursor-pointer items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px]">
                  <input type="checkbox" checked={rule.states.includes(s.name)} onChange={() => toggleState(type, s.name)} />
                  {s.name}
                </label>
              ))}
            </div>
            {options.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {options.tags.map((t) => (
                  <label key={t} className="flex cursor-pointer items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px]">
                    <input type="checkbox" checked={rule.tags.includes(t)} onChange={() => toggleTag(type, t)} />
                    #{t}
                  </label>
                ))}
              </div>
            )}
            {options.fields.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <select
                  value={rule.field ?? ''}
                  onChange={(e) => updateType(type, { field: e.target.value || null, fieldBlockedValue: e.target.value ? rule.fieldBlockedValue : undefined })}
                  className="focus-ring rounded-md border border-border bg-surface px-2 py-1 text-[11px]"
                >
                  <option value="">{t('scrum.noFieldOption')}</option>
                  {options.fields.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                {rule.field && (
                  // A14: this app does not yet discover a picklist field's
                  // real allowed values (see server/ado/discovery.js's own
                  // comment) — the owner types the EXACT value that means
                  // blocked (e.g. "true" for a boolean field, or the exact
                  // option text for a picklist), matched by equality rather
                  // than truthiness.
                  <input
                    type="text"
                    value={rule.fieldBlockedValue === undefined ? '' : String(rule.fieldBlockedValue)}
                    onChange={(e) => updateType(type, { fieldBlockedValue: e.target.value })}
                    placeholder={t('scrum.fieldBlockedValuePlaceholder')}
                    className="focus-ring w-40 rounded-md border border-border bg-surface px-2 py-1 text-[11px]"
                  />
                )}
              </div>
            )}
          </div>
        );
      })}

      {save.isError && <InlineMessage tone="error">{(save.error as Error).message}</InlineMessage>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={save.isPending}
          className="focus-ring rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {t('common.save')}
        </button>
        <button type="button" onClick={onClose} className="focus-ring rounded-md px-3 py-1.5 text-xs text-ink-muted">
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
