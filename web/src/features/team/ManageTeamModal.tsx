import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import { Modal } from '../../components/ui/Modal';
import { InlineMessage } from '../../components/ui/InlineMessage';
import { useOrg, useOrgMutations } from '../../lib/useOrg';
import { useTranslation } from '../../lib/i18n';
import { Foreign } from '../../components/ui/Foreign';
import { TeamListView } from './manage/TeamListView';
import { TeamDetailView } from './manage/TeamDetailView';

/** How long a confirmation stays before it clears itself. Long enough to
 * read a name in it, short enough that it doesn't linger over the next
 * thing you do. */
const ANNOUNCEMENT_MS = 5000;

interface Announcement {
  /** Bumped on every announce so repeating the SAME message still counts as
   * a new one — otherwise deleting two people in a row would leave the first
   * banner's timer running and dismiss the second one early. */
  seq: number;
  message: string;
  tone: 'success' | 'danger';
}

/** The admin surface behind the Team page's "Manage team" button — a
 * two-screen flow: a compact list of every team the caller can see (see
 * manage/TeamListView.tsx), and, one level deeper, a single team's roster
 * and settings (see manage/TeamDetailView.tsx). The dashboard owner sees
 * every team in the chart; a Lead sees only their own. */
export function ManageTeamModal({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const { data, isLoading, isError, refetch } = useOrg();
  const mutations = useOrgMutations();
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const seq = useRef(0);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [returnFocusTeamId, setReturnFocusTeamId] = useState<string | null>(null);

  // A permanently-mounted aria-live region announces changes without
  // stealing focus — the previous version force-focused a status box at the
  // top of the modal on every save, which threw away the reader's place in
  // a large tree along with the page's scroll position.
  function announce(message: string, tone: 'success' | 'danger' = 'success') {
    seq.current += 1;
    setAnnouncement({ seq: seq.current, message, tone });
  }

  // Confirmations expire on their own: they report something already done,
  // so there is nothing to act on and no reason to make the reader clear
  // them. The × is for clearing one early rather than the only way out.
  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(null), ANNOUNCEMENT_MS);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  const members = data?.members ?? [];
  const teams = data?.teams ?? [];
  const self = members.find((m) => m.id === data?.selfMemberId) ?? null;
  const assignableRoles = data?.assignableRoles ?? [];
  const isOwner = data?.isOwner ?? false;

  const selectedTeam = selectedTeamId ? teams.find((t) => t.id === selectedTeamId) ?? null : null;
  const manager = selectedTeam?.managerMemberId ? members.find((m) => m.id === selectedTeam.managerMemberId) ?? null : null;
  const canManageSelected = !!selectedTeam && (isOwner || (!!self && selectedTeam.managerMemberId === self.id));

  const title = selectedTeam ? (
    <>
      {t('team.manageTeamTitle')} · <Foreign as="span">{selectedTeam.name}</Foreign>
    </>
  ) : (
    t('team.manageTeamTitle')
  );

  function goBack() {
    setReturnFocusTeamId(selectedTeamId);
    setSelectedTeamId(null);
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <div role="status" aria-live="polite" className="sr-only">
          {announcement?.message}
        </div>
        {announcement && (
          // Tone follows the nature of the change, not its success: a
          // deletion that worked is still a removal, and reading it in the
          // same green as "Added X" is how you fail to notice you deleted
          // the wrong person.
          <div
            className={`mb-2 flex items-center gap-1.5 rounded-card border p-2.5 text-xs font-medium ${
              announcement.tone === 'danger' ? 'border-danger/30 bg-danger/10 text-danger' : 'border-success-tint/30 bg-success-tint/10 text-success'
            }`}
          >
            {announcement.tone === 'danger' ? <AlertTriangle size={14} className="shrink-0" /> : <Check size={14} className="shrink-0" />}
            {/* Hidden from assistive tech, not the whole banner: the live
                region above has already said this, and marking the container
                aria-hidden would bury the focusable × inside it. */}
            <span aria-hidden="true" className="min-w-0 flex-1">
              {announcement.message}
            </span>
            <button
              type="button"
              onClick={() => setAnnouncement(null)}
              aria-label={t('common.close')}
              className="focus-ring -m-1 shrink-0 cursor-pointer rounded p-1 opacity-70 transition-opacity hover:opacity-100"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {isLoading && <p className="text-xs text-ink-subtle">{t('team.loading')}</p>}
        {/* The chart is stored on this project's own wiki, so with no wiki
            every save would fail (WIKI_MISSING) — say so before anyone edits
            rather than after. See server/orgStore.js. */}
        {!isLoading && data && data.wikiAvailable === false && (
          <InlineMessage tone="warning" className="mb-2">
            {t('team.wikiMissingModal')}
          </InlineMessage>
        )}
        {isError && (
          <InlineMessage tone="error" className="mb-2">
            {t('team.couldNotLoadTeam')}{' '}
            <button type="button" onClick={() => refetch()} className="focus-ring underline">
              {t('common.retry')}
            </button>
          </InlineMessage>
        )}

        {!isLoading && !isError && selectedTeam ? (
          <TeamDetailView
            team={selectedTeam}
            manager={manager}
            members={members}
            teams={teams}
            self={self}
            selfId={self ? self.id : null}
            isOwner={isOwner}
            canManage={canManageSelected}
            assignableRoles={assignableRoles}
            mutations={mutations}
            announce={announce}
            onBack={goBack}
          />
        ) : (
          !isLoading &&
          !isError && (
            <TeamListView
              teams={teams}
              members={members}
              self={self}
              isOwner={isOwner}
              assignableRoles={assignableRoles}
              mutations={mutations}
              announce={announce}
              onManage={setSelectedTeamId}
              focusTeamId={returnFocusTeamId}
              onFocusHandled={() => setReturnFocusTeamId(null)}
            />
          )
        )}
      </div>
    </Modal>
  );
}
