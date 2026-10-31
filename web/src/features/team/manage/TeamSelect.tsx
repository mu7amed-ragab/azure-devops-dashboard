import type { OrgTeam } from '../../../lib/types';
import { inputClass } from './roleRules';
import { useTranslation } from '../../../lib/i18n';

interface TeamSelectProps {
  id: string;
  value: string;
  onChange: (teamId: string) => void;
  teams: OrgTeam[];
  className?: string;
}

/** A flat team <select> — used to move a person between teams from
 * EditMemberForm. The Manage Team modal now shows every team as its own
 * card (see TeamCard.tsx), so a grouped picker here would just duplicate
 * that structure; a flat alphabetical-by-insertion list is enough for the
 * occasional cross-team move. */
export function TeamSelect({ id, value, onChange, teams, className }: TeamSelectProps) {
  const t = useTranslation();
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className ?? inputClass}>
      {/* No "No team" option: a regular member always belongs to exactly one
          team. The placeholder is disabled so an unset value can be shown
          but never chosen. */}
      {!value && (
        <option value="" disabled>
          {t('team.selectTeamPlaceholder')}
        </option>
      )}
      {teams.map((team) => (
        <option key={team.id} value={team.id}>
          {team.name}
        </option>
      ))}
    </select>
  );
}
